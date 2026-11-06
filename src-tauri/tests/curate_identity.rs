use cadence_core_lib::db::{AppDb, DbOperations, DbTrack};
#[test]
fn mappings_and_manual_field_revisions_survive_restart_and_ignore_stale_evidence() {
    use cadence_core_lib::curation::CurationStorage;
    let dir = std::env::temp_dir().join(format!("cadence-mapping-{}", uuid::Uuid::new_v4()));
    let path = dir.join("cadence.db");
    let db = AppDb::new(path.clone()).unwrap();
    let mut song = track("one", "album", "library/Harbor Lights", "one.flac", 1);
    {
        let mut conn = db.conn.lock();
        conn.execute(
            "INSERT INTO releases (id,title,folder_path,folder_name,artist_credit,created_at)
             VALUES ('album','Harbor Lights','library/Harbor Lights','Harbor Lights','Various Artists','2026-11-06')",
            [],
        ).unwrap();
        DbOperations::upsert_tracks_batch(&mut conn, &[song.clone()]).unwrap();
    }
    let ids = ["one".to_string()];
    let before = CurationStorage::get_identity(&db, &ids).unwrap();
    let make_run = |id: &str,
                    time: &str,
                    snapshot: &[serde_json::Value],
                    provider_track: Option<&str>| {
        json!({
            "id": id, "requestedAt": time, "completedAt": time, "outcome": "completed", "trigger": "user_refresh",
            "identity": snapshot,
            "identityMappings": [{
                "localTrackId": "one", "provider": "musicbrainz", "releaseId": "mb-edition",
                "providerTrackId": provider_track, "providerPosition": provider_track.map(|_| 1),
                "method": if provider_track.is_some() { "title" } else { "none" },
                "positional": false, "status": if provider_track.is_some() { "inferred" } else { "unmapped" },
            }],
            "decision": {"albumId": "album", "outcomeStatus": "evaluated_unchanged", "headlineSummary": "Fixture result"},
        })
    };
    let first = make_run(
        "first",
        "2026-11-06T10:00:00Z",
        &before,
        Some("recording-1"),
    );
    CurationStorage::save_evidence(&db, "album", &first).unwrap();
    let persisted = CurationStorage::get_evidence(&db, "album", "first")
        .unwrap()
        .unwrap();
    assert_eq!(persisted["mappingRevisions"][0]["mappingRev"], 1);

    let identical = make_run(
        "identical",
        "2026-11-06T10:01:00Z",
        &before,
        Some("recording-1"),
    );
    CurationStorage::save_evidence(&db, "album", &identical).unwrap();
    let persisted = CurationStorage::get_evidence(&db, "album", "identical")
        .unwrap()
        .unwrap();
    assert_eq!(persisted["mappingRevisions"][0]["mappingRev"], 1);

    let draft = json!({"fields": {"genre": {"selected": "New genre", "userOverridden": true}}});
    CurationStorage::save_draft(&db, "album", &draft).unwrap();
    CurationStorage::save_draft(&db, "album", &draft).unwrap();
    song.track_number = Some(2);
    DbOperations::upsert_tracks_batch(&mut db.conn.lock(), &[song]).unwrap();

    let stale = make_run(
        "stale",
        "2026-11-06T10:02:00Z",
        &before,
        Some("stale-recording"),
    );
    CurationStorage::save_evidence(&db, "album", &stale).unwrap();
    let persisted = CurationStorage::get_evidence(&db, "album", "stale")
        .unwrap()
        .unwrap();
    assert!(persisted.get("mappingRevisions").is_none());

    let after = CurationStorage::get_identity(&db, &ids).unwrap();
    let unmapped = make_run("unmapped", "2026-11-06T10:03:00Z", &after, None);
    CurationStorage::save_evidence(&db, "album", &unmapped).unwrap();
    drop(db);

    let db = AppDb::new(path.clone()).unwrap();
    let conn = db.conn.lock();
    let mapping = conn
        .query_row(
            "SELECT status, revision FROM curate_identity_mappings WHERE local_track_id = 'one'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .unwrap();
    assert_eq!(mapping, ("unmapped".into(), 2));
    let metadata: i64 = conn.query_row(
        "SELECT revision FROM curate_identity_metadata WHERE entity_id = 'album' AND field = 'genre'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(metadata, 1);
    conn.execute("DELETE FROM tracks WHERE id = 'one'", [])
        .unwrap();
    let detached: (String, Option<String>) = conn.query_row(
        "SELECT lineage_status, disc_id FROM curate_identity_tracks WHERE local_track_id = 'one'",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(detached, ("unresolved".into(), None));
    drop(conn);
    let replacement = track(
        "replacement",
        "album",
        "library/Harbor Lights",
        "one.flac",
        2,
    );
    DbOperations::upsert_tracks_batch(&mut db.conn.lock(), &[replacement]).unwrap();
    let replacement = CurationStorage::get_identity(&db, &["replacement".into()]).unwrap();
    assert_eq!(replacement[0]["localTrackId"], "replacement");
    let new_mappings: i64 = db
        .conn
        .lock()
        .query_row(
            "SELECT COUNT(*) FROM curate_identity_mappings WHERE local_track_id = 'replacement'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(new_mappings, 0);
    drop(db);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

use rusqlite::Connection;
use serde_json::json;

fn track(id: &str, release: &str, folder: &str, file: &str, position: i32) -> DbTrack {
    serde_json::from_value(json!({
        "id": id, "releaseId": release, "mountId": "fixture",
        "folderPath": folder, "folderName": "Harbor Lights",
        "filePath": format!("{folder}/{file}"), "fileName": file,
        "fileSize": 100, "mtime": 0, "title": file, "artistCredit": "Various Artists",
        "albumTitle": "Harbor Lights", "trackNumber": position, "durationSecs": 60,
        "format": "FLAC", "hasEmbeddedArt": false, "sidecarStatus": "in_sync",
        "isOnline": true, "isCompilation": true, "originalAlbum": "Original Film",
        "originalYear": 1988, "createdAt": "2026-11-06"
    }))
    .unwrap()
}

fn identity(conn: &Connection, track: &str) -> (String, String, String, i64, i64, i64) {
    conn.query_row(
        "SELECT e.id, d.id, s.group_id, e.revision, d.revision, d.order_revision
         FROM curate_identity_tracks t
         JOIN curate_identity_discs d ON t.disc_id = d.id
         JOIN curate_identity_editions e ON d.edition_id = e.id
         JOIN curate_identity_sources s ON t.local_track_id = s.local_track_id
         WHERE t.local_track_id = ?1 AND s.status = 'inferred'",
        [track],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        },
    )
    .unwrap()
}

#[test]
fn editions_discs_and_cross_disc_source_survive_restart_and_rescan() {
    let dir = std::env::temp_dir().join(format!("cadence-identity-{}", uuid::Uuid::new_v4()));
    let path = dir.join("cadence.db");
    let db = AppDb::new(path.clone()).unwrap();
    let mut disc_one = track("one", "disc1", "library/Harbor Lights/CD 1", "one.flac", 1);
    let disc_two = track("two", "disc2", "library/Harbor Lights/CD 2", "two.flac", 1);
    let deluxe = track(
        "deluxe",
        "deluxe",
        "library/Harbor Lights Deluxe",
        "one.flac",
        1,
    );
    let (first, second, other) = {
        let mut conn = db.conn.lock();
        for t in [&disc_one, &disc_two, &deluxe] {
            conn.execute(
                "INSERT INTO releases (id,title,folder_path,folder_name,artist_credit,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    t.release_id,
                    t.album_title,
                    t.folder_path,
                    t.folder_name,
                    t.artist_credit,
                    t.created_at
                ],
            )
            .unwrap();
        }
        DbOperations::upsert_tracks_batch(&mut conn, &[disc_one.clone(), disc_two, deluxe])
            .unwrap();
        (
            identity(&conn, "one"),
            identity(&conn, "two"),
            identity(&conn, "deluxe"),
        )
    };
    assert_eq!(first.0, second.0);
    assert_ne!(first.1, second.1);
    assert_eq!(first.2, second.2);
    assert_ne!(first.0, other.0);
    assert_ne!(first.2, other.2);
    drop(db);

    let db = AppDb::new(path).unwrap();
    let mut conn = db.conn.lock();
    assert_eq!(identity(&conn, "one"), first);
    disc_one.id = "replacement-scan-id".into();
    DbOperations::upsert_tracks_batch(&mut conn, &[disc_one.clone()]).unwrap();
    assert_eq!(identity(&conn, "one"), first);

    disc_one.track_number = Some(2);
    disc_one.title = "Corrected title".into();
    DbOperations::upsert_tracks_batch(&mut conn, &[disc_one]).unwrap();
    let reordered = identity(&conn, "one");
    assert_eq!(
        (&reordered.0, &reordered.1, &reordered.2),
        (&first.0, &first.1, &first.2)
    );
    assert_eq!(
        (reordered.3, reordered.4, reordered.5),
        (first.3, first.4, first.5 + 1)
    );
    assert_eq!(identity(&conn, "two"), second);
    assert_eq!(identity(&conn, "deluxe"), other);
    drop(conn);
    drop(db);
    std::fs::remove_file(dir.join("cadence.db")).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
#[test]
fn legacy_identity_table_upgrades_before_curate_loads_existing_and_new_tracks() {
    use cadence_core_lib::curation::CurationStorage;

    let path = std::env::temp_dir().join(format!(
        "cadence-identity-upgrade-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let ids = ["existing".to_owned(), "unseen".to_owned()];
    let original = {
        let db = AppDb::new(path.clone()).unwrap();
        {
            let mut conn = db.conn.lock();
            conn.execute(
                "INSERT INTO releases (id,title,folder_path,folder_name,artist_credit,created_at)
                 VALUES ('album','Sivaa','library/Sivaa','Sivaa','Various Artists','2026-11-06')",
                [],
            )
            .unwrap();
            let tracks = [
                track("existing", "album", "library/Sivaa", "one.flac", 1),
                track("unseen", "album", "library/Sivaa", "two.flac", 2),
            ];
            DbOperations::upsert_tracks_batch(&mut conn, &tracks).unwrap();
            conn.execute_batch(
                "DELETE FROM curate_identity_sources WHERE local_track_id = 'unseen';
                 DELETE FROM curate_identity_tracks WHERE local_track_id = 'unseen';
                 ALTER TABLE curate_identity_tracks DROP COLUMN catalog_source_key;",
            )
            .unwrap();
        }
        CurationStorage::get_identity(&db, &ids[..1]).unwrap()
    };

    let upgraded = {
        let db = AppDb::new(path.clone()).unwrap();
        let rows = CurationStorage::get_identity(&db, &ids).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["editionId"], original[0]["editionId"]);
        assert_eq!(rows[0]["discId"], original[0]["discId"]);
        assert_eq!(rows[1]["editionId"], original[0]["editionId"]);
        assert_eq!(rows[0]["sourceGroupId"], original[0]["sourceGroupId"]);
        assert_eq!(rows[1]["sourceGroupId"], original[0]["sourceGroupId"]);
        rows
    };
    let db = AppDb::new(path.clone()).unwrap();
    assert_eq!(CurationStorage::get_identity(&db, &ids).unwrap(), upgraded);
    drop(db);
    std::fs::remove_file(path).unwrap();
}
