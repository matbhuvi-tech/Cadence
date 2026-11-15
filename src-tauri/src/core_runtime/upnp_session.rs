//! Phase 5: Tauri-independent Linux/Core paced UPnP HTTP server & HiFi ROSE RS130 session coordinator.
//!
//! Invariants enforced:
//! 1. **Zero Disk I/O during playback:** serves exclusively from pre-admitted, page-locked
//!    `Arc<Vec<u8>>` slices in `LockedBytesArena`. Sony `.dsf` 80-byte headers are parsed
//!    directly from locked RAM. No windowed-read or pageable fallback exists.
//! 2. **Opaque Session Capabilities:** each `RunToken` mints an unguessable `/media/cap_<uuid>.<ext>`
//!    URL exposing no file paths or track IDs. Superseded tokens immediately return `404`/`410`
//!    and never serve another track's bytes.
//! 3. **Network PHY Quietness & 512 KiB Pre-Roll Cap:** `TCP_NODELAY = true`, pre-roll capped at
//!    `MAX_CORE_PREROLL_BYTES` (`512 KiB`), steady-state `SO_SNDBUF` clamped to `16..=32 KiB`
//!    (normalized via `/ 2` on Linux so kernel `2x` `sk_sndbuf` doubling never exceeds `32 KiB`),
//!    and sequential `Range` continuations skip repeated pre-roll.
//! 4. **Zero-Allocation Synchronous Pacer:** `stream_paced_slice_no_alloc` runs on a dedicated
//!    OS thread (`cadence-core-pacer`), pinned on Linux to `CpuPartition::pacer_core`, sleeping
//!    with monotonic absolute deadlines (`clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME)`),
//!    performing zero heap allocations, locks, or formatting in the chunk loop.
//! 5. **Qualified AVTransport Reconciliation:** HTTP EOF never implies audible completion; only
//!    renderer-reported `STOPPED` on the active session URI after full audio payload delivery
//!    emits `RendererEvent::Completed(RunToken)`. External URI takeover quarantines the session
//!    without fighting via repeated `Play` commands.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream as StdTcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::{
    HeadlessConfig, HeadlessCoreRuntime, MemoryLocker, PlatformProbe, RuntimeError,
    SystemMemoryLocker, SystemPlatformProbe,
};
use crate::core_session::{
    Renderer, RendererAction, RendererError, RendererEvent, RunToken,
};

/// Strict Core UPnP pre-roll cap (512 KiB), resolving the audiophile policy ceiling
/// without altering legacy Windows desktop constants.
pub const MAX_CORE_PREROLL_BYTES: u64 = 512 * 1024;

/// Target pre-roll duration (0.5 s) before clamping to `MAX_CORE_PREROLL_BYTES`.
pub const CORE_PREROLL_SECS: f64 = 0.5;

/// Minimum steady-state kernel socket send buffer (16 KiB).
pub const MIN_CORE_STEADY_SNDBUF_BYTES: usize = 16 * 1024;

/// Maximum steady-state kernel socket send buffer (32 KiB).
pub const MAX_CORE_STEADY_SNDBUF_BYTES: usize = 32 * 1024;

/// Fast-start socket send buffer during initial <= 512 KiB pre-roll (256 KiB).
pub const CORE_FAST_START_SNDBUF_BYTES: usize = 256 * 1024;

/// Minimum paced write chunk (4 KiB = 1 page).
pub const MIN_CORE_CHUNK_BYTES: usize = 4 * 1024;

/// Maximum paced write chunk (16 KiB = 4 pages).
pub const MAX_CORE_CHUNK_BYTES: usize = 16 * 1024;

/// Minimum pacing rate floor (64 KiB/s).
pub const MIN_CORE_PACE_BYTES_PER_SEC: f64 = 64.0 * 1024.0;

/// Target minimum chunk tick duration (1.25 ms).
pub const TARGET_CORE_TICK_SECS: f64 = 0.00125;

/// Ground-truth metadata parsed directly from an 80-byte Sony DSF header in locked RAM.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DsfHeaderInfo {
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_count: u64,
    pub duration_secs: f64,
    pub bits_per_sample: u8,
    pub metadata_offset: u64,
    pub bitrate_bytes_per_sec: f64,
}

/// Parses the fixed 80-byte Sony DSF container header (`DSD ` + `fmt `) directly from
/// an in-memory slice without touching the filesystem.
pub fn parse_dsf_header_bytes(bytes: &[u8]) -> Option<DsfHeaderInfo> {
    if bytes.len() < 80 || &bytes[0..4] != b"DSD " || &bytes[28..32] != b"fmt " {
        return None;
    }
    let metadata_offset = u64::from_le_bytes(bytes[20..28].try_into().ok()?);
    let channels = u32::from_le_bytes(bytes[52..56].try_into().ok()?) as u16;
    let sample_rate = u32::from_le_bytes(bytes[56..60].try_into().ok()?);
    let bits_per_sample = u32::from_le_bytes(bytes[60..64].try_into().ok()?) as u8;
    let sample_count = u64::from_le_bytes(bytes[64..72].try_into().ok()?);
    if sample_rate == 0 || channels == 0 {
        return None;
    }
    let duration_secs = sample_count as f64 / sample_rate as f64;
    let bitrate_bytes_per_sec = (sample_rate as f64 * channels as f64) / 8.0;
    Some(DsfHeaderInfo {
        channels,
        sample_rate,
        sample_count,
        duration_secs,
        bits_per_sample: if bits_per_sample == 0 { 1 } else { bits_per_sample },
        metadata_offset,
        bitrate_bytes_per_sec,
    })
}

/// Computes the bitrate-scaled chunk size aligned to 4 KiB pages (`4 KiB..=16 KiB`).
pub fn calculate_core_chunk_bytes(bitrate_bytes_per_sec: f64) -> usize {
    const PAGE_ALIGN: usize = 4 * 1024;
    if bitrate_bytes_per_sec <= 0.0 {
        return MAX_CORE_CHUNK_BYTES;
    }
    let raw = (bitrate_bytes_per_sec * TARGET_CORE_TICK_SECS).ceil() as usize;
    let aligned = raw.saturating_add(PAGE_ALIGN - 1) & !(PAGE_ALIGN - 1);
    aligned.clamp(MIN_CORE_CHUNK_BYTES, MAX_CORE_CHUNK_BYTES)
}

/// Computes the steady-state socket send buffer clamped to `16 KiB..=32 KiB` and aligned to 16 KiB.
pub fn calculate_core_steady_sndbuf_bytes(bitrate_bytes_per_sec: f64) -> usize {
    if bitrate_bytes_per_sec <= 0.0 {
        return MIN_CORE_STEADY_SNDBUF_BYTES;
    }
    let target = (bitrate_bytes_per_sec * 0.100).round() as usize;
    let clamped = target.clamp(MIN_CORE_STEADY_SNDBUF_BYTES, MAX_CORE_STEADY_SNDBUF_BYTES);
    const ALIGN_MASK: usize = MAX_CORE_CHUNK_BYTES - 1;
    (clamped + ALIGN_MASK) & !ALIGN_MASK
}

/// Validates an advertised reachable LAN IPv4 address.
/// Rejects unspecified (`0.0.0.0`), broadcast, multicast, link-local (`169.254.0.0/16`),
/// CGNAT/Tailscale/VPN (`100.64.0.0/10`), and loopback (`127.0.0.0/8`) unless
/// `allow_loopback_for_tests` is explicitly enabled for local simulator tests.
pub fn validate_advertised_lan_ip(
    ip_str: &str,
    allow_loopback_for_tests: bool,
) -> Result<Ipv4Addr, String> {
    let ip: Ipv4Addr = ip_str
        .trim()
        .parse()
        .map_err(|_| format!("invalid advertised IPv4 address '{}'", ip_str))?;
    let octets = ip.octets();
    if ip.is_unspecified() {
        return Err("advertised IP cannot be unspecified (0.0.0.0)".into());
    }
    if ip.is_broadcast() || ip.is_multicast() {
        return Err(format!("advertised IP '{}' cannot be broadcast or multicast", ip));
    }
    if ip.is_link_local() {
        return Err(format!("advertised IP '{}' cannot be link-local (169.254.x.x)", ip));
    }
    if octets[0] == 100 && (octets[1] & 0b1100_0000) == 64 {
        return Err(format!(
            "advertised IP '{}' is in CGNAT/VPN range (100.64.0.0/10); use a wired LAN interface IP",
            ip
        ));
    }
    if ip.is_loopback() && !allow_loopback_for_tests {
        return Err("advertised IP cannot be loopback (127.x.x.x) in production mode".into());
    }
    Ok(ip)
}

/// Raw Linux kernel `tcp_info` subset used to normalize telemetry across platforms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxTcpInfoRaw {
    pub tcpi_state: u8,
    pub tcpi_rtt: u32,
    pub tcpi_min_rtt: u32,
    pub tcpi_snd_mss: u32,
    pub tcpi_unacked: u32,
    pub tcpi_snd_cwnd: u32,
    pub tcpi_snd_wnd: u32,
    pub tcpi_total_retrans: u32,
}

/// Normalized non-blocking TCP socket telemetry sample (all byte fields in bytes, RTT in microseconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreTcpSample {
    pub rtt_us: u32,
    pub min_rtt_us: u32,
    pub bytes_in_flight: u32,
    pub cwnd: u32,
    pub snd_wnd: u32,
    pub bytes_retrans: u32,
}

/// Normalizes Linux kernel `tcp_info` fields (where `tcpi_unacked`, `tcpi_snd_cwnd`, and
/// `tcpi_total_retrans` are measured in segments of `tcpi_snd_mss`) into byte units.
#[inline]
pub const fn normalize_linux_tcp_info(raw: LinuxTcpInfoRaw) -> CoreTcpSample {
    let mss = if raw.tcpi_snd_mss == 0 {
        1448
    } else {
        raw.tcpi_snd_mss
    };
    CoreTcpSample {
        rtt_us: raw.tcpi_rtt,
        min_rtt_us: if raw.tcpi_min_rtt == 0 {
            raw.tcpi_rtt
        } else {
            raw.tcpi_min_rtt
        },
        bytes_in_flight: raw.tcpi_unacked.saturating_mul(mss),
        cwnd: raw.tcpi_snd_cwnd.saturating_mul(mss),
        snd_wnd: raw.tcpi_snd_wnd,
        bytes_retrans: raw.tcpi_total_retrans.saturating_mul(mss),
    }
}

/// Tuning parameters for the synchronous Core UPnP pacer.
#[derive(Debug, Clone, Copy)]
pub struct CorePacerConfig {
    pub initial_lead_target_ms: u64,
    pub initial_fill_multiplier: f64,
    pub initial_fill_lead_ms: i64,
    pub initial_overfeed_multiplier: f64,
    pub min_steady_multiplier: f64,
    pub drain_multiplier: f64,
    pub max_overfeed_multiplier: f64,
    pub ramp_interval_ms: u64,
    pub initial_ramp_step: f64,
    pub fine_ramp_step: f64,
    pub backoff_excess_factor: f64,
    pub soft_ceiling_floor: f64,
    pub soft_ceiling_step: f64,
    pub soft_ceiling_relax_ms: u64,
    pub max_debt_ms: i64,
    pub stall_threshold_ms: u64,
    pub fast_write_ms: u64,
    pub flow_clear_ms: u64,
    pub tcp_info_poll_ms: u64,
    pub tcp_info_min_event_ms: u64,
    pub tcp_info_stale_ms: u64,
    pub uncertain_max_margin_ms: u64,
    pub disable_sleep_for_tests: bool,
}

impl Default for CorePacerConfig {
    fn default() -> Self {
        Self {
            initial_lead_target_ms: 1200,
            initial_fill_multiplier: 1.180,
            initial_fill_lead_ms: 1_000,
            initial_overfeed_multiplier: 1.080,
            min_steady_multiplier: 1.000,
            drain_multiplier: 0.995,
            max_overfeed_multiplier: 1.120,
            ramp_interval_ms: 6_000,
            initial_ramp_step: 0.010,
            fine_ramp_step: 0.005,
            backoff_excess_factor: 0.50,
            soft_ceiling_floor: 1.010,
            soft_ceiling_step: 0.005,
            soft_ceiling_relax_ms: 30_000,
            max_debt_ms: 3_000,
            stall_threshold_ms: 25,
            fast_write_ms: 10,
            flow_clear_ms: 1_500,
            tcp_info_poll_ms: 200,
            tcp_info_min_event_ms: 50,
            tcp_info_stale_ms: 750,
            uncertain_max_margin_ms: 250,
            disable_sleep_for_tests: false,
        }
    }
}

impl CorePacerConfig {
    pub fn fast_for_tests() -> Self {
        Self {
            disable_sleep_for_tests: true,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CorePacingState {
    Unpaced = 0,
    InitialFill = 1,
    SteadyMaintain = 2,
}

impl CorePacingState {
    fn from_code(code: u8) -> &'static str {
        match code {
            1 => "initial_fill",
            2 => "steady_maintain",
            _ => "unpaced",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoreRateRegime {
    Unpaced = 0,
    InitialFill = 1,
    Cruise = 2,
    Overfeed = 3,
    Trim = 4,
    FlowSuppressed = 6,
}

impl CoreRateRegime {
    fn from_code(code: u8) -> &'static str {
        match code {
            1 => "initial_fill",
            2 => "cruise",
            3 => "overfeed",
            4 => "trim",
            6 => "flow_suppressed",
            _ => "unpaced",
        }
    }
}

/// Lock-free, zero-allocation atomic pacing metrics for the Core UPnP streamer.
#[derive(Debug, Default)]
pub struct CorePacingMetrics {
    pub current_state: AtomicU8,
    pub current_regime: AtomicU8,
    pub lead_certainty: AtomicU8,
    pub current_multiplier_x1000: AtomicU64,
    pub realtime_bytes_per_sec: AtomicU64,
    pub preroll_bytes_configured: AtomicU64,
    pub configured_sndbuf_bytes: AtomicU64,
    pub actual_sndbuf_bytes: AtomicU64,
    pub fast_start_sndbuf_bytes: AtomicU64,
    pub audio_connections: AtomicU64,
    pub chunks_sent: AtomicU64,
    pub bytes_sent: AtomicU64,
    pub preroll_chunks: AtomicU64,
    pub write_block_stalls: AtomicU64,
    pub schedule_lag_stalls: AtomicU64,
    pub state_transitions: AtomicU64,
    pub estimated_lead_ms: AtomicI64,
    pub tcp_info_samples: AtomicU64,
    pub congestion_events: AtomicU64,
    pub flow_control_events: AtomicU64,
    pub last_rtt_us: AtomicU32,
    pub last_bytes_in_flight: AtomicU32,
    pub last_snd_wnd: AtomicU32,
    pub last_bytes_retrans: AtomicU32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorePacingSnapshot {
    pub current_state: &'static str,
    pub current_regime: &'static str,
    pub lead_certainty: &'static str,
    pub current_multiplier: f64,
    pub realtime_bytes_per_sec: u64,
    pub preroll_bytes_configured: u64,
    pub configured_sndbuf_bytes: u64,
    pub actual_sndbuf_bytes: u64,
    pub fast_start_sndbuf_bytes: u64,
    pub audio_connections: u64,
    pub chunks_sent: u64,
    pub bytes_sent: u64,
    pub preroll_chunks: u64,
    pub write_block_stalls: u64,
    pub schedule_lag_stalls: u64,
    pub state_transitions: u64,
    pub estimated_lead_ms: i64,
    pub tcp_info_samples: u64,
    pub congestion_events: u64,
    pub flow_control_events: u64,
    pub last_rtt_us: u32,
    pub last_bytes_in_flight: u32,
    pub last_snd_wnd: u32,
    pub last_bytes_retrans: u32,
}

impl CorePacingMetrics {
    pub fn reset_for_connection(&self) {
        self.preroll_chunks.store(0, Ordering::Relaxed);
        self.chunks_sent.store(0, Ordering::Relaxed);
        self.bytes_sent.store(0, Ordering::Relaxed);
    }

    #[inline]
    fn record_state(&self, state: CorePacingState, regime: CoreRateRegime, mult: f64) {
        self.current_state.store(state as u8, Ordering::Relaxed);
        self.current_regime.store(regime as u8, Ordering::Relaxed);
        let milli = (mult * 1000.0).round().max(0.0) as u64;
        self.current_multiplier_x1000.store(milli, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> CorePacingSnapshot {
        CorePacingSnapshot {
            current_state: CorePacingState::from_code(self.current_state.load(Ordering::Relaxed)),
            current_regime: CoreRateRegime::from_code(self.current_regime.load(Ordering::Relaxed)),
            lead_certainty: if self.lead_certainty.load(Ordering::Relaxed) == 1 {
                "measured"
            } else {
                "uncertain"
            },
            current_multiplier: self.current_multiplier_x1000.load(Ordering::Relaxed) as f64 / 1000.0,
            realtime_bytes_per_sec: self.realtime_bytes_per_sec.load(Ordering::Relaxed),
            preroll_bytes_configured: self.preroll_bytes_configured.load(Ordering::Relaxed),
            configured_sndbuf_bytes: self.configured_sndbuf_bytes.load(Ordering::Relaxed),
            actual_sndbuf_bytes: self.actual_sndbuf_bytes.load(Ordering::Relaxed),
            fast_start_sndbuf_bytes: self.fast_start_sndbuf_bytes.load(Ordering::Relaxed),
            audio_connections: self.audio_connections.load(Ordering::Relaxed),
            chunks_sent: self.chunks_sent.load(Ordering::Relaxed),
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            preroll_chunks: self.preroll_chunks.load(Ordering::Relaxed),
            write_block_stalls: self.write_block_stalls.load(Ordering::Relaxed),
            schedule_lag_stalls: self.schedule_lag_stalls.load(Ordering::Relaxed),
            state_transitions: self.state_transitions.load(Ordering::Relaxed),
            estimated_lead_ms: self.estimated_lead_ms.load(Ordering::Relaxed),
            tcp_info_samples: self.tcp_info_samples.load(Ordering::Relaxed),
            congestion_events: self.congestion_events.load(Ordering::Relaxed),
            flow_control_events: self.flow_control_events.load(Ordering::Relaxed),
            last_rtt_us: self.last_rtt_us.load(Ordering::Relaxed),
            last_bytes_in_flight: self.last_bytes_in_flight.load(Ordering::Relaxed),
            last_snd_wnd: self.last_snd_wnd.load(Ordering::Relaxed),
            last_bytes_retrans: self.last_bytes_retrans.load(Ordering::Relaxed),
        }
    }
}

/// Dedicated synchronous UPnP packet pacer with monotonic absolute deadlines and
/// zero heap allocations in the active loop.
pub struct CorePacer {
    config: CorePacerConfig,
    realtime_rate: Option<f64>,
    state: CorePacingState,
    preroll: u64,
    sent: u64,
    steady_sndbuf: usize,
    clamped_to_steady: bool,
    is_metadata: bool,
    metrics: Arc<CorePacingMetrics>,
    is_paused: Arc<AtomicBool>,
    horizon_bytes: f64,
    last_horizon_tick: Option<Instant>,
    next_chunk_due: Option<Instant>,
    horizon_initialized: bool,
    last_tcp_sample: Option<CoreTcpSample>,
    last_tcp_sample_at: Option<Instant>,
    last_probe_attempt_at: Option<Instant>,
    baseline_open_snd_wnd: u32,
    uncertain_margin_bytes: u64,
    active_pace_mult: f64,
    soft_ceiling_mult: f64,
    flow_strikes: u32,
    flow_suppressed_until: Option<Instant>,
    clean_window_anchor: Option<Instant>,
    ceiling_relax_anchor: Option<Instant>,
}

impl CorePacer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: CorePacerConfig,
        realtime_bytes_per_sec: Option<f64>,
        preroll_bytes: u64,
        steady_sndbuf_bytes: usize,
        is_contiguous_reconnect: bool,
        is_range_continuation: bool,
        is_metadata: bool,
        metrics: Arc<CorePacingMetrics>,
        is_paused: Arc<AtomicBool>,
    ) -> Self {
        let clamped_preroll = if is_range_continuation || is_metadata {
            0
        } else {
            preroll_bytes.min(MAX_CORE_PREROLL_BYTES)
        };
        let clamped_sndbuf = steady_sndbuf_bytes.clamp(
            MIN_CORE_STEADY_SNDBUF_BYTES,
            MAX_CORE_STEADY_SNDBUF_BYTES,
        );

        if is_metadata || realtime_bytes_per_sec.is_none() {
            if !is_metadata {
                metrics.record_state(CorePacingState::Unpaced, CoreRateRegime::Unpaced, 0.0);
            }
            return Self {
                config,
                realtime_rate: None,
                state: CorePacingState::Unpaced,
                preroll: 0,
                sent: 0,
                steady_sndbuf: clamped_sndbuf,
                clamped_to_steady: true,
                is_metadata,
                metrics,
                is_paused,
                horizon_bytes: 0.0,
                last_horizon_tick: None,
                next_chunk_due: None,
                horizon_initialized: false,
                last_tcp_sample: None,
                last_tcp_sample_at: None,
                last_probe_attempt_at: None,
                baseline_open_snd_wnd: 0,
                uncertain_margin_bytes: (MAX_CORE_CHUNK_BYTES as u64) * 2,
                active_pace_mult: 0.0,
                soft_ceiling_mult: 0.0,
                flow_strikes: 0,
                flow_suppressed_until: None,
                clean_window_anchor: None,
                ceiling_relax_anchor: None,
            };
        }

        let realtime = realtime_bytes_per_sec.unwrap();
        metrics.reset_for_connection();
        metrics.audio_connections.fetch_add(1, Ordering::Relaxed);
        metrics
            .preroll_bytes_configured
            .store(clamped_preroll, Ordering::Relaxed);
        metrics
            .configured_sndbuf_bytes
            .store(clamped_sndbuf as u64, Ordering::Relaxed);
        metrics
            .realtime_bytes_per_sec
            .store(realtime.round().max(0.0) as u64, Ordering::Relaxed);

        let now = Instant::now();
        let (initial_state, initial_regime, initial_mult, seed_horizon_bytes, horizon_ready) =
            if is_contiguous_reconnect {
                let seed_lead = (config.initial_lead_target_ms as f64 / 1000.0) * realtime;
                (
                    CorePacingState::SteadyMaintain,
                    CoreRateRegime::Cruise,
                    config.min_steady_multiplier,
                    -seed_lead,
                    true,
                )
            } else {
                (
                    CorePacingState::InitialFill,
                    CoreRateRegime::InitialFill,
                    config.initial_fill_multiplier,
                    0.0,
                    is_range_continuation,
                )
            };

        metrics.record_state(initial_state, initial_regime, initial_mult);
        Self {
            config,
            realtime_rate: Some(realtime),
            state: initial_state,
            preroll: clamped_preroll,
            sent: 0,
            steady_sndbuf: clamped_sndbuf,
            clamped_to_steady: is_range_continuation,
            is_metadata: false,
            metrics,
            is_paused,
            horizon_bytes: seed_horizon_bytes,
            last_horizon_tick: if horizon_ready { Some(now) } else { None },
            next_chunk_due: if horizon_ready { Some(now) } else { None },
            horizon_initialized: horizon_ready,
            last_tcp_sample: None,
            last_tcp_sample_at: None,
            last_probe_attempt_at: None,
            baseline_open_snd_wnd: 0,
            uncertain_margin_bytes: (MAX_CORE_CHUNK_BYTES as u64) * 2,
            active_pace_mult: initial_mult,
            soft_ceiling_mult: config.max_overfeed_multiplier,
            flow_strikes: 0,
            flow_suppressed_until: None,
            clean_window_anchor: if horizon_ready { Some(now) } else { None },
            ceiling_relax_anchor: if horizon_ready { Some(now) } else { None },
        }
    }

    pub fn set_sent_for_test(&mut self, sent_bytes: u64) {
        self.sent = sent_bytes;
    }

    #[inline]
    pub fn on_chunk_sent(
        &mut self,
        stream: &mut StdTcpStream,
        chunk_len: usize,
        write_block_dur: Duration,
        cancelled: &AtomicBool,
    ) {
        self.sent = self.sent.saturating_add(chunk_len as u64);
        if !self.is_metadata {
            self.metrics.chunks_sent.fetch_add(1, Ordering::Relaxed);
            self.metrics
                .bytes_sent
                .fetch_add(chunk_len as u64, Ordering::Relaxed);
        }

        if self.realtime_rate.is_none() || self.state == CorePacingState::Unpaced {
            return;
        }

        // Phase 1: Unpaced fast-start pre-roll (strictly <= 512 KiB).
        if self.sent <= self.preroll {
            if !self.is_metadata {
                self.metrics.preroll_chunks.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }

        // Phase 2: Down-clamp SO_SNDBUF to 32 KiB steady-state ceiling (normalized on Linux).
        if !self.clamped_to_steady {
            apply_socket_sndbuf(stream, self.steady_sndbuf, &self.metrics);
            self.clamped_to_steady = true;
            let now = Instant::now();
            self.horizon_bytes = 0.0;
            self.last_horizon_tick = Some(now);
            self.next_chunk_due = Some(now);
            self.clean_window_anchor = Some(now);
            self.ceiling_relax_anchor = Some(now);
            self.horizon_initialized = true;
            return;
        }

        let now = Instant::now();
        let paused = self.is_paused.load(Ordering::Acquire);
        let sample = if self.should_probe_tcp_info(now, write_block_dur) {
            self.last_probe_attempt_at = Some(now);
            query_socket_tcp_info(stream)
        } else {
            None
        };

        let sleep_dur = self.advance_with_sample(now, chunk_len, write_block_dur, paused, sample);
        if paused {
            while self.is_paused.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire) {
                sleep_monotonic_duration(Duration::from_millis(20));
            }
            let resumed = Instant::now();
            self.last_horizon_tick = Some(resumed);
            self.next_chunk_due = Some(resumed);
            self.clean_window_anchor = Some(resumed);
            self.ceiling_relax_anchor = Some(resumed);
            return;
        }
        if !self.config.disable_sleep_for_tests {
            if let Some(dur) = sleep_dur {
                sleep_monotonic_duration(dur);
            }
        }
    }

    fn should_probe_tcp_info(&self, now: Instant, write_block_dur: Duration) -> bool {
        let stall_thresh = Duration::from_millis(self.config.stall_threshold_ms);
        let due_lag = self
            .next_chunk_due
            .map(|due| now.saturating_duration_since(due) > stall_thresh)
            .unwrap_or(false);
        let anomaly = write_block_dur > stall_thresh || due_lag;
        match self.last_probe_attempt_at {
            None => true,
            Some(prev) => {
                let elapsed = now.saturating_duration_since(prev);
                if anomaly {
                    elapsed >= Duration::from_millis(self.config.tcp_info_min_event_ms)
                } else {
                    elapsed >= Duration::from_millis(self.config.tcp_info_poll_ms)
                }
            }
        }
    }

    pub fn advance_with_sample(
        &mut self,
        now: Instant,
        chunk_bytes: usize,
        write_block_dur: Duration,
        paused: bool,
        new_sample: Option<CoreTcpSample>,
    ) -> Option<Duration> {
        let realtime = self.realtime_rate?;
        if self.state == CorePacingState::Unpaced {
            return None;
        }

        if !self.horizon_initialized {
            self.last_horizon_tick = Some(now);
            self.next_chunk_due = Some(now);
            self.clean_window_anchor.get_or_insert(now);
            self.ceiling_relax_anchor.get_or_insert(now);
            self.horizon_initialized = true;
        }

        let mut retrans_delta = 0u32;
        let mut just_measured = false;
        if let Some(curr) = new_sample {
            if let Some(prev) = self.last_tcp_sample {
                retrans_delta = curr.bytes_retrans.saturating_sub(prev.bytes_retrans);
            }
            self.last_tcp_sample = Some(curr);
            self.last_tcp_sample_at = Some(now);
            self.baseline_open_snd_wnd = self.baseline_open_snd_wnd.max(curr.snd_wnd);
            just_measured = true;

            if !self.is_metadata {
                self.metrics.tcp_info_samples.fetch_add(1, Ordering::Relaxed);
                self.metrics.last_rtt_us.store(curr.rtt_us, Ordering::Relaxed);
                self.metrics
                    .last_bytes_in_flight
                    .store(curr.bytes_in_flight, Ordering::Relaxed);
                self.metrics.last_snd_wnd.store(curr.snd_wnd, Ordering::Relaxed);
                self.metrics
                    .last_bytes_retrans
                    .store(curr.bytes_retrans, Ordering::Relaxed);
            }
        }

        let prev_tick = *self.last_horizon_tick.get_or_insert(now);
        self.last_horizon_tick = Some(now);
        if !paused {
            let dt = now.saturating_duration_since(prev_tick);
            self.horizon_bytes += dt.as_secs_f64() * realtime;
        } else {
            self.next_chunk_due = Some(now);
            self.clean_window_anchor = Some(now);
            self.ceiling_relax_anchor = Some(now);
        }

        let stall_thresh = Duration::from_millis(self.config.stall_threshold_ms);
        let fast_thresh = Duration::from_millis(self.config.fast_write_ms);
        let prev_due = *self.next_chunk_due.get_or_insert(now);
        let schedule_lag = now.saturating_duration_since(prev_due);
        let is_write_stall = write_block_dur > stall_thresh;
        let is_schedule_lag = schedule_lag > stall_thresh;

        if !self.is_metadata {
            if is_write_stall {
                self.metrics
                    .write_block_stalls
                    .fetch_add(1, Ordering::Relaxed);
            } else if is_schedule_lag && write_block_dur <= fast_thresh {
                self.metrics
                    .schedule_lag_stalls
                    .fetch_add(1, Ordering::Relaxed);
            }
        }

        let is_measured = self
            .last_tcp_sample_at
            .is_some_and(|at| now.saturating_duration_since(at) <= Duration::from_millis(self.config.tcp_info_stale_ms));

        let delivered_bytes = if is_measured {
            let inflight = self
                .last_tcp_sample
                .map(|s| s.bytes_in_flight as u64)
                .unwrap_or(0);
            self.sent
                .saturating_sub(inflight.saturating_add(self.steady_sndbuf as u64))
        } else {
            self.sent.saturating_sub(self.uncertain_margin_bytes.min(self.sent))
        };

        let max_debt_bytes = (self.config.max_debt_ms as f64 / 1000.0) * realtime;
        if self.horizon_bytes > delivered_bytes as f64 + max_debt_bytes {
            self.horizon_bytes = delivered_bytes as f64 + max_debt_bytes;
        }

        let display_lead_ms =
            (((delivered_bytes as f64 - self.horizon_bytes) / realtime) * 1000.0).round() as i64;

        if !paused && is_measured && just_measured {
            if let Some(sample) = self.last_tcp_sample {
                let low_wnd_floor = (self.steady_sndbuf as u32).saturating_mul(2);
                let collapsed = self.baseline_open_snd_wnd >= 256 * 1024
                    && sample.snd_wnd <= self.baseline_open_snd_wnd / 4
                    && sample.snd_wnd <= 128 * 1024;
                if sample.snd_wnd <= low_wnd_floor || collapsed {
                    self.metrics
                        .flow_control_events
                        .fetch_add(1, Ordering::Relaxed);
                    self.trigger_flow_backoff(now);
                } else if is_write_stall && retrans_delta > 0 {
                    self.metrics
                        .congestion_events
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        let (multiplier, regime) = self.select_rate_and_transition(now, display_lead_ms, paused);

        if !self.is_metadata {
            self.metrics
                .lead_certainty
                .store(u8::from(is_measured), Ordering::Relaxed);
            self.metrics
                .estimated_lead_ms
                .store(display_lead_ms, Ordering::Relaxed);
            self.metrics.record_state(self.state, regime, multiplier);
        }

        if paused {
            return None;
        }
        if is_write_stall || (is_schedule_lag && write_block_dur <= fast_thresh) {
            self.next_chunk_due = Some(now);
            return None;
        }

        let effective_rate = (realtime * multiplier).max(MIN_CORE_PACE_BYTES_PER_SEC);
        let chunk_dur = Duration::from_secs_f64(chunk_bytes.max(1) as f64 / effective_rate);
        let max_phase_slip = Duration::from_secs_f64((chunk_bytes.saturating_mul(2)) as f64 / realtime)
            .min(Duration::from_millis(12));
        let floor_due = now.checked_sub(max_phase_slip).unwrap_or(now);
        let target_due = (prev_due + chunk_dur).max(floor_due);
        self.next_chunk_due = Some(target_due);
        target_due.checked_duration_since(now)
    }

    fn trigger_flow_backoff(&mut self, now: Instant) {
        if self.flow_suppressed_until.is_some_and(|t| now < t) {
            return;
        }
        let until = now + Duration::from_millis(self.config.flow_clear_ms);
        self.flow_suppressed_until = Some(until);
        self.clean_window_anchor = Some(until);
        self.ceiling_relax_anchor = Some(until);
        self.flow_strikes = self.flow_strikes.saturating_add(1);

        let prev_mult = self.active_pace_mult;
        let floor = self.config.min_steady_multiplier;
        let excess = (prev_mult - floor).max(0.0);
        let halved = floor + excess * self.config.backoff_excess_factor;
        let rounded = (halved * 1000.0).round() / 1000.0;
        let next_mult = if rounded < floor + 0.005 {
            floor
        } else {
            rounded.max(floor)
        };
        self.active_pace_mult = next_mult.min(self.soft_ceiling_mult).max(floor);

        let cand_ceil = ((prev_mult - self.config.soft_ceiling_step) * 1000.0).round() / 1000.0;
        self.soft_ceiling_mult = self
            .soft_ceiling_mult
            .min(cand_ceil)
            .max(self.config.soft_ceiling_floor);
    }

    fn select_rate_and_transition(
        &mut self,
        now: Instant,
        display_lead_ms: i64,
        paused: bool,
    ) -> (f64, CoreRateRegime) {
        if paused {
            return (1.0, CoreRateRegime::Cruise);
        }
        let flow_active = self.flow_suppressed_until.is_some_and(|t| now < t);
        if self.state == CorePacingState::InitialFill {
            let clean_elapsed = self.clean_window_anchor.is_some_and(|t| {
                now.saturating_duration_since(t) >= Duration::from_millis(self.config.ramp_interval_ms)
            });
            let cushion_ready = display_lead_ms >= self.config.initial_fill_lead_ms;
            if flow_active || self.flow_strikes > 0 || cushion_ready || clean_elapsed {
                self.state = CorePacingState::SteadyMaintain;
                if !(flow_active || self.flow_strikes > 0) {
                    self.active_pace_mult = self
                        .config
                        .initial_overfeed_multiplier
                        .min(self.soft_ceiling_mult);
                }
                self.clean_window_anchor = Some(now);
                if !self.is_metadata {
                    self.metrics
                        .state_transitions
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        if flow_active {
            return (self.config.drain_multiplier, CoreRateRegime::FlowSuppressed);
        }

        if self.state == CorePacingState::SteadyMaintain {
            self.maybe_step_up_while_clean(now);
        }

        let regime = if self.state == CorePacingState::InitialFill {
            CoreRateRegime::InitialFill
        } else if self.active_pace_mult > self.config.min_steady_multiplier + 1e-6 {
            CoreRateRegime::Overfeed
        } else if self.active_pace_mult < self.config.min_steady_multiplier - 1e-6 {
            CoreRateRegime::Trim
        } else {
            CoreRateRegime::Cruise
        };
        (self.active_pace_mult, regime)
    }

    fn maybe_step_up_while_clean(&mut self, now: Instant) {
        let relax_dur = Duration::from_millis(self.config.soft_ceiling_relax_ms);
        let relax_anchor = *self.ceiling_relax_anchor.get_or_insert(now);
        if now.saturating_duration_since(relax_anchor) >= relax_dur {
            self.ceiling_relax_anchor = Some(now);
            if self.flow_strikes > 0 {
                self.flow_strikes -= 1;
            }
            if self.soft_ceiling_mult < self.config.max_overfeed_multiplier - 1e-6 {
                self.soft_ceiling_mult =
                    (((self.soft_ceiling_mult + self.config.soft_ceiling_step) * 1000.0).round()
                        / 1000.0)
                        .min(self.config.max_overfeed_multiplier);
            }
        }

        let ramp_dur = Duration::from_millis(self.config.ramp_interval_ms);
        let ramp_anchor = *self.clean_window_anchor.get_or_insert(now);
        if now.saturating_duration_since(ramp_anchor) >= ramp_dur {
            self.clean_window_anchor = Some(now);
            let step = if self.flow_strikes == 0 {
                self.config.initial_ramp_step
            } else {
                self.config.fine_ramp_step
            };
            let next = (((self.active_pace_mult + step) * 1000.0).round() / 1000.0)
                .min(self.soft_ceiling_mult);
            if next > self.active_pace_mult + 1e-6 {
                self.active_pace_mult = next;
            }
        }
    }
}

/// Zero-allocation synchronous chunk-streaming loop.
/// Writes `slice` to `stream` in `chunk_bytes` increments, checks `cancelled` before every chunk,
/// updates `last_audio_end_offset`, and invokes `pacer.on_chunk_sent(...)` with zero heap allocations.
#[allow(clippy::too_many_arguments)]
pub fn stream_paced_slice_no_alloc(
    stream: &mut StdTcpStream,
    slice: &[u8],
    base_offset: u64,
    chunk_bytes: usize,
    track_progress: bool,
    last_audio_end_offset: &AtomicU64,
    cancelled: &AtomicBool,
    pacer: &mut CorePacer,
) -> bool {
    let step = chunk_bytes.max(1);
    let mut offset = base_offset;
    for chunk in slice.chunks(step) {
        if cancelled.load(Ordering::Acquire) {
            return false;
        }
        let t0 = Instant::now();
        if stream.write_all(chunk).is_err() {
            return false;
        }
        let write_block_dur = t0.elapsed();
        offset = offset.saturating_add(chunk.len() as u64);
        if track_progress {
            last_audio_end_offset.store(offset, Ordering::Release);
        }
        pacer.on_chunk_sent(stream, chunk.len(), write_block_dur, cancelled);
    }
    true
}

/// Sleeps using `clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME)` on Linux to eliminate
/// relative wakeup drift, or `std::thread::sleep` on other targets.
#[inline]
fn sleep_monotonic_duration(dur: Duration) {
    if dur.is_zero() {
        return;
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let mut now_ts = std::mem::zeroed::<libc::timespec>();
        if libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now_ts) == 0 {
            let add_secs = dur.as_secs() as libc::time_t;
            let add_nsecs = dur.subsec_nanos() as libc::c_long;
            let mut target_sec = now_ts.tv_sec.saturating_add(add_secs);
            let mut target_nsec = now_ts.tv_nsec + add_nsecs;
            if target_nsec >= 1_000_000_000 {
                target_sec = target_sec.saturating_add(1);
                target_nsec -= 1_000_000_000;
            }
            let req = libc::timespec {
                tv_sec: target_sec,
                tv_nsec: target_nsec,
            };
            loop {
                let rc = libc::clock_nanosleep(
                    libc::CLOCK_MONOTONIC,
                    libc::TIMER_ABSTIME,
                    &req,
                    std::ptr::null_mut(),
                );
                if rc != libc::EINTR {
                    break;
                }
            }
            return;
        }
    }
    std::thread::sleep(dur);
}

/// Pins the current pacer thread to `CpuPartition::pacer_core` on Linux/TrueNAS.
fn pin_current_thread_to_pacer_core() {
    #[cfg(target_os = "linux")]
    unsafe {
        let allowed = std::fs::read_to_string("/sys/fs/cgroup/cpuset.cpus.effective")
            .ok()
            .and_then(|s| super::parse_cpuset_list(&s).ok())
            .unwrap_or_else(|| {
                let mut set = std::mem::zeroed::<libc::cpu_set_t>();
                let mut v = Vec::new();
                if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) == 0
                {
                    for cpu in 0..128 {
                        if libc::CPU_ISSET(cpu, &set) {
                            v.push(cpu);
                        }
                    }
                }
                v
            });
        let part = super::partition_truenas_cpus(&allowed);
        if let Some(core) = part.pacer_core {
            let mut target = std::mem::zeroed::<libc::cpu_set_t>();
            libc::CPU_ZERO(&mut target);
            libc::CPU_SET(core, &mut target);
            let _ = libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &target);
        }
    }
}

/// Sets socket `SO_SNDBUF`, normalizing by `/ 2` on Linux so kernel `2x` `sk_sndbuf`
/// accounting produces the exact desired ceiling.
fn apply_socket_sndbuf(
    stream: &StdTcpStream,
    desired_ceiling_bytes: usize,
    metrics: &CorePacingMetrics,
) {
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::io::AsRawFd;
        let fd = stream.as_raw_fd();
        let normalized = super::normalize_linux_setsockopt_sndbuf(desired_ceiling_bytes) as libc::c_int;
        let _ = libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&raw const normalized) as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
        let mut raw_actual: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        if libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&raw mut raw_actual) as *mut libc::c_void,
            &mut len,
        ) == 0
            && raw_actual > 0
        {
            let effective = super::normalize_linux_getsockopt_sndbuf(raw_actual as usize);
            metrics
                .actual_sndbuf_bytes
                .store(effective as u64, Ordering::Relaxed);
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = stream;
        metrics
            .actual_sndbuf_bytes
            .store(desired_ceiling_bytes as u64, Ordering::Relaxed);
    }
}

#[cfg(target_os = "linux")]
fn query_socket_tcp_info(stream: &StdTcpStream) -> Option<CoreTcpSample> {
    use std::os::unix::io::AsRawFd;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KernelTcpInfoPrefix {
        tcpi_state: u8,
        tcpi_ca_state: u8,
        tcpi_retransmits: u8,
        tcpi_probes: u8,
        tcpi_backoff: u8,
        tcpi_options: u8,
        tcpi_snd_wscale_rcv_wscale: u8,
        tcpi_delivery_rate_app_limited: u8,
        tcpi_rto: u32,
        tcpi_ato: u32,
        tcpi_snd_mss: u32,
        tcpi_rcv_mss: u32,
        tcpi_unacked: u32,
        tcpi_sacked: u32,
        tcpi_lost: u32,
        tcpi_retrans: u32,
        tcpi_fackets: u32,
        tcpi_last_data_sent: u32,
        tcpi_last_ack_sent: u32,
        tcpi_last_data_recv: u32,
        tcpi_last_ack_recv: u32,
        tcpi_pmtu: u32,
        tcpi_rcv_ssthresh: u32,
        tcpi_rtt: u32,
        tcpi_rttvar: u32,
        tcpi_snd_ssthresh: u32,
        tcpi_snd_cwnd: u32,
        tcpi_advmss: u32,
        tcpi_reordering: u32,
        tcpi_rcv_rtt: u32,
        tcpi_rcv_space: u32,
        tcpi_total_retrans: u32,
    }

    unsafe {
        let mut info = std::mem::zeroed::<KernelTcpInfoPrefix>();
        let mut len = std::mem::size_of::<KernelTcpInfoPrefix>() as libc::socklen_t;
        let rc = libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_TCP,
            libc::TCP_INFO,
            (&raw mut info) as *mut libc::c_void,
            &mut len,
        );
        if rc == 0 && (len as usize) >= std::mem::size_of::<KernelTcpInfoPrefix>() {
            Some(normalize_linux_tcp_info(LinuxTcpInfoRaw {
                tcpi_state: info.tcpi_state,
                tcpi_rtt: info.tcpi_rtt,
                tcpi_min_rtt: info.tcpi_rtt.saturating_sub(info.tcpi_rttvar),
                tcpi_snd_mss: info.tcpi_snd_mss,
                tcpi_unacked: info.tcpi_unacked,
                tcpi_snd_cwnd: info.tcpi_snd_cwnd,
                tcpi_snd_wnd: info.tcpi_rcv_space.max(65_536),
                tcpi_total_retrans: info.tcpi_total_retrans,
            }))
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn query_socket_tcp_info(_stream: &StdTcpStream) -> Option<CoreTcpSample> {
    None
}

/// Qualified UPnP MediaRenderer descriptor (specifically targeting HiFi ROSE RS130).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rs130DeviceDescriptor {
    pub udn: String,
    pub friendly_name: String,
    pub model_name: Option<String>,
    pub model_description: Option<String>,
    pub manufacturer: Option<String>,
    pub description_url: String,
    pub control_url: String,
}

impl Rs130DeviceDescriptor {
    pub fn is_qualified_rs130(&self) -> bool {
        let combined = format!(
            "{} {} {} {}",
            self.friendly_name,
            self.model_name.as_deref().unwrap_or(""),
            self.model_description.as_deref().unwrap_or(""),
            self.manufacturer.as_deref().unwrap_or("")
        )
        .to_ascii_lowercase();
        combined.contains("rs130") || combined.contains("rose") || combined.contains("citech")
    }

    pub fn supports_extension(&self, ext: &str) -> bool {
        matches!(
            ext.trim().to_ascii_lowercase().as_str(),
            "flac" | "wav" | "dsf" | "dff" | "mp3" | "m4a" | "alac" | "ogg"
        )
    }
}

/// Inspects a UPnP device description URL, verifies AVTransport service support,
/// and enforces an optional persisted UDN match before binding.
pub fn inspect_rs130_description(
    description_url: &str,
    expected_udn: Option<&str>,
) -> Result<Rs130DeviceDescriptor, String> {
    let (host, port, path) = parse_http_url(description_url)
        .ok_or_else(|| format!("invalid UPnP description URL '{}'", description_url))?;
    let response = http_request_raw(&host, port, &format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        path, host, port
    ))?;

    if !response.contains("200 OK") {
        return Err(format!("UPnP description fetch failed from {}", description_url));
    }
    if !response.contains("AVTransport") {
        return Err("UPnP device does not implement AVTransport service".into());
    }

    let udn = extract_xml_tag(&response, "UDN")
        .ok_or_else(|| "UPnP description is missing <UDN>".to_string())?;
    if let Some(expected) = expected_udn {
        if udn != expected {
            return Err(format!(
                "UPnP UDN mismatch: expected '{}', found '{}'",
                expected, udn
            ));
        }
    }

    let friendly_name = extract_xml_tag(&response, "friendlyName")
        .unwrap_or_else(|| "RS130 Streamer".to_string());
    let model_name = extract_xml_tag(&response, "modelName");
    let model_description = extract_xml_tag(&response, "modelDescription");
    let manufacturer = extract_xml_tag(&response, "manufacturer");
    let raw_control = extract_avtransport_control_url(&response)
        .unwrap_or_else(|| "/AVTransport/control".to_string());

    let control_url = if raw_control.starts_with("http://") {
        raw_control
    } else if raw_control.starts_with('/') {
        format!("http://{}:{}{}", host, port, raw_control)
    } else {
        format!("http://{}:{}/{}", host, port, raw_control)
    };

    Ok(Rs130DeviceDescriptor {
        udn,
        friendly_name,
        model_name,
        model_description,
        manufacturer,
        description_url: description_url.to_string(),
        control_url,
    })
}

struct ActiveMediaSession {
    capability_path: String,
    stream_url: String,
    run_token: Mutex<RunToken>,
    buffer: Arc<Vec<u8>>,
    content_type: &'static str,
    realtime_bytes_per_sec: Option<f64>,
    preroll_bytes: u64,
    steady_sndbuf_bytes: usize,
    fast_start_sndbuf_bytes: usize,
    chunk_bytes: usize,
    metadata_offset: Option<u64>,
    audio_payload_end: u64,
    has_streamed_audio: AtomicBool,
    last_audio_end_offset: AtomicU64,
    cancelled: AtomicBool,
}

struct StreamSlotGuard {
    counter: Arc<AtomicUsize>,
}

impl Drop for StreamSlotGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Low-noise HTTP media server serving opaque per-`RunToken` capability URLs from locked RAM.
pub struct CoreMediaServer {
    listen_addr: SocketAddr,
    advertised_ip: Ipv4Addr,
    active_session: Arc<Mutex<Option<Arc<ActiveMediaSession>>>>,
    pacing_metrics: Arc<CorePacingMetrics>,
    paused_flag: Arc<AtomicBool>,
    stop_listener: Arc<AtomicBool>,
    active_streams: Arc<AtomicUsize>,
    listener_join: Option<std::thread::JoinHandle<()>>,
}

impl CoreMediaServer {
    pub fn bind(
        bind_addr: SocketAddr,
        advertised_ip: String,
        allow_loopback_advertise: bool,
        max_concurrent_streams: usize,
    ) -> Result<Self, String> {
        Self::bind_with_config(
            bind_addr,
            advertised_ip,
            allow_loopback_advertise,
            max_concurrent_streams,
            CorePacerConfig::default(),
        )
    }

    pub fn bind_with_config(
        bind_addr: SocketAddr,
        advertised_ip: String,
        allow_loopback_advertise: bool,
        max_concurrent_streams: usize,
        pacer_config: CorePacerConfig,
    ) -> Result<Self, String> {
        let validated_ip = validate_advertised_lan_ip(&advertised_ip, allow_loopback_advertise)?;
        let listener = TcpListener::bind(bind_addr).map_err(|e| {
            format!(
                "failed to bind Core UPnP media port {}: {}",
                bind_addr, e
            )
        })?;
        let listen_addr = listener
            .local_addr()
            .map_err(|e| format!("failed to query media listener addr: {}", e))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("failed to configure listener: {}", e))?;

        let active_session: Arc<Mutex<Option<Arc<ActiveMediaSession>>>> = Arc::new(Mutex::new(None));
        let pacing_metrics = Arc::new(CorePacingMetrics::default());
        let paused_flag = Arc::new(AtomicBool::new(false));
        let stop_listener = Arc::new(AtomicBool::new(false));
        let active_streams = Arc::new(AtomicUsize::new(0));
        let max_streams = max_concurrent_streams.max(1);

        let session_ref = Arc::clone(&active_session);
        let metrics_ref = Arc::clone(&pacing_metrics);
        let paused_ref = Arc::clone(&paused_flag);
        let stop_ref = Arc::clone(&stop_listener);
        let streams_ref = Arc::clone(&active_streams);

        let join = std::thread::Builder::new()
            .name("cadence-core-upnp-listener".into())
            .spawn(move || {
                while !stop_ref.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if stream.set_nonblocking(false).is_err() {
                                continue;
                            }
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

                            let prev = streams_ref.fetch_add(1, Ordering::AcqRel);
                            if prev >= max_streams {
                                streams_ref.fetch_sub(1, Ordering::AcqRel);
                                let _ = stream.write_all(
                                    b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
                                );
                                continue;
                            }

                            let slot_guard = StreamSlotGuard {
                                counter: Arc::clone(&streams_ref),
                            };
                            let s_ref = Arc::clone(&session_ref);
                            let m_ref = Arc::clone(&metrics_ref);
                            let p_ref = Arc::clone(&paused_ref);
                            let cfg = pacer_config;

                            let _ = std::thread::Builder::new()
                                .name("cadence-core-pacer".into())
                                .spawn(move || {
                                    let _slot = slot_guard;
                                    Self::handle_client_sync(stream, s_ref, m_ref, p_ref, cfg);
                                });
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("failed to spawn media listener thread: {}", e))?;

        Ok(Self {
            listen_addr,
            advertised_ip: validated_ip,
            active_session,
            pacing_metrics,
            paused_flag,
            stop_listener,
            active_streams,
            listener_join: Some(join),
        })
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }

    pub fn pacing_snapshot(&self) -> CorePacingSnapshot {
        self.pacing_metrics.snapshot()
    }

    fn handle_client_sync(
        mut stream: StdTcpStream,
        active_session: Arc<Mutex<Option<Arc<ActiveMediaSession>>>>,
        pacing_metrics: Arc<CorePacingMetrics>,
        paused_flag: Arc<AtomicBool>,
        pacer_config: CorePacerConfig,
    ) {
        pin_current_thread_to_pacer_core();
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

        let mut buf = [0u8; 4096];
        let n = match stream.read(&mut buf) {
            Ok(n) if n > 0 => n,
            _ => return,
        };

        let request = String::from_utf8_lossy(&buf[..n]);
        let mut first_line_parts = request.lines().next().unwrap_or("").split_whitespace();
        let method = first_line_parts.next().unwrap_or("");
        let raw_target = first_line_parts.next().unwrap_or("");
        let req_path = raw_target.split('?').next().unwrap_or("");

        let is_head = method == "HEAD";
        if method != "GET" && !is_head {
            let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
            return;
        }

        if req_path.contains("..") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            return;
        }

        let session = match active_session.lock().ok().and_then(|g| g.clone()) {
            Some(s) if !s.cancelled.load(Ordering::Acquire) && s.capability_path == req_path => s,
            _ => {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                return;
            }
        };

        let len = session.buffer.len() as u64;
        let range_header = request
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("range:"))
            .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()));

        let (start, end, response_header) = match range_header {
            Some(r) => match parse_http_range(&r, len) {
                Ok((s, e)) => (
                    s,
                    e,
                    format!(
                        "HTTP/1.1 206 Partial Content\r\n\
                         Content-Type: {}\r\n\
                         Content-Range: bytes {}-{}/{}\r\n\
                         Content-Length: {}\r\n\
                         Accept-Ranges: bytes\r\n\
                         transferMode.dlna.org: Streaming\r\n\
                         Connection: close\r\n\r\n",
                        session.content_type,
                        s,
                        e,
                        len,
                        e - s + 1
                    ),
                ),
                Err(()) => {
                    let msg = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nConnection: close\r\n\r\n",
                        len
                    );
                    let _ = stream.write_all(msg.as_bytes());
                    return;
                }
            },
            None => (
                0,
                len.saturating_sub(1),
                format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: {}\r\n\
                     Content-Length: {}\r\n\
                     Accept-Ranges: bytes\r\n\
                     transferMode.dlna.org: Streaming\r\n\
                     Connection: close\r\n\r\n",
                    session.content_type, len
                ),
            ),
        };

        // Detect DSF ID3v2 metadata probes or tail artwork probes:
        let is_metadata_request = if let Some(meta_off) = session.metadata_offset {
            meta_off > 0 && start >= meta_off
        } else {
            len > 10 * 1024 * 1024
                && start >= len.saturating_sub(10 * 1024 * 1024)
                && (end - start + 1) < 5 * 1024 * 1024
        };

        let is_range_continuation = !is_metadata_request && start >= 1024 * 1024;
        let is_contiguous_reconnect = if is_range_continuation
            && session.has_streamed_audio.load(Ordering::Acquire)
        {
            let prev_end = session.last_audio_end_offset.load(Ordering::Acquire);
            start >= prev_end.saturating_sub(256 * 1024)
                && start <= prev_end.saturating_add(512 * 1024)
        } else {
            false
        };

        if !is_metadata_request {
            pacing_metrics
                .fast_start_sndbuf_bytes
                .store(session.fast_start_sndbuf_bytes as u64, Ordering::Relaxed);
        }

        if is_range_continuation {
            apply_socket_sndbuf(&stream, session.steady_sndbuf_bytes, &pacing_metrics);
        } else {
            apply_socket_sndbuf(&stream, session.fast_start_sndbuf_bytes, &pacing_metrics);
        }

        if stream.write_all(response_header.as_bytes()).is_err() || is_head || len == 0 {
            return;
        }

        let _ = stream.set_read_timeout(None);
        if !is_metadata_request {
            session.has_streamed_audio.store(true, Ordering::Release);
            session.last_audio_end_offset.store(start, Ordering::Release);
        }

        let mut pacer = CorePacer::new(
            pacer_config,
            session.realtime_bytes_per_sec,
            session.preroll_bytes,
            session.steady_sndbuf_bytes,
            is_contiguous_reconnect,
            is_range_continuation,
            is_metadata_request,
            pacing_metrics,
            paused_flag,
        );

        let body_slice = &session.buffer.as_slice()[start as usize..=end as usize];
        let _ = stream_paced_slice_no_alloc(
            &mut stream,
            body_slice,
            start,
            session.chunk_bytes,
            !is_metadata_request,
            &session.last_audio_end_offset,
            &session.cancelled,
            &mut pacer,
        );
        let _ = stream.flush();
    }

    fn stop_active_session(&self) {
        if let Ok(mut guard) = self.active_session.lock() {
            if let Some(prev) = guard.take() {
                prev.cancelled.store(true, Ordering::Release);
            }
        }
    }

    fn shutdown(&mut self) {
        self.stop_active_session();
        self.stop_listener.store(true, Ordering::Release);
        let _ = StdTcpStream::connect(self.listen_addr);
        if let Some(join) = self.listener_join.take() {
            let _ = join.join();
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while self.active_streams.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for CoreMediaServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone, Debug)]
struct TrackMediaMeta {
    title: String,
    artist: String,
    album: String,
    duration_secs: f64,
    extension: String,
}

/// Configuration for `UpnpSessionRuntime`.
#[derive(Clone, Debug)]
pub struct UpnpSessionConfig {
    pub bind_addr: SocketAddr,
    pub advertised_ip: String,
    pub allow_loopback_advertise: bool,
    pub max_concurrent_streams: usize,
    pub pacer_config: CorePacerConfig,
    pub target_device: Rs130DeviceDescriptor,
}

/// Outcome of polling/reconciling the target UPnP renderer's transport state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportReport {
    NoActiveRun,
    StartedPlaying,
    Steady,
    CompletedAndAdvanced,
    ExternalTakeover,
    RendererFailed,
}

/// Snapshot returned by `reconcile_after_restart` without seizing the renderer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestartProbeSnapshot {
    pub transport_state: String,
    pub current_uri: String,
    pub rel_time: String,
}

struct UpnpBridgeRenderer {
    device: Rs130DeviceDescriptor,
    media_server_addr: SocketAddr,
    advertised_ip: Ipv4Addr,
    active_session: Arc<Mutex<Option<Arc<ActiveMediaSession>>>>,
    paused_flag: Arc<AtomicBool>,
    shared_buffers: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>,
    track_meta: Arc<HashMap<String, TrackMediaMeta>>,
}

impl Renderer for UpnpBridgeRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        match action {
            RendererAction::Play { entry, token } => {
                let buffer = self
                    .shared_buffers
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&entry.track_id).cloned())
                    .ok_or(RendererError)?;
                let meta = self
                    .track_meta
                    .get(&entry.track_id)
                    .cloned()
                    .ok_or(RendererError)?;

                if !self.device.supports_extension(&meta.extension) {
                    return Err(RendererError);
                }

                // Cancel any previous session immediately so late requests never receive new track bytes
                if let Ok(mut guard) = self.active_session.lock() {
                    if let Some(old) = guard.take() {
                        old.cancelled.store(true, Ordering::Release);
                    }
                }
                self.paused_flag.store(false, Ordering::Release);

                let dsf_info = if meta.extension == "dsf" {
                    parse_dsf_header_bytes(buffer.as_slice())
                } else {
                    None
                };

                let len = buffer.len() as u64;
                let (realtime_bps, metadata_offset, audio_payload_end) =
                    if let Some(info) = dsf_info {
                        let payload_end = if info.metadata_offset > 0 && info.metadata_offset <= len {
                            info.metadata_offset
                        } else {
                            len
                        };
                        (
                            Some(info.bitrate_bytes_per_sec),
                            if info.metadata_offset > 0 {
                                Some(info.metadata_offset)
                            } else {
                                None
                            },
                            payload_end,
                        )
                    } else if meta.duration_secs > 0.1 {
                        (Some(len as f64 / meta.duration_secs), None, len)
                    } else {
                        (None, None, len)
                    };

                let preroll_bytes = realtime_bps
                    .map(|rt| ((rt * CORE_PREROLL_SECS) as u64).min(MAX_CORE_PREROLL_BYTES))
                    .unwrap_or(0);
                let steady_sndbuf = realtime_bps
                    .map(calculate_core_steady_sndbuf_bytes)
                    .unwrap_or(MIN_CORE_STEADY_SNDBUF_BYTES);
                let chunk_bytes = realtime_bps
                    .map(calculate_core_chunk_bytes)
                    .unwrap_or(MAX_CORE_CHUNK_BYTES);

                let cap_id = uuid::Uuid::new_v4().simple().to_string();
                let capability_path = format!("/media/cap_{}.{}", cap_id, meta.extension);
                let stream_url = format!(
                    "http://{}:{}{}",
                    self.advertised_ip,
                    self.media_server_addr.port(),
                    capability_path
                );

                let session = Arc::new(ActiveMediaSession {
                    capability_path,
                    stream_url: stream_url.clone(),
                    run_token: Mutex::new(token.clone()),
                    buffer,
                    content_type: content_type_for_ext(&meta.extension),
                    realtime_bytes_per_sec: realtime_bps,
                    preroll_bytes,
                    steady_sndbuf_bytes: steady_sndbuf,
                    fast_start_sndbuf_bytes: CORE_FAST_START_SNDBUF_BYTES,
                    chunk_bytes,
                    metadata_offset,
                    audio_payload_end,
                    has_streamed_audio: AtomicBool::new(false),
                    last_audio_end_offset: AtomicU64::new(0),
                    cancelled: AtomicBool::new(false),
                });

                if let Ok(mut guard) = self.active_session.lock() {
                    *guard = Some(session);
                }

                send_set_avtransport_uri_and_play(&self.device.control_url, &stream_url, &meta)
                    .map_err(|_| RendererError)
            }
            RendererAction::Pause => {
                self.paused_flag.store(true, Ordering::Release);
                send_simple_avtransport_action(&self.device.control_url, "Pause", "")
                    .map(|_| ())
                    .map_err(|_| RendererError)
            }
            RendererAction::Resume { token } => {
                if let Ok(guard) = self.active_session.lock() {
                    if let Some(s) = guard.as_ref() {
                        if let Ok(mut tok_guard) = s.run_token.lock() {
                            *tok_guard = token.clone();
                        }
                    }
                }
                self.paused_flag.store(false, Ordering::Release);
                send_simple_avtransport_action(
                    &self.device.control_url,
                    "Play",
                    "<Speed>1</Speed>",
                )
                .map(|_| ())
                .map_err(|_| RendererError)
            }
            RendererAction::Seek {
                position_seconds,
                token,
            } => {
                if let Ok(guard) = self.active_session.lock() {
                    if let Some(s) = guard.as_ref() {
                        if let Ok(mut tok_guard) = s.run_token.lock() {
                            *tok_guard = token.clone();
                        }
                    }
                }
                let rel_time = format_rel_time(*position_seconds);
                let extra = format!("<Unit>REL_TIME</Unit><Target>{}</Target>", rel_time);
                send_simple_avtransport_action(&self.device.control_url, "Seek", &extra)
                    .map(|_| ())
                    .map_err(|_| RendererError)
            }
            RendererAction::Stop => {
                self.paused_flag.store(false, Ordering::Release);
                if let Ok(mut guard) = self.active_session.lock() {
                    if let Some(old) = guard.take() {
                        old.cancelled.store(true, Ordering::Release);
                    }
                }
                let _ = send_simple_avtransport_action(&self.device.control_url, "Stop", "");
                Ok(())
            }
        }
    }
}

/// Complete Phase 5 headless Core + paced UPnP + RS130 session coordinator.
pub struct UpnpSessionRuntime<
    P: PlatformProbe = SystemPlatformProbe,
    L: MemoryLocker = SystemMemoryLocker,
> {
    inner: HeadlessCoreRuntime<UpnpBridgeRenderer, P, L>,
    media_server: CoreMediaServer,
    device: Rs130DeviceDescriptor,
    shared_buffers: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>,
    consecutive_failures: u32,
}

impl UpnpSessionRuntime<SystemPlatformProbe, SystemMemoryLocker> {
    pub fn open(
        headless_config: HeadlessConfig,
        upnp_config: UpnpSessionConfig,
    ) -> Result<Self, RuntimeError> {
        Self::open_with_platform(
            headless_config,
            upnp_config,
            SystemPlatformProbe,
            SystemMemoryLocker,
        )
    }
}

impl<P: PlatformProbe, L: MemoryLocker> UpnpSessionRuntime<P, L> {
    pub fn open_with_platform(
        headless_config: HeadlessConfig,
        upnp_config: UpnpSessionConfig,
        probe: P,
        locker: L,
    ) -> Result<Self, RuntimeError> {
        let media_server = CoreMediaServer::bind_with_config(
            upnp_config.bind_addr,
            upnp_config.advertised_ip.clone(),
            upnp_config.allow_loopback_advertise,
            upnp_config.max_concurrent_streams,
            upnp_config.pacer_config,
        )
        .map_err(RuntimeError::Database)?;

        let track_meta = Arc::new(load_track_media_meta(&headless_config.db_path)?);
        let shared_buffers = Arc::new(Mutex::new(HashMap::new()));

        let bridge = UpnpBridgeRenderer {
            device: upnp_config.target_device.clone(),
            media_server_addr: media_server.listen_addr(),
            advertised_ip: media_server.advertised_ip,
            active_session: Arc::clone(&media_server.active_session),
            paused_flag: Arc::clone(&media_server.paused_flag),
            shared_buffers: Arc::clone(&shared_buffers),
            track_meta,
        };

        let inner = HeadlessCoreRuntime::open_with_platform(headless_config, bridge, probe, locker)?;
        Ok(Self {
            inner,
            media_server,
            device: upnp_config.target_device,
            shared_buffers,
            consecutive_failures: 0,
        })
    }

    pub fn media_listen_addr(&self) -> SocketAddr {
        self.media_server.listen_addr()
    }

    pub fn pacing_snapshot(&self) -> CorePacingSnapshot {
        self.media_server.pacing_snapshot()
    }

    pub fn admit_tracks(&mut self, track_ids: &[String]) -> Result<(), RuntimeError> {
        self.inner.admit_tracks(track_ids)?;
        if let Ok(mut map) = self.shared_buffers.lock() {
            for id in track_ids {
                if let Some(buf) = self.inner.shared_track_buffer(id) {
                    map.insert(id.clone(), buf);
                }
            }
        }
        Ok(())
    }

    pub fn request(&mut self, input: &[u8]) -> Value {
        self.inner.request(input)
    }

    /// Polls the target RS130 renderer (`GetTransportInfo` + `GetPositionInfo`) and reconciles
    /// qualified transport events into `HeadlessCoreRuntime`.
    pub fn reconcile_renderer(&mut self) -> Result<TransportReport, RuntimeError> {
        let active = self
            .media_server
            .active_session
            .lock()
            .ok()
            .and_then(|g| g.clone());
        let Some(session) = active else {
            return Ok(TransportReport::NoActiveRun);
        };
        let token = session
            .run_token
            .lock()
            .map_err(|_| RuntimeError::Closed)?
            .clone();

        let probe = match query_renderer_state(&self.device.control_url) {
            Ok(p) => {
                self.consecutive_failures = 0;
                p
            }
            Err(_) => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                if self.consecutive_failures >= 3 {
                    self.media_server.stop_active_session();
                    let _ = self.inner.on_renderer_event(RendererEvent::Failed(token));
                    return Ok(TransportReport::RendererFailed);
                }
                return Ok(TransportReport::Steady);
            }
        };

        // Detect external takeover: renderer's CurrentURI changed away from our opaque session URI
        if !probe.current_uri.is_empty() && probe.current_uri != session.stream_url {
            self.media_server.stop_active_session();
            let _ = self
                .inner
                .on_renderer_event(RendererEvent::ExternalTakeover(token));
            return Ok(TransportReport::ExternalTakeover);
        }

        match probe.transport_state.as_str() {
            "PLAYING" => {
                let changed = self
                    .inner
                    .on_renderer_event(RendererEvent::Started(token))
                    .unwrap_or(false);
                if changed {
                    Ok(TransportReport::StartedPlaying)
                } else {
                    Ok(TransportReport::Steady)
                }
            }
            "STOPPED" => {
                // CRITICAL: HTTP EOF alone does not establish completion, and STOPPED before
                // audio tail delivery does not complete. Require both audio delivery to reach
                // `audio_payload_end` AND renderer `STOPPED` on the matching session URI.
                let streamed = session.has_streamed_audio.load(Ordering::Acquire);
                let end_offset = session.last_audio_end_offset.load(Ordering::Acquire);
                if streamed && end_offset >= session.audio_payload_end {
                    let advanced = self
                        .inner
                        .on_renderer_event(RendererEvent::Completed(token))
                        .unwrap_or(false);
                    if advanced {
                        return Ok(TransportReport::CompletedAndAdvanced);
                    }
                }
                Ok(TransportReport::Steady)
            }
            _ => Ok(TransportReport::Steady),
        }
    }

    /// Inspects the renderer state after a Core restart without seizing the renderer or
    /// issuing `SetAVTransportURI`, `Play`, or `Stop`.
    pub fn reconcile_after_restart(&self) -> Result<RestartProbeSnapshot, String> {
        query_renderer_state(&self.device.control_url)
    }

    pub fn shutdown(&mut self) -> Result<(), RuntimeError> {
        self.media_server.shutdown();
        if let Ok(mut map) = self.shared_buffers.lock() {
            map.clear();
        }
        self.inner.shutdown()
    }
}

fn load_track_media_meta(db_path: & std::path::Path) -> Result<HashMap<String, TrackMediaMeta>, RuntimeError> {
    let db = crate::db::AppDb::new(db_path.to_path_buf()).map_err(RuntimeError::Database)?;
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare(
            "SELECT id, title, artist_credit, album_title, duration_secs, file_path
             FROM tracks
             WHERE is_online != 0
             ORDER BY album_title ASC, COALESCE(track_number, 0) ASC, title ASC, id ASC",
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
            ))
        })
        .map_err(|e| RuntimeError::Database(e.to_string()))?;

    let mut map = HashMap::new();
    let mut used = std::collections::HashSet::new();
    for row in rows {
        let (raw_id, title, artist, album, duration_secs, file_path) =
            row.map_err(|e| RuntimeError::Database(e.to_string()))?;
        let token_id = super::sanitize_or_hash_token(&raw_id, &mut used);
        let ext = PathBuf::from(&file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("flac")
            .to_ascii_lowercase();
        map.insert(
            token_id,
            TrackMediaMeta {
                title,
                artist,
                album,
                duration_secs,
                extension: ext,
            },
        );
    }
    Ok(map)
}

fn content_type_for_ext(ext: &str) -> &'static str {
    match ext {
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "dsf" | "dff" => "audio/x-dsd",
        "mp3" => "audio/mpeg",
        "m4a" | "alac" => "audio/mp4",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

fn parse_http_range(header_value: &str, len: u64) -> Result<(u64, u64), ()> {
    let spec = header_value.split('=').nth(1).ok_or(())?;
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = spec.split_once('-').ok_or(())?;
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Err(());
    }
    let (start, end) = if a.is_empty() {
        let suffix: u64 = b.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = a.parse().map_err(|_| ())?;
        let end = if b.is_empty() {
            len - 1
        } else {
            b.parse::<u64>().map_err(|_| ())?.min(len - 1)
        };
        (start, end)
    };
    if start >= len || end < start {
        return Err(());
    }
    Ok((start, end))
}

fn format_rel_time(seconds: f64) -> String {
    let total = seconds.round().max(0.0) as u64;
    let hrs = total / 3600;
    let mins = (total % 3600) / 60;
    let secs = total % 60;
    format!("{:02}:{:02}:{:02}", hrs, mins, secs)
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn send_set_avtransport_uri_and_play(
    control_url: &str,
    stream_url: &str,
    meta: &TrackMediaMeta,
) -> Result<(), String> {
    let mime = content_type_for_ext(&meta.extension);
    let res_elements = if meta.extension == "dsf" || meta.extension == "dff" {
        format!(
            "&lt;res protocolInfo=\"http-get:*:audio/x-dsd:*\"&gt;{}&lt;/res&gt;\
             &lt;res protocolInfo=\"http-get:*:audio/dsf:*\"&gt;{}&lt;/res&gt;",
            stream_url, stream_url
        )
    } else {
        format!(
            "&lt;res protocolInfo=\"http-get:*:{}:*\"&gt;{}&lt;/res&gt;",
            mime, stream_url
        )
    };

    let didl = format!(
        "&lt;DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"&gt;\
           &lt;item id=\"0\" parentID=\"0\" restricted=\"1\"&gt;\
             &lt;dc:title&gt;{}&lt;/dc:title&gt;\
             &lt;dc:creator&gt;{}&lt;/dc:creator&gt;\
             &lt;upnp:album&gt;{}&lt;/upnp:album&gt;\
             &lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;\
             {}\
           &lt;/item&gt;\
         &lt;/DIDL-Lite&gt;",
        escape_xml(&meta.title),
        escape_xml(&meta.artist),
        escape_xml(&meta.album),
        res_elements
    );

    let set_body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
           <s:Body>\
             <u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
               <InstanceID>0</InstanceID>\
               <CurrentURI>{}</CurrentURI>\
               <CurrentURIMetaData>{}</CurrentURIMetaData>\
             </u:SetAVTransportURI>\
           </s:Body>\
         </s:Envelope>",
        stream_url, didl
    );
    send_soap_post(control_url, "SetAVTransportURI", &set_body)?;
    send_simple_avtransport_action(control_url, "Play", "<Speed>1</Speed>")?;
    Ok(())
}

fn send_simple_avtransport_action(
    control_url: &str,
    action: &str,
    extra_xml: &str,
) -> Result<String, String> {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
           <s:Body>\
             <u:{action} xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
               <InstanceID>0</InstanceID>{extra_xml}\
             </u:{action}>\
           </s:Body>\
         </s:Envelope>"
    );
    send_soap_post(control_url, action, &body)
}

fn query_renderer_state(control_url: &str) -> Result<RestartProbeSnapshot, String> {
    let transport_xml = send_simple_avtransport_action(control_url, "GetTransportInfo", "")?;
    let pos_xml = send_simple_avtransport_action(control_url, "GetPositionInfo", "")?;
    let transport_state =
        extract_xml_tag(&transport_xml, "CurrentTransportState").unwrap_or_else(|| "UNKNOWN".into());
    let current_uri = extract_xml_tag(&pos_xml, "TrackURI").unwrap_or_default();
    let rel_time = extract_xml_tag(&pos_xml, "RelTime").unwrap_or_else(|| "00:00:00".into());
    Ok(RestartProbeSnapshot {
        transport_state,
        current_uri,
        rel_time,
    })
}

fn send_soap_post(control_url: &str, action: &str, body: &str) -> Result<String, String> {
    let (host, port, path) =
        parse_http_url(control_url).ok_or_else(|| format!("invalid control URL '{}'", control_url))?;
    let req = format!(
        "POST {} HTTP/1.1\r\n\
         Host: {}:{}\r\n\
         Content-Type: text/xml; charset=\"utf-8\"\r\n\
         Content-Length: {}\r\n\
         SOAPACTION: \"urn:schemas-upnp-org:service:AVTransport:1#{}\"\r\n\
         Connection: close\r\n\r\n\
         {}",
        path,
        host,
        port,
        body.len(),
        action,
        body
    );
    let resp = http_request_raw(&host, port, &req)?;
    if resp.contains("200 OK") {
        Ok(resp)
    } else {
        Err(format!("UPnP SOAP action {} failed", action))
    }
}

fn http_request_raw(host: &str, port: u16, request: &str) -> Result<String, String> {
    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e| format!("invalid socket address {}:{}: {}", host, port, e))?;
    let mut stream = StdTcpStream::connect_timeout(&addr, Duration::from_millis(1500))
        .map_err(|e| format!("connect failed: {}", e))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write failed: {}", e))?;
    let mut response = String::new();
    stream
        .take(256 * 1024)
        .read_to_string(&mut response)
        .map_err(|e| format!("read failed: {}", e))?;
    Ok(response)
}

fn parse_http_url(url: &str) -> Option<(String, u16, String)> {
    let stripped = url.strip_prefix("http://")?;
    let slash_idx = stripped.find('/').unwrap_or(stripped.len());
    let host_port = &stripped[..slash_idx];
    let path = if slash_idx < stripped.len() {
        &stripped[slash_idx..]
    } else {
        "/"
    };
    let mut parts = host_port.split(':');
    let host = parts.next()?.to_string();
    let port = parts.next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(80);
    Some((host, port, path.to_string()))
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

fn extract_avtransport_control_url(xml: &str) -> Option<String> {
    let pos = xml.find("AVTransport")?;
    let section = &xml[pos..];
    let end_service = section.find("</service>")?;
    extract_xml_tag(&section[..end_service], "controlURL")
}
