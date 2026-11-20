pub mod artwork_worker;
pub mod gate;
pub mod image_store;
pub mod matcher;
pub mod providers;
pub mod schema;
pub mod worker;

#[cfg(test)]
mod tests;

use crate::db::AppDb;
use image_store::ImageStore;
use rusqlite::{params, OptionalExtension};
use schema::{
    accept_album_proposal, apply_user_overlay, compute_enrichment_status, enqueue_rerun,
    get_enrichment_album_detail, get_enrichment_config, list_enrichment_albums,
    lock_album_file_tags, revert_album_to_file_tags, seed_pending_albums_and_artwork,
    set_enrichment_config, strip_core_release_prefix, unlock_album_for_enrichment,
    UserTrackOverlayEdit,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use worker::EnrichmentIdleGate;

pub fn handle_enrichment_request(
    db: &AppDb,
    gate: &Arc<EnrichmentIdleGate>,
    op: &str,
    req: &Value,
    track_db_ids: &HashMap<String, String>,
) -> (Value, bool) {
    let fail = |code: &str, msg: String| -> (Value, bool) {
        (
            json!({ "ok": false, "error": { "code": code, "message": msg } }),
            false,
        )
    };

    match op {
        "enrichment.status" => {
            let conn = db.conn.lock();
            if let Err(e) = schema::ensure_schema(&conn) {
                return fail("invalid_payload", e.to_string());
            }
            let (rt_state, cooldown_secs) = gate.runtime_state();
            let current = gate.current_album();
            let gates = gate.provider_gates_snapshot();
            match compute_enrichment_status(
                &conn,
                rt_state,
                cooldown_secs,
                current.as_ref().map(|(id, _)| id.clone()),
                current.map(|(_, title)| title),
                gates,
            ) {
                Ok(status) => (json!({ "ok": true, "data": status }), false),
                Err(e) => fail("invalid_payload", e.to_string()),
            }
        }
        "enrichment.control" => {
            let action = req
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut conn = db.conn.lock();
            if let Err(e) = schema::ensure_schema(&conn) {
                return fail("invalid_payload", e.to_string());
            }
            match action {
                "pause" => {
                    if let Err(e) = set_enrichment_config(&conn, None, Some(true)) {
                        return fail("invalid_payload", e.to_string());
                    }
                    if let Ok((enabled, paused, _)) = get_enrichment_config(&conn) {
                        gate.sync_config(enabled, paused);
                    }
                }
                "resume" => {
                    if let Err(e) = set_enrichment_config(&conn, None, Some(false)) {
                        return fail("invalid_payload", e.to_string());
                    }
                    if let Ok((enabled, paused, _)) = get_enrichment_config(&conn) {
                        gate.sync_config(enabled, paused);
                    }
                }
                "set_enabled" => {
                    let enabled = req.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                    if let Err(e) = set_enrichment_config(&conn, Some(enabled), None) {
                        return fail("invalid_payload", e.to_string());
                    }
                    if let Ok((en, paused, _)) = get_enrichment_config(&conn) {
                        gate.sync_config(en, paused);
                    }
                }
                "rerun_root" => {
                    let Some(fid) = req.get("folderId").and_then(Value::as_str) else {
                        return fail("invalid_payload", "Missing folderId".into());
                    };
                    if let Err(e) = enqueue_rerun(&mut conn, None, Some(fid), false) {
                        return fail("invalid_payload", e.to_string());
                    }
                    gate.wake();
                }
                "rerun_album" => {
                    let Some(rid) = req.get("releaseId").and_then(Value::as_str) else {
                        return fail("invalid_payload", "Missing releaseId".into());
                    };
                    if let Err(e) = enqueue_rerun(&mut conn, Some(rid), None, false) {
                        return fail("invalid_payload", e.to_string());
                    }
                    gate.wake();
                }
                "rerun_missing" => {
                    let _ = seed_pending_albums_and_artwork(&conn);
                    if let Err(e) = enqueue_rerun(&mut conn, None, None, true) {
                        return fail("invalid_payload", e.to_string());
                    }
                    gate.wake();
                }
                _ => return fail("invalid_payload", "Unsupported enrichment.control action".into()),
            }

            let (rt_state, cooldown_secs) = gate.runtime_state();
            let current = gate.current_album();
            let gates = gate.provider_gates_snapshot();
            match compute_enrichment_status(
                &conn,
                rt_state,
                cooldown_secs,
                current.as_ref().map(|(id, _)| id.clone()),
                current.map(|(_, title)| title),
                gates,
            ) {
                Ok(status) => {
                    gate.push_event("enrichment.updated", json!({ "action": action }));
                    (json!({ "ok": true, "data": status }), false)
                }
                Err(e) => fail("invalid_payload", e.to_string()),
            }
        }
        "enrichment.albums.list" => {
            let status_filter = req.get("status").and_then(Value::as_str);
            let folder_id = req.get("folderId").and_then(Value::as_str);
            let limit = req
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .clamp(1, 2000) as usize;
            let offset = req.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let conn = db.conn.lock();
            if let Err(e) = schema::ensure_schema(&conn) {
                return fail("invalid_payload", e.to_string());
            }
            match list_enrichment_albums(&conn, status_filter, folder_id, limit, offset) {
                Ok(albums) => (json!({ "ok": true, "data": { "albums": albums } }), false),
                Err(e) => fail("invalid_payload", e.to_string()),
            }
        }
        "enrichment.album.detail" => {
            let Some(rid) = req.get("releaseId").and_then(Value::as_str) else {
                return fail("invalid_payload", "Missing releaseId".into());
            };
            let conn = db.conn.lock();
            if let Err(e) = schema::ensure_schema(&conn) {
                return fail("invalid_payload", e.to_string());
            }
            match get_enrichment_album_detail(&conn, rid) {
                Ok(Some(detail)) => (json!({ "ok": true, "data": detail }), false),
                Ok(None) => fail("not_found", "Release not found".into()),
                Err(e) => fail("invalid_payload", e.to_string()),
            }
        }
        "enrichment.album.action" => {
            let Some(raw_rid) = req.get("releaseId").and_then(Value::as_str) else {
                return fail("invalid_payload", "Missing releaseId".into());
            };
            let Some(action) = req.get("action").and_then(Value::as_str) else {
                return fail("invalid_payload", "Missing action".into());
            };
            let rid = strip_core_release_prefix(raw_rid).to_string();
            let mut conn = db.conn.lock();
            if let Err(e) = schema::ensure_schema(&conn) {
                return fail("invalid_payload", e.to_string());
            }

            let res: Result<(), String> = match action {
                "save_overlay" => {
                    let fields = req
                        .get("fields")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let raw_tracks: Vec<UserTrackOverlayEdit> = req
                        .get("tracks")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|e| e.to_string())
                        .unwrap_or(None)
                        .unwrap_or_default();
                    let resolved_tracks: Vec<UserTrackOverlayEdit> = raw_tracks
                        .into_iter()
                        .map(|mut t| {
                            if let Some(raw_id) = track_db_ids.get(&t.track_id) {
                                t.track_id = raw_id.clone();
                            }
                            t
                        })
                        .collect();
                    let cover_art_url = req
                        .get("coverArtUrl")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let r = apply_user_overlay(
                        &mut conn,
                        &rid,
                        &fields,
                        &resolved_tracks,
                        "manual_edit",
                        cover_art_url,
                    );
                    if r.is_ok() && cover_art_url.is_some() {
                        gate.wake();
                    }
                    r
                }
                "accept_proposal" => accept_album_proposal(&mut conn, &rid),
                "revert_to_file" => revert_album_to_file_tags(&mut conn, &rid),
                "lock_file_tags" => lock_album_file_tags(&mut conn, &rid),
                "unlock_auto" => {
                    let r = unlock_album_for_enrichment(&mut conn, &rid);
                    if r.is_ok() {
                        gate.wake();
                    }
                    r
                }
                _ => Err("Unsupported enrichment.album.action".into()),
            };

            if let Err(e) = res {
                return fail("invalid_payload", e);
            }

            gate.push_event(
                "enrichment.updated",
                json!({ "releaseId": rid, "action": action }),
            );
            match get_enrichment_album_detail(&conn, &rid) {
                Ok(Some(detail)) => (json!({ "ok": true, "data": detail }), true),
                Ok(None) => fail("not_found", "Release not found".into()),
                Err(e) => fail("invalid_payload", e.to_string()),
            }
        }
        _ => fail("unsupported_capability", "Unsupported enrichment op".into()),
    }
}

pub fn serve_artist_artwork(
    db: &AppDb,
    artwork_dir: &Path,
    artist_id: &str,
) -> Result<(String, String, Vec<u8>), String> {
    if artist_id.len() > 128
        || !artist_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid artist ID".into());
    }
    let row: Option<(String, String)> = {
        let conn = db.conn.try_lock().ok_or("deferred_until_idle")?;
        conn.query_row(
            "SELECT image_hash, mime FROM artwork_items
             WHERE entity_kind = 'artist' AND entity_id = ?1
               AND status IN ('found', 'found_stale', 'user_override')
               AND image_hash IS NOT NULL AND mime IS NOT NULL",
            params![artist_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    let Some((hash, mime)) = row else {
        return Err("Artwork not found".into());
    };
    let store = ImageStore::new(artwork_dir.to_path_buf());
    let bytes = store.open_bytes(&hash, &mime)?;
    Ok((hash, mime, bytes))
}
