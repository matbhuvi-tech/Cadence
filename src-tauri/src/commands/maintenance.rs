use serde::{Deserialize, Serialize};
use tauri::State;
use crate::maintenance::{CommitQueueWorker, CommitTelemetryPayload, MaintenanceStats, MaintenanceWorker, PortraitSyncProgressEvent};

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

// Background Commit Queue IPC Commands

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueBatchRequest {
    pub id: Option<String>,
    pub description: Option<String>,
    pub destination: Option<String>,
    pub force_override: Option<bool>,
    pub items: Vec<crate::db::NewCommitItem>,
}

#[tauri::command]
pub fn commit_enqueue_batch(
    db: State<crate::db::AppDb>,
    worker: State<CommitQueueWorker>,
    request: EnqueueBatchRequest,
) -> Result<String, String> {
    let batch_id = request.id.unwrap_or_else(|| format!("batch-{}", uuid::Uuid::new_v4().simple()));
    let total_tracks = request.items.len() as i64;
    let batch = crate::db::DbCommitQueueBatch {
        id: batch_id.clone(),
        description: request.description,
        total_tracks,
        destination: request.destination.unwrap_or_else(|| "embedded".to_string()),
        force_override: request.force_override.unwrap_or(false),
        status: "pending".to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
    };

    let mut conn = db.conn.lock();
    crate::db::DbOperations::insert_commit_batch_and_items(&mut conn, &batch, &request.items)
        .map_err(|e| format!("Failed to enqueue batch: {}", e))?;
    drop(conn);

    worker.emit_telemetry(true);
    Ok(batch_id)
}

#[tauri::command]
pub fn commit_get_queue_summary(
    db: State<crate::db::AppDb>,
) -> Result<crate::db::CommitQueueSummary, String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::get_commit_queue_summary(&conn)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn commit_get_telemetry(
    worker: State<CommitQueueWorker>,
) -> Result<CommitTelemetryPayload, String> {
    Ok(worker.get_telemetry())
}

#[tauri::command]
pub fn commit_set_override(
    db: State<crate::db::AppDb>,
    worker: State<CommitQueueWorker>,
    batch_id: String,
    allow: bool,
) -> Result<(), String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::set_batch_override(&conn, &batch_id, allow)
        .map_err(|e| e.to_string())?;
    drop(conn);
    worker.emit_telemetry(true);
    Ok(())
}

#[tauri::command]
pub fn commit_toggle_pause(
    worker: State<CommitQueueWorker>,
) -> Result<bool, String> {
    Ok(worker.toggle_pause())
}

#[tauri::command]
pub fn commit_retry_offline_mounts(
    worker: State<CommitQueueWorker>,
) -> Result<(), String> {
    worker.retry_offline_mounts();
    Ok(())
}

#[tauri::command]
pub fn commit_cancel_batch(
    db: State<crate::db::AppDb>,
    worker: State<CommitQueueWorker>,
    batch_id: String,
) -> Result<usize, String> {
    let conn = db.conn.lock();
    let cancelled = crate::db::DbOperations::cancel_batch_pending_items(&conn, &batch_id)
        .map_err(|e| e.to_string())?;
    drop(conn);
    worker.emit_telemetry(true);
    Ok(cancelled)
}

#[tauri::command]
pub fn commit_undo_batch(
    db: State<crate::db::AppDb>,
    worker: State<CommitQueueWorker>,
    batch_id: String,
) -> Result<String, String> {
    let conn = db.conn.lock();
    let completed_items = crate::db::DbOperations::fetch_completed_items_for_undo(&conn, &batch_id)
        .map_err(|e| e.to_string())?;

    if completed_items.is_empty() {
        return Err("No completed items to undo in this batch".to_string());
    }

    let undo_batch_id = format!("undo-{}", uuid::Uuid::new_v4().simple());
    let mut undo_items = Vec::new();

    for item in &completed_items {
        undo_items.push(crate::db::NewCommitItem {
            id: format!("item-{}", uuid::Uuid::new_v4().simple()),
            track_id: item.track_id.clone(),
            file_path: item.file_path.clone(),
            mount_id: item.mount_id.clone(),
            payload_json: item.backup_json.clone(),
            backup_json: item.payload_json.clone(),
            expected_crc: None,
        });
    }

    let total_tracks = undo_items.len() as i64;
    let undo_batch = crate::db::DbCommitQueueBatch {
        id: undo_batch_id.clone(),
        description: Some(format!("Undo for batch {}", batch_id)),
        total_tracks,
        destination: "embedded".to_string(),
        force_override: false,
        status: "pending".to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
    };

    drop(conn);
    let mut conn = db.conn.lock();
    crate::db::DbOperations::insert_commit_batch_and_items(&mut conn, &undo_batch, &undo_items)
        .map_err(|e| format!("Failed to enqueue undo batch: {}", e))?;
    drop(conn);

    worker.emit_telemetry(true);
    Ok(undo_batch_id)
}

#[tauri::command]
pub fn commit_get_queued_track_ids(
    db: State<crate::db::AppDb>,
) -> Result<Vec<String>, String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::get_queued_track_ids(&conn)
        .map_err(|e| e.to_string())
}
