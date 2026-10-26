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

#[tauri::command]
pub fn get_track_fingerprint(
    db: State<crate::db::AppDb>,
    track_id: String,
) -> Result<(String, i32), String> {
    let conn = db.conn.lock();
    let row: Option<(Option<String>, String, f64)> = conn.query_row(
        "SELECT acoustid_fingerprint, file_path, duration_secs FROM tracks WHERE id = ?1 LIMIT 1",
        rusqlite::params![track_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).ok();

    let (cached_fp, file_path, dur) = row.ok_or_else(|| format!("Track not found: {}", track_id))?;
    if let Some(fp) = cached_fp {
        if !fp.is_empty() && fp != "ERROR_UNREADABLE" {
            return Ok((fp, dur.round() as i32));
        }
    }

    drop(conn);
    // Generate fingerprint
    let (fingerprint, actual_dur) = crate::maintenance::fingerprint::generate_fingerprint_for_file(&file_path, 120)?;
    let conn = db.conn.lock();
    let _ = crate::db::DbOperations::update_track_fingerprint(&conn, &track_id, &fingerprint);
    Ok((fingerprint, actual_dur))
}

#[tauri::command]
pub fn db_update_track_provenance(
    db: State<crate::db::AppDb>,
    track_id: String,
    mbid: Option<String>,
    original_album: Option<String>,
    original_year: Option<i32>,
) -> Result<(), String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::update_track_provenance(
        &conn,
        &track_id,
        mbid.as_deref(),
        original_album.as_deref(),
        original_year,
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_cached_acoustid(
    db: State<crate::db::AppDb>,
    fingerprint: String,
) -> Result<Option<(Option<String>, Option<String>, Option<i32>, Option<f64>)>, String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::get_cached_acoustid(&conn, &fingerprint)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_cache_acoustid_result(
    db: State<crate::db::AppDb>,
    fingerprint: String,
    duration: i32,
    mbid: Option<String>,
    canonical_title: Option<String>,
    canonical_year: Option<i32>,
    score: Option<f64>,
) -> Result<(), String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::cache_acoustid_result(
        &conn,
        &fingerprint,
        duration,
        mbid.as_deref(),
        canonical_title.as_deref(),
        canonical_year,
        score,
    ).map_err(|e| e.to_string())
}

