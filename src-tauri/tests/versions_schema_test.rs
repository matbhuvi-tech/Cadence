use cadence_core_lib::db::{AppDb, DbOperations, DbRelease, DbTrack};

fn make_track(
    id: &str,
    release_id: &str,
    mount_id: &str,
    file_path: &str,
    format: &str,
    sample_rate: Option<u32>,
    bit_depth: Option<u8>,
    dr_score: Option<i32>,
    is_online: bool,
) -> DbTrack {
    DbTrack {
        id: id.to_string(),
        release_id: release_id.to_string(),
        mount_id: mount_id.to_string(),
        folder_path: "D:/Music/Kind of Blue".to_string(),
        folder_name: "Kind of Blue".to_string(),
        file_path: file_path.to_string(),
        file_name: format!("{}.{}", id, format.to_lowercase()),
        file_size: 10_000_000,
        mtime: 1700000000,
        title: format!("Track {}", id),
        artist_credit: "Miles Davis".to_string(),
        album_title: "Kind of Blue".to_string(),
        release_year: Some(1959),
        track_number: Some(1),
        disc_number: Some(1),
        genre: Some("Jazz".to_string()),
        composer: None,
        duration_secs: 300.0,
        format: format.to_string(),
        sample_rate,
        bit_depth,
        channels: Some(2),
        dr_score,
        has_embedded_art: false,
        sidecar_status: "in_sync".to_string(),
        sidecar_edits_json: None,
        is_online,
        work_title: None,
        movement_number: None,
        movement_title: None,
        is_compilation: false,
        album_artist: Some("Miles Davis".to_string()),
        original_album: None,
        original_year: None,
        acoustid_fingerprint: None,
        musicbrainz_recording_id: None,
        created_at: "2026-11-09T00:00:00Z".to_string(),
    }
}

fn make_release(id: &str, title: &str, folder_path: &str, year: Option<i32>) -> DbRelease {
    DbRelease {
        id: id.to_string(),
        title: title.to_string(),
        folder_path: folder_path.to_string(),
        folder_name: title.to_string(),
        artist_credit: "Miles Davis".to_string(),
        composer_name: None,
        release_year: year,
        genre_tags: Some("Jazz".to_string()),
        front_cover_url: None,
        backdrop_url: None,
        target_folder_path: None,
        is_compilation: false,
        physical_combo_title: None,
        created_at: "2026-11-09T00:00:00Z".to_string(),
        master_album_id: None,
    }
}

#[test]
fn test_master_albums_schema_and_version_grouping() {
    let dir = std::env::temp_dir().join(format!("cadence-versions-{}", uuid::Uuid::new_v4()));
    let db_path = dir.join("cadence.db");
    let db = AppDb::new(db_path.clone()).unwrap();

    let r1 = make_release("rel-1959-mono", "Kind of Blue (Mono 24/96)", "D:/Music/KOB_1959", Some(1959));
    let r2 = make_release("rel-1986-cd", "Kind of Blue (1986 CD)", "D:/Music/KOB_1986", Some(1986));
    let r3 = make_release("rel-2013-dsd", "Kind of Blue (2013 DSD64)", "E:/External/KOB_DSD", Some(2013));

    let t1 = make_track("t1", "rel-1959-mono", "mount-local", "D:/Music/KOB_1959/01.flac", "FLAC", Some(96000), Some(24), Some(14), true);
    let t2 = make_track("t2", "rel-1986-cd", "mount-local", "D:/Music/KOB_1986/01.flac", "FLAC", Some(44100), Some(16), Some(13), true);
    let t3 = make_track("t3", "rel-2013-dsd", "mount-ext", "E:/External/KOB_DSD/01.dsf", "DSF", Some(2822400), Some(1), Some(15), true);

    {
        let mut conn = db.conn.lock();
        DbOperations::upsert_releases_batch(&mut conn, &[r1.clone(), r2.clone(), r3.clone()]).unwrap();
        DbOperations::upsert_tracks_batch(&mut conn, &[t1.clone(), t2.clone(), t3.clone()]).unwrap();

        // 1. Group the 3 releases into a master album with the 1986 CD (DR13, 16/44.1) as preferred default
        let master_id = DbOperations::group_releases_into_master(
            &mut conn,
            None,
            "Kind of Blue",
            "Miles Davis",
            &["rel-1959-mono".to_string(), "rel-1986-cd".to_string(), "rel-2013-dsd".to_string()],
            Some("rel-1986-cd".to_string()),
        )
        .unwrap();

        assert!(!master_id.is_empty());

        // 2. Query master albums: verify anti-resolution bias is honored (default is 1986 CD, not DSD)
        let master_albums = DbOperations::get_master_albums(&conn).unwrap();
        assert_eq!(master_albums.len(), 1);
        let m = &master_albums[0];
        assert_eq!(m.id, master_id);
        assert_eq!(m.canonical_title, "Kind of Blue");
        assert_eq!(m.canonical_artist, "Miles Davis");
        assert_eq!(m.default_release_id.as_deref(), Some("rel-1986-cd"));

        // 3. Query album versions: verify 3 versions and derived technical summaries
        let versions = DbOperations::get_album_versions(&conn, &master_id).unwrap();
        assert_eq!(versions.len(), 3);

        let v_cd = versions.iter().find(|v| v.release_id == "rel-1986-cd").unwrap();
        assert!(v_cd.is_default);
        assert!(v_cd.is_online);
        assert_eq!(v_cd.max_sample_rate, Some(44100));
        assert_eq!(v_cd.max_bit_depth, Some(16));
        assert_eq!(v_cd.avg_dr_score, Some(13.0));

        let v_dsd = versions.iter().find(|v| v.release_id == "rel-2013-dsd").unwrap();
        assert!(!v_dsd.is_default);
        assert!(v_dsd.is_online);
        assert_eq!(v_dsd.max_sample_rate, Some(2822400));
        assert!(v_dsd.format_summary.contains("DSF") || v_dsd.format_summary.contains("DSD"));

        // 4. Update default version to 1959 mono
        DbOperations::set_default_release_version(&mut conn, &master_id, "rel-1959-mono").unwrap();
        let versions_after_set = DbOperations::get_album_versions(&conn, &master_id).unwrap();
        let v_mono = versions_after_set.iter().find(|v| v.release_id == "rel-1959-mono").unwrap();
        assert!(v_mono.is_default);

        // 5. Offline preference retention (anti-resolution bias):
        // Disconnect mount-local (tracks become offline)
        conn.execute("UPDATE tracks SET is_online = 0 WHERE release_id = 'rel-1959-mono'", []).unwrap();
        let versions_offline = DbOperations::get_album_versions(&conn, &master_id).unwrap();
        let v_mono_offline = versions_offline.iter().find(|v| v.release_id == "rel-1959-mono").unwrap();
        assert!(!v_mono_offline.is_online);
        assert!(v_mono_offline.is_default); // Still preferred default!

        let master_still = DbOperations::get_master_albums(&conn).unwrap();
        assert_eq!(master_still[0].default_release_id.as_deref(), Some("rel-1959-mono"));

        // 6. Ungroup release: remove rel-2013-dsd from master album
        DbOperations::ungroup_release_from_master(&mut conn, "rel-2013-dsd").unwrap();
        let versions_remaining = DbOperations::get_album_versions(&conn, &master_id).unwrap();
        assert_eq!(versions_remaining.len(), 2);
        assert!(versions_remaining.iter().all(|v| v.release_id != "rel-2013-dsd"));

        // Verify rel-2013-dsd is still intact in releases table with master_album_id = NULL
        let rel_dsd: Option<String> = conn
            .query_row(
                "SELECT master_album_id FROM releases WHERE id = 'rel-2013-dsd'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rel_dsd, None);
    }
}
