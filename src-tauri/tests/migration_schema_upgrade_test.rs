use cadence_core_lib::core_runtime::migration::{
    export_consistent_snapshot, map_path_with_roots, MigrationError, RootMapping,
};
use cadence_core_lib::db::AppDb;
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cadence_migration_test_{}_{}",
        label,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn upgrades_legacy_minimal_schema_without_losing_rows() {
    let dir = temp_dir("legacy_upgrade");
    let db_path = dir.join("cadence.db");

    // Seed a historical minimal SQLite schema missing newer columns/tables
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "
            CREATE TABLE storage_mounts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                mount_path TEXT NOT NULL,
                mount_type TEXT NOT NULL,
                file_system TEXT NOT NULL,
                last_seen_timestamp TEXT NOT NULL
            );
            CREATE TABLE releases (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                folder_name TEXT NOT NULL,
                artist_credit TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE tracks (
                id TEXT PRIMARY KEY,
                release_id TEXT NOT NULL,
                mount_id TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                folder_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                title TEXT NOT NULL,
                artist_credit TEXT NOT NULL,
                album_title TEXT NOT NULL,
                duration_secs REAL NOT NULL,
                format TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO storage_mounts VALUES ('m1', 'NAS', '/music', 'nas', 'zfs', '2025-01-01T00:00:00Z');
            INSERT INTO releases VALUES ('r1', 'Legacy Album', '/music/Legacy', 'Legacy', 'Legacy Artist', '2025-01-01T00:00:00Z');
            INSERT INTO tracks VALUES ('t1', 'r1', 'm1', '/music/Legacy', 'Legacy', '/music/Legacy/01.flac', '01.flac', 1024, 1700000000, 'Opening', 'Legacy Artist', 'Legacy Album', 180.0, 'FLAC', '2025-01-01T00:00:00Z');
            ",
        )
        .unwrap();
    }

    // Opening with AppDb::new must apply all schema migrations non-destructively
    let db = AppDb::new(db_path.clone()).expect("AppDb::new must upgrade legacy schema");
    let conn = db.conn.lock();

    let track_title: String = conn
        .query_row("SELECT title FROM tracks WHERE id = 't1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(track_title, "Opening");

    // Newer columns and tables must now exist
    let master_table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='master_albums'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(master_table_exists, 1);

    let identity_table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='curate_identity_editions'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(identity_table_exists, 1);

    drop(conn);
    drop(db);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn map_path_with_roots_prefers_longest_prefix_and_normalizes_separators() {
    let mappings = vec![
        RootMapping {
            windows_prefix: r"\\192.168.1.6\Music".to_string(),
            core_prefix: "/mnt/music".to_string(),
        },
        RootMapping {
            windows_prefix: r"\\192.168.1.6\Music\Master".to_string(),
            core_prefix: "/mnt/master".to_string(),
        },
    ];

    let (mapped, matched) = map_path_with_roots(
        r"\\192.168.1.6\Music\Master\Jazz\KindOfBlue.flac",
        &mappings,
    )
    .expect("should match longest prefix");
    assert_eq!(mapped, "/mnt/master/Jazz/KindOfBlue.flac");
    assert_eq!(matched.core_prefix, "/mnt/master");

    assert!(map_path_with_roots(r"E:\Unmapped\Track.wav", &mappings).is_none());
}

#[test]
fn export_consistent_snapshot_rejects_missing_source() {
    let dir = temp_dir("missing_source");
    let err = export_consistent_snapshot(&dir.join("does_not_exist.db"), &dir.join("out.db"))
        .expect_err("missing source db must fail");
    assert!(matches!(err, MigrationError::InvalidPath(_)));
    let _ = fs::remove_dir_all(&dir);
}
