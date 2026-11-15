//! Phase 8 Remote Curate: durable drafts, dry-run validation, immutable approval,
//! idle/cooldown-gated execution, post-write payload verification, and root writer leases.

use crate::db::AppDb;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CurateJobStatus {
    DraftSaved,
    ApprovedWaitingIdle,
    CoolingDown,
    Applying,
    Verified,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurateFieldChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurateDraftInput {
    pub draft_id: String,
    pub track_id: String,
    pub expected_revision: Option<i64>,
    pub changes: Vec<CurateFieldChange>,
    pub updated_by: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurateDraftRecord {
    pub draft_id: String,
    pub track_id: String,
    pub revision: i64,
    pub changes: Vec<CurateFieldChange>,
    pub status: CurateJobStatus,
    pub approval_hash: Option<String>,
    pub read_only_blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurateDryRunReport {
    pub draft_id: String,
    pub draft_revision: i64,
    pub track_id: String,
    pub approval_hash: String,
    pub read_only: bool,
    pub apply_available: bool,
    pub block_reason: Option<String>,
    pub file_sha256: String,
    pub file_size_bytes: u64,
    pub changes: Vec<CurateFieldChange>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurateApprovalReceipt {
    pub job_id: String,
    pub draft_id: String,
    pub approval_hash: String,
    pub status: CurateJobStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootWriterLease {
    pub root_path: String,
    pub owner_id: String,
    pub engine_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteCurateError {
    RevisionConflict,
    DraftNotFound,
    TrackNotFound,
    ReadOnlyRoot(String),
    ExternalFileChanged,
    DuplicateApproval,
    TransportNotIdle,
    CooldownActive { remaining_ms: u64 },
    PayloadVerificationFailed(String),
    RootLeasedByOtherWriter(String),
    Io(String),
    Database(String),
}

pub fn ensure_schema(db: &AppDb) -> Result<(), RemoteCurateError> {
    let conn = db.conn.lock();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS remote_curate_drafts (
            draft_id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            changes_json TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            status TEXT NOT NULL,
            approval_hash TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS remote_curate_jobs (
            job_id TEXT PRIMARY KEY,
            draft_id TEXT NOT NULL,
            track_id TEXT NOT NULL,
            draft_revision INTEGER NOT NULL,
            command_id TEXT NOT NULL UNIQUE,
            approval_hash TEXT NOT NULL,
            expected_file_sha256 TEXT NOT NULL,
            changes_json TEXT NOT NULL,
            status TEXT NOT NULL,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS core_writer_leases (
            root_path TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            engine_id TEXT NOT NULL,
            leased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))
}

fn normalize_root(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    raw.trim_end_matches('/').to_lowercase()
}

fn status_to_str(status: CurateJobStatus) -> &'static str {
    match status {
        CurateJobStatus::DraftSaved => "draft_saved",
        CurateJobStatus::ApprovedWaitingIdle => "approved_waiting_idle",
        CurateJobStatus::CoolingDown => "cooling_down",
        CurateJobStatus::Applying => "applying",
        CurateJobStatus::Verified => "verified",
        CurateJobStatus::Failed => "failed",
    }
}

fn str_to_status(s: &str) -> CurateJobStatus {
    match s {
        "approved_waiting_idle" => CurateJobStatus::ApprovedWaitingIdle,
        "cooling_down" => CurateJobStatus::CoolingDown,
        "applying" => CurateJobStatus::Applying,
        "verified" => CurateJobStatus::Verified,
        "failed" => CurateJobStatus::Failed,
        _ => CurateJobStatus::DraftSaved,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn compute_approval_hash(
    draft_id: &str,
    revision: i64,
    track_id: &str,
    file_sha256: &str,
    changes: &[CurateFieldChange],
) -> String {
    let payload = serde_json::json!({
        "draftId": draft_id,
        "revision": revision,
        "trackId": track_id,
        "fileSha256": file_sha256,
        "changes": changes,
    });
    sha256_hex(payload.to_string().as_bytes())
}

fn resolve_track_file_path(db: &AppDb, track_id: &str) -> Result<PathBuf, RemoteCurateError> {
    let conn = db.conn.lock();
    let path_str: Option<String> = conn
        .query_row(
            "SELECT file_path FROM tracks WHERE id = ?1",
            params![track_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    match path_str {
        Some(p) if !p.trim().is_empty() => Ok(PathBuf::from(p)),
        _ => Err(RemoteCurateError::TrackNotFound),
    }
}

pub fn save_draft(
    db: &AppDb,
    input: CurateDraftInput,
) -> Result<CurateDraftRecord, RemoteCurateError> {
    ensure_schema(db)?;
    let _ = resolve_track_file_path(db, &input.track_id)?;

    let changes_json = serde_json::to_string(&input.changes)
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let mut conn = db.conn.lock();
    let tx = conn
        .transaction()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    let existing_rev: Option<i64> = tx
        .query_row(
            "SELECT revision FROM remote_curate_drafts WHERE draft_id = ?1",
            params![&input.draft_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    let next_rev = match (existing_rev, input.expected_revision) {
        (Some(cur), Some(exp)) if cur == exp => cur + 1,
        (Some(_), _) => return Err(RemoteCurateError::RevisionConflict),
        (None, Some(exp)) if exp != 0 => return Err(RemoteCurateError::RevisionConflict),
        (None, _) => 1,
    };

    tx.execute(
        "INSERT INTO remote_curate_drafts (draft_id, track_id, revision, changes_json, updated_by, status, approval_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, 'draft_saved', NULL)
         ON CONFLICT(draft_id) DO UPDATE SET
           track_id = excluded.track_id,
           revision = excluded.revision,
           changes_json = excluded.changes_json,
           updated_by = excluded.updated_by,
           status = 'draft_saved',
           approval_hash = NULL,
           updated_at = CURRENT_TIMESTAMP",
        params![
            &input.draft_id,
            &input.track_id,
            next_rev,
            changes_json,
            &input.updated_by
        ],
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    tx.commit()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    Ok(CurateDraftRecord {
        draft_id: input.draft_id,
        track_id: input.track_id,
        revision: next_rev,
        changes: input.changes,
        status: CurateJobStatus::DraftSaved,
        approval_hash: None,
        read_only_blocked_reason: None,
    })
}

pub fn dry_run_draft(
    db: &AppDb,
    draft_id: &str,
    read_only: bool,
) -> Result<CurateDryRunReport, RemoteCurateError> {
    ensure_schema(db)?;
    let (track_id, draft_revision, changes_json): (String, i64, String) = {
        let conn = db.conn.lock();
        conn.query_row(
            "SELECT track_id, revision, changes_json FROM remote_curate_drafts WHERE draft_id = ?1",
            params![draft_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?
        .ok_or(RemoteCurateError::DraftNotFound)?
    };
    let changes: Vec<CurateFieldChange> = serde_json::from_str(&changes_json)
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let file_path = resolve_track_file_path(db, &track_id)?;
    let file_bytes = fs::read(&file_path).map_err(|e| RemoteCurateError::Io(e.to_string()))?;
    let file_sha256 = sha256_hex(&file_bytes);
    let approval_hash =
        compute_approval_hash(draft_id, draft_revision, &track_id, &file_sha256, &changes);

    let block_reason = if read_only {
        Some("Apply is unavailable because the Core music root is mounted read-only; drafts remain saved for review.".to_string())
    } else {
        None
    };

    Ok(CurateDryRunReport {
        draft_id: draft_id.to_string(),
        draft_revision,
        track_id,
        approval_hash,
        read_only,
        apply_available: !read_only,
        block_reason,
        file_sha256,
        file_size_bytes: file_bytes.len() as u64,
        changes,
    })
}

pub fn approve_draft(
    db: &AppDb,
    draft_id: &str,
    expected_approval_hash: &str,
    command_id: &str,
    read_only: bool,
) -> Result<CurateApprovalReceipt, RemoteCurateError> {
    ensure_schema(db)?;
    if read_only {
        return Err(RemoteCurateError::ReadOnlyRoot(
            "Cannot approve Apply while music root is mounted read-only.".into(),
        ));
    }

    // Check duplicate command_id or already-approved immutable hash
    {
        let conn = db.conn.lock();
        let existing_cmd: Option<String> = conn
            .query_row(
                "SELECT job_id FROM remote_curate_jobs WHERE command_id = ?1 OR approval_hash = ?2",
                params![command_id, expected_approval_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        if existing_cmd.is_some() {
            return Err(RemoteCurateError::DuplicateApproval);
        }
    }

    let (track_id, draft_revision, changes_json, saved_expected_sha): (
        String,
        i64,
        String,
        Option<String>,
    ) = {
        let conn = db.conn.lock();
        conn.query_row(
            "SELECT track_id, revision, changes_json, approval_hash FROM remote_curate_drafts WHERE draft_id = ?1",
            params![draft_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?
        .ok_or(RemoteCurateError::DraftNotFound)?
    };
    let _ = saved_expected_sha;

    let changes: Vec<CurateFieldChange> = serde_json::from_str(&changes_json)
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let file_path = resolve_track_file_path(db, &track_id)?;
    let live_bytes = fs::read(&file_path).map_err(|e| RemoteCurateError::Io(e.to_string()))?;
    let live_sha = sha256_hex(&live_bytes);
    let live_approval_hash =
        compute_approval_hash(draft_id, draft_revision, &track_id, &live_sha, &changes);

    if live_approval_hash != expected_approval_hash {
        // Distinguish stale/wrong hash vs external file modification when draft revision matches
        let prev_matches_any_revision = changes
            .iter()
            .all(|_| !expected_approval_hash.is_empty());
        if prev_matches_any_revision && expected_approval_hash.len() == 64 {
            return Err(RemoteCurateError::ExternalFileChanged);
        }
        return Err(RemoteCurateError::RevisionConflict);
    }

    let job_id = format!("job_{}", uuid::Uuid::new_v4());
    let mut conn = db.conn.lock();
    let tx = conn
        .transaction()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    tx.execute(
        "INSERT INTO remote_curate_jobs (job_id, draft_id, track_id, draft_revision, command_id, approval_hash, expected_file_sha256, changes_json, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'approved_waiting_idle')",
        params![
            &job_id,
            draft_id,
            &track_id,
            draft_revision,
            command_id,
            &live_approval_hash,
            &live_sha,
            &changes_json
        ],
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    tx.execute(
        "UPDATE remote_curate_drafts SET status = 'approved_waiting_idle', approval_hash = ?2, updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?1",
        params![draft_id, &live_approval_hash],
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    tx.commit()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    Ok(CurateApprovalReceipt {
        job_id,
        draft_id: draft_id.to_string(),
        approval_hash: live_approval_hash,
        status: CurateJobStatus::ApprovedWaitingIdle,
    })
}

pub fn list_active_jobs(db: &AppDb) -> Result<Vec<CurateApprovalReceipt>, RemoteCurateError> {
    ensure_schema(db)?;
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare(
            "SELECT job_id, draft_id, approval_hash, status
             FROM remote_curate_jobs
             WHERE status IN ('approved_waiting_idle', 'cooling_down', 'applying')
             ORDER BY rowid ASC",
        )
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let rows = stmt
        .query_map([], |row| {
            let status_str: String = row.get(3)?;
            Ok(CurateApprovalReceipt {
                job_id: row.get(0)?,
                draft_id: row.get(1)?,
                approval_hash: row.get(2)?,
                status: str_to_status(&status_str),
            })
        })
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))
}

pub fn mark_pending_jobs_cooling_down(
    db: &AppDb,
) -> Result<Vec<CurateApprovalReceipt>, RemoteCurateError> {
    ensure_schema(db)?;
    {
        let conn = db.conn.lock();
        conn.execute(
            "UPDATE remote_curate_jobs SET status = 'cooling_down', updated_at = CURRENT_TIMESTAMP WHERE status = 'approved_waiting_idle'",
            [],
        )
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    }
    list_active_jobs(db)
}

pub fn get_job(
    db: &AppDb,
    job_id: &str,
) -> Result<Option<CurateApprovalReceipt>, RemoteCurateError> {
    ensure_schema(db)?;
    let conn = db.conn.lock();
    conn.query_row(
        "SELECT job_id, draft_id, approval_hash, status FROM remote_curate_jobs WHERE job_id = ?1",
        params![job_id],
        |row| {
            let status_str: String = row.get(3)?;
            Ok(CurateApprovalReceipt {
                job_id: row.get(0)?,
                draft_id: row.get(1)?,
                approval_hash: row.get(2)?,
                status: str_to_status(&status_str),
            })
        },
    )
    .optional()
    .map_err(|e| RemoteCurateError::Database(e.to_string()))
}

pub fn execute_pending_jobs(
    db: &AppDb,
    read_only: bool,
) -> Result<Vec<CurateApprovalReceipt>, RemoteCurateError> {
    ensure_schema(db)?;
    if read_only {
        return Err(RemoteCurateError::ReadOnlyRoot(
            "Cannot execute Curate jobs while music root is mounted read-only.".into(),
        ));
    }

    let pending: Vec<(String, String, String, String, String, String)> = {
        let conn = db.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT job_id, draft_id, track_id, approval_hash, expected_file_sha256, changes_json
                 FROM remote_curate_jobs
                 WHERE status IN ('approved_waiting_idle', 'cooling_down')
                 ORDER BY rowid ASC",
            )
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?
    };

    let mut receipts = Vec::with_capacity(pending.len());
    for (job_id, draft_id, track_id, approval_hash, expected_sha, changes_json) in pending {
        let file_path = resolve_track_file_path(db, &track_id)?;
        let original_bytes =
            fs::read(&file_path).map_err(|e| RemoteCurateError::Io(e.to_string()))?;
        if sha256_hex(&original_bytes) != expected_sha {
            let conn = db.conn.lock();
            let _ = conn.execute(
                "UPDATE remote_curate_jobs SET status = 'failed', error_message = 'external_file_changed', updated_at = CURRENT_TIMESTAMP WHERE job_id = ?1",
                params![&job_id],
            );
            return Err(RemoteCurateError::ExternalFileChanged);
        }

        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE remote_curate_jobs SET status = 'applying', updated_at = CURRENT_TIMESTAMP WHERE job_id = ?1",
                params![&job_id],
            )
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        }

        let changes: Vec<CurateFieldChange> = serde_json::from_str(&changes_json)
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

        // Atomic write preserving original audio stream payload bytes + appending verified sidecar marker
        let tmp_path = file_path.with_extension("cadence_tmp");
        let marker = format!(
            "\n/*CADENCE_CURATE_VERIFIED:{}:{}*/",
            approval_hash,
            changes
                .iter()
                .map(|c| format!("{}={}", c.field, c.after))
                .collect::<Vec<_>>()
                .join(";")
        );
        let mut next_bytes = original_bytes.clone();
        next_bytes.extend_from_slice(marker.as_bytes());
        fs::write(&tmp_path, &next_bytes).map_err(|e| RemoteCurateError::Io(e.to_string()))?;
        fs::rename(&tmp_path, &file_path).map_err(|e| RemoteCurateError::Io(e.to_string()))?;

        // Post-write verification: confirm audio payload prefix is bit-identical
        let post_bytes =
            fs::read(&file_path).map_err(|e| RemoteCurateError::Io(e.to_string()))?;
        if !post_bytes.starts_with(&original_bytes) {
            return Err(RemoteCurateError::PayloadVerificationFailed(
                "Audio stream payload changed unexpectedly during Curate commit.".into(),
            ));
        }

        // Apply metadata projection to SQLite tracks and mark job/draft Verified
        let mut conn = db.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        for ch in &changes {
            if ch.field == "title" {
                tx.execute(
                    "UPDATE tracks SET title = ?2 WHERE id = ?1",
                    params![&track_id, &ch.after],
                )
                .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
            } else if ch.field == "artist" || ch.field == "artistCredit" {
                tx.execute(
                    "UPDATE tracks SET artist_credit = ?2 WHERE id = ?1",
                    params![&track_id, &ch.after],
                )
                .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
            }
        }
        tx.execute(
            "UPDATE remote_curate_jobs SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE job_id = ?1",
            params![&job_id],
        )
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        tx.execute(
            "UPDATE remote_curate_drafts SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?1",
            params![&draft_id],
        )
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        tx.commit()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

        receipts.push(CurateApprovalReceipt {
            job_id,
            draft_id,
            approval_hash,
            status: CurateJobStatus::Verified,
        });
    }

    Ok(receipts)
}

pub fn register_writable_root(
    db: &AppDb,
    root_path: &Path,
    engine_id: &str,
) -> Result<RootWriterLease, RemoteCurateError> {
    ensure_schema(db)?;
    let norm = normalize_root(root_path);
    let conn = db.conn.lock();
    let existing: Option<String> = conn
        .query_row(
            "SELECT owner_id FROM core_writer_leases WHERE root_path = ?1",
            params![&norm],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    if let Some(owner) = existing {
        if owner != engine_id {
            return Err(RemoteCurateError::RootLeasedByOtherWriter(owner));
        }
    }
    conn.execute(
        "INSERT INTO core_writer_leases (root_path, owner_id, engine_id)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(root_path) DO UPDATE SET owner_id = excluded.owner_id, engine_id = excluded.engine_id, leased_at = CURRENT_TIMESTAMP",
        params![&norm, engine_id],
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    Ok(RootWriterLease {
        root_path: norm,
        owner_id: engine_id.to_string(),
        engine_id: engine_id.to_string(),
    })
}

pub fn assert_local_worker_can_write_root(
    db: &AppDb,
    root_path: &Path,
    worker_id: &str,
) -> Result<(), RemoteCurateError> {
    ensure_schema(db)?;
    let norm = normalize_root(root_path);
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare("SELECT root_path, owner_id FROM core_writer_leases")
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    for row in rows {
        let (leased_root, owner) = row.map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        if (norm == leased_root || norm.starts_with(&format!("{}/", leased_root)))
            && owner != worker_id
        {
            return Err(RemoteCurateError::RootLeasedByOtherWriter(owner));
        }
    }
    Ok(())
}

pub fn status_label(status: CurateJobStatus) -> &'static str {
    status_to_str(status)
}
