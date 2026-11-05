use std::collections::HashMap;
use std::sync::LazyLock;
use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension};
use crate::audio::AudioEngine;
use crate::db::AppDb;
use super::models::{CandidateTelemetry, CurationDecisionTrace, FieldDecision};

/// In-memory trace buffer to ensure Bit-Perfect Storage Bus Silence during active playback.
/// If an album curation completes while the AudioEngine is in Playing or Paused state,
/// the trace is held in RAM without performing disk I/O on library drives or SQLite.
static MEMORY_BUFFER: LazyLock<Mutex<HashMap<String, CurationDecisionTrace>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct CurationStorage;

impl CurationStorage {
    pub fn save_draft(db: &AppDb, album_id: &str, draft: &serde_json::Value) -> Result<(), String> {
        db.conn.lock().execute(
            "INSERT INTO curation_drafts (album_id, draft_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(album_id) DO UPDATE SET
                draft_json = excluded.draft_json, updated_at = excluded.updated_at",
            params![album_id, draft.to_string(), chrono::Utc::now().to_rfc3339()],
        ).map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn get_draft(db: &AppDb, album_id: &str) -> Result<Option<serde_json::Value>, String> {
        let draft: Option<String> = db.conn.lock().query_row(
            "SELECT draft_json FROM curation_drafts WHERE album_id = ?1",
            params![album_id],
            |row| row.get(0),
        ).optional().map_err(|err| err.to_string())?;
        draft.map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|err| err.to_string())
    }

    /// Saves a curation decision trace with audiophile idle-guarding and field-level merge semantics.
    pub fn save_trace(
        db: &AppDb,
        engine: &AudioEngine,
        album_id: &str,
        trace: CurationDecisionTrace,
    ) -> Result<(), String> {
        // Audiophile Guard: Zero Disk I/O while AudioEngine is active
        if engine.is_playing() || engine.is_paused() {
            let mut buffer = MEMORY_BUFFER.lock();
            // Perform in-memory field-level merge if already in buffer
            if let Some(existing) = buffer.get_mut(album_id) {
                for (field, decision) in trace.field_traces {
                    existing.field_traces.insert(field, decision);
                }
                existing.album_hash = trace.album_hash;
                existing.matched_release_id = trace.matched_release_id;
                existing.outcome_status = trace.outcome_status;
                existing.headline_summary = trace.headline_summary;
                existing.candidate_telemetry = trace.candidate_telemetry;
                existing.duration_ms = trace.duration_ms;
                existing.engine_version = trace.engine_version;
                existing.updated_at = trace.updated_at;
            } else {
                buffer.insert(album_id.to_string(), trace);
            }
            eprintln!(
                "[Audiophile Guard] Playback active. Curation trace for album '{}' buffered in RAM (zero disk I/O).",
                album_id
            );
            return Ok(());
        }

        // Flushes any previously buffered traces now that the engine is idle
        Self::flush_buffer_internal(db)?;

        // Persist the current trace to SQLite with field-level merge
        Self::persist_trace_to_db(db, album_id, trace)
    }

    /// Retrieves the latest curation decision trace for an album.
    /// Checks the in-memory RAM buffer first, then falls back to SQLite.
    pub fn get_trace(db: &AppDb, album_id: &str) -> Result<Option<CurationDecisionTrace>, String> {
        // 1. Check RAM buffer first
        {
            let buffer = MEMORY_BUFFER.lock();
            if let Some(trace) = buffer.get(album_id) {
                return Ok(Some(trace.clone()));
            }
        }

        // 2. Query SQLite
        let conn = db.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT
                    album_id,
                    album_hash,
                    matched_release_id,
                    outcome_status,
                    headline_summary,
                    field_traces_json,
                    candidate_telemetry_json,
                    duration_ms,
                    engine_version,
                    updated_at
                 FROM curation_decision_traces
                 WHERE album_id = ?1",
            )
            .map_err(|e| format!("Failed to prepare get_trace query: {}", e))?;

        let trace = stmt
            .query_row(params![album_id], |row| {
                let album_id: String = row.get(0)?;
                let album_hash: Option<String> = row.get(1)?;
                let matched_release_id: Option<String> = row.get(2)?;
                let outcome_status: String = row.get(3)?;
                let headline_summary: String = row.get(4)?;
                let field_traces_json: String = row.get(5)?;
                let candidate_telemetry_json: String = row.get(6)?;
                let duration_ms: Option<u64> = row.get(7)?;
                let engine_version: Option<String> = row.get(8)?;
                let updated_at: Option<String> = row.get(9)?;

                let field_traces = serde_json::from_str::<HashMap<String, FieldDecision>>(&field_traces_json)
                    .unwrap_or_default();
                let candidate_telemetry = serde_json::from_str::<Vec<CandidateTelemetry>>(&candidate_telemetry_json)
                    .unwrap_or_default();

                Ok(CurationDecisionTrace {
                    album_id,
                    album_hash,
                    matched_release_id,
                    outcome_status,
                    headline_summary,
                    field_traces,
                    candidate_telemetry,
                    duration_ms,
                    engine_version,
                    updated_at,
                })
            })
            .ok();

        Ok(trace)
    }

    /// Clears the curation trace for an album from both RAM buffer and SQLite.
    pub fn clear_trace(db: &AppDb, album_id: &str) -> Result<(), String> {
        {
            let mut buffer = MEMORY_BUFFER.lock();
            buffer.remove(album_id);
        }

        let conn = db.conn.lock();
        conn.execute(
            "DELETE FROM curation_decision_traces WHERE album_id = ?1",
            params![album_id],
        )
        .map_err(|e| format!("Failed to delete curation trace for album {}: {}", album_id, e))?;

        Ok(())
    }

    /// Internal helper to flush all RAM buffered traces into SQLite when idle.
    fn flush_buffer_internal(db: &AppDb) -> Result<(), String> {
        let items: Vec<(String, CurationDecisionTrace)> = {
            let mut buffer = MEMORY_BUFFER.lock();
            buffer.drain().collect()
        };

        for (album_id, trace) in items {
            Self::persist_trace_to_db(db, &album_id, trace)?;
        }

        Ok(())
    }

    /// Core persistence function with SQLite UPSERT and field-level merge logic.
    fn persist_trace_to_db(
        db: &AppDb,
        album_id: &str,
        mut trace: CurationDecisionTrace,
    ) -> Result<(), String> {
        let conn = db.conn.lock();

        // 1. Check for existing record to perform field-level merge
        let existing_fields: Option<HashMap<String, FieldDecision>> = conn
            .query_row(
                "SELECT field_traces_json FROM curation_decision_traces WHERE album_id = ?1",
                params![album_id],
                |row| {
                    let json_str: String = row.get(0)?;
                    Ok(serde_json::from_str::<HashMap<String, FieldDecision>>(&json_str).unwrap_or_default())
                },
            )
            .ok();

        if let Some(mut existing) = existing_fields {
            // Merge incoming field decisions into existing
            for (field, decision) in trace.field_traces {
                existing.insert(field, decision);
            }
            trace.field_traces = existing;
        }

        // 2. Serialize fields to JSON
        let field_traces_json = serde_json::to_string(&trace.field_traces)
            .map_err(|e| format!("Failed to serialize field_traces: {}", e))?;
        let candidate_telemetry_json = serde_json::to_string(&trace.candidate_telemetry)
            .map_err(|e| format!("Failed to serialize candidate_telemetry: {}", e))?;
        let updated_at_val = trace.updated_at.clone().unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        // 3. Execute SQLite UPSERT
        conn.execute(
            "INSERT INTO curation_decision_traces (
                album_id,
                album_hash,
                matched_release_id,
                outcome_status,
                headline_summary,
                field_traces_json,
                candidate_telemetry_json,
                duration_ms,
                engine_version,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(album_id) DO UPDATE SET
                album_hash = excluded.album_hash,
                matched_release_id = excluded.matched_release_id,
                outcome_status = excluded.outcome_status,
                headline_summary = excluded.headline_summary,
                field_traces_json = excluded.field_traces_json,
                candidate_telemetry_json = excluded.candidate_telemetry_json,
                duration_ms = excluded.duration_ms,
                engine_version = excluded.engine_version,
                updated_at = excluded.updated_at",
            params![
                album_id,
                trace.album_hash,
                trace.matched_release_id,
                trace.outcome_status,
                trace.headline_summary,
                field_traces_json,
                candidate_telemetry_json,
                trace.duration_ms,
                trace.engine_version,
                updated_at_val,
            ],
        )
        .map_err(|e| format!("Failed to upsert curation trace for album {}: {}", album_id, e))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn curate_draft_survives_reopening_an_existing_database() {
        let path = std::env::temp_dir().join(format!("cadence-draft-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            crate::db::schema::initialize_schema(&conn).unwrap();
            conn.execute("DROP TABLE curation_drafts", []).unwrap();
            conn.execute(
                "INSERT INTO compilation_provenance_cache VALUES ('legacy', 'album', 'Title', '{}', '{}', 'v1', 0)",
                [],
            ).unwrap();
        }
        let draft = json!({"version": 1, "staged": true, "fields": {"genre": {"selected": "Tamil Soundtrack"}}});
        {
            let db = AppDb::new(path.clone()).unwrap();
            assert_eq!(CurationStorage::get_draft(&db, "album").unwrap(), None);
            CurationStorage::save_draft(&db, "album", &json!({"version": 1, "staged": false})).unwrap();
            CurationStorage::save_draft(&db, "album", &draft).unwrap();
        }
        {
            let db = AppDb::new(path.clone()).unwrap();
            assert_eq!(CurationStorage::get_draft(&db, "album").unwrap(), Some(draft));
            assert_eq!(CurationStorage::get_draft(&db, "another-album").unwrap(), None);
            let preserved: i64 = db.conn.lock().query_row(
                "SELECT COUNT(*) FROM compilation_provenance_cache WHERE hash_key = 'legacy'",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(preserved, 1);
        }
        std::fs::remove_file(path).unwrap();
    }
}
