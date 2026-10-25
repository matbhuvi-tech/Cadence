use std::process::Command;
use tauri::{AppHandle, State};

use crate::db::{
    is_directory_accessible, AppDb, DbOperations, DbPlaylist, DbPlaylistWithTracks, DbRelease,
    DbSkippedFile, DbStorageMount, DbTrack, DbWatchedFolder, StorageAccessibilityReport,
};
use crate::scanner::{ScanProgressPayload, ScannerController};

// Storage Mounts
#[tauri::command]
pub async fn check_storage_mounts_accessibility(
    db: State<'_, AppDb>,
) -> Result<Vec<StorageAccessibilityReport>, String> {
    let (mounts, watched_folders) = {
        let conn = db.conn.lock();
        let m = DbOperations::get_storage_mounts(&conn).map_err(|e| e.to_string())?;
        let w = DbOperations::get_watched_folders(&conn).map_err(|e| e.to_string())?;
        (m, w)
    };

    let mut reports = Vec::new();

    for mut mount in mounts {
        let mut accessible = is_directory_accessible(&mount.mount_path).await;
        if !accessible {
            // Check if any watched folder belonging to this mount is accessible
            for wf in watched_folders.iter().filter(|w| w.mount_id == mount.id) {
                if is_directory_accessible(&wf.folder_path).await {
                    accessible = true;
                    break;
                }
            }
        }

        let new_status = if accessible { "online" } else { "offline" };
        if mount.status != new_status {
            mount.status = new_status.to_string();
            let conn = db.conn.lock();
            let _ = DbOperations::set_mount_status(&conn, &mount.id, new_status);
        }

        let (tracks_count, releases_count) = {
            let conn = db.conn.lock();
            let mut stmt_t = conn
                .prepare("SELECT COUNT(*) FROM tracks WHERE mount_id = ?1")
                .map_err(|e| e.to_string())?;
            let t_cnt: i64 = stmt_t.query_row(rusqlite::params![mount.id], |r| r.get(0)).unwrap_or(0);
            let mut stmt_r = conn
                .prepare("SELECT COUNT(DISTINCT release_id) FROM tracks WHERE mount_id = ?1")
                .map_err(|e| e.to_string())?;
            let r_cnt: i64 = stmt_r.query_row(rusqlite::params![mount.id], |r| r.get(0)).unwrap_or(0);
            (t_cnt, r_cnt)
        };

        reports.push(StorageAccessibilityReport {
            mount_id: mount.id,
            name: mount.name,
            mount_path: mount.mount_path,
            is_accessible: accessible,
            status: new_status.to_string(),
            tracks_count,
            releases_count,
        });
    }

    Ok(reports)
}

#[tauri::command]
pub async fn check_path_accessible(path: String) -> Result<bool, String> {
    Ok(is_directory_accessible(&path).await)
}

#[tauri::command]
pub fn db_get_offline_counts(db: State<'_, AppDb>) -> Result<(i64, i64), String> {
    let conn = db.conn.lock();
    DbOperations::get_offline_counts(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_storage_mounts(db: State<'_, AppDb>) -> Result<Vec<DbStorageMount>, String> {
    let conn = db.conn.lock();
    DbOperations::get_storage_mounts(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_save_storage_mount(db: State<'_, AppDb>, mount: DbStorageMount) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::upsert_storage_mount(&conn, &mount).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_remove_storage_mount(db: State<'_, AppDb>, mount_id: String) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::delete_storage_mount(&conn, &mount_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_set_mount_status(
    db: State<'_, AppDb>,
    mount_id: String,
    status: String,
) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::set_mount_status(&conn, &mount_id, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_toggle_mount_lock(db: State<'_, AppDb>, mount_id: String) -> Result<bool, String> {
    let conn = db.conn.lock();
    DbOperations::toggle_mount_lock(&conn, &mount_id).map_err(|e| e.to_string())
}

// Watched Folders
#[tauri::command]
pub fn db_get_watched_folders(db: State<'_, AppDb>) -> Result<Vec<DbWatchedFolder>, String> {
    let conn = db.conn.lock();
    DbOperations::get_watched_folders(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_save_watched_folder(
    db: State<'_, AppDb>,
    folder: DbWatchedFolder,
) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::upsert_watched_folder(&conn, &folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_remove_watched_folder(db: State<'_, AppDb>, folder_id: String) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::delete_watched_folder(&conn, &folder_id).map_err(|e| e.to_string())
}

// Tracks & Releases
#[tauri::command]
pub fn db_get_tracks(
    db: State<'_, AppDb>,
    limit: Option<i64>,
    offset: Option<i64>,
    only_online: Option<bool>,
) -> Result<Vec<DbTrack>, String> {
    let conn = db.conn.lock();
    DbOperations::get_tracks(&conn, limit, offset, only_online).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_releases(
    db: State<'_, AppDb>,
    only_online: Option<bool>,
) -> Result<Vec<DbRelease>, String> {
    let conn = db.conn.lock();
    DbOperations::get_releases(&conn, only_online).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_save_tracks_batch(
    db: State<'_, AppDb>,
    tracks: Vec<DbTrack>,
    releases: Vec<DbRelease>,
) -> Result<(), String> {
    let mut conn = db.conn.lock();
    if !releases.is_empty() {
        DbOperations::upsert_releases_batch(&mut conn, &releases).map_err(|e| e.to_string())?;
    }
    if !tracks.is_empty() {
        DbOperations::upsert_tracks_batch(&mut conn, &tracks).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Skipped Files
#[tauri::command]
pub fn db_get_skipped_files(db: State<'_, AppDb>) -> Result<Vec<DbSkippedFile>, String> {
    let conn = db.conn.lock();
    DbOperations::get_skipped_files(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_ignore_skipped_file(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::ignore_skipped_file(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_ignore_all_skipped_files(db: State<'_, AppDb>) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::ignore_all_skipped_files(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_skipped_file(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::delete_skipped_file(&conn, &id).map_err(|e| e.to_string())
}

// Stats
#[tauri::command]
pub fn db_get_library_stats(db: State<'_, AppDb>) -> Result<(i64, i64, i64, i64), String> {
    let conn = db.conn.lock();
    DbOperations::get_library_counts(&conn).map_err(|e| e.to_string())
}

// Scanner Controls
#[tauri::command]
pub fn start_library_scan(
    app: AppHandle,
    db: State<'_, AppDb>,
    scanner: State<'_, ScannerController>,
    folder_path: String,
    mount_id: Option<String>,
    force_full: Option<bool>,
    playback_policy: Option<String>,
) -> Result<(), String> {
    if let Some(ref policy) = playback_policy {
        let mode = crate::scanner::engine::PlaybackScanMode::from_str(policy);
        scanner.set_playback_mode(mode);
    }
    scanner.start_scan(app, (*db).clone(), folder_path, mount_id, force_full.unwrap_or(false))
}

#[tauri::command]
pub fn set_scan_playback_policy(
    scanner: State<'_, ScannerController>,
    policy: String,
) -> Result<(), String> {
    let mode = crate::scanner::engine::PlaybackScanMode::from_str(&policy);
    scanner.set_playback_mode(mode);
    Ok(())
}

#[tauri::command]
pub fn get_scan_playback_policy(
    scanner: State<'_, ScannerController>,
) -> Result<String, String> {
    Ok(scanner.get_playback_mode().as_str().to_string())
}

#[tauri::command]
pub fn pause_library_scan(scanner: State<'_, ScannerController>) -> Result<(), String> {
    scanner.pause();
    Ok(())
}

#[tauri::command]
pub fn resume_library_scan(scanner: State<'_, ScannerController>) -> Result<(), String> {
    scanner.resume();
    Ok(())
}

#[tauri::command]
pub fn cancel_library_scan(scanner: State<'_, ScannerController>) -> Result<(), String> {
    scanner.cancel();
    Ok(())
}

#[tauri::command]
pub fn get_scan_status(scanner: State<'_, ScannerController>) -> ScanProgressPayload {
    scanner.get_status()
}

#[tauri::command]
pub fn show_item_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Windows Explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        }
    }
    Ok(())
}

// --- Canonical Relational Artists ---

#[tauri::command]
pub fn db_get_canonical_artists(db: State<'_, AppDb>) -> Result<Vec<crate::db::DbArtistSummary>, String> {
    let mut conn = db.conn.lock();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM canonical_artists", [], |r| r.get(0)).unwrap_or(0);
    if count == 0 {
        let _ = crate::db::DbOperations::backfill_artist_credits_from_tracks(&mut conn);
    }
    crate::db::DbOperations::get_canonical_artists(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_canonical_artist_detail(
    db: State<'_, AppDb>,
    artist_id: String,
) -> Result<Option<crate::db::DbArtistDetail>, String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::get_canonical_artist_detail(&conn, &artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_set_artist_portrait(
    db: State<'_, AppDb>,
    artist_id: String,
    portrait_url: String,
    status: Option<String>,
) -> Result<(), String> {
    let conn = db.conn.lock();
    let st = status.as_deref().unwrap_or("enriched");
    crate::db::DbOperations::set_artist_portrait(&conn, &artist_id, &portrait_url, st).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_backfill_artist_credits(db: State<'_, AppDb>) -> Result<usize, String> {
    let mut conn = db.conn.lock();
    crate::db::DbOperations::backfill_artist_credits_from_tracks(&mut conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_search_catalog(
    db: State<'_, AppDb>,
    query: String,
    limit: Option<usize>,
) -> Result<crate::db::DbCatalogSearchResults, String> {
    let conn = db.conn.lock();
    crate::db::DbOperations::search_catalog(&conn, &query, limit.unwrap_or(5)).map_err(|e| e.to_string())
}

// Playlists
#[tauri::command]
pub fn db_get_playlists(db: State<'_, AppDb>) -> Result<Vec<DbPlaylist>, String> {
    let conn = db.conn.lock();
    DbOperations::get_playlists(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_playlist_details(
    db: State<'_, AppDb>,
    playlist_id: String,
) -> Result<Option<DbPlaylistWithTracks>, String> {
    let conn = db.conn.lock();
    DbOperations::get_playlist_details(&conn, &playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_create_playlist(
    db: State<'_, AppDb>,
    id: String,
    title: String,
    description: Option<String>,
    cover_art_url: Option<String>,
    tags: Option<String>,
    listening_notes: Option<String>,
    track_ids: Vec<String>,
) -> Result<DbPlaylist, String> {
    let mut conn = db.conn.lock();
    DbOperations::create_playlist(
        &mut conn,
        &id,
        &title,
        description.as_deref(),
        cover_art_url.as_deref(),
        tags.as_deref(),
        listening_notes.as_deref(),
        &track_ids,
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_update_playlist(
    db: State<'_, AppDb>,
    id: String,
    title: String,
    description: Option<String>,
    cover_art_url: Option<String>,
    tags: Option<String>,
    listening_notes: Option<String>,
) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::update_playlist(
        &conn,
        &id,
        &title,
        description.as_deref(),
        cover_art_url.as_deref(),
        tags.as_deref(),
        listening_notes.as_deref(),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_playlist(
    db: State<'_, AppDb>,
    id: String,
) -> Result<(), String> {
    let conn = db.conn.lock();
    DbOperations::delete_playlist(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_add_tracks_to_playlist(
    db: State<'_, AppDb>,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), String> {
    let mut conn = db.conn.lock();
    DbOperations::add_tracks_to_playlist(&mut conn, &playlist_id, &track_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_remove_track_from_playlist(
    db: State<'_, AppDb>,
    playlist_id: String,
    position: i64,
) -> Result<(), String> {
    let mut conn = db.conn.lock();
    DbOperations::remove_track_from_playlist(&mut conn, &playlist_id, position).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_reorder_playlist_tracks(
    db: State<'_, AppDb>,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), String> {
    let mut conn = db.conn.lock();
    DbOperations::reorder_playlist_tracks(&mut conn, &playlist_id, &track_ids).map_err(|e| e.to_string())
}

