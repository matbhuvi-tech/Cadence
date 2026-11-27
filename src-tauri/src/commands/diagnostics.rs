use serde::Deserialize;
use serde_json::Value;
use crate::diagnostics::{self, CaptureMode, DebugLogState};
use crate::support_bundle::{
    self, GeneratedSupportBundle, SupportBundleRequest, SupportDiagnosticsPreview,
    SupportScenarioInfo, SupportSubmissionResult, SupportWebhookConfig,
};

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

#[tauri::command]
pub fn get_support_scenarios() -> Vec<SupportScenarioInfo> {
    support_bundle::support_scenarios()
}

#[tauri::command]
pub fn preview_support_diagnostics(
    scenario_id: String,
    active_engine_url: Option<String>,
    active_engine_reachable: Option<bool>,
    active_engine_probe_error: Option<String>,
    engine_snapshot: Option<Value>,
) -> SupportDiagnosticsPreview {
    support_bundle::build_support_preview(
        &scenario_id,
        active_engine_url.as_deref(),
        active_engine_reachable.unwrap_or(false),
        active_engine_probe_error.as_deref(),
        engine_snapshot.as_ref(),
    )
}

#[tauri::command]
pub fn generate_support_bundle(request: SupportBundleRequest) -> Result<GeneratedSupportBundle, String> {
    let base_dir = diagnostics::log_dir_path().unwrap_or_else(std::env::temp_dir);
    let out_dir = base_dir.join("support-bundles");
    support_bundle::generate_support_bundle_to_dir(&out_dir, request)
}

#[tauri::command]
pub async fn submit_support_bundle(
    request: SupportBundleRequest,
) -> Result<SupportSubmissionResult, String> {
    let base_dir = diagnostics::log_dir_path().unwrap_or_else(std::env::temp_dir);
    let out_dir = base_dir.join("support-bundles");
    support_bundle::submit_support_bundle_to_dir(&out_dir, request).await
}

#[tauri::command]
pub fn get_support_webhook_config() -> SupportWebhookConfig {
    support_bundle::get_support_webhook_config()
}

#[tauri::command]
pub fn set_support_webhook_url(webhook_url: String) -> Result<SupportWebhookConfig, String> {
    support_bundle::save_support_webhook_url(&webhook_url)
}

#[tauri::command]
pub fn reveal_support_bundle_in_folder(zip_path: String) -> Result<(), String> {
    let target = std::path::Path::new(&zip_path);
    if !target.exists() {
        return Err("Support bundle file does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Finder: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = target.parent().unwrap_or(target);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open support bundle folder: {e}"))?;
    }

    Ok(())
}

