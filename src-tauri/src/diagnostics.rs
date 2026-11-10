//! Non-blocking, preallocated audiophile diagnostic logging subsystem.
//!
//! Architecture invariants:
//! - Mode `Off` (default): producers execute only a relaxed atomic load; zero formatting,
//!   zero allocations, zero mutexes, zero syscalls, zero disk I/O.
//! - Modes `Debug` and `DiagnosticCapture`: producers write fixed-size inline records into a
//!   bounded preallocated lock-free MPSC ring buffer using atomic sequence counters only.
//!   Submission never acquires a mutex, touches the filesystem, or waits for another thread.
//!   On overflow, new events are dropped immediately and `dropped_events` is incremented.
//! - Dedicated low-priority background writer (`cadence-diag-writer`, background I/O priority
//!   on Windows, pinned off Core 0/1) owns the AppData log file exclusively:
//!   * `Debug`: persists to AppData ONLY when playback is fully idle (not playing, not paused,
//!     not loading, and past the 30s post-playback cooldown). Paused playback remains protected.
//!   * `DiagnosticCapture`: flushes buffered events periodically even during active or paused
//!     playback, explicitly relaxing audio-hygiene disk silence for capturing live hangs.
//!
//! Crash / hang trade-off:
//! Because `Debug` buffers events in memory while playback is active, paused, or cooling down,
//! a hard crash, fatal hang, or forced termination before playback becomes idle may lose
//! un-flushed events in RAM. Even `DiagnosticCapture` persists asynchronously off the audio
//! path, so an abrupt termination may lose the most recent micro-batch.

use std::cell::UnsafeCell;
use std::collections::VecDeque;
use std::fmt::{self, Write as FmtWrite};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write as IoWrite};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const DEFAULT_RING_CAPACITY: usize = 2048;
pub const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const COOLDOWN_DURATION: Duration = Duration::from_secs(30);
const RECENT_UI_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Off = 0,
    Debug = 1,
    DiagnosticCapture = 2,
}

impl CaptureMode {
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => Self::Debug,
            2 => Self::DiagnosticCapture,
            _ => Self::Off,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Debug => "debug",
            Self::DiagnosticCapture => "diagnostic_capture",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagCategory {
    DeviceDiscovery = 0,
    DeviceSelection = 1,
    AudioRouting = 2,
    PlaybackLifecycle = 3,
    WasapiLifecycle = 4,
    UpnpLifecycle = 5,
    QueueCoordination = 6,
    AudioEngineCommands = 7,
    BackgroundWorkers = 8,
    AudioHygiene = 9,
}

impl DiagCategory {
    pub fn from_str_key(s: &str) -> Self {
        match s {
            "device_discovery" => Self::DeviceDiscovery,
            "device_selection" => Self::DeviceSelection,
            "audio_routing" => Self::AudioRouting,
            "playback_lifecycle" => Self::PlaybackLifecycle,
            "wasapi_lifecycle" => Self::WasapiLifecycle,
            "upnp_lifecycle" => Self::UpnpLifecycle,
            "queue_coordination" => Self::QueueCoordination,
            "audio_engine_commands" => Self::AudioEngineCommands,
            "background_workers" => Self::BackgroundWorkers,
            "audio_hygiene" => Self::AudioHygiene,
            _ => Self::BackgroundWorkers,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeviceDiscovery => "DEVICE_DISCOVERY",
            Self::DeviceSelection => "DEVICE_SELECTION",
            Self::AudioRouting => "AUDIO_ROUTING",
            Self::PlaybackLifecycle => "PLAYBACK_LIFECYCLE",
            Self::WasapiLifecycle => "WASAPI_LIFECYCLE",
            Self::UpnpLifecycle => "UPNP_LIFECYCLE",
            Self::QueueCoordination => "QUEUE_COORDINATION",
            Self::AudioEngineCommands => "AUDIO_ENGINE_CMD",
            Self::BackgroundWorkers => "BACKGROUND_WORKER",
            Self::AudioHygiene => "AUDIO_HYGIENE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HygieneState {
    Idle,
    Playing,
    Paused,
    Loading,
    Cooldown { remaining_secs: u64 },
}

impl HygieneState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Playing => "playing",
            Self::Paused => "paused",
            Self::Loading => "loading",
            Self::Cooldown { .. } => "cooldown",
        }
    }

    pub fn cooldown_secs(self) -> Option<u64> {
        match self {
            Self::Cooldown { remaining_secs } => Some(remaining_secs),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogState {
    pub mode: CaptureMode,
    pub ring_capacity: usize,
    pub buffered_approx: usize,
    pub dropped_count: u64,
    pub persisted_count: u64,
    pub hygiene_state: String,
    pub cooldown_remaining_secs: Option<u64>,
    pub log_file_path: Option<String>,
    pub log_dir_path: Option<String>,
    pub last_flush_error: Option<String>,
}

/// Fixed-size UTF-8 stack buffer avoiding any heap allocation when formatting log payloads.
struct FixedUtf8Buf<const CAP: usize> {
    buf: [u8; CAP],
    len: usize,
}

impl<const CAP: usize> FixedUtf8Buf<CAP> {
    #[inline]
    fn new() -> Self {
        Self {
            buf: [0u8; CAP],
            len: 0,
        }
    }

    #[inline]
    fn from_str_truncated(s: &str) -> ([u8; CAP], usize) {
        let mut out = Self::new();
        let _ = out.write_str(s);
        (out.buf, out.len)
    }
}

impl<const CAP: usize> FmtWrite for FixedUtf8Buf<CAP> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let remaining = CAP.saturating_sub(self.len);
        if remaining == 0 || s.is_empty() {
            return Ok(());
        }
        let bytes = s.as_bytes();
        let mut take = bytes.len().min(remaining);
        // Step back until we land on a valid UTF-8 codepoint boundary.
        while take > 0 && !s.is_char_boundary(take) {
            take -= 1;
        }
        self.buf[self.len..self.len + take].copy_from_slice(&bytes[..take]);
        self.len += take;
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub struct DiagEvent {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub category: DiagCategory,
    pub correlation_id: u64,
    pub wait_us: u64,
    pub exec_us: u64,
    pub thread_name: [u8; 24],
    pub thread_name_len: u8,
    pub event: [u8; 32],
    pub event_len: u8,
    pub detail: [u8; 256],
    pub detail_len: u16,
}

impl DiagEvent {
    pub const EMPTY: Self = Self {
        seq: 0,
        timestamp_ms: 0,
        category: DiagCategory::BackgroundWorkers,
        correlation_id: 0,
        wait_us: 0,
        exec_us: 0,
        thread_name: [0u8; 24],
        thread_name_len: 0,
        event: [0u8; 32],
        event_len: 0,
        detail: [0u8; 256],
        detail_len: 0,
    };

    pub fn format_line(&self, out: &mut String) {
        let secs = (self.timestamp_ms / 1000) as i64;
        let millis = (self.timestamp_ms % 1000) as u32;
        let ts_str = DateTime::<Utc>::from_timestamp(secs, millis * 1_000_000)
            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
            .unwrap_or_else(|| format!("{}ms", self.timestamp_ms));
        let thread = std::str::from_utf8(&self.thread_name[..self.thread_name_len as usize])
            .unwrap_or("unknown");
        let event = std::str::from_utf8(&self.event[..self.event_len as usize])
            .unwrap_or("event");
        let detail = std::str::from_utf8(&self.detail[..self.detail_len as usize])
            .unwrap_or("");
        let _ = writeln!(
            out,
            "{} | #{:<6} | {:<18} | {:<19} | {:<28} | cid={} | wait_us={} | exec_us={} | {}",
            ts_str,
            self.seq,
            thread,
            self.category.as_str(),
            event,
            self.correlation_id,
            self.wait_us,
            self.exec_us,
            detail
        );
    }
}

#[repr(align(64))]
struct Slot {
    seq: AtomicU64,
    event: UnsafeCell<DiagEvent>,
}

// SAFETY: Access to `Slot::event` is strictly synchronized through `Slot::seq`:
// producers gain exclusive write access via `enqueue_pos` CAS while `seq == pos`,
// write, then release-store `seq = pos + 1`. The single consumer only reads while
// `seq == pos + 1`, then release-stores `seq = pos + capacity`.
unsafe impl Sync for Slot {}

/// Preallocated, bounded, non-blocking MPSC ring buffer.
pub struct LockFreeDiagRing {
    capacity: usize,
    mask: usize,
    slots: Box<[Slot]>,
    enqueue_pos: AtomicU64,
    dequeue_pos: AtomicU64,
    next_seq: AtomicU64,
    dropped_total: AtomicU64,
    unreported_drops: AtomicU64,
    consumer_guard: Mutex<()>,
}

impl LockFreeDiagRing {
    pub fn with_capacity(requested_capacity: usize) -> Self {
        let capacity = requested_capacity.max(16).next_power_of_two();
        let slots: Vec<Slot> = (0..capacity)
            .map(|idx| Slot {
                seq: AtomicU64::new(idx as u64),
                event: UnsafeCell::new(DiagEvent::EMPTY),
            })
            .collect();

        Self {
            capacity,
            mask: capacity - 1,
            slots: slots.into_boxed_slice(),
            enqueue_pos: AtomicU64::new(0),
            dequeue_pos: AtomicU64::new(0),
            next_seq: AtomicU64::new(1),
            dropped_total: AtomicU64::new(0),
            unreported_drops: AtomicU64::new(0),
            consumer_guard: Mutex::new(()),
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn dropped_total(&self) -> u64 {
        self.dropped_total.load(Ordering::Relaxed)
    }

    pub fn take_unreported_drops(&self) -> u64 {
        self.unreported_drops.swap(0, Ordering::AcqRel)
    }

    pub fn buffered_approx(&self) -> usize {
        let enq = self.enqueue_pos.load(Ordering::Relaxed);
        let deq = self.dequeue_pos.load(Ordering::Relaxed);
        (enq.saturating_sub(deq) as usize).min(self.capacity)
    }

    /// Wait-free / non-blocking push. Never acquires a mutex, allocates, or blocks.
    pub fn try_push(&self, mut ev: DiagEvent) -> bool {
        ev.seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let mut attempts = 0usize;
        let mut pos = self.enqueue_pos.load(Ordering::Relaxed);

        loop {
            let slot = &self.slots[(pos as usize) & self.mask];
            let seq = slot.seq.load(Ordering::Acquire);
            let diff = (seq as i64).wrapping_sub(pos as i64);

            if diff == 0 {
                match self.enqueue_pos.compare_exchange_weak(
                    pos,
                    pos.wrapping_add(1),
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => {
                        // SAFETY: Exclusive slot ownership verified by winning CAS at seq == pos.
                        unsafe {
                            *slot.event.get() = ev;
                        }
                        slot.seq.store(pos.wrapping_add(1), Ordering::Release);
                        return true;
                    }
                    Err(actual) => {
                        pos = actual;
                    }
                }
            } else if diff < 0 {
                self.dropped_total.fetch_add(1, Ordering::Relaxed);
                self.unreported_drops.fetch_add(1, Ordering::Relaxed);
                return false;
            } else {
                attempts += 1;
                if attempts >= 64 {
                    self.dropped_total.fetch_add(1, Ordering::Relaxed);
                    self.unreported_drops.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                pos = self.enqueue_pos.load(Ordering::Relaxed);
            }
        }
    }

    /// Drain up to `max_items` ready entries for the single writer consumer.
    pub fn drain_batch(&self, max_items: usize, out: &mut Vec<DiagEvent>) -> usize {
        let _guard = self.consumer_guard.lock();
        let mut count = 0usize;
        let mut pos = self.dequeue_pos.load(Ordering::Relaxed);

        while count < max_items {
            let slot = &self.slots[(pos as usize) & self.mask];
            let seq = slot.seq.load(Ordering::Acquire);
            let expected = pos.wrapping_add(1);
            let diff = (seq as i64).wrapping_sub(expected as i64);

            if diff == 0 {
                // SAFETY: Consumer holds exclusive access for `pos` while `seq == pos + 1`.
                let ev = unsafe { *slot.event.get() };
                slot.seq
                    .store(pos.wrapping_add(self.capacity as u64), Ordering::Release);
                pos = pos.wrapping_add(1);
                self.dequeue_pos.store(pos, Ordering::Relaxed);
                out.push(ev);
                count += 1;
            } else {
                break;
            }
        }
        count
    }
}

/// Global fast-path atomic mode (`0 = Off`, `1 = Debug`, `2 = DiagnosticCapture`).
/// Stored standalone outside `OnceLock` so `Off` never touches or allocates ring storage.
static CAPTURE_MODE: AtomicU8 = AtomicU8::new(0);
static RING_CELL: OnceLock<Arc<LockFreeDiagRing>> = OnceLock::new();
static RUNTIME_CONTROLLER: OnceLock<Arc<DiagRuntime>> = OnceLock::new();

#[inline(always)]
pub fn capture_mode() -> CaptureMode {
    CaptureMode::from_u8(CAPTURE_MODE.load(Ordering::Relaxed))
}

#[inline(always)]
pub fn is_active() -> bool {
    CAPTURE_MODE.load(Ordering::Relaxed) != 0
}

fn global_ring() -> &'static Arc<LockFreeDiagRing> {
    RING_CELL.get_or_init(|| Arc::new(LockFreeDiagRing::with_capacity(DEFAULT_RING_CAPACITY)))
}

#[inline]
fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Format onto stack and submit non-blocking to the preallocated global ring buffer.
#[inline(never)]
pub fn submit_fmt(
    category: DiagCategory,
    correlation_id: u64,
    wait_us: u64,
    exec_us: u64,
    event_name: &str,
    args: fmt::Arguments<'_>,
) {
    if !is_active() {
        return;
    }
    let ring = global_ring();
    let mut detail_buf = FixedUtf8Buf::<256>::new();
    let _ = fmt::write(&mut detail_buf, args);
    let (event_buf, event_len) = FixedUtf8Buf::<32>::from_str_truncated(event_name);

    let current_thread = thread::current();
    let thread_str = current_thread.name().unwrap_or("worker");
    let (thread_buf, thread_len) = FixedUtf8Buf::<24>::from_str_truncated(thread_str);

    let ev = DiagEvent {
        seq: 0,
        timestamp_ms: now_timestamp_ms(),
        category,
        correlation_id,
        wait_us,
        exec_us,
        thread_name: thread_buf,
        thread_name_len: thread_len as u8,
        event: event_buf,
        event_len: event_len as u8,
        detail: detail_buf.buf,
        detail_len: detail_buf.len as u16,
    };

    let _ = ring.try_push(ev);
}

pub fn submit_frontend_event(
    category: &str,
    event_name: &str,
    correlation_id: u64,
    wait_us: u64,
    exec_us: u64,
    detail: &str,
) {
    if !is_active() {
        return;
    }
    submit_fmt(
        DiagCategory::from_str_key(category),
        correlation_id,
        wait_us,
        exec_us,
        event_name,
        format_args!("{}", detail),
    );
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDebugSettings {
    mode: CaptureMode,
}

type HygieneProbeFn = Arc<dyn Fn() -> HygieneState + Send + Sync>;

pub struct DiagRuntime {
    ring: Arc<LockFreeDiagRing>,
    mode_ref: Option<&'static AtomicU8>,
    local_mode: AtomicU8,
    log_dir: PathBuf,
    settings_path: PathBuf,
    hygiene_probe: HygieneProbeFn,
    persisted_count: AtomicU64,
    last_flush_error: Mutex<Option<String>>,
    recent_lines: Mutex<VecDeque<String>>,
    writer_started: AtomicBool,
    stop_flag: Arc<AtomicBool>,
    writer_handle: Mutex<Option<JoinHandle<()>>>,
    on_flush_hook: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

impl DiagRuntime {
    pub fn new(
        ring: Arc<LockFreeDiagRing>,
        use_global_mode: bool,
        app_data_dir: PathBuf,
        hygiene_probe: HygieneProbeFn,
    ) -> Self {
        let log_dir = app_data_dir.join("logs");
        let settings_path = app_data_dir.join("debug_settings.json");
        Self {
            ring,
            mode_ref: use_global_mode.then_some(&CAPTURE_MODE),
            local_mode: AtomicU8::new(CAPTURE_MODE.load(Ordering::Relaxed)),
            log_dir,
            settings_path,
            hygiene_probe,
            persisted_count: AtomicU64::new(0),
            last_flush_error: Mutex::new(None),
            recent_lines: Mutex::new(VecDeque::with_capacity(RECENT_UI_LIMIT)),
            writer_started: AtomicBool::new(false),
            stop_flag: Arc::new(AtomicBool::new(false)),
            writer_handle: Mutex::new(None),
            on_flush_hook: None,
        }
    }

    pub fn with_flush_hook(mut self, hook: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        self.on_flush_hook = Some(hook);
        self
    }

    pub fn mode(&self) -> CaptureMode {
        let raw = match self.mode_ref {
            Some(m) => m.load(Ordering::Relaxed),
            None => self.local_mode.load(Ordering::Relaxed),
        };
        CaptureMode::from_u8(raw)
    }

    pub fn set_mode(&self, next: CaptureMode, persist_setting: bool) {
        if let Some(m) = self.mode_ref {
            m.store(next as u8, Ordering::Release);
        }
        self.local_mode.store(next as u8, Ordering::Release);
        if persist_setting {
            if let Some(parent) = self.settings_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&PersistedDebugSettings { mode: next }) {
                let _ = fs::write(&self.settings_path, json);
            }
        }
    }

    pub fn load_persisted_setting(&self) {
        // Explicit env vars override stored preference on startup
        if std::env::var_os("CADENCE_DIAGNOSTIC_CAPTURE").is_some_and(|v| v == "1" || v == "true") {
            self.set_mode(CaptureMode::DiagnosticCapture, false);
            return;
        }
        if std::env::var_os("CADENCE_DEBUG").is_some_and(|v| v == "1" || v == "true") {
            self.set_mode(CaptureMode::Debug, false);
            return;
        }

        if let Ok(raw) = fs::read_to_string(&self.settings_path) {
            if let Ok(parsed) = serde_json::from_str::<PersistedDebugSettings>(&raw) {
                if parsed.mode != CaptureMode::Off {
                    self.set_mode(parsed.mode, false);
                }
            }
        }
    }

    pub fn submit_test_event(&self, category: DiagCategory, cid: u64, event: &str, detail: &str) -> bool {
        if self.mode() == CaptureMode::Off {
            return false;
        }
        let mut detail_buf = FixedUtf8Buf::<256>::new();
        let _ = detail_buf.write_str(detail);
        let (event_buf, event_len) = FixedUtf8Buf::<32>::from_str_truncated(event);
        let cur = thread::current();
        let (thread_buf, thread_len) = FixedUtf8Buf::<24>::from_str_truncated(cur.name().unwrap_or("test"));
        self.ring.try_push(DiagEvent {
            seq: 0,
            timestamp_ms: now_timestamp_ms(),
            category,
            correlation_id: cid,
            wait_us: 0,
            exec_us: 0,
            thread_name: thread_buf,
            thread_name_len: thread_len as u8,
            event: event_buf,
            event_len: event_len as u8,
            detail: detail_buf.buf,
            detail_len: detail_buf.len as u16,
        })
    }

    fn start_writer_arc(self: &Arc<Self>) {
        if self.writer_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let rt = Arc::clone(self);
        let handle = thread::Builder::new()
            .name("cadence-diag-writer".into())
            .spawn(move || {
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::System::Threading::{
                        GetCurrentThread, SetThreadAffinityMask, SetThreadPriority,
                        THREAD_MODE_BACKGROUND_BEGIN, THREAD_PRIORITY_BELOW_NORMAL,
                    };
                    let res = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
                    if res == 0 {
                        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
                    }
                    let cores = std::thread::available_parallelism()
                        .map(|n| n.get())
                        .unwrap_or(1)
                        .min(usize::BITS as usize);
                    if cores >= 4 {
                        let all: usize = if cores == usize::BITS as usize {
                            usize::MAX
                        } else {
                            (1usize << cores) - 1
                        };
                        let _ = SetThreadAffinityMask(GetCurrentThread(), all & !0b11);
                    }
                }
                rt.writer_loop();
            })
            .ok();

        *self.writer_handle.lock() = handle;
    }

    pub fn main_log_path(&self) -> PathBuf {
        self.log_dir.join("cadence-debug.log")
    }

    pub fn rotated_log_path(&self) -> PathBuf {
        self.log_dir.join("cadence-debug.1.log")
    }

    fn writer_loop(&self) {
        let mut scratch = Vec::with_capacity(256);
        let mut line_buf = String::with_capacity(4096);

        while !self.stop_flag.load(Ordering::Relaxed) {
            let mode = self.mode();
            let hygiene = (self.hygiene_probe)();

            let total_sleep_ms = match (mode, hygiene) {
                (CaptureMode::DiagnosticCapture, _) => {
                    let _ = self.flush_pending_batch(&mut scratch, &mut line_buf, 256);
                    200u64
                }
                (CaptureMode::Debug, HygieneState::Idle) => {
                    let drained = self.flush_pending_batch(&mut scratch, &mut line_buf, 256);
                    if drained >= 256 { 25 } else { 400 }
                }
                (CaptureMode::Debug, _) => {
                    // Preserve audio hygiene: stay completely silent during Playing, Paused, Loading, or Cooldown.
                    500
                }
                (CaptureMode::Off, HygieneState::Idle) => {
                    // If user toggled Off while idle, cleanly drain any leftover buffered entries once.
                    if self.ring.buffered_approx() > 0 {
                        let _ = self.flush_pending_batch(&mut scratch, &mut line_buf, 256);
                    }
                    500
                }
                (CaptureMode::Off, _) => 500,
            };

            let mut waited = 0u64;
            while waited < total_sleep_ms && !self.stop_flag.load(Ordering::Relaxed) {
                let step = (total_sleep_ms - waited).min(100);
                thread::sleep(Duration::from_millis(step));
                waited += step;
            }
        }
    }

    /// Performs consumer-only flush of ready ring events into AppData rotating log.
    /// Returns number of events persisted. Must ONLY be called when policy allows disk I/O.
    pub fn flush_pending_batch(
        &self,
        scratch: &mut Vec<DiagEvent>,
        line_buf: &mut String,
        max_items: usize,
    ) -> usize {
        scratch.clear();
        let count = self.ring.drain_batch(max_items, scratch);
        let drops = self.ring.take_unreported_drops();
        if count == 0 && drops == 0 {
            return 0;
        }

        line_buf.clear();
        for ev in scratch.iter() {
            ev.format_line(line_buf);
        }
        if drops > 0 {
            let ts = now_timestamp_ms();
            let _ = writeln!(
                line_buf,
                "{}ms | #DROP   | cadence-diag-writer | AUDIO_HYGIENE       | buffer_overflow_dropped      | cid=0 | wait_us=0 | exec_us=0 | dropped_events={}",
                ts, drops
            );
        }

        if let Err(err) = self.append_to_appdata_log(line_buf) {
            *self.last_flush_error.lock() = Some(err);
        } else {
            *self.last_flush_error.lock() = None;
            if count > 0 {
                self.persisted_count.fetch_add(count as u64, Ordering::Relaxed);
            }
            if let Some(ref hook) = self.on_flush_hook {
                hook(line_buf);
            }
            let mut recent = self.recent_lines.lock();
            for line in line_buf.lines() {
                if recent.len() >= RECENT_UI_LIMIT {
                    recent.pop_front();
                }
                recent.push_back(line.to_string());
            }
        }
        count
    }

    /// Public explicit idle-guarded flush (for testing or idle UI flush).
    pub fn flush_now_if_allowed(&self) -> Result<usize, String> {
        let mode = self.mode();
        let hygiene = (self.hygiene_probe)();
        if mode != CaptureMode::DiagnosticCapture && !matches!(hygiene, HygieneState::Idle) {
            return Err(format!(
                "Flush deferred to preserve audio hygiene (state: {})",
                hygiene.label()
            ));
        }
        let mut scratch = Vec::with_capacity(256);
        let mut line_buf = String::with_capacity(4096);
        let mut total = 0usize;
        loop {
            let n = self.flush_pending_batch(&mut scratch, &mut line_buf, 256);
            total += n;
            if n < 256 {
                break;
            }
        }
        Ok(total)
    }

    fn append_to_appdata_log(&self, content: &str) -> Result<(), String> {
        fs::create_dir_all(&self.log_dir).map_err(|e| format!("create log dir failed: {}", e))?;
        let main_path = self.main_log_path();
        if let Ok(meta) = fs::metadata(&main_path) {
            if meta.len() + content.len() as u64 >= MAX_LOG_FILE_BYTES {
                let rotated = self.rotated_log_path();
                let _ = fs::remove_file(&rotated);
                let _ = fs::rename(&main_path, &rotated);
            }
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&main_path)
            .map_err(|e| format!("open debug log failed: {}", e))?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(content.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("write debug log failed: {}", e))
    }

    pub fn clear_logs(&self) -> Result<(), String> {
        let mut scratch = Vec::with_capacity(256);
        while self.ring.drain_batch(256, &mut scratch) > 0 {
            scratch.clear();
        }
        let _ = self.ring.take_unreported_drops();
        self.recent_lines.lock().clear();
        let main = self.main_log_path();
        if main.exists() {
            fs::remove_file(&main).map_err(|e| format!("Failed to remove log: {}", e))?;
        }
        let rotated = self.rotated_log_path();
        if rotated.exists() {
            let _ = fs::remove_file(&rotated);
        }
        self.persisted_count.store(0, Ordering::Relaxed);
        *self.last_flush_error.lock() = None;
        Ok(())
    }

    pub fn recent_logs(&self) -> Vec<String> {
        self.recent_lines.lock().iter().cloned().collect()
    }

    pub fn status(&self) -> DebugLogState {
        let hygiene = (self.hygiene_probe)();
        DebugLogState {
            mode: self.mode(),
            ring_capacity: self.ring.capacity(),
            buffered_approx: self.ring.buffered_approx(),
            dropped_count: self.ring.dropped_total(),
            persisted_count: self.persisted_count.load(Ordering::Relaxed),
            hygiene_state: hygiene.label().to_string(),
            cooldown_remaining_secs: hygiene.cooldown_secs(),
            log_file_path: Some(self.main_log_path().to_string_lossy().to_string()),
            log_dir_path: Some(self.log_dir.to_string_lossy().to_string()),
            last_flush_error: self.last_flush_error.lock().clone(),
        }
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(h) = self.writer_handle.lock().take() {
            let _ = h.join();
        }
    }
}

impl Drop for DiagRuntime {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(h) = self.writer_handle.lock().take() {
            let _ = h.join();
        }
    }
}

/// Read startup environment variables (`CADENCE_DEBUG=1` or `CADENCE_DIAGNOSTIC_CAPTURE=1`)
/// before `AudioEngine::new()` without spawning disk threads yet.
pub fn init_from_env() {
    if std::env::var_os("CADENCE_DIAGNOSTIC_CAPTURE").is_some_and(|v| v == "1" || v == "true") {
        let _ = global_ring();
        CAPTURE_MODE.store(CaptureMode::DiagnosticCapture as u8, Ordering::Release);
    } else if std::env::var_os("CADENCE_DEBUG").is_some_and(|v| v == "1" || v == "true") {
        let _ = global_ring();
        CAPTURE_MODE.store(CaptureMode::Debug as u8, Ordering::Release);
    }
}

/// Configure AppData persistence and start the low-priority writer thread when active.
pub fn configure_persistence(app_data_dir: PathBuf, hygiene_probe: HygieneProbeFn) -> &'static Arc<DiagRuntime> {
    RUNTIME_CONTROLLER.get_or_init(|| {
        let ring = Arc::clone(global_ring());
        let rt = Arc::new(DiagRuntime::new(ring, true, app_data_dir, hygiene_probe));
        rt.load_persisted_setting();
        if rt.mode() != CaptureMode::Off {
            rt.start_writer_arc();
        }
        rt
    })
}

pub fn set_mode(mode: CaptureMode) -> DebugLogState {
    if mode != CaptureMode::Off {
        let _ = global_ring();
    }
    if let Some(rt) = RUNTIME_CONTROLLER.get() {
        rt.set_mode(mode, true);
        if mode != CaptureMode::Off {
            rt.start_writer_arc();
        }
        rt.status()
    } else {
        CAPTURE_MODE.store(mode as u8, Ordering::Release);
        get_state()
    }
}

pub fn get_state() -> DebugLogState {
    if let Some(rt) = RUNTIME_CONTROLLER.get() {
        rt.status()
    } else {
        DebugLogState {
            mode: capture_mode(),
            ring_capacity: DEFAULT_RING_CAPACITY,
            buffered_approx: RING_CELL.get().map(|r| r.buffered_approx()).unwrap_or(0),
            dropped_count: RING_CELL.get().map(|r| r.dropped_total()).unwrap_or(0),
            persisted_count: 0,
            hygiene_state: "idle".to_string(),
            cooldown_remaining_secs: None,
            log_file_path: None,
            log_dir_path: None,
            last_flush_error: None,
        }
    }
}

pub fn get_recent_logs() -> Vec<String> {
    RUNTIME_CONTROLLER
        .get()
        .map(|rt| rt.recent_logs())
        .unwrap_or_default()
}

pub fn clear_logs() -> Result<DebugLogState, String> {
    if let Some(rt) = RUNTIME_CONTROLLER.get() {
        rt.clear_logs()?;
        Ok(rt.status())
    } else {
        if let Some(ring) = RING_CELL.get() {
            let mut tmp = Vec::with_capacity(256);
            while ring.drain_batch(256, &mut tmp) > 0 {
                tmp.clear();
            }
            let _ = ring.take_unreported_drops();
        }
        Ok(get_state())
    }
}

pub fn flush_if_idle() -> Result<DebugLogState, String> {
    if let Some(rt) = RUNTIME_CONTROLLER.get() {
        rt.flush_now_if_allowed()?;
        Ok(rt.status())
    } else {
        Err("Diagnostics persistence not yet initialized".to_string())
    }
}

pub fn log_dir_path() -> Option<PathBuf> {
    RUNTIME_CONTROLLER.get().map(|rt| rt.log_dir.clone())
}

#[macro_export]
macro_rules! diag_log {
    ($cat:expr, $corr:expr, $wait_us:expr, $exec_us:expr, $event:expr, $($arg:tt)+) => {{
        if $crate::diagnostics::is_active() {
            $crate::diagnostics::submit_fmt(
                $cat,
                $corr,
                $wait_us,
                $exec_us,
                $event,
                format_args!($($arg)+),
            );
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cadence_diag_test_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn overflow_drops_without_blocking_and_counts_exact_drops() {
        let ring = Arc::new(LockFreeDiagRing::with_capacity(32));
        let dir = temp_dir("overflow");
        let rt = DiagRuntime::new(
            Arc::clone(&ring),
            false,
            dir.clone(),
            Arc::new(|| HygieneState::Idle),
        );
        rt.set_mode(CaptureMode::Debug, false);

        let mut accepted = 0u64;
        for i in 0..100u64 {
            if rt.submit_test_event(DiagCategory::AudioEngineCommands, i, "rapid_cmd", "idx=1") {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 32);
        assert_eq!(ring.dropped_total(), 68);

        let flushed = rt.flush_now_if_allowed().unwrap();
        assert_eq!(flushed, 32);
        let log_contents = fs::read_to_string(rt.main_log_path()).unwrap();
        assert!(log_contents.contains("buffer_overflow_dropped"));
        assert!(log_contents.contains("dropped_events=68"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn debug_mode_protects_playing_paused_loading_and_cooldown_while_capture_flushes() {
        let ring = Arc::new(LockFreeDiagRing::with_capacity(64));
        let dir = temp_dir("hygiene");
        let state = Arc::new(Mutex::new(HygieneState::Playing));
        let state_ref = Arc::clone(&state);

        let rt = DiagRuntime::new(
            Arc::clone(&ring),
            false,
            dir.clone(),
            Arc::new(move || *state_ref.lock()),
        );
        rt.set_mode(CaptureMode::Debug, false);
        assert!(rt.submit_test_event(DiagCategory::WasapiLifecycle, 1, "wasapi_init", "rate=44100"));

        // Playing, Paused, Loading, and Cooldown must block disk persistence in normal Debug mode
        for blocked_state in [
            HygieneState::Playing,
            HygieneState::Paused,
            HygieneState::Loading,
            HygieneState::Cooldown { remaining_secs: 15 },
        ] {
            *state.lock() = blocked_state;
            assert!(rt.flush_now_if_allowed().is_err());
            assert!(!rt.main_log_path().exists());
        }

        // Transitioning to Idle flushes buffered events cleanly
        *state.lock() = HygieneState::Idle;
        assert_eq!(rt.flush_now_if_allowed().unwrap(), 1);
        assert!(rt.main_log_path().exists());

        // Diagnostic Capture Mode explicitly permits flushing during Playing/Paused
        rt.set_mode(CaptureMode::DiagnosticCapture, false);
        *state.lock() = HygieneState::Paused;
        assert!(rt.submit_test_event(DiagCategory::UpnpLifecycle, 2, "soap_play", "udn=uuid:rose"));
        assert_eq!(rt.flush_now_if_allowed().unwrap(), 1);
        let text = fs::read_to_string(rt.main_log_path()).unwrap();
        assert!(text.contains("soap_play"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn slow_writer_and_full_buffer_never_stall_rapid_command_producers() {
        let ring = Arc::new(LockFreeDiagRing::with_capacity(128));
        let dir = temp_dir("nonblocking");
        let flush_calls = Arc::new(AtomicUsize::new(0));
        let flush_calls_hook = Arc::clone(&flush_calls);

        let rt = Arc::new(
            DiagRuntime::new(
                Arc::clone(&ring),
                false,
                dir.clone(),
                Arc::new(|| HygieneState::Idle),
            )
            .with_flush_hook(Arc::new(move |_| {
                flush_calls_hook.fetch_add(1, Ordering::Relaxed);
                // Simulate slow AppData disk flush on the writer thread
                thread::sleep(Duration::from_millis(80));
            })),
        );
        rt.set_mode(CaptureMode::DiagnosticCapture, false);
        rt.start_writer_arc();

        let t0 = Instant::now();
        for i in 0..5000u64 {
            let _ = rt.submit_test_event(
                DiagCategory::PlaybackLifecycle,
                i,
                "rapid_transport",
                "action=seek pos=12.5",
            );
        }
        let submit_elapsed = t0.elapsed();
        rt.stop();

        // 5000 submissions under concurrent slow disk flushing must finish in well under 50ms
        assert!(
            submit_elapsed < Duration::from_millis(50),
            "Producers stalled for {:?}",
            submit_elapsed
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
