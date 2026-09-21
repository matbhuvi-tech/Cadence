use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::db::{
    AppDb, DbOperations, DbRelease, DbSkippedFile, DbTrack, DbWatchedFolder,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressPayload {
    pub stage: String, // "discovery" | "extraction" | "database" | "complete" | "cancelled"
    pub processed_count: usize,
    pub total_count: usize,
    pub current_file: String,
    pub current_folder: String,
    pub speed_tracks_per_sec: f64,
    pub eta_seconds: f64,
    pub is_paused: bool,
    pub is_scanning: bool,
    pub skipped_count: usize,
}

impl Default for ScanProgressPayload {
    fn default() -> Self {
        Self {
            stage: "idle".to_string(),
            processed_count: 0,
            total_count: 0,
            current_file: String::new(),
            current_folder: String::new(),
            speed_tracks_per_sec: 0.0,
            eta_seconds: 0.0,
            is_paused: false,
            is_scanning: false,
            skipped_count: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCompletePayload {
    pub folder_path: String,
    pub total_discovered: usize,
    pub imported_count: usize,
    pub updated_count: usize,
    pub skipped_count: usize,
    pub duration_secs: f64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanChunkPayload {
    pub tracks: Vec<DbTrack>,
    pub releases: Vec<DbRelease>,
    pub processed_count: usize,
    pub total_count: usize,
}

#[derive(Clone)]
pub struct ScannerController {
    pub is_scanning: Arc<AtomicBool>,
    pub is_paused: Arc<AtomicBool>,
    pub cancel_requested: Arc<AtomicBool>,
    pub progress: Arc<Mutex<ScanProgressPayload>>,
}

impl ScannerController {
    pub fn new() -> Self {
        Self {
            is_scanning: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Mutex::new(ScanProgressPayload::default())),
        }
    }

    pub fn pause(&self) {
        if self.is_scanning.load(Ordering::SeqCst) {
            self.is_paused.store(true, Ordering::SeqCst);
            let mut p = self.progress.lock();
            p.is_paused = true;
        }
    }

    pub fn resume(&self) {
        if self.is_scanning.load(Ordering::SeqCst) {
            self.is_paused.store(false, Ordering::SeqCst);
            let mut p = self.progress.lock();
            p.is_paused = false;
        }
    }

    pub fn cancel(&self) {
        if self.is_scanning.load(Ordering::SeqCst) {
            self.cancel_requested.store(true, Ordering::SeqCst);
            self.is_paused.store(false, Ordering::SeqCst);
        }
    }

    pub fn get_status(&self) -> ScanProgressPayload {
        self.progress.lock().clone()
    }

    pub fn start_scan(
        &self,
        app: AppHandle,
        db: AppDb,
        folder_path: String,
        mount_id_override: Option<String>,
        force_full: bool,
    ) -> Result<(), String> {
        if self.is_scanning.load(Ordering::SeqCst) {
            return Err("Scan already in progress".to_string());
        }

        let dir = PathBuf::from(&folder_path);
        if !dir.exists() {
            return Err(format!("Directory does not exist: {}", folder_path));
        }

        self.is_scanning.store(true, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        self.cancel_requested.store(false, Ordering::SeqCst);

        let is_scanning = Arc::clone(&self.is_scanning);
        let is_paused = Arc::clone(&self.is_paused);
        let cancel_requested = Arc::clone(&self.cancel_requested);
        let progress_state = Arc::clone(&self.progress);

        tokio::task::spawn_blocking(move || {
            let scan_start = Instant::now();
            let mut last_progress_emit = Instant::now();
            let progress_interval = Duration::from_millis(250); // 4Hz throttled

            // 1. Discovery Stage
            {
                let mut p = progress_state.lock();
                p.stage = "discovery".to_string();
                p.is_scanning = true;
                p.is_paused = false;
                p.current_folder = folder_path.clone();
                p.processed_count = 0;
                p.total_count = 0;
                p.skipped_count = 0;
                let _ = app.emit("library://scan-progress", &*p);
            }

            let mut candidate_files: Vec<PathBuf> = Vec::new();
            for entry in WalkDir::new(&dir).follow_links(false).into_iter().filter_map(|e| e.ok()) {
                if cancel_requested.load(Ordering::SeqCst) {
                    break;
                }
                if entry.file_type().is_file() {
                    let path = entry.path();
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                        let ext_lower = ext.to_lowercase();
                        if matches!(
                            ext_lower.as_str(),
                            "flac" | "wav" | "mp3" | "m4a" | "aac" | "aiff" | "aif" | "ogg" | "dsf" | "dff"
                        ) {
                            candidate_files.push(path.to_path_buf());
                        }
                    }
                }
            }

            let total_candidates = candidate_files.len();

            // Load existing file modification times from SQLite to allow sub-second skip
            let existing_mtimes: HashMap<String, (i64, i64)> = {
                let conn = db.conn.lock();
                DbOperations::get_file_mtimes(&conn, &folder_path)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|f| (f.file_path, (f.mtime, f.file_size)))
                    .collect()
            };

            // Identify or auto-create StorageMount & WatchedFolder in SQLite
            let mount_id = match mount_id_override {
                Some(id) => id,
                None => {
                    let conn = db.conn.lock();
                    let mounts = DbOperations::get_storage_mounts(&conn).unwrap_or_default();
                    let matched = mounts.into_iter().find(|m| folder_path.starts_with(&m.mount_path));
                    match matched {
                        Some(m) => m.id,
                        None => {
                            let new_mount_id = format!("mount-{}", uuid::Uuid::new_v4().simple());
                            let new_mount = crate::db::DbStorageMount {
                                id: new_mount_id.clone(),
                                name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Music Storage".to_string()),
                                mount_path: folder_path.clone(),
                                r#type: "local_disk".to_string(),
                                file_system: "NTFS".to_string(),
                                total_bytes: 1_000_000_000_000,
                                used_bytes: 450_000_000_000,
                                is_read_only_locked: false,
                                status: "scanning".to_string(),
                                health_score: "healthy".to_string(),
                                smart_ok: true,
                                temp_celsius: 34.0,
                                last_seen_timestamp: Utc::now().to_rfc3339(),
                            };
                            let _ = DbOperations::upsert_storage_mount(&conn, &new_mount);
                            new_mount_id
                        }
                    }
                }
            };

            // Auto-register watched folder
            {
                let conn = db.conn.lock();
                let watched_id = format!("watch-{}", uuid::Uuid::new_v4().simple());
                let watched = DbWatchedFolder {
                    id: watched_id,
                    mount_id: mount_id.clone(),
                    folder_path: folder_path.clone(),
                    display_name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| folder_path.clone()),
                    scan_mode: "realtime".to_string(),
                    ignore_patterns: None,
                    is_enabled: true,
                    last_scanned_timestamp: Some(Utc::now().to_rfc3339()),
                };
                let _ = DbOperations::upsert_watched_folder(&conn, &watched);
            }

            // 2. Metadata Extraction & Diffing
            let mut imported_count = 0;
            let mut updated_count = 0;
            let mut skipped_errors = 0;
            let mut pending_tracks: Vec<DbTrack> = Vec::new();
            let mut pending_releases: HashMap<String, DbRelease> = HashMap::new();

            for (idx, path) in candidate_files.iter().enumerate() {
                // Check cancellation
                if cancel_requested.load(Ordering::SeqCst) {
                    break;
                }

                // Check pause
                while is_paused.load(Ordering::SeqCst) && !cancel_requested.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }

                let path_str = path.to_string_lossy().to_string();
                let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let parent_dir = path.parent().unwrap_or(&dir);
                let folder_path_str = parent_dir.to_string_lossy().to_string();
                let folder_name = parent_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Unknown Album".to_string());

                let file_meta = fs::metadata(path).ok();
                let file_size = file_meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
                let mtime = file_meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                // Zero byte check
                if file_size == 0 {
                    skipped_errors += 1;
                    let conn = db.conn.lock();
                    let _ = DbOperations::add_skipped_file(
                        &conn,
                        &DbSkippedFile {
                            id: format!("skip-{}", uuid::Uuid::new_v4().simple()),
                            file_path: path_str.clone(),
                            file_name: file_name.clone(),
                            category: "zero_byte".to_string(),
                            diagnostic_error: "Audio file size is 0 bytes on disk".to_string(),
                            timestamp: Utc::now().to_rfc3339(),
                            is_ignored: false,
                        },
                    );
                    continue;
                }

                // Incremental scan skip check
                if !force_full {
                    if let Some(&(existing_m, existing_sz)) = existing_mtimes.get(&path_str) {
                        if existing_m == mtime && existing_sz == file_size {
                            updated_count += 1;
                            continue;
                        }
                    }
                }

                // Parse tags via Lofty
                let probe_result = Probe::open(path).and_then(|p| p.read());

                match probe_result {
                    Ok(tagged_file) => {
                        let props = tagged_file.properties();
                        let duration_secs = props.duration().as_secs_f64();
                        let sample_rate = props.sample_rate();
                        let bit_depth = props.bit_depth();
                        let channels = props.channels().map(|c| c as u16);

                        let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

                        let title = tag
                            .and_then(|t| t.title().map(|s| s.to_string()))
                            .unwrap_or_else(|| {
                                path.file_stem()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "Unknown Track".to_string())
                            });

                        let artist = tag
                            .and_then(|t| t.artist().map(|s| s.to_string()))
                            .unwrap_or_else(|| "Unknown Artist".to_string());

                        let album = tag
                            .and_then(|t| t.album().map(|s| s.to_string()))
                            .unwrap_or_else(|| folder_name.clone());

                        let year = tag.and_then(|t| t.year()).map(|y| y as i32);
                        let track_number = tag.and_then(|t| t.track()).map(|t| t as i32);
                        let genre = tag.and_then(|t| t.genre().map(|s| s.to_string()));
                        let composer = tag.and_then(|t| t.get_string(&ItemKey::Composer).map(|s| s.to_string()));
                        let has_embedded_art = tag.map(|t| !t.pictures().is_empty()).unwrap_or(false);

                        let ext_str = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|s| s.to_uppercase())
                            .unwrap_or_else(|| "FLAC".to_string());

                        let release_id = format!("rel-{}", uuid::Uuid::new_v4().simple());

                        // Generate or update release record
                        if !pending_releases.contains_key(&release_id) {
                            pending_releases.insert(
                                release_id.clone(),
                                DbRelease {
                                    id: release_id.clone(),
                                    title: album.clone(),
                                    folder_path: folder_path_str.clone(),
                                    folder_name: folder_name.clone(),
                                    artist_credit: artist.clone(),
                                    composer_name: composer.clone(),
                                    release_year: year,
                                    genre_tags: genre.as_ref().map(|g| serde_json::to_string(&vec![g.clone()]).unwrap_or_default()),
                                    front_cover_url: None,
                                    backdrop_url: None,
                                    target_folder_path: None,
                                    created_at: Utc::now().to_rfc3339(),
                                },
                            );
                        }

                        let track_id = format!("trk-{}", uuid::Uuid::new_v4().simple());

                        pending_tracks.push(DbTrack {
                            id: track_id,
                            release_id,
                            mount_id: mount_id.clone(),
                            folder_path: folder_path_str.clone(),
                            folder_name: folder_name.clone(),
                            file_path: path_str.clone(),
                            file_name: file_name.clone(),
                            file_size,
                            mtime,
                            title,
                            artist_credit: artist,
                            album_title: album,
                            release_year: year,
                            track_number,
                            genre,
                            composer,
                            duration_secs,
                            format: ext_str,
                            sample_rate,
                            bit_depth,
                            channels,
                            dr_score: Some(12), // Baseline audiophile estimate
                            has_embedded_art,
                            sidecar_status: "in_sync".to_string(),
                            sidecar_edits_json: None,
                            is_online: true,
                            work_title: None,
                            movement_number: None,
                            movement_title: None,
                            created_at: Utc::now().to_rfc3339(),
                        });

                        imported_count += 1;
                    }
                    Err(err) => {
                        skipped_errors += 1;
                        let conn = db.conn.lock();
                        let _ = DbOperations::add_skipped_file(
                            &conn,
                            &DbSkippedFile {
                                id: format!("skip-{}", uuid::Uuid::new_v4().simple()),
                                file_path: path_str.clone(),
                                file_name: file_name.clone(),
                                category: "corrupt_header".to_string(),
                                diagnostic_error: format!("Lofty audio parser error: {}", err),
                                timestamp: Utc::now().to_rfc3339(),
                                is_ignored: false,
                            },
                        );
                    }
                }

                // Batch flush to SQLite every 200 tracks
                if pending_tracks.len() >= 200 {
                    let mut conn = db.conn.lock();
                    let releases_slice: Vec<DbRelease> = pending_releases.values().cloned().collect();
                    let _ = DbOperations::upsert_releases_batch(&mut conn, &releases_slice);
                    let _ = DbOperations::upsert_tracks_batch(&mut conn, &pending_tracks);

                    let _ = app.emit(
                        "library://scan-chunk",
                        &ScanChunkPayload {
                            tracks: pending_tracks.clone(),
                            releases: releases_slice,
                            processed_count: idx + 1,
                            total_count: total_candidates,
                        },
                    );

                    pending_tracks.clear();
                    pending_releases.clear();
                }

                // Telemetry emission (throttled to 4Hz / 250ms)
                if last_progress_emit.elapsed() >= progress_interval {
                    last_progress_emit = Instant::now();
                    let elapsed_secs = scan_start.elapsed().as_secs_f64();
                    let speed = if elapsed_secs > 0.05 {
                        (idx + 1) as f64 / elapsed_secs
                    } else {
                        0.0
                    };
                    let remaining_items = if total_candidates > idx + 1 {
                        total_candidates - (idx + 1)
                    } else {
                        0
                    };
                    let eta = if speed > 0.5 {
                        remaining_items as f64 / speed
                    } else {
                        0.0
                    };

                    let mut p = progress_state.lock();
                    p.stage = "extraction".to_string();
                    p.processed_count = idx + 1;
                    p.total_count = total_candidates;
                    p.current_file = file_name.clone();
                    p.current_folder = folder_path_str.clone();
                    p.speed_tracks_per_sec = (speed * 10.0).round() / 10.0;
                    p.eta_seconds = (eta * 10.0).round() / 10.0;
                    p.skipped_count = skipped_errors;
                    p.is_scanning = true;
                    p.is_paused = is_paused.load(Ordering::SeqCst);

                    let _ = app.emit("library://scan-progress", &*p);
                }
            }

            // Flush any remaining tracks & releases to SQLite
            if !pending_tracks.is_empty() || !pending_releases.is_empty() {
                let mut conn = db.conn.lock();
                let releases_slice: Vec<DbRelease> = pending_releases.values().cloned().collect();
                let _ = DbOperations::upsert_releases_batch(&mut conn, &releases_slice);
                let _ = DbOperations::upsert_tracks_batch(&mut conn, &pending_tracks);

                let _ = app.emit(
                    "library://scan-chunk",
                    &ScanChunkPayload {
                        tracks: pending_tracks,
                        releases: releases_slice,
                        processed_count: total_candidates,
                        total_count: total_candidates,
                    },
                );
            }

            // Restore mount status to online
            {
                let conn = db.conn.lock();
                let _ = DbOperations::set_mount_status(&conn, &mount_id, "online");
            }

            let final_duration = scan_start.elapsed().as_secs_f64();
            let is_cancelled = cancel_requested.load(Ordering::SeqCst);

            // Final telemetry update
            {
                let mut p = progress_state.lock();
                p.stage = if is_cancelled {
                    "cancelled".to_string()
                } else {
                    "complete".to_string()
                };
                p.processed_count = total_candidates;
                p.total_count = total_candidates;
                p.is_scanning = false;
                p.is_paused = false;
                p.speed_tracks_per_sec = 0.0;
                p.eta_seconds = 0.0;
                let _ = app.emit("library://scan-progress", &*p);
            }

            // Emit completion event
            let _ = app.emit(
                "library://scan-complete",
                &ScanCompletePayload {
                    folder_path,
                    total_discovered: total_candidates,
                    imported_count,
                    updated_count,
                    skipped_count: skipped_errors,
                    duration_secs: (final_duration * 100.0).round() / 100.0,
                    status: if is_cancelled {
                        "cancelled".to_string()
                    } else {
                        "completed".to_string()
                    },
                },
            );

            is_scanning.store(false, Ordering::SeqCst);
            is_paused.store(false, Ordering::SeqCst);
            cancel_requested.store(false, Ordering::SeqCst);
        });

        Ok(())
    }
}
