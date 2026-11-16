#[cfg(feature = "desktop")]
pub mod audio;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod core_runtime;
pub mod core_session;
pub mod curation;
pub mod db;
pub mod diagnostics;
#[cfg(feature = "desktop")]
pub mod maintenance;
#[cfg(feature = "desktop")]
pub mod remote;
pub mod scanner;

#[cfg(feature = "desktop")]
use commands::artist_portrait::*;
#[cfg(feature = "desktop")]
use commands::diagnostics::*;
#[cfg(feature = "desktop")]
use commands::gemini_config::*;
#[cfg(feature = "desktop")]
use commands::metadata_providers::*;
#[cfg(feature = "desktop")]
use commands::remote::*;
#[cfg(feature = "desktop")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(feature = "desktop")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

#[cfg(feature = "desktop")]
struct PendingOpenFilesState {
    files: parking_lot::Mutex<Vec<String>>,
    frontend_ready: std::sync::atomic::AtomicBool,
}

#[cfg(feature = "desktop")]
impl PendingOpenFilesState {
    fn new() -> Self {
        Self {
            files: parking_lot::Mutex::new(Vec::new()),
            frontend_ready: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[cfg(feature = "desktop")]
fn is_supported_audio_file(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("flac" | "wav" | "aiff" | "aif" | "dsf" | "dff" | "mp3" | "m4a" | "aac" | "ogg" | "alac")
    )
}

#[cfg(feature = "desktop")]
fn normalize_opened_path(path: &std::path::Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = resolved.to_string_lossy().to_string();
    #[cfg(windows)]
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", stripped);
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        return stripped.to_string();
    }
    s
}

#[cfg(feature = "desktop")]
fn extract_audio_file_args(args: &[String], cwd: Option<&str>) -> Vec<String> {
    let mut files = Vec::new();
    for arg in args.iter().skip(1) {
        let trimmed = arg.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let candidate = std::path::Path::new(trimmed);
        let path = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            std::path::Path::new(dir).join(candidate)
        } else {
            candidate.to_path_buf()
        };
        if is_supported_audio_file(&path) {
            let normalized = normalize_opened_path(&path);
            if !files.contains(&normalized) {
                files.push(normalized);
            }
        }
    }
    files
}

#[cfg(feature = "desktop")]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn take_pending_open_files(state: tauri::State<'_, PendingOpenFilesState>) -> Vec<String> {
    state
        .frontend_ready
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let mut guard = state.files.lock();
    std::mem::take(&mut *guard)
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::init_from_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            focus_main_window(app);
            let files = extract_audio_file_args(&argv, Some(cwd.as_str()));
            if files.is_empty() {
                return;
            }
            if let Some(pending) = app.try_state::<PendingOpenFilesState>() {
                if pending
                    .frontend_ready
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    let _ = app.emit("cadence:open-files", files);
                } else {
                    pending.files.lock().extend(files);
                }
            } else {
                let _ = app.emit("cadence:open-files", files);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        ^ tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(PendingOpenFilesState::new())
        .manage(CoreEventStreamState::default())
        .setup(move |app| {
            let startup_args: Vec<String> = std::env::args().collect();
            let startup_files = extract_audio_file_args(&startup_args, None);
            if !startup_files.is_empty() {
                if let Some(pending) = app.try_state::<PendingOpenFilesState>() {
                    pending.files.lock().extend(startup_files);
                }
            }
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let _ = diagnostics::configure_persistence(
                app_data_dir,
                std::sync::Arc::new(|| diagnostics::HygieneState::Idle),
            );

            // Configure lightweight Windows System Tray Icon for thin Frontend shell
            let show_i = MenuItem::with_id(app, "tray_show", "Show Cadence", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "tray_quit", "Quit Cadence", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_i, &sep, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::with_id("cadence-tray")
                .tooltip("Cadence — Engine-First Audiophile Controller")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "tray_show" => {
                        focus_main_window(app_handle);
                    }
                    "tray_quit" => {
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_main_window(tray.app_handle());
                    }
                });

            if let Some(default_icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(default_icon.clone());
            }

            let _tray = tray_builder.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_gemini_config,
            save_gemini_api_key,
            save_gemini_model,
            remove_gemini_api_key,
            gemini_resolve,
            cancel_gemini_request,
            get_gemini_quota,
            search_artist_portraits,
            search_itunes_metadata,
            search_musicbrainz_metadata,
            cancel_provider_request,
            take_pending_open_files,
            // TLS-pinned Engine IPC & LAN mDNS discovery helpers
            core_probe_endpoint,
            core_control_request,
            core_fetch_artwork,
            core_connect_events,
            core_disconnect_events,
            discover_core_nodes,
            // Diagnostics & Debug Logging commands
            get_debug_log_state,
            set_debug_logging,
            get_recent_debug_logs,
            clear_debug_logs,
            flush_debug_logs_if_idle,
            open_debug_log_folder,
            log_frontend_debug_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cadence application");
}

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::*;

    #[test]
    fn extract_audio_file_args_filters_flags_and_non_audio() {
        let dir =
            std::env::temp_dir().join(format!("cadence_open_with_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let flac_path = dir.join("test_song.flac");
        let txt_path = dir.join("notes.txt");
        std::fs::write(&flac_path, b"fLaC").unwrap();
        std::fs::write(&txt_path, b"hello").unwrap();

        let args = vec![
            "cadence-core.exe".to_string(),
            "--minimized".to_string(),
            txt_path.to_string_lossy().to_string(),
            "test_song.flac".to_string(),
            flac_path.to_string_lossy().to_string(),
            dir.join("missing.mp3").to_string_lossy().to_string(),
        ];

        let extracted = extract_audio_file_args(&args, Some(dir.to_str().unwrap()));
        assert_eq!(extracted.len(), 1);
        assert!(extracted[0].to_lowercase().ends_with("test_song.flac"));
        assert!(!extracted[0].starts_with(r"\\?\"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
