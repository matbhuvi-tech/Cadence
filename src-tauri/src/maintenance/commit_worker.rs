use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagExt, TagItem};
use parking_lot::Mutex;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

use crate::audio::AudioEngine;
use crate::db::{AppDb, DbOperations};

struct CommitWriteError {
    message: String,
    mount_unavailable: bool,
}

impl From<String> for CommitWriteError {
    fn from(message: String) -> Self {
        Self { message, mount_unavailable: false }
    }
}

impl From<&str> for CommitWriteError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl CommitWriteError {
    fn storage(operation: &str, error: &std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let mut mount_unavailable = matches!(error.kind(),
            NotConnected | NetworkUnreachable | HostUnreachable | ConnectionAborted | ConnectionReset | TimedOut);
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{
                ERROR_BAD_NETPATH, ERROR_BAD_NET_NAME, ERROR_CONNECTION_UNAVAIL,
                ERROR_DEVICE_NOT_CONNECTED, ERROR_NETNAME_DELETED, ERROR_NOT_READY,
            };
            mount_unavailable |= error.raw_os_error().is_some_and(|code| matches!(code as u32,
                ERROR_BAD_NETPATH | ERROR_BAD_NET_NAME | ERROR_CONNECTION_UNAVAIL |
                ERROR_DEVICE_NOT_CONNECTED | ERROR_NETNAME_DELETED | ERROR_NOT_READY));
        }
        Self { message: format!("{operation}: {error}"), mount_unavailable }
    }

    fn tag(operation: &str, error: lofty::error::LoftyError) -> Self {
        match error.kind() {
            lofty::error::ErrorKind::Io(io) => Self::storage(operation, io),
            _ => format!("{operation}: {error}").into(),
        }
    }
}

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

type TelemetrySink = Arc<dyn Fn(&CommitTelemetryPayload) + Send + Sync>;

struct PreparedCover {
    id: String,
    source: String,
    jpeg: Vec<u8>,
    thumbnail_url: String,
}

const MAX_COVER_BYTES: usize = 8 * 1024 * 1024;

fn load_cover_bytes(source: &str) -> Result<Vec<u8>, String> {
    if source.starts_with("data:") {
        let (kind, encoded) = source.split_once(";base64,")
            .ok_or_else(|| "Invalid cover image data.".to_string())?;
        if !matches!(kind.to_ascii_lowercase().as_str(), "data:image/jpeg" | "data:image/png") {
            return Err("Only JPEG and PNG cover images are supported.".into());
        }
        if encoded.len() > MAX_COVER_BYTES.div_ceil(3) * 4 {
            return Err("The selected cover exceeds 8 MiB.".into());
        }
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|_| "Invalid cover image data.".to_string())?;
        if bytes.len() > MAX_COVER_BYTES {
            return Err("The selected cover exceeds 8 MiB.".into());
        }
        return Ok(bytes);
    }

    let url = reqwest::Url::parse(source).map_err(|_| "Invalid cover URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err("The cover URL must be HTTP or HTTPS without embedded credentials.".into());
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|err| format!("Could not start cover download: {err}"))?;
    runtime.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build().map_err(|err| format!("Could not start cover download: {}", err.without_url()))?;
        let mut response = client.get(url).send().await.and_then(|response| response.error_for_status())
            .map_err(|err| format!("Could not download the selected cover: {}", err.without_url()))?;
        if response.content_length().is_some_and(|size| size > MAX_COVER_BYTES as u64) {
            return Err("The selected cover exceeds 8 MiB.".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await
            .map_err(|err| format!("The cover download was interrupted: {}", err.without_url()))? {
            if chunk.len() > MAX_COVER_BYTES - bytes.len() {
                return Err("The selected cover exceeds 8 MiB.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    })
}

#[derive(Clone)]
pub struct CommitQueueWorker {
    playback_active: Arc<dyn Fn() -> bool + Send + Sync>,
    db: AppDb,
    is_running: Arc<AtomicBool>,
    user_paused: Arc<AtomicBool>,
    telemetry_sink: Arc<Mutex<Option<TelemetrySink>>>,
    last_telemetry_emit: Arc<Mutex<std::time::Instant>>,
    last_emitted_state: Arc<Mutex<String>>,
    offline_mounts: Arc<Mutex<HashSet<String>>>,
    mount_failure_counts: Arc<Mutex<HashMap<String, u32>>>,
    active_item_info: Arc<Mutex<Option<(String, String, String)>>>, // (track_id, title, file_path)
    processed_in_window: Arc<Mutex<Vec<std::time::Instant>>>,
    written_artwork_dirs: Arc<Mutex<HashSet<std::path::PathBuf>>>,
    prepared_cover: Arc<Mutex<Option<Arc<PreparedCover>>>>,
    current_active_batch_id: Arc<Mutex<Option<String>>>,
}

impl CommitQueueWorker {
    pub fn new(engine: AudioEngine, db: AppDb) -> Self {
        Self::with_playback_gate(db, move || engine.is_playing() || engine.is_paused())
    }

    fn with_playback_gate(db: AppDb, playback_active: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            playback_active: Arc::new(playback_active),
            db,
            is_running: Arc::new(AtomicBool::new(false)),
            user_paused: Arc::new(AtomicBool::new(false)),
            telemetry_sink: Arc::new(Mutex::new(None)),
            last_telemetry_emit: Arc::new(Mutex::new(std::time::Instant::now() - Duration::from_secs(1))),
            last_emitted_state: Arc::new(Mutex::new(String::new())),
            offline_mounts: Arc::new(Mutex::new(HashSet::new())),
            mount_failure_counts: Arc::new(Mutex::new(HashMap::new())),
            active_item_info: Arc::new(Mutex::new(None)),
            processed_in_window: Arc::new(Mutex::new(Vec::new())),
            written_artwork_dirs: Arc::new(Mutex::new(HashSet::new())),
            prepared_cover: Arc::new(Mutex::new(None)),
            current_active_batch_id: Arc::new(Mutex::new(None)),
        }
    }

    /// Creates a CommitQueueWorker with its own dedicated SQLite connection,
    /// isolating worker writes and SQLite locks from the UI thread's read connection.
    pub fn from_db_path(engine: AudioEngine, db_path: std::path::PathBuf) -> Result<Self, String> {
        let db = AppDb::open_dedicated(&db_path)?;
        Ok(Self::new(engine, db))
    }

    /// Safely acquires the worker's dedicated SQLite connection with a 5-second timeout guard.
    /// Panics immediately with a clear diagnostic if an accidental re-entrant call or deadlock occurs.
    fn lock_db(&self) -> parking_lot::MutexGuard<'_, rusqlite::Connection> {
        self.db.conn
            .try_lock_for(Duration::from_secs(5))
            .expect("[CommitQueueWorker] Deadlock detected: DB Mutex lock timed out after 5 seconds")
    }

    fn batch_progress(
        &self,
        summary: Option<&crate::db::CommitQueueSummary>,
    ) -> (i64, i64, i64, i64) {
        let conn = self.lock_db();
        DbOperations::get_commit_batch_progress(
            &conn,
            summary.and_then(|s| s.active_batch_id.as_deref()),
        )
        .unwrap_or((0, 0, 0, 0))
    }

    /// Performs startup crash recovery: sweeps `in_flight` items in SQLite and deletes orphaned temp files.
    pub fn perform_startup_recovery(&self) {
        let requeued_res = {
            let conn = self.lock_db();
            DbOperations::requeue_inflight_commit_items_sweep(&conn)
        };
        match requeued_res {
            Ok(requeued) => {
                for item in requeued {
                    let path = Path::new(&item.file_path);
                    if let Some(parent) = path.parent() {
                        if let Ok(entries) = fs::read_dir(parent) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let fname = entry.file_name().to_string_lossy().to_string();
                                if fname.contains(".cadence-tmp-") {
                                    if let Err(e) = fs::remove_file(entry.path()) {
                                        eprintln!("[CommitQueueWorker] Failed to clean orphaned temp file {:?}: {}", entry.path(), e);
                                    } else {
                                        eprintln!("[CommitQueueWorker] Cleaned orphaned temp file: {:?}", entry.path());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[CommitQueueWorker] Failed to sweep in_flight items on startup: {}", e);
            }
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.telemetry_sink.lock() = Some(Arc::new(move |payload| {
            let _ = handle.emit("commit://telemetry", payload);
        }));
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
            // Fetch summary to check if there is work to do
            let summary = {
                let conn = self.lock_db();
                DbOperations::get_commit_queue_summary(&conn).ok()
            };

            let pending_count = summary.as_ref().map(|s| s.pending_items).unwrap_or(0);
            if pending_count == 0 {
                *self.active_item_info.lock() = None;
                self.emit_state_telemetry("idle", None, None);
                thread::sleep(Duration::from_millis(500));
                continue;
            }

            if (self.playback_active)() {
                *self.active_item_info.lock() = None;
                self.emit_state_telemetry("paused_playback", None, None);
                thread::sleep(Duration::from_millis(250));
                continue;
            }

            // 3. Excluded mounts check
            let excluded: Vec<String> = self.offline_mounts.lock().iter().cloned().collect();

            // Fetch and claim under one transaction so edits cannot replace a claimed payload.
            let next_item = {
                let conn = self.lock_db();
                DbOperations::claim_next_commit_item(&conn, &excluded)
            };

            let (item, inflight_summary) = match next_item {
                Ok(Some(claimed)) => claimed,
                Err(err) => {
                    eprintln!("[CommitQueueWorker] Could not claim next item: {}", err);
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }
                Ok(None) => {
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
                    *self.prepared_cover.lock() = None;
                }
            }

            // Parse payload for track info
            let payload: serde_json::Value = serde_json::from_str(&item.payload_json).unwrap_or_default();
            let track_title = payload
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("Unknown Track")
                .to_string();

            *self.active_item_info.lock() = Some((item.track_id.clone(), track_title.clone(), item.file_path.clone()));

            self.emit_telemetry_with_summary(&inflight_summary, "writing", None, None, true);

            // 6. Execute atomic write
            let write_result = self.process_commit_item(&item, &payload);

            // 7. Update status based on result using single atomic lock acquisition
            match write_result {
                Ok(bytes) => {
                    let summary_res = {
                        let conn = self.lock_db();
                        DbOperations::complete_commit_item_and_get_summary(&conn, &item.id, bytes)
                    };

                    // Clear any failure count for this mount
                    self.mount_failure_counts.lock().remove(&item.mount_id);

                    // Record throughput timestamp
                    {
                        let mut history = self.processed_in_window.lock();
                        let now = std::time::Instant::now();
                        history.push(now);
                        history.retain(|t| now.duration_since(*t) <= Duration::from_secs(5));
                    }

                    match summary_res {
                        Ok(summary) => {
                            self.emit_telemetry_with_summary(&summary, "writing", None, None, false);
                        }
                        Err(e) => {
                            eprintln!("[CommitQueueWorker] Critical: Failed to mark item {} completed: {}", item.id, e);
                        }
                    }
                }
                Err(error) => {
                    let err_msg = error.message;
                    eprintln!("[CommitQueueWorker] Failed to write track {}: {}", item.file_path, err_msg);
                    let summary_res = {
                        let conn = self.lock_db();
                        DbOperations::fail_commit_item_and_get_summary(&conn, &item.id, &err_msg)
                    };

                    // A per-file tag error is evidence that the mount was reachable.
                    let mut failures = self.mount_failure_counts.lock();
                    if error.mount_unavailable {
                        let count = failures.entry(item.mount_id.clone()).or_insert(0);
                        *count += 1;
                        if *count >= 3 {
                            self.offline_mounts.lock().insert(item.mount_id.clone());
                            eprintln!(
                                "[CommitQueueWorker] Mount {} was unavailable for 3 consecutive writes. Isolating mount.",
                                item.mount_id
                            );
                        }
                    } else {
                        failures.remove(&item.mount_id);
                    }
                    drop(failures);

                    match summary_res {
                        Ok(summary) => {
                            self.emit_telemetry_with_summary(&summary, "writing", None, Some(err_msg), true);
                        }
                        Err(e) => {
                            eprintln!("[CommitQueueWorker] Critical: Failed to mark item {} failed: {}", item.id, e);
                        }
                    }
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
    ) -> Result<i64, CommitWriteError> {
        let curate = payload.get("curate").and_then(|value| value.as_bool()).unwrap_or(false);
        if curate {
            let conn = self.lock_db();
            let locked = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM storage_mounts WHERE id = ?1 AND is_readonly_locked = 1)",
                [&item.mount_id],
                |row| row.get::<_, bool>(0),
            ).map_err(|err| err.to_string())?;
            if locked {
                return Err("This storage mount is locked read-only.".into());
            }
        }
        let destination = payload.get("destination").and_then(|d| d.as_str()).unwrap_or("embedded");
        let target_path = Path::new(&item.file_path);

        fs::metadata(target_path).map_err(|error| CommitWriteError::storage("Could not access the target file", &error))?;

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
            if let Some(orig_album) = payload.get("originalAlbum").and_then(|s| s.as_str()) {
                sidecar_val["originalAlbum"] = serde_json::json!(orig_album);
            }
            if let Some(orig_year) = payload.get("originalYear").and_then(|v| v.as_i64()) {
                sidecar_val["originalYear"] = serde_json::json!(orig_year);
            }

            let sidecar_str = serde_json::to_string_pretty(&sidecar_val)
                .map_err(|e| format!("Failed to serialize sidecar: {}", e))?;
            fs::write(&temp_sidecar, sidecar_str)
                .map_err(|error| CommitWriteError::storage("Failed to write temp sidecar", &error))?;

            Self::atomic_replace_file(&temp_sidecar, &sidecar_path)
                .map_err(|error| CommitWriteError::storage("Failed to replace the sidecar", &error))?;

            // Update SQLite track status
            {
                let conn = self.lock_db();
                if let Err(e) = conn.execute(
                    "UPDATE tracks SET sidecar_status = 'synced' WHERE id = ?1",
                    rusqlite::params![item.track_id],
                ) {
                    eprintln!("[CommitQueueWorker] Warning: Failed to update sidecar sync status for track {}: {}", item.track_id, e);
                }
            }

            let bytes = fs::metadata(&sidecar_path).map(|m| m.len() as i64).unwrap_or(0);
            return Ok(bytes);
        }

        let artwork = if curate {
            payload.get("coverArtUrl").and_then(|value| value.as_str())
                .map(|source| self.prepare_cover(source, &item.batch_id)).transpose()?
        } else {
            None
        };

        // Artwork retrieval can take several seconds. Re-check playback before touching the file.
        while (self.playback_active)() || self.user_paused.load(Ordering::Relaxed) {
            if !self.is_running.load(Ordering::Relaxed) {
                return Err("The worker stopped before the file write.".into());
            }
            let state = if (self.playback_active)() { "paused_playback" } else { "user_paused" };
            self.emit_state_telemetry(state, None, None);
            thread::sleep(Duration::from_millis(250));
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
            .map_err(|error| CommitWriteError::storage("Failed to copy to temp file", &error))?;

        // Open temp file with Lofty and apply metadata updates
        let write_tags_res = (|| -> Result<(), CommitWriteError> {
            let read_tags = || Probe::open(&temp_path)?.read();
            let mut repaired = super::wav_date_repair::RepairedDates::default();
            let mut tagged_file = match read_tags() {
                Err(error) if ext.eq_ignore_ascii_case("wav")
                    && matches!(error.kind(), lofty::error::ErrorKind::BadTimestamp(_)) => {
                    repaired = super::wav_date_repair::remove_malformed_dates(
                        &temp_path, payload.get("year").and_then(|value| value.as_i64()),
                        payload.get("originalYear").and_then(|value| value.as_i64()),
                    ).map_err(|error| CommitWriteError::storage("Could not repair the staged WAV date", &error))?;
                    if !repaired.any() {
                        return Err(CommitWriteError::tag("Lofty read tags failed", error));
                    }
                    read_tags().map_err(|error| CommitWriteError::tag("Could not read the repaired WAV tags", error))?
                }
                result => result.map_err(|error| CommitWriteError::tag("Lofty read tags failed", error))?,
            };

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
            if let Some(orig_album) = payload.get("originalAlbum").and_then(|s| s.as_str()) {
                tag.insert(TagItem::new(ItemKey::OriginalAlbumTitle, ItemValue::Text(orig_album.to_string())));
            }
            if let Some(orig_year) = payload.get("originalYear").and_then(|v| v.as_i64()) {
                tag.insert(TagItem::new(ItemKey::OriginalReleaseDate, ItemValue::Text(orig_year.to_string())));
            }
            if let Some(cover) = &artwork {
                let mut picture = Picture::from_reader(&mut cover.jpeg.as_slice())
                    .map_err(|err| format!("Could not prepare the embedded cover: {err}"))?;
                picture.set_pic_type(PictureType::CoverFront);
                tag.remove_picture_type(PictureType::CoverFront);
                tag.push_picture(picture);
            }

            tag.save_to_path(&temp_path, WriteOptions::default())
                .map_err(|error| CommitWriteError::tag("Lofty save_to_path failed", error))?;

            if artwork.is_some() || repaired.any() {
                let verified = read_tags()
                    .map_err(|error| CommitWriteError::tag("Could not verify the staged tags", error))?;
                let verified_tag = verified.primary_tag().or_else(|| verified.first_tag())
                    .ok_or("The audio format did not retain the staged tags.")?;
                if let Some(cover) = &artwork {
                    if !verified_tag.pictures().iter().any(|pic|
                        pic.pic_type() == PictureType::CoverFront && pic.data() == cover.jpeg) {
                        return Err("The audio format did not retain the selected front cover.".into());
                    }
                }
                if (repaired.year && verified_tag.year().map(i64::from) != payload["year"].as_i64())
                    || (repaired.original_year && verified_tag.get_string(&ItemKey::OriginalReleaseDate)
                        .and_then(|date| date.parse::<i64>().ok()) != payload["originalYear"].as_i64()) {
                    return Err("The WAV did not retain the confirmed replacement date.".into());
                }
            }
            Ok(())
        })();

        if let Err(e) = write_tags_res {
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        // Atomic swap into place
        if let Err(error) = Self::atomic_replace_file(&temp_path, target_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(CommitWriteError::storage("Failed to replace the audio file", &error));
        }

        // Write cover.jpg to album directory if staged artwork data URL is provided (deduplicated per batch)
        if let Some(cover_data) = payload.get("coverArtUrl").and_then(|s| s.as_str()).filter(|_| !curate) {
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
            let conn = self.lock_db();
            let update_cache = |conn: &rusqlite::Connection| -> rusqlite::Result<()> {
                conn.execute(
                "UPDATE tracks SET
                    title = COALESCE(?1, title),
                    artist_credit = COALESCE(?2, artist_credit),
                    album_title = COALESCE(?3, album_title),
                    album_artist = COALESCE(?4, album_artist),
                    composer = COALESCE(?5, composer),
                    release_year = COALESCE(?6, release_year),
                    track_number = COALESCE(?7, track_number),
                    genre = COALESCE(?8, genre),
                    original_album = COALESCE(?9, original_album),
                    original_year = COALESCE(?10, original_year),
                    sidecar_status = 'synced'
                 WHERE id = ?11",
                rusqlite::params![
                    payload.get("title").and_then(|s| s.as_str()),
                    payload.get("artist").or_else(|| payload.get("artistCredit")).and_then(|s| s.as_str()),
                    payload.get("album").and_then(|s| s.as_str()),
                    payload.get("albumArtist").and_then(|s| s.as_str()),
                    payload.get("composer").or_else(|| payload.get("composerName")).and_then(|s| s.as_str()),
                    payload.get("year").and_then(|v| v.as_i64()),
                    payload.get("trackNumber").and_then(|v| v.as_i64()),
                    payload.get("genre").and_then(|s| s.as_str()),
                    payload.get("originalAlbum").and_then(|s| s.as_str()),
                    payload.get("originalYear").and_then(|v| v.as_i64()),
                    item.track_id,
                ],
                )?;
                if curate {
                    conn.execute(
                        "UPDATE releases SET title = COALESCE(?1, title),
                            artist_credit = COALESCE(?2, artist_credit),
                            composer_name = COALESCE(?3, composer_name),
                            release_year = COALESCE(?4, release_year),
                            genre_tags = CASE WHEN ?5 IS NULL THEN genre_tags
                                WHEN json_valid(genre_tags) THEN json_set(genre_tags, '$[0]', ?5)
                                ELSE json_array(?5) END,
                            front_cover_url = COALESCE(?6, front_cover_url)
                         WHERE id = (SELECT release_id FROM tracks WHERE id = ?7)",
                        rusqlite::params![
                            payload.get("album").and_then(|v| v.as_str()),
                            payload.get("albumArtist").and_then(|v| v.as_str()),
                            payload.get("composer").and_then(|v| v.as_str()),
                            payload.get("year").and_then(|v| v.as_i64()),
                            payload.get("genre").and_then(|v| v.as_str()),
                            artwork.as_ref().map(|cover| cover.thumbnail_url.as_str()),
                            item.track_id,
                        ],
                    )?;
                    if let Some(cover) = &artwork {
                        conn.execute(
                            "INSERT OR IGNORE INTO commit_artwork_results (id, thumbnail_url, jpeg) VALUES (?1, ?2, ?3)",
                            rusqlite::params![cover.id, cover.thumbnail_url, cover.jpeg],
                        )?;
                        conn.execute(
                            "UPDATE commit_queue_items SET artwork_result_id = ?1 WHERE id = ?2",
                            rusqlite::params![cover.id, item.id],
                        )?;
                    }
                }
                Ok(())
            };
            if curate {
                let tx = conn.unchecked_transaction().map_err(|err| err.to_string())?;
                update_cache(&tx).and_then(|()| tx.commit()).map_err(|err| {
                    format!("File tags were written, but updating the catalog failed: {err}")
                })?;
            } else if let Err(err) = update_cache(&conn) {
                eprintln!("[CommitQueueWorker] Warning: Failed to update track cache for {}: {}", item.track_id, err);
            }
        }

        let written_bytes = fs::metadata(target_path).map(|m| m.len() as i64).unwrap_or(0);
        Ok(written_bytes)
    }

    fn prepare_cover(&self, source: &str, batch_id: &str) -> Result<Arc<PreparedCover>, String> {
        if let Some(cover) = self.prepared_cover.lock().as_ref().filter(|cover| cover.source == source).cloned() {
            return Ok(cover);
        }
        let saved = self.lock_db().query_row(
            "SELECT a.id, a.thumbnail_url, a.jpeg FROM commit_artwork_results a
             JOIN commit_queue_items i ON i.artwork_result_id = a.id
             WHERE i.batch_id = ?1 AND a.jpeg IS NOT NULL
                AND CASE WHEN json_valid(i.payload_json) THEN json_extract(i.payload_json, '$.coverArtUrl') END = ?2
             LIMIT 1",
            rusqlite::params![batch_id, source],
            |row| Ok(PreparedCover {
                id: row.get(0)?,
                thumbnail_url: row.get(1)?,
                jpeg: row.get(2)?,
                source: source.to_owned(),
            }),
        ).optional().map_err(|err| format!("Could not load previously saved artwork: {err}"))?;
        if let Some(cover) = saved {
            let cover = Arc::new(cover);
            *self.prepared_cover.lock() = Some(cover.clone());
            return Ok(cover);
        }
        let bytes = load_cover_bytes(source)?;
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()
            .map_err(|err| format!("Could not identify the cover image: {err}"))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(6000);
        limits.max_image_height = Some(6000);
        limits.max_alloc = Some(160 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader.decode().map_err(|err| format!("Invalid JPEG or PNG cover: {err}"))?;
        let encode = |size, quality| -> Result<Vec<u8>, String> {
            let mut output = Vec::new();
            let resized = if decoded.width().max(decoded.height()) > size {
                decoded.thumbnail(size, size).into_rgb8()
            } else {
                decoded.to_rgb8()
            };
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
                .encode_image(&resized).map_err(|err| format!("Could not encode the cover: {err}"))?;
            Ok(output)
        };
        let cover = Arc::new(PreparedCover {
            id: Uuid::new_v4().to_string(),
            source: source.to_owned(),
            jpeg: encode(1500, 90)?,
            thumbnail_url: format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(encode(240, 75)?)),
        });
        *self.prepared_cover.lock() = Some(cover.clone());
        Ok(cover)
    }

    fn atomic_replace_file(src: &Path, dest: &Path) -> std::io::Result<()> {
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
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        #[cfg(not(windows))]
        {
            fs::rename(src, dest)
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
        let state = {
            let is_playback_active = (self.playback_active)();
            if self.user_paused.load(Ordering::Relaxed) {
                "user_paused"
            } else if is_playback_active {
                "paused_playback"
            } else {
                "writing"
            }
        };

        self.emit_telemetry_with_state(state, None, None, force);
    }

    fn emit_telemetry_with_summary(
        &self,
        summary: &crate::db::CommitQueueSummary,
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

        let telemetry_sink = self.telemetry_sink.lock().clone();
        let emit = match telemetry_sink {
            Some(emit) => emit,
            None => return,
        };

        let (pending_items, inflight_items, completed_items, failed_items) =
            self.batch_progress(Some(summary));
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
            active_batch_id: summary.active_batch_id.clone(),
            active_batch_description: summary.active_batch_description.clone(),
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

        emit(&payload);
    }

    fn emit_telemetry_with_state(
        &self,
        state: &str,
        cooldown_remaining: Option<u64>,
        error_message: Option<String>,
        force: bool,
    ) {
        let summary_opt = {
            let conn = self.lock_db();
            DbOperations::get_commit_queue_summary(&conn).ok()
        };

        if let Some(summary) = summary_opt {
            self.emit_telemetry_with_summary(&summary, state, cooldown_remaining, error_message, force);
        }
    }

    pub fn get_telemetry(&self) -> CommitTelemetryPayload {
        let summary = {
            let conn = self.lock_db();
            DbOperations::get_commit_queue_summary(&conn).ok()
        };

        let (pending_items, inflight_items, completed_items, failed_items) =
            self.batch_progress(summary.as_ref());
        let total_items = pending_items + inflight_items + completed_items + failed_items;

        let percent = if total_items > 0 {
            (completed_items as f64 / total_items as f64) * 100.0
        } else {
            100.0
        };

        let is_playback_active = (self.playback_active)();
        let state = if self.user_paused.load(Ordering::Relaxed) {
            "user_paused".to_string()
        } else if total_items == 0 || (pending_items == 0 && inflight_items == 0) {
            "idle".to_string()
        } else if is_playback_active {
            "paused_playback".to_string()
        } else {
            "writing".to_string()
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
            cooldown_remaining_secs: None,
            offline_mounts: offline,
            error_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbCommitQueueBatch, NewCommitItem};

    fn wav_fixture() -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend(196u32.to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16u32.to_le_bytes());
        bytes.extend(1u16.to_le_bytes()); // PCM
        bytes.extend(1u16.to_le_bytes()); // Mono
        bytes.extend(8000u32.to_le_bytes());
        bytes.extend(16000u32.to_le_bytes());
        bytes.extend(2u16.to_le_bytes());
        bytes.extend(16u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend(160u32.to_le_bytes());
        bytes.extend([0; 160]);
        bytes
    }

    fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready() {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        true
    }

    fn wav_with_short_id3_year() -> Vec<u8> {
        let mut frames = Vec::new();
        for (id, text) in [
            (b"TDRC", b"198".as_slice()),
            (b"TDOR", b"1988-1".as_slice()),
            (b"TPE1", b"Original artist".as_slice()),
        ] {
            frames.extend(id);
            frames.extend(((text.len() + 1) as u32).to_be_bytes());
            frames.extend([0, 0, 0]); // Frame flags and Latin-1 encoding
            frames.extend(text);
        }
        let mut tag = b"ID3\x04\x00\x00\x00\x00\x00".to_vec();
        tag.push(frames.len() as u8);
        tag.extend(frames);
        let mut wav = wav_fixture();
        wav.extend(b"id3 ");
        wav.extend((tag.len() as u32).to_le_bytes());
        wav.extend(&tag);
        if tag.len() % 2 != 0 {
            wav.push(0);
        }
        let size = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&size.to_le_bytes());
        wav
    }

    #[test]
    fn mount_isolation_requires_a_storage_connection_error() {
        use std::io::{Error, ErrorKind};
        for kind in [ErrorKind::NotConnected, ErrorKind::NetworkUnreachable, ErrorKind::TimedOut] {
            assert!(CommitWriteError::storage("write", &Error::from(kind)).mount_unavailable);
        }
        for kind in [ErrorKind::NotFound, ErrorKind::PermissionDenied, ErrorKind::InvalidData] {
            assert!(!CommitWriteError::storage("write", &Error::from(kind)).mount_unavailable);
        }
        #[cfg(windows)]
        assert!(CommitWriteError::storage("open", &Error::from_raw_os_error(
            windows_sys::Win32::Foundation::ERROR_BAD_NETPATH as i32,
        )).mount_unavailable);
    }

    #[test]
    fn malformed_wav_dates_can_be_repaired_without_blocking_the_mount() {
        let folder = std::env::temp_dir().join(format!("cadence-timestamp-{}", Uuid::new_v4()));
        fs::create_dir(&folder).unwrap();
        let database = folder.join("cadence.db");
        let db = AppDb::new(database.clone()).unwrap();
        let malformed = wav_with_short_id3_year();
        let repair = folder.join("3.wav");
        let healthy = folder.join("4.wav");
        let items: Vec<_> = (0..5).map(|index| {
            let path = folder.join(format!("{index}.wav"));
            fs::write(&path, if index < 4 { malformed.clone() } else { wav_fixture() }).unwrap();
            let mut payload = serde_json::json!({"curate": true, "genre": "Soundtrack"});
            if index == 3 {
                payload["year"] = serde_json::json!(1988);
                payload["originalYear"] = serde_json::json!(1987);
            }
            NewCommitItem {
                id: index.to_string(), track_id: index.to_string(), file_path: path.to_str().unwrap().into(),
                mount_id: "disk".into(), payload_json: payload.to_string(),
                backup_json: "{}".into(), expected_crc: None,
            }
        }).collect();
        let read_error = Probe::open(&repair).unwrap().read().err().expect("fixture should fail to parse");
        assert!(read_error.to_string().contains("Timestamp segment is too short"));
        let batch = DbCommitQueueBatch {
            id: "batch".into(), description: Some("Timestamp fixture".into()), total_tracks: 5,
            destination: "embedded".into(), force_override: false, status: "pending".into(),
            created_at: "2026-11-07".into(), completed_at: None,
        };
        DbOperations::insert_commit_batch_and_items(&mut db.conn.lock(), &batch, &items).unwrap();
        let worker = CommitQueueWorker::with_playback_gate(db, || false);
        let handle = worker.start().unwrap();
        let drained = wait_until(|| worker.get_telemetry().pending_items == 0);
        worker.stop();
        handle.join().unwrap();
        let telemetry = worker.get_telemetry();
        assert!(drained, "the bad tags stranded {} items on the mount", telemetry.pending_items);
        assert_eq!(telemetry.failed_items, 3);
        assert_eq!(telemetry.completed_items, 2);
        assert!(telemetry.offline_mounts.is_empty());
        let repaired = Probe::open(&repair).unwrap().read().unwrap();
        let tag = repaired.primary_tag().unwrap();
        assert_eq!(tag.year(), Some(1988));
        assert_eq!(tag.get_string(&ItemKey::OriginalReleaseDate), Some("1987"));
        assert_eq!(tag.artist().as_deref(), Some("Original artist"));
        assert_eq!(tag.genre().as_deref(), Some("Soundtrack"));
        assert_eq!(Probe::open(&healthy).unwrap().read().unwrap().primary_tag().unwrap().genre().as_deref(), Some("Soundtrack"));
        for index in 0..3 {
            assert_eq!(fs::read(folder.join(format!("{index}.wav"))).unwrap(), malformed);
        }
        drop(worker);
        for item in items {
            fs::remove_file(item.file_path).unwrap();
        }
        fs::remove_file(database).unwrap();
        fs::remove_dir(folder).unwrap();
    }

    #[test]
    fn curate_confirmation_survives_worker_restart_and_writes_wav_after_playback() {
        let folder = std::env::temp_dir().join(format!("cadence-curate-{}", Uuid::new_v4()));
        fs::create_dir(&folder).unwrap();
        let song = folder.join("fixture.wav");
        let database = folder.join("cadence.db");
        let wav = wav_fixture();
        fs::write(&song, &wav).unwrap();
        let mut image = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(8, 8, image::Rgb([48, 94, 150])))
            .write_to(&mut image, image::ImageFormat::Png).unwrap();
        let cover_source = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(image.into_inner()));
        let playing = Arc::new(AtomicBool::new(true));
        {
            let db = AppDb::new(database.clone()).unwrap();
            let mut conn = db.conn.lock();
            conn.execute_batch(
                "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
                 VALUES ('disk', 'Fixture', 'fixture', 'local', 'NTFS', '2026-01-01');
                 INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, genre_tags, created_at)
                 VALUES ('album', 'Fixture Album', 'fixture', 'fixture', 'Singer', '[\"Soundtrack\"]', '2026-01-01');",
            ).unwrap();
            conn.execute(
                "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path,
                    file_name, file_size, mtime, title, artist_credit, album_title, genre, format, created_at)
                 VALUES ('track', 'album', 'disk', 'fixture', 'fixture', ?1, 'fixture.wav', 204, 0,
                    'Fixture Song', 'Singer', 'Fixture Album', 'Soundtrack', 'WAV', '2026-01-01')",
                [song.to_str().unwrap()],
            ).unwrap();
            let batch = DbCommitQueueBatch {
                id: "batch".into(), description: Some("Curate fixture".into()), total_tracks: 1,
                destination: "embedded".into(), force_override: false, status: "pending".into(),
                created_at: "2026-01-01".into(), completed_at: None,
            };
            let item = NewCommitItem {
                id: "item".into(), track_id: "track".into(), file_path: song.to_str().unwrap().into(),
                mount_id: "disk".into(), payload_json: serde_json::json!({
                    "curate": true, "genre": "Tamil Soundtrack", "coverArtUrl": cover_source,
                }).to_string(),
                backup_json: r#"{"genre":"Soundtrack"}"#.into(), expected_crc: None,
            };
            DbOperations::insert_commit_batch_and_items(&mut conn, &batch, &[item]).unwrap();
            drop(conn);
            let gate = playing.clone();
            let worker = CommitQueueWorker::with_playback_gate(db, move || gate.load(Ordering::SeqCst));
            let handle = worker.start().unwrap();
            let paused = wait_until(|| *worker.last_emitted_state.lock() == "paused_playback");
            worker.stop();
            handle.join().unwrap();
            assert!(paused, "worker never observed the playback gate");
            assert_eq!(fs::read(&song).unwrap(), wav);
        }
        {
            let db = AppDb::new(database.clone()).unwrap();
            let gate = playing.clone();
            let worker = CommitQueueWorker::with_playback_gate(db, move || gate.load(Ordering::SeqCst));
            let handle = worker.start().unwrap();
            let paused = wait_until(|| *worker.last_emitted_state.lock() == "paused_playback");
            let while_playing = fs::read(&song).unwrap();
            let pending = worker.get_telemetry().pending_items;
            playing.store(false, Ordering::SeqCst);
            let finished = wait_until(|| {
                let status = worker.get_telemetry();
                status.completed_items == 1 || status.failed_items == 1
            });
            worker.stop();
            handle.join().unwrap();
            assert!(paused && finished, "worker did not resume promptly after playback stopped");
            assert_eq!(pending, 1);
            assert_eq!(while_playing, wav);
            let conn = worker.lock_db();
            let (status, error): (String, Option<String>) = conn.query_row(
                "SELECT status, error_message FROM commit_queue_items WHERE id = 'item'", [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(status, "completed", "{error:?}");
            let (track_genre, release_genre, thumbnail): (String, String, String) = conn.query_row(
                "SELECT tracks.genre, json_extract(releases.genre_tags, '$[0]'), releases.front_cover_url
                 FROM tracks JOIN releases ON releases.id = tracks.release_id WHERE tracks.id = 'track'",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(track_genre, "Tamil Soundtrack");
            assert_eq!(release_genre, "Tamil Soundtrack");
            assert!(thumbnail.starts_with("data:image/jpeg;base64,"));
            drop(conn);
            *worker.prepared_cover.lock() = None;
            let saved = worker.prepare_cover(&cover_source, "batch").unwrap();
            assert_eq!(saved.thumbnail_url, thumbnail);
            assert!(worker.prepare_cover("data:image/png;base64,SGVsbG8=", "batch").is_err());
        }
        let written = Probe::open(&song).unwrap().read().unwrap();
        let tag = written.primary_tag().or_else(|| written.first_tag()).unwrap();
        assert_eq!(tag.genre().as_deref(), Some("Tamil Soundtrack"));
        let front_cover = tag.pictures().iter().find(|pic| pic.pic_type() == PictureType::CoverFront).unwrap();
        assert_eq!(image::load_from_memory(front_cover.data()).unwrap().width(), 8);
        fs::remove_file(&song).unwrap();
        fs::remove_file(&database).unwrap();
        fs::remove_dir(&folder).unwrap();
    }
}
