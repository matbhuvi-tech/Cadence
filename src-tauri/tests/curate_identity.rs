use cadence_core_lib::db::{AppDb, DbOperations, DbTrack};
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
    })).unwrap()
}

fn identity(conn: &Connection, track: &str) -> (String, String, String, i64, i64, i64) {
    conn.query_row(
        "SELECT e.id, d.id, s.group_id, e.revision, d.revision, d.order_revision
         FROM curate_identity_tracks t
         JOIN curate_identity_discs d ON t.disc_id = d.id
         JOIN curate_identity_editions e ON d.edition_id = e.id
         JOIN curate_identity_sources s ON t.local_track_id = s.local_track_id
         WHERE t.local_track_id = ?1 AND s.status = 'inferred'",
        [track], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).unwrap()
}

#[test]
fn editions_discs_and_cross_disc_source_survive_restart_and_rescan() {
    let dir = std::env::temp_dir().join(format!("cadence-identity-{}", uuid::Uuid::new_v4()));
    let path = dir.join("cadence.db");
    let db = AppDb::new(path.clone()).unwrap();
    let mut disc_one = track("one", "disc1", "library/Harbor Lights/CD 1", "one.flac", 1);
    let disc_two = track("two", "disc2", "library/Harbor Lights/CD 2", "two.flac", 1);
    let deluxe = track("deluxe", "deluxe", "library/Harbor Lights Deluxe", "one.flac", 1);
    let (first, second, other) = {
        let mut conn = db.conn.lock();
        for t in [&disc_one, &disc_two, &deluxe] {
            conn.execute(
                "INSERT INTO releases (id,title,folder_path,folder_name,artist_credit,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![t.release_id, t.album_title, t.folder_path, t.folder_name, t.artist_credit, t.created_at],
            ).unwrap();
        }
        DbOperations::upsert_tracks_batch(&mut conn, &[disc_one.clone(), disc_two, deluxe]).unwrap();
        (identity(&conn, "one"), identity(&conn, "two"), identity(&conn, "deluxe"))
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
    assert_eq!((&reordered.0, &reordered.1, &reordered.2), (&first.0, &first.1, &first.2));
    assert_eq!((reordered.3, reordered.4, reordered.5), (first.3, first.4, first.5 + 1));
    assert_eq!(identity(&conn, "two"), second);
    assert_eq!(identity(&conn, "deluxe"), other);
    drop(conn);
    drop(db);
    std::fs::remove_file(dir.join("cadence.db")).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

