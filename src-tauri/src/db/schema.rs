use rusqlite::{Connection, Result};

pub fn initialize_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS storage_mounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mount_path TEXT NOT NULL UNIQUE,
            mount_type TEXT NOT NULL,
            file_system TEXT NOT NULL,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            used_bytes INTEGER NOT NULL DEFAULT 0,
            is_readonly_locked INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'online',
            health_score TEXT NOT NULL DEFAULT 'healthy',
            smart_ok INTEGER NOT NULL DEFAULT 1,
            temp_celsius REAL NOT NULL DEFAULT 35.0,
            last_seen_timestamp TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS watched_folders (
            id TEXT PRIMARY KEY,
            mount_id TEXT NOT NULL,
            folder_path TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            scan_mode TEXT NOT NULL DEFAULT 'realtime',
            ignore_patterns TEXT,
            is_enabled INTEGER NOT NULL DEFAULT 1,
            last_scanned_timestamp TEXT,
            FOREIGN KEY(mount_id) REFERENCES storage_mounts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS releases (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            folder_name TEXT NOT NULL,
            artist_credit TEXT NOT NULL,
            composer_name TEXT,
            release_year INTEGER,
            genre_tags TEXT,
            front_cover_url TEXT,
            backdrop_url TEXT,
            target_folder_path TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            release_id TEXT NOT NULL,
            mount_id TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            folder_name TEXT NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            title TEXT NOT NULL,
            artist_credit TEXT NOT NULL,
            album_title TEXT NOT NULL,
            release_year INTEGER,
            track_number INTEGER,
            genre TEXT,
            composer TEXT,
            duration_secs REAL NOT NULL DEFAULT 0.0,
            format TEXT NOT NULL,
            sample_rate INTEGER,
            bit_depth INTEGER,
            channels INTEGER,
            dr_score INTEGER,
            has_embedded_art INTEGER NOT NULL DEFAULT 0,
            sidecar_status TEXT NOT NULL DEFAULT 'in_sync',
            sidecar_edits_json TEXT,
            is_online INTEGER NOT NULL DEFAULT 1,
            work_title TEXT,
            movement_number TEXT,
            movement_title TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE,
            FOREIGN KEY(mount_id) REFERENCES storage_mounts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS skipped_files (
            id TEXT PRIMARY KEY,
            file_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            category TEXT NOT NULL,
            diagnostic_error TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            is_ignored INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS scan_history (
            id TEXT PRIMARY KEY,
            folder_path TEXT NOT NULL,
            start_timestamp TEXT NOT NULL,
            end_timestamp TEXT,
            total_discovered INTEGER NOT NULL DEFAULT 0,
            imported_count INTEGER NOT NULL DEFAULT 0,
            updated_count INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            duration_secs REAL NOT NULL DEFAULT 0.0,
            status TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
        CREATE INDEX IF NOT EXISTS idx_tracks_mount_id ON tracks(mount_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_release_id ON tracks(release_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_mtime ON tracks(mtime);
        CREATE INDEX IF NOT EXISTS idx_releases_folder_path ON releases(folder_path);
        CREATE INDEX IF NOT EXISTS idx_watched_folders_mount ON watched_folders(mount_id);
        "
    )?;

    Ok(())
}
