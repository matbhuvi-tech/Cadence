//! Phase 8 Remote Curate: durable drafts, dry-run validation, immutable approval,
//! idle/cooldown-gated execution, post-write payload verification, and root writer leases.

use crate::db::AppDb;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
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
            dry_run_revision INTEGER,
            dry_run_file_sha256 TEXT,
            dry_run_file_size INTEGER,
            dry_run_mtime_ns INTEGER,
            dry_run_writable_ok INTEGER,
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
            result_file_sha256 TEXT,
            changes_json TEXT NOT NULL,
            status TEXT NOT NULL,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS remote_curate_journal (
            job_id TEXT PRIMARY KEY,
            original_bytes BLOB NOT NULL,
            result_bytes BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_writer_leases (
            root_path TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            engine_id TEXT NOT NULL,
            leased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

    let has_result_sha: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('remote_curate_jobs') WHERE name = 'result_file_sha256')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !has_result_sha {
        let _ = conn.execute(
            "ALTER TABLE remote_curate_jobs ADD COLUMN result_file_sha256 TEXT",
            [],
        );
    }

    for (col, ty) in [
        ("dry_run_revision", "INTEGER"),
        ("dry_run_file_sha256", "TEXT"),
        ("dry_run_file_size", "INTEGER"),
        ("dry_run_mtime_ns", "INTEGER"),
        ("dry_run_writable_ok", "INTEGER"),
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('remote_curate_drafts') WHERE name = ?1)",
                params![col],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !exists {
            let _ = conn.execute(
                &format!("ALTER TABLE remote_curate_drafts ADD COLUMN {col} {ty}"),
                [],
            );
        }
    }

    // Reclaim orphaned audio BLOBs left behind by prior failed/finished jobs.
    let pruned = conn
        .execute(
            "DELETE FROM remote_curate_journal
             WHERE job_id NOT IN (
                 SELECT job_id FROM remote_curate_jobs
                 WHERE status IN ('approved_waiting_idle', 'cooling_down', 'applying')
             )",
            [],
        )
        .unwrap_or(0);
    if pruned > 0 {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    Ok(())
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

    let applying: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM remote_curate_jobs WHERE draft_id=?1 AND status IN ('approved_waiting_idle','cooling_down','applying'))",params![input.draft_id],|r|r.get(0)).map_err(|e|RemoteCurateError::Database(e.to_string()))?;
    if applying{return Err(RemoteCurateError::RevisionConflict);}

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
           dry_run_revision = NULL,
           dry_run_file_sha256 = NULL,
           dry_run_file_size = NULL,
           dry_run_mtime_ns = NULL,
           dry_run_writable_ok = NULL,
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

const APPROVE_STAT_CACHE_MIN_BYTES: u64 = 1_048_576;
const MAX_COMMIT_FILE_BYTES: u64 = 256 * 1024 * 1024;

fn file_size_and_mtime_ns(file: &fs::File) -> Option<(u64, i64)> {
    let meta = file.metadata().ok()?;
    let modified = meta.modified().ok()?;
    let mtime_ns = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .min(i64::MAX as u128) as i64;
    Some((meta.len(), mtime_ns))
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
    let source = authorized_target(db, &file_path)?;
    let file_stat = file_size_and_mtime_ns(&source.source);
    let stat_size = source
        .source
        .metadata()
        .map(|m| m.len())
        .ok()
        .or_else(|| file_stat.map(|(sz, _)| sz));
    let is_dsd = file_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("dsf") || e.eq_ignore_ascii_case("dff"));
    if is_dsd || stat_size.is_some_and(|sz| sz > MAX_COMMIT_FILE_BYTES) {
        drop(source);
        let placeholder_sha = sha256_hex(b"");
        let approval_hash =
            compute_approval_hash(draft_id, draft_revision, &track_id, &placeholder_sha, &changes);
        let reason = if is_dsd {
            "DSD files (.dsf/.dff) cannot have embedded tags rewritten — use Save to Cache instead."
        } else {
            "Track exceeds the 256 MiB file-write safety limit — use Save to Cache instead."
        };
        return Ok(CurateDryRunReport {
            draft_id: draft_id.to_string(),
            draft_revision,
            track_id,
            approval_hash,
            read_only,
            apply_available: false,
            block_reason: Some(reason.to_string()),
            file_sha256: placeholder_sha,
            file_size_bytes: stat_size.unwrap_or(0),
            changes,
        });
    }
    let file_bytes = read_bounded(crate::core_runtime::library::handle_path(&source.source,&file_path)).map_err(|e| RemoteCurateError::Io(e.to_string()))?;
    drop(source);
    let file_sha256 = sha256_hex(&file_bytes);
    let approval_hash =
        compute_approval_hash(draft_id, draft_revision, &track_id, &file_sha256, &changes);

    let writer_error = crate::curation::tag_writer::writable(&file_bytes).err().or_else(|| changes.iter().find_map(|c| crate::curation::tag_writer::key(&c.field).err()));
    let writable_ok = writer_error.is_none();
    if let Some((sz, mtime_ns)) = file_stat {
        let writable_flag: i64 = if writable_ok { 1 } else { 0 };
        let conn = db.conn.lock();
        let _ = conn.execute(
            "UPDATE remote_curate_drafts
             SET dry_run_revision = ?2,
                 dry_run_file_sha256 = ?3,
                 dry_run_file_size = ?4,
                 dry_run_mtime_ns = ?5,
                 dry_run_writable_ok = ?6
             WHERE draft_id = ?1 AND revision = ?2",
            params![
                draft_id,
                draft_revision,
                &file_sha256,
                sz as i64,
                mtime_ns,
                writable_flag
            ],
        );
    }
    let block_reason = if read_only {
        Some("Apply is unavailable because the Core music root is mounted read-only; drafts remain saved for review.".to_string())
    } else {
        writer_error
    };

    Ok(CurateDryRunReport {
        draft_id: draft_id.to_string(),
        draft_revision,
        track_id,
        approval_hash,
        read_only,
        apply_available: block_reason.is_none(),
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

    let (
        track_id,
        draft_revision,
        changes_json,
        saved_expected_sha,
        dry_run_revision,
        dry_run_file_sha256,
        dry_run_file_size,
        dry_run_mtime_ns,
        dry_run_writable_ok,
    ): (
        String,
        i64,
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    ) = {
        let conn = db.conn.lock();
        conn.query_row(
            "SELECT track_id, revision, changes_json, approval_hash,
                    dry_run_revision, dry_run_file_sha256, dry_run_file_size,
                    dry_run_mtime_ns, dry_run_writable_ok
             FROM remote_curate_drafts WHERE draft_id = ?1",
            params![draft_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?
        .ok_or(RemoteCurateError::DraftNotFound)?
    };
    let _ = saved_expected_sha;

    let changes: Vec<CurateFieldChange> = serde_json::from_str(&changes_json)
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let file_path = resolve_track_file_path(db, &track_id)?;
    let source = authorized_target(db, &file_path)?;
    let live_stat = file_size_and_mtime_ns(&source.source);
    let cached_sha = if dry_run_revision == Some(draft_revision) && dry_run_writable_ok == Some(1) {
        match (
            live_stat,
            dry_run_file_size,
            dry_run_mtime_ns,
            dry_run_file_sha256.as_deref(),
        ) {
            (Some((sz, mt)), Some(exp_sz), Some(exp_mt), Some(sha))
                if sz >= APPROVE_STAT_CACHE_MIN_BYTES
                    && sz as i64 == exp_sz
                    && mt == exp_mt
                    && sha.len() == 64 =>
            {
                Some(sha.to_string())
            }
            _ => None,
        }
    } else {
        None
    };

    let live_sha = if let Some(sha) = cached_sha {
        drop(source);
        for change in &changes {
            crate::curation::tag_writer::key(&change.field)
                .map_err(RemoteCurateError::PayloadVerificationFailed)?;
        }
        sha
    } else {
        let live_bytes = read_bounded(crate::core_runtime::library::handle_path(
            &source.source,
            &file_path,
        ))
        .map_err(|e| RemoteCurateError::Io(e.to_string()))?;
        drop(source);
        crate::curation::tag_writer::writable(&live_bytes)
            .map_err(RemoteCurateError::PayloadVerificationFailed)?;
        for change in &changes {
            crate::curation::tag_writer::key(&change.field)
                .map_err(RemoteCurateError::PayloadVerificationFailed)?;
        }
        sha256_hex(&live_bytes)
    };
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
        error_message: None,
    })
}

pub fn list_active_jobs(db: &AppDb) -> Result<Vec<CurateApprovalReceipt>, RemoteCurateError> {
    ensure_schema(db)?;
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare(
            "SELECT job_id, draft_id, approval_hash, status, error_message
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
                error_message: row.get(4)?,
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
        "SELECT job_id, draft_id, approval_hash, status, error_message FROM remote_curate_jobs WHERE job_id = ?1",
        params![job_id],
        |row| {
            let status_str: String = row.get(3)?;
            Ok(CurateApprovalReceipt {
                job_id: row.get(0)?,
                draft_id: row.get(1)?,
                approval_hash: row.get(2)?,
                status: str_to_status(&status_str),
                error_message: row.get(4)?,
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

    let pending: Vec<(String, String, String, String, String, String, String)> = {
        let conn = db.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT job_id, draft_id, track_id, approval_hash, expected_file_sha256,
                        COALESCE(result_file_sha256, ''), changes_json
                 FROM remote_curate_jobs
                 WHERE status IN ('approved_waiting_idle', 'cooling_down', 'applying')
                 ORDER BY rowid ASC LIMIT 1",
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
                    row.get(6)?,
                ))
            })
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?
    };

    let mut receipts = Vec::with_capacity(pending.len());
    for (job_id, draft_id, track_id, approval_hash, expected_sha, result_sha, changes_json) in pending {
        let original_path = match resolve_track_file_path(db, &track_id) {
            Ok(p) => p,
            Err(e) => {
                let _ = mark_job_failed(db, &job_id, &format!("{e:?}"));
                return Err(e);
            }
        };
        let target = match authorized_target(db, &original_path) {
            Ok(t) => t,
            Err(error) => {
                mark_job_failed(db, &job_id, &format!("{error:?}"))?;
                continue;
            }
        };
        let file_path = target.path.clone();
        let disk_bytes = match read_bounded(crate::core_runtime::library::handle_path(
            &target.source,
            &original_path,
        )) {
            Ok(b) => b,
            Err(e) => {
                let msg = e.to_string();
                let _ = mark_job_failed(db, &job_id, &msg);
                return Err(RemoteCurateError::Io(msg));
            }
        };
        // Release Windows/SMB/NFS file & parent directory handles BEFORE atomic_replace()
        // so renaming over the target file does not hit Access is denied (os error 5).
        drop(target);

        let disk_sha = sha256_hex(&disk_bytes);
        let journal: Option<(Vec<u8>, Vec<u8>)> = db
            .conn
            .lock()
            .query_row(
                "SELECT original_bytes,result_bytes FROM remote_curate_journal WHERE job_id=?1",
                params![job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

        let already_swapped_on_disk = !result_sha.is_empty() && disk_sha == result_sha;
        let changes: Vec<CurateFieldChange> = match serde_json::from_str(&changes_json) {
            Ok(parsed) => parsed,
            Err(e) => {
                mark_job_failed(db, &job_id, &format!("Invalid changes_json: {e}"))?;
                continue;
            }
        };
        let mut rollback_bytes: Option<Vec<u8>> = None;

        if !already_swapped_on_disk {
            let original_bytes = journal
                .as_ref()
                .map(|(original, _)| original.clone())
                .unwrap_or_else(|| disk_bytes.clone());
            let disk_valid = disk_sha == expected_sha
                || journal
                    .as_ref()
                    .is_some_and(|(_, result)| sha256_hex(result) == disk_sha);
            if !disk_valid || sha256_hex(&original_bytes) != expected_sha {
                mark_job_failed(db, &job_id, "external_file_changed")?;
                return Err(RemoteCurateError::ExternalFileChanged);
            }

            // Prepare real tags in RAM and verify exact payload hashes, container
            // structure, codec properties and all changed fields before replacement.
            let updates = changes
                .iter()
                .map(|c| (c.field.clone(), c.after.clone()))
                .collect::<Vec<_>>();
            let next_bytes = match crate::curation::tag_writer::prepare(&original_bytes, &updates) {
                Ok(bytes) => bytes,
                Err(message) => {
                    mark_job_failed(db, &job_id, &message)?;
                    continue;
                }
            };
            let next_sha = sha256_hex(&next_bytes);
            {
                let conn = db.conn.lock();
                conn.execute(
                    "UPDATE remote_curate_jobs
                     SET status = 'applying', result_file_sha256 = ?2, updated_at = CURRENT_TIMESTAMP
                     WHERE job_id = ?1",
                    params![&job_id, &next_sha],
                )
                .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
            }
            if let Err(error) = atomic_replace(&file_path, &next_bytes) {
                let _ = atomic_replace(&file_path, &original_bytes);
                mark_job_failed(db, &job_id, &format!("{error:?}"))?;
                continue;
            }
            let post_bytes = match read_no_follow(&file_path) {
                Ok(b) => b,
                Err(e) => {
                    let _ = atomic_replace(&file_path, &original_bytes);
                    mark_job_failed(db, &job_id, &e.to_string())?;
                    continue;
                }
            };
            if sha256_hex(&post_bytes) != next_sha {
                let _ = atomic_replace(&file_path, &original_bytes);
                mark_job_failed(db, &job_id, "Post-write verification failed; original restored")?;
                continue;
            }
            rollback_bytes = Some(original_bytes);
        }

        let projection_result = (|| -> Result<(),RemoteCurateError> {
        let mut conn = db.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        for ch in &changes {
            let column = match ch.field.as_str() {
                "title"=>"title", "artist"|"artistCredit"=>"artist_credit", "album"|"albumTitle"=>"album_title",
                "albumArtist"=>"album_artist", "composer"|"composerName"=>"composer", "genre"=>"genre",
                "originalAlbum"=>"original_album", "originalYear"=>"original_year", "lyrics"=>"lyrics",
                _=>return Err(RemoteCurateError::PayloadVerificationFailed("Unsupported field".into())),
            };
            tx.execute(&format!("UPDATE tracks SET {column}=?2 WHERE id=?1"),params![track_id,ch.after]).map_err(|e|RemoteCurateError::Database(e.to_string()))?;
        }
        tx.execute(
            "UPDATE remote_curate_jobs SET status = 'verified', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?1",
            params![&job_id],
        )
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        tx.execute(
            "UPDATE remote_curate_drafts SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?1",
            params![&draft_id],
        )
        .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
        tx.execute("DELETE FROM remote_curate_journal WHERE job_id=?1",params![job_id]).map_err(|e|RemoteCurateError::Database(e.to_string()))?;
        tx.commit()
            .map_err(|e| RemoteCurateError::Database(e.to_string()))?;

        Ok(())
        })();
        if let Err(error)=projection_result {
            if let Some(original_bytes) = rollback_bytes {
                let _ = atomic_replace(&file_path, &original_bytes);
            }
            mark_job_failed(db,&job_id,&format!("Projection failed; original restored: {error:?}"))?;
            continue;
        }

        let committed_tuples: Vec<(String, String, String)> = changes
            .iter()
            .map(|ch| (track_id.clone(), ch.field.clone(), ch.after.clone()))
            .collect();
        if let Some(mut conn) = db.conn.try_lock() {
            let _ = crate::core_runtime::enrichment::schema::record_file_commit_for_tracks(
                &mut conn,
                &committed_tuples,
            );
        } else {
            let mut conn = db.conn.lock();
            let _ = crate::core_runtime::enrichment::schema::record_file_commit_for_tracks(
                &mut conn,
                &committed_tuples,
            );
        }

        receipts.push(CurateApprovalReceipt {
            job_id,
            draft_id,
            approval_hash,
            status: CurateJobStatus::Verified,
            error_message: None,
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

fn mark_job_failed(db: &AppDb, id: &str, message: &str) -> Result<(), RemoteCurateError> {
    let conn = db.conn.lock();
    conn.execute(
        "UPDATE remote_curate_jobs SET status='failed', error_message=?2, updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
        params![id, message],
    )
    .map_err(|e| RemoteCurateError::Database(e.to_string()))?;
    let _ = conn.execute("DELETE FROM remote_curate_journal WHERE job_id=?1", params![id]);
    Ok(())
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), RemoteCurateError> {
    use std::io::Write;
    let name = format!(".cadence-tmp-{}",uuid::Uuid::new_v4());
    let tmp = path.parent().ok_or_else(||RemoteCurateError::Io("Missing parent".into()))?.join(name);
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        if let Ok(meta) = open_no_follow(path).and_then(|f| f.metadata()) {
            let _ = file.set_permissions(meta.permissions());
        }
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            let backoffs = [50u64, 150, 300];
            let mut last_err = None;
            for attempt in 0..=backoffs.len() {
                match fs::rename(&tmp, path) {
                    Ok(()) => {
                        last_err = None;
                        break;
                    }
                    Err(e)
                        if attempt < backoffs.len()
                            && (e.kind() == std::io::ErrorKind::PermissionDenied
                                || e.raw_os_error() == Some(32)) =>
                    {
                        last_err = Some(e);
                        thread::sleep(Duration::from_millis(backoffs[attempt]));
                    }
                    Err(e) => return Err(e),
                }
            }
            if let Some(e) = last_err {
                return Err(e);
            }
        }
        #[cfg(not(windows))]
        {
            fs::rename(&tmp, path)?;
        }
        #[cfg(unix)]
        if let Ok(dir) = fs::File::open(path.parent().unwrap()) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {let _ = fs::remove_file(&tmp);}
    result.map_err(|e|RemoteCurateError::Io(e.to_string()))
}

struct AuthorizedTarget {
    source: fs::File,
    _parent: fs::File,
    path: PathBuf,
}

fn authorized_target(db:&AppDb,path:&Path)->Result<AuthorizedTarget,RemoteCurateError>{
    let roots={
        let conn=db.conn.lock();
        let configured:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_authorized_roots')",[],|r|r.get(0)).map_err(|e|RemoteCurateError::Database(e.to_string()))?;
        if configured {
            let mut stmt=conn.prepare("SELECT path FROM engine_authorized_roots").map_err(|e|RemoteCurateError::Database(e.to_string()))?;
            let rows=stmt.query_map([],|r|Ok(PathBuf::from(r.get::<_,String>(0)?))).map_err(|e|RemoteCurateError::Database(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|RemoteCurateError::Database(e.to_string()))?;
            rows
        }else{vec![path.parent().ok_or_else(||RemoteCurateError::Io("Missing parent".into()))?.to_path_buf()]}
    };
    let source=crate::core_runtime::library::open_authorized(&roots,path).map_err(RemoteCurateError::Io)?;
    if !source.metadata().map_err(|e|RemoteCurateError::Io(e.to_string()))?.is_file(){return Err(RemoteCurateError::Io("Not a regular file".into()));}
    let parent_path=path.parent().ok_or_else(||RemoteCurateError::Io("Missing parent".into()))?;
    let parent=crate::core_runtime::library::open_authorized(&roots,parent_path).map_err(RemoteCurateError::Io)?;
    let anchored=crate::core_runtime::library::handle_path(&parent,parent_path).join(path.file_name().unwrap());
    Ok(AuthorizedTarget{source,_parent:parent,path:anchored})
}

fn open_no_follow(path:&Path)->std::io::Result<fs::File>{
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK);}
    options.open(path)
}
fn read_no_follow(path:&Path)->std::io::Result<Vec<u8>>{
    use std::io::Read;
    let mut file=open_no_follow(path)?;
    let mut bytes=Vec::new();file.read_to_end(&mut bytes)?;Ok(bytes)
}

fn read_bounded(path:PathBuf)->std::io::Result<Vec<u8>>{
    use std::io::Read;
    let file=fs::File::open(path)?;
    if file.metadata()?.len()>MAX_COMMIT_FILE_BYTES{return Err(std::io::Error::other("Curate source exceeds the 256 MiB bounded commit limit"));}
    let mut bytes=Vec::new();file.take(MAX_COMMIT_FILE_BYTES+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>MAX_COMMIT_FILE_BYTES{return Err(std::io::Error::other("Curate source grew beyond the commit limit"));}Ok(bytes)
}

pub struct CurateJobWorker {
    stop: Arc<std::sync::atomic::AtomicBool>,
    gate: Arc<crate::core_runtime::enrichment::worker::EnrichmentIdleGate>,
    join: Option<JoinHandle<()>>,
}

impl CurateJobWorker {
    pub fn start(
        db_path: PathBuf,
        music_read_only: bool,
        gate: Arc<crate::core_runtime::enrichment::worker::EnrichmentIdleGate>,
    ) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_loop = Arc::clone(&stop);
        let gate_loop = Arc::clone(&gate);
        let join = thread::Builder::new()
            .name("cadence-curate-writer".into())
            .spawn(move || run_curate_worker_loop(db_path, music_read_only, stop_loop, gate_loop))
            .ok();
        Self { stop, gate, join }
    }

    pub fn shutdown(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.gate.wake_curate();
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for CurateJobWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn has_active_jobs(db: &AppDb) -> bool {
    let conn = db.conn.lock();
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM remote_curate_jobs WHERE status IN ('approved_waiting_idle', 'cooling_down', 'applying'))",
        [],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0)
        != 0
}

fn run_curate_worker_loop(
    db_path: PathBuf,
    music_read_only: bool,
    stop: Arc<std::sync::atomic::AtomicBool>,
    gate: Arc<crate::core_runtime::enrichment::worker::EnrichmentIdleGate>,
) {
    crate::core_runtime::enrichment::worker::configure_background_thread();
    let Ok(db) = AppDb::new(db_path) else {
        return;
    };
    let _ = ensure_schema(&db);

    while !stop.load(std::sync::atomic::Ordering::Acquire) && !gate.is_shutdown() {
        if music_read_only || !has_active_jobs(&db) {
            gate.wait_curate(Duration::from_secs(5));
            continue;
        }

        if !gate.is_transport_storage_idle() {
            if !gate.is_transport_active() && gate.cooldown_remaining_ms() > 0 {
                let _ = mark_pending_jobs_cooling_down(&db);
            }
            let wait_ms = if gate.is_transport_active() {
                1000
            } else {
                gate.cooldown_remaining_ms().clamp(250, 2000)
            };
            gate.wait_curate(Duration::from_millis(wait_ms));
            continue;
        }

        let prep_wait_ms = gate.curate_prep_settle_remaining_ms(1_500);
        if prep_wait_ms > 0 {
            gate.wait_curate(Duration::from_millis(prep_wait_ms.clamp(100, 500)));
            continue;
        }

        let mut verified_count = 0usize;
        let mut any_changed = false;
        while !stop.load(std::sync::atomic::Ordering::Acquire)
            && gate.is_transport_storage_idle()
            && gate.curate_prep_settle_remaining_ms(1_500) == 0
            && has_active_jobs(&db)
        {
            match execute_pending_jobs(&db, false) {
                Ok(receipts) => {
                    any_changed = true;
                    verified_count += receipts.len();
                }
                Err(RemoteCurateError::Database(_)) => {
                    any_changed = true;
                    gate.wait_curate(Duration::from_secs(2));
                    break;
                }
                Err(_) => {
                    any_changed = true;
                    break;
                }
            }
        }
        if verified_count > 0 {
            gate.mark_catalog_dirty();
        }
        if any_changed {
            gate.push_event(
                "curate.updated",
                serde_json::json!({ "verified": verified_count }),
            );
        }
    }
}
