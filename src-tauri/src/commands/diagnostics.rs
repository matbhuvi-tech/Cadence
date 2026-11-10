use serde::Deserialize;
use crate::diagnostics::{self, CaptureMode, DebugLogState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendDebugEvent {
    pub category: String,
    pub event: String,
    pub correlation_id: Option<u64>,
    pub wait_us: Option<u64>,
    pub exec_us: Option<u64>,
    pub detail: String,
}

#[tauri::command]
pub fn get_debug_log_state() -> DebugLogState {
    diagnostics::get_state()
}

#[tauri::command]
pub fn set_debug_logging(mode: CaptureMode) -> DebugLogState {
    diagnostics::set_mode(mode)
}

#[tauri::command]
pub fn get_recent_debug_logs() -> Vec<String> {
    diagnostics::get_recent_logs()
}

#[tauri::command]
pub fn clear_debug_logs() -> Result<DebugLogState, String> {
    diagnostics::clear_logs()
}

#[tauri::command]
pub fn flush_debug_logs_if_idle() -> Result<DebugLogState, String> {
    diagnostics::flush_if_idle()
}

#[tauri::command]
pub fn open_debug_log_folder() -> Result<String, String> {
    let dir = diagnostics::log_dir_path()
        .ok_or_else(|| "Diagnostics folder is not initialized yet".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to prepare log folder: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open log directory: {}", e))?;
    }

    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn log_frontend_debug_batch(events: Vec<FrontendDebugEvent>) {
    if !diagnostics::is_active() {
        return;
    }
    for ev in events.into_iter().take(64) {
        diagnostics::submit_frontend_event(
            &ev.category,
            &ev.event,
            ev.correlation_id.unwrap_or(0),
            ev.wait_us.unwrap_or(0),
            ev.exec_us.unwrap_or(0),
            &ev.detail,
        );
    }
}

