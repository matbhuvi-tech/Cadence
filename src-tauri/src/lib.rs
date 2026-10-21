pub mod audio;
pub mod commands;
pub mod db;
pub mod remote;
pub mod scanner;

use audio::AudioEngine;
use commands::audio::*;
use commands::library::*;
use commands::remote::*;
use commands::scanner::*;
use db::AppDb;
use scanner::ScannerController;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_engine = AudioEngine::new();
    let engine_for_remote = audio_engine.clone();
    let scanner_controller = ScannerController::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(audio_engine)
        .manage(scanner_controller)
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let db_path = app_data_dir.join("cadence.db");
            println!("[Cadence Core] Initializing SQLite database at: {:?}", db_path);
            let app_db = AppDb::new(db_path).expect("Failed to initialize SQLite database");

            let artwork_cache_dir = app_data_dir.join("cache").join("artwork");
            let token_path = app_data_dir.join("remote_token.txt");
            let remote_state = std::sync::Arc::new(crate::remote::RemoteState::new(
                engine_for_remote.clone(),
                app_db.clone(),
                artwork_cache_dir,
                token_path,
            ));
            remote_state.set_app_handle(app.handle().clone());

            let remote_state_for_server = std::sync::Arc::clone(&remote_state);
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::remote::start_remote_server(remote_state_for_server, 4040).await {
                    eprintln!("[Cadence Remote] Could not launch server: {}", e);
                }
            });

            app.manage(app_db);
            app.manage(remote_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            play_track,
            pause_audio,
            resume_audio,
            stop_audio,
            seek_audio,
            set_audio_volume,
            set_audio_device,
            get_playback_status,
            list_audio_devices,
            set_purity_mode,
            get_purity_mode,
            discover_upnp_devices,
            get_stream_buffer_info,
            set_stream_buffer_limit,
            scan_directory_native,
            read_cover_art_base64,
            commit_track_tags_native,
            // Remote Mobile Controller commands
            get_remote_server_info,
            regenerate_pairing_token,
            sync_desktop_queue_to_remote,
            // SQLite Library & Storage commands
            check_storage_mounts_accessibility,
            check_path_accessible,
            db_get_offline_counts,
            db_get_storage_mounts,
            db_save_storage_mount,
            db_remove_storage_mount,
            db_set_mount_status,
            db_toggle_mount_lock,
            db_get_watched_folders,
            db_save_watched_folder,
            db_remove_watched_folder,
            db_get_tracks,
            db_get_releases,
            db_save_tracks_batch,
            db_get_skipped_files,
            db_ignore_skipped_file,
            db_delete_skipped_file,
            db_get_library_stats,
            start_library_scan,
            pause_library_scan,
            resume_library_scan,
            cancel_library_scan,
            get_scan_status,
            show_item_in_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cadence Core application");
}
