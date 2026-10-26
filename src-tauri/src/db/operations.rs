use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStorageMount {
    pub id: String,
    pub name: String,
    pub mount_path: String,
    pub r#type: String,
    pub file_system: String,
    pub total_bytes: i64,
    pub used_bytes: i64,
    pub is_read_only_locked: bool,
    pub status: String,
    pub health_score: String,
    pub smart_ok: bool,
    pub temp_celsius: f64,
    pub last_seen_timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbWatchedFolder {
    pub id: String,
    pub mount_id: String,
    pub folder_path: String,
    pub display_name: String,
    pub scan_mode: String,
    pub ignore_patterns: Option<String>,
    pub is_enabled: bool,
    pub last_scanned_timestamp: Option<String>,
    #[serde(default)]
    pub track_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbRelease {
    pub id: String,
    pub title: String,
    pub folder_path: String,
    pub folder_name: String,
    pub artist_credit: String,
    pub composer_name: Option<String>,
    pub release_year: Option<i32>,
    pub genre_tags: Option<String>,
    pub front_cover_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub target_folder_path: Option<String>,
    #[serde(default)]
    pub is_compilation: bool,
    pub physical_combo_title: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTrack {
    pub id: String,
    pub release_id: String,
    pub mount_id: String,
    pub folder_path: String,
    pub folder_name: String,
    pub file_path: String,
    pub file_name: String,
    pub file_size: i64,
    pub mtime: i64,
    pub title: String,
    pub artist_credit: String,
    pub album_title: String,
    pub release_year: Option<i32>,
    pub track_number: Option<i32>,
    pub genre: Option<String>,
    pub composer: Option<String>,
    pub duration_secs: f64,
    pub format: String,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u16>,
    pub dr_score: Option<i32>,
    pub has_embedded_art: bool,
    pub sidecar_status: String,
    pub sidecar_edits_json: Option<String>,
    pub is_online: bool,
    pub work_title: Option<String>,
    pub movement_number: Option<String>,
    pub movement_title: Option<String>,
    #[serde(default)]
    pub is_compilation: bool,
    pub album_artist: Option<String>,
    pub original_album: Option<String>,
    pub original_year: Option<i32>,
    pub acoustid_fingerprint: Option<String>,
    pub musicbrainz_recording_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSkippedFile {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub category: String,
    pub diagnostic_error: String,
    pub timestamp: String,
    pub is_ignored: bool,
    #[serde(default)]
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMtimeCheck {
    pub file_path: String,
    pub mtime: i64,
    pub file_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageAccessibilityReport {
    pub mount_id: String,
    pub name: String,
    pub mount_path: String,
    pub is_accessible: bool,
    pub status: String,
    pub tracks_count: i64,
    pub releases_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbArtworkCacheState {
    pub id: String,
    pub entity_type: String,
    pub source_path: String,
    pub cache_path: Option<String>,
    pub status: String, // "cached", "not_found", "failed"
    pub source_mtime: i64,
    pub file_size: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCanonicalArtist {
    pub id: String,
    pub name: String,
    pub sort_name: Option<String>,
    pub mbid: Option<String>,
    pub apple_artist_id: Option<String>,
    pub portrait_url: Option<String>,
    pub portrait_status: String,
    pub portrait_checked_at: Option<i64>,
    pub bio_summary: Option<String>,
    pub era_active: Option<String>,
    pub primary_role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbArtistSummary {
    pub id: String,
    pub name: String,
    pub sort_name: Option<String>,
    pub portrait_url: Option<String>,
    pub portrait_status: String,
    pub primary_role: String,
    pub albums_count: i64,
    pub tracks_count: i64,
    pub roles: Vec<String>,
    pub era_active: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbArtistCreditItem {
    pub track_id: String,
    pub track_title: String,
    pub track_number: Option<i32>,
    pub release_id: String,
    pub release_title: String,
    pub release_year: Option<i32>,
    pub role: String,
    pub format: String,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub dr_score: Option<i32>,
    pub duration_secs: f64,
    pub full_artist_credit: String,
    pub co_artists: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbArtistDetail {
    pub artist: DbCanonicalArtist,
    pub albums_count: i64,
    pub tracks_count: i64,
    pub roles: Vec<String>,
    pub discography: Vec<DbRelease>,
    pub appearing_tracks: Vec<DbArtistCreditItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCatalogSearchResults {
    pub albums: Vec<DbRelease>,
    pub tracks: Vec<DbTrack>,
    pub artists: Vec<DbArtistSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPlaylist {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub cover_art_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Option<String>,
    pub listening_notes: Option<String>,
    #[serde(default)]
    pub tracks_count: i64,
    #[serde(default)]
    pub total_duration_secs: f64,
    #[serde(default)]
    pub format_breakdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPlaylistWithTracks {
    #[serde(flatten)]
    pub playlist: DbPlaylist,
    pub tracks: Vec<DbTrack>,
}

pub fn check_directory_accessible_sync(path_str: &str) -> bool {
    let norm = path_str.replace('/', "\\");
    if norm.starts_with(r"\\") {
        let parts: Vec<&str> = norm
            .trim_start_matches('\\')
            .split('\\')
            .filter(|s| !s.is_empty())
            .collect();
        if let Some(host) = parts.first() {
            use std::net::{TcpStream, ToSocketAddrs};
            use std::time::Duration;
            let addr = format!("{}:445", host);
            let is_host_up = addr
                .to_socket_addrs()
                .ok()
                .and_then(|mut iter| iter.next())
                .map(|sock_addr| TcpStream::connect_timeout(&sock_addr, Duration::from_millis(2000)).is_ok())
                .unwrap_or(false);
            if !is_host_up {
                return false;
            }
        }
    }

    let p = std::path::Path::new(path_str);
    if !p.exists() || !p.is_dir() {
        return false;
    }
    std::fs::read_dir(p).is_ok()
}

pub async fn is_directory_accessible(path_str: &str) -> bool {
    let p = path_str.to_string();
    let task = tokio::task::spawn_blocking(move || check_directory_accessible_sync(&p));

    match tokio::time::timeout(std::time::Duration::from_millis(4000), task).await {
        Ok(Ok(res)) => res,
        _ => false,
    }
}

pub struct DbOperations;

impl DbOperations {
    // Storage Mounts
    pub fn get_storage_mounts(conn: &Connection) -> Result<Vec<DbStorageMount>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, mount_path, mount_type, file_system, total_bytes, used_bytes,
                    is_readonly_locked, status, health_score, smart_ok, temp_celsius, last_seen_timestamp
             FROM storage_mounts ORDER BY name ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DbStorageMount {
                id: row.get(0)?,
                name: row.get(1)?,
                mount_path: row.get(2)?,
                r#type: row.get(3)?,
                file_system: row.get(4)?,
                total_bytes: row.get(5)?,
                used_bytes: row.get(6)?,
                is_read_only_locked: row.get::<_, i32>(7)? != 0,
                status: row.get(8)?,
                health_score: row.get(9)?,
                smart_ok: row.get::<_, i32>(10)? != 0,
                temp_celsius: row.get(11)?,
                last_seen_timestamp: row.get(12)?,
            })
        })?;

        let mut mounts = Vec::new();
        for r in rows {
            mounts.push(r?);
        }
        Ok(mounts)
    }

    pub fn upsert_storage_mount(conn: &Connection, mount: &DbStorageMount) -> Result<()> {
        conn.execute(
            "INSERT INTO storage_mounts (
                id, name, mount_path, mount_type, file_system, total_bytes, used_bytes,
                is_readonly_locked, status, health_score, smart_ok, temp_celsius, last_seen_timestamp
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                mount_path=excluded.mount_path,
                mount_type=excluded.mount_type,
                file_system=excluded.file_system,
                total_bytes=excluded.total_bytes,
                used_bytes=excluded.used_bytes,
                is_readonly_locked=excluded.is_readonly_locked,
                status=excluded.status,
                health_score=excluded.health_score,
                smart_ok=excluded.smart_ok,
                temp_celsius=excluded.temp_celsius,
                last_seen_timestamp=excluded.last_seen_timestamp",
            params![
                mount.id,
                mount.name,
                mount.mount_path,
                mount.r#type,
                mount.file_system,
                mount.total_bytes,
                mount.used_bytes,
                if mount.is_read_only_locked { 1 } else { 0 },
                mount.status,
                mount.health_score,
                if mount.smart_ok { 1 } else { 0 },
                mount.temp_celsius,
                mount.last_seen_timestamp,
            ],
        )?;
        Ok(())
    }

    pub fn set_mount_status(conn: &Connection, mount_id: &str, status: &str) -> Result<()> {
        let is_online = status == "online" || status == "scanning";
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE storage_mounts SET status = ?1, last_seen_timestamp = ?2 WHERE id = ?3",
            params![status, now, mount_id],
        )?;

        // Update all tracks for this mount
        conn.execute(
            "UPDATE tracks SET is_online = ?1 WHERE mount_id = ?2",
            params![if is_online { 1 } else { 0 }, mount_id],
        )?;

        Ok(())
    }

    pub fn toggle_mount_lock(conn: &Connection, mount_id: &str) -> Result<bool> {
        let mut stmt = conn.prepare("SELECT is_readonly_locked FROM storage_mounts WHERE id = ?1")?;
        let current_lock: i32 = stmt.query_row(params![mount_id], |r| r.get(0))?;
        let new_lock = if current_lock == 0 { 1 } else { 0 };

        conn.execute(
            "UPDATE storage_mounts SET is_readonly_locked = ?1 WHERE id = ?2",
            params![new_lock, mount_id],
        )?;

        Ok(new_lock != 0)
    }

    pub fn delete_storage_mount(conn: &Connection, mount_id: &str) -> Result<()> {
        conn.execute("DELETE FROM tracks WHERE mount_id = ?1", params![mount_id])?;
        conn.execute("DELETE FROM watched_folders WHERE mount_id = ?1", params![mount_id])?;
        conn.execute("DELETE FROM storage_mounts WHERE id = ?1", params![mount_id])?;
        let _ = conn.execute(
            "DELETE FROM releases WHERE id NOT IN (SELECT DISTINCT release_id FROM tracks)",
            [],
        );
        Ok(())
    }

    pub fn ensure_mount_for_path(
        conn: &Connection,
        path: &str,
        preferred_mount_id: Option<&str>,
    ) -> Result<String> {
        // 1. If preferred_mount_id is provided, check if it actually exists in storage_mounts
        if let Some(pref_id) = preferred_mount_id {
            if !pref_id.is_empty() {
                let exists: bool = conn
                    .query_row(
                        "SELECT 1 FROM storage_mounts WHERE id = ?1 LIMIT 1",
                        params![pref_id],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if exists {
                    return Ok(pref_id.to_string());
                }
            }
        }

        // 2. Fetch existing storage mounts and check if any covers this path
        let existing_mounts = Self::get_storage_mounts(conn).unwrap_or_default();
        let norm_path = path.replace('/', "\\").to_lowercase();
        let trimmed_norm_path = norm_path.trim_end_matches('\\');

        for m in &existing_mounts {
            let m_norm = m.mount_path.replace('/', "\\").to_lowercase();
            let m_trimmed = m_norm.trim_end_matches('\\');

            if !m_trimmed.is_empty() {
                if trimmed_norm_path == m_trimmed
                    || trimmed_norm_path.starts_with(&format!("{}\\", m_trimmed))
                    || (m_trimmed.ends_with(':') && trimmed_norm_path.starts_with(m_trimmed))
                {
                    return Ok(m.id.clone());
                }
            }
        }

        // 3. Derive canonical mount details from path
        let raw_path = path.replace('/', "\\");
        let (mount_id, mount_name, mount_path, mount_type, file_system) = {
            let is_win_drive = if raw_path.len() >= 2 {
                let bytes = raw_path.as_bytes();
                bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
            } else {
                false
            };

            if is_win_drive {
                let drive_char = raw_path.chars().next().unwrap().to_ascii_uppercase();
                let clean_id = format!("mount-{}_", drive_char.to_ascii_lowercase());
                let name = format!("Drive {}: (Local Audio Disk)", drive_char);
                let m_path = format!("{}:\\", drive_char);
                (clean_id, name, m_path, "local_disk".to_string(), "NTFS".to_string())
            } else if raw_path.starts_with("\\\\") {
                let parts: Vec<&str> = raw_path
                    .trim_start_matches('\\')
                    .split('\\')
                    .filter(|s| !s.is_empty())
                    .collect();
                let share_root = if parts.len() >= 2 {
                    format!("\\\\{}\\{}", parts[0], parts[1])
                } else if !parts.is_empty() {
                    format!("\\\\{}", parts[0])
                } else {
                    "\\\\network-share".to_string()
                };
                let clean_id = format!(
                    "mount-{}",
                    share_root.to_lowercase().replace(|c: char| !c.is_alphanumeric(), "_")
                );
                let name = format!("Network Storage ({})", share_root);
                (clean_id, name, share_root, "nas_array".to_string(), "ZFS".to_string())
            } else if path.starts_with('/') {
                let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
                let root_str = if parts.len() >= 2 && parts[0] == "Volumes" {
                    format!("/Volumes/{}", parts[1])
                } else if !parts.is_empty() {
                    format!("/{}", parts[0])
                } else {
                    "/".to_string()
                };
                let clean_id = format!(
                    "mount-{}",
                    root_str.to_lowercase().replace(|c: char| !c.is_alphanumeric(), "_")
                );
                let name = format!("Storage Volume ({})", root_str);
                (clean_id, name, root_str, "local_disk".to_string(), "APFS".to_string())
            } else {
                (
                    "mount-local".to_string(),
                    "Local Storage".to_string(),
                    raw_path.clone(),
                    "local_disk".to_string(),
                    "NTFS".to_string(),
                )
            }
        };

        // 4. Upsert this new storage mount into database
        let new_mount = DbStorageMount {
            id: mount_id.clone(),
            name: mount_name,
            mount_path,
            r#type: mount_type,
            file_system,
            total_bytes: 1_000_000_000_000,
            used_bytes: 450_000_000_000,
            is_read_only_locked: false,
            status: "online".to_string(),
            health_score: "healthy".to_string(),
            smart_ok: true,
            temp_celsius: 34.0,
            last_seen_timestamp: Utc::now().to_rfc3339(),
        };

        Self::upsert_storage_mount(conn, &new_mount)?;
        Ok(mount_id)
    }

    // Watched Folders
    pub fn get_watched_folders(conn: &Connection) -> Result<Vec<DbWatchedFolder>> {
        let mut stmt = conn.prepare(
            "SELECT wf.id, wf.mount_id, wf.folder_path, wf.display_name, wf.scan_mode, wf.ignore_patterns, wf.is_enabled, wf.last_scanned_timestamp,
             (SELECT COUNT(*) FROM tracks t WHERE t.file_path LIKE wf.folder_path || '%') AS track_count
             FROM watched_folders wf ORDER BY wf.folder_path ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DbWatchedFolder {
                id: row.get(0)?,
                mount_id: row.get(1)?,
                folder_path: row.get(2)?,
                display_name: row.get(3)?,
                scan_mode: row.get(4)?,
                ignore_patterns: row.get(5)?,
                is_enabled: row.get::<_, i32>(6)? != 0,
                last_scanned_timestamp: row.get(7)?,
                track_count: row.get(8).ok(),
            })
        })?;

        let mut folders = Vec::new();
        for r in rows {
            folders.push(r?);
        }
        Ok(folders)
    }

    pub fn upsert_watched_folder(conn: &Connection, folder: &DbWatchedFolder) -> Result<()> {
        let valid_mount_id = Self::ensure_mount_for_path(conn, &folder.folder_path, Some(&folder.mount_id))?;

        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM watched_folders WHERE folder_path = ?1 LIMIT 1",
                params![folder.folder_path],
                |r| r.get(0),
            )
            .ok();
        let target_id = existing_id.unwrap_or_else(|| folder.id.clone());

        conn.execute(
            "INSERT INTO watched_folders (
                id, mount_id, folder_path, display_name, scan_mode, ignore_patterns, is_enabled, last_scanned_timestamp
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                mount_id=excluded.mount_id,
                folder_path=excluded.folder_path,
                display_name=excluded.display_name,
                scan_mode=excluded.scan_mode,
                ignore_patterns=excluded.ignore_patterns,
                is_enabled=excluded.is_enabled,
                last_scanned_timestamp=excluded.last_scanned_timestamp",
            params![
                target_id,
                valid_mount_id,
                folder.folder_path,
                folder.display_name,
                folder.scan_mode,
                folder.ignore_patterns,
                if folder.is_enabled { 1 } else { 0 },
                folder.last_scanned_timestamp,
            ],
        )?;
        Ok(())
    }

    pub fn delete_watched_folder(conn: &Connection, folder_id: &str) -> Result<()> {
        conn.execute("DELETE FROM watched_folders WHERE id = ?1", params![folder_id])?;
        Ok(())
    }

    // Releases
    pub fn get_releases(conn: &Connection, only_online: Option<bool>) -> Result<Vec<DbRelease>> {
        let sql = if only_online.unwrap_or(false) {
            "SELECT DISTINCT r.id, r.title, r.folder_path, r.folder_name, r.artist_credit, r.composer_name,
                    r.release_year, r.genre_tags, r.front_cover_url, r.backdrop_url, r.target_folder_path,
                    r.is_compilation, r.physical_combo_title, r.created_at
             FROM releases r
             WHERE r.id IN (SELECT DISTINCT release_id FROM tracks WHERE is_online = 1)
             ORDER BY r.title ASC"
        } else {
            "SELECT id, title, folder_path, folder_name, artist_credit, composer_name,
                    release_year, genre_tags, front_cover_url, backdrop_url, target_folder_path,
                    is_compilation, physical_combo_title, created_at
             FROM releases ORDER BY title ASC"
        };

        let mut stmt = conn.prepare(sql)?;

        let rows = stmt.query_map([], |row| {
            Ok(DbRelease {
                id: row.get(0)?,
                title: row.get(1)?,
                folder_path: row.get(2)?,
                folder_name: row.get(3)?,
                artist_credit: row.get(4)?,
                composer_name: row.get(5)?,
                release_year: row.get(6)?,
                genre_tags: row.get(7)?,
                front_cover_url: row.get(8)?,
                backdrop_url: row.get(9)?,
                target_folder_path: row.get(10)?,
                is_compilation: row.get::<_, i32>(11).unwrap_or(0) != 0,
                physical_combo_title: row.get(12)?,
                created_at: row.get(13)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn upsert_releases_batch(conn: &mut Connection, releases: &[DbRelease]) -> Result<()> {
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO releases (
                    id, title, folder_path, folder_name, artist_credit, composer_name,
                    release_year, genre_tags, front_cover_url, backdrop_url, target_folder_path,
                    is_compilation, physical_combo_title, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    folder_path=excluded.folder_path,
                    folder_name=excluded.folder_name,
                    artist_credit=excluded.artist_credit,
                    composer_name=COALESCE(excluded.composer_name, releases.composer_name),
                    release_year=COALESCE(excluded.release_year, releases.release_year),
                    genre_tags=COALESCE(excluded.genre_tags, releases.genre_tags),
                    front_cover_url=COALESCE(excluded.front_cover_url, releases.front_cover_url),
                    backdrop_url=COALESCE(excluded.backdrop_url, releases.backdrop_url),
                    target_folder_path=COALESCE(excluded.target_folder_path, releases.target_folder_path),
                    is_compilation=excluded.is_compilation,
                    physical_combo_title=COALESCE(excluded.physical_combo_title, releases.physical_combo_title)",
            )?;

            for rel in releases {
                stmt.execute(params![
                    rel.id,
                    rel.title,
                    rel.folder_path,
                    rel.folder_name,
                    rel.artist_credit,
                    rel.composer_name,
                    rel.release_year,
                    rel.genre_tags,
                    rel.front_cover_url,
                    rel.backdrop_url,
                    rel.target_folder_path,
                    if rel.is_compilation { 1 } else { 0 },
                    rel.physical_combo_title,
                    rel.created_at,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // Tracks
    pub fn get_tracks(
        conn: &Connection,
        limit: Option<i64>,
        offset: Option<i64>,
        only_online: Option<bool>,
    ) -> Result<Vec<DbTrack>> {
        let where_clause = if only_online.unwrap_or(false) {
            "WHERE is_online = 1"
        } else {
            ""
        };

        let pagination_clause = match (limit, offset) {
            (Some(l), Some(o)) => format!("LIMIT {} OFFSET {}", l, o),
            (Some(l), None) => format!("LIMIT {}", l),
            _ => "".to_string(),
        };

        let sql = format!(
            "SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                    file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                    genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                    dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                    work_title, movement_number, movement_title,
                    is_compilation, album_artist, original_album, original_year,
                    acoustid_fingerprint, musicbrainz_recording_id, created_at
             FROM tracks {} ORDER BY album_title ASC, track_number ASC {}",
            where_clause, pagination_clause
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(DbTrack {
                id: row.get(0)?,
                release_id: row.get(1)?,
                mount_id: row.get(2)?,
                folder_path: row.get(3)?,
                folder_name: row.get(4)?,
                file_path: row.get(5)?,
                file_name: row.get(6)?,
                file_size: row.get(7)?,
                mtime: row.get(8)?,
                title: row.get(9)?,
                artist_credit: row.get(10)?,
                album_title: row.get(11)?,
                release_year: row.get(12)?,
                track_number: row.get(13)?,
                genre: row.get(14)?,
                composer: row.get(15)?,
                duration_secs: row.get(16)?,
                format: row.get(17)?,
                sample_rate: row.get(18)?,
                bit_depth: row.get(19)?,
                channels: row.get(20)?,
                dr_score: row.get(21)?,
                has_embedded_art: row.get::<_, i32>(22)? != 0,
                sidecar_status: row.get(23)?,
                sidecar_edits_json: row.get(24)?,
                is_online: row.get::<_, i32>(25)? != 0,
                work_title: row.get(26)?,
                movement_number: row.get(27)?,
                movement_title: row.get(28)?,
                is_compilation: row.get::<_, i32>(29).unwrap_or(0) != 0,
                album_artist: row.get(30)?,
                original_album: row.get(31)?,
                original_year: row.get(32)?,
                acoustid_fingerprint: row.get(33)?,
                musicbrainz_recording_id: row.get(34)?,
                created_at: row.get(35)?,
            })
        })?;

        let mut tracks = Vec::new();
        for r in rows {
            tracks.push(r?);
        }
        Ok(tracks)
    }

    pub fn get_offline_counts(conn: &Connection) -> Result<(i64, i64)> {
        let mut stmt_trk = conn.prepare("SELECT COUNT(*) FROM tracks WHERE is_online = 0")?;
        let offline_tracks: i64 = stmt_trk.query_row([], |r| r.get(0))?;

        let mut stmt_rel = conn.prepare(
            "SELECT COUNT(*) FROM releases WHERE id NOT IN (SELECT DISTINCT release_id FROM tracks WHERE is_online = 1)"
        )?;
        let offline_releases: i64 = stmt_rel.query_row([], |r| r.get(0))?;

        Ok((offline_tracks, offline_releases))
    }

    pub fn upsert_tracks_batch(conn: &mut Connection, tracks: &[DbTrack]) -> Result<()> {
        // Pre-resolve and ensure all referenced mounts exist in storage_mounts
        let mut resolved_mounts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for t in tracks {
            if !resolved_mounts.contains_key(&t.mount_id) {
                let valid_id = Self::ensure_mount_for_path(conn, &t.folder_path, Some(&t.mount_id))
                    .unwrap_or_else(|_| t.mount_id.clone());
                resolved_mounts.insert(t.mount_id.clone(), valid_id);
            }
        }

        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO tracks (
                    id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                    file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                    genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                    dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                    work_title, movement_number, movement_title,
                    is_compilation, album_artist, original_album, original_year,
                    acoustid_fingerprint, musicbrainz_recording_id, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                          ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                          ?31, ?32, ?33, ?34, ?35, ?36)
                ON CONFLICT(file_path) DO UPDATE SET
                    release_id=excluded.release_id,
                    mount_id=excluded.mount_id,
                    folder_path=excluded.folder_path,
                    folder_name=excluded.folder_name,
                    file_size=excluded.file_size,
                    mtime=excluded.mtime,
                    title=excluded.title,
                    artist_credit=excluded.artist_credit,
                    album_title=excluded.album_title,
                    release_year=excluded.release_year,
                    track_number=excluded.track_number,
                    genre=excluded.genre,
                    composer=excluded.composer,
                    duration_secs=excluded.duration_secs,
                    format=excluded.format,
                    sample_rate=excluded.sample_rate,
                    bit_depth=excluded.bit_depth,
                    channels=excluded.channels,
                    dr_score=excluded.dr_score,
                    has_embedded_art=excluded.has_embedded_art,
                    sidecar_status=excluded.sidecar_status,
                    sidecar_edits_json=excluded.sidecar_edits_json,
                    is_online=excluded.is_online,
                    work_title=excluded.work_title,
                    movement_number=excluded.movement_number,
                    movement_title=excluded.movement_title,
                    is_compilation=excluded.is_compilation,
                    album_artist=COALESCE(excluded.album_artist, tracks.album_artist),
                    original_album=COALESCE(excluded.original_album, tracks.original_album),
                    original_year=COALESCE(excluded.original_year, tracks.original_year),
                    acoustid_fingerprint=COALESCE(excluded.acoustid_fingerprint, tracks.acoustid_fingerprint),
                    musicbrainz_recording_id=COALESCE(excluded.musicbrainz_recording_id, tracks.musicbrainz_recording_id)",
            )?;

            for t in tracks {
                let mount_id = resolved_mounts.get(&t.mount_id).unwrap_or(&t.mount_id);
                stmt.execute(params![
                    t.id,
                    t.release_id,
                    mount_id,
                    t.folder_path,
                    t.folder_name,
                    t.file_path,
                    t.file_name,
                    t.file_size,
                    t.mtime,
                    t.title,
                    t.artist_credit,
                    t.album_title,
                    t.release_year,
                    t.track_number,
                    t.genre,
                    t.composer,
                    t.duration_secs,
                    t.format,
                    t.sample_rate,
                    t.bit_depth,
                    t.channels,
                    t.dr_score,
                    if t.has_embedded_art { 1 } else { 0 },
                    t.sidecar_status,
                    t.sidecar_edits_json,
                    if t.is_online { 1 } else { 0 },
                    t.work_title,
                    t.movement_number,
                    t.movement_title,
                    if t.is_compilation { 1 } else { 0 },
                    t.album_artist,
                    t.original_album,
                    t.original_year,
                    t.acoustid_fingerprint,
                    t.musicbrainz_recording_id,
                    t.created_at,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_unfingerprinted_tracks(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT id, file_path FROM tracks 
             WHERE (acoustid_fingerprint IS NULL OR acoustid_fingerprint = '')
               AND is_online = 1
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        let mut res = Vec::new();
        for r in rows {
            if let Ok(item) = r {
                res.push(item);
            }
        }
        Ok(res)
    }

    pub fn update_track_fingerprint(conn: &Connection, track_id: &str, fingerprint: &str) -> Result<()> {
        conn.execute(
            "UPDATE tracks SET acoustid_fingerprint = ?1 WHERE id = ?2",
            params![fingerprint, track_id],
        )?;
        Ok(())
    }

    pub fn update_track_provenance(
        conn: &Connection,
        track_id: &str,
        mbid: Option<&str>,
        original_album: Option<&str>,
        original_year: Option<i32>,
    ) -> Result<()> {
        conn.execute(
            "UPDATE tracks SET 
                musicbrainz_recording_id = COALESCE(?1, musicbrainz_recording_id),
                original_album = COALESCE(?2, original_album),
                original_year = COALESCE(?3, original_year)
             WHERE id = ?4",
            params![mbid, original_album, original_year, track_id],
        )?;
        Ok(())
    }

    pub fn get_cached_acoustid(
        conn: &Connection,
        fingerprint: &str,
    ) -> Result<Option<(Option<String>, Option<String>, Option<i32>, Option<f64>)>> {
        let mut stmt = conn.prepare(
            "SELECT mbid, canonical_title, canonical_year, score FROM acoustid_cache WHERE fingerprint = ?1"
        )?;
        let mut rows = stmt.query(params![fingerprint])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        } else {
            Ok(None)
        }
    }

    pub fn cache_acoustid_result(
        conn: &Connection,
        fingerprint: &str,
        duration: i32,
        mbid: Option<&str>,
        canonical_title: Option<&str>,
        canonical_year: Option<i32>,
        score: Option<f64>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR REPLACE INTO acoustid_cache (fingerprint, duration, mbid, canonical_title, canonical_year, score, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![fingerprint, duration, mbid, canonical_title, canonical_year, score, now],
        )?;
        Ok(())
    }

    pub fn get_file_mtimes(conn: &Connection, folder_path: &str) -> Result<Vec<FileMtimeCheck>> {
        let pattern = format!("{}%", folder_path);
        let mut stmt = conn.prepare(
            "SELECT file_path, mtime, file_size FROM tracks WHERE file_path LIKE ?1",
        )?;

        let rows = stmt.query_map(params![pattern], |row| {
            Ok(FileMtimeCheck {
                file_path: row.get(0)?,
                mtime: row.get(1)?,
                file_size: row.get(2)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // Skipped / Quarantine Files
    pub fn get_skipped_files(conn: &Connection) -> Result<Vec<DbSkippedFile>> {
        let mut stmt = conn.prepare(
            "SELECT id, file_path, file_name, category, diagnostic_error, timestamp, is_ignored, mtime
             FROM skipped_files WHERE is_ignored = 0 ORDER BY timestamp DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DbSkippedFile {
                id: row.get(0)?,
                file_path: row.get(1)?,
                file_name: row.get(2)?,
                category: row.get(3)?,
                diagnostic_error: row.get(4)?,
                timestamp: row.get(5)?,
                is_ignored: row.get::<_, i32>(6)? != 0,
                mtime: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn get_ignored_skipped_files(conn: &Connection) -> Result<std::collections::HashMap<String, i64>> {
        let mut stmt = conn.prepare(
            "SELECT file_path, mtime FROM skipped_files WHERE is_ignored = 1"
        )?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let mtime: i64 = row.get::<_, Option<i64>>(1)?.unwrap_or(0);
            Ok((path, mtime))
        })?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (p, m) = r?;
            map.insert(p, m);
        }
        Ok(map)
    }

    pub fn add_skipped_file(conn: &Connection, file: &DbSkippedFile) -> Result<()> {
        conn.execute(
            "INSERT INTO skipped_files (id, file_path, file_name, category, diagnostic_error, timestamp, is_ignored, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(file_path) DO UPDATE SET
                diagnostic_error=excluded.diagnostic_error,
                timestamp=excluded.timestamp,
                category=excluded.category,
                mtime=excluded.mtime,
                is_ignored=0",
            params![
                file.id,
                file.file_path,
                file.file_name,
                file.category,
                file.diagnostic_error,
                file.timestamp,
                if file.is_ignored { 1 } else { 0 },
                file.mtime,
            ],
        )?;
        Ok(())
    }

    pub fn ignore_skipped_file(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("UPDATE skipped_files SET is_ignored = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn ignore_all_skipped_files(conn: &Connection) -> Result<()> {
        conn.execute("UPDATE skipped_files SET is_ignored = 1 WHERE is_ignored = 0", [])?;
        Ok(())
    }

    pub fn delete_skipped_file(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM skipped_files WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn remove_skipped_file_by_path(conn: &Connection, file_path: &str) -> Result<()> {
        conn.execute("DELETE FROM skipped_files WHERE file_path = ?1", params![file_path])?;
        Ok(())
    }

    // Diagnostics / Counts
    pub fn get_library_counts(conn: &Connection) -> Result<(i64, i64, i64, i64)> {
        let total_tracks: i64 = conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        let total_releases: i64 = conn.query_row("SELECT COUNT(*) FROM releases", [], |r| r.get(0))?;
        let total_mounts: i64 = conn.query_row("SELECT COUNT(*) FROM storage_mounts", [], |r| r.get(0))?;
        let total_skipped: i64 = conn.query_row("SELECT COUNT(*) FROM skipped_files WHERE is_ignored = 0", [], |r| r.get(0))?;
        Ok((total_tracks, total_releases, total_mounts, total_skipped))
    }

    // --- Artwork Cache State Maintenance ---
    pub fn upsert_artwork_cache_state(conn: &Connection, state: &DbArtworkCacheState) -> Result<()> {
        conn.execute(
            "INSERT INTO artwork_cache_state (
                id, entity_type, source_path, cache_path, status, source_mtime, file_size, width, height, checked_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                cache_path = excluded.cache_path,
                status = excluded.status,
                source_mtime = excluded.source_mtime,
                file_size = excluded.file_size,
                width = excluded.width,
                height = excluded.height,
                checked_at = excluded.checked_at",
            params![
                state.id,
                state.entity_type,
                state.source_path,
                state.cache_path,
                state.status,
                state.source_mtime,
                state.file_size,
                state.width,
                state.height,
                state.checked_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_artwork_cache_state(conn: &Connection, id: &str) -> Result<Option<DbArtworkCacheState>> {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, source_path, cache_path, status, source_mtime, file_size, width, height, checked_at
             FROM artwork_cache_state WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(DbArtworkCacheState {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                source_path: row.get(2)?,
                cache_path: row.get(3)?,
                status: row.get(4)?,
                source_mtime: row.get(5)?,
                file_size: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                checked_at: row.get(9)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn get_pending_artwork_releases(conn: &Connection, limit: usize) -> Result<Vec<(String, String, Option<String>)>> {
        let sql = format!(
            "SELECT r.id, r.folder_path,
                    (SELECT t.file_path FROM tracks t WHERE t.release_id = r.id AND t.is_online = 1 LIMIT 1)
             FROM releases r
             WHERE r.id NOT IN (SELECT id FROM artwork_cache_state WHERE status IN ('cached', 'not_found', 'failed'))
             LIMIT {}",
            limit
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        let mut res = Vec::new();
        for r in rows {
            if let Ok(item) = r {
                res.push(item);
            }
        }
        Ok(res)
    }

    pub fn get_pending_artwork_tracks(conn: &Connection, limit: usize) -> Result<Vec<(String, String, String, i64)>> {
        let sql = format!(
            "SELECT t.id, t.release_id, t.file_path, t.mtime
             FROM tracks t
             WHERE t.is_online = 1
               AND t.has_embedded_art = 1
               AND t.id NOT IN (SELECT id FROM artwork_cache_state WHERE status IN ('cached', 'not_found', 'failed'))
               AND (t.release_id IS NULL OR t.release_id = '' OR t.release_id NOT IN (SELECT id FROM artwork_cache_state WHERE status = 'cached'))
             LIMIT {}",
            limit
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        let mut res = Vec::new();
        for r in rows {
            if let Ok(item) = r {
                res.push(item);
            }
        }
        Ok(res)
    }

    pub fn get_artwork_cache_stats(conn: &Connection) -> Result<(i64, i64, i64, i64, i64)> {
        let total_releases: i64 = conn.query_row("SELECT COUNT(*) FROM releases", [], |r| r.get(0)).unwrap_or(0);
        // Only count loose singles that do not belong to any album release
        let standalone_singles: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE is_online = 1 AND (release_id IS NULL OR release_id = '' OR release_id NOT IN (SELECT id FROM releases))",
            [],
            |r| r.get(0),
        ).unwrap_or(0);
        let total_target = total_releases + standalone_singles;

        let mut stmt = conn.prepare(
            "SELECT 
                COALESCE(SUM(CASE WHEN status = 'cached' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)
             FROM artwork_cache_state
             WHERE entity_type = 'release' OR id IN (
                 SELECT id FROM tracks WHERE is_online = 1 AND (release_id IS NULL OR release_id = '' OR release_id NOT IN (SELECT id FROM releases))
             )",
        )?;
        let (cached, not_found, failed): (i64, i64, i64) = stmt.query_row([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let completed = cached + not_found + failed;
        let pending = if total_target > completed { total_target - completed } else { 0 };

        Ok((cached, not_found, failed, total_target, pending))
    }

    pub fn update_release_front_cover_url(conn: &Connection, release_id: &str, cover_url: &str) -> Result<()> {
        conn.execute(
            "UPDATE releases SET front_cover_url = ?1 WHERE id = ?2 AND (front_cover_url IS NULL OR front_cover_url = '')",
            params![cover_url, release_id],
        )?;
        Ok(())
    }

    // --- Relational Artist Methods ---

    pub fn normalize_artist_alias(name: &str) -> String {
        name.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase()
    }

    pub fn is_compound_exception(name: &str) -> bool {
        let norm = Self::normalize_artist_alias(name);
        if norm.is_empty() {
            return false;
        }

        const EXCEPTIONS: &[&str] = &[
            "simon & garfunkel", "simon and garfunkel",
            "shankar-ehsaan-loy", "shankar ehsaan loy", "shankar, ehsaan & loy",
            "salim-sulaiman", "salim sulaiman", "salim & sulaiman",
            "vishal-shekhar", "vishal shekhar", "vishal & shekhar",
            "earth, wind & fire", "earth wind & fire", "earth wind and fire",
            "crosby, stills, nash & young", "crosby, stills & nash",
            "emerson, lake & palmer", "blood, sweat & tears",
            "kalyanji-anandji", "kalyanji anandji",
            "laxmikant-pyarelal", "laxmikant pyarelal",
            "nadeem-shravan", "nadeem shravan",
            "jatin-lalit", "jatin lalit",
            "anand-milind", "anand milind",
            "sajid-wajid", "sajid wajid",
            "sachin-jigar", "sachin jigar",
            "ajay-atul", "ajay atul",
            "brooks & dunn", "hall & oates", "daryl hall & john oates",
            "sly & the family stone", "kc & the sunshine band",
            "katrina and the waves", "huey lewis and the news",
            "joan jett & the blackhearts", "tom petty and the heartbreakers",
            "bob marley & the wailers", "iron & wine",
            "florence + the machine", "florence and the machine",
            "mumford & sons", "of monsters and men",
            "king gizzard & the lizard wizard"
        ];

        for ex in EXCEPTIONS {
            if norm == Self::normalize_artist_alias(ex) {
                return true;
            }
        }
        false
    }

    pub fn split_multi_artist_credits(raw_artist: &str, composer: Option<&str>) -> Vec<(String, String, String, i32)> {
        let mut credits = Vec::new();
        let mut order = 0;

        let trimmed_artist = raw_artist.trim();
        if !trimmed_artist.is_empty() && !trimmed_artist.eq_ignore_ascii_case("unknown artist") && !trimmed_artist.eq_ignore_ascii_case("various artists") {
            if Self::is_compound_exception(trimmed_artist) {
                credits.push((trimmed_artist.to_string(), "Primary".to_string(), String::new(), order));
                order += 1;
            } else {
                let lower = trimmed_artist.to_lowercase();
                let feat_pos = lower.find(" feat. ")
                    .or_else(|| lower.find(" feat "))
                    .or_else(|| lower.find(" ft. "))
                    .or_else(|| lower.find(" ft "))
                    .or_else(|| lower.find(" featuring "))
                    .or_else(|| lower.find(" with "));

                let (main_str, feat_str) = match feat_pos {
                    Some(pos) => {
                        let main = &trimmed_artist[..pos];
                        let after_delim = &trimmed_artist[pos..];
                        let delim_len = if after_delim.to_lowercase().starts_with(" featuring ") {
                            11
                        } else if after_delim.to_lowercase().starts_with(" feat. ") {
                            7
                        } else if after_delim.to_lowercase().starts_with(" feat ") {
                            6
                        } else if after_delim.to_lowercase().starts_with(" with ") {
                            6
                        } else if after_delim.to_lowercase().starts_with(" ft. ") {
                            5
                        } else if after_delim.to_lowercase().starts_with(" ft ") {
                            4
                        } else {
                            4
                        };
                        let feat = if after_delim.len() > delim_len { &after_delim[delim_len..] } else { "" };
                        (main, Some(feat))
                    }
                    None => (trimmed_artist, None),
                };

                let split_tokens = |s: &str| -> Vec<String> {
                    let mut tokens = Vec::new();
                    let cleaned = s.replace(';', ",")
                                   .replace('/', ",")
                                   .replace('•', ",")
                                   .replace('|', ",")
                                   .replace('\\', ",");
                    for chunk in cleaned.split(',') {
                        let sub_cleaned = chunk.replace(" & ", ", ").replace(" and ", ", ");
                        for tok in sub_cleaned.split(',') {
                            let t = tok.trim();
                            if !t.is_empty() && !t.eq_ignore_ascii_case("unknown artist") && !t.eq_ignore_ascii_case("various artists") {
                                tokens.push(t.to_string());
                            }
                        }
                    }
                    tokens
                };

                for tok in split_tokens(main_str) {
                    if !credits.iter().any(|(name, role, _, _)| name.eq_ignore_ascii_case(&tok) && role == "Primary") {
                        credits.push((tok, "Primary".to_string(), ", ".to_string(), order));
                        order += 1;
                    }
                }

                if let Some(feat) = feat_str {
                    for tok in split_tokens(feat) {
                        if !credits.iter().any(|(name, _, _, _)| name.eq_ignore_ascii_case(&tok)) {
                            credits.push((tok, "Featured".to_string(), " feat. ".to_string(), order));
                            order += 1;
                        }
                    }
                }
            }
        }

        if let Some(comp_str) = composer {
            let comp_trimmed = comp_str.trim();
            if !comp_trimmed.is_empty() && !comp_trimmed.eq_ignore_ascii_case("unknown composer") && !comp_trimmed.eq_ignore_ascii_case("unknown") {
                if Self::is_compound_exception(comp_trimmed) {
                    if !credits.iter().any(|(name, role, _, _)| name.eq_ignore_ascii_case(comp_trimmed) && role == "Composer") {
                        credits.push((comp_trimmed.to_string(), "Composer".to_string(), String::new(), order));
                        let _ = order;
                    }
                } else {
                    let comp_cleaned = comp_trimmed.replace(';', ",")
                                                   .replace('/', ",")
                                                   .replace(" & ", ", ")
                                                   .replace(" and ", ", ");
                    for chunk in comp_cleaned.split(',') {
                        let t = chunk.trim();
                        if !t.is_empty() && !t.eq_ignore_ascii_case("unknown") {
                            if !credits.iter().any(|(name, role, _, _)| name.eq_ignore_ascii_case(t) && role == "Composer") {
                                credits.push((t.to_string(), "Composer".to_string(), String::new(), order));
                                order += 1;
                            }
                        }
                    }
                }
            }
        }

        credits
    }

    pub fn upsert_canonical_artist_entity(conn: &Connection, name: &str, role: &str) -> Result<String> {
        let alias_norm = Self::normalize_artist_alias(name);
        if alias_norm.is_empty() {
            return Ok(String::new());
        }

        // Check alias mapping first
        let existing_id: Option<String> = conn.query_row(
            "SELECT canonical_artist_id FROM artist_aliases WHERE alias_norm = ?1 LIMIT 1",
            params![alias_norm],
            |r| r.get(0),
        ).ok();

        if let Some(id) = existing_id {
            return Ok(id);
        }

        // Check if canonical_artists already has exact name
        let existing_by_name: Option<String> = conn.query_row(
            "SELECT id FROM canonical_artists WHERE name = ?1 LIMIT 1",
            params![name],
            |r| r.get(0),
        ).ok();

        let artist_id = if let Some(id) = existing_by_name {
            id
        } else {
            let new_id = format!("art-{}", uuid::Uuid::new_v4().simple());
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO canonical_artists (id, name, sort_name, primary_role, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(name) DO UPDATE SET primary_role = excluded.primary_role",
                params![new_id, name, name, role, now],
            )?;
            new_id
        };

        // Link alias
        let _ = conn.execute(
            "INSERT OR IGNORE INTO artist_aliases (alias_norm, canonical_artist_id) VALUES (?1, ?2)",
            params![alias_norm, artist_id],
        );

        Ok(artist_id)
    }

    pub fn upsert_track_artist_credits(
        conn: &mut Connection,
        track_id: &str,
        credits: &[(String, String, String, i32)],
    ) -> Result<()> {
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO track_artist_credits (track_id, canonical_artist_id, role, join_phrase, credit_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            )?;

            for (artist_name, role, join_phrase, order) in credits {
                let artist_id = Self::upsert_canonical_artist_entity(&tx, artist_name, role)?;
                if !artist_id.is_empty() {
                    stmt.execute(params![track_id, artist_id, role, join_phrase, order])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_canonical_artists(conn: &Connection) -> Result<Vec<DbArtistSummary>> {
        let mut stmt = conn.prepare(
            "SELECT 
                ca.id, ca.name, ca.sort_name, ca.portrait_url, ca.primary_role, ca.era_active,
                COUNT(DISTINCT t.release_id) AS albums_count,
                COUNT(DISTINCT tac.track_id) AS tracks_count,
                COALESCE(GROUP_CONCAT(DISTINCT tac.role), ca.primary_role) AS all_roles,
                ca.portrait_status
             FROM canonical_artists ca
             JOIN track_artist_credits tac ON tac.canonical_artist_id = ca.id
             JOIN tracks t ON t.id = tac.track_id
             GROUP BY ca.id
             HAVING tracks_count > 0
             ORDER BY albums_count DESC, tracks_count DESC, ca.name ASC"
        )?;

        let rows = stmt.query_map([], |row| {
            let roles_str: String = row.get(8).unwrap_or_default();
            let roles: Vec<String> = roles_str.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            Ok(DbArtistSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_name: row.get(2)?,
                portrait_url: row.get(3)?,
                primary_role: row.get(4)?,
                era_active: row.get(5)?,
                albums_count: row.get(6)?,
                tracks_count: row.get(7)?,
                roles,
                portrait_status: row.get(9).unwrap_or_else(|_| "pending".to_string()),
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn get_canonical_artist_detail(conn: &Connection, artist_id: &str) -> Result<Option<DbArtistDetail>> {
        let artist_res: Option<DbCanonicalArtist> = conn.query_row(
            "SELECT id, name, sort_name, mbid, apple_artist_id, portrait_url, portrait_status, portrait_checked_at, bio_summary, era_active, primary_role, created_at
             FROM canonical_artists WHERE id = ?1 LIMIT 1",
            params![artist_id],
            |row| {
                Ok(DbCanonicalArtist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_name: row.get(2)?,
                    mbid: row.get(3)?,
                    apple_artist_id: row.get(4)?,
                    portrait_url: row.get(5)?,
                    portrait_status: row.get(6).unwrap_or_else(|_| "pending".to_string()),
                    portrait_checked_at: row.get(7).ok(),
                    bio_summary: row.get(8)?,
                    era_active: row.get(9)?,
                    primary_role: row.get(10)?,
                    created_at: row.get(11)?,
                })
            },
        ).ok();

        let artist = match artist_res {
            Some(a) => a,
            None => return Ok(None),
        };

        // Discography releases where this artist contributed
        let mut rel_stmt = conn.prepare(
            "SELECT DISTINCT r.id, r.title, r.folder_path, r.folder_name, r.artist_credit, r.composer_name,
                             r.release_year, r.genre_tags, r.front_cover_url, r.backdrop_url, r.target_folder_path,
                             r.is_compilation, r.physical_combo_title, r.created_at
             FROM releases r
             JOIN tracks t ON t.release_id = r.id
             JOIN track_artist_credits tac ON tac.track_id = t.id
             WHERE tac.canonical_artist_id = ?1
             ORDER BY r.release_year DESC, r.title ASC"
        )?;

        let rel_rows = rel_stmt.query_map(params![artist_id], |row| {
            Ok(DbRelease {
                id: row.get(0)?,
                title: row.get(1)?,
                folder_path: row.get(2)?,
                folder_name: row.get(3)?,
                artist_credit: row.get(4)?,
                composer_name: row.get(5)?,
                release_year: row.get(6)?,
                genre_tags: row.get(7)?,
                front_cover_url: row.get(8)?,
                backdrop_url: row.get(9)?,
                target_folder_path: row.get(10)?,
                is_compilation: row.get::<_, i32>(11).unwrap_or(0) != 0,
                physical_combo_title: row.get(12)?,
                created_at: row.get(13)?,
            })
        })?;

        let mut discography = Vec::new();
        for r in rel_rows {
            discography.push(r?);
        }

        // Appearing tracks
        let mut trk_stmt = conn.prepare(
            "SELECT t.id, t.title, t.track_number, t.release_id, r.title, r.release_year, tac.role,
                    t.format, t.sample_rate, t.bit_depth, t.dr_score, t.duration_secs, t.artist_credit
             FROM tracks t
             JOIN releases r ON r.id = t.release_id
             JOIN track_artist_credits tac ON tac.track_id = t.id
             WHERE tac.canonical_artist_id = ?1
             ORDER BY r.release_year DESC, t.track_number ASC, t.title ASC"
        )?;

        let trk_rows = trk_stmt.query_map(params![artist_id], |row| {
            let full_credit: String = row.get(12)?;
            let co_artists: Vec<String> = full_credit.split(&[',', ';', '&', '/'][..])
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case(&artist.name))
                .collect();

            Ok(DbArtistCreditItem {
                track_id: row.get(0)?,
                track_title: row.get(1)?,
                track_number: row.get(2)?,
                release_id: row.get(3)?,
                release_title: row.get(4)?,
                release_year: row.get(5)?,
                role: row.get(6)?,
                format: row.get(7)?,
                sample_rate: row.get(8)?,
                bit_depth: row.get(9)?,
                dr_score: row.get(10)?,
                duration_secs: row.get(11)?,
                full_artist_credit: full_credit,
                co_artists,
            })
        })?;

        let mut appearing_tracks = Vec::new();
        for t in trk_rows {
            appearing_tracks.push(t?);
        }

        let mut roles_stmt = conn.prepare(
            "SELECT DISTINCT role FROM track_artist_credits WHERE canonical_artist_id = ?1"
        )?;
        let roles: Vec<String> = roles_stmt.query_map(params![artist_id], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        let albums_count = discography.len() as i64;
        let tracks_count = appearing_tracks.len() as i64;

        Ok(Some(DbArtistDetail {
            artist,
            albums_count,
            tracks_count,
            roles,
            discography,
            appearing_tracks,
        }))
    }

    pub fn set_artist_portrait(
        conn: &Connection,
        artist_id: &str,
        portrait_url: &str,
        status: &str,
    ) -> Result<()> {
        let now_sec = Utc::now().timestamp();
        conn.execute(
            "UPDATE canonical_artists 
             SET portrait_url = ?1, portrait_status = ?2, portrait_checked_at = ?3 
             WHERE id = ?4",
            params![portrait_url, status, now_sec, artist_id],
        )?;
        Ok(())
    }

    pub fn mark_artist_portrait_not_found(conn: &Connection, artist_id: &str) -> Result<()> {
        let now_sec = Utc::now().timestamp();
        conn.execute(
            "UPDATE canonical_artists SET portrait_status = 'not_found', portrait_checked_at = ?1 WHERE id = ?2",
            params![now_sec, artist_id],
        )?;
        Ok(())
    }

    pub fn get_pending_portrait_artists(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT id, name FROM canonical_artists 
             WHERE portrait_status = 'pending' AND (portrait_url IS NULL OR portrait_url = '')
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut list = Vec::new();
        for r in rows {
            if let Ok(item) = r {
                list.push(item);
            }
        }
        Ok(list)
    }

    pub fn get_artist_portrait_stats(conn: &Connection) -> Result<(usize, usize, usize, Vec<String>)> {
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM canonical_artists",
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        let completed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM canonical_artists WHERE (portrait_url IS NOT NULL AND portrait_url != '') OR portrait_status = 'not_found'",
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM canonical_artists WHERE portrait_status = 'pending' AND (portrait_url IS NULL OR portrait_url = '')",
            [],
            |r| r.get(0),
        ).unwrap_or(0);

        let mut stmt = conn.prepare(
            "SELECT name FROM canonical_artists 
             WHERE portrait_status = 'pending' AND (portrait_url IS NULL OR portrait_url = '')
             ORDER BY name ASC
             LIMIT 5"
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        let mut next_names = Vec::new();
        for r in rows {
            if let Ok(name) = r {
                next_names.push(name);
            }
        }

        Ok((total as usize, completed as usize, pending as usize, next_names))
    }

    pub fn backfill_artist_credits_from_tracks(conn: &mut Connection) -> Result<usize> {
        let count_tracks: i64 = conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0)).unwrap_or(0);
        if count_tracks == 0 {
            return Ok(0);
        }

        let track_items: Vec<(String, String, Option<String>)> = {
            let mut stmt = conn.prepare("SELECT id, artist_credit, composer FROM tracks")?;
            let items: Vec<(String, String, Option<String>)> = stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?.filter_map(|r| r.ok()).collect();
            items
        };

        let tx = conn.transaction()?;
        let mut inserted_credits = 0;
        {
            let mut credit_stmt = tx.prepare(
                "INSERT OR REPLACE INTO track_artist_credits (track_id, canonical_artist_id, role, join_phrase, credit_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            )?;

            for (track_id, artist_credit, composer) in &track_items {
                let credits = Self::split_multi_artist_credits(artist_credit, composer.as_deref());
                for (artist_name, role, join_phrase, order) in credits {
                    let artist_id = Self::upsert_canonical_artist_entity(&tx, &artist_name, &role)?;
                    if !artist_id.is_empty() {
                        let _ = credit_stmt.execute(params![track_id, artist_id, role, join_phrase, order]);
                        inserted_credits += 1;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(inserted_credits)
    }

    pub fn search_catalog(
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<DbCatalogSearchResults> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(DbCatalogSearchResults {
                albums: Vec::new(),
                tracks: Vec::new(),
                artists: Vec::new(),
            });
        }

        let like_pat = format!("%{}%", q);
        let lim = limit.min(25) as i64;

        // 1. Search Releases
        let mut albums = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT id, title, folder_path, folder_name, artist_credit, composer_name,
                        release_year, genre_tags, front_cover_url, backdrop_url, target_folder_path,
                        is_compilation, physical_combo_title, created_at
                 FROM releases
                 WHERE title LIKE ?1 OR artist_credit LIKE ?1 OR composer_name LIKE ?1 OR folder_name LIKE ?1
                 LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_pat, lim], |row| {
                Ok(DbRelease {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    folder_path: row.get(2)?,
                    folder_name: row.get(3)?,
                    artist_credit: row.get(4)?,
                    composer_name: row.get(5)?,
                    release_year: row.get(6)?,
                    genre_tags: row.get(7)?,
                    front_cover_url: row.get(8)?,
                    backdrop_url: row.get(9)?,
                    target_folder_path: row.get(10)?,
                    is_compilation: row.get::<_, i32>(11).unwrap_or(0) != 0,
                    physical_combo_title: row.get(12)?,
                    created_at: row.get(13)?,
                })
            })?;
            for r in rows.flatten() {
                albums.push(r);
            }
        }

        // 2. Search Tracks
        let mut tracks = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                        file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                        genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                        dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                        work_title, movement_number, movement_title,
                        is_compilation, album_artist, original_album, original_year,
                        acoustid_fingerprint, musicbrainz_recording_id, created_at
                 FROM tracks
                 WHERE title LIKE ?1 OR artist_credit LIKE ?1 OR composer LIKE ?1 OR work_title LIKE ?1 OR movement_title LIKE ?1
                 LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_pat, lim], |row| {
                Ok(DbTrack {
                    id: row.get(0)?,
                    release_id: row.get(1)?,
                    mount_id: row.get(2)?,
                    folder_path: row.get(3)?,
                    folder_name: row.get(4)?,
                    file_path: row.get(5)?,
                    file_name: row.get(6)?,
                    file_size: row.get(7)?,
                    mtime: row.get(8)?,
                    title: row.get(9)?,
                    artist_credit: row.get(10)?,
                    album_title: row.get(11)?,
                    release_year: row.get(12)?,
                    track_number: row.get(13)?,
                    genre: row.get(14)?,
                    composer: row.get(15)?,
                    duration_secs: row.get(16)?,
                    format: row.get(17)?,
                    sample_rate: row.get(18)?,
                    bit_depth: row.get(19)?,
                    channels: row.get(20)?,
                    dr_score: row.get(21)?,
                    has_embedded_art: row.get::<_, i32>(22)? != 0,
                    sidecar_status: row.get(23)?,
                    sidecar_edits_json: row.get(24)?,
                    is_online: row.get::<_, i32>(25)? != 0,
                    work_title: row.get(26)?,
                    movement_number: row.get(27)?,
                    movement_title: row.get(28)?,
                    is_compilation: row.get::<_, i32>(29).unwrap_or(0) != 0,
                    album_artist: row.get(30)?,
                    original_album: row.get(31)?,
                    original_year: row.get(32)?,
                    acoustid_fingerprint: row.get(33)?,
                    musicbrainz_recording_id: row.get(34)?,
                    created_at: row.get(35)?,
                })
            })?;
            for t in rows.flatten() {
                tracks.push(t);
            }
        }

        // 3. Search Canonical Artists
        let mut artists = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.name, a.sort_name, a.portrait_url, a.portrait_status, a.primary_role,
                        a.era_active,
                        COUNT(DISTINCT t.release_id) as albums_count,
                        COUNT(DISTINCT tac.track_id) as tracks_count
                 FROM canonical_artists a
                 LEFT JOIN track_artist_credits tac ON tac.canonical_artist_id = a.id
                 LEFT JOIN tracks t ON t.id = tac.track_id
                 WHERE a.name LIKE ?1 OR a.sort_name LIKE ?1
                 GROUP BY a.id
                 ORDER BY tracks_count DESC
                 LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_pat, lim], |row| {
                Ok(DbArtistSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_name: row.get(2)?,
                    portrait_url: row.get(3)?,
                    portrait_status: row.get(4)?,
                    primary_role: row.get(5)?,
                    era_active: row.get(6)?,
                    albums_count: row.get(7)?,
                    tracks_count: row.get(8)?,
                    roles: vec![row.get(5)?],
                })
            })?;
            for a in rows.flatten() {
                artists.push(a);
            }
        }

        Ok(DbCatalogSearchResults {
            albums,
            tracks,
            artists,
        })
    }

    // ==========================================
    // Playlists & Curated Archival Stacks
    // ==========================================

    pub fn get_playlists(conn: &Connection) -> Result<Vec<DbPlaylist>> {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.title, p.description, p.cover_art_url, p.created_at, p.updated_at,
                    p.tags, p.listening_notes,
                    COUNT(pt.track_id) as tracks_count,
                    COALESCE(SUM(t.duration_secs), 0.0) as total_duration_secs,
                    COALESCE(GROUP_CONCAT(DISTINCT t.format), '') as format_breakdown
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             LEFT JOIN tracks t ON t.id = pt.track_id
             GROUP BY p.id
             ORDER BY p.updated_at DESC"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DbPlaylist {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                cover_art_url: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                tags: row.get(6)?,
                listening_notes: row.get(7)?,
                tracks_count: row.get(8)?,
                total_duration_secs: row.get(9)?,
                format_breakdown: row.get(10)?,
            })
        })?;

        let mut list = Vec::new();
        for pl in rows.flatten() {
            list.push(pl);
        }
        Ok(list)
    }

    pub fn get_playlist_details(conn: &Connection, playlist_id: &str) -> Result<Option<DbPlaylistWithTracks>> {
        let mut stmt_p = conn.prepare(
            "SELECT p.id, p.title, p.description, p.cover_art_url, p.created_at, p.updated_at,
                    p.tags, p.listening_notes,
                    COUNT(pt.track_id) as tracks_count,
                    COALESCE(SUM(t.duration_secs), 0.0) as total_duration_secs,
                    COALESCE(GROUP_CONCAT(DISTINCT t.format), '') as format_breakdown
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             LEFT JOIN tracks t ON t.id = pt.track_id
             WHERE p.id = ?1
             GROUP BY p.id"
        )?;

        let playlist = stmt_p.query_row(params![playlist_id], |row| {
            Ok(DbPlaylist {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                cover_art_url: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                tags: row.get(6)?,
                listening_notes: row.get(7)?,
                tracks_count: row.get(8)?,
                total_duration_secs: row.get(9)?,
                format_breakdown: row.get(10)?,
            })
        });

        let playlist = match playlist {
            Ok(p) => p,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e),
        };

        // Fetch tracks ordered by pt.position ASC
        let mut stmt_t = conn.prepare(
            "SELECT t.id, t.release_id, t.mount_id, t.folder_path, t.folder_name,
                    t.file_path, t.file_name, t.file_size, t.mtime, t.title,
                    t.artist_credit, t.album_title, t.release_year, t.track_number,
                    t.genre, t.composer, t.duration_secs, t.format, t.sample_rate,
                    t.bit_depth, t.channels, t.dr_score, t.has_embedded_art,
                    t.sidecar_status, t.sidecar_edits_json, t.is_online,
                    t.work_title, t.movement_number, t.movement_title,
                    t.is_compilation, t.album_artist, t.original_album, t.original_year,
                    t.acoustid_fingerprint, t.musicbrainz_recording_id, t.created_at
             FROM playlist_tracks pt
             JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position ASC"
        )?;

        let track_rows = stmt_t.query_map(params![playlist_id], |row| {
            Ok(DbTrack {
                id: row.get(0)?,
                release_id: row.get(1)?,
                mount_id: row.get(2)?,
                folder_path: row.get(3)?,
                folder_name: row.get(4)?,
                file_path: row.get(5)?,
                file_name: row.get(6)?,
                file_size: row.get(7)?,
                mtime: row.get(8)?,
                title: row.get(9)?,
                artist_credit: row.get(10)?,
                album_title: row.get(11)?,
                release_year: row.get(12)?,
                track_number: row.get(13)?,
                genre: row.get(14)?,
                composer: row.get(15)?,
                duration_secs: row.get(16)?,
                format: row.get(17)?,
                sample_rate: row.get(18)?,
                bit_depth: row.get(19)?,
                channels: row.get(20)?,
                dr_score: row.get(21)?,
                has_embedded_art: row.get::<_, i64>(22)? != 0,
                sidecar_status: row.get(23)?,
                sidecar_edits_json: row.get(24)?,
                is_online: row.get::<_, i64>(25)? != 0,
                work_title: row.get(26)?,
                movement_number: row.get(27)?,
                movement_title: row.get(28)?,
                is_compilation: row.get::<_, i32>(29).unwrap_or(0) != 0,
                album_artist: row.get(30)?,
                original_album: row.get(31)?,
                original_year: row.get(32)?,
                acoustid_fingerprint: row.get(33)?,
                musicbrainz_recording_id: row.get(34)?,
                created_at: row.get(35)?,
            })
        })?;

        let mut tracks = Vec::new();
        for t in track_rows.flatten() {
            tracks.push(t);
        }

        Ok(Some(DbPlaylistWithTracks { playlist, tracks }))
    }

    pub fn create_playlist(
        conn: &mut Connection,
        id: &str,
        title: &str,
        description: Option<&str>,
        cover_art_url: Option<&str>,
        tags: Option<&str>,
        listening_notes: Option<&str>,
        track_ids: &[String],
    ) -> Result<DbPlaylist> {
        let now = Utc::now().to_rfc3339();
        let tx = conn.transaction()?;

        tx.execute(
            "INSERT INTO playlists (id, title, description, cover_art_url, created_at, updated_at, tags, listening_notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)",
            params![id, title, description, cover_art_url, now, tags, listening_notes],
        )?;

        let mut stmt_ins = tx.prepare(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, ?4)"
        )?;

        for (pos, tid) in track_ids.iter().enumerate() {
            stmt_ins.execute(params![id, tid, pos as i64, now])?;
        }
        drop(stmt_ins);

        tx.commit()?;

        Ok(DbPlaylist {
            id: id.to_string(),
            title: title.to_string(),
            description: description.map(|s| s.to_string()),
            cover_art_url: cover_art_url.map(|s| s.to_string()),
            created_at: now.clone(),
            updated_at: now,
            tags: tags.map(|s| s.to_string()),
            listening_notes: listening_notes.map(|s| s.to_string()),
            tracks_count: track_ids.len() as i64,
            total_duration_secs: 0.0,
            format_breakdown: String::new(),
        })
    }

    pub fn update_playlist(
        conn: &Connection,
        id: &str,
        title: &str,
        description: Option<&str>,
        cover_art_url: Option<&str>,
        tags: Option<&str>,
        listening_notes: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE playlists SET title = ?1, description = ?2, cover_art_url = ?3,
                    tags = ?4, listening_notes = ?5, updated_at = ?6
             WHERE id = ?7",
            params![title, description, cover_art_url, tags, listening_notes, now, id],
        )?;
        Ok(())
    }

    pub fn delete_playlist(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn add_tracks_to_playlist(
        conn: &mut Connection,
        playlist_id: &str,
        track_ids: &[String],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = conn.transaction()?;

        let max_pos: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        ).unwrap_or(-1);

        let mut stmt = tx.prepare(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, ?4)"
        )?;

        for (idx, tid) in track_ids.iter().enumerate() {
            let pos = max_pos + 1 + (idx as i64);
            stmt.execute(params![playlist_id, tid, pos, now])?;
        }
        drop(stmt);

        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn remove_track_from_playlist(
        conn: &mut Connection,
        playlist_id: &str,
        position: i64,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = conn.transaction()?;

        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND position = ?2",
            params![playlist_id, position],
        )?;

        // Re-index remaining tracks atomically
        let mut stmt_sel = tx.prepare(
            "SELECT id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC"
        )?;
        let row_ids: Vec<i64> = stmt_sel.query_map(params![playlist_id], |r| r.get(0))?
            .flatten()
            .collect();
        drop(stmt_sel);

        let mut stmt_upd = tx.prepare(
            "UPDATE playlist_tracks SET position = ?1 WHERE id = ?2"
        )?;
        for (new_pos, row_id) in row_ids.iter().enumerate() {
            stmt_upd.execute(params![new_pos as i64, row_id])?;
        }
        drop(stmt_upd);

        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn reorder_playlist_tracks(
        conn: &mut Connection,
        playlist_id: &str,
        track_ids: &[String],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = conn.transaction()?;

        // Atomic delete and re-insert inside explicit transaction avoids UNIQUE collision
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )?;

        let mut stmt = tx.prepare(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, ?4)"
        )?;

        for (pos, tid) in track_ids.iter().enumerate() {
            stmt.execute(params![playlist_id, tid, pos as i64, now])?;
        }
        drop(stmt);

        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;

        tx.commit()?;
        Ok(())
    }
}
