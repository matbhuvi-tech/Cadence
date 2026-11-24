//! Opt-in sender delivery capture. No timers, locks, disk access, or allocation on writes.
//! Normal listening costs one atomic load per audio write. History allocation/serialization
//! happens only on the control thread; capture expires even if a controller disappears.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

const BIN_MS: u64 = 100;
const CAPTURE_MS: u64 = 60_000;
const BINS: usize = (CAPTURE_MS / BIN_MS) as usize;

#[derive(Debug, Default)]
struct Bin {
    // Each value carries its capture/bin tag, so a late writer from an old
    // connection/capture cannot make old bytes appear in a new capture.
    bytes: AtomicU64,
    gap: AtomicU64,
    delay: AtomicU64,
    target: AtomicU64,
    write_count: AtomicU64,
    min_chunk_bytes: AtomicU64,
    max_chunk_bytes: AtomicU64,
    timing_samples: AtomicU64,
    min_expected_us: AtomicU64,
    max_expected_us: AtomicU64,
    max_early_us: AtomicU64,
}

#[derive(Debug)]
pub struct DeliveryHistory {
    origin: Instant,
    stream_id: AtomicU64,
    next_capture: AtomicU64,
    capture_id: AtomicU64,
    active_capture: AtomicU64,
    started_ms: AtomicU64,
    stopped_ms: AtomicU64,
    bins: [Bin; BINS],
}

impl Default for DeliveryHistory {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
            stream_id: AtomicU64::new(0),
            next_capture: AtomicU64::new(0),
            capture_id: AtomicU64::new(0),
            active_capture: AtomicU64::new(0),
            started_ms: AtomicU64::new(0),
            stopped_ms: AtomicU64::new(u64::MAX),
            bins: std::array::from_fn(|_| Bin::default()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryBin {
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub bytes: u64,
    pub target_bytes_per_sec: u64,
    pub max_gap_us: u64,
    pub max_delay_us: u64,
    pub write_count: u64,
    pub min_chunk_bytes: u64,
    pub max_chunk_bytes: u64,
    pub timing_samples: u64,
    pub min_expected_us: u64,
    pub max_expected_us: u64,
    pub max_early_us: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryCapture {
    pub id: u64,
    pub elapsed_ms: u64,
    pub complete: bool,
    pub bins: Vec<DeliveryBin>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySnapshot {
    pub stream_id: u64,
    pub sampled_at_ms: u64,
    pub pacer_enabled: bool,
    pub state: &'static str,
    pub bytes_sent: u64,
    pub realtime_bytes_per_sec: u64,
    pub multiplier: f64,
    pub write_stalls: u64,
    pub schedule_stalls: u64,
    pub congestion_events: u64,
    pub flow_control_events: u64,
    pub tcp_samples: u64,
    pub rtt_us: u32,
    pub retrans_bytes: u32,
    pub capture: Option<DeliveryCapture>,
}

impl DeliveryHistory {
    /// Called only on the authenticated control path, never by the audio writer.
    /// Summary heartbeats omit history. A stale controller cannot stop a newer capture.
    pub fn handle_request(&self, request: &serde_json::Value) -> Option<DeliveryCapture> {
        let now = Instant::now();
        match request["captureAction"].as_str() {
            Some("start") => {
                self.start_at(now);
            }
            Some("stop") => {
                self.stop(request["captureId"].as_u64().unwrap_or(0));
            }
            _ => {}
        }
        if request["includeCapture"].as_bool() != Some(true) {
            return None;
        }
        let snapshot = self.snapshot_at(now)?;
        if request["captureAction"].as_str() != Some("start")
            && request["captureId"].as_u64() != Some(snapshot.id)
        {
            return None;
        }
        Some(snapshot)
    }
    pub fn sampled_at_ms(&self) -> u64 {
        self.millis_at(Instant::now())
    }
    fn millis_at(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.origin)
            .as_millis()
            .min(u64::MAX as u128) as u64
    }
    pub fn stream_id(&self) -> u64 {
        self.stream_id.load(Ordering::Acquire)
    }
    pub fn start_at(&self, now: Instant) -> u64 {
        self.active_capture.store(0, Ordering::Release);
        // 22 bits are available in the packed tag; clearing only on control-path
        // start avoids stale data even after the bounded ID wraps.
        let id = self.next_capture.fetch_add(1, Ordering::Relaxed) % 0x3f_ffff + 1;
        for bin in &self.bins {
            bin.bytes.store(0, Ordering::Relaxed);
            bin.gap.store(0, Ordering::Relaxed);
            bin.delay.store(0, Ordering::Relaxed);
            bin.target.store(0, Ordering::Relaxed);
            bin.write_count.store(0, Ordering::Relaxed);
            bin.min_chunk_bytes.store(0, Ordering::Relaxed);
            bin.max_chunk_bytes.store(0, Ordering::Relaxed);
            bin.timing_samples.store(0, Ordering::Relaxed);
            bin.min_expected_us.store(0, Ordering::Relaxed);
            bin.max_expected_us.store(0, Ordering::Relaxed);
            bin.max_early_us.store(0, Ordering::Relaxed);
        }
        self.started_ms
            .store(self.millis_at(now), Ordering::Relaxed);
        self.stopped_ms.store(u64::MAX, Ordering::Relaxed);
        self.capture_id.store(id, Ordering::Release);
        self.active_capture.store(id, Ordering::Release);
        id
    }
    pub fn stop(&self, id: u64) -> bool {
        self.stop_at(id, Instant::now())
    }
    pub fn stop_at(&self, id: u64, now: Instant) -> bool {
        if id == 0
            || self
                .active_capture
                .compare_exchange(id, 0, Ordering::AcqRel, Ordering::Relaxed)
                .is_err()
        {
            return false;
        }
        let elapsed = self
            .millis_at(now)
            .saturating_sub(self.started_ms.load(Ordering::Relaxed));
        self.stopped_ms
            .store(elapsed.min(CAPTURE_MS), Ordering::Release);
        true
    }
    pub fn snapshot_at(&self, now: Instant) -> Option<DeliveryCapture> {
        let id = self.capture_id.load(Ordering::Acquire);
        if id == 0 {
            return None;
        }
        let elapsed = self
            .millis_at(now)
            .saturating_sub(self.started_ms.load(Ordering::Relaxed));
        let stopped = self.stopped_ms.load(Ordering::Acquire);
        let elapsed_ms = elapsed.min(stopped).min(CAPTURE_MS);
        let count = elapsed_ms.div_ceil(BIN_MS) as usize;
        let mut bins = Vec::with_capacity(count);
        let mut last_target = 0;
        for (index, bin) in self.bins.iter().take(count).enumerate() {
            let tag = (id << 10) | index as u64;
            let read = |value: &AtomicU64| {
                let packed = value.load(Ordering::Acquire);
                if packed >> 32 == tag {
                    packed & 0xffff_ffff
                } else {
                    0
                }
            };
            let bytes = read(&bin.bytes);
            let target = read(&bin.target);
            if target > 0 {
                last_target = target;
            }
            let duration_ms = BIN_MS.min(elapsed_ms - index as u64 * BIN_MS);
            bins.push(DeliveryBin {
                offset_ms: index as u64 * BIN_MS,
                duration_ms,
                bytes,
                target_bytes_per_sec: last_target,
                max_gap_us: read(&bin.gap).max(if bytes == 0 { duration_ms * 1000 } else { 0 }),
                max_delay_us: read(&bin.delay),
                write_count: read(&bin.write_count),
                min_chunk_bytes: read(&bin.min_chunk_bytes),
                max_chunk_bytes: read(&bin.max_chunk_bytes),
                timing_samples: read(&bin.timing_samples),
                min_expected_us: read(&bin.min_expected_us),
                max_expected_us: read(&bin.max_expected_us),
                max_early_us: read(&bin.max_early_us),
            });
        }
        Some(DeliveryCapture {
            id,
            elapsed_ms,
            complete: stopped != u64::MAX || elapsed >= CAPTURE_MS,
            bins,
        })
    }
}

#[derive(Debug)]
pub struct DeliveryWriter {
    stream_id: u64,
    capture_id: u64,
    bin_index: usize,
    bytes: u64,
    max_gap_us: u64,
    max_delay_us: u64,
    write_count: u64,
    min_chunk_bytes: u64,
    max_chunk_bytes: u64,
    timing_samples: u64,
    min_expected_us: u64,
    max_expected_us: u64,
    max_early_us: u64,
    last_write: Option<Instant>,
    last_bytes: u64,
    last_target: u64,
}

impl DeliveryWriter {
    pub fn new(history: &DeliveryHistory) -> Self {
        history.active_capture.store(0, Ordering::Release);
        history.capture_id.store(0, Ordering::Release);
        Self {
            stream_id: history.stream_id.fetch_add(1, Ordering::AcqRel) + 1,
            capture_id: 0,
            bin_index: usize::MAX,
            bytes: 0,
            max_gap_us: 0,
            write_count: 0,
            min_chunk_bytes: 0,
            max_chunk_bytes: 0,
            timing_samples: 0,
            min_expected_us: 0,
            max_expected_us: 0,
            max_early_us: 0,
            last_write: None,
            max_delay_us: 0,
            last_bytes: 0,
            last_target: 0,
        }
    }
    #[inline]
    pub fn record(
        &mut self,
        history: &DeliveryHistory,
        bytes: usize,
        target: impl FnOnce() -> u64,
    ) {
        if history.active_capture.load(Ordering::Relaxed) != 0 {
            self.record_at(history, Instant::now(), bytes, target());
        }
    }
    pub fn record_at(
        &mut self,
        history: &DeliveryHistory,
        now: Instant,
        bytes: usize,
        target: u64,
    ) {
        let id = history.active_capture.load(Ordering::Acquire);
        if id == 0 || history.stream_id() != self.stream_id {
            return;
        }
        let elapsed = history
            .millis_at(now)
            .saturating_sub(history.started_ms.load(Ordering::Relaxed));
        if elapsed >= CAPTURE_MS {
            let _ = history.active_capture.compare_exchange(
                id,
                0,
                Ordering::Release,
                Ordering::Relaxed,
            );
            return;
        }
        if self.capture_id != id {
            self.capture_id = id;
            self.bin_index = usize::MAX;
            self.last_write = None;
        }
        let index = (elapsed / BIN_MS) as usize;
        if self.bin_index != index {
            self.bin_index = index;
            self.bytes = 0;
            self.max_gap_us = 0;
            self.max_delay_us = 0;
            self.write_count = 0;
            self.min_chunk_bytes = 0;
            self.max_chunk_bytes = 0;
            self.timing_samples = 0;
            self.min_expected_us = 0;
            self.max_expected_us = 0;
            self.max_early_us = 0;
        }
        if let Some(last) = self.last_write {
            let gap = now
                .saturating_duration_since(last)
                .as_micros()
                .min(u32::MAX as u128) as u64;
            self.max_gap_us = self.max_gap_us.max(gap);
            // 16 KiB CD-quality writes naturally sit ~93 ms apart. Only excess
            // over the preceding chunk's intended pacing interval is lateness.
            if self.last_target > 0 {
                let expected = self.last_bytes.saturating_mul(1_000_000) / self.last_target;
                self.max_delay_us = self.max_delay_us.max(gap.saturating_sub(expected));
                self.max_early_us = self.max_early_us.max(expected.saturating_sub(gap));
                self.min_expected_us = if self.timing_samples == 0 {
                    expected
                } else {
                    self.min_expected_us.min(expected)
                };
                self.max_expected_us = self.max_expected_us.max(expected);
                self.timing_samples += 1;
            }
        }
        self.min_chunk_bytes = if self.write_count == 0 {
            bytes as u64
        } else {
            self.min_chunk_bytes.min(bytes as u64)
        };
        self.max_chunk_bytes = self.max_chunk_bytes.max(bytes as u64);
        self.write_count += 1;
        self.last_write = Some(now);
        self.last_bytes = bytes as u64;
        self.last_target = target;
        self.bytes = self.bytes.saturating_add(bytes as u64).min(u32::MAX as u64);
        let tag = ((id << 10) | index as u64) << 32;
        let bin = &history.bins[index];
        bin.target
            .store(tag | target.min(u32::MAX as u64), Ordering::Release);
        bin.gap.store(tag | self.max_gap_us, Ordering::Release);
        bin.delay.store(tag | self.max_delay_us, Ordering::Release);
        bin.write_count.store(
            tag | self.write_count.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.min_chunk_bytes.store(
            tag | self.min_chunk_bytes.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.max_chunk_bytes.store(
            tag | self.max_chunk_bytes.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.timing_samples.store(
            tag | self.timing_samples.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.min_expected_us.store(
            tag | self.min_expected_us.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.max_expected_us.store(
            tag | self.max_expected_us.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.max_early_us.store(
            tag | self.max_early_us.min(u32::MAX as u64),
            Ordering::Release,
        );
        bin.bytes.store(tag | self.bytes, Ordering::Release);
    }
}
