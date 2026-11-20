#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Standalone Cadence Playback Engine (`cadence-engine.exe`).
//! Tauri-free Windows/cross-platform audio engine hosting `AudioEngine`
//! (`WASAPI Exclusive`, `ASIO`, `UPnP`) over Cadence Core Protocol v2.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cadence_core_lib::core_runtime::dragonfish::{probe_healthcheck, DEFAULT_CONTROL_PORT};
use cadence_core_lib::core_runtime::windows_engine::{
    default_windows_engine_data_dir, detect_legacy_desktop_db, migrate_legacy_desktop_db,
    WindowsEngineConfig, WindowsEngineNode,
};

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn attach_parent_console_if_present() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_parent_console_if_present() {}

#[cfg(windows)]
struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
const SINGLETON_MUTEX_NAME: &str = "Local\\CadencePlaybackEngineSingleton\0";
#[cfg(windows)]
const STOP_EVENT_NAME: &str = "Local\\CadencePlaybackEngineStop\0";

#[cfg(windows)]
fn acquire_single_instance_guard() -> Option<HandleGuard> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = SINGLETON_MUTEX_NAME.encode_utf16().collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        return None;
    }
    Some(HandleGuard(handle))
}

#[cfg(windows)]
fn create_stop_event() -> Option<HandleGuard> {
    use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent};
    let name: Vec<u16> = STOP_EVENT_NAME.encode_utf16().collect();
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    unsafe {
        let _ = ResetEvent(handle);
    }
    Some(HandleGuard(handle))
}

#[cfg(windows)]
fn is_stop_event_signaled(event: &Option<HandleGuard>) -> bool {
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    let Some(guard) = event.as_ref() else {
        return false;
    };
    unsafe { WaitForSingleObject(guard.0, 0) == WAIT_OBJECT_0 }
}

#[cfg(windows)]
fn signal_running_engine_stop() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenEventW, OpenMutexW, SetEvent, EVENT_MODIFY_STATE,
    };
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let event_name: Vec<u16> = STOP_EVENT_NAME.encode_utf16().collect();
    let ev = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, event_name.as_ptr()) };
    if ev.is_null() {
        return false;
    }
    unsafe {
        let _ = SetEvent(ev);
        CloseHandle(ev);
    }

    // Wait up to 5 seconds for the running instance to release its singleton mutex
    let mutex_name: Vec<u16> = SINGLETON_MUTEX_NAME.encode_utf16().collect();
    for _ in 0..50 {
        let mtx = unsafe { OpenMutexW(SYNCHRONIZE, 0, mutex_name.as_ptr()) };
        if mtx.is_null() {
            return true;
        }
        unsafe {
            CloseHandle(mtx);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

#[cfg(not(windows))]
struct HandleGuard;

#[cfg(not(windows))]
fn acquire_single_instance_guard() -> Option<HandleGuard> {
    Some(HandleGuard)
}

#[cfg(not(windows))]
fn create_stop_event() -> Option<HandleGuard> {
    None
}

#[cfg(not(windows))]
fn is_stop_event_signaled(_event: &Option<HandleGuard>) -> bool {
    false
}

#[cfg(not(windows))]
fn signal_running_engine_stop() -> bool {
    false
}

#[cfg(windows)]
unsafe extern "system" fn console_ctrl_handler(_ctrl_type: u32) -> i32 {
    SHUTDOWN.store(true, Ordering::Release);
    1
}

#[cfg(windows)]
fn install_shutdown_handler() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    unsafe {
        let _ = SetConsoleCtrlHandler(Some(console_ctrl_handler), 1);
    }
}

#[cfg(not(windows))]
fn install_shutdown_handler() {}

#[cfg(windows)]
mod tray {
    use super::{RESTART_REQUESTED, SHUTDOWN};
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
        DestroyMenu, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, LoadIconW,
        LookupIconIdFromDirectoryEx, PostQuitMessage, RegisterClassW, SetForegroundWindow,
        TrackPopupMenu, TranslateMessage, IDI_APPLICATION, LR_DEFAULTCOLOR, MF_GRAYED,
        MF_SEPARATOR, MF_STRING, MSG, TPM_BOTTOMALIGN, TPM_LEFTALIGN, WM_APP, WM_COMMAND,
        WM_DESTROY, WM_RBUTTONUP, WNDCLASSW,
    };

    static EMBEDDED_ICO: &[u8] = include_bytes!("../../icons/icon.ico");

    unsafe fn load_cadence_tray_icon() -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
        // Look up the best 32x32 (or 16x16) icon resource inside the embedded .ico bytes
        let offset = LookupIconIdFromDirectoryEx(EMBEDDED_ICO.as_ptr(), 1, 32, 32, LR_DEFAULTCOLOR);
        if offset > 0 && (offset as usize) < EMBEDDED_ICO.len() {
            let slice = &EMBEDDED_ICO[offset as usize..];
            let hicon = CreateIconFromResourceEx(
                slice.as_ptr(),
                slice.len() as u32,
                1,
                0x0003_0000,
                32,
                32,
                LR_DEFAULTCOLOR,
            );
            if !hicon.is_null() {
                return hicon;
            }
        }
        LoadIconW(std::ptr::null_mut(), IDI_APPLICATION)
    }

    const WM_TRAYICON: u32 = WM_APP + 1;
    const CMD_STATUS: usize = 1001;
    const CMD_RESTART: usize = 1002;
    const CMD_QUIT: usize = 1003;

    static mut TRAY_PORT: u16 = 4040;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_TRAYICON => {
                if lparam as u32 == WM_RBUTTONUP {
                    let hmenu = CreatePopupMenu();
                    if !hmenu.is_null() {
                        let port = TRAY_PORT;
                        let status_text = to_wide(&format!("Cadence Engine (Port {port})"));
                        let restart_text = to_wide("Restart Engine");
                        let quit_text = to_wide("Quit Engine");
                        AppendMenuW(hmenu, MF_STRING | MF_GRAYED, CMD_STATUS, status_text.as_ptr());
                        AppendMenuW(hmenu, MF_SEPARATOR, 0, std::ptr::null());
                        AppendMenuW(hmenu, MF_STRING, CMD_RESTART, restart_text.as_ptr());
                        AppendMenuW(hmenu, MF_STRING, CMD_QUIT, quit_text.as_ptr());

                        let mut pt = POINT { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        SetForegroundWindow(hwnd);
                        TrackPopupMenu(
                            hmenu,
                            TPM_LEFTALIGN | TPM_BOTTOMALIGN,
                            pt.x,
                            pt.y,
                            0,
                            hwnd,
                            std::ptr::null(),
                        );
                        DestroyMenu(hmenu);
                    }
                }
                0
            }
            WM_COMMAND => {
                match wparam & 0xffff {
                    CMD_RESTART => {
                        RESTART_REQUESTED.store(true, Ordering::Release);
                        SHUTDOWN.store(true, Ordering::Release);
                        PostQuitMessage(0);
                    }
                    CMD_QUIT => {
                        SHUTDOWN.store(true, Ordering::Release);
                        PostQuitMessage(0);
                    }
                    _ => {}
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn spawn_tray_thread(port: u16) -> Option<(std::thread::JoinHandle<()>, usize)> {
        unsafe {
            TRAY_PORT = port;
        }
        let (tx, rx) = std::sync::mpsc::channel::<usize>();
        let handle = std::thread::Builder::new()
            .name("cadence-win-tray".into())
            .spawn(move || unsafe {
                let hinstance = GetModuleHandleW(std::ptr::null());
                let class_name = to_wide("CadenceEngineTrayClass");
                let wc = WNDCLASSW {
                    style: 0,
                    lpfnWndProc: Some(wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: hinstance,
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                };
                RegisterClassW(&wc);
                let title = to_wide("Cadence Playback Engine");
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    hinstance,
                    std::ptr::null(),
                );
                let _ = tx.send(hwnd as usize);
                if hwnd.is_null() {
                    return;
                }

                let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
                nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
                nid.hWnd = hwnd;
                nid.uID = 1;
                nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
                nid.uCallbackMessage = WM_TRAYICON;
                nid.hIcon = load_cadence_tray_icon();
                let tip = format!("Cadence Playback Engine (Running on :{port})");
                for (dst, src) in nid.szTip.iter_mut().zip(tip.encode_utf16()) {
                    *dst = src;
                }
                Shell_NotifyIconW(NIM_ADD, &nid);

                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                Shell_NotifyIconW(NIM_DELETE, &nid);
                DestroyWindow(hwnd);
            })
            .ok()?;

        let hwnd_val = rx.recv().ok().unwrap_or(0);
        Some((handle, hwnd_val))
    }

    pub fn close_tray_window(hwnd_val: usize) {
        if hwnd_val != 0 {
            use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
            unsafe {
                PostMessageW(hwnd_val as HWND, WM_CLOSE, 0, 0);
            }
        }
    }
}

fn print_usage() {
    eprintln!(
        "Cadence Playback Engine\n\
         Usage:\n\
         \tcadence-engine [--data-dir <path>] [--port <u16>] [--localhost-only] [--label <name>] [--no-tray]\n\
         \tcadence-engine --stop | --restart\n\
         \tcadence-engine --migrate-legacy-db [<path-to-cadence.db>] [--data-dir <path>]\n\
         \tcadence-engine --healthcheck [--port <u16>]\n\
         \tcadence-engine --version | --help"
    );
}

fn main() {
    attach_parent_console_if_present();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cfg = WindowsEngineConfig::default();
    let mut migrate_db: Option<Option<PathBuf>> = None;
    let mut healthcheck = false;
    let mut stop_only = false;
    let mut restart = false;
    let mut no_tray = false;
    let mut port = DEFAULT_CONTROL_PORT;
    let mut localhost_only = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                print_usage();
                return;
            }
            "--version" | "-V" => {
                println!("cadence-engine {}", env!("CADENCE_BUILD_DISPLAY"));
                return;
            }
            "--stop" => {
                stop_only = true;
            }
            "--restart" => {
                restart = true;
            }
            "--no-tray" => {
                no_tray = true;
            }
            "--data-dir" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    cfg.app_data_dir = PathBuf::from(val);
                } else {
                    eprintln!("--data-dir requires a path");
                    std::process::exit(2);
                }
            }
            "--port" => {
                i += 1;
                port = args
                    .get(i)
                    .and_then(|v| v.parse::<u16>().ok())
                    .unwrap_or_else(|| {
                        eprintln!("--port requires a valid u16");
                        std::process::exit(2);
                    });
            }
            "--localhost-only" => {
                localhost_only = true;
            }
            "--label" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    cfg.label = val.clone();
                }
            }
            "--migrate-legacy-db" => {
                let next = args.get(i + 1).filter(|s| !s.starts_with("--"));
                if let Some(path) = next {
                    migrate_db = Some(Some(PathBuf::from(path)));
                    i += 1;
                } else {
                    migrate_db = Some(None);
                }
            }
            "--healthcheck" => {
                healthcheck = true;
            }
            other => {
                eprintln!("Unknown argument: {other}");
                print_usage();
                std::process::exit(2);
            }
        }
        i += 1;
    }

    if stop_only {
        if signal_running_engine_stop() {
            println!("Cadence Playback Engine stopped.");
        } else {
            println!("Cadence Playback Engine is not running.");
        }
        return;
    }

    if restart {
        let _ = signal_running_engine_stop();
    }

    if healthcheck {
        std::process::exit(if probe_healthcheck(port).is_ok() { 0 } else { 1 });
    }

    if let Some(explicit_legacy) = migrate_db {
        let data_dir = if cfg.app_data_dir.as_os_str().is_empty() {
            default_windows_engine_data_dir()
        } else {
            cfg.app_data_dir.clone()
        };
        let legacy_path = explicit_legacy.or_else(detect_legacy_desktop_db);
        let Some(legacy_path) = legacy_path else {
            eprintln!("No legacy cadence.db found in %APPDATA%. Pass an explicit path.");
            std::process::exit(1);
        };
        match migrate_legacy_desktop_db(&legacy_path, &data_dir) {
            Ok(res) => {
                println!(
                    "Migrated legacy DB {} -> {} (tracks={}, playlists={}, drafts={})",
                    legacy_path.display(),
                    data_dir.join("cadence.db").display(),
                    res.imported_tracks,
                    res.imported_playlists,
                    res.imported_drafts
                );
                return;
            }
            Err(err) => {
                eprintln!("Legacy DB migration failed: {err}");
                std::process::exit(1);
            }
        }
    }

    let bind_ip: IpAddr = if localhost_only {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };
    cfg.control_bind_addr = SocketAddr::new(bind_ip, port);

    let Some(_instance_guard) = acquire_single_instance_guard() else {
        println!("Cadence Playback Engine is already running.");
        return;
    };
    let stop_event = create_stop_event();

    install_shutdown_handler();

    let mut node = match WindowsEngineNode::bootstrap(cfg) {
        Ok(n) => n,
        Err(err) => {
            eprintln!("Failed to start Cadence Playback Engine: {err:?}");
            std::process::exit(1);
        }
    };

    println!(
        "Cadence Playback Engine ready on https://{} (engineId={}, label=\"{}\")",
        node.control_listen_addr, node.identity.engine_id, node.identity.label
    );

    #[cfg(windows)]
    let tray_handle = if !no_tray {
        tray::spawn_tray_thread(node.control_listen_addr.port())
    } else {
        None
    };

    while !SHUTDOWN.load(Ordering::Acquire) && !is_stop_event_signaled(&stop_event) {
        std::thread::sleep(Duration::from_millis(250));
    }

    #[cfg(windows)]
    if let Some((join, hwnd_val)) = tray_handle {
        tray::close_tray_window(hwnd_val);
        let _ = join.join();
    }

    node.shutdown();
    drop(_instance_guard);
    drop(stop_event);

    if RESTART_REQUESTED.load(Ordering::Acquire) {
        if let Ok(exe) = std::env::current_exe() {
            let passthrough: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| a != "--restart" && a != "--stop")
                .collect();
            let _ = std::process::Command::new(exe).args(passthrough).spawn();
        }
    }
}
