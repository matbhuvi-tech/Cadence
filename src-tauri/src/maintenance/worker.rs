use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use chrono::Utc;
use image::imageops::FilterType;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::audio::AudioEngine;
use crate::db::{AppDb, DbArtworkCacheState, DbOperations};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStats {
    pub is_running: bool,
    pub is_idle: bool,
    pub status_message: String,
    pub cached_count: i64,
    pub not_found_count: i64,
    pub failed_count: i64,
    pub total_items: i64,
    pub pending_items: i64,
    pub last_processed_item: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortraitSyncProgressEvent {
    pub state: String, // "active" | "cooldown" | "paused_playback" | "complete" | "user_paused"
    pub completed: usize,
    pub total: usize,
    pub pending: usize,
    pub cooldown_remaining_secs: Option<u8>,
    pub current_artist_id: Option<String>,
    pub current_artist_name: Option<String>,
    pub resolved_portrait_url: Option<String>,
    pub provider_info: Option<String>,
    pub next_in_queue: Vec<String>,
}

#[derive(Clone)]
pub struct MaintenanceWorker {
    engine: AudioEngine,
    db: AppDb,
    cache_dir: PathBuf,
    is_running: Arc<AtomicBool>,
    user_paused: Arc<AtomicBool>,
    stats: Arc<Mutex<MaintenanceStats>>,
    last_playback_activity: Arc<Mutex<std::time::Instant>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    last_emitted_state: Arc<Mutex<String>>,
    current_artist: Arc<Mutex<Option<(String, String)>>>,
    last_resolved_info: Arc<Mutex<Option<String>>>,
}

impl MaintenanceWorker {
    pub fn new(engine: AudioEngine, db: AppDb, cache_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&cache_dir);
        let mut initial_stats = MaintenanceStats::default();
        initial_stats.status_message = "Initializing low-noise maintenance worker...".to_string();
        Self {
            engine,
            db,
            cache_dir,
            is_running: Arc::new(AtomicBool::new(false)),
            user_paused: Arc::new(AtomicBool::new(false)),
            stats: Arc::new(Mutex::new(initial_stats)),
            last_playback_activity: Arc::new(Mutex::new(std::time::Instant::now())),
            app_handle: Arc::new(Mutex::new(None)),
            last_emitted_state: Arc::new(Mutex::new(String::new())),
            current_artist: Arc::new(Mutex::new(None)),
            last_resolved_info: Arc::new(Mutex::new(None)),
        }
    }

    /// Starts the background maintenance thread with low priority and I/O isolation.
    pub fn start(&self) -> Option<JoinHandle<()>> {
        if self.is_running.swap(true, Ordering::SeqCst) {
            eprintln!("[Cadence Maintenance] Worker is already active.");
            return None;
        }

        let worker = self.clone();
        let handle = thread::Builder::new()
            .name("cadence-maintenance".into())
            .spawn(move || {
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::System::Threading::{
                        GetCurrentThread, SetThreadAffinityMask, SetThreadPriority,
                        THREAD_MODE_BACKGROUND_BEGIN, THREAD_PRIORITY_BELOW_NORMAL,
                    };

                    // 1. Drop both CPU scheduling priority AND Disk/Page I/O priority to IoPriorityVeryLow.
                    // This instructs the Windows storage subsystem that any audio engine read (play_file, VirtualLock)
                    // immediately preempts cadence-maintenance at the NVMe/SATA controller level!
                    let res = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
                    if res == 0 {
                        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
                    }

                    // 2. CPU Affinity Pinning: Pin cadence-maintenance away from Core 0 and Core 1
                    let cores = std::thread::available_parallelism()
                        .map(|n| n.get())
                        .unwrap_or(1)
                        .min(usize::BITS as usize);

                    if cores >= 4 {
                        let all: usize = if cores == usize::BITS as usize { usize::MAX } else { (1usize << cores) - 1 };
                        let mask = all & !0b11;
                        let _ = SetThreadAffinityMask(GetCurrentThread(), mask);
                    }
                }

                eprintln!("[Cadence Maintenance] Low-noise idle maintenance thread started (background I/O mode, pinned off Core 0/1).");
                worker.run_loop();
                eprintln!("[Cadence Maintenance] Maintenance thread terminated.");
            })
            .ok();

        handle
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock() = Some(handle);
    }

    pub fn toggle_pause(&self) -> bool {
        let currently_paused = self.user_paused.load(Ordering::SeqCst);
        let new_state = !currently_paused;
        self.user_paused.store(new_state, Ordering::SeqCst);
        self.emit_current_state();
        new_state
    }

    pub fn is_user_paused(&self) -> bool {
        self.user_paused.load(Ordering::Relaxed)
    }

    pub fn force_enrich_now(&self) {
        let _ = self.engine.stop();
        self.user_paused.store(false, Ordering::SeqCst);
        *self.last_playback_activity.lock() = std::time::Instant::now() - Duration::from_secs(35);
        self.emit_current_state();
    }

    pub fn get_portrait_sync_stats(&self) -> PortraitSyncProgressEvent {
        let (total, completed, pending, next_in_queue) = {
            let conn = self.db.conn.lock();
            DbOperations::get_artist_portrait_stats(&conn).unwrap_or((0, 0, 0, Vec::new()))
        };

        let user_paused = self.user_paused.load(Ordering::Relaxed);
        let status = self.engine.get_status();
        let is_active_session = status.is_playing || status.is_paused;
        let elapsed = self.last_playback_activity.lock().elapsed();
        let cooldown_rem = Duration::from_secs(30).saturating_sub(elapsed);
        let in_cooldown = !is_active_session && !cooldown_rem.is_zero();

        let state = if user_paused {
            "user_paused".to_string()
        } else if pending == 0 {
            "complete".to_string()
        } else if is_active_session {
            "paused_playback".to_string()
        } else if in_cooldown {
            "cooldown".to_string()
        } else {
            "active".to_string()
        };

        let cooldown_remaining_secs = if state == "cooldown" {
            Some(cooldown_rem.as_secs().max(1) as u8)
        } else {
            None
        };

        let current = self.current_artist.lock().clone();
        let last_resolved = self.last_resolved_info.lock().clone();

        PortraitSyncProgressEvent {
            state,
            completed,
            total,
            pending,
            cooldown_remaining_secs,
            current_artist_id: current.as_ref().map(|c| c.0.clone()),
            current_artist_name: current.as_ref().map(|c| c.1.clone()),
            resolved_portrait_url: None,
            provider_info: last_resolved,
            next_in_queue,
        }
    }

    pub fn emit_current_state(&self) {
        if let Some(app) = self.app_handle.lock().as_ref() {
            let event = self.get_portrait_sync_stats();
            *self.last_emitted_state.lock() = event.state.clone();
            let _ = app.emit("portrait-sync-progress", &event);
        }
    }

    pub fn notify_artist_portrait_resolved(
        &self,
        artist_id: &str,
        artist_name: &str,
        portrait_url: &str,
        provider_info: &str,
    ) {
        *self.last_resolved_info.lock() = Some(format!("{} (via {})", artist_name, provider_info));
        if let Some(app) = self.app_handle.lock().as_ref() {
            let mut event = self.get_portrait_sync_stats();
            event.current_artist_id = Some(artist_id.to_string());
            event.current_artist_name = Some(artist_name.to_string());
            event.resolved_portrait_url = Some(portrait_url.to_string());
            event.provider_info = Some(provider_info.to_string());

            let _ = app.emit("portrait-sync-progress", &event);
            let _ = app.emit("portrait-enriched", &serde_json::json!({
                "artistId": artist_id,
                "artistName": artist_name,
                "portraitUrl": portrait_url,
                "provider": provider_info
            }));
        }
    }

    pub fn get_stats(&self) -> MaintenanceStats {
        let mut s = self.stats.lock().clone();
        s.is_running = self.is_running.load(Ordering::Relaxed);
        let status = self.engine.get_status();
        let is_active_session = status.is_playing || status.is_paused;
        if is_active_session {
            *self.last_playback_activity.lock() = std::time::Instant::now();
        }

        let elapsed = self.last_playback_activity.lock().elapsed();
        let cooldown_remaining = Duration::from_secs(30).saturating_sub(elapsed);
        let in_cooldown = !is_active_session && !cooldown_remaining.is_zero();
        s.is_idle = !is_active_session && !in_cooldown;

        // Query current SQLite counts
        let conn = self.db.conn.lock();
        if let Ok((cached, not_found, failed, total_target, pending)) = DbOperations::get_artwork_cache_stats(&conn) {
            s.cached_count = cached;
            s.not_found_count = not_found;
            s.failed_count = failed;
            s.total_items = total_target;
            s.pending_items = pending;
        }

        if status.is_playing && !status.is_paused {
            s.status_message = "Suspended: Bit-perfect audio playback active (zero bus contention)".to_string();
        } else if status.is_paused {
            s.status_message = "Suspended: Playback session paused (listening room silence preserved)".to_string();
        } else if in_cooldown {
            s.status_message = format!("Cooling down: {}s cooldown remaining before background tasks resume", cooldown_remaining.as_secs());
        } else if s.pending_items == 0 {
            if s.not_found_count > 0 {
                s.status_message = format!("Idle: All {} albums evaluated ({} cached, {} without art)", s.total_items, s.cached_count, s.not_found_count);
            } else {
                s.status_message = format!("Idle: All {} albums pre-cached", s.total_items);
            }
        }

        s
    }

    fn is_audio_idle(&self) -> bool {
        let status = self.engine.get_status();
        // 1. Block execution if audio is playing or paused
        if status.is_playing || status.is_paused {
            *self.last_playback_activity.lock() = std::time::Instant::now();
            return false;
        }

        // 2. Require a 30-second cooldown after stopping before waking maintenance thread
        let elapsed = self.last_playback_activity.lock().elapsed();
        if elapsed < Duration::from_secs(30) {
            return false;
        }

        true
    }

    fn run_loop(&self) {
        let mut last_reported_state = String::new();

        while self.is_running.load(Ordering::Relaxed) {
            // 0. Check User Pause
            if self.user_paused.load(Ordering::Relaxed) {
                if last_reported_state != "user_paused" {
                    last_reported_state = "user_paused".to_string();
                    self.set_status("Suspended: Artist portrait sync paused by user".to_string());
                    self.emit_current_state();
                }
                thread::sleep(Duration::from_millis(1000));
                continue;
            }

            // 1. Check if all items are already complete
            let pending_count: i64 = {
                let conn = self.db.conn.lock();
                conn.query_row(
                    "SELECT COUNT(*) FROM canonical_artists WHERE portrait_status = 'pending' AND (portrait_url IS NULL OR portrait_url = '')",
                    [],
                    |r| r.get(0),
                ).unwrap_or(0)
            };

            if pending_count == 0 {
                if last_reported_state != "complete" {
                    last_reported_state = "complete".to_string();
                    self.set_status("Idle: All artist portraits synchronized".to_string());
                    self.emit_current_state();
                }
                thread::sleep(Duration::from_millis(2000));
                continue;
            }

            // 2. Check if the audio engine is idle (not playing, not paused, and past 30s cooldown)
            if !self.is_audio_idle() {
                let status = self.engine.get_status();
                let (current_state, msg) = if status.is_playing || status.is_paused {
                    *self.last_playback_activity.lock() = std::time::Instant::now();
                    (
                        "paused_playback".to_string(),
                        if !status.is_paused {
                            "Suspended: Bit-perfect audio playback active (zero bus contention)".to_string()
                        } else {
                            "Suspended: Playback session paused (listening room silence preserved)".to_string()
                        },
                    )
                } else {
                    let rem = Duration::from_secs(30).saturating_sub(self.last_playback_activity.lock().elapsed());
                    (
                        "cooldown".to_string(),
                        format!("Cooling down: {}s cooldown remaining before background tasks resume", rem.as_secs()),
                    )
                };

                self.set_status(msg);

                // Zero-polling contract: Emit only on state transition to preserve quiet bus
                if last_reported_state != current_state {
                    last_reported_state = current_state;
                    self.emit_current_state();
                }

                thread::sleep(Duration::from_millis(1000));
                continue;
            }

            // 2. Audio is idle (>30s cooldown elapsed):
            // Check for pending artist portraits
            let next_artist = {
                let conn = self.db.conn.lock();
                DbOperations::get_pending_portrait_artists(&conn, 1)
                    .ok()
                    .and_then(|mut v| v.pop())
            };

            if let Some((artist_id, artist_name)) = next_artist {
                *self.current_artist.lock() = Some((artist_id.clone(), artist_name.clone()));
                if last_reported_state != "active" {
                    last_reported_state = "active".to_string();
                }
                self.set_status(format!("Active: Enriching portrait for {}", artist_name));
                self.emit_current_state();

                // Wait for the active item to be processed or timeout (up to 5 seconds)
                // Low-noise pacing between artists (500ms) to ensure bus silence
                for _ in 0..5 {
                    if !self.is_running.load(Ordering::Relaxed) || !self.is_audio_idle() || self.user_paused.load(Ordering::Relaxed) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(500));
                    let still_pending = {
                        let conn = self.db.conn.lock();
                        conn.query_row(
                            "SELECT COUNT(*) FROM canonical_artists WHERE id = ?1 AND portrait_status = 'pending'",
                            rusqlite::params![artist_id],
                            |r| r.get::<_, i64>(0),
                        ).unwrap_or(0) > 0
                    };
                    if !still_pending {
                        break;
                    }
                }
                *self.current_artist.lock() = None;
                continue;
            }

            // If no pending artists, check if we just completed
            if last_reported_state == "active" || last_reported_state == "cooldown" || last_reported_state == "paused_playback" || last_reported_state == "" {
                last_reported_state = "complete".to_string();
                self.emit_current_state();
            }

            // 3. Audio is idle: do a unit of artwork maintenance work
            let processed_something = self.process_next_artwork_item();

            if processed_something {
                // Low-noise cooldown between items (100ms) to ensure zero thermal/fan disruption
                thread::sleep(Duration::from_millis(100));
            } else {
                self.set_status("Idle: All artist portraits and album covers up-to-date".to_string());
                // No pending items to process: sleep longer before checking for new files
                for _ in 0..20 {
                    if !self.is_running.load(Ordering::Relaxed) || !self.is_audio_idle() || self.user_paused.load(Ordering::Relaxed) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(1000));
                }
            }
        }
    }

    fn set_status(&self, message: String) {
        let mut s = self.stats.lock();
        s.status_message = message;
    }

    /// Process a single pending release or track. Returns true if an item was processed.
    fn process_next_artwork_item(&self) -> bool {
        // Double-check engine is still idle before acquiring DB lock
        if !self.is_audio_idle() {
            return false;
        }

        // Priority 1: Check pending releases
        let pending_release = {
            let conn = self.db.conn.lock();
            DbOperations::get_pending_artwork_releases(&conn, 1)
                .ok()
                .and_then(|mut v| v.pop())
        };

        if let Some((release_id, folder_path, sample_track)) = pending_release {
            self.process_release_artwork(&release_id, &folder_path, sample_track.as_deref());
            return true;
        }

        // Priority 2: Check pending individual tracks with embedded art
        let pending_track = {
            let conn = self.db.conn.lock();
            DbOperations::get_pending_artwork_tracks(&conn, 1)
                .ok()
                .and_then(|mut v| v.pop())
        };

        if let Some((track_id, _release_id, file_path, mtime)) = pending_track {
            self.process_track_artwork(&track_id, &file_path, mtime);
            return true;
        }

        false
    }

    fn safe_id(id: &str) -> String {
        id.chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect()
    }

    fn process_release_artwork(&self, release_id: &str, folder_path_str: &str, sample_track_path: Option<&str>) {
        if !self.is_audio_idle() {
            return;
        }

        let safe_id = Self::safe_id(release_id);
        let thumb_filename = format!("{}.jpg", safe_id);
        let thumb_path = self.cache_dir.join(&thumb_filename);
        let now = Utc::now().to_rfc3339();

        // 1. If 300x300 thumbnail already exists on disk (e.g. from runtime browsing), record state in SQLite
        if thumb_path.is_file() {
            let file_size = fs::metadata(&thumb_path).map(|m| m.len() as i64).ok();
            let state = DbArtworkCacheState {
                id: release_id.to_string(),
                entity_type: "release".to_string(),
                source_path: folder_path_str.to_string(),
                cache_path: Some(thumb_path.to_string_lossy().to_string()),
                status: "cached".to_string(),
                source_mtime: 0,
                file_size,
                width: Some(300),
                height: Some(300),
                checked_at: now,
            };
            let conn = self.db.conn.lock();
            let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
            let _ = DbOperations::update_release_front_cover_url(&conn, release_id, &thumb_path.to_string_lossy());
            self.update_last_item(format!("Release (disk hit): {}", release_id));
            return;
        }

        // 2. Thumbnail is missing: search for source cover art
        let folder_path = Path::new(folder_path_str);
        let mut raw_bytes: Option<Vec<u8>> = None;
        let mut source_mtime: i64 = 0;

        // A. Check folder images first
        if folder_path.is_dir() {
            let candidates = [
                "cover.jpg", "folder.jpg", "front.jpg", "album.jpg",
                "cover.png", "folder.png", "front.png", "Cover.jpg",
                "Folder.jpg", "Front.jpg", "cover.jpeg", "front.jpeg"
            ];
            for cand in candidates {
                let img_path = folder_path.join(cand);
                if img_path.is_file() {
                    if let Ok(b) = fs::read(&img_path) {
                        source_mtime = fs::metadata(&img_path)
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        raw_bytes = Some(b);
                        break;
                    }
                }
            }
        }

        // B. If not in folder, extract from sample track embedded tag
        if raw_bytes.is_none() {
            if let Some(track_path_str) = sample_track_path {
                let t_path = Path::new(track_path_str);
                if t_path.is_file() {
                    let ext_lower = t_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    if ext_lower == "dsf" {
                        raw_bytes = extract_dsf_artwork(t_path);
                    }
                    if raw_bytes.is_none() {
                        if let Ok(tagged_file) = Probe::open(t_path).and_then(|p| p.read()) {
                            if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                                if let Some(pic) = tag.pictures().first() {
                                    raw_bytes = Some(pic.data().to_vec());
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Generate 300x300 thumbnail or record not_found
        match raw_bytes {
            Some(data) => {
                // Ensure audio is still idle before CPU resize
                if !self.is_audio_idle() {
                    return;
                }

                if let Some((thumb_bytes, w, h)) = Self::resize_to_thumbnail(&data, 300) {
                    if fs::write(&thumb_path, &thumb_bytes).is_ok() {
                        let state = DbArtworkCacheState {
                            id: release_id.to_string(),
                            entity_type: "release".to_string(),
                            source_path: folder_path_str.to_string(),
                            cache_path: Some(thumb_path.to_string_lossy().to_string()),
                            status: "cached".to_string(),
                            source_mtime,
                            file_size: Some(thumb_bytes.len() as i64),
                            width: Some(w),
                            height: Some(h),
                            checked_at: now,
                        };
                        let conn = self.db.conn.lock();
                        let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
                        let _ = DbOperations::update_release_front_cover_url(&conn, release_id, &thumb_path.to_string_lossy());
                        self.update_last_item(format!("Release: {} (300x300 generated)", release_id));
                        return;
                    }
                }

                // Failed decode or write
                let state = DbArtworkCacheState {
                    id: release_id.to_string(),
                    entity_type: "release".to_string(),
                    source_path: folder_path_str.to_string(),
                    cache_path: None,
                    status: "failed".to_string(),
                    source_mtime,
                    file_size: None,
                    width: None,
                    height: None,
                    checked_at: now,
                };
                let conn = self.db.conn.lock();
                let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
                self.update_last_item(format!("Release: {} (failed to decode)", release_id));
            }
            None => {
                // No artwork found anywhere in folder or tags
                let state = DbArtworkCacheState {
                    id: release_id.to_string(),
                    entity_type: "release".to_string(),
                    source_path: folder_path_str.to_string(),
                    cache_path: None,
                    status: "not_found".to_string(),
                    source_mtime: 0,
                    file_size: None,
                    width: None,
                    height: None,
                    checked_at: now,
                };
                let conn = self.db.conn.lock();
                let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
                self.update_last_item(format!("Release: {} (no art found)", release_id));
            }
        }
    }

    fn process_track_artwork(&self, track_id: &str, file_path_str: &str, mtime: i64) {
        if !self.is_audio_idle() {
            return;
        }

        let safe_id = Self::safe_id(track_id);
        let thumb_filename = format!("{}.jpg", safe_id);
        let thumb_path = self.cache_dir.join(&thumb_filename);
        let now = Utc::now().to_rfc3339();

        // 1. If already cached on disk, record state
        if thumb_path.is_file() {
            let file_size = fs::metadata(&thumb_path).map(|m| m.len() as i64).ok();
            let state = DbArtworkCacheState {
                id: track_id.to_string(),
                entity_type: "track".to_string(),
                source_path: file_path_str.to_string(),
                cache_path: Some(thumb_path.to_string_lossy().to_string()),
                status: "cached".to_string(),
                source_mtime: mtime,
                file_size,
                width: Some(300),
                height: Some(300),
                checked_at: now,
            };
            let conn = self.db.conn.lock();
            let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
            self.update_last_item(format!("Track (disk hit): {}", track_id));
            return;
        }

        // 2. Release-level Deduplication:
        // Check if track belongs to a release that already has cached artwork!
        let parent_cached_thumb = {
            let conn = self.db.conn.lock();
            let stmt = conn.prepare(
                "SELECT r.id FROM releases r 
                 JOIN tracks t ON t.release_id = r.id 
                 WHERE t.id = ?1 LIMIT 1"
            ).ok();
            stmt.and_then(|mut s| {
                s.query_row(rusqlite::params![track_id], |row| row.get::<_, String>(0)).ok()
            }).and_then(|rel_id| {
                let rel_thumb = self.cache_dir.join(format!("{}.jpg", Self::safe_id(&rel_id)));
                if rel_thumb.is_file() {
                    Some(rel_thumb)
                } else {
                    None
                }
            })
        };

        if let Some(rel_thumb_path) = parent_cached_thumb {
            // Parent album already cached! Link track without re-reading audio file from E:\!
            let file_size = fs::metadata(&rel_thumb_path).map(|m| m.len() as i64).ok();
            let state = DbArtworkCacheState {
                id: track_id.to_string(),
                entity_type: "track".to_string(),
                source_path: file_path_str.to_string(),
                cache_path: Some(rel_thumb_path.to_string_lossy().to_string()),
                status: "cached".to_string(),
                source_mtime: mtime,
                file_size,
                width: Some(300),
                height: Some(300),
                checked_at: now,
            };
            let conn = self.db.conn.lock();
            let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
            self.update_last_item(format!("Track (inherited from album): {}", track_id));
            return;
        }

        // 3. Extract embedded tag picture (checking DSF metadata offset directly)
        let audio_path = Path::new(file_path_str);
        if !audio_path.is_file() {
            let state = DbArtworkCacheState {
                id: track_id.to_string(),
                entity_type: "track".to_string(),
                source_path: file_path_str.to_string(),
                cache_path: None,
                status: "not_found".to_string(),
                source_mtime: mtime,
                file_size: None,
                width: None,
                height: None,
                checked_at: now,
            };
            let conn = self.db.conn.lock();
            let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
            return;
        }

        let raw_bytes: Option<Vec<u8>> = (|| {
            let ext_lower = audio_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if ext_lower == "dsf" {
                if let Some(dsf_art) = extract_dsf_artwork(audio_path) {
                    return Some(dsf_art);
                }
            }

            if let Ok(tagged_file) = Probe::open(audio_path).and_then(|p| p.read()) {
                if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                    if let Some(pic) = tag.pictures().first() {
                        return Some(pic.data().to_vec());
                    }
                }
            }
            None
        })();

        match raw_bytes {
            Some(data) => {
                if !self.is_audio_idle() {
                    return;
                }

                if let Some((thumb_bytes, w, h)) = Self::resize_to_thumbnail(&data, 300) {
                    if fs::write(&thumb_path, &thumb_bytes).is_ok() {
                        let state = DbArtworkCacheState {
                            id: track_id.to_string(),
                            entity_type: "track".to_string(),
                            source_path: file_path_str.to_string(),
                            cache_path: Some(thumb_path.to_string_lossy().to_string()),
                            status: "cached".to_string(),
                            source_mtime: mtime,
                            file_size: Some(thumb_bytes.len() as i64),
                            width: Some(w),
                            height: Some(h),
                            checked_at: now,
                        };
                        let conn = self.db.conn.lock();
                        let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
                        self.update_last_item(format!("Track: {} (300x300 generated)", track_id));
                        return;
                    }
                }

                let state = DbArtworkCacheState {
                    id: track_id.to_string(),
                    entity_type: "track".to_string(),
                    source_path: file_path_str.to_string(),
                    cache_path: None,
                    status: "failed".to_string(),
                    source_mtime: mtime,
                    file_size: None,
                    width: None,
                    height: None,
                    checked_at: now,
                };
                let conn = self.db.conn.lock();
                let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
            }
            None => {
                let state = DbArtworkCacheState {
                    id: track_id.to_string(),
                    entity_type: "track".to_string(),
                    source_path: file_path_str.to_string(),
                    cache_path: None,
                    status: "not_found".to_string(),
                    source_mtime: mtime,
                    file_size: None,
                    width: None,
                    height: None,
                    checked_at: now,
                };
                let conn = self.db.conn.lock();
                let _ = DbOperations::upsert_artwork_cache_state(&conn, &state);
            }
        }
    }

    fn resize_to_thumbnail(raw_data: &[u8], max_dim: u32) -> Option<(Vec<u8>, u32, u32)> {
        if let Ok(img) = image::load_from_memory(raw_data) {
            let thumb = img.resize(max_dim, max_dim, FilterType::Triangle);
            let w = thumb.width();
            let h = thumb.height();
            let mut out = Cursor::new(Vec::new());
            if thumb.write_to(&mut out, image::ImageFormat::Jpeg).is_ok() {
                return Some((out.into_inner(), w, h));
            }
        }
        None
    }

    fn update_last_item(&self, item: String) {
        let mut s = self.stats.lock();
        s.last_processed_item = Some(item);
    }
}

/// Extracts embedded cover art from a Sony DSF file by seeking directly to
/// the metadata chunk pointer at bytes 20..28, bypassing multi-hundred megabyte audio streams.
pub fn extract_dsf_artwork(path: &Path) -> Option<Vec<u8>> {
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 80];
    file.read_exact(&mut header).ok()?;

    if &header[0..4] != b"DSD " {
        return None;
    }

    let metadata_offset = u64::from_le_bytes(header[20..28].try_into().ok()?);
    if metadata_offset == 0 {
        return None;
    }

    let file_len = file.metadata().ok()?.len();
    if metadata_offset >= file_len {
        return None;
    }

    file.seek(SeekFrom::Start(metadata_offset)).ok()?;

    let mut id3_hdr = [0u8; 10];
    file.read_exact(&mut id3_hdr).ok()?;
    if &id3_hdr[0..3] != b"ID3" {
        return None;
    }

    let version_major = id3_hdr[3]; // e.g. 3 for ID3v2.3, 4 for ID3v2.4
    let tag_size = ((id3_hdr[6] as usize & 0x7F) << 21)
        | ((id3_hdr[7] as usize & 0x7F) << 14)
        | ((id3_hdr[8] as usize & 0x7F) << 7)
        | (id3_hdr[9] as usize & 0x7F);

    if tag_size == 0 || tag_size > 32 * 1024 * 1024 {
        return None;
    }

    let mut tag_data = vec![0u8; tag_size];
    file.read_exact(&mut tag_data).ok()?;

    // Search frames for APIC (Attached Picture)
    let mut cursor = 0;
    while cursor + 10 <= tag_data.len() {
        let frame_id = &tag_data[cursor..cursor + 4];
        if frame_id == b"\0\0\0\0" {
            break;
        }

        let frame_size = if version_major == 4 {
            // Synchsafe integer in ID3v2.4
            ((tag_data[cursor + 4] as usize & 0x7F) << 21)
                | ((tag_data[cursor + 5] as usize & 0x7F) << 14)
                | ((tag_data[cursor + 6] as usize & 0x7F) << 7)
                | (tag_data[cursor + 7] as usize & 0x7F)
        } else {
            // Standard big-endian u32 in ID3v2.3
            u32::from_be_bytes(tag_data[cursor + 4..cursor + 8].try_into().unwrap_or([0; 4])) as usize
        };

        let frame_header_size = 10;
        let frame_end = cursor + frame_header_size + frame_size;
        if frame_end > tag_data.len() {
            break;
        }

        if frame_id == b"APIC" {
            let apic_data = &tag_data[cursor + frame_header_size..frame_end];
            // Locate raw image bytes inside the APIC frame.
            // JPEG magic: [0xFF, 0xD8, 0xFF]
            // PNG magic: [0x89, 0x50, 0x4E, 0x47]
            if let Some(pos) = find_subsequence(apic_data, &[0xFF, 0xD8, 0xFF]) {
                return Some(apic_data[pos..].to_vec());
            } else if let Some(pos) = find_subsequence(apic_data, &[0x89, 0x50, 0x4E, 0x47]) {
                return Some(apic_data[pos..].to_vec());
            }
        }

        cursor = frame_end;
    }

    None
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}
