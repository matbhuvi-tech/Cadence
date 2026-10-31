pub mod audio;
pub mod commands;
pub mod db;
pub mod maintenance;
pub mod remote;
pub mod scanner;

use audio::AudioEngine;
use commands::audio::*;
use commands::gemini_config::*;
use commands::library::*;
use commands::maintenance::*;
use commands::remote::*;
use commands::scanner::*;
use db::AppDb;
use scanner::ScannerController;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_engine = AudioEngine::new();
    let engine_for_remote = audio_engine.clone();
    let engine_for_maintenance = audio_engine.clone();
    let engine_for_commit = audio_engine.clone();
    let scanner_controller = ScannerController::new(Some(audio_engine.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::all() ^ tauri_plugin_window_state::StateFlags::VISIBLE)
            .build())
        .manage(audio_engine)
        .manage(scanner_controller)
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let db_path = app_data_dir.join("cadence.db");
            println!("[Cadence Core] Initializing SQLite database at: {:?}", db_path);
            let app_db = AppDb::new(db_path.clone()).expect("Failed to initialize SQLite database");

            let artwork_cache_dir = app_data_dir.join("cache").join("artwork");
            let token_path = app_data_dir.join("remote_token.txt");
            let remote_state = std::sync::Arc::new(crate::remote::RemoteState::new(
                engine_for_remote.clone(),
                app_db.clone(),
                artwork_cache_dir.clone(),
                token_path,
            ));
            remote_state.set_app_handle(app.handle().clone());

            let remote_state_for_server = std::sync::Arc::clone(&remote_state);
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::remote::start_remote_server(remote_state_for_server, 4040).await {
                    eprintln!("[Cadence Remote] Could not launch server: {}", e);
                }
            });

            // Start low-priority background maintenance worker (runs only when AudioEngine is idle)
            let maintenance_worker = crate::maintenance::MaintenanceWorker::new(
                engine_for_maintenance,
                app_db.clone(),
                artwork_cache_dir,
            );
            maintenance_worker.set_app_handle(app.handle().clone());
            maintenance_worker.start();

            let commit_worker = crate::maintenance::CommitQueueWorker::from_db_path(engine_for_commit, db_path.clone()).expect("Failed to initialize CommitQueueWorker dedicated DB connection");
            commit_worker.set_app_handle(app.handle().clone());
            commit_worker.start();

            app.manage(app_db);
            app.manage(remote_state.clone());
            app.manage(maintenance_worker);
            app.manage(commit_worker);

            // Configure Windows System Tray Icon & Audiophile Transport Menu
            let show_i = MenuItem::with_id(app, "tray_show", "Show Cadence Core", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let play_pause_i = MenuItem::with_id(app, "tray_play_pause", "Play / Pause", true, None::<&str>)?;
            let next_i = MenuItem::with_id(app, "tray_next", "Next Track", true, None::<&str>)?;
            let prev_i = MenuItem::with_id(app, "tray_prev", "Previous Track", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "tray_quit", "Quit Cadence", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[&show_i, &sep1, &play_pause_i, &next_i, &prev_i, &sep2, &quit_i],
            )?;

            let remote_for_tray = std::sync::Arc::clone(&remote_state);
            let mut tray_builder = TrayIconBuilder::with_id("cadence-tray")
                .tooltip("Cadence Core — Relational Audiophile Engine")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app_handle, event| {
                    match event.id.as_ref() {
                        "tray_show" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "tray_play_pause" => {
                            let status = remote_for_tray.engine.get_status();
                            if status.is_playing && !status.is_paused {
                                let _ = remote_for_tray.engine.pause();
                            } else {
                                let _ = remote_for_tray.engine.resume();
                            }
                            let updated = remote_for_tray.engine.get_status();
                            remote_for_tray.broadcast_state_change(&updated);
                        }
                        "tray_next" => {
                            let next_file = {
                                let mut q = remote_for_tray.queue.lock();
                                if q.items.is_empty() {
                                    None
                                } else {
                                    let mut next_idx = q.current_index + 1;
                                    if next_idx >= q.items.len() as isize {
                                        if q.repeat_mode == "all" {
                                            next_idx = 0;
                                        } else {
                                            next_idx = -1;
                                        }
                                    }
                                    if next_idx >= 0 {
                                        q.current_index = next_idx;
                                        q.items.get(next_idx as usize).map(|t| t.file_path.clone())
                                    } else {
                                        None
                                    }
                                }
                            };
                            if let Some(path) = next_file {
                                let _ = remote_for_tray.engine.play_track(&path);
                                let updated = remote_for_tray.engine.get_status();
                                remote_for_tray.broadcast_state_change(&updated);
                                remote_for_tray.broadcast_queue_update();
                            }
                        }
                        "tray_prev" => {
                            let prev_file = {
                                let mut q = remote_for_tray.queue.lock();
                                if q.items.is_empty() {
                                    None
                                } else {
                                    let next_idx = (q.current_index - 1).max(0);
                                    q.current_index = next_idx;
                                    q.items.get(next_idx as usize).map(|t| t.file_path.clone())
                                }
                            };
                            if let Some(path) = prev_file {
                                let _ = remote_for_tray.engine.play_track(&path);
                                let updated = remote_for_tray.engine.get_status();
                                remote_for_tray.broadcast_state_change(&updated);
                                remote_for_tray.broadcast_queue_update();
                            }
                        }
                        "tray_quit" => {
                            let _ = remote_for_tray.engine.stop();
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app_handle = tray.app_handle();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(default_icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(default_icon.clone());
            }

            let _tray = tray_builder.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_gemini_config,
            save_gemini_api_key,
            save_gemini_model,
            remove_gemini_api_key,
            gemini_resolve,
            get_gemini_quota,
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
            prepare_next_track,
            invalidate_next_track,
            set_settling_delay_ms,
            scan_directory_native,
            read_cover_art_base64,
            commit_track_tags_native,
            // Asynchronous Background Commit Queue commands
            commit_enqueue_batch,
            commit_get_queue_summary,
            commit_get_telemetry,
            commit_set_override,
            commit_toggle_pause,
            commit_retry_offline_mounts,
            commit_cancel_batch,
            commit_undo_batch,
            commit_get_queued_track_ids,
            // Remote Mobile Controller commands
            get_remote_server_info,
            regenerate_pairing_token,
            sync_desktop_queue_to_remote,
            // Maintenance commands
            get_maintenance_stats,
            get_portrait_sync_stats,
            toggle_maintenance_pause,
            notify_artist_portrait_resolved,
            force_enrich_now,
            get_track_fingerprint,
            db_update_track_provenance,
            db_get_cached_acoustid,
            db_cache_acoustid_result,
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
            db_ignore_all_skipped_files,
            db_delete_skipped_file,
            db_get_library_stats,
            start_library_scan,
            set_scan_playback_policy,
            get_scan_playback_policy,
            pause_library_scan,
            resume_library_scan,
            cancel_library_scan,
            get_scan_status,
            show_item_in_folder,
            db_get_canonical_artists,
            db_get_canonical_artist_detail,
            db_set_artist_portrait,
            db_update_canonical_artist_editorial,
            db_backfill_artist_credits,
            db_search_catalog,
            // Playlists
            db_get_playlists,
            db_get_playlist_details,
            db_create_playlist,
            db_update_playlist,
            db_delete_playlist,
            db_add_tracks_to_playlist,
            db_remove_track_from_playlist,
            db_reorder_playlist_tracks,
            // Split Multi-Disc Overrides
            db_set_release_split,
            db_remove_release_split,
            db_get_split_releases,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cadence Core application");
}
