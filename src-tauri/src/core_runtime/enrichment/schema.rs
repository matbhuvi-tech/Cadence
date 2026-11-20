use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRecord {
    pub entity_type: String,
    pub entity_id: String,
    pub field_name: String,
    pub value_text: Option<String>,
    pub origin: String,
    pub provider: Option<String>,
    pub confidence: Option<f64>,
    pub distance: Option<f64>,
    pub locked: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserActionRecord {
    pub id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub field_name: String,
    pub action: String,
    pub previous_value: Option<String>,
    pub new_value: Option<String>,
    pub actor: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootEnrichmentProgress {
    pub folder_id: String,
    pub display_name: String,
    pub path: String,
    pub total_albums: usize,
    pub covered_albums: usize,
    pub coverage_percent: u8,
    pub auto_applied_albums: usize,
    pub needs_review_albums: usize,
    pub no_match_albums: usize,
    pub user_locked_albums: usize,
    pub pending_albums: usize,
    pub failed_albums: usize,
    pub artwork_covered_albums: usize,
    pub artwork_coverage_percent: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGateSnapshot {
    pub provider: String,
    pub circuit: String,
    pub consecutive_failures: u32,
    pub retry_after_secs: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentStatusResponse {
    pub state: String, // "active" | "cooldown" | "paused_playback" | "user_paused" | "disabled" | "complete"
    pub enabled: bool,
    pub user_paused: bool,
    pub cooldown_remaining_secs: Option<u64>,
    pub current_release_id: Option<String>,
    pub current_album_title: Option<String>,
    pub total_albums: usize,
    pub covered_albums: usize,
    pub coverage_percent: u8,
    pub auto_applied_albums: usize,
    pub needs_review_albums: usize,
    pub no_match_albums: usize,
    pub user_locked_albums: usize,
    pub pending_albums: usize,
    pub failed_albums: usize,
    pub artwork_covered_albums: usize,
    pub artwork_coverage_percent: u8,
    pub artwork_pending_items: usize,
    pub provider_gates: Vec<ProviderGateSnapshot>,
    pub roots: Vec<RootEnrichmentProgress>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentAlbumSummary {
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub status: String,
    pub provider: Option<String>,
    pub external_release_id: Option<String>,
    pub distance: Option<f64>,
    pub runner_up_distance: Option<f64>,
    pub vetoes: Vec<serde_json::Value>,
    pub has_user_overlay: bool,
    pub has_auto_overlay: bool,
    pub artwork_status: Option<String>,
    pub artwork_source: Option<String>,
    pub artwork_width: Option<u32>,
    pub artwork_height: Option<u32>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTrackSummary {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub duration_secs: f64,
    pub release_year: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentAlbumDetail {
    pub release_id: String,
    pub raw_title: String,
    pub raw_artist: String,
    pub raw_album_artist: Option<String>,
    pub raw_year: Option<i64>,
    pub raw_composer: Option<String>,
    pub raw_genre: Option<String>,
    pub status: String,
    pub provider: Option<String>,
    pub external_release_id: Option<String>,
    pub distance: Option<f64>,
    pub runner_up_distance: Option<f64>,
    pub vetoes: Vec<serde_json::Value>,
    pub proposal: Option<serde_json::Value>,
    pub overlays: Vec<OverlayRecord>,
    pub tracks: Vec<RawTrackSummary>,
    pub artwork_status: Option<String>,
    pub artwork_source: Option<String>,
    pub artwork_width: Option<u32>,
    pub artwork_height: Option<u32>,
    pub artwork_trace: Vec<serde_json::Value>,
    pub pending_artwork_url: Option<String>,
    pub pending_artwork_attempts: Option<u32>,
    pub pending_artwork_error: Option<String>,
    pub user_actions: Vec<UserActionRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTrackOverlayEdit {
    pub track_id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub year: Option<String>,
}

pub fn strip_core_release_prefix(release_id: &str) -> &str {
    release_id.strip_prefix("core_rel_").unwrap_or(release_id)
}

pub fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS metadata_overlays (
            entity_type TEXT NOT NULL CHECK(entity_type IN ('release', 'track')),
            entity_id TEXT NOT NULL,
            field_name TEXT NOT NULL,
            value_text TEXT,
            origin TEXT NOT NULL CHECK(origin IN ('user', 'auto')),
            provider TEXT,
            confidence REAL,
            distance REAL,
            locked INTEGER NOT NULL DEFAULT 0,
            source_signature TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, entity_id, field_name)
        );
        CREATE INDEX IF NOT EXISTS idx_metadata_overlays_entity
            ON metadata_overlays(entity_type, entity_id);

        CREATE TABLE IF NOT EXISTS metadata_user_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL CHECK(entity_type IN ('release', 'track')),
            entity_id TEXT NOT NULL,
            field_name TEXT NOT NULL,
            action TEXT NOT NULL,
            previous_value TEXT,
            new_value TEXT,
            actor TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_metadata_user_actions_entity
            ON metadata_user_actions(entity_type, entity_id, created_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS enrichment_album_state (
            release_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('pending', 'auto_applied', 'needs_review', 'no_match', 'user_locked', 'failed')),
            provider TEXT,
            external_release_id TEXT,
            distance REAL,
            runner_up_distance REAL,
            vetoes_json TEXT NOT NULL DEFAULT '[]',
            proposal_json TEXT,
            raw_signature TEXT NOT NULL DEFAULT '',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_retry_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_enrichment_album_status
            ON enrichment_album_state(status, next_retry_at);

        CREATE TABLE IF NOT EXISTS enrichment_config (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            enabled INTEGER NOT NULL DEFAULT 1,
            user_paused INTEGER NOT NULL DEFAULT 0,
            min_local_artwork_px INTEGER NOT NULL DEFAULT 500,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO enrichment_config(id) VALUES(1);

        CREATE TABLE IF NOT EXISTS artwork_queue (
            entity_kind TEXT NOT NULL CHECK(entity_kind IN ('album', 'artist')),
            entity_id TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 10,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at INTEGER NOT NULL DEFAULT 0,
            enqueued_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            override_url TEXT,
            PRIMARY KEY (entity_kind, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_artwork_queue_drain
            ON artwork_queue(entity_kind, next_retry_at, priority, enqueued_at);

        CREATE TABLE IF NOT EXISTS artwork_items (
            entity_kind TEXT NOT NULL CHECK(entity_kind IN ('album', 'artist')),
            entity_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('found', 'found_stale', 'absent', 'user_override')),
            image_hash TEXT,
            mime TEXT,
            width INTEGER,
            height INTEGER,
            size_bytes INTEGER,
            source TEXT,
            source_path TEXT,
            ref_mtime INTEGER NOT NULL DEFAULT 0,
            trace_json TEXT NOT NULL DEFAULT '[]',
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (entity_kind, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_artwork_items_status
            ON artwork_items(entity_kind, status);

        CREATE TABLE IF NOT EXISTS engine_artwork (
            release_id TEXT PRIMARY KEY,
            etag TEXT NOT NULL,
            jpeg BLOB NOT NULL
        );
        ",
    )?;
    let has_override_url: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('artwork_queue') WHERE name = 'override_url')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !has_override_url {
        conn.execute("ALTER TABLE artwork_queue ADD COLUMN override_url TEXT", [])?;
    }
    Ok(())
}

pub fn epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn normalize_path_for_prefix(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        s = format!("//{rest}");
    } else if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    #[cfg(windows)]
    {
        s = s.to_ascii_lowercase();
    }
    s
}

pub fn path_under_root(track_folder: &str, root_folder: &str) -> bool {
    let tf = normalize_path_for_prefix(track_folder);
    let rf = normalize_path_for_prefix(root_folder);
    if tf.is_empty() || rf.is_empty() {
        return false;
    }
    if tf == rf {
        return true;
    }
    if rf == "/" {
        return tf.starts_with('/');
    }
    tf.starts_with(&format!("{rf}/"))
}

pub fn get_enrichment_config(conn: &Connection) -> Result<(bool, bool, u32)> {
    conn.query_row(
        "SELECT enabled, user_paused, min_local_artwork_px FROM enrichment_config WHERE id = 1",
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)? != 0,
                r.get::<_, i64>(1)? != 0,
                r.get::<_, i64>(2)?.max(64) as u32,
            ))
        },
    )
    .optional()
    .map(|opt| opt.unwrap_or((true, false, 500)))
}

pub fn set_enrichment_config(
    conn: &Connection,
    enabled: Option<bool>,
    user_paused: Option<bool>,
) -> Result<()> {
    let (cur_enabled, cur_paused, _) = get_enrichment_config(conn)?;
    let next_enabled = enabled.unwrap_or(cur_enabled);
    let next_paused = user_paused.unwrap_or(cur_paused);
    conn.execute(
        "UPDATE enrichment_config
         SET enabled = ?1, user_paused = ?2, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1",
        params![i64::from(next_enabled), i64::from(next_paused)],
    )?;
    Ok(())
}

pub fn record_user_action(
    tx: &Transaction,
    entity_type: &str,
    entity_id: &str,
    field_name: &str,
    action: &str,
    previous_value: Option<&str>,
    new_value: Option<&str>,
    actor: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO metadata_user_actions
            (entity_type, entity_id, field_name, action, previous_value, new_value, actor)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entity_type,
            entity_id,
            field_name,
            action,
            previous_value,
            new_value,
            actor
        ],
    )?;
    Ok(())
}

pub fn is_entity_or_field_user_locked(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    field_name: &str,
) -> Result<bool> {
    let overlay_locked: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM metadata_overlays
            WHERE entity_type = ?1 AND entity_id = ?2
              AND (field_name = ?3 OR field_name = '*')
              AND (origin = 'user' OR locked = 1)
        )",
        params![entity_type, entity_id, field_name],
        |r| r.get(0),
    )?;
    if overlay_locked {
        return Ok(true);
    }

    let latest_action: Option<String> = conn
        .query_row(
            "SELECT action FROM metadata_user_actions
             WHERE entity_type = ?1 AND entity_id = ?2
               AND (field_name = ?3 OR field_name = '*')
             ORDER BY id DESC LIMIT 1",
            params![entity_type, entity_id, field_name],
            |r| r.get(0),
        )
        .optional()?;
    Ok(matches!(
        latest_action.as_deref(),
        Some("manual_edit" | "revert_to_file" | "lock_file_tags" | "reject_auto" | "commit_to_file")
    ))
}

pub fn mark_curate_queue_projection_stale(tx: &Transaction, release_id: &str) -> Result<()> {
    let has_tables: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='curate_queue_projection')
            AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='curate_identity_tracks')
            AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='curate_identity_discs')",
        [],
        |r| r.get(0),
    )?;
    if !has_tables {
        return Ok(());
    }
    tx.execute(
        "UPDATE curate_queue_projection
         SET stale = 1
         WHERE edition_id IN (
            SELECT DISTINCT d.edition_id
            FROM curate_identity_tracks cit
            JOIN curate_identity_discs d ON d.id = cit.disc_id
            JOIN tracks t ON t.id = cit.local_track_id
            WHERE t.release_id = ?1
         )",
        params![release_id],
    )?;
    Ok(())
}

pub fn compute_release_raw_signature(conn: &Connection, release_id: &str) -> Result<Option<String>> {
    let rel: Option<(String, String, Option<i64>)> = conn
        .query_row(
            "SELECT title, artist_credit, release_year FROM releases WHERE id = ?1",
            params![release_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((rel_title, rel_artist, rel_year)) = rel else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT id, title, artist_credit, COALESCE(album_artist, ''), COALESCE(track_number, 0),
                COALESCE(disc_number, 1), ROUND(duration_secs, 1), COALESCE(release_year, 0)
         FROM tracks
         WHERE release_id = ?1 AND is_online != 0
         ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![release_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, f64>(6)?,
            r.get::<_, i64>(7)?,
        ))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(rel_title.as_bytes());
    hasher.update(b"\0");
    hasher.update(rel_artist.as_bytes());
    hasher.update(b"\0");
    hasher.update(rel_year.unwrap_or(0).to_le_bytes());
    let mut track_count = 0usize;
    for row in rows {
        let (id, title, artist, album_artist, trk, disc, dur, year) = row?;
        track_count += 1;
        hasher.update(id.as_bytes());
        hasher.update(b"\0");
        hasher.update(title.as_bytes());
        hasher.update(b"\0");
        hasher.update(artist.as_bytes());
        hasher.update(b"\0");
        hasher.update(album_artist.as_bytes());
        hasher.update(trk.to_le_bytes());
        hasher.update(disc.to_le_bytes());
        hasher.update(dur.to_le_bytes());
        hasher.update(year.to_le_bytes());
    }
    if track_count == 0 {
        return Ok(None);
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

pub fn seed_pending_albums_and_artwork(conn: &Connection) -> Result<(usize, usize)> {
    let release_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT t.release_id
             FROM tracks t
             WHERE t.is_online != 0 AND t.release_id IS NOT NULL AND TRIM(t.release_id) != ''
             ORDER BY t.release_id",
        )?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    let now = epoch_secs();
    let mut seeded_albums = 0usize;
    let mut seeded_artwork = 0usize;

    for release_id in release_ids {
        let Some(sig) = compute_release_raw_signature(conn, &release_id)? else {
            continue;
        };
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT status, raw_signature FROM enrichment_album_state WHERE release_id = ?1",
                params![release_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let locked = is_entity_or_field_user_locked(conn, "release", &release_id, "*")?;
        match existing {
            None => {
                let status = if locked { "user_locked" } else { "pending" };
                conn.execute(
                    "INSERT INTO enrichment_album_state(release_id, status, raw_signature, next_retry_at)
                     VALUES (?1, ?2, ?3, 0)",
                    params![release_id, status, sig],
                )?;
                seeded_albums += 1;
            }
            Some((cur_status, cur_sig)) => {
                if cur_sig != sig && cur_status != "user_locked" && !locked {
                    conn.execute(
                        "UPDATE enrichment_album_state
                         SET status = 'pending', raw_signature = ?2, attempt_count = 0,
                             next_retry_at = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP
                         WHERE release_id = ?1",
                        params![release_id, sig],
                    )?;
                    seeded_albums += 1;
                }
            }
        }

        let needs_art: bool = conn.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM artwork_items WHERE entity_kind='album' AND entity_id=?1 AND status IN ('found', 'absent', 'user_override'))
                AND NOT EXISTS(SELECT 1 FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1)",
            params![release_id],
            |r| r.get(0),
        )?;
        if needs_art {
            let has_local_cached: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_artwork WHERE release_id=?1)",
                params![release_id],
                |r| r.get(0),
            )?;
            let priority = if has_local_cached { 30 } else { 10 };
            conn.execute(
                "INSERT OR IGNORE INTO artwork_queue(entity_kind, entity_id, priority, enqueued_at, next_retry_at)
                 VALUES('album', ?1, ?2, ?3, 0)",
                params![release_id, priority, now],
            )?;
            seeded_artwork += 1;
        }
    }

    // Seed artist artwork queue for canonical artists without resolved artwork yet
    let artist_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM canonical_artists
             WHERE COALESCE(TRIM(name), '') != ''
               AND LOWER(TRIM(name)) NOT IN ('unknown', 'unknown artist', 'various', 'various artists', 'va')
               AND (portrait_status IS NULL OR portrait_status = 'pending')",
        )?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for artist_id in artist_ids {
        let needs: bool = conn.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM artwork_items WHERE entity_kind='artist' AND entity_id=?1 AND status IN ('found', 'absent', 'user_override'))
                AND NOT EXISTS(SELECT 1 FROM artwork_queue WHERE entity_kind='artist' AND entity_id=?1)",
            params![artist_id],
            |r| r.get(0),
        )?;
        if needs {
            conn.execute(
                "INSERT OR IGNORE INTO artwork_queue(entity_kind, entity_id, priority, enqueued_at, next_retry_at)
                 VALUES('artist', ?1, 50, ?2, 0)",
                params![artist_id, now],
            )?;
            seeded_artwork += 1;
        }
    }

    Ok((seeded_albums, seeded_artwork))
}

#[derive(Default)]
struct BucketCounts {
    releases: HashSet<String>,
    auto_applied: usize,
    needs_review: usize,
    no_match: usize,
    user_locked: usize,
    pending: usize,
    failed: usize,
    artwork_covered: usize,
}

fn pct(part: usize, total: usize) -> u8 {
    if total == 0 {
        return 100;
    }
    ((part * 100) / total).min(100) as u8
}

pub fn compute_enrichment_status(
    conn: &Connection,
    runtime_state: &str,
    cooldown_remaining_secs: Option<u64>,
    current_release_id: Option<String>,
    current_album_title: Option<String>,
    provider_gates: Vec<ProviderGateSnapshot>,
) -> Result<EnrichmentStatusResponse> {
    let (enabled, user_paused, _) = get_enrichment_config(conn)?;

    let mut roots_meta: Vec<(String, String, String, String)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, mount_id, folder_path, display_name FROM watched_folders ORDER BY folder_path ASC",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })? {
            roots_meta.push(row?);
        }
    }

    let mut mount_counts: HashMap<String, usize> = HashMap::new();
    for (_, mount_id, _, _) in &roots_meta {
        *mount_counts.entry(mount_id.clone()).or_insert(0) += 1;
    }

    // Map each release to enrichment status & artwork covered flag
    let mut release_status: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT release_id, status FROM enrichment_album_state")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (rid, st) = row?;
            release_status.insert(rid, st);
        }
    }

    let mut artwork_covered: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT entity_id FROM artwork_items
             WHERE entity_kind = 'album' AND status IN ('found', 'found_stale', 'user_override')
             UNION
             SELECT release_id FROM engine_artwork",
        )?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            artwork_covered.insert(row?);
        }
    }

    let mut root_buckets: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut global_releases: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT release_id, mount_id, folder_path
             FROM tracks
             WHERE is_online != 0 AND release_id IS NOT NULL AND TRIM(release_id) != ''",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (release_id, mount_id, folder_path) = row?;
            global_releases.insert(release_id.clone());

            let mut matched_any_prefix = false;
            for (folder_id, _, root_path, _) in &roots_meta {
                if path_under_root(&folder_path, root_path) {
                    root_buckets
                        .entry(folder_id.clone())
                        .or_default()
                        .insert(release_id.clone());
                    matched_any_prefix = true;
                }
            }
            if !matched_any_prefix {
                for (folder_id, root_mount_id, _, _) in &roots_meta {
                    if root_mount_id == &mount_id && mount_counts.get(root_mount_id) == Some(&1) {
                        root_buckets
                            .entry(folder_id.clone())
                            .or_default()
                            .insert(release_id.clone());
                    }
                }
            }
        }
    }

    let tally = |releases: &HashSet<String>| -> BucketCounts {
        let mut c = BucketCounts::default();
        c.releases = releases.clone();
        for rid in releases {
            match release_status.get(rid).map(String::as_str) {
                Some("auto_applied") => c.auto_applied += 1,
                Some("needs_review") => c.needs_review += 1,
                Some("no_match") => c.no_match += 1,
                Some("user_locked") => c.user_locked += 1,
                Some("failed") => c.failed += 1,
                _ => c.pending += 1,
            }
            if artwork_covered.contains(rid) {
                c.artwork_covered += 1;
            }
        }
        c
    };

    let global = tally(&global_releases);
    let global_total = global.releases.len();
    let global_covered =
        global.auto_applied + global.needs_review + global.no_match + global.user_locked;

    let mut roots = Vec::with_capacity(roots_meta.len());
    for (folder_id, _, path, display_name) in roots_meta {
        let set = root_buckets.get(&folder_id).cloned().unwrap_or_default();
        let b = tally(&set);
        let total = b.releases.len();
        let covered = b.auto_applied + b.needs_review + b.no_match + b.user_locked;
        roots.push(RootEnrichmentProgress {
            folder_id,
            display_name,
            path,
            total_albums: total,
            covered_albums: covered,
            coverage_percent: pct(covered, total),
            auto_applied_albums: b.auto_applied,
            needs_review_albums: b.needs_review,
            no_match_albums: b.no_match,
            user_locked_albums: b.user_locked,
            pending_albums: b.pending,
            failed_albums: b.failed,
            artwork_covered_albums: b.artwork_covered,
            artwork_coverage_percent: pct(b.artwork_covered, total),
        });
    }

    let artwork_pending_items: usize = conn
        .query_row("SELECT COUNT(*) FROM artwork_queue", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        .max(0) as usize;

    let effective_state = if !enabled {
        "disabled".to_string()
    } else if user_paused {
        "user_paused".to_string()
    } else if global.pending == 0 && artwork_pending_items == 0 {
        "complete".to_string()
    } else {
        runtime_state.to_string()
    };

    Ok(EnrichmentStatusResponse {
        state: effective_state,
        enabled,
        user_paused,
        cooldown_remaining_secs,
        current_release_id,
        current_album_title,
        total_albums: global_total,
        covered_albums: global_covered,
        coverage_percent: pct(global_covered, global_total),
        auto_applied_albums: global.auto_applied,
        needs_review_albums: global.needs_review,
        no_match_albums: global.no_match,
        user_locked_albums: global.user_locked,
        pending_albums: global.pending,
        failed_albums: global.failed,
        artwork_covered_albums: global.artwork_covered,
        artwork_coverage_percent: pct(global.artwork_covered, global_total),
        artwork_pending_items,
        provider_gates,
        roots,
    })
}

pub fn list_enrichment_albums(
    conn: &Connection,
    status_filter: Option<&str>,
    folder_id: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<EnrichmentAlbumSummary>> {
    let root_filter: Option<(String, String)> = if let Some(fid) = folder_id {
        conn.query_row(
            "SELECT mount_id, folder_path FROM watched_folders WHERE id = ?1",
            params![fid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    } else {
        None
    };

    let mut stmt = conn.prepare(
        "SELECT r.id,
                COALESCE(ov_alb.value_text, r.title),
                COALESCE(ov_art.value_text, r.artist_credit),
                COALESCE(e.status, 'pending'),
                e.provider,
                e.external_release_id,
                e.distance,
                e.runner_up_distance,
                COALESCE(e.vetoes_json, '[]'),
                EXISTS(SELECT 1 FROM metadata_overlays mo WHERE mo.entity_type='release' AND mo.entity_id=r.id AND mo.origin='user'),
                EXISTS(SELECT 1 FROM metadata_overlays mo WHERE mo.entity_type='release' AND mo.entity_id=r.id AND mo.origin='auto'),
                ai.status,
                ai.source,
                ai.width,
                ai.height,
                COALESCE(e.updated_at, r.created_at),
                r.folder_path
         FROM releases r
         LEFT JOIN enrichment_album_state e ON e.release_id = r.id
         LEFT JOIN metadata_overlays ov_alb ON ov_alb.entity_type='release' AND ov_alb.entity_id=r.id AND ov_alb.field_name='album'
         LEFT JOIN metadata_overlays ov_art ON ov_art.entity_type='release' AND ov_art.entity_id=r.id AND ov_art.field_name='album_artist'
         LEFT JOIN artwork_items ai ON ai.entity_kind='album' AND ai.entity_id=r.id
         WHERE EXISTS(SELECT 1 FROM tracks t WHERE t.release_id = r.id AND t.is_online != 0)
         ORDER BY COALESCE(e.updated_at, r.created_at) DESC, r.title ASC",
    )?;

    let mut out = Vec::new();
    let mut skipped = 0usize;
    let rows = stmt.query_map([], |r| {
        let vetoes_raw: String = r.get(8)?;
        let vetoes = serde_json::from_str::<Vec<serde_json::Value>>(&vetoes_raw).unwrap_or_default();
        Ok((
            EnrichmentAlbumSummary {
                release_id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                status: r.get(3)?,
                provider: r.get(4)?,
                external_release_id: r.get(5)?,
                distance: r.get(6)?,
                runner_up_distance: r.get(7)?,
                vetoes,
                has_user_overlay: r.get::<_, i64>(9)? != 0,
                has_auto_overlay: r.get::<_, i64>(10)? != 0,
                artwork_status: r.get(11)?,
                artwork_source: r.get(12)?,
                artwork_width: r.get::<_, Option<i64>>(13)?.map(|v| v.max(0) as u32),
                artwork_height: r.get::<_, Option<i64>>(14)?.map(|v| v.max(0) as u32),
                updated_at: r.get(15)?,
            },
            r.get::<_, String>(16)?,
        ))
    })?;

    for row in rows {
        let (item, folder_path) = row?;
        if let Some(st) = status_filter {
            if st == "user_overlay" {
                if !item.has_user_overlay && item.status != "user_locked" {
                    continue;
                }
            } else if item.status != st {
                continue;
            }
        }
        if let Some((_, ref root_path)) = root_filter {
            if !path_under_root(&folder_path, root_path) {
                continue;
            }
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        out.push(item);
        if out.len() >= limit {
            break;
        }
    }

    Ok(out)
}

struct RawReleaseBaseline {
    raw_title: String,
    raw_artist: String,
    raw_album_artist: Option<String>,
    raw_year: Option<i64>,
    raw_composer: Option<String>,
    raw_genre: Option<String>,
}

fn clean_raw_genre(trk_genre: Option<String>, rel_genre_tags: Option<String>) -> Option<String> {
    if let Some(g) = trk_genre.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Some(g);
    }
    let raw = rel_genre_tags?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with('[') {
        if let Ok(arr) = serde_json::from_str::<Vec<String>>(&raw) {
            return arr.into_iter().map(|s| s.trim().to_string()).find(|s| !s.is_empty());
        }
    }
    Some(raw)
}

fn load_raw_release_baseline(conn: &Connection, rid: &str) -> Result<Option<RawReleaseBaseline>> {
    let rel: Option<(String, String, Option<i64>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT title, artist_credit, release_year, composer_name, genre_tags FROM releases WHERE id = ?1",
            params![rid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((rel_title, rel_artist, rel_year, rel_composer, rel_genre)) = rel else {
        return Ok(None);
    };
    let trk: (Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>) = conn.query_row(
        "SELECT
            (SELECT album_title FROM tracks WHERE release_id = ?1 AND is_online != 0 AND TRIM(COALESCE(album_title, '')) != '' ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC LIMIT 1),
            (SELECT album_artist FROM tracks WHERE release_id = ?1 AND is_online != 0 AND TRIM(COALESCE(album_artist, '')) != '' ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC LIMIT 1),
            (SELECT composer FROM tracks WHERE release_id = ?1 AND is_online != 0 AND TRIM(COALESCE(composer, '')) != '' ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC LIMIT 1),
            (SELECT genre FROM tracks WHERE release_id = ?1 AND is_online != 0 AND TRIM(COALESCE(genre, '')) != '' ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC LIMIT 1),
            (SELECT release_year FROM tracks WHERE release_id = ?1 AND is_online != 0 AND release_year IS NOT NULL ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC LIMIT 1)",
        params![rid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let raw_title = trk
        .0
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(rel_title);
    let raw_album_artist = trk
        .1
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let trimmed = rel_artist.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
    let raw_composer = trk
        .2
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| rel_composer.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    let raw_genre = clean_raw_genre(trk.3, rel_genre);
    let raw_year = trk.4.or(rel_year);
    Ok(Some(RawReleaseBaseline {
        raw_title,
        raw_artist: rel_artist,
        raw_album_artist,
        raw_year,
        raw_composer,
        raw_genre,
    }))
}

pub fn get_enrichment_album_detail(
    conn: &Connection,
    release_id: &str,
) -> Result<Option<EnrichmentAlbumDetail>> {
    let rid = strip_core_release_prefix(release_id);
    let Some(raw) = load_raw_release_baseline(conn, rid)? else {
        return Ok(None);
    };
    let RawReleaseBaseline {
        raw_title,
        raw_artist,
        raw_album_artist,
        raw_year,
        raw_composer,
        raw_genre,
    } = raw;

    let state_row: Option<(
        String,
        Option<String>,
        Option<String>,
        Option<f64>,
        Option<f64>,
        String,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT status, provider, external_release_id, distance, runner_up_distance, vetoes_json, proposal_json
             FROM enrichment_album_state WHERE release_id = ?1",
            params![rid],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()?;

    let (status, provider, external_release_id, distance, runner_up_distance, vetoes, proposal) =
        if let Some((st, prov, ext, d, r_d, vetoes_s, prop_s)) = state_row {
            (
                st,
                prov,
                ext,
                d,
                r_d,
                serde_json::from_str::<Vec<serde_json::Value>>(&vetoes_s).unwrap_or_default(),
                prop_s.and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok()),
            )
        } else {
            ("pending".into(), None, None, None, None, Vec::new(), None)
        };

    let mut tracks = Vec::new();
    let mut track_ids = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, artist_credit, album_artist, track_number, disc_number, duration_secs, release_year
             FROM tracks WHERE release_id = ?1 AND is_online != 0
             ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC, title ASC",
        )?;
        for row in stmt.query_map(params![rid], |r| {
            Ok(RawTrackSummary {
                track_id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                album_artist: r.get(3)?,
                track_number: r.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u32),
                disc_number: r.get::<_, Option<i64>>(5)?.map(|v| v.max(0) as u32),
                duration_secs: r.get(6)?,
                release_year: r.get(7)?,
            })
        })? {
            let t = row?;
            track_ids.push(t.track_id.clone());
            tracks.push(t);
        }
    }

    let mut overlays = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, updated_at
             FROM metadata_overlays
             WHERE (entity_type = 'release' AND entity_id = ?1)
                OR (entity_type = 'track' AND entity_id IN (SELECT id FROM tracks WHERE release_id = ?1))
             ORDER BY entity_type ASC, entity_id ASC, field_name ASC",
        )?;
        for row in stmt.query_map(params![rid], |r| {
            Ok(OverlayRecord {
                entity_type: r.get(0)?,
                entity_id: r.get(1)?,
                field_name: r.get(2)?,
                value_text: r.get(3)?,
                origin: r.get(4)?,
                provider: r.get(5)?,
                confidence: r.get(6)?,
                distance: r.get(7)?,
                locked: r.get::<_, i64>(8)? != 0,
                updated_at: r.get(9)?,
            })
        })? {
            overlays.push(row?);
        }
    }

    let art_row: Option<(String, Option<String>, Option<i64>, Option<i64>, String)> = conn
        .query_row(
            "SELECT status, source, width, height, trace_json
             FROM artwork_items WHERE entity_kind = 'album' AND entity_id = ?1",
            params![rid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let (artwork_status, artwork_source, artwork_width, artwork_height, artwork_trace) =
        if let Some((st, src, w, h, trace_s)) = art_row {
            (
                Some(st),
                src,
                w.map(|v| v.max(0) as u32),
                h.map(|v| v.max(0) as u32),
                serde_json::from_str::<Vec<serde_json::Value>>(&trace_s).unwrap_or_default(),
            )
        } else {
            (None, None, None, None, Vec::new())
        };

    let pending_art_row: Option<(Option<String>, i64, Option<String>)> = conn
        .query_row(
            "SELECT override_url, attempts, last_error
             FROM artwork_queue WHERE entity_kind = 'album' AND entity_id = ?1",
            params![rid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (pending_artwork_url, pending_artwork_attempts, pending_artwork_error) =
        match pending_art_row {
            Some((Some(url), attempts, last_err)) if !url.trim().is_empty() => (
                Some(url.trim().to_string()),
                Some(attempts.max(0) as u32),
                last_err.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            ),
            _ => (None, None, None),
        };

    let mut user_actions = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, entity_id, field_name, action, previous_value, new_value, actor, created_at
             FROM metadata_user_actions
             WHERE (entity_type = 'release' AND entity_id = ?1)
                OR (entity_type = 'track' AND entity_id IN (SELECT id FROM tracks WHERE release_id = ?1))
             ORDER BY id DESC LIMIT 100",
        )?;
        for row in stmt.query_map(params![rid], |r| {
            Ok(UserActionRecord {
                id: r.get(0)?,
                entity_type: r.get(1)?,
                entity_id: r.get(2)?,
                field_name: r.get(3)?,
                action: r.get(4)?,
                previous_value: r.get(5)?,
                new_value: r.get(6)?,
                actor: r.get(7)?,
                created_at: r.get(8)?,
            })
        })? {
            user_actions.push(row?);
        }
    }

    Ok(Some(EnrichmentAlbumDetail {
        release_id: rid.to_string(),
        raw_title,
        raw_artist,
        raw_album_artist,
        raw_year,
        raw_composer,
        raw_genre,
        status,
        provider,
        external_release_id,
        distance,
        runner_up_distance,
        vetoes,
        proposal,
        overlays,
        tracks,
        artwork_status,
        artwork_source,
        artwork_width,
        artwork_height,
        artwork_trace,
        pending_artwork_url,
        pending_artwork_attempts,
        pending_artwork_error,
        user_actions,
    }))
}

pub fn apply_user_overlay(
    conn: &mut Connection,
    release_id: &str,
    release_fields: &serde_json::Map<String, serde_json::Value>,
    track_edits: &[UserTrackOverlayEdit],
    action_kind: &str,
    cover_art_url: Option<&str>,
) -> std::result::Result<(), String> {
    let rid = strip_core_release_prefix(release_id);
    let cover_url_clean = cover_art_url.map(str::trim).filter(|s| !s.is_empty());
    if let Some(url) = cover_url_clean {
        let valid_http =
            (url.starts_with("http://") || url.starts_with("https://")) && url.len() <= 2048;
        let valid_data =
            url.starts_with("data:image/") && url.contains(";base64,") && url.len() <= 22_000_000;
        if !valid_http && !valid_data {
            return Err(
                "Cover art URL must be HTTP(S) or a JPEG/PNG/WebP data URL".into(),
            );
        }
    }

    let raw_baseline = load_raw_release_baseline(conn, rid).map_err(|e| e.to_string())?;
    let sig = compute_release_raw_signature(conn, rid)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let allowed_release_fields = ["album", "album_artist", "year", "composer", "genre"];
    for (k, v) in release_fields {
        let canonical_field = match k.as_str() {
            "album" | "albumTitle" => "album",
            "albumArtist" | "album_artist" => "album_artist",
            "year" | "releaseYear" => "year",
            "composer" | "composerName" => "composer",
            "genre" => "genre",
            other if allowed_release_fields.contains(&other) => other,
            _ => continue,
        };
        let new_val = v
            .as_str()
            .map(str::trim)
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|n| n.to_string()))
            .filter(|s| !s.is_empty());
        let raw_val: Option<String> = raw_baseline.as_ref().and_then(|raw| match canonical_field {
            "album" => (!raw.raw_title.trim().is_empty()).then(|| raw.raw_title.trim().to_string()),
            "album_artist" => raw.raw_album_artist.clone(),
            "year" => raw.raw_year.map(|y| y.to_string()),
            "composer" => raw.raw_composer.clone(),
            "genre" => raw.raw_genre.clone(),
            _ => None,
        });
        let prev_val: Option<String> = tx
            .query_row(
                "SELECT value_text FROM metadata_overlays WHERE entity_type='release' AND entity_id=?1 AND field_name=?2",
                params![rid, canonical_field],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();

        let differs_from_raw = match (&new_val, &raw_val) {
            (Some(nv), Some(rv)) => nv != rv,
            (Some(_), None) => true,
            (None, _) => false,
        };

        if let Some(ref val) = new_val {
            if differs_from_raw {
                tx.execute(
                    "INSERT INTO metadata_overlays
                        (entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, source_signature, updated_at)
                     VALUES ('release', ?1, ?2, ?3, 'user', 'user_manual', 1.0, 0.0, 1, ?4, CURRENT_TIMESTAMP)
                     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
                        value_text = excluded.value_text,
                        origin = 'user',
                        provider = 'user_manual',
                        confidence = 1.0,
                        distance = 0.0,
                        locked = 1,
                        source_signature = excluded.source_signature,
                        updated_at = CURRENT_TIMESTAMP",
                    params![rid, canonical_field, val, sig],
                )
                .map_err(|e| e.to_string())?;
            } else {
                tx.execute(
                    "DELETE FROM metadata_overlays WHERE entity_type='release' AND entity_id=?1 AND field_name=?2",
                    params![rid, canonical_field],
                )
                .map_err(|e| e.to_string())?;
            }
        } else {
            tx.execute(
                "DELETE FROM metadata_overlays WHERE entity_type='release' AND entity_id=?1 AND field_name=?2",
                params![rid, canonical_field],
            )
            .map_err(|e| e.to_string())?;
        }

        let effective_before = prev_val.as_deref().or(raw_val.as_deref());
        let effective_after = new_val.as_deref().or(raw_val.as_deref());
        if effective_before != effective_after {
            record_user_action(
                &tx,
                "release",
                rid,
                canonical_field,
                action_kind,
                effective_before,
                effective_after,
                "user",
            )
            .map_err(|e| e.to_string())?;
        }
    }

    for tr in track_edits {
        let raw_track: Option<(String, String, Option<i64>)> = tx
            .query_row(
                "SELECT title, artist_credit, release_year FROM tracks WHERE id = ?1 AND release_id = ?2",
                params![tr.track_id, rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((raw_t_title, raw_t_artist, raw_t_year)) = raw_track else {
            continue;
        };
        let raw_t_year_str = raw_t_year.map(|y| y.to_string());
        for (field_name, opt_val, raw_t_val) in [
            ("track_title", tr.title.as_deref(), Some(raw_t_title.trim())),
            ("track_artist", tr.artist.as_deref(), Some(raw_t_artist.trim())),
            ("year", tr.year.as_deref(), raw_t_year_str.as_deref()),
        ] {
            let Some(raw_val_in) = opt_val else { continue };
            let trimmed = raw_val_in.trim();
            let prev_val: Option<String> = tx
                .query_row(
                    "SELECT value_text FROM metadata_overlays WHERE entity_type='track' AND entity_id=?1 AND field_name=?2",
                    params![tr.track_id, field_name],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            let differs_from_raw = !trimmed.is_empty() && Some(trimmed) != raw_t_val;
            if differs_from_raw {
                tx.execute(
                    "INSERT INTO metadata_overlays
                        (entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, source_signature, updated_at)
                     VALUES ('track', ?1, ?2, ?3, 'user', 'user_manual', 1.0, 0.0, 1, ?4, CURRENT_TIMESTAMP)
                     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
                        value_text = excluded.value_text,
                        origin = 'user',
                        provider = 'user_manual',
                        confidence = 1.0,
                        distance = 0.0,
                        locked = 1,
                        source_signature = excluded.source_signature,
                        updated_at = CURRENT_TIMESTAMP",
                    params![tr.track_id, field_name, trimmed, sig],
                )
                .map_err(|e| e.to_string())?;
            } else {
                tx.execute(
                    "DELETE FROM metadata_overlays WHERE entity_type='track' AND entity_id=?1 AND field_name=?2",
                    params![tr.track_id, field_name],
                )
                .map_err(|e| e.to_string())?;
            }
            let effective_before = prev_val.as_deref().or(raw_t_val);
            let effective_after = (!trimmed.is_empty()).then_some(trimmed).or(raw_t_val);
            if effective_before != effective_after {
                record_user_action(
                    &tx,
                    "track",
                    &tr.track_id,
                    field_name,
                    action_kind,
                    effective_before,
                    effective_after,
                    "user",
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(art_url) = cover_url_clean {
        let now = epoch_secs();
        tx.execute(
            "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, last_error, override_url)
             VALUES('album', ?1, 0, 0, 0, ?2, NULL, ?3)
             ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                priority = 0,
                attempts = 0,
                next_retry_at = 0,
                enqueued_at = excluded.enqueued_at,
                last_error = NULL,
                override_url = excluded.override_url",
            params![rid, now, art_url],
        )
        .map_err(|e| e.to_string())?;
        let display_val = if art_url.starts_with("data:") {
            "uploaded image"
        } else {
            art_url
        };
        record_user_action(
            &tx,
            "release",
            rid,
            "cover_art",
            "stage_artwork",
            None,
            Some(display_val),
            "user",
        )
        .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "INSERT INTO enrichment_album_state(release_id, status, raw_signature, updated_at)
         VALUES(?1, 'user_locked', ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(release_id) DO UPDATE SET
            status = 'user_locked',
            raw_signature = excluded.raw_signature,
            updated_at = CURRENT_TIMESTAMP",
        params![rid, sig],
    )
    .map_err(|e| e.to_string())?;

    mark_curate_queue_projection_stale(&tx, rid).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn accept_album_proposal(conn: &mut Connection, release_id: &str) -> std::result::Result<(), String> {
    let rid = strip_core_release_prefix(release_id);
    let proposal_str: Option<(Option<String>, Option<String>, Option<f64>)> = conn
        .query_row(
            "SELECT proposal_json, provider, distance FROM enrichment_album_state WHERE release_id = ?1",
            params![rid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((Some(raw_json), provider, distance)) = proposal_str else {
        return Err("No enrichment proposal available for this album".into());
    };
    let proposal: serde_json::Value = serde_json::from_str(&raw_json).map_err(|e| e.to_string())?;
    let sig = compute_release_raw_signature(conn, rid)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let prov = provider.as_deref().unwrap_or("enrichment");
    let dist = distance.unwrap_or(0.0);
    let conf = (1.0 - dist).clamp(0.0, 1.0);

    for (json_key, field_name) in [
        ("album", "album"),
        ("albumArtist", "album_artist"),
        ("year", "year"),
        ("composer", "composer"),
        ("genre", "genre"),
    ] {
        let val = proposal
            .get(json_key)
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.trim().to_string())
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
            .filter(|s| !s.is_empty());
        let Some(val) = val else { continue };
        let prev: Option<String> = tx
            .query_row(
                "SELECT value_text FROM metadata_overlays WHERE entity_type='release' AND entity_id=?1 AND field_name=?2",
                params![rid, field_name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        tx.execute(
            "INSERT INTO metadata_overlays
                (entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, source_signature, updated_at)
             VALUES ('release', ?1, ?2, ?3, 'user', ?4, ?5, ?6, 1, ?7, CURRENT_TIMESTAMP)
             ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
                value_text = excluded.value_text,
                origin = 'user',
                provider = excluded.provider,
                confidence = excluded.confidence,
                distance = excluded.distance,
                locked = 1,
                source_signature = excluded.source_signature,
                updated_at = CURRENT_TIMESTAMP",
            params![rid, field_name, val, prov, conf, dist, sig],
        )
        .map_err(|e| e.to_string())?;
        record_user_action(
            &tx,
            "release",
            rid,
            field_name,
            "accept_auto",
            prev.as_deref(),
            Some(&val),
            "user",
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(tracks) = proposal.get("tracks").and_then(|v| v.as_array()) {
        for tr in tracks {
            let Some(tid) = tr.get("localTrackId").and_then(|v| v.as_str()) else {
                continue;
            };
            for (k, field_name) in [
                ("proposedArtist", "track_artist"),
                ("proposedTitle", "track_title"),
            ] {
                let Some(val) = tr.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) else {
                    continue;
                };
                tx.execute(
                    "INSERT INTO metadata_overlays
                        (entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, source_signature, updated_at)
                     VALUES ('track', ?1, ?2, ?3, 'user', ?4, ?5, ?6, 1, ?7, CURRENT_TIMESTAMP)
                     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
                        value_text = excluded.value_text,
                        origin = 'user',
                        provider = excluded.provider,
                        confidence = excluded.confidence,
                        distance = excluded.distance,
                        locked = 1,
                        source_signature = excluded.source_signature,
                        updated_at = CURRENT_TIMESTAMP",
                    params![tid, field_name, val, prov, conf, dist, sig],
                )
                .map_err(|e| e.to_string())?;
                record_user_action(
                    &tx,
                    "track",
                    tid,
                    field_name,
                    "accept_auto",
                    None,
                    Some(val),
                    "user",
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    tx.execute(
        "UPDATE enrichment_album_state
         SET status = 'auto_applied', raw_signature = ?2, updated_at = CURRENT_TIMESTAMP
         WHERE release_id = ?1",
        params![rid, sig],
    )
    .map_err(|e| e.to_string())?;

    mark_curate_queue_projection_stale(&tx, rid).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn revert_album_to_file_tags(conn: &mut Connection, release_id: &str) -> std::result::Result<(), String> {
    let rid = strip_core_release_prefix(release_id);
    let sig = compute_release_raw_signature(conn, rid)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM metadata_overlays WHERE entity_type = 'release' AND entity_id = ?1",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM metadata_overlays
         WHERE entity_type = 'track' AND entity_id IN (SELECT id FROM tracks WHERE release_id = ?1)",
        params![rid],
    )
    .map_err(|e| e.to_string())?;

    record_user_action(
        &tx,
        "release",
        rid,
        "*",
        "revert_to_file",
        None,
        None,
        "user",
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO enrichment_album_state(release_id, status, raw_signature, updated_at)
         VALUES(?1, 'user_locked', ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(release_id) DO UPDATE SET
            status = 'user_locked',
            raw_signature = excluded.raw_signature,
            updated_at = CURRENT_TIMESTAMP",
        params![rid, sig],
    )
    .map_err(|e| e.to_string())?;

    mark_curate_queue_projection_stale(&tx, rid).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn lock_album_file_tags(conn: &mut Connection, release_id: &str) -> std::result::Result<(), String> {
    let rid = strip_core_release_prefix(release_id);
    let sig = compute_release_raw_signature(conn, rid)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM metadata_overlays WHERE entity_type='release' AND entity_id=?1 AND origin='auto'",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM metadata_overlays
         WHERE entity_type='track' AND origin='auto'
           AND entity_id IN (SELECT id FROM tracks WHERE release_id=?1)",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    record_user_action(&tx, "release", rid, "*", "lock_file_tags", None, None, "user")
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO enrichment_album_state(release_id, status, raw_signature, updated_at)
         VALUES(?1, 'user_locked', ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(release_id) DO UPDATE SET
            status = 'user_locked',
            raw_signature = excluded.raw_signature,
            updated_at = CURRENT_TIMESTAMP",
        params![rid, sig],
    )
    .map_err(|e| e.to_string())?;
    mark_curate_queue_projection_stale(&tx, rid).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn unlock_album_for_enrichment(conn: &mut Connection, release_id: &str) -> std::result::Result<(), String> {
    let rid = strip_core_release_prefix(release_id);
    let now = epoch_secs();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE metadata_overlays SET locked = 0 WHERE entity_type='release' AND entity_id=?1 AND origin='auto'",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE metadata_overlays SET locked = 0
         WHERE entity_type='track' AND origin='auto'
           AND entity_id IN (SELECT id FROM tracks WHERE release_id=?1)",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    record_user_action(&tx, "release", rid, "*", "unlock_auto", None, None, "user")
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO enrichment_album_state(release_id, status, attempt_count, next_retry_at, last_error, updated_at)
         VALUES(?1, 'pending', 0, 0, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(release_id) DO UPDATE SET
            status = 'pending',
            attempt_count = 0,
            next_retry_at = 0,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP",
        params![rid],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, last_error)
         VALUES('album', ?1, 5, 0, 0, ?2, NULL)
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
            priority = 5,
            attempts = 0,
            next_retry_at = 0,
            last_error = NULL",
        params![rid, now],
    )
    .map_err(|e| e.to_string())?;
    mark_curate_queue_projection_stale(&tx, rid).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_file_commit_for_tracks(
    conn: &mut Connection,
    track_changes: &[(String, String, String)], // (track_id, field, after_value)
) -> Result<()> {
    if track_changes.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let mut touched_releases = HashSet::new();
    for (track_id, raw_field, after_val) in track_changes {
        let release_id: Option<String> = tx
            .query_row(
                "SELECT release_id FROM tracks WHERE id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(ref rid) = release_id {
            touched_releases.insert(rid.clone());
        }
        let field_name = match raw_field.as_str() {
            "title" => "track_title",
            "artist" | "artistCredit" => "track_artist",
            "album" | "albumTitle" => "album",
            "albumArtist" => "album_artist",
            "composer" | "composerName" => "composer",
            "genre" => "genre",
            other => other,
        };
        if matches!(field_name, "track_title" | "track_artist") {
            tx.execute(
                "DELETE FROM metadata_overlays WHERE entity_type='track' AND entity_id=?1 AND field_name=?2",
                params![track_id, field_name],
            )?;
            record_user_action(
                &tx,
                "track",
                track_id,
                field_name,
                "commit_to_file",
                None,
                Some(after_val),
                "user",
            )?;
        } else if let Some(ref rid) = release_id {
            tx.execute(
                "DELETE FROM metadata_overlays WHERE entity_type='release' AND entity_id=?1 AND field_name=?2",
                params![rid, field_name],
            )?;
            record_user_action(
                &tx,
                "release",
                rid,
                field_name,
                "commit_to_file",
                None,
                Some(after_val),
                "user",
            )?;
        }
    }
    for rid in touched_releases {
        let sig = compute_release_raw_signature(&tx, &rid)?.unwrap_or_default();
        tx.execute(
            "INSERT INTO enrichment_album_state(release_id, status, raw_signature, updated_at)
             VALUES(?1, 'user_locked', ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(release_id) DO UPDATE SET
                status = 'user_locked',
                raw_signature = excluded.raw_signature,
                updated_at = CURRENT_TIMESTAMP",
            params![rid, sig],
        )?;
        mark_curate_queue_projection_stale(&tx, &rid)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn enqueue_rerun(
    conn: &mut Connection,
    release_id: Option<&str>,
    folder_id: Option<&str>,
    only_missing_or_failed: bool,
) -> Result<usize> {
    let now = epoch_secs();
    if let Some(raw_rid) = release_id {
        let rid = strip_core_release_prefix(raw_rid);
        let changed = conn.execute(
            "INSERT INTO enrichment_album_state(release_id, status, attempt_count, next_retry_at, last_error, updated_at)
             VALUES(?1, 'pending', 0, 0, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(release_id) DO UPDATE SET
                status = CASE WHEN enrichment_album_state.status = 'user_locked' THEN 'user_locked' ELSE 'pending' END,
                attempt_count = 0,
                next_retry_at = 0,
                last_error = NULL,
                updated_at = CURRENT_TIMESTAMP",
            params![rid],
        )?;
        let _ = conn.execute(
            "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, last_error)
             VALUES('album', ?1, 5, 0, 0, ?2, NULL)
             ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                priority = 5, attempts = 0, next_retry_at = 0, last_error = NULL",
            params![rid, now],
        );
        return Ok(changed);
    }

    let target_rids: Vec<String> = if let Some(fid) = folder_id {
        let root: Option<(String, String)> = conn
            .query_row(
                "SELECT mount_id, folder_path FROM watched_folders WHERE id = ?1",
                params![fid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((mount_id, root_path)) = root else {
            return Ok(0);
        };
        let mut stmt = conn.prepare(
            "SELECT DISTINCT release_id, mount_id, folder_path FROM tracks WHERE is_online != 0",
        )?;
        let mut matched = HashSet::new();
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (rid, mid, fp) = row?;
            if path_under_root(&fp, &root_path) || mid == mount_id {
                matched.insert(rid);
            }
        }
        matched.into_iter().collect()
    } else {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT release_id FROM tracks WHERE is_online != 0",
        )?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    let mut queued = 0usize;
    for rid in target_rids {
        let cur_status: Option<String> = conn
            .query_row(
                "SELECT status FROM enrichment_album_state WHERE release_id = ?1",
                params![rid],
                |r| r.get(0),
            )
            .optional()?;
        if cur_status.as_deref() == Some("user_locked") {
            continue;
        }
        if only_missing_or_failed
            && !matches!(cur_status.as_deref(), None | Some("pending" | "failed" | "no_match"))
        {
            continue;
        }
        conn.execute(
            "INSERT INTO enrichment_album_state(release_id, status, attempt_count, next_retry_at, last_error, updated_at)
             VALUES(?1, 'pending', 0, 0, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(release_id) DO UPDATE SET
                status = 'pending', attempt_count = 0, next_retry_at = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP",
            params![rid],
        )?;
        conn.execute(
            "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, last_error)
             VALUES('album', ?1, 10, 0, 0, ?2, NULL)
             ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                attempts = 0, next_retry_at = 0, last_error = NULL",
            params![rid, now],
        )?;
        queued += 1;
    }

    Ok(queued)
}
