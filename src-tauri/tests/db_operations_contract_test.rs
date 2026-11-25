use cadence_core_lib::db::{
    AppDb, DbOperations, DbRelease, DbSkippedFile, DbStorageMount, DbTrack, DbWatchedFolder,
};
use std::fs;
use std::path::PathBuf;

fn temp_db(label: &str) -> (PathBuf, AppDb) {
    let dir = std::env::temp_dir().join(format!(
        "cadence_db_ops_test_{}_{}",
        label,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).unwrap();
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    (dir, db)
}

fn make_mount(id: &str, name: &str, path: &str, kind: &str) -> DbStorageMount {
    DbStorageMount {
        id: id.to_string(),
        name: name.to_string(),
        mount_path: path.to_string(),
        r#type: kind.to_string(),
        file_system: "zfs".to_string(),
        total_bytes: 1_000_000_000,
        used_bytes: 250_000_000,
        is_read_only_locked: false,
        status: "online".to_string(),
        health_score: "healthy".to_string(),
        smart_ok: true,
        temp_celsius: 36.0,
        last_seen_timestamp: "2026-11-25T00:00:00Z".to_string(),
    }
}

fn make_release(id: &str, title: &str, folder_path: &str, year: Option<i32>) -> DbRelease {
    DbRelease {
        id: id.to_string(),
        title: title.to_string(),
        folder_path: folder_path.to_string(),
        folder_name: title.to_string(),
        artist_credit: "John Coltrane".to_string(),
        composer_name: None,
        release_year: year,
        genre_tags: Some("Jazz".to_string()),
        front_cover_url: None,
        backdrop_url: None,
        target_folder_path: None,
        is_compilation: false,
        physical_combo_title: None,
        is_favorite: false,
        created_at: "2026-11-25T00:00:00Z".to_string(),
        master_album_id: None,
    }
}

fn make_track(id: &str, release_id: &str, mount_id: &str, folder: &str, online: bool) -> DbTrack {
    DbTrack {
        id: id.to_string(),
        release_id: release_id.to_string(),
        mount_id: mount_id.to_string(),
        folder_path: folder.to_string(),
        folder_name: "Blue Train".to_string(),
        file_path: format!("{folder}/{id}.flac"),
        file_name: format!("{id}.flac"),
        file_size: 42_000_000,
        mtime: 1700000000,
        title: format!("Title {id}"),
        artist_credit: "John Coltrane".to_string(),
        album_title: "Blue Train".to_string(),
        release_year: Some(1957),
        track_number: Some(1),
        disc_number: Some(1),
        genre: Some("Jazz".to_string()),
        composer: None,
        duration_secs: 643.0,
        format: "FLAC".to_string(),
        sample_rate: Some(192_000),
        bit_depth: Some(24),
        channels: Some(2),
        dr_score: Some(12),
        has_embedded_art: true,
        sidecar_status: "in_sync".to_string(),
        sidecar_edits_json: None,
        is_online: online,
        work_title: None,
        movement_number: None,
        movement_title: None,
        is_compilation: false,
        album_artist: Some("John Coltrane".to_string()),
        original_album: None,
        original_year: None,
        acoustid_fingerprint: None,
        musicbrainz_recording_id: None,
        created_at: "2026-11-25T00:00:00Z".to_string(),
    }
}

#[test]
fn storage_mounts_and_watched_folders_crud() {
    let (dir, db) = temp_db("mounts_folders");
    let conn = db.conn.lock();

    let mount = make_mount("mnt_1", "NAS Library", "/mnt/music", "nas");
    DbOperations::upsert_storage_mount(&conn, &mount).unwrap();
    let mounts = DbOperations::get_storage_mounts(&conn).unwrap();
    assert_eq!(mounts.len(), 1);
    assert_eq!(mounts[0].status, "online");

    DbOperations::set_mount_status(&conn, "mnt_1", "offline").unwrap();
    let locked = DbOperations::toggle_mount_lock(&conn, "mnt_1").unwrap();
    assert!(locked);
    let updated = DbOperations::get_storage_mounts(&conn).unwrap();
    assert_eq!(updated[0].status, "offline");
    assert!(updated[0].is_read_only_locked);

    let folder = DbWatchedFolder {
        id: "wf_1".to_string(),
        mount_id: "mnt_1".to_string(),
        folder_path: "/mnt/music/Jazz".to_string(),
        display_name: "Jazz".to_string(),
        scan_mode: "recursive".to_string(),
        ignore_patterns: None,
        is_enabled: true,
        last_scanned_timestamp: None,
        track_count: Some(0),
    };
    DbOperations::upsert_watched_folder(&conn, &folder).unwrap();
    assert_eq!(DbOperations::get_watched_folders(&conn).unwrap().len(), 1);

    DbOperations::delete_watched_folder(&conn, "wf_1").unwrap();
    assert!(DbOperations::get_watched_folders(&conn).unwrap().is_empty());

    DbOperations::delete_storage_mount(&conn, "mnt_1").unwrap();
    assert!(DbOperations::get_storage_mounts(&conn).unwrap().is_empty());

    drop(conn);
    drop(db);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn releases_tracks_version_grouping_and_pruning() {
    let (dir, db) = temp_db("releases_tracks_grouping");
    let mut conn = db.conn.lock();

    let mount = make_mount("mnt_1", "Music", "/music", "local");
    DbOperations::upsert_storage_mount(&conn, &mount).unwrap();

    let r1 = make_release("rel_cd", "Blue Train", "/music/BlueTrain-CD", Some(1957));
    let r2 = make_release("rel_hires", "Blue Train", "/music/BlueTrain-24-192", Some(2014));
    let r_empty = make_release("rel_empty", "Empty Folder", "/music/Empty", Some(2020));
    DbOperations::upsert_releases_batch(&mut conn, &[r1, r2, r_empty]).unwrap();

    let t1 = make_track("trk_1", "rel_cd", "mnt_1", "/music/BlueTrain-CD", true);
    let t2 = make_track("trk_2", "rel_hires", "mnt_1", "/music/BlueTrain-24-192", false);
    DbOperations::upsert_tracks_batch(&mut conn, &[t1, t2]).unwrap();

    let (tracks_total, releases_total, _, _) = DbOperations::get_library_counts(&conn).unwrap();
    assert_eq!(tracks_total, 2);
    assert_eq!(releases_total, 3);

    let (offline_tracks, _) = DbOperations::get_offline_counts(&conn).unwrap();
    assert_eq!(offline_tracks, 1);

    // Group two editions into a single master album and toggle default version
    let master_id = DbOperations::group_releases_into_master(
        &mut conn,
        None,
        "Blue Train",
        "John Coltrane",
        &["rel_cd".to_string(), "rel_hires".to_string()],
        Some("rel_cd".to_string()),
    )
    .unwrap();
    assert_eq!(DbOperations::get_master_albums(&conn).unwrap().len(), 1);
    let versions = DbOperations::get_album_versions(&conn, &master_id).unwrap();
    assert_eq!(versions.len(), 2);

    DbOperations::set_default_release_version(&mut conn, &master_id, "rel_hires").unwrap();
    DbOperations::ungroup_release_from_master(&mut conn, "rel_cd").unwrap();

    // Prune release that has zero tracks
    let pruned = DbOperations::prune_empty_releases_in_folder(&conn, "/music").unwrap();
    assert_eq!(pruned, 1);
    assert_eq!(DbOperations::get_releases(&conn, None).unwrap().len(), 2);

    drop(conn);
    drop(db);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn transaction_rollback_leaves_database_unchanged_and_skipped_files_work() {
    let (dir, db) = temp_db("tx_rollback_and_skipped");
    let mut conn = db.conn.lock();

    // Explicit transaction rollback leaves zero persisted rows
    {
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
             VALUES ('mnt_rolled_back', 'Temp', '/tmp', 'local', 'ext4', '2026-11-25T00:00:00Z')",
            [],
        )
        .unwrap();
        tx.rollback().unwrap();
    }
    assert!(DbOperations::get_storage_mounts(&conn).unwrap().is_empty());

    // Skipped files lifecycle
    let skipped = DbSkippedFile {
        id: "skip_1".to_string(),
        file_path: "/music/corrupt/bad.flac".to_string(),
        file_name: "bad.flac".to_string(),
        category: "corrupt_header".to_string(),
        diagnostic_error: "Unexpected EOF".to_string(),
        timestamp: "2026-11-25T00:00:00Z".to_string(),
        is_ignored: false,
        mtime: 1700000000,
    };
    DbOperations::add_skipped_file(&conn, &skipped).unwrap();
    assert_eq!(DbOperations::get_skipped_files(&conn).unwrap().len(), 1);

    DbOperations::ignore_skipped_file(&conn, "skip_1").unwrap();
    assert_eq!(DbOperations::get_ignored_skipped_files(&conn).unwrap().len(), 1);

    DbOperations::remove_skipped_file_by_path(&conn, "/music/corrupt/bad.flac").unwrap();
    assert!(DbOperations::get_skipped_files(&conn).unwrap().is_empty());

    assert_eq!(
        DbOperations::normalize_artist_alias("A. R. Rahman"),
        DbOperations::normalize_artist_alias("a.r. rahman")
    );

    drop(conn);
    drop(db);
    let _ = fs::remove_dir_all(&dir);
}
