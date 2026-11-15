//! Phase 9 Snapshot Import & Catalog Mapping:
//! - Live-WAL-consistent snapshot export via `VACUUM INTO` (source untouched)
//! - Root prefix mapping with strict component-level case-sensitive validation
//! - Retention of supported identities, playlists, and user-authored drafts
//! - Suppression of imported pending tag-write jobs (`cancelled` historical state)
//! - Pre-import rollback snapshot & atomic restore

use crate::db::AppDb;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootMapping {
    pub windows_prefix: String,
    pub core_prefix: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedTrackPreview {
    pub track_id: String,
    pub source_path: String,
    pub mapped_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotImportPreview {
    pub total_source_tracks: usize,
    pub mapped_tracks: Vec<MappedTrackPreview>,
    pub unmapped_roots: Vec<String>,
    pub case_mismatches: Vec<String>,
    pub missing_files: Vec<String>,
    pub ambiguous_paths: Vec<String>,
    pub suppressed_pending_jobs: usize,
    pub drafts_count: usize,
    pub playlists_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotImportOptions {
    pub mappings: Vec<RootMapping>,
    pub enforce_case_sensitive: bool,
    pub include_unmapped: bool,
    pub rollback_tag: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotImportResult {
    pub imported_tracks: usize,
    pub imported_playlists: usize,
    pub imported_drafts: usize,
    pub suppressed_pending_jobs: usize,
    pub rollback_snapshot_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationError {
    InvalidPath(String),
    Database(String),
    Io(String),
    RollbackMissing(String),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(m)
            | Self::Database(m)
            | Self::Io(m)
            | Self::RollbackMissing(m) => write!(f, "{}", m),
        }
    }
}

impl std::error::Error for MigrationError {}

/// Exports a single-file, transactionally consistent snapshot of a live WAL SQLite DB
/// via `VACUUM INTO` without mutating or checkpointing away source state.
pub fn export_consistent_snapshot(
    source_db_path: &Path,
    dest_snapshot_path: &Path,
) -> Result<(), MigrationError> {
    if !source_db_path.is_file() {
        return Err(MigrationError::InvalidPath(format!(
            "source database '{}' does not exist",
            source_db_path.display()
        )));
    }
    if let Some(parent) = dest_snapshot_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| MigrationError::Io(e.to_string()))?;
        }
    }
    if dest_snapshot_path.exists() {
        fs::remove_file(dest_snapshot_path).map_err(|e| MigrationError::Io(e.to_string()))?;
    }
    let _ = fs::remove_file(format!("{}-wal", dest_snapshot_path.display()));
    let _ = fs::remove_file(format!("{}-shm", dest_snapshot_path.display()));

    let conn = Connection::open(source_db_path).map_err(|e| MigrationError::Database(e.to_string()))?;
    let escaped = dest_snapshot_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}';", escaped))
        .map_err(|e| MigrationError::Database(e.to_string()))?;
    Ok(())
}

fn normalize_slashes(raw: &str) -> String {
    raw.replace('\\', "/").trim_end_matches('/').to_string()
}

/// Maps a Windows/UNC path using the longest matching `windows_prefix` (case-insensitive prefix
/// comparison for Windows roots, while preserving exact relative subpath casing for Linux).
pub fn map_path_with_roots(source_path: &str, mappings: &[RootMapping]) -> Option<(String, RootMapping)> {
    let norm_src = normalize_slashes(source_path);
    let src_lower = norm_src.to_ascii_lowercase();

    let mut best: Option<(usize, &RootMapping)> = None;
    for mapping in mappings {
        let prefix = normalize_slashes(&mapping.windows_prefix);
        if prefix.is_empty() {
            continue;
        }
        let prefix_lower = prefix.to_ascii_lowercase();
        let matched = src_lower == prefix_lower || src_lower.starts_with(&format!("{}/", prefix_lower));
        if matched && best.map_or(true, |(len, _)| prefix.len() > len) {
            best = Some((prefix.len(), mapping));
        }
    }

    let (prefix_len, mapping) = best?;
    let rel = norm_src[prefix_len..].trim_start_matches('/');
    let core_prefix = normalize_slashes(&mapping.core_prefix);
    let mapped = if rel.is_empty() {
        core_prefix
    } else if core_prefix.is_empty() {
        format!("/{}", rel)
    } else {
        format!("{}/{}", core_prefix, rel)
    };
    Some((mapped, mapping.clone()))
}

enum FsMatchResult {
    ExactMatch,
    CaseMismatch,
    Missing,
}

fn check_exact_case_filesystem(core_prefix: &str, full_mapped_path: &str) -> FsMatchResult {
    let root = Path::new(core_prefix);
    if !root.exists() {
        return FsMatchResult::Missing;
    }
    let norm_root = normalize_slashes(core_prefix);
    let norm_full = normalize_slashes(full_mapped_path);
    let rel = norm_full
        .strip_prefix(&norm_root)
        .unwrap_or(&norm_full)
        .trim_start_matches('/');
    if rel.is_empty() {
        return FsMatchResult::ExactMatch;
    }

    let mut cur = root.to_path_buf();
    for component in rel.split('/').filter(|c| !c.is_empty()) {
        let Ok(entries) = fs::read_dir(&cur) else {
            return FsMatchResult::Missing;
        };
        let mut exact = None;
        let mut ci_match = false;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == component {
                exact = Some(entry.path());
                break;
            }
            if name_str.eq_ignore_ascii_case(component) {
                ci_match = true;
            }
        }
        if let Some(next_path) = exact {
            cur = next_path;
        } else if ci_match {
            return FsMatchResult::CaseMismatch;
        } else {
            return FsMatchResult::Missing;
        }
    }
    FsMatchResult::ExactMatch
}

pub fn preview_snapshot_import(
    snapshot_path: &Path,
    mappings: &[RootMapping],
    verify_filesystem_case: bool,
) -> Result<SnapshotImportPreview, MigrationError> {
    if !snapshot_path.is_file() {
        return Err(MigrationError::InvalidPath(format!(
            "snapshot '{}' does not exist",
            snapshot_path.display()
        )));
    }
    let conn = Connection::open(snapshot_path).map_err(|e| MigrationError::Database(e.to_string()))?;

    let mut stmt = conn
        .prepare("SELECT id, file_path FROM tracks ORDER BY id ASC")
        .map_err(|e| MigrationError::Database(e.to_string()))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| MigrationError::Database(e.to_string()))?;

    let mut total_source_tracks = 0usize;
    let mut mapped_candidates: Vec<(String, String, String)> = Vec::new();
    let mut unmapped_roots = Vec::new();
    let mut case_mismatches = Vec::new();
    let mut missing_files = Vec::new();
    let mut mapped_path_counts: HashMap<String, usize> = HashMap::new();

    for row in rows {
        let (track_id, source_path) = row.map_err(|e| MigrationError::Database(e.to_string()))?;
        total_source_tracks += 1;

        let Some((mapped_path, mapping)) = map_path_with_roots(&source_path, mappings) else {
            unmapped_roots.push(source_path);
            continue;
        };

        if verify_filesystem_case {
            match check_exact_case_filesystem(&mapping.core_prefix, &mapped_path) {
                FsMatchResult::ExactMatch => {}
                FsMatchResult::CaseMismatch => {
                    case_mismatches.push(mapped_path);
                    continue;
                }
                FsMatchResult::Missing => {
                    missing_files.push(mapped_path);
                    continue;
                }
            }
        }

        *mapped_path_counts.entry(mapped_path.clone()).or_insert(0) += 1;
        mapped_candidates.push((track_id, source_path, mapped_path));
    }

    let mut ambiguous_paths = Vec::new();
    let mut seen_ambig = HashSet::new();
    let mut mapped_tracks = Vec::new();
    for (track_id, source_path, mapped_path) in mapped_candidates {
        if mapped_path_counts.get(&mapped_path).copied().unwrap_or(0) > 1 {
            if seen_ambig.insert(mapped_path.clone()) {
                ambiguous_paths.push(mapped_path);
            }
            continue;
        }
        mapped_tracks.push(MappedTrackPreview {
            track_id,
            source_path,
            mapped_path,
        });
    }

    let suppressed_pending_jobs: usize = conn
        .query_row(
            "SELECT count(*) FROM commit_queue_items WHERE status IN ('pending', 'in_flight')",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        .max(0) as usize;
    let drafts_count: usize = conn
        .query_row("SELECT count(*) FROM curation_drafts", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        .max(0) as usize;
    let playlists_count: usize = conn
        .query_row("SELECT count(*) FROM playlists", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        .max(0) as usize;

    Ok(SnapshotImportPreview {
        total_source_tracks,
        mapped_tracks,
        unmapped_roots,
        case_mismatches,
        missing_files,
        ambiguous_paths,
        suppressed_pending_jobs,
        drafts_count,
        playlists_count,
    })
}

pub fn import_snapshot_into_core(
    snapshot_path: &Path,
    core_db_path: &Path,
    rollback_dir: &Path,
    options: SnapshotImportOptions,
) -> Result<SnapshotImportResult, MigrationError> {
    let safe_tag = if options.rollback_tag.trim().is_empty() {
        "pre-import".to_string()
    } else {
        options.rollback_tag.trim().replace(['/', '\\', ' '], "_")
    };

    // Ensure Core DB exists and has the current schema, then create rollback snapshot first.
    let target_db = AppDb::new(core_db_path.to_path_buf()).map_err(MigrationError::Database)?;
    let rollback_snapshot_path = rollback_dir.join(format!("{}.db", safe_tag));
    export_consistent_snapshot(core_db_path, &rollback_snapshot_path)?;

    let preview =
        preview_snapshot_import(snapshot_path, &options.mappings, options.enforce_case_sensitive)?;
    let allowed_track_map: HashMap<String, String> = preview
        .mapped_tracks
        .iter()
        .map(|t| (t.track_id.clone(), t.mapped_path.clone()))
        .collect();

    let src_conn =
        Connection::open(snapshot_path).map_err(|e| MigrationError::Database(e.to_string()))?;

    let mut imported_tracks = 0usize;
    let mut imported_playlists = 0usize;
    let mut imported_drafts = 0usize;
    let mut suppressed_pending_jobs = 0usize;

    let mut dst_conn = target_db.conn.lock();
    let tx = dst_conn
        .transaction()
        .map_err(|e| MigrationError::Database(e.to_string()))?;

    // Clear target catalog tables for clean independent snapshot import (rollback DB holds prior state)
    tx.execute_batch(
        "DELETE FROM playlist_tracks;
         DELETE FROM playlists;
         DELETE FROM tracks;
         DELETE FROM releases;
         DELETE FROM storage_mounts;",
    )
    .map_err(|e| MigrationError::Database(e.to_string()))?;

    // Copy storage mounts (mapped where possible)
    {
        let mut stmt = src_conn
            .prepare("SELECT id, name, mount_path, mount_type, file_system, total_bytes, used_bytes, is_readonly_locked, status, health_score, smart_ok, temp_celsius, last_seen_timestamp FROM storage_mounts")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let name: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mount_path: String = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mapped_mount = map_path_with_roots(&mount_path, &options.mappings)
                .map(|(m, _)| m)
                .unwrap_or(mount_path);
            let mount_type: String = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            let file_system: String = r.get(4).map_err(|e| MigrationError::Database(e.to_string()))?;
            let total_bytes: i64 = r.get(5).map_err(|e| MigrationError::Database(e.to_string()))?;
            let used_bytes: i64 = r.get(6).map_err(|e| MigrationError::Database(e.to_string()))?;
            let is_ro: i64 = r.get(7).map_err(|e| MigrationError::Database(e.to_string()))?;
            let status: String = r.get(8).map_err(|e| MigrationError::Database(e.to_string()))?;
            let health_score: String = r.get(9).map_err(|e| MigrationError::Database(e.to_string()))?;
            let smart_ok: i64 = r.get(10).map_err(|e| MigrationError::Database(e.to_string()))?;
            let temp_c: f64 = r.get(11).map_err(|e| MigrationError::Database(e.to_string()))?;
            let last_seen: String = r.get(12).map_err(|e| MigrationError::Database(e.to_string()))?;

            tx.execute(
                "INSERT OR REPLACE INTO storage_mounts (id, name, mount_path, mount_type, file_system, total_bytes, used_bytes, is_readonly_locked, status, health_score, smart_ok, temp_celsius, last_seen_timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![id, name, mapped_mount, mount_type, file_system, total_bytes, used_bytes, is_ro, status, health_score, smart_ok, temp_c, last_seen],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        }
    }

    // Copy releases (mapped folder_path)
    {
        let mut stmt = src_conn
            .prepare("SELECT id, title, folder_path, folder_name, artist_credit, composer_name, release_year, genre_tags, is_compilation, is_favorite, created_at FROM releases")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let title: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let folder_path: String = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mapped_folder = map_path_with_roots(&folder_path, &options.mappings)
                .map(|(m, _)| m)
                .unwrap_or(folder_path);
            let folder_name: String = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            let artist_credit: String = r.get(4).map_err(|e| MigrationError::Database(e.to_string()))?;
            let composer_name: Option<String> = r.get(5).map_err(|e| MigrationError::Database(e.to_string()))?;
            let release_year: Option<i64> = r.get(6).map_err(|e| MigrationError::Database(e.to_string()))?;
            let genre_tags: Option<String> = r.get(7).map_err(|e| MigrationError::Database(e.to_string()))?;
            let is_comp: i64 = r.get(8).map_err(|e| MigrationError::Database(e.to_string()))?;
            let is_fav: i64 = r.get(9).map_err(|e| MigrationError::Database(e.to_string()))?;
            let created_at: String = r.get(10).map_err(|e| MigrationError::Database(e.to_string()))?;

            tx.execute(
                "INSERT OR REPLACE INTO releases (id, title, folder_path, folder_name, artist_credit, composer_name, release_year, genre_tags, is_compilation, is_favorite, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![id, title, mapped_folder, folder_name, artist_credit, composer_name, release_year, genre_tags, is_comp, is_fav, created_at],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        }
    }

    // Copy mapped tracks, resetting `sidecar_status` to `in_sync` so imported pending edits never replay
    let mut imported_track_ids = HashSet::new();
    {
        let mut stmt = src_conn
            .prepare("SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, release_year, track_number, genre, composer, duration_secs, format, sample_rate, bit_depth, channels, dr_score, has_embedded_art, is_online, created_at FROM tracks")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let orig_path: String = r.get(5).map_err(|e| MigrationError::Database(e.to_string()))?;
            let Some(mapped_file_path) = allowed_track_map.get(&id).cloned().or_else(|| {
                if options.include_unmapped {
                    Some(orig_path.clone())
                } else {
                    None
                }
            }) else {
                continue;
            };
            let release_id: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mount_id: String = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let folder_path: String = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mapped_folder = map_path_with_roots(&folder_path, &options.mappings)
                .map(|(m, _)| m)
                .unwrap_or(folder_path);
            let folder_name: String = r.get(4).map_err(|e| MigrationError::Database(e.to_string()))?;
            let file_name: String = r.get(6).map_err(|e| MigrationError::Database(e.to_string()))?;
            let file_size: i64 = r.get(7).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mtime: i64 = r.get(8).map_err(|e| MigrationError::Database(e.to_string()))?;
            let title: String = r.get(9).map_err(|e| MigrationError::Database(e.to_string()))?;
            let artist_credit: String = r.get(10).map_err(|e| MigrationError::Database(e.to_string()))?;
            let album_title: String = r.get(11).map_err(|e| MigrationError::Database(e.to_string()))?;
            let release_year: Option<i64> = r.get(12).map_err(|e| MigrationError::Database(e.to_string()))?;
            let track_number: Option<i64> = r.get(13).map_err(|e| MigrationError::Database(e.to_string()))?;
            let genre: Option<String> = r.get(14).map_err(|e| MigrationError::Database(e.to_string()))?;
            let composer: Option<String> = r.get(15).map_err(|e| MigrationError::Database(e.to_string()))?;
            let duration_secs: f64 = r.get(16).map_err(|e| MigrationError::Database(e.to_string()))?;
            let format: String = r.get(17).map_err(|e| MigrationError::Database(e.to_string()))?;
            let sample_rate: Option<i64> = r.get(18).map_err(|e| MigrationError::Database(e.to_string()))?;
            let bit_depth: Option<i64> = r.get(19).map_err(|e| MigrationError::Database(e.to_string()))?;
            let channels: Option<i64> = r.get(20).map_err(|e| MigrationError::Database(e.to_string()))?;
            let dr_score: Option<i64> = r.get(21).map_err(|e| MigrationError::Database(e.to_string()))?;
            let has_art: i64 = r.get(22).map_err(|e| MigrationError::Database(e.to_string()))?;
            let is_online: i64 = r.get(23).map_err(|e| MigrationError::Database(e.to_string()))?;
            let created_at: String = r.get(24).map_err(|e| MigrationError::Database(e.to_string()))?;

            tx.execute(
                "INSERT OR REPLACE INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, release_year, track_number, genre, composer, duration_secs, format, sample_rate, bit_depth, channels, dr_score, has_embedded_art, sidecar_status, is_online, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, 'in_sync', ?24, ?25)",
                params![id, release_id, mount_id, mapped_folder, folder_name, mapped_file_path, file_name, file_size, mtime, title, artist_credit, album_title, release_year, track_number, genre, composer, duration_secs, format, sample_rate, bit_depth, channels, dr_score, has_art, is_online, created_at],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;

            imported_track_ids.insert(id);
            imported_tracks += 1;
        }
    }

    // Preserve playlists and tracks present in Core catalog
    {
        let mut stmt = src_conn
            .prepare("SELECT id, title, description, cover_art_url, created_at, updated_at, tags, listening_notes FROM playlists")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let title: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let desc: Option<String> = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let cover: Option<String> = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            let created_at: String = r.get(4).map_err(|e| MigrationError::Database(e.to_string()))?;
            let updated_at: String = r.get(5).map_err(|e| MigrationError::Database(e.to_string()))?;
            let tags: Option<String> = r.get(6).map_err(|e| MigrationError::Database(e.to_string()))?;
            let notes: Option<String> = r.get(7).map_err(|e| MigrationError::Database(e.to_string()))?;
            tx.execute(
                "INSERT OR REPLACE INTO playlists (id, title, description, cover_art_url, created_at, updated_at, tags, listening_notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, title, desc, cover, created_at, updated_at, tags, notes],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
            imported_playlists += 1;
        }
    }
    {
        let mut stmt = src_conn
            .prepare("SELECT playlist_id, track_id, position, added_at FROM playlist_tracks ORDER BY playlist_id ASC, position ASC")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let playlist_id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let track_id: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            if !imported_track_ids.contains(&track_id) {
                continue;
            }
            let pos: i64 = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let added_at: String = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![playlist_id, track_id, pos, added_at],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        }
    }

    // Preserve supported Curate identities & user-authored drafts
    {
        let mut stmt = src_conn
            .prepare("SELECT id, anchor, status, revision FROM curate_identity_editions")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let anchor: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let status: String = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let rev: i64 = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            tx.execute(
                "INSERT OR REPLACE INTO curate_identity_editions (id, anchor, status, revision) VALUES (?1, ?2, ?3, ?4)",
                params![id, anchor, status, rev],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        }
    }
    {
        let mut stmt = src_conn
            .prepare("SELECT album_id, draft_json, updated_at FROM curation_drafts")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let album_id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let draft_json: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let updated_at: String = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            tx.execute(
                "INSERT OR REPLACE INTO curation_drafts (album_id, draft_json, updated_at) VALUES (?1, ?2, ?3)",
                params![album_id, draft_json, updated_at],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
            imported_drafts += 1;
        }
    }

    // Retain historical commit batches/items safely as cancelled/archived without activating or replaying
    {
        let mut stmt = src_conn
            .prepare("SELECT id, description, total_tracks, destination, force_override, status, created_at, completed_at FROM commit_queue_batches")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let desc: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let total: i64 = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let dest: String = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            let force: i64 = r.get(4).map_err(|e| MigrationError::Database(e.to_string()))?;
            let orig_status: String = r.get(5).map_err(|e| MigrationError::Database(e.to_string()))?;
            let created_at: String = r.get(6).map_err(|e| MigrationError::Database(e.to_string()))?;
            let completed_at: Option<String> = r.get(7).map_err(|e| MigrationError::Database(e.to_string()))?;
            let next_status = if orig_status == "pending" || orig_status == "processing" || orig_status == "paused_playback" || orig_status == "paused_mount_offline" {
                "cancelled"
            } else {
                orig_status.as_str()
            };
            tx.execute(
                "INSERT OR REPLACE INTO commit_queue_batches (id, description, total_tracks, destination, force_override, status, created_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, desc, total, dest, force, next_status, created_at, completed_at],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        }
    }
    {
        let mut stmt = src_conn
            .prepare("SELECT id, batch_id, track_id, file_path, mount_id, payload_json, backup_json, expected_crc, status, retry_count, error_message FROM commit_queue_items")
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        while let Some(r) = rows.next().map_err(|e| MigrationError::Database(e.to_string()))? {
            let id: String = r.get(0).map_err(|e| MigrationError::Database(e.to_string()))?;
            let batch_id: String = r.get(1).map_err(|e| MigrationError::Database(e.to_string()))?;
            let track_id: String = r.get(2).map_err(|e| MigrationError::Database(e.to_string()))?;
            let file_path: String = r.get(3).map_err(|e| MigrationError::Database(e.to_string()))?;
            let mount_id: String = r.get(4).map_err(|e| MigrationError::Database(e.to_string()))?;
            let payload_json: String = r.get(5).map_err(|e| MigrationError::Database(e.to_string()))?;
            let backup_json: String = r.get(6).map_err(|e| MigrationError::Database(e.to_string()))?;
            let expected_crc: Option<String> = r.get(7).map_err(|e| MigrationError::Database(e.to_string()))?;
            let orig_status: String = r.get(8).map_err(|e| MigrationError::Database(e.to_string()))?;
            let retry_count: i64 = r.get(9).map_err(|e| MigrationError::Database(e.to_string()))?;
            let error_message: Option<String> = r.get(10).map_err(|e| MigrationError::Database(e.to_string()))?;

            let was_active = orig_status == "pending" || orig_status == "in_flight";
            let next_status = if was_active {
                suppressed_pending_jobs += 1;
                "cancelled"
            } else {
                orig_status.as_str()
            };
            let next_err = if was_active {
                Some("imported_suppressed_no_replay".to_string())
            } else {
                error_message
            };
            tx.execute(
                "INSERT OR REPLACE INTO commit_queue_items (id, batch_id, track_id, file_path, mount_id, payload_json, backup_json, expected_crc, status, retry_count, error_message)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![id, batch_id, track_id, file_path, mount_id, payload_json, backup_json, expected_crc, next_status, retry_count, next_err],
            )
            .map_err(|e| MigrationError::Database(e.to_string()))?;
        }
    }

    tx.commit().map_err(|e| MigrationError::Database(e.to_string()))?;

    Ok(SnapshotImportResult {
        imported_tracks,
        imported_playlists,
        imported_drafts,
        suppressed_pending_jobs,
        rollback_snapshot_path,
    })
}

pub fn rollback_snapshot_import(
    core_db_path: &Path,
    rollback_snapshot_path: &Path,
) -> Result<(), MigrationError> {
    if !rollback_snapshot_path.is_file() {
        return Err(MigrationError::RollbackMissing(format!(
            "rollback snapshot '{}' not found",
            rollback_snapshot_path.display()
        )));
    }
    let _ = fs::remove_file(format!("{}-wal", core_db_path.display()));
    let _ = fs::remove_file(format!("{}-shm", core_db_path.display()));
    fs::copy(rollback_snapshot_path, core_db_path).map_err(|e| MigrationError::Io(e.to_string()))?;
    Ok(())
}
