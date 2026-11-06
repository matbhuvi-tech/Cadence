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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbProvenanceCacheEntry {
    pub hash_key: String,
    pub album_id: String,
    pub album_title: String,
    pub input_params_json: String,
    pub response_json: String,
    pub model_version: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_get_provenance_cache(
    db: State<crate::db::AppDb>,
    hash_key: String,
) -> Result<Option<DbProvenanceCacheEntry>, String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::get_provenance_cache(&conn, &hash_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_set_provenance_cache(
    db: State<crate::db::AppDb>,
    hash_key: String,
    album_id: String,
    album_title: String,
    input_params_json: String,
    response_json: String,
    model_version: String,
) -> Result<(), String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::set_provenance_cache(
        &conn,
        &hash_key,
        &album_id,
        &album_title,
        &input_params_json,
        &response_json,
        &model_version,
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
    pub require_idle: Option<bool>,
    pub curate_drafts: Option<Vec<EnqueuedCurateDraft>>,
    pub items: Vec<crate::db::NewCommitItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueuedCurateDraft {
    pub album_id: String,
    pub draft: serde_json::Value,
}

#[tauri::command]
pub fn commit_enqueue_batch(
    db: State<crate::db::AppDb>,
    worker: State<CommitQueueWorker>,
    engine: State<crate::audio::AudioEngine>,
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
    let require_idle = request.require_idle.unwrap_or(false);
    if require_idle && (engine.is_playing() || engine.is_paused()) {
        return Err("Stop playback before queueing a Tier 1 batch.".into());
    }
    let drafts: Vec<_> = request.curate_drafts.unwrap_or_default().into_iter()
        .map(|entry| (entry.album_id, entry.draft))
        .collect();
    let queued = crate::db::DbOperations::insert_commit_with_curate_drafts(&mut conn, &batch, &request.items, &drafts, require_idle)
        .map_err(|e| format!("Failed to enqueue batch: {}", e))?;
    if !queued {
        return Err("A track already has an unresolved commit. Review the queue before retrying the batch.".into());
    }
    drop(conn);

    worker.emit_telemetry(true);
    Ok(batch_id)
}

#[tauri::command]
pub fn commit_get_curate_projection(
    db: State<crate::db::AppDb>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db.conn.lock();
    load_curate_projection(&conn).map_err(|err| err.to_string())
}

fn load_curate_projection(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "WITH latest AS (
            SELECT i.id, i.track_id, i.status, i.payload_json, i.artwork_result_id, i.error_message, b.rowid AS batch_order,
                ROW_NUMBER() OVER (PARTITION BY i.track_id ORDER BY b.rowid DESC, i.rowid DESC) AS rank
            FROM commit_queue_items i JOIN commit_queue_batches b ON b.id = i.batch_id
            WHERE i.status IN ('pending', 'in_flight', 'failed', 'completed')
        )
        SELECT latest.track_id, latest.status, latest.payload_json,
            latest.status <> 'completed' OR (
                t.id IS NOT NULL
                AND t.title IS COALESCE(json_extract(latest.payload_json, '$.title'), t.title)
                AND t.artist_credit IS COALESCE(json_extract(latest.payload_json, '$.artist'), t.artist_credit)
                AND t.album_title IS COALESCE(json_extract(latest.payload_json, '$.album'), t.album_title)
                AND t.album_artist IS COALESCE(json_extract(latest.payload_json, '$.albumArtist'), t.album_artist)
                AND t.composer IS COALESCE(json_extract(latest.payload_json, '$.composer'), t.composer)
                AND t.release_year IS COALESCE(json_extract(latest.payload_json, '$.year'), t.release_year)
                AND t.genre IS COALESCE(json_extract(latest.payload_json, '$.genre'), t.genre)
                AND t.original_album IS COALESCE(json_extract(latest.payload_json, '$.originalAlbum'), t.original_album)
                AND t.original_year IS COALESCE(json_extract(latest.payload_json, '$.originalYear'), t.original_year)
            ), latest.id, a.thumbnail_url, latest.error_message
        FROM latest LEFT JOIN tracks t ON t.id = latest.track_id
        LEFT JOIN releases r ON r.id = t.release_id
        LEFT JOIN commit_artwork_results a ON a.id = latest.artwork_result_id
            AND latest.status = 'completed' AND r.front_cover_url = a.thumbnail_url
        WHERE rank = 1 AND CASE WHEN json_valid(latest.payload_json) THEN json_extract(latest.payload_json, '$.curate') END = 1
        ORDER BY batch_order, latest.track_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "trackId": row.get::<_, String>(0)?,
            "status": row.get::<_, String>(1)?,
            "payloadJson": row.get::<_, String>(2)?,
            "applies": row.get::<_, bool>(3)?,
            "id": row.get::<_, String>(4)?,
            "artworkUrl": row.get::<_, Option<String>>(5)?,
            "errorMessage": row.get::<_, Option<String>>(6)?,
        }))
    })?;
    rows.collect()
}

#[cfg(test)]
#[test]
fn curate_projection_uses_newest_confirmation_and_ignores_cancelled_items() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::schema::initialize_schema(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO commit_queue_batches (id, description, total_tracks, destination, status, created_at)
            VALUES ('first', 'First', 1, 'embedded', 'pending', '2026-01-01'),
                   ('second', 'Second', 1, 'embedded', 'pending', '2026-01-02');
         INSERT INTO commit_queue_items (id, batch_id, track_id, file_path, mount_id, payload_json, backup_json, status)
            VALUES ('old', 'first', 'track', 'song.flac', 'mount', '{\"curate\":true,\"genre\":\"Old\"}', '{}', 'in_flight'),
                   ('new', 'second', 'track', 'song.flac', 'mount', '{\"curate\":true,\"genre\":\"New\"}', '{}', 'pending');",
    ).unwrap();
    assert_eq!(load_curate_projection(&conn).unwrap()[0]["id"], "new");
    conn.execute("UPDATE commit_queue_items SET status = 'cancelled' WHERE id = 'new'", []).unwrap();
    assert_eq!(load_curate_projection(&conn).unwrap()[0]["id"], "old");
    conn.execute("UPDATE commit_queue_items SET status = 'completed' WHERE id = 'old'", []).unwrap();
    assert_eq!(load_curate_projection(&conn).unwrap()[0]["applies"], false);
}

#[tauri::command]
pub fn commit_retry_curate_items(
    db: State<crate::db::AppDb>,
    worker: State<CommitQueueWorker>,
    item_ids: Vec<String>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock();
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let mut retried = 0;
    for id in item_ids {
        let changed = tx.execute(
            "UPDATE commit_queue_items AS i SET status = 'pending', completed_at = NULL
             WHERE i.id = ?1 AND i.status = 'failed'
               AND CASE WHEN json_valid(i.payload_json) THEN json_extract(i.payload_json, '$.curate') END = 1
               AND NOT EXISTS (
                   SELECT 1 FROM commit_queue_items newer JOIN commit_queue_batches nb ON nb.id = newer.batch_id
                   WHERE newer.track_id = i.track_id AND newer.status <> 'cancelled'
                     AND nb.rowid > (SELECT b.rowid FROM commit_queue_batches b WHERE b.id = i.batch_id)
               )",
            [&id],
        ).map_err(|err| err.to_string())?;
        if changed > 0 {
            tx.execute(
                "UPDATE commit_queue_batches SET status = 'pending', completed_at = NULL
                 WHERE id = (SELECT batch_id FROM commit_queue_items WHERE id = ?1)",
                [&id],
            ).map_err(|err| err.to_string())?;
        }
        retried += changed;
    }
    tx.commit().map_err(|err| err.to_string())?;
    drop(conn);
    worker.emit_telemetry(true);
    Ok(retried)
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
