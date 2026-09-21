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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMtimeCheck {
    pub file_path: String,
    pub mtime: i64,
    pub file_size: i64,
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
        conn.execute("DELETE FROM storage_mounts WHERE id = ?1", params![mount_id])?;
        Ok(())
    }

    // Watched Folders
    pub fn get_watched_folders(conn: &Connection) -> Result<Vec<DbWatchedFolder>> {
        let mut stmt = conn.prepare(
            "SELECT id, mount_id, folder_path, display_name, scan_mode, ignore_patterns, is_enabled, last_scanned_timestamp
             FROM watched_folders ORDER BY folder_path ASC",
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
            })
        })?;

        let mut folders = Vec::new();
        for r in rows {
            folders.push(r?);
        }
        Ok(folders)
    }

    pub fn upsert_watched_folder(conn: &Connection, folder: &DbWatchedFolder) -> Result<()> {
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
                folder.id,
                folder.mount_id,
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
    pub fn get_releases(conn: &Connection) -> Result<Vec<DbRelease>> {
        let mut stmt = conn.prepare(
            "SELECT id, title, folder_path, folder_name, artist_credit, composer_name,
                    release_year, genre_tags, front_cover_url, backdrop_url, target_folder_path, created_at
             FROM releases ORDER BY title ASC",
        )?;

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
                created_at: row.get(11)?,
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
                    release_year, genre_tags, front_cover_url, backdrop_url, target_folder_path, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    folder_path=excluded.folder_path,
                    folder_name=excluded.folder_name,
                    artist_credit=excluded.artist_credit,
                    composer_name=excluded.composer_name,
                    release_year=excluded.release_year,
                    genre_tags=excluded.genre_tags,
                    front_cover_url=excluded.front_cover_url,
                    backdrop_url=excluded.backdrop_url,
                    target_folder_path=excluded.target_folder_path",
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
                    rel.created_at,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // Tracks
    pub fn get_tracks(conn: &Connection, limit: Option<i64>, offset: Option<i64>) -> Result<Vec<DbTrack>> {
        let sql = match (limit, offset) {
            (Some(l), Some(o)) => format!(
                "SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                        file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                        genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                        dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                        work_title, movement_number, movement_title, created_at
                 FROM tracks ORDER BY album_title ASC, track_number ASC LIMIT {} OFFSET {}",
                l, o
            ),
            (Some(l), None) => format!(
                "SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                        file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                        genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                        dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                        work_title, movement_number, movement_title, created_at
                 FROM tracks ORDER BY album_title ASC, track_number ASC LIMIT {}",
                l
            ),
            _ => "SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                        file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                        genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                        dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                        work_title, movement_number, movement_title, created_at
                 FROM tracks ORDER BY album_title ASC, track_number ASC".to_string(),
        };

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
                created_at: row.get(29)?,
            })
        })?;

        let mut tracks = Vec::new();
        for r in rows {
            tracks.push(r?);
        }
        Ok(tracks)
    }

    pub fn upsert_tracks_batch(conn: &mut Connection, tracks: &[DbTrack]) -> Result<()> {
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO tracks (
                    id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                    file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                    genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                    dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                    work_title, movement_number, movement_title, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                          ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)
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
                    movement_title=excluded.movement_title",
            )?;

            for t in tracks {
                stmt.execute(params![
                    t.id,
                    t.release_id,
                    t.mount_id,
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
                    t.created_at,
                ])?;
            }
        }
        tx.commit()?;
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
            "SELECT id, file_path, file_name, category, diagnostic_error, timestamp, is_ignored
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
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn add_skipped_file(conn: &Connection, file: &DbSkippedFile) -> Result<()> {
        conn.execute(
            "INSERT INTO skipped_files (id, file_path, file_name, category, diagnostic_error, timestamp, is_ignored)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(file_path) DO UPDATE SET
                diagnostic_error=excluded.diagnostic_error,
                timestamp=excluded.timestamp,
                category=excluded.category",
            params![
                file.id,
                file.file_path,
                file.file_name,
                file.category,
                file.diagnostic_error,
                file.timestamp,
                if file.is_ignored { 1 } else { 0 },
            ],
        )?;
        Ok(())
    }

    pub fn ignore_skipped_file(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("UPDATE skipped_files SET is_ignored = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn delete_skipped_file(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM skipped_files WHERE id = ?1", params![id])?;
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
}
