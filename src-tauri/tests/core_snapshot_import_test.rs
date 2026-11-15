use cadence_core_lib::core_runtime::migration::{
    export_consistent_snapshot, import_snapshot_into_core, preview_snapshot_import,
    rollback_snapshot_import, RootMapping, SnapshotImportOptions, SnapshotImportPreview,
    SnapshotImportResult,
};
use cadence_core_lib::db::AppDb;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cadence_phase9_{}_{}",
        name,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn seed_windows_source_db(db_path: &Path) -> AppDb {
    let db = AppDb::new(db_path.to_path_buf()).unwrap();
    let conn = db.conn.lock();
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES ('mnt-nas', 'TrueNAS', '\\\\192.168.1.6\\Mathan\\Music Collection', 'smb', 'zfs', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES ('mnt-local', 'Windows E', 'E:\\Mathan\\Music', 'local_disk', 'ntfs', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, is_favorite, created_at)
         VALUES ('rel-nas', 'Bombay', '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman\\Bombay', 'Bombay', 'A. R. Rahman', 1, '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, sidecar_status, created_at)
         VALUES ('trk-nas-1', 'rel-nas', 'mnt-nas', '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman\\Bombay', 'Bombay', '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman\\Bombay\\01_Tu_Hi_Re.flac', '01_Tu_Hi_Re.flac', 4096, 1, 'Tu Hi Re', 'A. R. Rahman', 'Bombay', 430.0, 'FLAC', 'pending_commit', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, sidecar_status, created_at)
         VALUES ('trk-nas-case', 'rel-nas', 'mnt-nas', '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman\\Bombay', 'Bombay', '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman\\Bombay\\02_kehna.flac', '02_kehna.flac', 4096, 1, 'Kehna Hi Kya', 'A. R. Rahman', 'Bombay', 350.0, 'FLAC', 'in_sync', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, sidecar_status, created_at)
         VALUES ('trk-win-local', 'rel-nas', 'mnt-local', 'E:\\Mathan\\Music\\DSD', 'DSD', 'E:\\Mathan\\Music\\DSD\\Sweep.dsf', 'Sweep.dsf', 8192, 1, 'DSD Sweep', 'Test', 'Test', 60.0, 'DSF', 'in_sync', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO playlists (id, title, description, created_at, updated_at)
         VALUES ('pl-1', 'Evening Favorites', 'Imported playlist', '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
         VALUES ('pl-1', 'trk-nas-1', 0, '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO curate_identity_editions (id, anchor, status, revision)
         VALUES ('ed-1', 'bombay_anchor', 'user_confirmed', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO curation_drafts (album_id, draft_json, updated_at)
         VALUES ('rel-nas', '{\"title\":\"Tu Hi Re (Master)\"}', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    // Pending Windows commit batch — MUST NOT replay or activate on Core after import
    conn.execute(
        "INSERT INTO commit_queue_batches (id, description, total_tracks, destination, status, created_at)
         VALUES ('batch-pending-1', 'Pending Windows Tag Write', 1, 'embedded', 'pending', '2026-11-15T00:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO commit_queue_items (id, batch_id, track_id, file_path, mount_id, payload_json, backup_json, status)
         VALUES ('item-1', 'batch-pending-1', 'trk-nas-1', '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman\\Bombay\\01_Tu_Hi_Re.flac', 'mnt-nas', '{\"title\":\"Should Not Replay\"}', '{}', 'pending')",
        [],
    )
    .unwrap();
    drop(conn);
    db
}

#[test]
fn live_wal_consistent_snapshot_captures_committed_state_without_mutating_source() {
    let dir = temp_dir("wal_snapshot");
    let source_db_path = dir.join("win_cadence.db");
    let snapshot_path = dir.join("win_snapshot.db");

    let db = seed_windows_source_db(&source_db_path);
    // Write an uncheckpointed WAL transaction before taking snapshot
    {
        let conn = db.conn.lock();
        conn.execute(
            "UPDATE tracks SET title = 'Tu Hi Re [WAL Committed]' WHERE id = 'trk-nas-1'",
            [],
        )
        .unwrap();
    }
    let before_count: i64 = {
        let conn = db.conn.lock();
        conn.query_row("SELECT count(*) FROM tracks", [], |r| r.get(0))
            .unwrap()
    };

    export_consistent_snapshot(&source_db_path, &snapshot_path).unwrap();

    // Source remains untouched and readable while snapshot captures WAL update
    let snap_conn = Connection::open(&snapshot_path).unwrap();
    let snap_title: String = snap_conn
        .query_row("SELECT title FROM tracks WHERE id = 'trk-nas-1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(snap_title, "Tu Hi Re [WAL Committed]");
    let snap_count: i64 = snap_conn
        .query_row("SELECT count(*) FROM tracks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(snap_count, before_count);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn preview_detects_case_sensitive_mappings_missing_roots_and_ambiguous_paths() {
    let dir = temp_dir("preview");
    let source_db_path = dir.join("win.db");
    let snapshot_path = dir.join("snap.db");
    let core_music_root = dir.join("music_root");

    // Populate target files on disk, intentionally omitting `02_kehna.flac` vs `02_Kehna.flac`
    // and checking exact Linux-style component matching
    let album_dir = core_music_root.join("Master/Hindi/A R Rahman/Bombay");
    fs::create_dir_all(&album_dir).unwrap();
    fs::write(album_dir.join("01_Tu_Hi_Re.flac"), b"FLAC1").unwrap();
    fs::write(album_dir.join("02_Kehna.flac"), b"FLAC2_UPPER").unwrap();

    let _ = seed_windows_source_db(&source_db_path);
    export_consistent_snapshot(&source_db_path, &snapshot_path).unwrap();

    let mappings = vec![RootMapping {
        windows_prefix: "\\\\192.168.1.6\\Mathan\\Music Collection".to_string(),
        core_prefix: core_music_root.to_string_lossy().to_string(),
    }];

    let preview = preview_snapshot_import(&snapshot_path, &mappings, true).unwrap();
    assert_eq!(preview.total_source_tracks, 3);
    assert_eq!(preview.mapped_tracks.len(), 1);
    assert_eq!(preview.mapped_tracks[0].track_id, "trk-nas-1");
    assert_eq!(preview.unmapped_roots.len(), 1);
    assert_eq!(preview.unmapped_roots[0], "E:\\Mathan\\Music\\DSD\\Sweep.dsf");
    assert_eq!(preview.case_mismatches.len(), 1);
    assert!(preview.case_mismatches[0].contains("02_kehna.flac"));
    assert_eq!(preview.suppressed_pending_jobs, 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn import_preserves_identities_playlists_drafts_suppresses_pending_writes_and_supports_rollback() {
    let dir = temp_dir("import_rollback");
    let source_db_path = dir.join("win.db");
    let snapshot_path = dir.join("snap.db");
    let core_db_path = dir.join("core_cadence.db");
    let rollback_dir = dir.join("rollback");
    let core_music_root = dir.join("music_root");

    let album_dir = core_music_root.join("Master/Hindi/A R Rahman/Bombay");
    fs::create_dir_all(&album_dir).unwrap();
    fs::write(album_dir.join("01_Tu_Hi_Re.flac"), b"FLAC1").unwrap();

    let _ = seed_windows_source_db(&source_db_path);
    export_consistent_snapshot(&source_db_path, &snapshot_path).unwrap();

    // Seed pre-existing track in Core DB so we can verify rollback restores prior state
    {
        let core_db = AppDb::new(core_db_path.clone()).unwrap();
        let conn = core_db.conn.lock();
        conn.execute(
            "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
             VALUES ('mnt-orig', 'Orig', '/music', 'local_disk', 'ext4', '2026-11-15T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
             VALUES ('rel-orig', 'Original Core Album', '/music/Orig', 'Orig', 'Orig Artist', '2026-11-15T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, created_at)
             VALUES ('trk-orig', 'rel-orig', 'mnt-orig', '/music/Orig', 'Orig', '/music/Orig/track.flac', 'track.flac', 100, 1, 'Original Track', 'Orig Artist', 'Original Core Album', 100.0, 'FLAC', '2026-11-15T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    let mappings = vec![RootMapping {
        windows_prefix: "\\\\192.168.1.6\\Mathan\\Music Collection".to_string(),
        core_prefix: core_music_root.to_string_lossy().to_string(),
    }];

    let result = import_snapshot_into_core(
        &snapshot_path,
        &core_db_path,
        &rollback_dir,
        SnapshotImportOptions {
            mappings,
            enforce_case_sensitive: true,
            include_unmapped: false,
            rollback_tag: "pre-import-1".to_string(),
        },
    )
    .unwrap();

    assert_eq!(result.imported_tracks, 1);
    assert_eq!(result.imported_playlists, 1);
    assert_eq!(result.imported_drafts, 1);
    assert_eq!(result.suppressed_pending_jobs, 1);
    assert!(result.rollback_snapshot_path.is_file());

    // Verify imported data in Core DB
    let core_conn = Connection::open(&core_db_path).unwrap();
    let mapped_path: String = core_conn
        .query_row("SELECT file_path FROM tracks WHERE id = 'trk-nas-1'", [], |r| r.get(0))
        .unwrap();
    assert!(mapped_path.ends_with("01_Tu_Hi_Re.flac"));
    let sidecar_status: String = core_conn
        .query_row("SELECT sidecar_status FROM tracks WHERE id = 'trk-nas-1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sidecar_status, "in_sync");

    let playlist_name: String = core_conn
        .query_row("SELECT title FROM playlists WHERE id = 'pl-1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(playlist_name, "Evening Favorites");

    let draft_count: i64 = core_conn
        .query_row("SELECT count(*) FROM curation_drafts WHERE album_id = 'rel-nas'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(draft_count, 1);

    // Imported historical commit queue items MUST be marked archived, NEVER pending
    let pending_items: i64 = core_conn
        .query_row(
            "SELECT count(*) FROM commit_queue_items WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending_items, 0);
    drop(core_conn);

    // Rollback restores original Core DB cleanly
    rollback_snapshot_import(&core_db_path, &result.rollback_snapshot_path).unwrap();
    let rolled_conn = Connection::open(&core_db_path).unwrap();
    let orig_count: i64 = rolled_conn
        .query_row("SELECT count(*) FROM tracks WHERE id = 'trk-orig'", [], |r| r.get(0))
        .unwrap();
    let nas_count: i64 = rolled_conn
        .query_row("SELECT count(*) FROM tracks WHERE id = 'trk-nas-1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orig_count, 1);
    assert_eq!(nas_count, 0);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cli_snapshot_export_preview_import_and_rollback_roundtrip() {
    let dir = temp_dir("cli_roundtrip");
    let source_db_path = dir.join("win.db");
    let snapshot_path = dir.join("snap.db");
    let app_data_dir = dir.join("core_app_data");
    let core_db_path = app_data_dir.join("cadence.db");
    let core_music_root = dir.join("music_root");

    let album_dir = core_music_root.join("Master/Hindi/A R Rahman/Bombay");
    fs::create_dir_all(&album_dir).unwrap();
    fs::write(album_dir.join("01_Tu_Hi_Re.flac"), b"FLAC1").unwrap();

    fs::create_dir_all(&app_data_dir).unwrap();
    {
        let core_db = AppDb::new(core_db_path.clone()).unwrap();
        let conn = core_db.conn.lock();
        conn.execute(
            "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
             VALUES ('mnt-orig', 'Core', '/music', 'local_disk', 'ext4', '2026-11-15T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
             VALUES ('rel-orig', 'Original', '/music/Orig', 'Orig', 'Artist', '2026-11-15T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, created_at)
             VALUES ('trk-orig', 'rel-orig', 'mnt-orig', '/music/Orig', 'Orig', '/music/Orig/track.flac', 'track.flac', 100, 1, 'Orig Track', 'Artist', 'Original', 100.0, 'FLAC', '2026-11-15T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    let _source_db = seed_windows_source_db(&source_db_path);
    let exe = env!("CARGO_BIN_EXE_cadence-headless");
    let map_arg = format!(
        "\\\\192.168.1.6\\Mathan\\Music Collection={}",
        core_music_root.display()
    );

    let export_out = Command::new(exe)
        .arg("--export-snapshot")
        .arg(&source_db_path)
        .arg(&snapshot_path)
        .output()
        .unwrap();
    assert!(
        export_out.status.success(),
        "export failed: {}",
        String::from_utf8_lossy(&export_out.stderr)
    );
    assert!(snapshot_path.is_file());

    let preview_out = Command::new(exe)
        .arg("--preview-import")
        .arg(&snapshot_path)
        .arg("--map-root")
        .arg(&map_arg)
        .output()
        .unwrap();
    assert!(
        preview_out.status.success(),
        "preview failed: {}",
        String::from_utf8_lossy(&preview_out.stderr)
    );
    let preview: SnapshotImportPreview = serde_json::from_slice(&preview_out.stdout).unwrap();
    assert_eq!(preview.mapped_tracks.len(), 1);
    assert_eq!(preview.suppressed_pending_jobs, 1);

    let import_out = Command::new(exe)
        .arg("--import-snapshot")
        .arg(&snapshot_path)
        .arg("--app-data-dir")
        .arg(&app_data_dir)
        .arg("--map-root")
        .arg(&map_arg)
        .arg("--rollback-tag")
        .arg("cli-pre-import")
        .output()
        .unwrap();
    assert!(
        import_out.status.success(),
        "import failed: {}",
        String::from_utf8_lossy(&import_out.stderr)
    );
    let result: SnapshotImportResult = serde_json::from_slice(&import_out.stdout).unwrap();
    assert_eq!(result.imported_tracks, 1);
    assert_eq!(result.imported_playlists, 1);
    assert_eq!(result.imported_drafts, 1);
    assert_eq!(result.suppressed_pending_jobs, 1);

    let rollback_out = Command::new(exe)
        .arg("--rollback-import")
        .arg(&result.rollback_snapshot_path)
        .arg("--app-data-dir")
        .arg(&app_data_dir)
        .output()
        .unwrap();
    assert!(
        rollback_out.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback_out.stderr)
    );

    let rolled_conn = Connection::open(&core_db_path).unwrap();
    let orig_count: i64 = rolled_conn
        .query_row("SELECT count(*) FROM tracks WHERE id = 'trk-orig'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orig_count, 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn import_handles_legacy_playlist_tracks_table_without_id_column() {
    let dir = temp_dir("legacy_playlist_schema");
    let source_db_path = dir.join("win.db");
    let export_db = dir.join("legacy-export.db");
    let core_db_path = dir.join("core.db");
    let rollback_dir = dir.join("rollback");
    let music_root = dir.join("music_root");
    fs::create_dir_all(&rollback_dir).unwrap();
    fs::create_dir_all(&music_root).unwrap();

    let _source_db = seed_windows_source_db(&source_db_path);
    export_consistent_snapshot(&source_db_path, &export_db).unwrap();

    // Recreate playlist_tracks using legacy composite PRIMARY KEY without an `id` column
    let exp_conn = Connection::open(&export_db).unwrap();
    exp_conn
        .execute_batch(
            "CREATE TABLE playlist_tracks_legacy (
                playlist_id TEXT NOT NULL,
                track_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                added_at TEXT NOT NULL,
                PRIMARY KEY (playlist_id, position)
            );
            INSERT INTO playlist_tracks_legacy (playlist_id, track_id, position, added_at)
            SELECT playlist_id, track_id, position, added_at FROM playlist_tracks;
            DROP TABLE playlist_tracks;
            ALTER TABLE playlist_tracks_legacy RENAME TO playlist_tracks;",
        )
        .unwrap();
    drop(exp_conn);

    let result = import_snapshot_into_core(
        &export_db,
        &core_db_path,
        &rollback_dir,
        SnapshotImportOptions {
            mappings: vec![RootMapping {
                windows_prefix: "\\\\192.168.1.6\\Mathan\\Music Collection".into(),
                core_prefix: music_root.to_string_lossy().to_string(),
            }],
            enforce_case_sensitive: false,
            include_unmapped: false,
            rollback_tag: "pre-legacy-import".into(),
        },
    )
    .expect("import must succeed when source playlist_tracks has no id column");
    assert_eq!(result.imported_playlists, 1);

    let dst = Connection::open(&core_db_path).unwrap();
    let count: i64 = dst
        .query_row(
            "SELECT count(*) FROM playlist_tracks WHERE playlist_id = 'pl-1' AND track_id = 'trk-nas-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);

    let _ = fs::remove_dir_all(&dir);
}
