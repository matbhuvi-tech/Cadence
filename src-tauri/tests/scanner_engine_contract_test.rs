use cadence_core_lib::scanner::engine::{
    disambiguate_combo_title, read_album_sidecar, read_track_sidecar, ScannerController,
};
use std::fs;
use std::path::PathBuf;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cadence_scanner_engine_test_{}_{}",
        label,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn sidecar_readers_handle_missing_malformed_and_valid_json() {
    let dir = temp_dir("sidecars");
    let track_path = dir.join("01_track.flac");
    fs::write(&track_path, b"").unwrap();

    // Missing sidecars return defaults without panicking
    let empty_album = read_album_sidecar(&dir);
    assert!(empty_album.album.is_none());
    let empty_track = read_track_sidecar(&track_path);
    assert!(empty_track.title.is_none());

    // Malformed sidecar JSON fails gracefully to defaults
    fs::write(dir.join("cadence-album.sidecar.json"), b"{not-valid-json").unwrap();
    let bad_album = read_album_sidecar(&dir);
    assert!(bad_album.album.is_none());

    // Valid album sidecar parses cleanly
    fs::write(
        dir.join("cadence-album.sidecar.json"),
        r#"{"album":"Goldberg Variations (1981)","folderName":"Goldberg Variations"}"#,
    )
    .unwrap();
    let parsed_album = read_album_sidecar(&dir);
    assert_eq!(parsed_album.album.as_deref(), Some("Goldberg Variations (1981)"));
    assert_eq!(parsed_album.folder_name.as_deref(), Some("Goldberg Variations"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn disambiguate_combo_title_and_controller_state_transitions() {
    let single = disambiguate_combo_title("Roja", "Roja (1992)");
    assert!(!single.is_empty());

    let combo = disambiguate_combo_title("Roja / Bombay", "Roja - Bombay [2-in-1 CD]");
    assert!(!combo.is_empty());

    let controller = ScannerController::new(None);
    let initial = controller.get_status();
    assert!(!initial.is_scanning);
    assert!(!initial.is_paused);

    // pause/resume/cancel are safe no-ops when no scan is running
    controller.pause();
    assert!(!controller.get_status().is_paused);
    controller.resume();
    assert!(!controller.get_status().is_paused);
    controller.cancel();
    assert!(!controller.get_status().is_scanning);
}
