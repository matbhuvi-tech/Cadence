use std::collections::HashMap;
use std::sync::LazyLock;
use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension};
use crate::audio::AudioEngine;
use crate::db::{curate_identity, AppDb, DbOperations};
use super::models::{CandidateTelemetry, CurationDecisionTrace, FieldDecision};

/// In-memory trace buffer to ensure Bit-Perfect Storage Bus Silence during active playback.
/// If an album curation completes while the AudioEngine is in Playing or Paused state,
/// the trace is held in RAM without performing disk I/O on library drives or SQLite.
static MEMORY_BUFFER: LazyLock<Mutex<HashMap<String, CurationDecisionTrace>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct CurationStorage;

impl CurationStorage {
    pub fn get_identity(db: &AppDb, track_ids: &[String]) -> Result<Vec<serde_json::Value>, String> {
        let mut conn = db.conn.lock();
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let rows = curate_identity::snapshot(&tx, track_ids, true).map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(rows)
    }

    pub fn save_evidence(
        db: &AppDb, album_id: &str, run: &serde_json::Value,
    ) -> Result<bool, String> {
        let field = |name: &str| run.get(name).and_then(|value| value.as_str())
            .ok_or_else(|| format!("Evidence is missing {name}"));
        let id = field("id")?;
        let requested_at = field("requestedAt")?;
        let outcome = field("outcome")?;
        let decision: Option<CurationDecisionTrace> = run.get("decision").cloned()
            .map(serde_json::from_value).transpose().map_err(|err| err.to_string())?;
        if decision.as_ref().is_some_and(|trace| trace.album_id != album_id) {
            return Err("The evidence decision belongs to a different album.".into());
        }
        let mut conn = db.conn.lock();
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let mut run = run.clone();
        let inserted = tx.execute(
            "INSERT INTO curation_evidence_runs
                (id, album_id, requested_at, completed_at, trigger, outcome, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING",
            params![id, album_id, requested_at, field("completedAt")?, field("trigger")?, outcome, run.to_string()],
        ).map_err(|err| err.to_string())?;
        if outcome != "completed" || inserted == 0 {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        }
        let current: Option<(String, String)> = tx.query_row(
            "SELECT e.requested_at, e.id FROM curation_current_evidence c
             JOIN curation_evidence_runs e ON e.id = c.run_id WHERE c.album_id = ?1",
            [album_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|err| err.to_string())?;
        let identity = run["identity"].as_array();
        let matching_ids = identity.map(|snapshot| curate_identity::matching_snapshot_ids(&tx, snapshot))
            .transpose().map_err(|err| err.to_string())?.flatten();
        let mut applicable = (identity.is_none() || matching_ids.is_some())
            && current.is_none_or(|(date, current_id)| (requested_at, id) >= (date.as_str(), current_id.as_str()));
        if let Some(requested) = run["context"]["tracks"].as_array() {
            applicable &= matching_ids.as_ref().is_some_and(|ids| ids.len() == requested.len());
        }
        if let Some(confirmed) = run["confirmedCommitIds"].as_object() {
            let mut latest = tx.prepare_cached(
                "SELECT CASE WHEN json_valid(i.payload_json) AND json_extract(i.payload_json, '$.curate') = 1
                    THEN i.id END FROM commit_queue_items i JOIN commit_queue_batches b ON b.id = i.batch_id
                 WHERE i.track_id = ?1 AND i.status <> 'cancelled'
                 ORDER BY b.rowid DESC, i.rowid DESC LIMIT 1",
            ).map_err(|err| err.to_string())?;
            for (track_id, expected) in confirmed {
                let current: Option<String> = latest.query_row([track_id], |row| row.get(0))
                    .optional().map_err(|err| err.to_string())?.flatten();
                if current.as_deref() != expected.as_str() {
                    applicable = false;
                    break;
                }
            }
        }
        if !applicable {
            run["applicability"] = serde_json::json!("superseded");
            tx.execute("UPDATE curation_evidence_runs SET payload_json = ?1 WHERE id = ?2",
                params![run.to_string(), id]).map_err(|err| err.to_string())?;
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        }
        if let Some(trace) = decision {
            if let Some(ids) = matching_ids {
                let mut revisions = Vec::new();
                if let Some(candidates) = run["identityMappings"].as_array() {
                    for candidate in candidates {
                        let mapping: curate_identity::MappingCandidate = serde_json::from_value(candidate.clone())
                            .map_err(|err| err.to_string())?;
                        if !ids.contains(mapping.local_track_id.as_str()) {
                            continue;
                        }
                        curate_identity::record_mapping(&tx, &mapping).map_err(|err| err.to_string())?;
                        let revision: i64 = tx.query_row(
                            "SELECT revision FROM curate_identity_mappings WHERE local_track_id = ?1 AND provider = ?2",
                            params![mapping.local_track_id, mapping.provider], |row| row.get(0),
                        ).map_err(|err| err.to_string())?;
                        revisions.push(serde_json::json!({
                            "localTrackId": mapping.local_track_id, "provider": mapping.provider,
                            "mappingRev": revision,
                        }));
                    }
                }
                if let Some(candidates) = run["sourceCandidates"].as_array() {
                    for candidate in candidates {
                        let source: curate_identity::SourceCandidate = serde_json::from_value(candidate.clone())
                            .map_err(|err| err.to_string())?;
                        if ids.contains(source.local_track_id.as_str()) {
                            curate_identity::record_source(&tx, &source).map_err(|err| err.to_string())?;
                        }
                    }
                }
                run["mappingRevisions"] = serde_json::json!(revisions);
                tx.execute("UPDATE curation_evidence_runs SET payload_json = ?1 WHERE id = ?2",
                    params![run.to_string(), id]).map_err(|err| err.to_string())?;
            }
            Self::persist_trace(&tx, album_id, trace, false)?;
            tx.execute(
                "INSERT INTO curation_current_evidence (album_id, run_id) VALUES (?1, ?2)
                 ON CONFLICT(album_id) DO UPDATE SET run_id = excluded.run_id",
                params![album_id, id],
            ).map_err(|err| err.to_string())?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(true)
    }

    pub fn list_evidence(db: &AppDb, album_id: &str) -> Result<Vec<serde_json::Value>, String> {
        let conn = db.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT e.id, e.trigger, e.requested_at, e.completed_at, e.outcome, c.run_id IS e.id,
             CASE WHEN json_extract(e.payload_json, '$.applicability') = 'superseded' THEN 'superseded'
               WHEN COALESCE(json_array_length(e.payload_json, '$.identity'), 0) = 0 THEN 'unverified' END
             FROM curation_evidence_runs e LEFT JOIN curation_current_evidence c ON c.album_id = e.album_id
             WHERE e.album_id = ?1 ORDER BY e.requested_at DESC, e.id DESC",
        ).map_err(|err| err.to_string())?;
        let rows = stmt.query_map([album_id], |row| Ok(serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "trigger": row.get::<_, String>(1)?,
            "requestedAt": row.get::<_, String>(2)?,
            "completedAt": row.get::<_, String>(3)?,
            "outcome": row.get::<_, String>(4)?,
            "current": row.get::<_, bool>(5)?,
            "applicability": row.get::<_, Option<String>>(6)?,
        }))).map_err(|err| err.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|err| err.to_string())
    }

    pub fn get_evidence(
        db: &AppDb, album_id: &str, id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let json: Option<String> = db.conn.lock().query_row(
            "SELECT payload_json FROM curation_evidence_runs WHERE album_id = ?1 AND id = ?2",
            params![album_id, id], |row| row.get(0),
        ).optional().map_err(|err| err.to_string())?;
        json.map(|json| serde_json::from_str(&json)).transpose().map_err(|err| err.to_string())
    }

    pub fn save_draft(db: &AppDb, album_id: &str, draft: &serde_json::Value) -> Result<(), String> {

        let mut conn = db.conn.lock();
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let previous: Option<String> = tx.query_row(
            "SELECT draft_json FROM curation_drafts WHERE album_id = ?1",
            [album_id], |row| row.get(0),
        ).optional().map_err(|err| err.to_string())?;
        let previous: serde_json::Value = previous.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
        if let Some(revision) = draft["revision"].as_str() {
            let next = DbOperations::record_curate_draft_revision(&tx, album_id, revision)
                .map_err(|err| err.to_string())?;
            if let Some(previous_revision) = previous["revision"].as_str() {
                let current = DbOperations::record_curate_draft_revision(&tx, album_id, previous_revision)
                    .map_err(|err| err.to_string())?;
                if next < current {
                    return Err("A newer Curate draft is already saved.".into());
                }
            }
        }
        curate_identity::record_draft_edits(&tx, album_id, &previous, draft).map_err(|err| err.to_string())?;
        tx.execute(
            "INSERT INTO curation_drafts (album_id, draft_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(album_id) DO UPDATE SET
                draft_json = excluded.draft_json, updated_at = excluded.updated_at",
            params![album_id, draft.to_string(), chrono::Utc::now().to_rfc3339()],
        ).map_err(|err| err.to_string())?;

        tx.commit().map_err(|err| err.to_string())
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
        trace: CurationDecisionTrace,
    ) -> Result<(), String> {
        let conn = db.conn.lock();
        Self::persist_trace(&conn, album_id, trace, true)
    }

    fn persist_trace(
        conn: &rusqlite::Connection,
        album_id: &str,
        mut trace: CurationDecisionTrace,
        merge: bool,
    ) -> Result<(), String> {

        // 1. Check for existing record to perform field-level merge
        let existing_fields: Option<HashMap<String, FieldDecision>> = if merge { conn
            .query_row(
                "SELECT field_traces_json FROM curation_decision_traces WHERE album_id = ?1",
                params![album_id],
                |row| {
                    let json_str: String = row.get(0)?;
                    Ok(serde_json::from_str::<HashMap<String, FieldDecision>>(&json_str).unwrap_or_default())
                },
            )
            .ok() } else { None };

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

        // Some upgraded catalogs retain mandatory columns from the original trace table.
        let legacy: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('curation_decision_traces') WHERE name = 'timestamp')",
            [],
            |row| row.get(0),
        ).map_err(|err| err.to_string())?;
        let legacy_timestamp = chrono::DateTime::parse_from_rfc3339(&updated_at_val)
            .map(|date| date.timestamp_millis()).unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
        let legacy_duration = trace.duration_ms.unwrap_or_default();
        let legacy_engine = trace.engine_version.as_deref().unwrap_or("unknown");
        let providers = serde_json::to_string(
            &trace.candidate_telemetry.iter().map(|candidate| candidate.provider.as_str()).collect::<Vec<_>>(),
        ).map_err(|err| err.to_string())?;
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![
            &album_id, &trace.album_hash, &trace.matched_release_id, &trace.outcome_status,
            &trace.headline_summary, &field_traces_json, &candidate_telemetry_json,
            &trace.duration_ms, &trace.engine_version, &updated_at_val,
        ];
        let (legacy_columns, legacy_values, legacy_updates) = if legacy {
            values.extend([&legacy_timestamp as &dyn rusqlite::ToSql, &legacy_duration, &providers, &legacy_engine]);
            (
                ", timestamp, execution_duration_ms, providers_queried, providers_failed,
                   candidates_json, selected_candidate_id, decisions_json, user_explanation, algorithm_version",
                ", ?11, ?12, ?13, '[]', ?7, ?3, ?6, ?5, ?14",
                ", timestamp = excluded.timestamp,
                   execution_duration_ms = excluded.execution_duration_ms,
                   providers_queried = excluded.providers_queried,
                   providers_failed = excluded.providers_failed,
                   candidates_json = excluded.candidates_json,
                   selected_candidate_id = excluded.selected_candidate_id,
                   decisions_json = excluded.decisions_json,
                   user_explanation = excluded.user_explanation,
                   algorithm_version = excluded.algorithm_version",
            )
        } else {
            ("", "", "")
        };
        let sql = format!(
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
                updated_at{legacy_columns}
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10{legacy_values})
            ON CONFLICT(album_id) DO UPDATE SET
                album_hash = excluded.album_hash,
                matched_release_id = excluded.matched_release_id,
                outcome_status = excluded.outcome_status,
                headline_summary = excluded.headline_summary,
                field_traces_json = excluded.field_traces_json,
                candidate_telemetry_json = excluded.candidate_telemetry_json,
                duration_ms = excluded.duration_ms,
                engine_version = excluded.engine_version,
                updated_at = excluded.updated_at{legacy_updates}"
        );
        conn.execute(&sql, rusqlite::params_from_iter(values))
        .map_err(|e| format!("Failed to upsert curation trace for album {}: {}", album_id, e))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refresh_saves_on_legacy_trace_schema() {
        let path = std::env::temp_dir().join(format!("cadence-legacy-trace-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE curation_decision_traces (
                    album_id TEXT PRIMARY KEY, matched_release_id TEXT,
                    timestamp INTEGER NOT NULL, execution_duration_ms INTEGER NOT NULL,
                    outcome_status TEXT NOT NULL, providers_queried TEXT NOT NULL,
                    providers_failed TEXT NOT NULL, candidates_json TEXT NOT NULL,
                    selected_candidate_id TEXT, decisions_json TEXT NOT NULL,
                    user_explanation TEXT NOT NULL, algorithm_version TEXT NOT NULL
                 );
                 INSERT INTO curation_decision_traces VALUES (
                    'existing', NULL, 1, 10, 'evaluated_unchanged', '[]', '[]', '[]',
                    NULL, '{}', 'Original trace', 'legacy'
                 );",
            ).unwrap();
        }
        {
            let db = AppDb::new(path.clone()).unwrap();
            for (album, id) in [("new-album", "new-run"), ("existing", "updated-run")] {
                let run = json!({
                    "id": id, "requestedAt": "2026-11-05T15:00:00.000Z",
                    "completedAt": "2026-11-05T15:00:01.000Z", "outcome": "completed",
                    "trigger": "user_refresh", "attempts": [],
                    "decision": {
                        "albumId": album, "outcomeStatus": "matched_applied",
                        "headlineSummary": "Saved refresh", "durationMs": 1000,
                        "engineVersion": "cadence-curate-v2", "updatedAt": "2026-11-05T15:00:01.000Z",
                    },
                });
                CurationStorage::save_evidence(&db, album, &run).unwrap();
                assert_eq!(CurationStorage::list_evidence(&db, album).unwrap()[0]["current"], true);
                assert_eq!(CurationStorage::get_trace(&db, album).unwrap().unwrap().headline_summary, "Saved refresh");
            }
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn evidence_history_survives_reopen_and_only_newest_completed_decision_is_current() {
        let path = std::env::temp_dir().join(format!("cadence-evidence-{}.sqlite", uuid::Uuid::new_v4()));
        let make_run = |id: &str, time: &str, outcome: &str| {
            let mut run = json!({
                "id": id, "requestedAt": time, "completedAt": time,
                "outcome": outcome, "trigger": "user_refresh", "attempts": [],
            });
            run["attempts"] = json!([
                {"provider": "gemini", "outcome": "http_error", "httpStatus": 429, "errorMessage": "Quota exhausted"},
                {"provider": "gemini", "outcome": "success", "modelUsed": "fixture-model",
                 "candidate": {"trackCount": 1, "tracks": [
                     {"localTrackId": "one", "title": "Song", "originalAlbum": "Film", "originalYear": 1986,
                      "composer": "Composer", "artist": "Singer", "confidence": 0.85, "notes": "Source match"}
                 ]}}
            ]);
            if outcome == "completed" {
                run["decision"] = json!({
                    "albumId": "album", "headlineSummary": id,
                    "outcomeStatus": "evaluated_unchanged", "fieldTraces": {}, "updatedAt": time,
                });
            }
            run
        };
        {
            let db = AppDb::new(path.clone()).unwrap();
            CurationStorage::save_evidence(&db, "album", &make_run("current", "2026-01-02T10:00:00.000Z", "completed")).unwrap();
            CurationStorage::save_evidence(&db, "album", &make_run("late", "2026-01-01T10:00:00.000Z", "completed")).unwrap();
            CurationStorage::save_evidence(&db, "album", &make_run("failed", "2026-01-03T10:00:00.000Z", "failed")).unwrap();
            CurationStorage::save_evidence(&db, "album", &make_run("current", "2026-01-04T10:00:00.000Z", "cancelled")).unwrap();
        }
        {
            let db = AppDb::new(path.clone()).unwrap();
            let rows = CurationStorage::list_evidence(&db, "album").unwrap();
            assert_eq!(rows.len(), 3);
            assert_eq!(rows[0]["id"], "failed");
            assert_eq!(rows[0]["current"], false);
            assert_eq!(rows[1]["id"], "current");
            assert_eq!(rows[1]["current"], true);
            assert_eq!(CurationStorage::get_trace(&db, "album").unwrap().unwrap().headline_summary, "current");
            assert!(CurationStorage::get_evidence(&db, "album", "late").unwrap().is_some());
            assert!(CurationStorage::get_evidence(&db, "other", "late").unwrap().is_none());
            let saved = CurationStorage::get_evidence(&db, "album", "current").unwrap().unwrap();
            assert_eq!(saved["attempts"], make_run("current", "2026-01-02T10:00:00.000Z", "completed")["attempts"]);
        }
        std::fs::remove_file(path).unwrap();
    }

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
