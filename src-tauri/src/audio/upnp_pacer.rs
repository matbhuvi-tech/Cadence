//! Simplified 3-state audiophile UPnP pacing controller (`Phase 2.2` bounded recovery).
//!
//! Objective: maintain a small, stable audio headroom (~1.2 s) at the UPnP renderer while
//! cruising at ~1.000x real-time bitrate and recovering with lead-gated bounded tiers
//! (`1.020x` shallow / `1.050x` moderate / `1.080x` deep deficit) only when estimated
//! delivery lead drops below target—without accumulating excess receiver backlog,
//! restoring Phase 1's rate-inversion/2s-reset defects, or executing blocking calls
//! in the critical streaming loop.

use std::net::TcpStream as StdTcpStream;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::stream_tuning;
use crate::diag_log;
use crate::diagnostics::DiagCategory;

/// Tuning parameters for the 3-state bounded-recovery UPnP pacing controller.
#[derive(Debug, Clone, Copy)]
pub struct PacerConfig {
    /// Target delivery lead to exit `InitialFill` (default: 1200 ms).
    pub initial_lead_target_ms: u64,
    /// Half-width around `effective_target_lead_ms` forming `[L_low, L_high]` hysteresis.
    pub band_half_width_ms: i64,
    /// Additional lead above `L_high` defining `L_max` trim ceiling.
    pub trim_margin_ms: i64,
    /// Hard cap on deficit accrued behind the 1.000x playback horizon (`D_max`).
    pub max_debt_ms: i64,
    /// Lower safety floor for `effective_target_lead_ms` under flow-control clamping.
    pub min_safe_target_ms: u64,
    /// Conservative recovery multiplier used when headroom is mildly below `L_low`.
    pub recovery_multiplier: f64,
    /// Lead threshold below which moderate recovery (`moderate_recovery_multiplier`) engages.
    pub moderate_recovery_lead_ms: i64,
    /// Moderate bounded recovery multiplier for thinning cushion (`400..800 ms` at 1200 ms target).
    pub moderate_recovery_multiplier: f64,
    /// Lead threshold below which deep deficit recovery (`deficit_recovery_multiplier`) engages.
    pub deficit_recovery_lead_ms: i64,
    /// Bounded deficit recovery multiplier when lead is critically low (`< 400 ms`).
    pub deficit_recovery_multiplier: f64,
    /// Gentle sub-real-time trim multiplier applied only when lead exceeds `L_max`.
    pub trim_multiplier: f64,
    /// Write/lag duration threshold separating normal operation from slow events.
    pub stall_threshold_ms: u64,
    /// Fast socket write threshold indicating healthy non-blocked kernel drain.
    pub fast_write_ms: u64,
    /// Short holdoff pausing `> 1.000x` boost briefly right on a congestion/uncertain stall.
    pub congestion_holdoff_ms: u64,
    /// Cooldown before relaxing `flow_suppressed` after flow-control signal clears.
    pub flow_clear_ms: u64,
    /// Periodic non-blocking `SIO_TCP_INFO` probe cadence during normal playback (~5 Hz).
    pub tcp_info_poll_ms: u64,
    /// Minimum spacing between anomaly-triggered `SIO_TCP_INFO` queries.
    pub tcp_info_min_event_ms: u64,
    /// Maximum age before an unrefreshed `SIO_TCP_INFO` snapshot becomes `Uncertain`.
    pub tcp_info_stale_ms: u64,
    /// Upper bound on uncertainty margin under fallback mode (`Uncertain`).
    pub uncertain_max_margin_ms: u64,
    /// Minimum interval between repeated flow-control ceiling reductions.
    pub target_clamp_cooldown_ms: u64,
}

impl Default for PacerConfig {
    fn default() -> Self {
        Self {
            initial_lead_target_ms: 1200,
            band_half_width_ms: 100,
            trim_margin_ms: 100,
            max_debt_ms: 3000,
            min_safe_target_ms: 150,
            recovery_multiplier: stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER, // 1.020x
            moderate_recovery_lead_ms: 800,
            moderate_recovery_multiplier: 1.050,
            deficit_recovery_lead_ms: 400,
            deficit_recovery_multiplier: 1.080,
            trim_multiplier: 0.995,
            stall_threshold_ms: stream_tuning::BACKPRESSURE_STALL_MS, // 25 ms
            fast_write_ms: 10,
            congestion_holdoff_ms: 100,
            flow_clear_ms: 1500,
            tcp_info_poll_ms: 200,
            tcp_info_min_event_ms: 50,
            tcp_info_stale_ms: 750,
            uncertain_max_margin_ms: 250,
            target_clamp_cooldown_ms: 500,
        }
    }
}

/// Non-blocking snapshot of Winsock kernel TCP statistics (`SIO_TCP_INFO`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpSocketSample {
    pub rtt_us: u32,
    pub min_rtt_us: u32,
    pub bytes_in_flight: u32,
    pub cwnd: u32,
    pub snd_wnd: u32,
    pub bytes_retrans: u32,
    pub fast_retrans: u32,
    pub dup_acks_in: u32,
    pub timeout_episodes: u32,
    pub snd_lim_time_rwin: Option<u32>,
    pub snd_lim_time_cwnd: Option<u32>,
}

/// Confidence level of the delivery estimate passed to the rate controller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryCertainty {
    Measured,
    Uncertain,
}

impl DeliveryCertainty {
    fn as_str(self) -> &'static str {
        match self {
            Self::Measured => "measured",
            Self::Uncertain => "uncertain",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallCause {
    None,
    LocalScheduleLag,
    LinkCongestion,
    ReceiverFlowControl,
    AmbiguousWriteStall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacingState {
    Unpaced,
    InitialFill,
    SteadyMaintain,
}

impl PacingState {
    fn code(self) -> u8 {
        match self {
            Self::Unpaced => 0,
            Self::InitialFill => 1,
            Self::SteadyMaintain => 2,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Unpaced => "unpaced",
            Self::InitialFill => "initial_fill",
            Self::SteadyMaintain => "steady_maintain",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RateRegime {
    Unpaced,
    InitialFill,
    Cruise,
    Recovering,
    Trim,
    CongestionHoldoff,
    FlowSuppressed,
}

impl RateRegime {
    fn code(self) -> u8 {
        match self {
            Self::Unpaced => 0,
            Self::InitialFill => 1,
            Self::Cruise => 2,
            Self::Recovering => 3,
            Self::Trim => 4,
            Self::CongestionHoldoff => 5,
            Self::FlowSuppressed => 6,
        }
    }

    fn from_code(code: u8) -> &'static str {
        match code {
            1 => "initial_fill",
            2 => "cruise",
            3 => "recovering",
            4 => "trim",
            5 => "congestion_holdoff",
            6 => "flow_suppressed",
            _ => "unpaced",
        }
    }
}

/// Nonblocking atomic pacing and socket observability telemetry updated with
/// zero heap allocations, locks, or synchronous I/O.
#[derive(Debug, Default)]
pub struct UpnpPacingMetrics {
    pub current_state: AtomicU8,
    pub current_regime: AtomicU8,
    pub lead_certainty: AtomicU8, // 0 = uncertain, 1 = measured
    pub current_multiplier_x1000: AtomicU64,
    pub realtime_bytes_per_sec: AtomicU64,
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
    pub max_write_block_us: AtomicU64,
    pub total_write_block_us: AtomicU64,
    pub max_schedule_lag_us: AtomicU64,
    pub total_schedule_lag_us: AtomicU64,
    pub window_reads: AtomicU64,
    pub estimated_lead_ms: AtomicI64,
    pub uncertain_margin_ms: AtomicU64,
    pub effective_target_lead_ms: AtomicU64,
    pub tcp_info_samples: AtomicU64,
    pub congestion_events: AtomicU64,
    pub flow_control_events: AtomicU64,
    pub ambiguous_stall_events: AtomicU64,
    pub last_rtt_us: AtomicU32,
    pub last_bytes_in_flight: AtomicU32,
    pub last_snd_wnd: AtomicU32,
    pub last_bytes_retrans: AtomicU32,
}

impl UpnpPacingMetrics {
    pub fn reset_for_stream(&self) {
        self.current_state.store(0, Ordering::Relaxed);
        self.current_regime.store(0, Ordering::Relaxed);
        self.lead_certainty.store(0, Ordering::Relaxed);
        self.current_multiplier_x1000.store(0, Ordering::Relaxed);
        self.realtime_bytes_per_sec.store(0, Ordering::Relaxed);
        self.configured_sndbuf_bytes.store(0, Ordering::Relaxed);
        self.actual_sndbuf_bytes.store(0, Ordering::Relaxed);
        self.fast_start_sndbuf_bytes.store(0, Ordering::Relaxed);
        self.audio_connections.store(0, Ordering::Relaxed);
        self.chunks_sent.store(0, Ordering::Relaxed);
        self.bytes_sent.store(0, Ordering::Relaxed);
        self.preroll_chunks.store(0, Ordering::Relaxed);
        self.write_block_stalls.store(0, Ordering::Relaxed);
        self.schedule_lag_stalls.store(0, Ordering::Relaxed);
        self.state_transitions.store(0, Ordering::Relaxed);
        self.max_write_block_us.store(0, Ordering::Relaxed);
        self.total_write_block_us.store(0, Ordering::Relaxed);
        self.max_schedule_lag_us.store(0, Ordering::Relaxed);
        self.total_schedule_lag_us.store(0, Ordering::Relaxed);
        self.window_reads.store(0, Ordering::Relaxed);
        self.estimated_lead_ms.store(0, Ordering::Relaxed);
        self.uncertain_margin_ms.store(0, Ordering::Relaxed);
        self.effective_target_lead_ms.store(0, Ordering::Relaxed);
        self.tcp_info_samples.store(0, Ordering::Relaxed);
        self.congestion_events.store(0, Ordering::Relaxed);
        self.flow_control_events.store(0, Ordering::Relaxed);
        self.ambiguous_stall_events.store(0, Ordering::Relaxed);
        self.last_rtt_us.store(0, Ordering::Relaxed);
        self.last_bytes_in_flight.store(0, Ordering::Relaxed);
        self.last_snd_wnd.store(0, Ordering::Relaxed);
        self.last_bytes_retrans.store(0, Ordering::Relaxed);
    }

    #[inline]
    fn record_state(
        &self,
        state: PacingState,
        regime: RateRegime,
        multiplier: f64,
        is_transition: bool,
    ) {
        self.current_state.store(state.code(), Ordering::Relaxed);
        self.current_regime.store(regime.code(), Ordering::Relaxed);
        let milli = (multiplier * 1000.0).round().max(0.0) as u64;
        self.current_multiplier_x1000.store(milli, Ordering::Relaxed);
        if is_transition {
            self.state_transitions.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> UpnpPacingSnapshot {
        let state_str = match self.current_state.load(Ordering::Relaxed) {
            1 => PacingState::InitialFill.as_str(),
            2 => PacingState::SteadyMaintain.as_str(),
            _ => PacingState::Unpaced.as_str(),
        };
        let regime_str = RateRegime::from_code(self.current_regime.load(Ordering::Relaxed));
        let certainty_str = if self.lead_certainty.load(Ordering::Relaxed) == 1 {
            DeliveryCertainty::Measured.as_str()
        } else {
            DeliveryCertainty::Uncertain.as_str()
        };
        let mult_x1000 = self.current_multiplier_x1000.load(Ordering::Relaxed);
        UpnpPacingSnapshot {
            current_state: state_str,
            current_regime: regime_str,
            lead_certainty: certainty_str,
            current_multiplier: mult_x1000 as f64 / 1000.0,
            realtime_bytes_per_sec: self.realtime_bytes_per_sec.load(Ordering::Relaxed),
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
            max_write_block_us: self.max_write_block_us.load(Ordering::Relaxed),
            total_write_block_us: self.total_write_block_us.load(Ordering::Relaxed),
            max_schedule_lag_us: self.max_schedule_lag_us.load(Ordering::Relaxed),
            total_schedule_lag_us: self.total_schedule_lag_us.load(Ordering::Relaxed),
            window_reads: self.window_reads.load(Ordering::Relaxed),
            estimated_lead_ms: self.estimated_lead_ms.load(Ordering::Relaxed),
            uncertain_margin_ms: self.uncertain_margin_ms.load(Ordering::Relaxed),
            effective_target_lead_ms: self.effective_target_lead_ms.load(Ordering::Relaxed),
            tcp_info_samples: self.tcp_info_samples.load(Ordering::Relaxed),
            congestion_events: self.congestion_events.load(Ordering::Relaxed),
            flow_control_events: self.flow_control_events.load(Ordering::Relaxed),
            ambiguous_stall_events: self.ambiguous_stall_events.load(Ordering::Relaxed),
            last_rtt_us: self.last_rtt_us.load(Ordering::Relaxed),
            last_bytes_in_flight: self.last_bytes_in_flight.load(Ordering::Relaxed),
            last_snd_wnd: self.last_snd_wnd.load(Ordering::Relaxed),
            last_bytes_retrans: self.last_bytes_retrans.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpnpPacingSnapshot {
    pub current_state: &'static str,
    pub current_regime: &'static str,
    pub lead_certainty: &'static str,
    pub current_multiplier: f64,
    pub realtime_bytes_per_sec: u64,
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
    pub max_write_block_us: u64,
    pub total_write_block_us: u64,
    pub max_schedule_lag_us: u64,
    pub total_schedule_lag_us: u64,
    pub window_reads: u64,
    pub estimated_lead_ms: i64,
    pub uncertain_margin_ms: u64,
    pub effective_target_lead_ms: u64,
    pub tcp_info_samples: u64,
    pub congestion_events: u64,
    pub flow_control_events: u64,
    pub ambiguous_stall_events: u64,
    pub last_rtt_us: u32,
    pub last_bytes_in_flight: u32,
    pub last_snd_wnd: u32,
    pub last_bytes_retrans: u32,
}

#[derive(Debug, Clone, Copy, Default)]
struct TcpSampleDeltas {
    bytes_retrans: u32,
    fast_retrans: u32,
    dup_acks: u32,
    timeouts: u32,
    rwin_lim: u32,
    cwnd_lim: u32,
}

impl TcpSampleDeltas {
    fn between(curr: TcpSocketSample, prev: Option<TcpSocketSample>) -> Self {
        let Some(p) = prev else {
            return Self::default();
        };
        Self {
            bytes_retrans: curr.bytes_retrans.saturating_sub(p.bytes_retrans),
            fast_retrans: curr.fast_retrans.saturating_sub(p.fast_retrans),
            dup_acks: curr.dup_acks_in.saturating_sub(p.dup_acks_in),
            timeouts: curr.timeout_episodes.saturating_sub(p.timeout_episodes),
            rwin_lim: match (curr.snd_lim_time_rwin, p.snd_lim_time_rwin) {
                (Some(c), Some(prev_v)) => c.saturating_sub(prev_v),
                _ => 0,
            },
            cwnd_lim: match (curr.snd_lim_time_cwnd, p.snd_lim_time_cwnd) {
                (Some(c), Some(prev_v)) => c.saturating_sub(prev_v),
                _ => 0,
            },
        }
    }
}

pub(crate) struct SynchronousPacer {
    config: PacerConfig,
    realtime_rate: Option<f64>,
    pub(crate) state: PacingState,
    preroll: u64,
    sent: u64,
    last_chunk_bytes: usize,
    steady_sndbuf: usize,
    clamped_to_steady: bool,
    is_metadata: bool,
    pub(crate) metrics: Arc<UpnpPacingMetrics>,
    is_paused: Arc<AtomicBool>,

    // Horizon & virtual sleep clock (strictly 1.000x consumption timeline)
    horizon_bytes: f64,
    last_horizon_tick: Option<Instant>,
    next_chunk_due: Option<Instant>,
    horizon_initialized: bool,

    // Delivery observability & bounded uncertainty interval
    last_tcp_sample: Option<TcpSocketSample>,
    last_tcp_sample_at: Option<Instant>,
    last_probe_attempt_at: Option<Instant>,
    baseline_open_snd_wnd: u32,
    uncertain_margin_bytes: u64,
    uncertain_slow_at: Option<Instant>,
    uncertain_slow_cluster: u32,
    clean_fast_streak: u32,

    // Controller hysteresis, holdoff, and suppression state
    effective_target_lead_ms: u64,
    last_target_clamp_at: Option<Instant>,
    is_recovering: bool,
    congestion_holdoff_until: Option<Instant>,
    flow_suppressed_until: Option<Instant>,
}

impl SynchronousPacer {
    pub(crate) fn unpaced(
        metrics: Arc<UpnpPacingMetrics>,
        is_metadata: bool,
        is_paused: Arc<AtomicBool>,
    ) -> Self {
        if !is_metadata {
            metrics.record_state(PacingState::Unpaced, RateRegime::Unpaced, 0.0, false);
        }
        Self {
            config: PacerConfig::default(),
            realtime_rate: None,
            state: PacingState::Unpaced,
            preroll: 0,
            sent: 0,
            last_chunk_bytes: stream_tuning::CHUNK_BYTES,
            steady_sndbuf: stream_tuning::MIN_SOCKET_SNDBUF_BYTES,
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
            uncertain_margin_bytes: (stream_tuning::CHUNK_BYTES as u64) * 2,
            uncertain_slow_at: None,
            uncertain_slow_cluster: 0,
            clean_fast_streak: 0,
            effective_target_lead_ms: 0,
            last_target_clamp_at: None,
            is_recovering: false,
            congestion_holdoff_until: None,
            flow_suppressed_until: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn with_config(
        config: PacerConfig,
        realtime_bytes_per_sec: Option<f64>,
        preroll_bytes: u64,
        sndbuf_bytes: usize,
        is_contiguous_reconnect: bool,
        is_range_continuation: bool,
        is_metadata: bool,
        metrics: Arc<UpnpPacingMetrics>,
        is_paused: Arc<AtomicBool>,
    ) -> Self {
        if is_metadata {
            return Self::unpaced(metrics, true, is_paused);
        }

        let Some(realtime) = realtime_bytes_per_sec else {
            return Self::unpaced(metrics, false, is_paused);
        };

        metrics.audio_connections.fetch_add(1, Ordering::Relaxed);
        metrics
            .configured_sndbuf_bytes
            .store(sndbuf_bytes as u64, Ordering::Relaxed);
        metrics
            .realtime_bytes_per_sec
            .store(realtime.round().max(0.0) as u64, Ordering::Relaxed);

        let now = Instant::now();
        let initial_target = config.initial_lead_target_ms;
        metrics
            .effective_target_lead_ms
            .store(initial_target, Ordering::Relaxed);

        // Preserve existing socket-buffer clamping contract for >=1 MB Range requests,
        // while keeping state transitions clean: contiguous reconnects enter SteadyMaintain;
        // fresh starts and discontinuous seeks begin in InitialFill.
        let (initial_state, initial_regime, initial_mult, seed_horizon_bytes, horizon_ready) =
            if is_contiguous_reconnect {
                let seed_lead = (initial_target as f64 / 1000.0) * realtime;
                (
                    PacingState::SteadyMaintain,
                    RateRegime::Cruise,
                    1.0,
                    -seed_lead,
                    true,
                )
            } else {
                (
                    PacingState::InitialFill,
                    RateRegime::InitialFill,
                    stream_tuning::RAMP_UP_MULTIPLIER,
                    0.0,
                    is_range_continuation,
                )
            };

        let pacer = Self {
            config,
            realtime_rate: Some(realtime),
            state: initial_state,
            preroll: if is_range_continuation { 0 } else { preroll_bytes },
            sent: 0,
            last_chunk_bytes: stream_tuning::CHUNK_BYTES,
            steady_sndbuf: sndbuf_bytes,
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
            uncertain_margin_bytes: (stream_tuning::CHUNK_BYTES as u64) * 2,
            uncertain_slow_at: None,
            uncertain_slow_cluster: 0,
            clean_fast_streak: 0,
            effective_target_lead_ms: initial_target,
            last_target_clamp_at: None,
            is_recovering: false,
            congestion_holdoff_until: None,
            flow_suppressed_until: None,
        };
        pacer
            .metrics
            .record_state(initial_state, initial_regime, initial_mult, false);
        pacer
    }

    pub(crate) fn on_chunk_sent(
        &mut self,
        stream: &mut StdTcpStream,
        n: usize,
        write_block_dur: Duration,
    ) {
        self.sent += n as u64;
        self.last_chunk_bytes = n.max(1);
        if !self.is_metadata {
            self.metrics.chunks_sent.fetch_add(1, Ordering::Relaxed);
            self.metrics.bytes_sent.fetch_add(n as u64, Ordering::Relaxed);
        }

        if self.realtime_rate.is_none() || self.state == PacingState::Unpaced {
            return;
        }

        // Phase 1: Fast-start pre-roll burst (unchanged <= MAX_PREROLL_BYTES = 512 KB).
        if self.sent <= self.preroll {
            if !self.is_metadata {
                self.metrics.preroll_chunks.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }

        // Phase 2: Transition boundary (down-clamp SO_SNDBUF to 32 KB ceiling cleanly).
        if !self.clamped_to_steady {
            let sock = socket2::SockRef::from(&*stream);
            let _ = sock.set_send_buffer_size(self.steady_sndbuf);
            if !self.is_metadata {
                if let Ok(actual) = sock.send_buffer_size() {
                    self.metrics
                        .actual_sndbuf_bytes
                        .store(actual as u64, Ordering::Relaxed);
                }
            }
            self.clamped_to_steady = true;
            let now = Instant::now();
            self.horizon_bytes = 0.0;
            self.last_horizon_tick = Some(now);
            self.next_chunk_due = Some(now);
            self.horizon_initialized = true;
            return;
        }

        let now = Instant::now();
        let paused = self.is_paused.load(Ordering::Acquire);
        let sample = if self.should_probe_tcp_info(now, write_block_dur) {
            self.last_probe_attempt_at = Some(now);
            query_tcp_info(stream)
        } else {
            None
        };

        let sleep_dur = self.advance_pacing_with_sample(now, write_block_dur, paused, sample);
        if paused {
            let mut ticks: u32 = 0;
            while self.is_paused.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(25));
                ticks = ticks.saturating_add(1);
                if ticks % 10 == 0 && !is_tcp_established(stream) {
                    break;
                }
            }
            let resumed_at = Instant::now();
            self.last_horizon_tick = Some(resumed_at);
            self.next_chunk_due = Some(resumed_at);
            return;
        }
        if let Some(dur) = sleep_dur {
            std::thread::sleep(dur);
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

    /// Evaluates one chunk completion at `now` with optional `TcpSocketSample`.
    /// Separated from Winsock / `thread::sleep` calls for deterministic unit testing.
    pub(crate) fn advance_pacing_with_sample(
        &mut self,
        now: Instant,
        write_block_dur: Duration,
        paused: bool,
        new_sample: Option<TcpSocketSample>,
    ) -> Option<Duration> {
        let realtime = self.realtime_rate?;
        if self.state == PacingState::Unpaced {
            return None;
        }

        if !self.horizon_initialized {
            self.last_horizon_tick = Some(now);
            self.next_chunk_due = Some(now);
            self.horizon_initialized = true;
        }

        // 1. Update TCP_INFO cache + compute deltas when a fresh snapshot arrives.
        let mut deltas = TcpSampleDeltas::default();
        let mut just_measured = false;
        if let Some(curr) = new_sample {
            deltas = TcpSampleDeltas::between(curr, self.last_tcp_sample);
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

        // 2. Advance real-time 1.000x playback horizon (never frozen by ZeroWindow alone!).
        let prev_tick = *self.last_horizon_tick.get_or_insert(now);
        self.last_horizon_tick = Some(now);
        if !paused {
            let dt = now.saturating_duration_since(prev_tick);
            self.horizon_bytes += dt.as_secs_f64() * realtime;
        } else {
            self.next_chunk_due = Some(now);
        }

        // 3. Determine stall thresholds & update fallback uncertainty width.
        let stall_thresh = Duration::from_millis(self.config.stall_threshold_ms);
        let fast_thresh = Duration::from_millis(self.config.fast_write_ms);
        let prev_due = *self.next_chunk_due.get_or_insert(now);
        let schedule_lag = now.saturating_duration_since(prev_due);
        let is_write_stall = write_block_dur > stall_thresh;
        let is_schedule_lag = schedule_lag > stall_thresh;

        if !self.is_metadata {
            let wb_us = write_block_dur.as_micros().min(u64::MAX as u128) as u64;
            let sl_us = schedule_lag.as_micros().min(u64::MAX as u128) as u64;
            self.metrics.total_write_block_us.fetch_add(wb_us, Ordering::Relaxed);
            self.metrics.max_write_block_us.fetch_max(wb_us, Ordering::Relaxed);
            self.metrics.total_schedule_lag_us.fetch_add(sl_us, Ordering::Relaxed);
            self.metrics.max_schedule_lag_us.fetch_max(sl_us, Ordering::Relaxed);
            if is_write_stall {
                self.metrics.write_block_stalls.fetch_add(1, Ordering::Relaxed);
            } else if is_schedule_lag && write_block_dur <= fast_thresh {
                self.metrics.schedule_lag_stalls.fetch_add(1, Ordering::Relaxed);
            }
        }

        let certainty = self.delivery_certainty(now);
        self.update_uncertainty_interval(
            now,
            realtime,
            certainty,
            write_block_dur,
            is_write_stall,
            fast_thresh,
        );

        // 4. Compute delivered bounds + enforce D_max backlog horizon clamp.
        let (optimistic_bytes, pessimistic_bytes, margin_bytes) =
            self.compute_delivered_bounds(realtime, certainty);
        let max_debt_bytes = (self.config.max_debt_ms as f64 / 1000.0) * realtime;
        if self.horizon_bytes > pessimistic_bytes as f64 + max_debt_bytes {
            self.horizon_bytes = pessimistic_bytes as f64 + max_debt_bytes;
        }

        let bytes_to_ms = |b_diff: f64| -> i64 { ((b_diff / realtime) * 1000.0).round() as i64 };
        let lead_lower_ms = bytes_to_ms(pessimistic_bytes as f64 - self.horizon_bytes);
        let lead_upper_ms = bytes_to_ms(optimistic_bytes as f64 - self.horizon_bytes);
        let display_lead_ms = match certainty {
            DeliveryCertainty::Measured => lead_lower_ms,
            DeliveryCertainty::Uncertain => lead_upper_ms,
        };
        let margin_ms = ((margin_bytes as f64 / realtime) * 1000.0).round().max(0.0) as u64;

        // 5. Classify event & apply flow-control / congestion guards cleanly.
        let cause = self.classify_event(
            now,
            write_block_dur,
            is_write_stall,
            is_schedule_lag,
            fast_thresh,
            certainty,
            just_measured,
            deltas,
        );
        self.apply_cause_reaction(now, certainty, cause, display_lead_ms);

        // 6. State transition + target multiplier selection.
        let (multiplier, regime) = self.select_rate_and_transition(
            now,
            certainty,
            lead_lower_ms,
            lead_upper_ms,
            paused,
        );

        if !self.is_metadata {
            self.metrics.lead_certainty.store(
                u8::from(certainty == DeliveryCertainty::Measured),
                Ordering::Relaxed,
            );
            self.metrics
                .estimated_lead_ms
                .store(display_lead_ms, Ordering::Relaxed);
            self.metrics
                .uncertain_margin_ms
                .store(margin_ms, Ordering::Relaxed);
            self.metrics
                .effective_target_lead_ms
                .store(self.effective_target_lead_ms, Ordering::Relaxed);
            self.metrics.record_state(self.state, regime, multiplier, false);
        }

        // 7. Compute non-bursty virtual sleep deadline.
        // Only the stalled/lagged chunk itself skips sleep (re-anchoring `next_chunk_due`
        // to `now` so a missed wakeup never triggers an unpaced catch-up burst); subsequent
        // clean chunks during `flow_suppressed` / `congestion_holdoff` stay paced at 1.000x.
        if paused {
            return None;
        }
        if is_write_stall || (is_schedule_lag && write_block_dur <= fast_thresh) {
            self.next_chunk_due = Some(now);
            return None;
        }

        let effective_rate = (realtime * multiplier).max(stream_tuning::MIN_PACE_BYTES_PER_SEC);
        let chunk_dur = Duration::from_secs_f64(self.last_chunk_bytes as f64 / effective_rate);
        let max_phase_slip = Duration::from_secs_f64(
            (stream_tuning::CHUNK_BYTES.saturating_mul(2)) as f64 / realtime,
        )
        .min(Duration::from_millis(12));
        let floor_due = now.checked_sub(max_phase_slip).unwrap_or(now);
        let target_due = (prev_due + chunk_dur).max(floor_due);
        self.next_chunk_due = Some(target_due);
        target_due.checked_duration_since(now)
    }

    fn delivery_certainty(&self, now: Instant) -> DeliveryCertainty {
        match (self.last_tcp_sample, self.last_tcp_sample_at) {
            (Some(_), Some(at))
                if now.saturating_duration_since(at)
                    <= Duration::from_millis(self.config.tcp_info_stale_ms) =>
            {
                DeliveryCertainty::Measured
            }
            _ => DeliveryCertainty::Uncertain,
        }
    }

    fn update_uncertainty_interval(
        &mut self,
        now: Instant,
        realtime: f64,
        certainty: DeliveryCertainty,
        write_block_dur: Duration,
        is_write_stall: bool,
        fast_thresh: Duration,
    ) {
        if certainty == DeliveryCertainty::Measured {
            // Fresh TCP_INFO telemetry proves whether RWIN is open or congested;
            // never let Measured congestion/stalls trip the Uncertain slow-cluster fallback.
            self.uncertain_slow_cluster = 0;
            self.uncertain_slow_at = None;
            return;
        }

        let base_floor = (stream_tuning::CHUNK_BYTES as u64).saturating_mul(2);
        let max_margin = ((self.config.uncertain_max_margin_ms as f64 / 1000.0) * realtime)
            .round()
            .max(base_floor as f64) as u64;

        if is_write_stall || write_block_dur > fast_thresh {
            self.clean_fast_streak = 0;
            let step = (stream_tuning::CHUNK_BYTES as u64).max(
                ((write_block_dur.as_secs_f64() * realtime) * 0.5).round() as u64,
            );
            self.uncertain_margin_bytes =
                self.uncertain_margin_bytes.saturating_add(step).min(max_margin);

            if is_write_stall {
                let clustered = self
                    .uncertain_slow_at
                    .is_some_and(|t| now.saturating_duration_since(t) <= Duration::from_secs(2));
                self.uncertain_slow_cluster = if clustered {
                    self.uncertain_slow_cluster.saturating_add(1)
                } else {
                    1
                };
                self.uncertain_slow_at = Some(now);
            }
        } else {
            self.clean_fast_streak = self.clean_fast_streak.saturating_add(1);
            if self.clean_fast_streak >= 4 {
                let decay = (stream_tuning::CHUNK_BYTES as u64) / 2;
                self.uncertain_margin_bytes =
                    self.uncertain_margin_bytes.saturating_sub(decay).max(base_floor);
            }
            if self
                .uncertain_slow_at
                .is_some_and(|t| now.saturating_duration_since(t) > Duration::from_secs(2))
            {
                self.uncertain_slow_cluster = 0;
            }
        }
    }

    fn compute_delivered_bounds(
        &self,
        realtime: f64,
        certainty: DeliveryCertainty,
    ) -> (u64, u64, u64) {
        match certainty {
            DeliveryCertainty::Measured => {
                let inflight = self
                    .last_tcp_sample
                    .map(|s| s.bytes_in_flight as u64)
                    .unwrap_or(0);
                // Bounds unACKed airlink exposure + kernel SO_SNDBUF ceiling cleanly.
                let unacked_bound = inflight.saturating_add(self.steady_sndbuf as u64);
                let lb = self.sent.saturating_sub(unacked_bound);
                (lb, lb, unacked_bound.min(self.sent))
            }
            DeliveryCertainty::Uncertain => {
                // Explicitly avoid claiming `accepted - SO_SNDBUF` equals ACKed delivery:
                // track explicit `[pessimistic, optimistic]` interval widening on slow writes.
                let max_margin = ((self.config.uncertain_max_margin_ms as f64 / 1000.0) * realtime)
                    .round()
                    .max((stream_tuning::CHUNK_BYTES as u64 * 2) as f64)
                    as u64;
                let margin = self.uncertain_margin_bytes.min(max_margin).min(self.sent);
                let pessimistic = self.sent.saturating_sub(margin);
                (self.sent, pessimistic, margin)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn classify_event(
        &self,
        now: Instant,
        write_block_dur: Duration,
        is_write_stall: bool,
        is_schedule_lag: bool,
        fast_thresh: Duration,
        certainty: DeliveryCertainty,
        just_measured: bool,
        deltas: TcpSampleDeltas,
    ) -> StallCause {
        if let (DeliveryCertainty::Measured, Some(sample)) = (certainty, self.last_tcp_sample) {
            if just_measured && self.is_receiver_flow_control(sample, deltas) {
                return StallCause::ReceiverFlowControl;
            }
        }

        if is_write_stall {
            if certainty == DeliveryCertainty::Measured {
                if let Some(sample) = self.last_tcp_sample {
                    if self.is_link_congestion(sample, deltas)
                        || (!just_measured
                            && self.congestion_holdoff_until.is_some_and(|t| now < t))
                    {
                        return StallCause::LinkCongestion;
                    }
                }
            }
            return StallCause::AmbiguousWriteStall;
        }

        if is_schedule_lag && write_block_dur <= fast_thresh {
            return StallCause::LocalScheduleLag;
        }

        StallCause::None
    }

    fn is_receiver_flow_control(&self, sample: TcpSocketSample, deltas: TcpSampleDeltas) -> bool {
        let low_wnd_floor = (self.steady_sndbuf as u32).saturating_mul(2); // 64 KB
        let collapsed_from_baseline = self.baseline_open_snd_wnd >= 256 * 1024
            && sample.snd_wnd <= self.baseline_open_snd_wnd / 4
            && sample.snd_wnd <= 128 * 1024;
        let rwin_limited = deltas.rwin_lim > 0 && deltas.bytes_retrans == 0 && deltas.cwnd_lim == 0;
        sample.snd_wnd <= low_wnd_floor || collapsed_from_baseline || rwin_limited
    }

    fn is_link_congestion(&self, sample: TcpSocketSample, deltas: TcpSampleDeltas) -> bool {
        let loss_or_dup = deltas.bytes_retrans > 0
            || deltas.fast_retrans > 0
            || deltas.dup_acks > 0
            || deltas.timeouts > 0
            || deltas.cwnd_lim > 0;
        let rtt_threshold = sample
            .min_rtt_us
            .saturating_mul(4)
            .max((self.config.stall_threshold_ms as u32).saturating_mul(1000));
        let rtt_cwnd_pressure = sample.rtt_us > rtt_threshold
            && sample.cwnd > 0
            && sample.bytes_in_flight.saturating_mul(4) >= sample.cwnd.saturating_mul(3);
        loss_or_dup || rtt_cwnd_pressure
    }

    fn apply_cause_reaction(
        &mut self,
        now: Instant,
        certainty: DeliveryCertainty,
        cause: StallCause,
        lead_ms: i64,
    ) {
        match cause {
            StallCause::ReceiverFlowControl => {
                self.is_recovering = false;
                self.flow_suppressed_until =
                    Some(now + Duration::from_millis(self.config.flow_clear_ms));
                self.clamp_target_downward(now, lead_ms);
                if !self.is_metadata {
                    self.metrics
                        .flow_control_events
                        .fetch_add(1, Ordering::Relaxed);
                }
                diag_log!(
                    DiagCategory::UpnpLifecycle,
                    0,
                    0,
                    0,
                    "upnp_pacer_flow_control",
                    "lead_ms={} target_ms={} snd_wnd={}",
                    lead_ms,
                    self.effective_target_lead_ms,
                    self.last_tcp_sample.map(|s| s.snd_wnd).unwrap_or(0)
                );
            }
            StallCause::LinkCongestion => {
                self.is_recovering = false;
                self.congestion_holdoff_until =
                    Some(now + Duration::from_millis(self.config.congestion_holdoff_ms));
                if !self.is_metadata {
                    self.metrics
                        .congestion_events
                        .fetch_add(1, Ordering::Relaxed);
                }
                diag_log!(
                    DiagCategory::UpnpLifecycle,
                    0,
                    0,
                    0,
                    "upnp_pacer_link_congestion",
                    "lead_ms={} rtt_us={} retrans={}",
                    lead_ms,
                    self.last_tcp_sample.map(|s| s.rtt_us).unwrap_or(0),
                    self.last_tcp_sample.map(|s| s.bytes_retrans).unwrap_or(0)
                );
            }
            StallCause::AmbiguousWriteStall => {
                self.is_recovering = false;
                self.congestion_holdoff_until =
                    Some(now + Duration::from_millis(self.config.congestion_holdoff_ms));
                if !self.is_metadata {
                    self.metrics
                        .ambiguous_stall_events
                        .fetch_add(1, Ordering::Relaxed);
                }
                // Engage flow-suppressed target clamping strictly when delivery bounds are Uncertain;
                // when TCP_INFO is Measured and SndWnd remains open, keep holdoff at 1.000x without
                // corrupting `effective_target_lead_ms`.
                if certainty == DeliveryCertainty::Uncertain && self.uncertain_slow_cluster >= 3 {
                    self.flow_suppressed_until =
                        Some(now + Duration::from_millis(self.config.flow_clear_ms));
                    self.clamp_target_downward(now, lead_ms);
                }
                diag_log!(
                    DiagCategory::UpnpLifecycle,
                    0,
                    0,
                    0,
                    "upnp_pacer_ambiguous_stall",
                    "lead_ms={} cluster={} target_ms={}",
                    lead_ms,
                    self.uncertain_slow_cluster,
                    self.effective_target_lead_ms
                );
            }
            StallCause::LocalScheduleLag | StallCause::None => {}
        }
    }

    fn clamp_target_downward(&mut self, now: Instant, observed_lead_ms: i64) {
        let allow_clamp = self.last_target_clamp_at.is_none_or(|t| {
            now.saturating_duration_since(t)
                >= Duration::from_millis(self.config.target_clamp_cooldown_ms)
        });
        if !allow_clamp {
            return;
        }
        self.last_target_clamp_at = Some(now);
        let scaled = if observed_lead_ms > 0 {
            ((observed_lead_ms as f64) * 0.85).round() as u64
        } else {
            self.config.min_safe_target_ms
        };
        let next_target = scaled
            .min(self.effective_target_lead_ms)
            .max(self.config.min_safe_target_ms);
        if next_target < self.effective_target_lead_ms {
            self.effective_target_lead_ms = next_target;
        }
    }

    fn select_rate_and_transition(
        &mut self,
        now: Instant,
        certainty: DeliveryCertainty,
        lead_lower_ms: i64,
        lead_upper_ms: i64,
        paused: bool,
    ) -> (f64, RateRegime) {
        if paused {
            return (1.0, RateRegime::Cruise);
        }

        let flow_active = self.flow_suppressed_until.is_some_and(|t| now < t);
        let holdoff_active = self.congestion_holdoff_until.is_some_and(|t| now < t);
        let target_ms = self.effective_target_lead_ms as i64;
        let low_ms = (target_ms - self.config.band_half_width_ms)
            .max(self.config.min_safe_target_ms as i64 / 2);
        let high_ms = target_ms + self.config.band_half_width_ms;
        let max_ms = high_ms + self.config.trim_margin_ms;

        match self.state {
            PacingState::Unpaced => (0.0, RateRegime::Unpaced),
            PacingState::InitialFill => {
                // In Uncertain mode, require optimistic lead to reach target AND fast drain before exit.
                let reached_target = match certainty {
                    DeliveryCertainty::Measured => lead_lower_ms >= target_ms,
                    DeliveryCertainty::Uncertain => {
                        lead_upper_ms >= target_ms && self.clean_fast_streak >= 2
                    }
                };
                if flow_active || reached_target {
                    self.state = PacingState::SteadyMaintain;
                    self.next_chunk_due = Some(now);
                    if !self.is_metadata {
                        self.metrics.state_transitions.fetch_add(1, Ordering::Relaxed);
                    }
                    diag_log!(
                        DiagCategory::UpnpLifecycle,
                        0,
                        0,
                        0,
                        "upnp_pacer_state_change",
                        "from=initial_fill to=steady_maintain lead_ms={} certainty={} flow={}",
                        lead_upper_ms,
                        certainty.as_str(),
                        flow_active
                    );
                    if flow_active {
                        return (1.0, RateRegime::FlowSuppressed);
                    }
                    return (1.0, RateRegime::Cruise);
                }

                if holdoff_active {
                    (1.0, RateRegime::CongestionHoldoff)
                } else {
                    (stream_tuning::RAMP_UP_MULTIPLIER, RateRegime::InitialFill)
                }
            }
            PacingState::SteadyMaintain => {
                if flow_active {
                    self.is_recovering = false;
                    return (1.0, RateRegime::FlowSuppressed);
                }
                if holdoff_active {
                    self.is_recovering = false;
                    return (1.0, RateRegime::CongestionHoldoff);
                }

                // Upper trim guard: prevent persistent overfeeding past `L_max`.
                if lead_upper_ms > max_ms && (certainty == DeliveryCertainty::Uncertain || lead_lower_ms > max_ms) {
                    self.is_recovering = false;
                    return (self.config.trim_multiplier, RateRegime::Trim);
                }

                // Hysteresis gate around target lead with lead-gated bounded recovery:
                // Under `Uncertain`, engage recovery only when even optimistic `lead_upper_ms < low_ms`
                // and fast drains confirm clear socket acceptance, stopping at `target_ms`.
                let active_lead_ms = match certainty {
                    DeliveryCertainty::Measured => lead_lower_ms,
                    DeliveryCertainty::Uncertain => lead_upper_ms,
                };
                let (trigger_recovery, exit_recovery) = match certainty {
                    DeliveryCertainty::Measured => (
                        lead_lower_ms < low_ms,
                        lead_lower_ms >= high_ms,
                    ),
                    DeliveryCertainty::Uncertain => (
                        lead_upper_ms < low_ms && self.clean_fast_streak >= 2,
                        lead_upper_ms >= target_ms,
                    ),
                };

                if self.is_recovering && exit_recovery {
                    self.is_recovering = false;
                } else if !self.is_recovering && trigger_recovery {
                    self.is_recovering = true;
                }

                if self.is_recovering {
                    let mult = self.recovery_rate_for_lead(target_ms, active_lead_ms);
                    (mult, RateRegime::Recovering)
                } else {
                    (1.0, RateRegime::Cruise)
                }
            }
        }
    }

    /// Selects bounded recovery pace scaled by remaining headroom (`1.020x` shallow,
    /// `1.050x` moderate, `1.080x` deep deficit) while scaling thresholds cleanly if
    /// flow control clamped `effective_target_lead_ms`.
    fn recovery_rate_for_lead(&self, target_ms: i64, active_lead_ms: i64) -> f64 {
        let moderate_thresh = (target_ms - 400)
            .max(0)
            .min(self.config.moderate_recovery_lead_ms);
        let deficit_thresh = (target_ms - 800)
            .max(0)
            .min(self.config.deficit_recovery_lead_ms)
            .min(moderate_thresh);

        if active_lead_ms < deficit_thresh {
            self.config.deficit_recovery_multiplier
        } else if active_lead_ms < moderate_thresh {
            self.config.moderate_recovery_multiplier
        } else {
            self.config.recovery_multiplier
        }
    }
}

#[cfg(windows)]
fn ioctl_tcp_info<T>(sock: usize, version: u32) -> Option<T> {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Networking::WinSock::{WSAIoctl, SIO_TCP_INFO, SOCKET_ERROR};

    let mut out: T = unsafe { zeroed() };
    let mut returned: u32 = 0;
    let rc = unsafe {
        WSAIoctl(
            sock,
            SIO_TCP_INFO,
            (&raw const version) as *const c_void,
            size_of::<u32>() as u32,
            (&raw mut out) as *mut c_void,
            size_of::<T>() as u32,
            &raw mut returned,
            std::ptr::null_mut(),
            None,
        )
    };
    (rc != SOCKET_ERROR && returned as usize >= size_of::<T>()).then_some(out)
}

#[cfg(windows)]
fn query_tcp_info(stream: &StdTcpStream) -> Option<TcpSocketSample> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{TCP_INFO_v0, TCP_INFO_v1};

    let sock = stream.as_raw_socket() as usize;
    if let Some(info) = ioctl_tcp_info::<TCP_INFO_v1>(sock, 1) {
        return Some(TcpSocketSample {
            rtt_us: info.RttUs,
            min_rtt_us: info.MinRttUs,
            bytes_in_flight: info.BytesInFlight,
            cwnd: info.Cwnd,
            snd_wnd: info.SndWnd,
            bytes_retrans: info.BytesRetrans,
            fast_retrans: info.FastRetrans,
            dup_acks_in: info.DupAcksIn,
            timeout_episodes: info.TimeoutEpisodes,
            snd_lim_time_rwin: Some(info.SndLimTimeRwin),
            snd_lim_time_cwnd: Some(info.SndLimTimeCwnd),
        });
    }
    ioctl_tcp_info::<TCP_INFO_v0>(sock, 0).map(|info| TcpSocketSample {
        rtt_us: info.RttUs,
        min_rtt_us: info.MinRttUs,
        bytes_in_flight: info.BytesInFlight,
        cwnd: info.Cwnd,
        snd_wnd: info.SndWnd,
        bytes_retrans: info.BytesRetrans,
        fast_retrans: info.FastRetrans,
        dup_acks_in: info.DupAcksIn,
        timeout_episodes: info.TimeoutEpisodes,
        snd_lim_time_rwin: None,
        snd_lim_time_cwnd: None,
    })
}

#[cfg(not(windows))]
fn query_tcp_info(_stream: &StdTcpStream) -> Option<TcpSocketSample> {
    None
}

#[cfg(windows)]
fn is_tcp_established(stream: &StdTcpStream) -> bool {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{TCPSTATE_ESTABLISHED, TCP_INFO_v0};

    let sock = stream.as_raw_socket() as usize;
    ioctl_tcp_info::<TCP_INFO_v0>(sock, 0)
        .map(|info| info.State == TCPSTATE_ESTABLISHED)
        .unwrap_or(true)
}

#[cfg(not(windows))]
fn is_tcp_established(_stream: &StdTcpStream) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSD256_BPS: f64 = 2_822_400.0;

    fn sample(snd_wnd: u32, rtt_us: u32, retrans: u32, inflight: u32) -> TcpSocketSample {
        TcpSocketSample {
            rtt_us,
            min_rtt_us: 2_500,
            bytes_in_flight: inflight,
            cwnd: 65_536,
            snd_wnd,
            bytes_retrans: retrans,
            fast_retrans: 0,
            dup_acks_in: 0,
            timeout_episodes: 0,
            snd_lim_time_rwin: Some(0),
            snd_lim_time_cwnd: Some(0),
        }
    }

    fn make_pacer(now: Instant) -> SynchronousPacer {
        let metrics = Arc::new(UpnpPacingMetrics::default());
        let paused = Arc::new(AtomicBool::new(false));
        let mut p = SynchronousPacer::with_config(
            PacerConfig::default(),
            Some(DSD256_BPS),
            0,
            stream_tuning::MAX_SOCKET_SNDBUF_BYTES,
            false,
            false,
            false,
            metrics,
            paused,
        );
        p.clamped_to_steady = true;
        p.horizon_initialized = true;
        p.last_horizon_tick = Some(now);
        p.next_chunk_due = Some(now);
        p
    }

    #[test]
    fn test_steady_state_matches_1x_without_excess_accumulation() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        // Simulate completing InitialFill to ~1210ms lead with open RWIN
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.210 * DSD256_BPS) as u64 + 32_768 + 8_192;

        let sleep = p.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 8_192)),
        );
        assert!(sleep.is_some());
        let snap = p.metrics.snapshot();
        assert_eq!(snap.current_state, "steady_maintain");
        assert_eq!(snap.current_regime, "cruise");
        assert_eq!(snap.lead_certainty, "measured");
        assert!((snap.current_multiplier - 1.000).abs() < 1e-6);

        // If excess lead grows above L_max (1400ms), controller trims gently below 1.000x
        p.sent += (0.300 * DSD256_BPS) as u64;
        let _ = p.advance_pacing_with_sample(
            t0 + Duration::from_millis(1),
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 8_192)),
        );
        let snap2 = p.metrics.snapshot();
        assert_eq!(snap2.current_regime, "trim");
        assert!((snap2.current_multiplier - 0.995).abs() < 1e-6);
    }

    #[test]
    fn test_wifi_congestion_does_not_lock_below_recovery_or_invert() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.200 * DSD256_BPS) as u64 + 32_768;

        // Baseline TCP_INFO sample
        let _ = p.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 0)),
        );

        // 220ms Wi-Fi stall with SndWnd still wide open (549 KB) and retransmissions rising
        let t1 = t0 + Duration::from_millis(220);
        p.sent += stream_tuning::CHUNK_BYTES as u64;
        let s1 = p.advance_pacing_with_sample(
            t1,
            Duration::from_millis(45),
            false,
            Some(sample(549_632, 85_000, 4_380, 32_768)),
        );
        assert!(s1.is_none());
        let snap1 = p.metrics.snapshot();
        assert_eq!(snap1.current_regime, "congestion_holdoff");
        assert_eq!(snap1.congestion_events, 1);
        assert_eq!(snap1.flow_control_events, 0);
        assert!(snap1.estimated_lead_ms < 1100, "lost headroom recorded cleanly");

        // After brief holdoff expires (100ms) and writes are fast/clean, shallow 1.020x recovery engages
        let t2 = t1 + Duration::from_millis(150);
        let _ = p.advance_pacing_with_sample(
            t2,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_200, 4_380, 4_096)),
        );
        let snap2 = p.metrics.snapshot();
        assert_eq!(snap2.current_regime, "recovering");
        assert!((snap2.current_multiplier - 1.020).abs() < 1e-6);
    }

    #[test]
    fn test_receiver_flow_control_suppresses_boost_and_keeps_clock_running_on_zerowindow() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.200 * DSD256_BPS) as u64 + 32_768;

        let _ = p.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 0)),
        );

        // Receiver shrinks SndWnd to 0 (TCP ZeroWindow) while NOT paused!
        let t1 = t0 + Duration::from_millis(300);
        let h_before = p.horizon_bytes;
        let s1 = p.advance_pacing_with_sample(
            t1,
            Duration::from_millis(35),
            false,
            Some(sample(0, 3_000, 0, 16_384)),
        );
        assert!(s1.is_none());
        let snap = p.metrics.snapshot();
        assert_eq!(snap.current_regime, "flow_suppressed");
        assert_eq!(snap.flow_control_events, 1);
        assert!(snap.effective_target_lead_ms < 1200);
        // CRITICAL: consumption clock must keep advancing during ZeroWindow when not explicitly paused
        assert!(p.horizon_bytes > h_before);
    }

    #[test]
    fn test_explicit_pause_freezes_horizon_while_debt_remains_bounded() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.200 * DSD256_BPS) as u64;

        let h0 = p.horizon_bytes;
        // 10 seconds while paused must NOT advance consumption horizon
        let t1 = t0 + Duration::from_secs(10);
        let _ = p.advance_pacing_with_sample(t1, Duration::from_micros(100), true, None);
        assert!((p.horizon_bytes - h0).abs() < 1e-6);

        // While actively playing across a 10s outage, debt is hard-capped at D_max (3000ms)
        let t2 = t1 + Duration::from_secs(10);
        let _ = p.advance_pacing_with_sample(t2, Duration::from_millis(500), false, None);
        let snap = p.metrics.snapshot();
        assert!(
            snap.estimated_lead_ms >= -p.config.max_debt_ms - 5,
            "deficit must stay bounded by D_max, got {}",
            snap.estimated_lead_ms
        );
    }

    #[test]
    fn test_uncertain_fallback_does_not_claim_measured_and_caps_slow_clusters() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.150 * DSD256_BPS) as u64;

        // With TCP_INFO unavailable (`None`), certainty is explicitly Uncertain
        let _ = p.advance_pacing_with_sample(t0, Duration::from_millis(30), false, None);
        let snap1 = p.metrics.snapshot();
        assert_eq!(snap1.lead_certainty, "uncertain");
        assert_eq!(snap1.ambiguous_stall_events, 1);
        assert_eq!(snap1.current_regime, "congestion_holdoff");

        // 3 clustered slow writes within 2s engage conservative flow-suppressed fallback
        let _ = p.advance_pacing_with_sample(t0 + Duration::from_millis(200), Duration::from_millis(30), false, None);
        let _ = p.advance_pacing_with_sample(t0 + Duration::from_millis(400), Duration::from_millis(30), false, None);
        let snap3 = p.metrics.snapshot();
        assert_eq!(snap3.current_regime, "flow_suppressed");
        assert!(snap3.uncertain_margin_ms <= p.config.uncertain_max_margin_ms);
    }

    #[test]
    fn test_initial_fill_resilient_to_isolated_congestion_and_stops_at_target() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.sent = 200_000;
        let _ = p.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 0)),
        );
        assert_eq!(p.state, PacingState::InitialFill);

        // Isolated Wi-Fi retry stall in InitialFill pauses briefly cleanly without aborting fill!
        let t1 = t0 + Duration::from_millis(50);
        p.sent += 16_384;
        let _ = p.advance_pacing_with_sample(
            t1,
            Duration::from_millis(32),
            false,
            Some(sample(549_632, 55_000, 2_920, 16_384)),
        );
        assert_eq!(p.state, PacingState::InitialFill);
        assert_eq!(p.metrics.snapshot().current_regime, "congestion_holdoff");

        // After holdoff clears, InitialFill completes smoothly once lead >= 1200ms -> SteadyMaintain
        let t2 = t1 + Duration::from_millis(600);
        p.sent = ((0.650 + 1.210) * DSD256_BPS) as u64 + 32_768 + 8_192;
        let _ = p.advance_pacing_with_sample(
            t2,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 2_920, 8_192)),
        );
        assert_eq!(p.state, PacingState::SteadyMaintain);
        assert_eq!(p.metrics.snapshot().current_regime, "cruise");
    }

    #[test]
    fn test_contiguous_reconnect_vs_discontinuous_seek_and_stale_degradation() {
        let t0 = Instant::now();
        let metrics = Arc::new(UpnpPacingMetrics::default());
        let paused = Arc::new(AtomicBool::new(false));

        // Contiguous reconnect enters SteadyMaintain directly with cruise rate
        let p_cont = SynchronousPacer::with_config(
            PacerConfig::default(),
            Some(DSD256_BPS),
            512 * 1024,
            stream_tuning::MAX_SOCKET_SNDBUF_BYTES,
            true,
            true,
            false,
            metrics.clone(),
            paused.clone(),
        );
        assert_eq!(p_cont.state, PacingState::SteadyMaintain);

        // Discontinuous seek (>= 1MB jump) resets into InitialFill (clamped 32KB SO_SNDBUF kept)
        let mut p_seek = SynchronousPacer::with_config(
            PacerConfig::default(),
            Some(DSD256_BPS),
            512 * 1024,
            stream_tuning::MAX_SOCKET_SNDBUF_BYTES,
            false,
            true,
            false,
            metrics,
            paused,
        );
        assert_eq!(p_seek.state, PacingState::InitialFill);

        // Measured snapshot ages out past 750ms -> degrades explicitly to Uncertain
        p_seek.state = PacingState::SteadyMaintain;
        p_seek.sent = (1.200 * DSD256_BPS) as u64;
        let _ = p_seek.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 8_192)),
        );
        assert_eq!(p_seek.metrics.snapshot().lead_certainty, "measured");

        let t_stale = t0 + Duration::from_millis(850);
        let _ = p_seek.advance_pacing_with_sample(t_stale, Duration::from_micros(200), false, None);
        assert_eq!(p_seek.metrics.snapshot().lead_certainty, "uncertain");
    }

    #[test]
    fn test_schedule_lag_does_not_suppress_or_trigger_flow_control() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.200 * DSD256_BPS) as u64 + 32_768;

        // Seed fresh TCP_INFO
        let _ = p.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(549_632, 3_000, 0, 0)),
        );

        // 45ms OS thread scheduling delay where Winsock write itself finished in 200us
        let t_lag = t0 + Duration::from_millis(45);
        p.sent += 16_384;
        let s = p.advance_pacing_with_sample(t_lag, Duration::from_micros(200), false, None);
        assert!(s.is_none(), "no catch-up sleep skip or burst needed; resets virtual due to now");
        let snap = p.metrics.snapshot();
        assert_eq!(snap.schedule_lag_stalls, 1);
        assert_eq!(snap.write_block_stalls, 0);
        assert_eq!(snap.flow_control_events, 0);
        assert_eq!(snap.congestion_events, 0);
    }

    #[test]
    fn test_measured_clustered_congestion_does_not_clamp_target_lead() {
        let t0 = Instant::now();
        let mut p = make_pacer(t0);
        p.state = PacingState::SteadyMaintain;
        p.sent = (1.350 * DSD256_BPS) as u64 + 32_768;

        // Baseline Measured sample with SndWnd wide open (~810 KB)
        let _ = p.advance_pacing_with_sample(
            t0,
            Duration::from_micros(200),
            false,
            Some(sample(810_880, 3_000, 0, 0)),
        );

        // 3 clustered stalls across 300ms while Measured & RWIN wide open:
        // (a) proven congestion (retrans delta > 0)
        // (b) follow-up slow write inside <50ms poll throttle (`None`, just_measured = false)
        // (c) another congestion / unexplained stall with RWIN still wide open
        let t1 = t0 + Duration::from_millis(100);
        let _ = p.advance_pacing_with_sample(
            t1,
            Duration::from_millis(40),
            false,
            Some(sample(810_880, 54_000, 2_920, 16_384)),
        );
        let t2 = t1 + Duration::from_millis(38);
        let _ = p.advance_pacing_with_sample(t2, Duration::from_millis(38), false, None);
        assert_eq!(p.metrics.snapshot().ambiguous_stall_events, 0);

        // Fresh low-RTT stalls with open SndWnd still must not trigger Uncertain flow suppression
        let t3 = t2 + Duration::from_millis(120);
        let _ = p.advance_pacing_with_sample(
            t3,
            Duration::from_millis(36),
            false,
            Some(sample(810_880, 18_000, 2_920, 8_192)),
        );
        let t4 = t3 + Duration::from_millis(120);
        let _ = p.advance_pacing_with_sample(
            t4,
            Duration::from_millis(36),
            false,
            Some(sample(810_880, 18_000, 2_920, 8_192)),
        );
        let t5 = t4 + Duration::from_millis(120);
        let _ = p.advance_pacing_with_sample(
            t5,
            Duration::from_millis(36),
            false,
            Some(sample(810_880, 18_000, 2_920, 8_192)),
        );

        let snap = p.metrics.snapshot();
        assert_eq!(snap.lead_certainty, "measured");
        assert_eq!(snap.effective_target_lead_ms, 1200);
        assert_eq!(snap.flow_control_events, 0);
        assert_eq!(snap.current_regime, "congestion_holdoff");
    }

    #[test]
    fn test_lead_gated_recovery_tiers_and_exit_to_cruise() {
        let mut t = Instant::now();
        let mut p = make_pacer(t);
        p.state = PacingState::SteadyMaintain;

        let step = |p: &mut SynchronousPacer, t_now: Instant, lead_ms: f64| {
            p.horizon_bytes = 0.0;
            p.last_horizon_tick = Some(t_now);
            p.sent = ((lead_ms / 1000.0) * DSD256_BPS) as u64 + 32_768 + 8_192;
            let _ = p.advance_pacing_with_sample(
                t_now,
                Duration::from_micros(200),
                false,
                Some(sample(549_632, 3_000, 0, 8_192)),
            );
            p.metrics.snapshot()
        };

        // Deep deficit (< 400ms) -> bounded 1.080x recovery
        t += Duration::from_millis(10);
        let s_deep = step(&mut p, t, 250.0);
        assert_eq!(s_deep.current_regime, "recovering");
        assert!((s_deep.current_multiplier - 1.080).abs() < 1e-6);

        // Moderate depletion (400..800ms) -> bounded 1.050x recovery
        t += Duration::from_millis(10);
        let s_mod = step(&mut p, t, 600.0);
        assert_eq!(s_mod.current_regime, "recovering");
        assert!((s_mod.current_multiplier - 1.050).abs() < 1e-6);

        // Shallow depletion (800..1300ms while recovering) -> gentle 1.020x top-off
        t += Duration::from_millis(10);
        let s_shallow = step(&mut p, t, 950.0);
        assert_eq!(s_shallow.current_regime, "recovering");
        assert!((s_shallow.current_multiplier - 1.020).abs() < 1e-6);

        // Hysteresis holds gentle 1.020x through 1200ms target up to L_high (1300ms)
        t += Duration::from_millis(10);
        let s_hyst = step(&mut p, t, 1200.0);
        assert_eq!(s_hyst.current_regime, "recovering");
        assert!((s_hyst.current_multiplier - 1.020).abs() < 1e-6);

        // Reaches L_high (1310ms) -> exits recovery cleanly to 1.000x cruise
        t += Duration::from_millis(10);
        let s_exit = step(&mut p, t, 1310.0);
        assert_eq!(s_exit.current_regime, "cruise");
        assert!((s_exit.current_multiplier - 1.000).abs() < 1e-6);

        // Stays in 1.000x cruise back across 1200ms target down to L_low (1100ms)
        t += Duration::from_millis(10);
        let s_cruise = step(&mut p, t, 1150.0);
        assert_eq!(s_cruise.current_regime, "cruise");
        assert!((s_cruise.current_multiplier - 1.000).abs() < 1e-6);
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_sio_tcp_info_nonblocking_on_loopback() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
        });

        let mut cli = StdTcpStream::connect(addr).unwrap();
        cli.write_all(&[0x5Au8; 1024]).unwrap();
        let t0 = Instant::now();
        let info = query_tcp_info(&cli);
        let elapsed = t0.elapsed();
        assert!(info.is_some(), "expected SIO_TCP_INFO to succeed on Windows socket");
        assert!(elapsed < Duration::from_millis(10), "SIO_TCP_INFO took {:?}", elapsed);
        drop(cli);
        let _ = srv.join();
    }
}
