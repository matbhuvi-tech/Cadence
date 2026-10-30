use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagExt, TagItem};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

use crate::audio::AudioEngine;
use crate::db::{AppDb, DbOperations};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitTelemetryPayload {
    pub state: String, // "idle" | "writing" | "paused_playback" | "cooldown" | "paused_mount_offline" | "user_paused"
    pub active_batch_id: Option<String>,
    pub active_batch_description: Option<String>,
    pub current_track_id: Option<String>,
    pub current_track_title: Option<String>,
    pub current_track_file_path: Option<String>,
    pub pending_items: i64,
    pub inflight_items: i64,
    pub completed_items: i64,
    pub failed_items: i64,
    pub total_items: i64,
    pub percent: f64,
    pub throughput_items_per_sec: f64,
    pub cooldown_remaining_secs: Option<u64>,
    pub offline_mounts: Vec<String>,
    pub error_message: Option<String>,
}

#[derive(Clone)]
pub struct CommitQueueWorker {
    engine: AudioEngine,
    db: AppDb,
    is_running: Arc<AtomicBool>,
    user_paused: Arc<AtomicBool>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    last_playback_activity: Arc<Mutex<std::time::Instant>>,
    last_telemetry_emit: Arc<Mutex<std::time::Instant>>,
    last_emitted_state: Arc<Mutex<String>>,
    offline_mounts: Arc<Mutex<HashSet<String>>>,
    mount_failure_counts: Arc<Mutex<HashMap<String, u32>>>,
    active_item_info: Arc<Mutex<Option<(String, String, String)>>>, // (track_id, title, file_path)
    processed_in_window: Arc<Mutex<Vec<std::time::Instant>>>,
    written_artwork_dirs: Arc<Mutex<HashSet<std::path::PathBuf>>>,
    current_active_batch_id: Arc<Mutex<Option<String>>>,
}

impl CommitQueueWorker {
    pub fn new(engine: AudioEngine, db: AppDb) -> Self {
        Self {
            engine,
            db,
            is_running: Arc::new(AtomicBool::new(false)),
            user_paused: Arc::new(AtomicBool::new(false)),
            app_handle: Arc::new(Mutex::new(None)),
            last_playback_activity: Arc::new(Mutex::new(std::time::Instant::now())),
            last_telemetry_emit: Arc::new(Mutex::new(std::time::Instant::now() - Duration::from_secs(1))),
            last_emitted_state: Arc::new(Mutex::new(String::new())),
            offline_mounts: Arc::new(Mutex::new(HashSet::new())),
            mount_failure_counts: Arc::new(Mutex::new(HashMap::new())),
            active_item_info: Arc::new(Mutex::new(None)),
            processed_in_window: Arc::new(Mutex::new(Vec::new())),
            written_artwork_dirs: Arc::new(Mutex::new(HashSet::new())),
            current_active_batch_id: Arc::new(Mutex::new(None)),
        }
    }

    /// Creates a CommitQueueWorker with its own dedicated SQLite connection,
    /// isolating worker writes and SQLite locks from the UI thread's read connection.
    pub fn from_db_path(engine: AudioEngine, db_path: std::path::PathBuf) -> Result<Self, String> {
        let db = AppDb::open_dedicated(&db_path)?;
        Ok(Self::new(engine, db))
    }

    /// Performs startup crash recovery: sweeps `in_flight` items in SQLite and deletes orphaned temp files.
    pub fn perform_startup_recovery(&self) {
        let conn = self.db.conn.lock();
        if let Ok(requeued) = DbOperations::requeue_inflight_commit_items_sweep(&conn) {
            drop(conn);
            for item in requeued {
                let path = Path::new(&item.file_path);
                if let Some(parent) = path.parent() {
                    if let Ok(entries) = fs::read_dir(parent) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let fname = entry.file_name().to_string_lossy().to_string();
                            if fname.contains(".cadence-tmp-") {
                                let _ = fs::remove_file(entry.path());
                                eprintln!("[CommitQueueWorker] Cleaned orphaned temp file: {:?}", entry.path());
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock() = Some(handle);
    }

    pub fn toggle_pause(&self) -> bool {
        let current = self.user_paused.load(Ordering::SeqCst);
        let next = !current;
        self.user_paused.store(next, Ordering::SeqCst);
        self.emit_telemetry(true);
        next
    }

    pub fn is_user_paused(&self) -> bool {
        self.user_paused.load(Ordering::Relaxed)
    }

    pub fn retry_offline_mounts(&self) {
        self.offline_mounts.lock().clear();
        self.mount_failure_counts.lock().clear();
        self.emit_telemetry(true);
    }

    pub fn handle_device_change(&self) {
        eprintln!("[CommitQueueWorker] Win32 WM_DEVICECHANGE received. Retrying offline mounts.");
        self.retry_offline_mounts();
    }

    pub fn start(&self) -> Option<JoinHandle<()>> {
        if self.is_running.swap(true, Ordering::SeqCst) {
            eprintln!("[CommitQueueWorker] Worker is already running.");
            return None;
        }

        self.perform_startup_recovery();

        let worker = self.clone();
        let handle = thread::Builder::new()
            .name("cadence-commit-worker".into())
            .spawn(move || {
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::System::Threading::{
                        GetCurrentProcess, GetCurrentThread, GetProcessAffinityMask,
                        SetThreadAffinityMask, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
                    };

                    // Set thread priority below normal to prevent starving foreground or audio threads,
                    // while avoiding THREAD_MODE_BACKGROUND_BEGIN to prevent Windows MemoryPriorityVeryLow
                    // and I/O priority inversion deadlocks on shared SQLite mutexes.
                    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);

                    let mut process_mask: usize = 0;
                    let mut system_mask: usize = 0;
                    if GetProcessAffinityMask(GetCurrentProcess(), &mut process_mask, &mut system_mask) != 0 {
                        let isolated_mask = process_mask & !0b11;
                        if isolated_mask != 0 {
                            SetThreadAffinityMask(GetCurrentThread(), isolated_mask);
                        } else {
                            SetThreadAffinityMask(GetCurrentThread(), process_mask);
                        }
                    }
                }

                eprintln!("[CommitQueueWorker] Started asynchronous background commit worker (isolated off Core 0/1).");
                worker.run_loop();
                eprintln!("[CommitQueueWorker] Commit worker terminated.");
            })
            .ok();

        handle
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }

    fn run_loop(&self) {
        while self.is_running.load(Ordering::Relaxed) {
            // 1. Check user pause
            if self.user_paused.load(Ordering::Relaxed) {
                self.emit_state_telemetry("user_paused", None, None);
                thread::sleep(Duration::from_millis(300));
                continue;
            }

            // 2. Audio Engine Transport Preemption Guard
            let is_playback_active = self.engine.is_playing() || self.engine.is_paused();
            if is_playback_active {
                *self.last_playback_activity.lock() = std::time::Instant::now();
            }

            let last_active = *self.last_playback_activity.lock();
            let elapsed_since_active = last_active.elapsed();
            let in_cooldown = !is_playback_active && elapsed_since_active < Duration::from_secs(30);

            // Fetch summary to check if there is work to do
            let summary = {
                let conn = self.db.conn.lock();
                DbOperations::get_commit_queue_summary(&conn).ok()
            };

            let pending_count = summary.as_ref().map(|s| s.pending_items).unwrap_or(0);
            if pending_count == 0 {
                *self.active_item_info.lock() = None;
                self.emit_state_telemetry("idle", None, None);
                thread::sleep(Duration::from_millis(500));
                continue;
            }

            // Check if active batch allows force override
            let active_batch_id = summary.as_ref().and_then(|s| s.active_batch_id.clone());
            let is_override_allowed = if let Some(ref bid) = active_batch_id {
                let conn = self.db.conn.lock();
                DbOperations::is_batch_override_allowed(&conn, bid).unwrap_or(false)
            } else {
                false
            };

            // Purity Mode check: If Purity Mode is active, NEVER allow override during playback
            let is_purity_mode = self.engine.get_purity_mode();
            let can_override = is_override_allowed && !is_purity_mode;

            if is_playback_active && !can_override {
                *self.active_item_info.lock() = None;
                self.emit_state_telemetry("paused_playback", None, None);
                thread::sleep(Duration::from_millis(250));
                continue;
            }

            if in_cooldown && !can_override {
                let remaining = 30u64.saturating_sub(elapsed_since_active.as_secs());
                *self.active_item_info.lock() = None;
                self.emit_state_telemetry("cooldown", Some(remaining), None);
                thread::sleep(Duration::from_millis(250));
                continue;
            }

            // 3. Excluded mounts check
            let excluded: Vec<String> = self.offline_mounts.lock().iter().cloned().collect();

            // 4. Fetch next pending item
            let next_item = {
                let conn = self.db.conn.lock();
                DbOperations::fetch_next_pending_commit_item(&conn, &excluded).ok().flatten()
            };

            let item = match next_item {
                Some(i) => i,
                None => {
                    // All pending items may be on offline mounts
                    if !excluded.is_empty() {
                        self.emit_state_telemetry("paused_mount_offline", None, None);
                    } else {
                        self.emit_state_telemetry("idle", None, None);
                    }
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }
            };

            // Reset artwork deduplication cache if batch changes
            {
                let mut current_batch = self.current_active_batch_id.lock();
                if current_batch.as_deref() != Some(&item.batch_id) {
                    *current_batch = Some(item.batch_id.clone());
                    self.written_artwork_dirs.lock().clear();
                }
            }

            // 5. Mark item as in_flight
            {
                let conn = self.db.conn.lock();
                let _ = DbOperations::update_commit_item_status(&conn, &item.id, "in_flight", None, 0);
            }

            // Parse payload for track info
            let payload: serde_json::Value = serde_json::from_str(&item.payload_json).unwrap_or_default();
            let track_title = payload
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("Unknown Track")
                .to_string();

            *self.active_item_info.lock() = Some((item.track_id.clone(), track_title.clone(), item.file_path.clone()));
            self.emit_state_telemetry("writing", None, None);

            // 6. Execute atomic write
            let write_result = self.process_commit_item(&item, &payload);

            // 7. Update status based on result
            match write_result {
                Ok(bytes) => {
                    {
                        let conn = self.db.conn.lock();
                        let _ = DbOperations::update_commit_item_status(&conn, &item.id, "completed", None, bytes);
                    }

                    // Clear any failure count for this mount
                    self.mount_failure_counts.lock().remove(&item.mount_id);

                    // Record throughput timestamp
                    {
                        let mut history = self.processed_in_window.lock();
                        let now = std::time::Instant::now();
                        history.push(now);
                        history.retain(|t| now.duration_since(*t) <= Duration::from_secs(5));
                    }

                    self.emit_telemetry(false);
                }
                Err(err_msg) => {
                    eprintln!("[CommitQueueWorker] Failed to write track {}: {}", item.file_path, err_msg);
                    {
                        let conn = self.db.conn.lock();
                        let _ = DbOperations::update_commit_item_status(&conn, &item.id, "failed", Some(&err_msg), 0);
                    }

                    // Track consecutive mount failures
                    {
                        let mut failures = self.mount_failure_counts.lock();
                        let count = failures.entry(item.mount_id.clone()).or_insert(0);
                        *count += 1;
                        if *count >= 3 {
                            let mut off = self.offline_mounts.lock();
                            off.insert(item.mount_id.clone());
                            eprintln!(
                                "[CommitQueueWorker] Mount {} failed 3 consecutive writes. Isolating mount.",
                                item.mount_id
                            );
                        }
                    }

                    self.emit_state_telemetry("writing", None, Some(err_msg));
                }
            }

            // Yield briefly between tracks to ensure storage bus quietness and UI smoothness
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn process_commit_item(
        &self,
        item: &crate::db::DbCommitQueueItem,
        payload: &serde_json::Value,
    ) -> Result<i64, String> {
        let destination = payload.get("destination").and_then(|d| d.as_str()).unwrap_or("embedded");
        let target_path = Path::new(&item.file_path);

        if !target_path.exists() {
            return Err(format!("File does not exist: {}", item.file_path));
        }

        if destination == "sidecar" {
            // Write / update cadence-album.sidecar.json in target directory
            let parent_dir = target_path.parent().ok_or("Invalid parent directory")?;
            let sidecar_path = parent_dir.join("cadence-album.sidecar.json");
            let temp_sidecar = parent_dir.join(format!("cadence-album.sidecar.json.cadence-tmp-{}", Uuid::new_v4()));

            let mut sidecar_val = if sidecar_path.exists() {
                fs::read_to_string(&sidecar_path)
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .unwrap_or_else(|| serde_json::json!({}))
            } else {
                serde_json::json!({})
            };

            if let Some(album) = payload.get("album").and_then(|s| s.as_str()) {
                sidecar_val["album"] = serde_json::json!(album);
            }
            if let Some(folder_name) = payload.get("folderName").and_then(|s| s.as_str()) {
                sidecar_val["folderName"] = serde_json::json!(folder_name);
            }
            if let Some(cover) = payload.get("coverArtUrl").and_then(|s| s.as_str()) {
                sidecar_val["coverArtUrl"] = serde_json::json!(cover);
            }

            let sidecar_str = serde_json::to_string_pretty(&sidecar_val)
                .map_err(|e| format!("Failed to serialize sidecar: {}", e))?;
            fs::write(&temp_sidecar, sidecar_str)
                .map_err(|e| format!("Failed to write temp sidecar: {}", e))?;

            Self::atomic_replace_file(&temp_sidecar, &sidecar_path)?;

            // Update SQLite track status
            let conn = self.db.conn.lock();
            let _ = conn.execute(
                "UPDATE tracks SET sidecar_status = 'synced' WHERE id = ?1",
                rusqlite::params![item.track_id],
            );

            let bytes = fs::metadata(&sidecar_path).map(|m| m.len() as i64).unwrap_or(0);
            return Ok(bytes);
        }

        // Embedded tags write
        let parent_dir = target_path.parent().ok_or("Invalid parent directory")?;
        let stem = target_path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = target_path.extension().unwrap_or_default().to_string_lossy();
        let temp_filename = if ext.is_empty() {
            format!("{}.cadence-tmp-{}", stem, Uuid::new_v4())
        } else {
            format!("{}.cadence-tmp-{}.{}", stem, Uuid::new_v4(), ext)
        };
        let temp_path = parent_dir.join(temp_filename);

        // Copy source file to temporary file in the same directory (same filesystem ensures atomic swap)
        fs::copy(target_path, &temp_path)
            .map_err(|e| format!("Failed to copy to temp file: {}", e))?;

        // Open temp file with Lofty and apply metadata updates
        let write_tags_res = (|| -> Result<(), String> {
            let mut tagged_file = Probe::open(&temp_path)
                .map_err(|e| format!("Lofty Probe open failed: {}", e))?
                .read()
                .map_err(|e| format!("Lofty read tags failed: {}", e))?;

            let tag_type = tagged_file.primary_tag_type();
            let tag = match tagged_file.tag_mut(tag_type) {
                Some(t) => t,
                None => {
                    tagged_file.insert_tag(Tag::new(tag_type));
                    match tagged_file.tag_mut(tag_type) {
                        Some(t) => t,
                        None => tagged_file.first_tag_mut().ok_or("Failed to access or create audio tag")?,
                    }
                }
            };

            if let Some(title) = payload.get("title").and_then(|s| s.as_str()) {
                tag.set_title(title.to_string());
            }
            if let Some(artist) = payload.get("artist").or_else(|| payload.get("artistCredit")).and_then(|s| s.as_str()) {
                tag.set_artist(artist.to_string());
            }
            if let Some(album) = payload.get("album").and_then(|s| s.as_str()) {
                tag.set_album(album.to_string());
            }
            if let Some(album_artist) = payload.get("albumArtist").and_then(|s| s.as_str()) {
                tag.insert(TagItem::new(ItemKey::AlbumArtist, ItemValue::Text(album_artist.to_string())));
            }
            if let Some(composer) = payload.get("composer").or_else(|| payload.get("composerName")).and_then(|s| s.as_str()) {
                tag.insert(TagItem::new(ItemKey::Composer, ItemValue::Text(composer.to_string())));
            }
            if let Some(year) = payload.get("year").and_then(|v| v.as_i64()) {
                tag.set_year(year as u32);
            }
            if let Some(track) = payload.get("trackNumber").and_then(|v| v.as_i64()) {
                tag.set_track(track as u32);
            }
            if let Some(genre) = payload.get("genre").and_then(|s| s.as_str()) {
                tag.set_genre(genre.to_string());
            }

            tag.save_to_path(&temp_path, WriteOptions::default())
                .map_err(|e| format!("Lofty save_to_path failed: {}", e))?;

            Ok(())
        })();

        if let Err(e) = write_tags_res {
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        // Atomic swap into place
        if let Err(e) = Self::atomic_replace_file(&temp_path, target_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        // Write cover.jpg to album directory if staged artwork data URL is provided (deduplicated per batch)
        if let Some(cover_data) = payload.get("coverArtUrl").and_then(|s| s.as_str()) {
            if cover_data.starts_with("data:image/") {
                let parent_dir_buf = parent_dir.to_path_buf();
                let already_written = self.written_artwork_dirs.lock().contains(&parent_dir_buf);
                if !already_written {
                    if let Some(idx) = cover_data.find(";base64,") {
                        let b64 = &cover_data[idx + 8..];
                        if let Ok(bytes) = BASE64_STANDARD.decode(b64) {
                            let cover_file = parent_dir.join("cover.jpg");
                            let temp_cover = parent_dir.join(format!("cover.cadence-tmp-{}.jpg", Uuid::new_v4()));
                            if fs::write(&temp_cover, &bytes).is_ok() {
                                if Self::atomic_replace_file(&temp_cover, &cover_file).is_ok() {
                                    self.written_artwork_dirs.lock().insert(parent_dir_buf);
                                } else {
                                    let _ = fs::remove_file(&temp_cover);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Update SQLite track cache so UI reflects tags immediately
        {
            let conn = self.db.conn.lock();
            let _ = conn.execute(
                "UPDATE tracks SET
                    title = COALESCE(?1, title),
                    artist_credit = COALESCE(?2, artist_credit),
                    album_title = COALESCE(?3, album_title),
                    album_artist = COALESCE(?4, album_artist),
                    composer = COALESCE(?5, composer),
                    release_year = COALESCE(?6, release_year),
                    track_number = COALESCE(?7, track_number),
                    genre = COALESCE(?8, genre),
                    sidecar_status = 'synced'
                 WHERE id = ?9",
                rusqlite::params![
                    payload.get("title").and_then(|s| s.as_str()),
                    payload.get("artist").or_else(|| payload.get("artistCredit")).and_then(|s| s.as_str()),
                    payload.get("album").and_then(|s| s.as_str()),
                    payload.get("albumArtist").and_then(|s| s.as_str()),
                    payload.get("composer").or_else(|| payload.get("composerName")).and_then(|s| s.as_str()),
                    payload.get("year").and_then(|v| v.as_i64()),
                    payload.get("trackNumber").and_then(|v| v.as_i64()),
                    payload.get("genre").and_then(|s| s.as_str()),
                    item.track_id,
                ],
            );
        }

        let written_bytes = fs::metadata(target_path).map(|m| m.len() as i64).unwrap_or(0);
        Ok(written_bytes)
    }

    fn atomic_replace_file(src: &Path, dest: &Path) -> Result<(), String> {
        #[cfg(windows)]
        unsafe {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };

            let wide_src: Vec<u16> = src.as_os_str().encode_wide().chain(Some(0)).collect();
            let wide_dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();

            let ret = MoveFileExW(
                wide_src.as_ptr(),
                wide_dest.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            );

            if ret == 0 {
                return Err(format!(
                    "Win32 MoveFileExW failed with error code: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        #[cfg(not(windows))]
        {
            fs::rename(src, dest).map_err(|e| format!("Failed to rename temp file: {}", e))
        }
    }

    fn emit_state_telemetry(
        &self,
        state: &str,
        cooldown_remaining: Option<u64>,
        error_message: Option<String>,
    ) {
        let mut last_state = self.last_emitted_state.lock();
        let force = *last_state != state;
        *last_state = state.to_string();
        drop(last_state);

        self.emit_telemetry_with_state(state, cooldown_remaining, error_message, force);
    }

    pub fn emit_telemetry(&self, force: bool) {
        let (state, cooldown) = {
            let is_playback_active = self.engine.is_playing() || self.engine.is_paused();
            let last_active = *self.last_playback_activity.lock();
            let elapsed = last_active.elapsed();
            if self.user_paused.load(Ordering::Relaxed) {
                ("user_paused", None)
            } else if is_playback_active {
                ("paused_playback", None)
            } else if elapsed < Duration::from_secs(30) {
                ("cooldown", Some(30u64.saturating_sub(elapsed.as_secs())))
            } else {
                ("writing", None)
            }
        };

        self.emit_telemetry_with_state(state, cooldown, None, force);
    }

    fn emit_telemetry_with_state(
        &self,
        state: &str,
        cooldown_remaining: Option<u64>,
        error_message: Option<String>,
        force: bool,
    ) {
        let mut last_emit = self.last_telemetry_emit.lock();
        if !force && last_emit.elapsed() < Duration::from_millis(250) {
            return;
        }
        *last_emit = std::time::Instant::now();
        drop(last_emit);

        let app_handle_opt = self.app_handle.lock().clone();
        let app = match app_handle_opt {
            Some(a) => a,
            None => return,
        };

        let summary = {
            let conn = self.db.conn.lock();
            DbOperations::get_commit_queue_summary(&conn).ok()
        };

        let pending_items = summary.as_ref().map(|s| s.pending_items).unwrap_or(0);
        let inflight_items = summary.as_ref().map(|s| s.inflight_items).unwrap_or(0);
        let completed_items = summary.as_ref().map(|s| s.completed_items).unwrap_or(0);
        let failed_items = summary.as_ref().map(|s| s.failed_items).unwrap_or(0);
        let total_items = pending_items + inflight_items + completed_items + failed_items;

        let percent = if total_items > 0 {
            (completed_items as f64 / total_items as f64) * 100.0
        } else {
            100.0
        };

        let history = self.processed_in_window.lock();
        let throughput = (history.len() as f64) / 5.0;
        drop(history);

        let active_info = self.active_item_info.lock().clone();
        let (current_track_id, current_track_title, current_track_file_path) = match active_info {
            Some((tid, title, path)) => (Some(tid), Some(title), Some(path)),
            None => (None, None, None),
        };

        let offline = self.offline_mounts.lock().iter().cloned().collect();

        let resolved_state = if total_items == 0 || (pending_items == 0 && inflight_items == 0) {
            "idle".to_string()
        } else {
            state.to_string()
        };

        let payload = CommitTelemetryPayload {
            state: resolved_state,
            active_batch_id: summary.as_ref().and_then(|s| s.active_batch_id.clone()),
            active_batch_description: summary.as_ref().and_then(|s| s.active_batch_description.clone()),
            current_track_id,
            current_track_title,
            current_track_file_path,
            pending_items,
            inflight_items,
            completed_items,
            failed_items,
            total_items,
            percent,
            throughput_items_per_sec: throughput,
            cooldown_remaining_secs: cooldown_remaining,
            offline_mounts: offline,
            error_message,
        };

        let _ = app.emit("commit://telemetry", &payload);
    }

    pub fn get_telemetry(&self) -> CommitTelemetryPayload {
        let summary = {
            let conn = self.db.conn.lock();
            DbOperations::get_commit_queue_summary(&conn).ok()
        };

        let pending_items = summary.as_ref().map(|s| s.pending_items).unwrap_or(0);
        let inflight_items = summary.as_ref().map(|s| s.inflight_items).unwrap_or(0);
        let completed_items = summary.as_ref().map(|s| s.completed_items).unwrap_or(0);
        let failed_items = summary.as_ref().map(|s| s.failed_items).unwrap_or(0);
        let total_items = pending_items + inflight_items + completed_items + failed_items;

        let percent = if total_items > 0 {
            (completed_items as f64 / total_items as f64) * 100.0
        } else {
            100.0
        };

        let is_playback_active = self.engine.is_playing() || self.engine.is_paused();
        let last_active = *self.last_playback_activity.lock();
        let elapsed = last_active.elapsed();
        let in_cooldown = !is_playback_active && elapsed < Duration::from_secs(30);

        let state = if self.user_paused.load(Ordering::Relaxed) {
            "user_paused".to_string()
        } else if total_items == 0 || (pending_items == 0 && inflight_items == 0) {
            "idle".to_string()
        } else if is_playback_active {
            "paused_playback".to_string()
        } else if in_cooldown {
            "cooldown".to_string()
        } else {
            "writing".to_string()
        };

        let cooldown_remaining_secs = if in_cooldown {
            Some(30u64.saturating_sub(elapsed.as_secs()))
        } else {
            None
        };

        let history = self.processed_in_window.lock();
        let throughput = (history.len() as f64) / 5.0;
        drop(history);

        let active_info = self.active_item_info.lock().clone();
        let (current_track_id, current_track_title, current_track_file_path) = match active_info {
            Some((tid, title, path)) => (Some(tid), Some(title), Some(path)),
            None => (None, None, None),
        };

        let offline = self.offline_mounts.lock().iter().cloned().collect();

        CommitTelemetryPayload {
            state,
            active_batch_id: summary.as_ref().and_then(|s| s.active_batch_id.clone()),
            active_batch_description: summary.as_ref().and_then(|s| s.active_batch_description.clone()),
            current_track_id,
            current_track_title,
            current_track_file_path,
            pending_items,
            inflight_items,
            completed_items,
            failed_items,
            total_items,
            percent,
            throughput_items_per_sec: throughput,
            cooldown_remaining_secs,
            offline_mounts: offline,
            error_message: None,
        }
    }
}
