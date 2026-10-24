use tauri::State;
use crate::maintenance::{MaintenanceStats, MaintenanceWorker, PortraitSyncProgressEvent};

#[tauri::command]
pub fn get_maintenance_stats(
    maintenance: State<MaintenanceWorker>,
) -> Result<MaintenanceStats, String> {
    Ok(maintenance.get_stats())
}

#[tauri::command]
pub fn get_portrait_sync_stats(
    maintenance: State<MaintenanceWorker>,
) -> Result<PortraitSyncProgressEvent, String> {
    Ok(maintenance.get_portrait_sync_stats())
}

#[tauri::command]
pub fn toggle_maintenance_pause(
    maintenance: State<MaintenanceWorker>,
) -> Result<bool, String> {
    Ok(maintenance.toggle_pause())
}

#[tauri::command]
pub fn notify_artist_portrait_resolved(
    maintenance: State<MaintenanceWorker>,
    artist_id: String,
    artist_name: String,
    portrait_url: String,
    provider_info: String,
) -> Result<(), String> {
    maintenance.notify_artist_portrait_resolved(&artist_id, &artist_name, &portrait_url, &provider_info);
    Ok(())
}

#[tauri::command]
pub fn force_enrich_now(
    maintenance: State<MaintenanceWorker>,
) -> Result<(), String> {
    maintenance.force_enrich_now();
    Ok(())
}

