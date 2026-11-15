//! Tauri-independent headless Core runtime, SQLite catalog projection,
//! strict locked-RAM admission, and 30-second post-playback storage silence.

pub mod curate;
pub mod dragonfish;
pub mod migration;
pub mod platform;
pub mod upnp_session;

pub use platform::{
    normalize_linux_getsockopt_sndbuf, normalize_linux_setsockopt_sndbuf, parse_cgroup_limit_bytes,
    parse_cpuset_list, parse_meminfo_bytes, parse_proc_status_cap_ipc_lock,
    parse_zfs_arc_reclaimable_bytes, partition_truenas_cpus, AdmissionError, CgroupMemoryLimits,
    CpuPartition, HostMemoryLimits, LockedBytesArena, MemoryLocker, PlatformLimits, PlatformProbe,
    SystemMemoryLocker, SystemPlatformProbe, DEFAULT_CONTAINER_HEADROOM_BYTES,
};

use crate::core_session::{
    CatalogTrack, ErrorCode, Output, Renderer, RendererAction, RendererError, RendererEvent,
    SessionConfig, SessionOwner, MAX_MESSAGE_BYTES,
};
use crate::db::AppDb;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Mandatory post-playback storage-bus silence window (30 seconds).
pub const COOLDOWN_DURATION: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct HeadlessConfig {
    pub db_path: PathBuf,
    pub engine_id: String,
    pub library_id: String,
    pub label: String,
    pub output: Option<Output>,
    pub headroom_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Database(String),
    SessionInit(ErrorCode),
    TransportNotIdle,
    CooldownActive { remaining_ms: u64 },
    Admission(AdmissionError),
    Closed,
}

struct SharedRenderer<R> {
    inner: Arc<Mutex<R>>,
    admitted_ids: Arc<Mutex<HashSet<String>>>,
}

impl<R> Clone for SharedRenderer<R> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            admitted_ids: Arc::clone(&self.admitted_ids),
        }
    }
}

impl<R: Renderer> Renderer for SharedRenderer<R> {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        if let RendererAction::Play { entry, .. } = action {
            let admitted = self.admitted_ids.lock().map_err(|_| RendererError)?;
            if !admitted.contains(&entry.track_id) {
                return Err(RendererError);
            }
        }
        let mut guard = self.inner.lock().map_err(|_| RendererError)?;
        guard.apply(action)
    }
}

pub struct HeadlessCoreRuntime<
    R: Renderer,
    P: PlatformProbe = SystemPlatformProbe,
    L: MemoryLocker = SystemMemoryLocker,
> {
    config: HeadlessConfig,
    db: Option<AppDb>,
    renderer: SharedRenderer<R>,
    owner: SessionOwner<SharedRenderer<R>>,
    track_files: HashMap<String, PathBuf>,
    arena: LockedBytesArena<P, L>,
    last_stopped_at: Option<Instant>,
    music_read_only: bool,
}

impl<R: Renderer> HeadlessCoreRuntime<R, SystemPlatformProbe, SystemMemoryLocker> {
    pub fn open(config: HeadlessConfig, renderer: R) -> Result<Self, RuntimeError> {
        Self::open_with_platform(
            config,
            renderer,
            SystemPlatformProbe,
            SystemMemoryLocker,
        )
    }
}

impl<R: Renderer, P: PlatformProbe, L: MemoryLocker> HeadlessCoreRuntime<R, P, L> {
    pub fn open_with_platform(
        config: HeadlessConfig,
        renderer: R,
        probe: P,
        locker: L,
    ) -> Result<Self, RuntimeError> {
        let db = AppDb::new(config.db_path.clone()).map_err(RuntimeError::Database)?;
        let (catalog, track_files) = load_catalog_projection(&db)?;
        let shared_renderer = SharedRenderer {
            inner: Arc::new(Mutex::new(renderer)),
            admitted_ids: Arc::new(Mutex::new(HashSet::new())),
        };
        let owner = SessionOwner::new(
            SessionConfig {
                engine_id: config.engine_id.clone(),
                library_id: config.library_id.clone(),
                label: config.label.clone(),
                output: config.output.clone(),
            },
            catalog,
            shared_renderer.clone(),
        )
        .map_err(RuntimeError::SessionInit)?;

        let headroom = if config.headroom_bytes == 0 {
            DEFAULT_CONTAINER_HEADROOM_BYTES
        } else {
            config.headroom_bytes
        };

        Ok(Self {
            config,
            db: Some(db),
            renderer: shared_renderer,
            owner,
            track_files,
            arena: LockedBytesArena::new(probe, locker, headroom),
            last_stopped_at: None,
            music_read_only: true,
        })
    }

    /// Verifies that the persistent Core SQLite connection is operating in WAL mode.
    pub fn wal_enabled(&self) -> Result<bool, RuntimeError> {
        let db = self.db.as_ref().ok_or(RuntimeError::Closed)?;
        let conn = db.conn.lock();
        let mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .map_err(|e| RuntimeError::Database(e.to_string()))?;
        Ok(mode.eq_ignore_ascii_case("wal"))
    }

    pub fn retained_locked_bytes(&self) -> u64 {
        self.arena.retained_locked_bytes()
    }

    pub fn available_budget_bytes(&self) -> u64 {
        self.arena.available_budget_bytes()
    }

    pub fn shared_track_buffer(&self, track_id: &str) -> Option<Arc<Vec<u8>>> {
        self.arena.get_shared_buffer(track_id)
    }

    /// Bounded explicit user-action admission helper used by live Core nodes so
    /// manual track/album switches work immediately without relaxing background
    /// `admit_tracks` / `reload_catalog` cooldown enforcement.
    pub(crate) fn admit_tracks_for_explicit_user_play(
        &mut self,
        track_ids: &[String],
        keep_ids: &HashSet<String>,
    ) -> Result<Vec<(String, Arc<Vec<u8>>)>, RuntimeError> {
        const MAX_WINDOW_TRACKS: usize = 4;
        let mut bounded: Vec<String> = Vec::with_capacity(MAX_WINDOW_TRACKS);
        for id in track_ids {
            if self.track_files.contains_key(id) && !bounded.contains(id) {
                bounded.push(id.clone());
                if bounded.len() >= MAX_WINDOW_TRACKS {
                    break;
                }
            }
        }
        if bounded.is_empty() {
            return Ok(Vec::new());
        }

        let mut retain_set = keep_ids.clone();
        for id in &bounded {
            retain_set.insert(id.clone());
        }

        let needs_load = bounded.iter().any(|id| !self.arena.is_admitted(id));
        if needs_load {
            if self.arena.admit_files(&self.track_files, &bounded).is_err() {
                self.arena.retain_keys(&retain_set);
                if let Ok(mut admitted) = self.renderer.admitted_ids.lock() {
                    admitted.retain(|id| retain_set.contains(id));
                }
                self.arena
                    .admit_files(&self.track_files, &bounded)
                    .map_err(RuntimeError::Admission)?;
            }
            if let Ok(mut admitted) = self.renderer.admitted_ids.lock() {
                for id in &bounded {
                    if self.arena.is_admitted(id) {
                        admitted.insert(id.clone());
                    }
                }
            }
        }

        let mut out = Vec::with_capacity(bounded.len());
        for id in bounded {
            if let Some(buf) = self.arena.get_shared_buffer(&id) {
                out.push((id, buf));
            }
        }
        Ok(out)
    }

    pub(crate) fn current_queue_track_id(&self) -> Option<String> {
        self.owner.current_track_id()
    }

    pub(crate) fn resolve_queue_transition_targets(
        &self,
        action: &str,
        entry_id: Option<&str>,
    ) -> Vec<String> {
        self.owner.resolve_queue_transition_targets(action, entry_id)
    }

    pub(crate) fn peek_next_queue_track_id(&self) -> Option<String> {
        let req = json!({
            "protocolVersion": 1,
            "engineId": self.config.engine_id,
            "libraryId": self.config.library_id,
            "operation": "session.snapshot"
        });
        let resp = self.owner.request(&serde_json::to_vec(&req).unwrap_or_default());
        let data = resp.get("data")?;
        let current_entry_id = data["queue"]["currentEntryId"].as_str()?;
        let entries = data["queue"]["entries"].as_array()?;
        let cur_idx = entries
            .iter()
            .position(|e| e["entryId"].as_str() == Some(current_entry_id))?;
        entries
            .get(cur_idx + 1)
            .and_then(|e| e["trackId"].as_str())
            .map(ToString::to_string)
    }

    pub fn admit_tracks(&mut self, track_ids: &[String]) -> Result<(), RuntimeError> {
        self.admit_tracks_at(track_ids, Instant::now())
    }

    pub fn admit_tracks_at(
        &mut self,
        track_ids: &[String],
        now: Instant,
    ) -> Result<(), RuntimeError> {
        self.ensure_storage_idle_at(now)?;
        self.arena
            .admit_files(&self.track_files, track_ids)
            .map_err(RuntimeError::Admission)?;
        if let Ok(mut admitted) = self.renderer.admitted_ids.lock() {
            for id in track_ids {
                if self.arena.is_admitted(id) {
                    admitted.insert(id.clone());
                }
            }
        }
        Ok(())
    }

    pub fn reload_catalog(&mut self) -> Result<usize, RuntimeError> {
        self.reload_catalog_at(Instant::now())
    }

    pub fn reload_catalog_at(&mut self, now: Instant) -> Result<usize, RuntimeError> {
        self.ensure_storage_idle_at(now)?;
        let db = self.db.as_ref().ok_or(RuntimeError::Closed)?;
        let (catalog, track_files) = load_catalog_projection(db)?;
        let count = catalog.len();
        self.owner = SessionOwner::new(
            SessionConfig {
                engine_id: self.config.engine_id.clone(),
                library_id: self.config.library_id.clone(),
                label: self.config.label.clone(),
                output: self.config.output.clone(),
            },
            catalog,
            self.renderer.clone(),
        )
        .map_err(RuntimeError::SessionInit)?;
        self.track_files = track_files;
        Ok(count)
    }

    pub fn request(&mut self, input: &[u8]) -> Value {
        self.request_at(input, Instant::now())
    }

    pub fn request_at(&mut self, input: &[u8], now: Instant) -> Value {
        if input.len() <= MAX_MESSAGE_BYTES {
            if let Ok(parsed) = serde_json::from_slice::<Value>(input) {
                if let Some(op) = parsed.get("operation").and_then(Value::as_str) {
                    if op.starts_with("curate.") {
                        return self.handle_curate_request_at(&parsed, now);
                    }
                }
                if self.rejects_unadmitted_target(&parsed) {
                    return json!({
                        "ok": false,
                        "error": { "code": "not_ready" }
                    });
                }
            }
        }
        let was_active = self.current_activity() != "idle";
        let response = self.owner.request(input);
        if was_active && self.current_activity() == "idle" {
            self.last_stopped_at = Some(now);
        }
        response
    }

    pub fn on_renderer_event(&mut self, event: RendererEvent) -> Result<bool, ErrorCode> {
        self.on_renderer_event_at(event, Instant::now())
    }

    pub fn on_renderer_event_at(
        &mut self,
        event: RendererEvent,
        now: Instant,
    ) -> Result<bool, ErrorCode> {
        let was_active = self.current_activity() != "idle";
        let applied = self.owner.on_renderer_event(event)?;
        if applied && was_active && self.current_activity() == "idle" {
            self.last_stopped_at = Some(now);
        }
        Ok(applied)
    }

    /// Deterministically stops any active session, unlocks all pinned RAM buffers,
    /// checkpoints WAL, and closes the SQLite handle cleanly.
    pub fn shutdown(&mut self) -> Result<(), RuntimeError> {
        let _ = self.renderer.apply(&RendererAction::Stop);
        self.arena.clear();
        if let Ok(mut admitted) = self.renderer.admitted_ids.lock() {
            admitted.clear();
        }
        if let Some(db) = self.db.take() {
            if let Some(conn_mutex) = Arc::into_inner(db.conn) {
                let conn = conn_mutex.into_inner();
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                let _ = conn.close();
            }
        }
        Ok(())
    }

    fn ensure_storage_idle_at(&self, now: Instant) -> Result<(), RuntimeError> {
        if self.db.is_none() {
            return Err(RuntimeError::Closed);
        }
        if self.current_activity() != "idle" {
            return Err(RuntimeError::TransportNotIdle);
        }
        if let Some(stopped_at) = self.last_stopped_at {
            let elapsed = now.saturating_duration_since(stopped_at);
            if elapsed < COOLDOWN_DURATION {
                let remaining_ms = (COOLDOWN_DURATION - elapsed).as_millis() as u64;
                return Err(RuntimeError::CooldownActive {
                    remaining_ms: remaining_ms.max(1),
                });
            }
        }
        Ok(())
    }

    fn current_activity(&self) -> String {
        let req = json!({
            "protocolVersion": 1,
            "engineId": self.config.engine_id,
            "libraryId": self.config.library_id,
            "operation": "session.snapshot"
        });
        let resp = self.owner.request(&serde_json::to_vec(&req).unwrap_or_default());
        resp["data"]["playback"]["activity"]
            .as_str()
            .unwrap_or("idle")
            .to_string()
    }

    fn rejects_unadmitted_target(&self, parsed: &Value) -> bool {
        let Some(op) = parsed.get("operation").and_then(Value::as_str) else {
            return false;
        };
        if op == "playback.control"
            && parsed.get("action").and_then(Value::as_str) == Some("play")
        {
            if let Some(track_id) = parsed.get("trackId").and_then(Value::as_str) {
                if self.track_files.contains_key(track_id) && !self.arena.is_admitted(track_id) {
                    return true;
                }
            }
        } else if op == "queue.replace" {
            if self.current_activity() == "idle" {
                if let Some(first_track_id) = parsed
                    .get("entries")
                    .and_then(Value::as_array)
                    .and_then(|entries| entries.first())
                    .and_then(|entry| entry.get("trackId"))
                    .and_then(Value::as_str)
                {
                    if self.track_files.contains_key(first_track_id)
                        && !self.arena.is_admitted(first_track_id)
                    {
                        return true;
                    }
                }
            }
        } else if op == "queue.control" {
            if let Some(action) = parsed.get("action").and_then(Value::as_str) {
                if matches!(action, "next" | "previous" | "jump") {
                    let entry_id = parsed.get("entryId").and_then(Value::as_str);
                    if let Some(target_track_id) =
                        self.resolve_queue_transition_targets(action, entry_id).first()
                    {
                        if self.track_files.contains_key(target_track_id)
                            && !self.arena.is_admitted(target_track_id)
                        {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    pub fn set_music_read_only(&mut self, read_only: bool) {
        self.music_read_only = read_only;
    }

    pub fn register_writable_root(
        &mut self,
        root_path: &std::path::Path,
    ) -> Result<curate::RootWriterLease, curate::RemoteCurateError> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| curate::RemoteCurateError::Database("runtime closed".into()))?;
        curate::register_writable_root(db, root_path, &self.config.engine_id)
    }

    pub fn save_curate_draft(
        &mut self,
        input: curate::CurateDraftInput,
    ) -> Result<curate::CurateDraftRecord, curate::RemoteCurateError> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| curate::RemoteCurateError::Database("runtime closed".into()))?;
        curate::save_draft(db, input)
    }

    pub fn dry_run_curate_draft_at(
        &mut self,
        draft_id: &str,
        now: Instant,
    ) -> Result<curate::CurateDryRunReport, curate::RemoteCurateError> {
        self.map_idle_gate(now)?;
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| curate::RemoteCurateError::Database("runtime closed".into()))?;
        curate::dry_run_draft(db, draft_id, self.music_read_only)
    }

    pub fn approve_curate_draft_at(
        &mut self,
        draft_id: &str,
        expected_approval_hash: &str,
        command_id: &str,
        _now: Instant,
    ) -> Result<curate::CurateApprovalReceipt, curate::RemoteCurateError> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| curate::RemoteCurateError::Database("runtime closed".into()))?;
        curate::approve_draft(
            db,
            draft_id,
            expected_approval_hash,
            command_id,
            self.music_read_only,
        )
    }

    pub fn execute_pending_curate_jobs_at(
        &mut self,
        now: Instant,
    ) -> Result<Vec<curate::CurateApprovalReceipt>, curate::RemoteCurateError> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| curate::RemoteCurateError::Database("runtime closed".into()))?;
        match self.ensure_storage_idle_at(now) {
            Ok(()) => {
                let receipts = curate::execute_pending_jobs(db, self.music_read_only)?;
                if !receipts.is_empty() {
                    let _ = self.reload_catalog_at(now);
                }
                Ok(receipts)
            }
            Err(RuntimeError::TransportNotIdle) => curate::list_active_jobs(db),
            Err(RuntimeError::CooldownActive { .. }) => curate::mark_pending_jobs_cooling_down(db),
            Err(RuntimeError::Closed) => Err(curate::RemoteCurateError::Database("runtime closed".into())),
            Err(e) => Err(curate::RemoteCurateError::Database(format!("{:?}", e))),
        }
    }

    pub fn get_curate_job(
        &self,
        job_id: &str,
    ) -> Result<Option<curate::CurateApprovalReceipt>, curate::RemoteCurateError> {
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| curate::RemoteCurateError::Database("runtime closed".into()))?;
        curate::get_job(db, job_id)
    }

    fn map_idle_gate(&self, now: Instant) -> Result<(), curate::RemoteCurateError> {
        match self.ensure_storage_idle_at(now) {
            Ok(()) => Ok(()),
            Err(RuntimeError::TransportNotIdle) => Err(curate::RemoteCurateError::TransportNotIdle),
            Err(RuntimeError::CooldownActive { remaining_ms }) => {
                Err(curate::RemoteCurateError::CooldownActive { remaining_ms })
            }
            Err(RuntimeError::Closed) => Err(curate::RemoteCurateError::Database("runtime closed".into())),
            Err(e) => Err(curate::RemoteCurateError::Database(format!("{:?}", e))),
        }
    }

    fn handle_curate_request_at(&mut self, parsed: &Value, now: Instant) -> Value {
        let engine_ok = parsed.get("engineId").and_then(Value::as_str) == Some(self.config.engine_id.as_str());
        let library_ok = parsed.get("libraryId").and_then(Value::as_str) == Some(self.config.library_id.as_str());
        if !engine_ok || !library_ok {
            return json!({ "ok": false, "error": { "code": "identity_mismatch" } });
        }
        let op = parsed.get("operation").and_then(Value::as_str).unwrap_or("");
        match op {
            "curate.draft.save" => {
                let Ok(input) = serde_json::from_value::<curate::CurateDraftInput>(parsed["draft"].clone()) else {
                    return json!({ "ok": false, "error": { "code": "invalid_payload" } });
                };
                match self.save_curate_draft(input) {
                    Ok(rec) => json!({ "ok": true, "data": rec }),
                    Err(e) => curate_err_json(e),
                }
            }
            "curate.dry_run" => {
                let Some(draft_id) = parsed.get("draftId").and_then(Value::as_str) else {
                    return json!({ "ok": false, "error": { "code": "invalid_payload" } });
                };
                match self.dry_run_curate_draft_at(draft_id, now) {
                    Ok(rep) => json!({ "ok": true, "data": rep }),
                    Err(e) => curate_err_json(e),
                }
            }
            "curate.approve" => {
                let (Some(draft_id), Some(hash), Some(cmd_id)) = (
                    parsed.get("draftId").and_then(Value::as_str),
                    parsed.get("approvalHash").and_then(Value::as_str),
                    parsed.get("commandId").and_then(Value::as_str),
                ) else {
                    return json!({ "ok": false, "error": { "code": "invalid_payload" } });
                };
                match self.approve_curate_draft_at(draft_id, hash, cmd_id, now) {
                    Ok(rec) => json!({ "ok": true, "data": rec }),
                    Err(e) => curate_err_json(e),
                }
            }
            "curate.job.status" => {
                let Some(job_id) = parsed.get("jobId").and_then(Value::as_str) else {
                    return json!({ "ok": false, "error": { "code": "invalid_payload" } });
                };
                match self.get_curate_job(job_id) {
                    Ok(Some(rec)) => json!({ "ok": true, "data": rec }),
                    Ok(None) => json!({ "ok": false, "error": { "code": "not_found" } }),
                    Err(e) => curate_err_json(e),
                }
            }
            _ => json!({ "ok": false, "error": { "code": "unsupported_capability" } }),
        }
    }
}

fn curate_err_json(err: curate::RemoteCurateError) -> Value {
    let code = match err {
        curate::RemoteCurateError::RevisionConflict => "stale_revision",
        curate::RemoteCurateError::DraftNotFound | curate::RemoteCurateError::TrackNotFound => "not_found",
        curate::RemoteCurateError::ReadOnlyRoot(_) => "read_only_root",
        curate::RemoteCurateError::ExternalFileChanged => "external_file_changed",
        curate::RemoteCurateError::DuplicateApproval => "duplicate_approval",
        curate::RemoteCurateError::TransportNotIdle | curate::RemoteCurateError::CooldownActive { .. } => "not_ready",
        curate::RemoteCurateError::RootLeasedByOtherWriter(_) => "root_leased",
        _ => "invalid_payload",
    };
    json!({ "ok": false, "error": { "code": code } })
}

fn load_catalog_projection(
    db: &AppDb,
) -> Result<(Vec<CatalogTrack>, HashMap<String, PathBuf>), RuntimeError> {
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.artist_credit, t.album_title, t.duration_secs, t.file_path,
                    t.format, t.sample_rate, t.bit_depth, t.track_number, t.disc_number,
                    COALESCE(t.release_year, r.release_year)
             FROM tracks t
             LEFT JOIN releases r ON t.release_id = r.id
             WHERE t.is_online != 0
             ORDER BY t.album_title ASC, COALESCE(t.disc_number, 1) ASC, COALESCE(t.track_number, 0) ASC, t.title ASC, t.id ASC",
        )
        .map_err(|e| RuntimeError::Database(e.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<i64>>(11)?,
            ))
        })
        .map_err(|e| RuntimeError::Database(e.to_string()))?;

    let mut catalog = Vec::new();
    let mut track_files = HashMap::new();
    let mut used_ids = HashSet::new();

    for row in rows {
        let (
            raw_id,
            title,
            artist,
            album,
            duration_secs,
            file_path,
            raw_format,
            raw_sample_rate,
            raw_bit_depth,
            raw_track_number,
            raw_disc_number,
            raw_release_year,
        ) = row.map_err(|e| RuntimeError::Database(e.to_string()))?;
        let token_id = sanitize_or_hash_token(&raw_id, &mut used_ids);
        let safe_duration = if duration_secs.is_finite() && (0.001..=86_400.0).contains(&duration_secs) {
            duration_secs
        } else {
            1.0
        };
        let normalized_format = raw_format
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_uppercase())
            .or_else(|| {
                std::path::Path::new(&file_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_ascii_uppercase())
            });
        let sample_rate = raw_sample_rate
            .filter(|&v| v > 0 && v <= u32::MAX as i64)
            .map(|v| v as u32);
        let bit_depth = raw_bit_depth
            .filter(|&v| v > 0 && v <= u16::MAX as i64)
            .map(|v| v as u16);
        let track_number = raw_track_number
            .filter(|&v| v > 0 && v <= u32::MAX as i64)
            .map(|v| v as u32);
        let disc_number = raw_disc_number
            .filter(|&v| v > 0 && v <= u16::MAX as i64)
            .map(|v| v as u16);
        let release_year = raw_release_year
            .filter(|&v| (1..=u16::MAX as i64).contains(&v))
            .map(|v| v as u16);

        catalog.push(CatalogTrack {
            id: token_id.clone(),
            title: sanitize_display_text(&title, "Untitled"),
            artist: sanitize_display_text(&artist, "Unknown Artist"),
            album: sanitize_display_text(&album, "Unknown Album"),
            duration_seconds: safe_duration,
            format: normalized_format,
            sample_rate,
            bit_depth,
            track_number,
            disc_number,
            release_year,
        });
        track_files.insert(token_id, PathBuf::from(file_path));
    }

    Ok((catalog, track_files))
}

fn is_valid_v1_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && value != "local"
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn sanitize_or_hash_token(raw_id: &str, used_ids: &mut HashSet<String>) -> String {
    if is_valid_v1_token(raw_id) && used_ids.insert(raw_id.to_string()) {
        return raw_id.to_string();
    }
    let mut counter = 0u32;
    loop {
        let mut hasher = Sha256::new();
        hasher.update(raw_id.as_bytes());
        if counter > 0 {
            hasher.update(counter.to_le_bytes());
        }
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(28);
        hex.push_str("trk_");
        for byte in &digest[..12] {
            use std::fmt::Write;
            let _ = write!(&mut hex, "{:02x}", byte);
        }
        if used_ids.insert(hex.clone()) {
            return hex;
        }
        counter += 1;
    }
}

fn sanitize_display_text(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\t' | '\n'))
        .take(1024)
        .collect();
    if cleaned.trim().is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}
