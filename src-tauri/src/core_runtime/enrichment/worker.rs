use super::artwork_worker::{process_album_artwork_item, process_artist_artwork_item, ArtworkProcessOutcome};
use super::gate::GateRegistry;
use super::image_store::ImageStore;
use super::matcher::{
    evaluate_album_candidates, is_placeholder_value, CandidateAlbum, LocalAlbum, LocalTrack,
    MatchOutcome,
};
use super::providers::{
    AppleMusicProvider, ExternalArtworkProvider, MetadataProvider, MusicBrainzProvider,
    ProviderError,
};
use super::schema::{
    compute_release_raw_signature, ensure_schema, epoch_secs, get_enrichment_config,
    is_entity_or_field_user_locked, mark_curate_queue_projection_stale,
    seed_pending_albums_and_artwork, ProviderGateSnapshot,
};
use crate::db::AppDb;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const COOLDOWN_MS: u64 = 30_000;
const COALESCE_BATCH_SIZE: usize = 5;
const COALESCE_QUIET_SECS: u64 = 2;
const MAX_SSE_EVENTS: usize = 64;

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct EnrichmentIdleGate {
    transport_active: AtomicBool,
    last_stopped_ms: AtomicU64,
    cooldown_ms: AtomicU64,
    user_paused: AtomicBool,
    enabled: AtomicBool,
    shutdown: AtomicBool,
    catalog_dirty_version: AtomicU64,
    curate_prep_in_flight: AtomicUsize,
    last_curate_prep_done_ms: AtomicU64,
    current_album: Mutex<Option<(String, String)>>,
    wake_lock: Mutex<()>,
    wake_cond: Condvar,
    curate_wake_lock: Mutex<()>,
    curate_wake_cond: Condvar,
    cancel_notify: Notify,
    events: Mutex<VecDeque<Value>>,
    gates: Arc<GateRegistry>,
}

impl EnrichmentIdleGate {
    pub fn new(gates: Arc<GateRegistry>) -> Self {
        Self {
            transport_active: AtomicBool::new(false),
            last_stopped_ms: AtomicU64::new(0),
            cooldown_ms: AtomicU64::new(COOLDOWN_MS),
            user_paused: AtomicBool::new(false),
            enabled: AtomicBool::new(true),
            shutdown: AtomicBool::new(false),
            catalog_dirty_version: AtomicU64::new(0),
            curate_prep_in_flight: AtomicUsize::new(0),
            last_curate_prep_done_ms: AtomicU64::new(0),
            current_album: Mutex::new(None),
            wake_lock: Mutex::new(()),
            wake_cond: Condvar::new(),
            curate_wake_lock: Mutex::new(()),
            curate_wake_cond: Condvar::new(),
            cancel_notify: Notify::new(),
            events: Mutex::new(VecDeque::new()),
            gates,
        }
    }

    pub fn set_cooldown_ms(&self, ms: u64) {
        self.cooldown_ms.store(ms, Ordering::Release);
        self.wake();
        self.wake_curate();
    }

    pub fn set_transport_active(&self, active: bool) {
        let was_active = self.transport_active.swap(active, Ordering::AcqRel);
        if active {
            self.cancel_notify.notify_waiters();
        } else if was_active {
            self.last_stopped_ms.store(now_epoch_ms(), Ordering::Release);
        }
        self.wake();
        self.wake_curate();
    }

    pub fn apply_recovery_cooldown(&self, remaining_ms: u64) {
        if remaining_ms == 0 {
            return;
        }
        let cooldown = self.cooldown_ms.load(Ordering::Acquire);
        let elapsed = cooldown.saturating_sub(remaining_ms.min(cooldown));
        let stop_ts = now_epoch_ms().saturating_sub(elapsed);
        self.last_stopped_ms.store(stop_ts, Ordering::Release);
        self.wake();
        self.wake_curate();
    }

    pub fn sync_config(&self, enabled: bool, user_paused: bool) {
        self.enabled.store(enabled, Ordering::Release);
        self.user_paused.store(user_paused, Ordering::Release);
        if !enabled || user_paused {
            self.cancel_notify.notify_waiters();
        }
        self.wake();
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.cancel_notify.notify_waiters();
        self.wake();
        self.wake_curate();
    }

    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }

    pub fn wake(&self) {
        if let Ok(_g) = self.wake_lock.lock() {
            self.wake_cond.notify_all();
        }
    }

    pub fn wake_curate(&self) {
        if let Ok(_g) = self.curate_wake_lock.lock() {
            self.curate_wake_cond.notify_all();
        }
    }

    pub fn wait_curate(&self, max_wait: Duration) {
        if let Ok(guard) = self.curate_wake_lock.lock() {
            let _ = self.curate_wake_cond.wait_timeout(guard, max_wait);
        }
    }

    pub fn is_transport_active(&self) -> bool {
        self.transport_active.load(Ordering::Acquire)
    }

    pub fn is_transport_storage_idle(&self) -> bool {
        !self.shutdown.load(Ordering::Acquire)
            && !self.transport_active.load(Ordering::Acquire)
            && self.cooldown_remaining_ms() == 0
    }

    pub fn begin_curate_prep(&self) {
        self.curate_prep_in_flight.fetch_add(1, Ordering::AcqRel);
    }

    pub fn end_curate_prep(&self) {
        self.last_curate_prep_done_ms
            .store(now_epoch_ms(), Ordering::Release);
        self.curate_prep_in_flight.fetch_sub(1, Ordering::AcqRel);
        self.wake_curate();
    }

    pub fn curate_prep_settle_remaining_ms(&self, settle_ms: u64) -> u64 {
        if self.curate_prep_in_flight.load(Ordering::Acquire) > 0 {
            return settle_ms;
        }
        let last = self.last_curate_prep_done_ms.load(Ordering::Acquire);
        if last == 0 {
            return 0;
        }
        settle_ms.saturating_sub(now_epoch_ms().saturating_sub(last))
    }

    pub fn cooldown_remaining_ms(&self) -> u64 {
        if self.transport_active.load(Ordering::Acquire) {
            return self.cooldown_ms.load(Ordering::Acquire);
        }
        let stopped = self.last_stopped_ms.load(Ordering::Acquire);
        if stopped == 0 {
            return 0;
        }
        let cooldown = self.cooldown_ms.load(Ordering::Acquire);
        let elapsed = now_epoch_ms().saturating_sub(stopped);
        cooldown.saturating_sub(elapsed)
    }

    pub fn is_idle_now(&self) -> bool {
        !self.shutdown.load(Ordering::Acquire)
            && self.enabled.load(Ordering::Acquire)
            && !self.user_paused.load(Ordering::Acquire)
            && !self.transport_active.load(Ordering::Acquire)
            && self.cooldown_remaining_ms() == 0
    }

    pub fn runtime_state(&self) -> (&'static str, Option<u64>) {
        if !self.enabled.load(Ordering::Acquire) {
            return ("disabled", None);
        }
        if self.user_paused.load(Ordering::Acquire) {
            return ("user_paused", None);
        }
        if self.transport_active.load(Ordering::Acquire) {
            return ("paused_playback", None);
        }
        let rem = self.cooldown_remaining_ms();
        if rem > 0 {
            return ("cooldown", Some(rem.div_ceil(1000).max(1)));
        }
        ("active", None)
    }

    pub fn current_album(&self) -> Option<(String, String)> {
        self.current_album.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_current_album(&self, album: Option<(String, String)>) {
        if let Ok(mut g) = self.current_album.lock() {
            *g = album;
        }
    }

    pub fn mark_catalog_dirty(&self) {
        self.catalog_dirty_version.fetch_add(1, Ordering::AcqRel);
    }

    pub fn catalog_dirty_version(&self) -> u64 {
        self.catalog_dirty_version.load(Ordering::Acquire)
    }

    pub fn push_event(&self, event: &str, data: Value) {
        if let Ok(mut q) = self.events.lock() {
            if q.len() >= MAX_SSE_EVENTS {
                q.pop_front();
            }
            q.push_back(json!({ "event": event, "data": data }));
        }
    }

    pub fn take_events(&self) -> Vec<Value> {
        self.events
            .lock()
            .map(|mut q| q.drain(..).collect())
            .unwrap_or_default()
    }

    pub fn provider_gates_snapshot(&self) -> Vec<ProviderGateSnapshot> {
        self.gates.snapshot()
    }

    pub fn cancel_notify(&self) -> &Notify {
        &self.cancel_notify
    }
}

pub struct CuratePrepGuard {
    gate: Arc<EnrichmentIdleGate>,
}

impl CuratePrepGuard {
    pub fn acquire(gate: Arc<EnrichmentIdleGate>) -> Self {
        gate.begin_curate_prep();
        Self { gate }
    }
}

impl Drop for CuratePrepGuard {
    fn drop(&mut self) {
        self.gate.end_curate_prep();
    }
}

pub struct EnrichmentWorkerConfig {
    pub db_path: PathBuf,
    pub artwork_dir: PathBuf,
    pub enable_external: bool,
}

pub struct EnrichmentWorker {
    gate: Arc<EnrichmentIdleGate>,
    join: Option<JoinHandle<()>>,
}

impl EnrichmentWorker {
    pub fn start(
        db: &AppDb,
        config: EnrichmentWorkerConfig,
        gate: Arc<EnrichmentIdleGate>,
        gates: Arc<GateRegistry>,
    ) -> Self {
        {
            let conn = db.conn.lock();
            let _ = ensure_schema(&conn);
            if let Ok((enabled, user_paused, _)) = get_enrichment_config(&conn) {
                gate.sync_config(enabled, user_paused);
            }
        }

        let providers: Vec<Arc<dyn MetadataProvider>> = if config.enable_external {
            vec![
                Arc::new(MusicBrainzProvider::new(Arc::clone(&gates))),
                Arc::new(AppleMusicProvider::new(Arc::clone(&gates))),
            ]
        } else {
            Vec::new()
        };
        let ext_art: Option<Arc<dyn ExternalArtworkProvider>> = if config.enable_external {
            Some(Arc::new(super::providers::CompositeArtworkProvider::new(
                Arc::clone(&gates),
            )))
        } else {
            None
        };

        Self::start_with_providers(config, gate, providers, ext_art)
    }

    pub fn start_with_providers(
        config: EnrichmentWorkerConfig,
        gate: Arc<EnrichmentIdleGate>,
        providers: Vec<Arc<dyn MetadataProvider>>,
        external_artwork: Option<Arc<dyn ExternalArtworkProvider>>,
    ) -> Self {
        let gate_thread = Arc::clone(&gate);
        let join = thread::Builder::new()
            .name("cadence-enrichment".into())
            .spawn(move || {
                apply_background_thread_isolation();
                run_worker_loop(config, gate_thread, providers, external_artwork);
            })
            .ok();

        Self { gate, join }
    }

    pub fn gate(&self) -> &Arc<EnrichmentIdleGate> {
        &self.gate
    }

    pub fn shutdown(&mut self) {
        self.gate.shutdown();
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for EnrichmentWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn configure_background_thread() {
    apply_background_thread_isolation();
}

fn apply_background_thread_isolation() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadAffinityMask, SetThreadPriority,
            THREAD_MODE_BACKGROUND_BEGIN, THREAD_PRIORITY_BELOW_NORMAL,
        };
        if SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) == 0 {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
        let cores = thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(usize::BITS as usize);
        if cores >= 4 {
            let all = if cores == usize::BITS as usize {
                usize::MAX
            } else {
                (1usize << cores) - 1
            };
            let _ = SetThreadAffinityMask(GetCurrentThread(), all & !0b11);
        }
    }
    #[cfg(unix)]
    unsafe {
        let _ = libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

fn open_worker_db(db_path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn run_worker_loop(
    config: EnrichmentWorkerConfig,
    gate: Arc<EnrichmentIdleGate>,
    providers: Vec<Arc<dyn MetadataProvider>>,
    external_artwork: Option<Arc<dyn ExternalArtworkProvider>>,
) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let Ok(mut conn) = open_worker_db(&config.db_path) else {
        return;
    };
    let store = ImageStore::new(config.artwork_dir);

    let mut pending_catalog_flush = 0usize;
    let mut last_change_at: Option<Instant> = None;

    let flush_coalesced_if_needed =
        |force: bool, count: &mut usize, last_at: &mut Option<Instant>| {
            if *count == 0 {
                return;
            }
            let quiet_elapsed = last_at
                .map(|t| t.elapsed() >= Duration::from_secs(COALESCE_QUIET_SECS))
                .unwrap_or(false);
            if force || *count >= COALESCE_BATCH_SIZE || quiet_elapsed {
                *count = 0;
                *last_at = None;
                gate.mark_catalog_dirty();
            }
        };

    while !gate.is_shutdown() {
        // Wait while playback, cooldown, pause, or disable is active
        if !gate.is_idle_now() {
            gate.set_current_album(None);
            flush_coalesced_if_needed(true, &mut pending_catalog_flush, &mut last_change_at);

            // User-staged cover art overrides (priority 0) still finish downloading when
            // Auto-Enrichment is paused or disabled, provided transport/storage are strictly idle.
            if gate.is_transport_storage_idle() {
                if let Some((_kind, entity_id, _prio, enq_at, attempts)) =
                    next_user_override_artwork_item(&conn)
                {
                    let is_transport_idle_closure = || gate.is_transport_storage_idle();
                    let outcome = rt.block_on(process_album_artwork_item(
                        &mut conn,
                        &store,
                        external_artwork.as_ref(),
                        &entity_id,
                        enq_at,
                        attempts,
                        500,
                        false,
                        &is_transport_idle_closure,
                        gate.cancel_notify(),
                    ));
                    match outcome {
                        ArtworkProcessOutcome::Found => {
                            gate.push_event(
                                "enrichment.updated",
                                json!({ "releaseId": entity_id, "artworkOutcome": "Found" }),
                            );
                            gate.mark_catalog_dirty();
                        }
                        ArtworkProcessOutcome::RetryLater(_) | ArtworkProcessOutcome::Absent => {
                            gate.push_event(
                                "enrichment.updated",
                                json!({ "releaseId": entity_id, "artworkOutcome": format!("{outcome:?}") }),
                            );
                        }
                        _ => {}
                    }
                    continue;
                }
            }

            let wait_dur = if !gate.enabled.load(Ordering::Acquire)
                || gate.user_paused.load(Ordering::Acquire)
                || gate.transport_active.load(Ordering::Acquire)
            {
                Duration::from_secs(5)
            } else {
                let rem = gate.cooldown_remaining_ms();
                Duration::from_millis(rem.clamp(50, 5000))
            };
            if let Ok(guard) = gate.wake_lock.lock() {
                let _ = gate.wake_cond.wait_timeout(guard, wait_dur);
            }
            continue;
        }

        // Sync config & seed new/changed releases
        if let Ok((enabled, user_paused, min_local_px)) = get_enrichment_config(&conn) {
            gate.sync_config(enabled, user_paused);
            if !gate.is_idle_now() {
                continue;
            }
            let _ = seed_pending_albums_and_artwork(&conn);

            let mut did_work = false;

            // Step A: Local-only artwork pass & priority-0 user cover overrides
            if let Some((art_kind, entity_id, prio, enq_at, attempts)) =
                next_artwork_item(&conn, true)
            {
                did_work = true;
                if art_kind == "album" {
                    let is_idle_closure = || gate.is_idle_now();
                    let outcome = rt.block_on(process_album_artwork_item(
                        &mut conn,
                        &store,
                        external_artwork.as_ref(),
                        &entity_id,
                        enq_at,
                        attempts,
                        min_local_px,
                        false,
                        &is_idle_closure,
                        gate.cancel_notify(),
                    ));
                    if matches!(
                        outcome,
                        ArtworkProcessOutcome::Found | ArtworkProcessOutcome::FoundStale
                    ) {
                        pending_catalog_flush += 1;
                        last_change_at = Some(Instant::now());
                        gate.push_event(
                            "enrichment.updated",
                            json!({ "releaseId": entity_id, "artworkOutcome": format!("{outcome:?}") }),
                        );
                        if prio == 0 && outcome == ArtworkProcessOutcome::Found {
                            flush_coalesced_if_needed(
                                true,
                                &mut pending_catalog_flush,
                                &mut last_change_at,
                            );
                        }
                    } else if prio == 0
                        && matches!(
                            outcome,
                            ArtworkProcessOutcome::RetryLater(_) | ArtworkProcessOutcome::Absent
                        )
                    {
                        gate.push_event(
                            "enrichment.updated",
                            json!({ "releaseId": entity_id, "artworkOutcome": format!("{outcome:?}") }),
                        );
                    }
                    if outcome == ArtworkProcessOutcome::FoundStale {
                        // Bump priority slightly above 10 so external pass upgrades it
                        let _ = conn.execute(
                            "UPDATE artwork_queue SET priority = 20, next_retry_at = ?2 WHERE entity_kind='album' AND entity_id=?1",
                            params![entity_id, epoch_secs()],
                        );
                    }
                }
            }

            if !gate.is_idle_now() {
                continue;
            }

            // Step B: Text Metadata Enrichment (1 album per step)
            if !providers.is_empty() {
                if let Some(release_id) = next_pending_album(&conn) {
                    did_work = true;
                    let changed = rt.block_on(process_text_enrichment_album(
                        &mut conn,
                        &release_id,
                        &providers,
                        &gate,
                    ));
                    gate.set_current_album(None);
                    if changed {
                        pending_catalog_flush += 1;
                        last_change_at = Some(Instant::now());
                    }
                }
            }

            if !gate.is_idle_now() {
                continue;
            }

            // Step C: External Artwork pass (albums needing art/upgrade, then artist portraits)
            if external_artwork.is_some() {
                if let Some((art_kind, entity_id, _prio, enq_at, attempts)) =
                    next_artwork_item(&conn, false)
                {
                    did_work = true;
                    let is_idle_closure = || gate.is_idle_now();
                    let outcome = if art_kind == "album" {
                        rt.block_on(process_album_artwork_item(
                            &mut conn,
                            &store,
                            external_artwork.as_ref(),
                            &entity_id,
                            enq_at,
                            attempts,
                            min_local_px,
                            true,
                            &is_idle_closure,
                            gate.cancel_notify(),
                        ))
                    } else {
                        rt.block_on(process_artist_artwork_item(
                            &mut conn,
                            &store,
                            external_artwork.as_ref(),
                            &entity_id,
                            enq_at,
                            attempts,
                            &is_idle_closure,
                            gate.cancel_notify(),
                        ))
                    };
                    if matches!(
                        outcome,
                        ArtworkProcessOutcome::Found | ArtworkProcessOutcome::FoundStale
                    ) {
                        if art_kind == "album" {
                            pending_catalog_flush += 1;
                            last_change_at = Some(Instant::now());
                            gate.push_event(
                                "enrichment.updated",
                                json!({ "releaseId": entity_id, "artworkOutcome": format!("{outcome:?}") }),
                            );
                        } else {
                            gate.push_event(
                                "enrichment.updated",
                                json!({ "artistId": entity_id, "artworkOutcome": format!("{outcome:?}") }),
                            );
                        }
                    }
                    if matches!(outcome, ArtworkProcessOutcome::RetryLater(_) | ArtworkProcessOutcome::Absent) {
                        crate::diag_log!(
                            crate::diagnostics::DiagCategory::Enrichment,
                            0,
                            0,
                            0,
                            "artwork_external_outcome",
                            "kind={} id={} outcome={:?}",
                            art_kind,
                            entity_id,
                            outcome
                        );
                    }
                }
            }

            flush_coalesced_if_needed(
                !did_work,
                &mut pending_catalog_flush,
                &mut last_change_at,
            );

            if !did_work {
                if let Ok(guard) = gate.wake_lock.lock() {
                    let _ = gate.wake_cond.wait_timeout(guard, Duration::from_secs(5));
                }
            }
        } else {
            thread::sleep(Duration::from_secs(2));
        }
    }
}

pub(crate) fn next_user_override_artwork_item(
    conn: &Connection,
) -> Option<(String, String, i64, i64, i64)> {
    let now = epoch_secs();
    conn.query_row(
        "SELECT entity_kind, entity_id, priority, enqueued_at, attempts
         FROM artwork_queue
         WHERE entity_kind = 'album'
           AND override_url IS NOT NULL
           AND TRIM(override_url) != ''
           AND next_retry_at <= ?1
         ORDER BY priority ASC, enqueued_at ASC
         LIMIT 1",
        params![now],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )
    .optional()
    .ok()
    .flatten()
}

fn next_artwork_item(conn: &Connection, local_only_priority: bool) -> Option<(String, String, i64, i64, i64)> {
    let now = epoch_secs();
    let max_prio = if local_only_priority { 15 } else { 100 };
    conn.query_row(
        "SELECT entity_kind, entity_id, priority, enqueued_at, attempts
         FROM artwork_queue
         WHERE next_retry_at <= ?1 AND priority <= ?2
         ORDER BY priority ASC, enqueued_at ASC
         LIMIT 1",
        params![now, max_prio],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )
    .optional()
    .ok()
    .flatten()
}

fn next_pending_album(conn: &Connection) -> Option<String> {
    let now = epoch_secs();
    conn.query_row(
        "SELECT e.release_id
         FROM enrichment_album_state e
         JOIN releases r ON r.id = e.release_id
         WHERE e.status = 'pending'
           AND e.next_retry_at <= ?1
           AND EXISTS(SELECT 1 FROM tracks t WHERE t.release_id = e.release_id AND t.is_online != 0)
         ORDER BY
           CASE WHEN COALESCE(TRIM(r.artist_credit), '') = '' OR LOWER(TRIM(r.artist_credit)) IN ('unknown', 'unknown artist') THEN 0 ELSE 1 END ASC,
           e.attempt_count ASC,
           e.updated_at ASC
         LIMIT 1",
        params![now],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn load_local_album_for_matching(
    conn: &Connection,
    release_id: &str,
) -> rusqlite::Result<Option<LocalAlbum>> {
    let rel: Option<(String, String, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT title, artist_credit, release_year, is_compilation FROM releases WHERE id = ?1",
            params![release_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((title, artist, year, is_comp)) = rel else {
        return Ok(None);
    };

    let album_locked = is_entity_or_field_user_locked(conn, "release", release_id, "*")?;
    let mut locked_release_fields = HashSet::new();
    for f in ["album", "album_artist", "year", "composer", "genre"] {
        if is_entity_or_field_user_locked(conn, "release", release_id, f)? {
            locked_release_fields.insert(f.to_string());
        }
    }

    let mut tracks = Vec::new();
    let mut max_disc = 1u32;
    let mut stmt = conn.prepare(
        "SELECT id, title, artist_credit, album_artist, track_number, disc_number,
                duration_secs, release_year, musicbrainz_recording_id, original_album, is_compilation
         FROM tracks
         WHERE release_id = ?1 AND is_online != 0
         ORDER BY COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC, title ASC, id ASC",
    )?;
    for row in stmt.query_map(params![release_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u32),
            r.get::<_, Option<i64>>(5)?.map(|v| v.max(0) as u32),
            r.get::<_, f64>(6)?,
            r.get::<_, Option<i64>>(7)?.map(|v| v as i32),
            r.get::<_, Option<String>>(8)?,
            r.get::<_, Option<String>>(9)?,
            r.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
        ))
    })? {
        let (
            track_id,
            t_title,
            t_artist,
            t_album_artist,
            track_number,
            disc_number,
            duration_secs,
            release_year,
            mb_recording_id,
            original_album,
            is_track_comp,
        ) = row?;
        if let Some(d) = disc_number {
            max_disc = max_disc.max(d);
        }
        let mut locked_fields = HashSet::new();
        for f in ["track_title", "track_artist", "year"] {
            if is_entity_or_field_user_locked(conn, "track", &track_id, f)? {
                locked_fields.insert(f.to_string());
            }
        }
        tracks.push(LocalTrack {
            track_id,
            title: t_title,
            artist: t_artist,
            album_artist: t_album_artist,
            track_number,
            disc_number,
            duration_secs,
            release_year,
            mb_recording_id,
            original_album,
            is_compilation: is_track_comp,
            locked_fields,
        });
    }

    if tracks.is_empty() {
        return Ok(None);
    }

    let effective_artist = if is_placeholder_value(&artist) {
        tracks
            .iter()
            .find_map(|t| t.album_artist.as_deref().filter(|a| !is_placeholder_value(a)))
            .unwrap_or(&artist)
            .to_string()
    } else {
        artist
    };

    Ok(Some(LocalAlbum {
        release_id: release_id.to_string(),
        title,
        artist: effective_artist,
        year: year.map(|y| y as i32),
        is_compilation: is_comp.unwrap_or(0) != 0 || tracks.iter().any(|t| t.is_compilation),
        discs_total: max_disc,
        locked_release_fields,
        album_locked,
        tracks,
    }))
}

pub async fn process_text_enrichment_album(
    conn: &mut Connection,
    release_id: &str,
    providers: &[Arc<dyn MetadataProvider>],
    gate: &EnrichmentIdleGate,
) -> bool {
    if !gate.is_idle_now() {
        return false;
    }
    let Ok(Some(local)) = load_local_album_for_matching(conn, release_id) else {
        let _ = conn.execute(
            "DELETE FROM enrichment_album_state WHERE release_id = ?1",
            params![release_id],
        );
        return false;
    };

    if local.album_locked {
        let _ = conn.execute(
            "UPDATE enrichment_album_state SET status='user_locked', updated_at=CURRENT_TIMESTAMP WHERE release_id=?1",
            params![release_id],
        );
        return false;
    }

    gate.set_current_album(Some((release_id.to_string(), local.title.clone())));
    let enrich_t0 = crate::diagnostics::is_active().then(Instant::now);

    let mut all_candidates: Vec<CandidateAlbum> = Vec::new();
    let mut transient_error: Option<(String, Option<Duration>)> = None;

    for provider in providers {
        if !gate.is_idle_now() {
            return false;
        }
        match provider.lookup_album(&local, gate.cancel_notify()).await {
            Ok(cands) => all_candidates.extend(cands),
            Err(ProviderError::Cancelled) => return false,
            Err(ProviderError::NotFound) => {}
            Err(ProviderError::RetryLater(d)) | Err(ProviderError::CircuitOpen(d)) => {
                transient_error = Some((format!("rate/breaker deferred {}s", d.as_secs()), Some(d)));
            }
            Err(ProviderError::Transient(msg)) => {
                transient_error = Some((msg, None));
            }
        }
    }

    if !gate.is_idle_now() {
        return false;
    }

    if all_candidates.is_empty() {
        if let Some((err_msg, retry_delay)) = transient_error {
            let attempts: i64 = conn
                .query_row(
                    "SELECT attempt_count FROM enrichment_album_state WHERE release_id = ?1",
                    params![release_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let delay = retry_delay
                .map(|d| d.as_secs() as i64)
                .unwrap_or_else(|| (30i64 * (1i64 << attempts.clamp(0, 7))).min(3600));
            let next_retry = epoch_secs() + delay.max(10);
            let _ = conn.execute(
                "UPDATE enrichment_album_state
                 SET attempt_count = ?2, next_retry_at = ?3, last_error = ?4, updated_at = CURRENT_TIMESTAMP
                 WHERE release_id = ?1",
                params![release_id, attempts + 1, next_retry, err_msg],
            );
            let dur_us = enrich_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
            crate::diag_log!(
                crate::diagnostics::DiagCategory::Enrichment,
                0,
                0,
                dur_us,
                "enrichment_album_deferred",
                "release={} attempts={} retry_s={} err={}",
                release_id,
                attempts + 1,
                delay.max(10),
                err_msg
            );
            return false;
        }
    }

    let eval = evaluate_album_candidates(&local, &all_candidates);
    let sig = compute_release_raw_signature(conn, release_id)
        .ok()
        .flatten()
        .unwrap_or_default();

    let vetoes_json = serde_json::to_string(&eval.vetoes).unwrap_or_else(|_| "[]".into());
    let proposal_json = eval
        .proposal
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());

    let mut applied_any = false;
    let Ok(tx) = conn.transaction() else {
        return false;
    };

    if let Some(ref prop) = eval.proposal {
        let conf = (1.0 - eval.effective_distance).clamp(0.0, 1.0);
        for field in &prop.auto_apply_release_fields {
            if is_entity_or_field_user_locked(&tx, "release", release_id, field).unwrap_or(true) {
                continue;
            }
            let val: Option<String> = match field.as_str() {
                "album" => prop.album.clone(),
                "album_artist" => prop.album_artist.clone(),
                "year" => prop.year.map(|y| y.to_string()),
                "composer" => prop.composer.clone(),
                "genre" => prop.genre.clone(),
                _ => None,
            };
            if let Some(v) = val.filter(|s| !s.trim().is_empty()) {
                let _ = tx.execute(
                    "INSERT INTO metadata_overlays
                        (entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, source_signature, updated_at)
                     VALUES('release', ?1, ?2, ?3, 'auto', ?4, ?5, ?6, 0, ?7, CURRENT_TIMESTAMP)
                     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
                        value_text = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.value_text ELSE excluded.value_text END,
                        origin = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.origin ELSE 'auto' END,
                        provider = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.provider ELSE excluded.provider END,
                        confidence = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.confidence ELSE excluded.confidence END,
                        distance = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.distance ELSE excluded.distance END,
                        source_signature = excluded.source_signature,
                        updated_at = CURRENT_TIMESTAMP",
                    params![release_id, field, v, prop.provider, conf, eval.distance, sig],
                );
                applied_any = true;
            }
        }

        for tr in &prop.tracks {
            for field in &tr.auto_apply_fields {
                if is_entity_or_field_user_locked(&tx, "track", &tr.local_track_id, field).unwrap_or(true) {
                    continue;
                }
                let val: Option<&String> = match field.as_str() {
                    "track_artist" => tr.proposed_artist.as_ref(),
                    "track_title" => tr.proposed_title.as_ref(),
                    _ => None,
                };
                if let Some(v) = val.filter(|s| !s.trim().is_empty()) {
                    let _ = tx.execute(
                        "INSERT INTO metadata_overlays
                            (entity_type, entity_id, field_name, value_text, origin, provider, confidence, distance, locked, source_signature, updated_at)
                         VALUES('track', ?1, ?2, ?3, 'auto', ?4, ?5, ?6, 0, ?7, CURRENT_TIMESTAMP)
                         ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
                            value_text = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.value_text ELSE excluded.value_text END,
                            origin = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.origin ELSE 'auto' END,
                            provider = CASE WHEN metadata_overlays.origin = 'user' OR metadata_overlays.locked = 1 THEN metadata_overlays.provider ELSE excluded.provider END,
                            source_signature = excluded.source_signature,
                            updated_at = CURRENT_TIMESTAMP",
                        params![tr.local_track_id, field, v, prop.provider, conf, tr.track_distance, sig],
                    );
                    applied_any = true;
                }
            }
        }
    }

    let status_str = match eval.outcome {
        MatchOutcome::AutoApply => "auto_applied",
        MatchOutcome::NeedsReview => "needs_review",
        MatchOutcome::NoMatch => "no_match",
    };

    let (prov_opt, ext_opt) = eval
        .proposal
        .as_ref()
        .map(|p| (Some(p.provider.as_str()), Some(p.external_release_id.as_str())))
        .unwrap_or((None, None));

    let _ = tx.execute(
        "INSERT INTO enrichment_album_state
            (release_id, status, provider, external_release_id, distance, runner_up_distance, vetoes_json, proposal_json, raw_signature, attempt_count, next_retry_at, last_error, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(release_id) DO UPDATE SET
            status = excluded.status,
            provider = excluded.provider,
            external_release_id = excluded.external_release_id,
            distance = excluded.distance,
            runner_up_distance = excluded.runner_up_distance,
            vetoes_json = excluded.vetoes_json,
            proposal_json = excluded.proposal_json,
            raw_signature = excluded.raw_signature,
            attempt_count = 0,
            next_retry_at = 0,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP",
        params![
            release_id,
            status_str,
            prov_opt,
            ext_opt,
            eval.distance,
            eval.runner_up_distance,
            vetoes_json,
            proposal_json,
            sig
        ],
    );

    if applied_any {
        let _ = mark_curate_queue_projection_stale(&tx, release_id);
    }

    if eval.proposal.as_ref().and_then(|p| p.artwork_url.as_ref()).is_some() {
        let art_status: Option<String> = tx
            .query_row(
                "SELECT status FROM artwork_items WHERE entity_kind='album' AND entity_id=?1",
                params![release_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        if matches!(art_status.as_deref(), None | Some("absent" | "found_stale")) {
            let now = epoch_secs();
            let _ = tx.execute(
                "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, last_error)
                 VALUES('album', ?1, 18, 0, 0, ?2, NULL)
                 ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                    priority = MIN(artwork_queue.priority, 18),
                    next_retry_at = 0",
                params![release_id, now],
            );
        }
    }

    if tx.commit().is_err() {
        return false;
    }

    let dur_us = enrich_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
    crate::diag_log!(
        crate::diagnostics::DiagCategory::Enrichment,
        0,
        0,
        dur_us,
        "enrichment_album_evaluated",
        "release={} status={} provider={} dist={:.3} applied={}",
        release_id,
        status_str,
        prov_opt.unwrap_or("none"),
        eval.distance,
        applied_any
    );

    gate.push_event(
        "enrichment.updated",
        json!({
            "releaseId": release_id,
            "status": status_str,
            "appliedOverlay": applied_any,
        }),
    );

    applied_any
}
