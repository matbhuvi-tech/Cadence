#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Standalone Cadence Playback Engine (`cadence-engine.exe`).
//! Tauri-free Windows/cross-platform audio engine hosting `AudioEngine`
//! (`WASAPI Exclusive`, `ASIO`, `UPnP`) over Cadence Core Protocol v2.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cadence_core_lib::core_runtime::doctor::run_engine_doctor;
use cadence_core_lib::core_runtime::dragonfish::{
    probe_healthcheck_with_data_dir, DragonfishNode, DEFAULT_CONTROL_PORT,
};
use cadence_core_lib::core_runtime::windows_engine::{
    default_windows_engine_data_dir, detect_legacy_desktop_db, migrate_legacy_desktop_db,
    WindowsEngineConfig, WindowsEngineNode,
};

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn attach_parent_console_if_present() -> bool {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) != 0 }
}

#[cfg(not(windows))]
fn attach_parent_console_if_present() -> bool {
    false
}

#[cfg(windows)]
fn is_interactive_gui_launch(attached_console: bool) -> bool {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_UNKNOWN};
    use windows_sys::Win32::System::Console::{GetConsoleWindow, GetStdHandle, STD_OUTPUT_HANDLE};

    if attached_console {
        return false;
    }
    unsafe {
        if !GetConsoleWindow().is_null() {
            return false;
        }
        let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        stdout.is_null()
            || stdout == INVALID_HANDLE_VALUE
            || GetFileType(stdout) == FILE_TYPE_UNKNOWN
    }
}

#[cfg(not(windows))]
fn is_interactive_gui_launch(_attached_console: bool) -> bool {
    false
}

#[cfg(windows)]
fn show_gui_message(title: &str, body: &str, is_error: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND,
    };
    let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let body_w: Vec<u16> = body.encode_utf16().chain(std::iter::once(0)).collect();
    let icon = if is_error {
        MB_ICONERROR
    } else {
        MB_ICONINFORMATION
    };
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body_w.as_ptr(),
            title_w.as_ptr(),
            MB_OK | MB_SETFOREGROUND | icon,
        );
    }
}

#[cfg(not(windows))]
fn show_gui_message(_title: &str, _body: &str, _is_error: bool) {}

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
fn is_engine_running() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let name: Vec<u16> = SINGLETON_MUTEX_NAME.encode_utf16().collect();
    let mtx = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
    if mtx.is_null() {
        false
    } else {
        unsafe {
            CloseHandle(mtx);
        }
        true
    }
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
fn is_engine_running() -> bool {
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

#[cfg(windows)]
mod win_service {
    use super::{
        acquire_single_instance_guard, create_stop_event, is_stop_event_signaled, SHUTDOWN,
    };
    use cadence_core_lib::core_runtime::windows_engine::{
        default_windows_service_data_dir, installed_windows_service_data_dir,
        is_windows_service_running, WindowsEngineConfig, WindowsEngineNode, WINDOWS_SERVICE_NAME,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_SERVICE_ALREADY_RUNNING,
        ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_EXISTS, NO_ERROR,
    };
    use windows_sys::Win32::System::Services::{
        ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, ControlService,
        CreateServiceW, DeleteService, OpenSCManagerW, OpenServiceW, QueryServiceStatus,
        RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW,
        StartServiceW, SC_HANDLE, SC_MANAGER_ALL_ACCESS, SC_MANAGER_CONNECT,
        SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP, SERVICE_ALL_ACCESS, SERVICE_AUTO_START,
        SERVICE_CHANGE_CONFIG, SERVICE_CONFIG_DESCRIPTION, SERVICE_CONTINUE_PENDING,
        SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP,
        SERVICE_DESCRIPTIONW, SERVICE_ERROR_NORMAL, SERVICE_NO_CHANGE, SERVICE_PAUSE_PENDING,
        SERVICE_PAUSED, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START,
        SERVICE_START_PENDING, SERVICE_STATUS, SERVICE_STATUS_HANDLE, SERVICE_STOP,
        SERVICE_STOPPED, SERVICE_STOP_PENDING, SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS,
    };

    const SERVICE_NAME: &str = WINDOWS_SERVICE_NAME;
    const SERVICE_DISPLAY_NAME: &str = "Cadence Playback Engine";
    const SERVICE_DESC: &str =
        "Bit-perfect audiophile playback engine hosting WASAPI Exclusive, ASIO, and UPnP endpoints.";
    const STANDARD_RIGHTS_DELETE: u32 = 0x0001_0000;
    const ERROR_CALL_NOT_IMPLEMENTED: u32 = 120;

    static SERVICE_CFG: Mutex<Option<WindowsEngineConfig>> = Mutex::new(None);
    static STATUS_HANDLE: AtomicIsize = AtomicIsize::new(0);

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn default_service_data_dir() -> PathBuf {
        default_windows_service_data_dir()
    }

    pub fn configured_service_data_dir() -> Option<PathBuf> {
        installed_windows_service_data_dir()
    }

    pub fn log_service_event(data_dir: &std::path::Path, message: &str) {
        use std::io::Write;
        if std::fs::create_dir_all(data_dir).is_err() {
            return;
        }
        let log_path = data_dir.join("service.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let ts = chrono::Utc::now().to_rfc3339();
            let _ = writeln!(file, "[{ts}] {message}");
        }
    }

    fn format_win_error(action: &str, code: u32) -> String {
        if code == ERROR_ACCESS_DENIED {
            format!("{action} failed: access denied (run from an elevated Administrator terminal)")
        } else if code == ERROR_SERVICE_DOES_NOT_EXIST {
            format!("{action} failed: service '{SERVICE_NAME}' is not installed")
        } else {
            format!("{action} failed with Windows error {code}")
        }
    }

    struct ScmHandle(SC_HANDLE);
    impl Drop for ScmHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseServiceHandle(self.0);
                }
            }
        }
    }

    pub fn quote_arg(s: &str) -> String {
        if s.is_empty() || s.contains([' ', '\t', '"']) {
            let escaped = s.replace('"', "\\\"");
            format!("\"{escaped}\"")
        } else {
            s.to_string()
        }
    }

    pub fn install(
        data_dir: &PathBuf,
        port: u16,
        localhost_only: bool,
        label: Option<&str>,
    ) -> Result<(), String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("failed to create service data directory {}: {e}", data_dir.display()))?;

        let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
        let mut cmd_parts = vec![
            quote_arg(&exe.to_string_lossy()),
            "--service-run".into(),
            "--no-tray".into(),
            "--data-dir".into(),
            quote_arg(&data_dir.to_string_lossy()),
            "--port".into(),
            port.to_string(),
        ];
        if localhost_only {
            cmd_parts.push("--localhost-only".into());
        }
        if let Some(lbl) = label {
            cmd_parts.push("--label".into());
            cmd_parts.push(quote_arg(lbl));
        }
        let bin_path = cmd_parts.join(" ");

        let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_ALL_ACCESS) };
        if scm_raw.is_null() {
            return Err(format_win_error("OpenSCManagerW", unsafe { GetLastError() }));
        }
        let scm = ScmHandle(scm_raw);

        let svc_name = to_wide(SERVICE_NAME);
        let svc_display = to_wide(SERVICE_DISPLAY_NAME);
        let svc_cmd = to_wide(&bin_path);
        let mut updated = false;
        let svc_raw = unsafe {
            CreateServiceW(
                scm.0,
                svc_name.as_ptr(),
                svc_display.as_ptr(),
                SERVICE_ALL_ACCESS,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_AUTO_START,
                SERVICE_ERROR_NORMAL,
                svc_cmd.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        let svc = if svc_raw.is_null() {
            let err = unsafe { GetLastError() };
            if err != ERROR_SERVICE_EXISTS {
                return Err(format_win_error("CreateServiceW", err));
            }
            let existing = unsafe {
                OpenServiceW(
                    scm.0,
                    svc_name.as_ptr(),
                    SERVICE_CHANGE_CONFIG | SERVICE_QUERY_STATUS,
                )
            };
            if existing.is_null() {
                return Err(format_win_error("OpenServiceW", unsafe { GetLastError() }));
            }
            let guard = ScmHandle(existing);
            let changed = unsafe {
                ChangeServiceConfigW(
                    guard.0,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_AUTO_START,
                    SERVICE_ERROR_NORMAL,
                    svc_cmd.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    svc_display.as_ptr(),
                )
            };
            if changed == 0 {
                return Err(format_win_error("ChangeServiceConfigW", unsafe {
                    GetLastError()
                }));
            }
            let _ = SERVICE_NO_CHANGE;
            updated = true;
            guard
        } else {
            ScmHandle(svc_raw)
        };

        let mut desc_wide = to_wide(SERVICE_DESC);
        let desc = SERVICE_DESCRIPTIONW {
            lpDescription: desc_wide.as_mut_ptr(),
        };
        unsafe {
            let _ = ChangeServiceConfig2W(
                svc.0,
                SERVICE_CONFIG_DESCRIPTION,
                (&desc as *const SERVICE_DESCRIPTIONW).cast(),
            );
        }

        if updated {
            println!(
                "Updated Windows service '{SERVICE_NAME}' (data-dir={}, port={port}).",
                data_dir.display()
            );
        } else {
            println!(
                "Installed Windows service '{SERVICE_NAME}' (data-dir={}, port={port}).",
                data_dir.display()
            );
        }
        println!("Note: Windows Service mode suits headless/UPnP servers; user-tray mode is recommended for session-scoped USB DAC/ASIO setups.");
        Ok(())
    }

    pub fn start() -> Result<(), String> {
        let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
        if scm_raw.is_null() {
            return Err(format_win_error("OpenSCManagerW", unsafe { GetLastError() }));
        }
        let scm = ScmHandle(scm_raw);
        let svc_name = to_wide(SERVICE_NAME);
        let svc_raw = unsafe {
            OpenServiceW(scm.0, svc_name.as_ptr(), SERVICE_START | SERVICE_QUERY_STATUS)
        };
        if svc_raw.is_null() {
            return Err(format_win_error("OpenServiceW", unsafe { GetLastError() }));
        }
        let svc = ScmHandle(svc_raw);
        let ok = unsafe { StartServiceW(svc.0, 0, std::ptr::null()) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_SERVICE_ALREADY_RUNNING {
                println!("Windows service '{SERVICE_NAME}' is already running.");
                return Ok(());
            }
            return Err(format_win_error("StartServiceW", err));
        }
        println!("Started Windows service '{SERVICE_NAME}'.");
        Ok(())
    }

    fn stop_and_wait(svc: SC_HANDLE) -> Result<(), String> {
        let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { QueryServiceStatus(svc, &mut status) } != 0
            && status.dwCurrentState == SERVICE_STOPPED
        {
            return Ok(());
        }
        let ok = unsafe { ControlService(svc, SERVICE_CONTROL_STOP, &mut status) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            return Err(format_win_error("ControlService(STOP)", err));
        }
        for _ in 0..40 {
            if unsafe { QueryServiceStatus(svc, &mut status) } != 0
                && status.dwCurrentState == SERVICE_STOPPED
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(format!("Timed out waiting for service '{SERVICE_NAME}' to stop"))
    }

    pub fn stop() -> Result<(), String> {
        let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
        if scm_raw.is_null() {
            return Err(format_win_error("OpenSCManagerW", unsafe { GetLastError() }));
        }
        let scm = ScmHandle(scm_raw);
        let svc_name = to_wide(SERVICE_NAME);
        let svc_raw = unsafe {
            OpenServiceW(scm.0, svc_name.as_ptr(), SERVICE_STOP | SERVICE_QUERY_STATUS)
        };
        if svc_raw.is_null() {
            return Err(format_win_error("OpenServiceW", unsafe { GetLastError() }));
        }
        let svc = ScmHandle(svc_raw);
        stop_and_wait(svc.0)?;
        println!("Stopped Windows service '{SERVICE_NAME}'.");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
        if scm_raw.is_null() {
            return Err(format_win_error("OpenSCManagerW", unsafe { GetLastError() }));
        }
        let scm = ScmHandle(scm_raw);
        let svc_name = to_wide(SERVICE_NAME);
        let svc_raw = unsafe {
            OpenServiceW(
                scm.0,
                svc_name.as_ptr(),
                SERVICE_STOP | SERVICE_QUERY_STATUS | STANDARD_RIGHTS_DELETE,
            )
        };
        if svc_raw.is_null() {
            return Err(format_win_error("OpenServiceW", unsafe { GetLastError() }));
        }
        let svc = ScmHandle(svc_raw);
        let _ = stop_and_wait(svc.0);
        let ok = unsafe { DeleteService(svc.0) };
        if ok == 0 {
            return Err(format_win_error("DeleteService", unsafe { GetLastError() }));
        }
        println!("Uninstalled Windows service '{SERVICE_NAME}'. Data directory was preserved.");
        Ok(())
    }

    pub fn status() -> Result<(), String> {
        let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
        if scm_raw.is_null() {
            return Err(format_win_error("OpenSCManagerW", unsafe { GetLastError() }));
        }
        let scm = ScmHandle(scm_raw);
        let svc_name = to_wide(SERVICE_NAME);
        let svc_raw = unsafe { OpenServiceW(scm.0, svc_name.as_ptr(), SERVICE_QUERY_STATUS) };
        if svc_raw.is_null() {
            let err = unsafe { GetLastError() };
            if err == ERROR_SERVICE_DOES_NOT_EXIST {
                println!("Windows service '{SERVICE_NAME}' is not installed.");
                return Ok(());
            }
            return Err(format_win_error("OpenServiceW", err));
        }
        let svc = ScmHandle(svc_raw);
        let mut st: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { QueryServiceStatus(svc.0, &mut st) } == 0 {
            return Err(format_win_error("QueryServiceStatus", unsafe { GetLastError() }));
        }
        let label = match st.dwCurrentState {
            SERVICE_STOPPED => "Stopped",
            SERVICE_START_PENDING => "StartPending",
            SERVICE_STOP_PENDING => "StopPending",
            SERVICE_RUNNING => "Running",
            SERVICE_CONTINUE_PENDING => "ContinuePending",
            SERVICE_PAUSE_PENDING => "PausePending",
            SERVICE_PAUSED => "Paused",
            _ => "Unknown",
        };
        println!("Windows service '{SERVICE_NAME}': {label}");
        Ok(())
    }

    pub fn is_service_running() -> bool {
        is_windows_service_running()
    }

    unsafe fn set_state(
        handle: SERVICE_STATUS_HANDLE,
        state: u32,
        exit_code: u32,
        wait_hint_ms: u32,
        checkpoint: u32,
    ) {
        if handle.is_null() {
            return;
        }
        let controls = if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        };
        let status = SERVICE_STATUS {
            dwServiceType: SERVICE_WIN32_OWN_PROCESS,
            dwCurrentState: state,
            dwControlsAccepted: controls,
            dwWin32ExitCode: exit_code,
            dwServiceSpecificExitCode: 0,
            dwCheckPoint: checkpoint,
            dwWaitHint: wait_hint_ms,
        };
        SetServiceStatus(handle, &status);
    }

    unsafe extern "system" fn service_ctrl_handler(
        dw_control: u32,
        _dw_event_type: u32,
        _lp_event_data: *mut core::ffi::c_void,
        _lp_context: *mut core::ffi::c_void,
    ) -> u32 {
        match dw_control {
            SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
                SHUTDOWN.store(true, Ordering::Release);
                let raw = STATUS_HANDLE.load(Ordering::Acquire);
                if raw != 0 {
                    set_state(raw as SERVICE_STATUS_HANDLE, SERVICE_STOP_PENDING, 0, 10_000, 1);
                }
                NO_ERROR
            }
            SERVICE_CONTROL_INTERROGATE => NO_ERROR,
            _ => ERROR_CALL_NOT_IMPLEMENTED,
        }
    }

    unsafe extern "system" fn service_main(
        _argc: u32,
        _argv: *mut windows_sys::core::PWSTR,
    ) {
        let svc_name = to_wide(SERVICE_NAME);
        let handle = RegisterServiceCtrlHandlerExW(
            svc_name.as_ptr(),
            Some(service_ctrl_handler),
            std::ptr::null(),
        );
        if handle.is_null() {
            return;
        }
        STATUS_HANDLE.store(handle as isize, Ordering::Release);
        set_state(handle, SERVICE_START_PENDING, 0, 15_000, 1);

        let Some(cfg) = SERVICE_CFG.lock().ok().and_then(|mut g| g.take()) else {
            set_state(handle, SERVICE_STOPPED, 1, 0, 0);
            STATUS_HANDLE.store(0, Ordering::Release);
            return;
        };
        let data_dir = cfg.app_data_dir.clone();
        log_service_event(
            &data_dir,
            &format!(
                "Service starting (port={}, bind={})",
                cfg.control_bind_addr.port(),
                cfg.control_bind_addr.ip()
            ),
        );

        let Some(_instance_guard) = acquire_single_instance_guard() else {
            log_service_event(
                &data_dir,
                "Fatal: another Cadence Playback Engine instance is already running (singleton mutex held)",
            );
            set_state(handle, SERVICE_STOPPED, 1, 0, 0);
            STATUS_HANDLE.store(0, Ordering::Release);
            return;
        };
        let stop_event = create_stop_event();

        let mut node = match WindowsEngineNode::bootstrap(cfg) {
            Ok(n) => n,
            Err(err) => {
                log_service_event(
                    &data_dir,
                    &format!("Fatal: WindowsEngineNode::bootstrap failed: {err:?}"),
                );
                set_state(handle, SERVICE_STOPPED, 1, 0, 0);
                STATUS_HANDLE.store(0, Ordering::Release);
                return;
            }
        };

        log_service_event(
            &data_dir,
            &format!("Service running on {}", node.control_listen_addr),
        );
        set_state(handle, SERVICE_RUNNING, 0, 0, 0);
        while !SHUTDOWN.load(Ordering::Acquire) && !is_stop_event_signaled(&stop_event) {
            std::thread::sleep(Duration::from_millis(250));
        }

        set_state(handle, SERVICE_STOP_PENDING, 0, 10_000, 2);
        node.shutdown();
        drop(_instance_guard);
        drop(stop_event);
        log_service_event(&data_dir, "Service stopped cleanly");
        set_state(handle, SERVICE_STOPPED, 0, 0, 0);
        STATUS_HANDLE.store(0, Ordering::Release);
    }

    pub fn run_as_service(cfg: WindowsEngineConfig) -> Result<(), String> {
        {
            let mut slot = SERVICE_CFG.lock().map_err(|_| "service config lock poisoned")?;
            *slot = Some(cfg);
        }
        let mut svc_name = to_wide(SERVICE_NAME);
        let table = [
            SERVICE_TABLE_ENTRYW {
                lpServiceName: svc_name.as_mut_ptr(),
                lpServiceProc: Some(service_main),
            },
            SERVICE_TABLE_ENTRYW {
                lpServiceName: std::ptr::null_mut(),
                lpServiceProc: None,
            },
        ];
        let ok = unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) };
        if ok == 0 {
            return Err(format_win_error("StartServiceCtrlDispatcherW", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod win_service {
    use cadence_core_lib::core_runtime::windows_engine::{
        default_windows_service_data_dir, installed_windows_service_data_dir,
        is_windows_service_running, WindowsEngineConfig,
    };
    use std::path::PathBuf;

    pub fn default_service_data_dir() -> PathBuf {
        default_windows_service_data_dir()
    }

    pub fn configured_service_data_dir() -> Option<PathBuf> {
        installed_windows_service_data_dir()
    }
    pub fn is_service_running() -> bool {
        is_windows_service_running()
    }
    pub fn install(_: &PathBuf, _: u16, _: bool, _: Option<&str>) -> Result<(), String> {
        Err("Windows Service management is only supported on Windows.".into())
    }
    pub fn uninstall() -> Result<(), String> {
        Err("Windows Service management is only supported on Windows.".into())
    }
    pub fn start() -> Result<(), String> {
        Err("Windows Service management is only supported on Windows.".into())
    }
    pub fn stop() -> Result<(), String> {
        Err("Windows Service management is only supported on Windows.".into())
    }
    pub fn status() -> Result<(), String> {
        Err("Windows Service management is only supported on Windows.".into())
    }
    pub fn run_as_service(_: WindowsEngineConfig) -> Result<(), String> {
        Err("Windows Service mode is only supported on Windows.".into())
    }
}

fn print_usage() {
    eprintln!(
        "Cadence Playback Engine\n\
         Usage:\n\
         \tcadence-engine [--data-dir <path>] [--port <u16>] [--localhost-only] [--label <name>] [--no-tray]\n\
         \tcadence-engine --stop | --restart\n\
         \tcadence-engine --doctor [--data-dir <path>] [--port <u16>]\n\
         \tcadence-engine --backup <tag> [--data-dir <path>] | --restore <tag> [--data-dir <path>]\n\
         \tcadence-engine --migrate-legacy-db [<path-to-cadence.db>] [--data-dir <path>]\n\
         \tcadence-engine --healthcheck [--data-dir <path>] [--port <u16>]\n\
         \tcadence-engine service <install|uninstall|start|stop|status> [--data-dir <path>] [--port <u16>] [--localhost-only] [--label <name>]\n\
         \tcadence-engine --version | --help\n\
         Notes:\n\
         \t--app-data-dir and --control-port are accepted as aliases for --data-dir and --port.\n\
         \tWindows Service mode is designed for headless/UPnP servers; user-tray mode is recommended for session-scoped USB DAC/ASIO setups."
    );
}

fn main() {
    cadence_core_lib::diagnostics::init_from_env();
    let attached_console = attach_parent_console_if_present();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cfg = WindowsEngineConfig::default();
    let mut migrate_db: Option<Option<PathBuf>> = None;
    let mut healthcheck = false;
    let mut run_doctor = false;
    let mut backup_tag: Option<String> = None;
    let mut restore_tag: Option<String> = None;
    let mut service_action: Option<String> = None;
    let mut service_run = false;
    let mut stop_only = false;
    let mut restart = false;
    let mut no_tray = false;
    let mut autostart = false;
    let mut port = DEFAULT_CONTROL_PORT;
    let mut localhost_only = false;
    let mut data_dir_explicit = false;
    let mut label_explicit = false;

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
            "--autostart" => {
                autostart = true;
            }
            "--service-run" => {
                service_run = true;
            }
            "service" => {
                i += 1;
                let Some(action) = args.get(i) else {
                    eprintln!("service requires an action: install|uninstall|start|stop|status");
                    std::process::exit(2);
                };
                if !matches!(
                    action.as_str(),
                    "install" | "uninstall" | "start" | "stop" | "status"
                ) {
                    eprintln!("Unknown service action '{action}' (expected install|uninstall|start|stop|status)");
                    std::process::exit(2);
                }
                service_action = Some(action.clone());
            }
            "--data-dir" | "--app-data-dir" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    cfg.app_data_dir = PathBuf::from(val);
                    data_dir_explicit = true;
                } else {
                    eprintln!("--data-dir requires a path");
                    std::process::exit(2);
                }
            }
            "--port" | "--control-port" => {
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
                    label_explicit = true;
                } else {
                    eprintln!("--label requires a value");
                    std::process::exit(2);
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
            "--doctor" => {
                run_doctor = true;
            }
            "--backup" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    backup_tag = Some(val.clone());
                } else {
                    eprintln!("--backup requires a tag");
                    std::process::exit(2);
                }
            }
            "--restore" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    restore_tag = Some(val.clone());
                } else {
                    eprintln!("--restore requires a tag");
                    std::process::exit(2);
                }
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
        } else if win_service::is_service_running() {
            println!("Cadence Playback Engine is running as a Windows Service. Stop it from an elevated terminal with: cadence-engine service stop");
        } else {
            println!("Cadence Playback Engine is not running.");
        }
        return;
    }

    if restart {
        let _ = signal_running_engine_stop();
    }

    let resolved_data_dir = if data_dir_explicit {
        cfg.app_data_dir.clone()
    } else {
        default_windows_engine_data_dir()
    };

    let has_env_data_dir = std::env::var("CADENCE_DATA_DIR")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    let active_diagnostic_data_dir =
        if !data_dir_explicit && !has_env_data_dir && win_service::is_service_running() {
            win_service::configured_service_data_dir()
                .unwrap_or_else(win_service::default_service_data_dir)
        } else {
            resolved_data_dir.clone()
        };

    if let Some(action) = service_action {
        let svc_data_dir = if data_dir_explicit {
            cfg.app_data_dir.clone()
        } else {
            win_service::default_service_data_dir()
        };
        let res = match action.as_str() {
            "install" => win_service::install(
                &svc_data_dir,
                port,
                localhost_only,
                if label_explicit { Some(cfg.label.as_str()) } else { None },
            ),
            "uninstall" => win_service::uninstall(),
            "start" => win_service::start(),
            "stop" => win_service::stop(),
            "status" => win_service::status(),
            _ => unreachable!(),
        };
        if let Err(err) = res {
            eprintln!("{err}");
            std::process::exit(1);
        }
        return;
    }

    if healthcheck {
        std::process::exit(
            if probe_healthcheck_with_data_dir(port, Some(&active_diagnostic_data_dir)).is_ok() {
                0
            } else {
                1
            },
        );
    }

    if run_doctor {
        let report = run_engine_doctor(&active_diagnostic_data_dir, port);
        println!("{}", report.format_text());
        std::process::exit(if report.is_healthy() { 0 } else { 1 });
    }

    if let Some(tag) = backup_tag {
        match DragonfishNode::create_versioned_backup_offline(
            &resolved_data_dir,
            env!("CARGO_PKG_VERSION"),
            &tag,
        ) {
            Ok(dir) => {
                println!("backup created: {}", dir.display());
                return;
            }
            Err(err) => {
                eprintln!("Backup failed: {}", err.user_message());
                std::process::exit(1);
            }
        }
    }

    if let Some(tag) = restore_tag {
        if is_engine_running() || win_service::is_service_running() {
            eprintln!("Cannot restore backup while Cadence Playback Engine is running. Stop it first with: cadence-engine --stop (or cadence-engine service stop)");
            std::process::exit(1);
        }
        match DragonfishNode::restore_versioned_backup(&resolved_data_dir, &tag) {
            Ok(manifest) => {
                println!(
                    "backup restored: tag={} appVersion={} schemaVersion={}",
                    manifest.tag, manifest.app_version, manifest.schema_version
                );
                return;
            }
            Err(err) => {
                eprintln!("Restore failed: {}", err.user_message());
                std::process::exit(1);
            }
        }
    }

    if let Some(explicit_legacy) = migrate_db {
        let legacy_path = explicit_legacy.or_else(detect_legacy_desktop_db);
        let Some(legacy_path) = legacy_path else {
            eprintln!("No legacy cadence.db found in %APPDATA%. Pass an explicit path.");
            std::process::exit(1);
        };
        match migrate_legacy_desktop_db(&legacy_path, &resolved_data_dir) {
            Ok(res) => {
                println!(
                    "Migrated legacy DB {} -> {} (tracks={}, playlists={}, drafts={})",
                    legacy_path.display(),
                    resolved_data_dir.join("cadence.db").display(),
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

    if data_dir_explicit && !has_env_data_dir {
        std::env::set_var("CADENCE_DATA_DIR", &cfg.app_data_dir);
    }

    if service_run {
        if let Err(err) = win_service::run_as_service(cfg) {
            eprintln!("{err}");
            std::process::exit(1);
        }
        return;
    }

    let show_dialogs = is_interactive_gui_launch(attached_console) && !no_tray && !autostart;

    if win_service::is_service_running() {
        println!("Cadence Playback Engine is already running as a Windows Service (manage with: cadence-engine service status|stop).");
        if show_dialogs {
            show_gui_message(
                "Cadence Playback Engine",
                &format!(
                    "Cadence Playback Engine is already running in the background as a Windows Service (HTTPS port {port}).\n\n\
                     Windows Services run without a system tray icon. Open Cadence Core to connect to it directly.\n\n\
                     To switch back to user-tray mode, re-run the Cadence installer and uncheck \"Windows Service\"."
                ),
                false,
            );
        }
        return;
    }

    let Some(_instance_guard) = acquire_single_instance_guard() else {
        println!("Cadence Playback Engine is already running.");
        if show_dialogs {
            show_gui_message(
                "Cadence Playback Engine",
                "Cadence Playback Engine is already running in the Windows notification area (system tray).\n\n\
                 Check the taskbar overflow menu (^) if the Cadence icon is hidden.",
                false,
            );
        }
        return;
    };
    let stop_event = create_stop_event();

    install_shutdown_handler();

    let mut node = match WindowsEngineNode::bootstrap(cfg) {
        Ok(n) => n,
        Err(err) => {
            eprintln!("Failed to start Cadence Playback Engine: {err:?}");
            if show_dialogs {
                show_gui_message(
                    "Cadence Playback Engine",
                    &format!("Failed to start Cadence Playback Engine:\n\n{err:?}"),
                    true,
                );
            }
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

#[cfg(all(test, windows))]
mod tests {
    use super::win_service;

    #[test]
    fn quote_arg_handles_plain_spaces_and_embedded_quotes() {
        assert_eq!(
            win_service::quote_arg(r"C:\ProgramData\CadenceEngine"),
            r"C:\ProgramData\CadenceEngine"
        );
        assert_eq!(
            win_service::quote_arg(r"C:\Program Files\Cadence\cadence-engine.exe"),
            r#""C:\Program Files\Cadence\cadence-engine.exe""#
        );
        assert_eq!(win_service::quote_arg(""), "\"\"");
        assert_eq!(win_service::quote_arg(r#"my "label""#), r#""my \"label\"""#);
    }

    #[test]
    fn default_service_data_dir_ends_with_cadence_engine() {
        let dir = win_service::default_service_data_dir();
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("CadenceEngine"));
    }

    #[test]
    fn log_service_event_appends_timestamped_lines_to_service_log() {
        let root = std::env::temp_dir().join(format!(
            "cadence_svc_log_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        win_service::log_service_event(&root, "Service starting (port=4040, bind=0.0.0.0)");
        win_service::log_service_event(&root, "Service stopped cleanly");

        let contents = std::fs::read_to_string(root.join("service.log")).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with('[') && lines[0].contains("] Service starting (port=4040, bind=0.0.0.0)"));
        assert!(lines[1].starts_with('[') && lines[1].contains("] Service stopped cleanly"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
