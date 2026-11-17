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

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream as StdTcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    HeadlessConfig, HeadlessCoreRuntime, MemoryLocker, PlatformProbe, RuntimeError,
    SystemMemoryLocker, SystemPlatformProbe,
};
use crate::core_session::{
    ExternalPlaybackInfo, Renderer, RendererAction, RendererError, RendererEvent, RunToken,
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
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
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
    /// When true, steady-state locks to cruise/overfeed floor after cushion fill or backoff
    /// instead of periodically creeping back up toward `max_overfeed_multiplier`.
    pub lock_cruise_on_fill_or_backoff: bool,
    /// When true, any TCP retransmission increment (`retrans_delta > 0`, e.g., TLP probes)
    /// triggers flow backoff immediately without requiring a > `stall_threshold_ms` write block.
    pub retrans_only_backoff: bool,
    /// Optional percentage (1..=99) of `baseline_open_snd_wnd` below which steady-state
    /// triggers flow backoff even when RWIN stays above 128 KiB.
    pub relative_wnd_dip_pct: Option<u8>,
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
            lock_cruise_on_fill_or_backoff: false,
            retrans_only_backoff: false,
            relative_wnd_dip_pct: None,
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

pub const RENDERER_PROFILES_SCHEMA_VERSION: u32 = 1;
pub const RENDERER_PROFILES_FILENAME: &str = "renderer-profiles.json";

/// Matcher rules selecting a persisted pacing configuration for a UPnP renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RendererPacerMatch {
    /// Exact normalized UDN match (highest precedence, intended for per-unit stress-test learnings).
    pub udn: Option<String>,
    /// Case-insensitive tokens that must all appear in renderer identity text when non-empty.
    pub all_keywords: Vec<String>,
    /// Case-insensitive tokens where any match selects this profile when `all_keywords` is empty.
    pub any_keywords: Vec<String>,
}

impl RendererPacerMatch {
    fn matches_identity(&self, device: &Rs130DeviceDescriptor) -> bool {
        let combined = format!(
            "{} {} {} {}",
            device.friendly_name,
            device.model_name.as_deref().unwrap_or(""),
            device.model_description.as_deref().unwrap_or(""),
            device.manufacturer.as_deref().unwrap_or("")
        )
        .to_ascii_lowercase();

        if !self.all_keywords.is_empty() {
            return self
                .all_keywords
                .iter()
                .all(|kw| !kw.trim().is_empty() && combined.contains(&kw.to_ascii_lowercase()));
        }
        if !self.any_keywords.is_empty() {
            return self
                .any_keywords
                .iter()
                .any(|kw| !kw.trim().is_empty() && combined.contains(&kw.to_ascii_lowercase()));
        }
        false
    }
}

/// Named renderer pacing profile persisted in `renderer-profiles.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RendererPacerProfile {
    pub id: String,
    pub description: String,
    pub learned_from_stress_test: bool,
    pub matcher: RendererPacerMatch,
    pub pacer_config: CorePacerConfig,
}

impl Default for RendererPacerProfile {
    fn default() -> Self {
        Self {
            id: "custom".into(),
            description: String::new(),
            learned_from_stress_test: false,
            matcher: RendererPacerMatch::default(),
            pacer_config: CorePacerConfig::default(),
        }
    }
}

/// Persisted renderer pacing registry (`renderer-profiles.json`) supplying `CorePacerConfig`
/// per renderer without device-specific branches in the streaming loop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RendererPacerProfileFile {
    pub schema_version: u32,
    pub default_profile: CorePacerConfig,
    pub profiles: Vec<RendererPacerProfile>,
}

impl Default for RendererPacerProfileFile {
    fn default() -> Self {
        Self::built_in_defaults()
    }
}

/// Pre-characterized RS130 profile derived from TrueNAS -> HiFi ROSE RS130 DSD256/CD captures:
/// fills a ~1.2s playback cushion cleanly via InitialFill, then locks onto 1.000x cruise
/// before hitting RS130's ~2.14s (DSD256) / ~6.96s (CD) buffer wall, with TLP/RWIN dip safety nets.
pub fn rs130_default_pacer_config() -> CorePacerConfig {
    CorePacerConfig {
        initial_fill_multiplier: 1.180,
        initial_fill_lead_ms: 1_200,
        initial_overfeed_multiplier: 1.000,
        min_steady_multiplier: 1.000,
        max_overfeed_multiplier: 1.000,
        soft_ceiling_floor: 1.000,
        lock_cruise_on_fill_or_backoff: true,
        retrans_only_backoff: true,
        relative_wnd_dip_pct: Some(92),
        ..CorePacerConfig::default()
    }
}

fn normalize_udn(udn: &str) -> String {
    udn.trim()
        .strip_prefix("uuid:")
        .or_else(|| udn.trim().strip_prefix("UUID:"))
        .unwrap_or(udn.trim())
        .trim()
        .to_ascii_lowercase()
}

impl RendererPacerProfileFile {
    pub fn built_in_defaults() -> Self {
        Self {
            schema_version: RENDERER_PROFILES_SCHEMA_VERSION,
            default_profile: CorePacerConfig::default(),
            profiles: vec![RendererPacerProfile {
                id: "hifi-rose-rs130".into(),
                description: "HiFi ROSE RS130 (CITECH): ~1.2s cushion fill then 1.000x cruise lock with TLP/RWIN dip safety net".into(),
                learned_from_stress_test: false,
                matcher: RendererPacerMatch {
                    udn: None,
                    all_keywords: Vec::new(),
                    any_keywords: vec!["rs130".into(), "rose".into(), "citech".into()],
                },
                pacer_config: rs130_default_pacer_config(),
            }],
        }
    }

    /// Resolves `(profile_id, CorePacerConfig)` in memory for `device`:
    /// exact normalized UDN match first -> keyword matcher -> `generic` default.
    pub fn resolve_for_device(&self, device: &Rs130DeviceDescriptor) -> (&str, CorePacerConfig) {
        let target_udn = normalize_udn(&device.udn);
        if !target_udn.is_empty() {
            if let Some(p) = self.profiles.iter().find(|p| {
                p.matcher
                    .udn
                    .as_deref()
                    .is_some_and(|u| normalize_udn(u) == target_udn)
            }) {
                return (p.id.as_str(), p.pacer_config);
            }
        }
        if let Some(p) = self
            .profiles
            .iter()
            .find(|p| p.matcher.matches_identity(device))
        {
            return (p.id.as_str(), p.pacer_config);
        }
        ("generic", self.default_profile)
    }

    pub fn resolve_generic(&self) -> (&str, CorePacerConfig) {
        ("generic", self.default_profile)
    }
}

/// Loads `app_data_dir/renderer-profiles.json` at idle/startup, seeding built-in defaults if absent.
/// Falls back cleanly to built-in defaults on read or parse errors so playback is never blocked.
pub fn load_or_seed_renderer_profiles(app_data_dir: &Path) -> RendererPacerProfileFile {
    let path = app_data_dir.join(RENDERER_PROFILES_FILENAME);
    if path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<RendererPacerProfileFile>(&raw) {
                return parsed;
            }
        }
        return RendererPacerProfileFile::built_in_defaults();
    }

    let defaults = RendererPacerProfileFile::built_in_defaults();
    if app_data_dir.is_dir() {
        if let Ok(bytes) = serde_json::to_vec_pretty(&defaults) {
            let tmp = app_data_dir.join(format!("{}.tmp", RENDERER_PROFILES_FILENAME));
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
    defaults
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
                let relative_dip = self.state == CorePacingState::SteadyMaintain
                    && self.config.relative_wnd_dip_pct.is_some_and(|pct| {
                        let pct = u64::from(pct.clamp(1, 99));
                        self.baseline_open_snd_wnd >= 256 * 1024
                            && u64::from(sample.snd_wnd).saturating_mul(100)
                                <= u64::from(self.baseline_open_snd_wnd).saturating_mul(pct)
                    });
                let retrans_hit = self.config.retrans_only_backoff && retrans_delta > 0;
                if sample.snd_wnd <= low_wnd_floor || collapsed || relative_dip || retrans_hit {
                    self.metrics
                        .flow_control_events
                        .fetch_add(1, Ordering::Relaxed);
                    self.trigger_flow_backoff(now);
                }
                if is_write_stall && retrans_delta > 0 {
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

        let floor = self.config.min_steady_multiplier;
        if self.config.lock_cruise_on_fill_or_backoff {
            self.active_pace_mult = floor;
            self.soft_ceiling_mult = floor;
            return;
        }

        let prev_mult = self.active_pace_mult;
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
                if self.config.lock_cruise_on_fill_or_backoff {
                    let target = self
                        .config
                        .initial_overfeed_multiplier
                        .min(self.soft_ceiling_mult)
                        .max(self.config.min_steady_multiplier);
                    self.active_pace_mult = target;
                    self.soft_ceiling_mult = target;
                } else if !(flow_active || self.flow_strikes > 0) {
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
        if self.config.lock_cruise_on_fill_or_backoff {
            return;
        }
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
fn core_tcp_sample_from_linux_tcp_info(info: &libc::tcp_info, len: usize) -> Option<CoreTcpSample> {
    let min_prefix = core::mem::offset_of!(libc::tcp_info, tcpi_total_retrans)
        + core::mem::size_of::<u32>();
    if len < min_prefix {
        return None;
    }

    let has_min_rtt = len
        >= core::mem::offset_of!(libc::tcp_info, tcpi_min_rtt) + core::mem::size_of::<u32>();
    let tcpi_min_rtt = if has_min_rtt && info.tcpi_min_rtt > 0 {
        info.tcpi_min_rtt
    } else {
        info.tcpi_rtt.saturating_sub(info.tcpi_rttvar)
    };

    // Never substitute `tcpi_rcv_space` (server's own receive space) for `tcpi_snd_wnd`
    // (peer's advertised RWIN): on Linux 4.10+ (`len >= ~232`), `tcpi_snd_wnd` reports the
    // real peer window including `0` on TCP ZeroWindow. Only ancient kernels lacking the
    // field treat it as unknown (`u32::MAX`) so steady-state pacing is not falsely throttled.
    let has_snd_wnd = len
        >= core::mem::offset_of!(libc::tcp_info, tcpi_snd_wnd) + core::mem::size_of::<u32>();
    let tcpi_snd_wnd = if has_snd_wnd {
        info.tcpi_snd_wnd
    } else {
        u32::MAX
    };

    let mut sample = normalize_linux_tcp_info(LinuxTcpInfoRaw {
        tcpi_state: info.tcpi_state,
        tcpi_rtt: info.tcpi_rtt,
        tcpi_min_rtt,
        tcpi_snd_mss: info.tcpi_snd_mss,
        tcpi_unacked: info.tcpi_unacked,
        tcpi_snd_cwnd: info.tcpi_snd_cwnd,
        tcpi_snd_wnd,
        tcpi_total_retrans: info.tcpi_total_retrans,
    });

    let has_bytes_retrans = len
        >= core::mem::offset_of!(libc::tcp_info, tcpi_bytes_retrans)
            + core::mem::size_of::<u64>();
    if has_bytes_retrans {
        sample.bytes_retrans = info.tcpi_bytes_retrans.min(u32::MAX as u64) as u32;
    }

    Some(sample)
}

#[cfg(target_os = "linux")]
fn query_socket_tcp_info(stream: &StdTcpStream) -> Option<CoreTcpSample> {
    use std::os::unix::io::AsRawFd;

    unsafe {
        let mut info = std::mem::zeroed::<libc::tcp_info>();
        let mut len = std::mem::size_of::<libc::tcp_info>() as libc::socklen_t;
        let rc = libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_TCP,
            libc::TCP_INFO,
            (&raw mut info) as *mut libc::c_void,
            &mut len,
        );
        if rc == 0 {
            core_tcp_sample_from_linux_tcp_info(&info, len as usize)
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn query_socket_tcp_info(_stream: &StdTcpStream) -> Option<CoreTcpSample> {
    None
}

/// Evidence from ConnectionManager Sink protocolInfo. Unknown is distinct from a
/// specific list that excludes DSD; wildcard or malformed entries cannot prove exclusion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DsdCapability { Supported, Unsupported, Unknown }

pub fn dsd_capability_from_sink_protocol_info(sink: Option<&str>) -> DsdCapability {
    let Some(sink) = sink.filter(|s| !s.trim().is_empty()) else { return DsdCapability::Unknown };
    let mut unknown = false;
    for entry in sink.split(',') {
        let fields: Vec<_> = entry.trim().split(':').collect();
        if fields.len() != 4 || fields[2].trim().is_empty() {
            unknown = true;
            continue;
        }
        let mime = fields[2].trim().to_ascii_lowercase();
        if matches!(mime.as_str(), "audio/x-dsd" | "audio/dsd" | "audio/x-dsf" | "audio/dsf" | "audio/x-dff" | "audio/dff") {
            return DsdCapability::Supported;
        }
        if mime.contains('*') { unknown = true; }
    }
    if unknown { DsdCapability::Unknown } else { DsdCapability::Unsupported }
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

/// Discovers a HiFi ROSE RS130 / AVTransport MediaRenderer on the local subnet via SSDP.
/// Returns `None` immediately when `allow_loopback` is true so hermetic tests never emit LAN multicast.
pub(crate) fn discover_rs130_device(
    pinned_udn: Option<&str>,
    allow_loopback: bool,
) -> Option<Rs130DeviceDescriptor> {
    if allow_loopback {
        return None;
    }
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    let _ = socket.set_read_timeout(Some(Duration::from_millis(300)));
    let msearch = b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
    let _ = socket.send_to(msearch, "239.255.255.250:1900");

    let deadline = Instant::now() + Duration::from_millis(1600);
    let mut locations: Vec<String> = Vec::new();
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, _)) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                for line in text.lines() {
                    if let Some((key, val)) = line.split_once(':') {
                        if key.trim().eq_ignore_ascii_case("location") {
                            let url = val.trim().to_string();
                            if !url.is_empty() && !locations.contains(&url) {
                                locations.push(url);
                            }
                        }
                    }
                }
            }
            Err(_) => {
                if !locations.is_empty() && Instant::now() + Duration::from_millis(600) > deadline {
                    break;
                }
            }
        }
    }

    for loc in locations {
        if let Ok(desc) = inspect_rs130_description(&loc, pinned_udn) {
            if pinned_udn.is_some() || desc.is_qualified_rs130() {
                return Some(desc);
            }
        }
    }
    None
}

#[derive(Clone, Debug)]
pub(crate) struct PlaybackClockState {
    pub(crate) base_position_secs: f64,
    pub(crate) playing_since: Option<Instant>,
    pub(crate) last_seek_at: Option<Instant>,
    pub(crate) duration_secs: f64,
}

impl PlaybackClockState {
    #[cfg(test)]
    fn new(duration_secs: f64) -> Self {
        Self {
            base_position_secs: 0.0,
            playing_since: None,
            last_seek_at: None,
            duration_secs: duration_secs.max(0.0),
        }
    }

    fn clamp_pos(duration_secs: f64, pos: f64) -> f64 {
        if !pos.is_finite() || pos < 0.0 {
            return 0.0;
        }
        if duration_secs > 0.0 {
            pos.min(duration_secs)
        } else {
            pos
        }
    }

    fn current_position(&self) -> f64 {
        let elapsed = self
            .playing_since
            .map(|started| started.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        Self::clamp_pos(self.duration_secs, self.base_position_secs + elapsed)
    }

    fn mark_paused(&mut self, reported_pos: Option<f64>) -> f64 {
        let fallback = self.current_position();
        let within_seek_settle = self
            .last_seek_at
            .is_some_and(|t| t.elapsed() < Duration::from_secs(2));
        let chosen = match reported_pos.filter(|p| p.is_finite() && *p > 0.25) {
            Some(p) if !within_seek_settle || (p - fallback).abs() <= 3.0 => {
                Self::clamp_pos(self.duration_secs, p)
            }
            _ => fallback,
        };
        self.base_position_secs = chosen;
        self.playing_since = None;
        chosen
    }

    fn mark_resumed(&mut self) {
        if self.playing_since.is_none() {
            self.playing_since = Some(Instant::now());
        }
    }

    fn mark_seek(&mut self, pos_secs: f64, is_paused: bool) {
        self.base_position_secs = Self::clamp_pos(self.duration_secs, pos_secs);
        self.playing_since = if is_paused { None } else { Some(Instant::now()) };
        self.last_seek_at = Some(Instant::now());
    }

    fn effective_playing_position(&mut self, reported_pos: Option<f64>) -> f64 {
        let current = self.current_position();
        let within_seek_settle = self
            .last_seek_at
            .is_some_and(|t| t.elapsed() < Duration::from_secs(2));
        if let Some(p) = reported_pos.filter(|p| p.is_finite() && *p > 0.5) {
            if !within_seek_settle || (p - current).abs() <= 3.0 {
                let clamped = Self::clamp_pos(self.duration_secs, p);
                self.base_position_secs = clamped;
                self.playing_since = Some(Instant::now());
                return clamped;
            }
        }
        if self.playing_since.is_none() {
            self.playing_since = Some(Instant::now());
        }
        current
    }
}

pub(crate) struct ActiveMediaSession {
    pub(crate) capability_path: String,
    pub(crate) stream_url: String,
    pub(crate) run_token: Mutex<RunToken>,
    pub(crate) buffer: Arc<Vec<u8>>,
    pub(crate) content_type: &'static str,
    pub(crate) realtime_bytes_per_sec: Option<f64>,
    pub(crate) preroll_bytes: u64,
    pub(crate) steady_sndbuf_bytes: usize,
    pub(crate) fast_start_sndbuf_bytes: usize,
    pub(crate) chunk_bytes: usize,
    pub(crate) metadata_offset: Option<u64>,
    pub(crate) audio_payload_end: u64,
    pub(crate) pacer_config: Option<CorePacerConfig>,
    pub(crate) has_streamed_audio: AtomicBool,
    pub(crate) last_audio_end_offset: AtomicU64,
    pub(crate) cancelled: AtomicBool,
    pub(crate) playback_clock: Mutex<PlaybackClockState>,
}

impl ActiveMediaSession {
    pub(crate) fn mark_paused(&self, reported_pos: Option<f64>) -> f64 {
        self.playback_clock
            .lock()
            .map(|mut c| c.mark_paused(reported_pos))
            .unwrap_or(0.0)
    }

    pub(crate) fn mark_resumed(&self) {
        if let Ok(mut c) = self.playback_clock.lock() {
            c.mark_resumed();
        }
    }

    pub(crate) fn mark_seek(&self, pos_secs: f64, is_paused: bool) {
        if let Ok(mut c) = self.playback_clock.lock() {
            c.mark_seek(pos_secs, is_paused);
        }
    }

    pub(crate) fn effective_playing_position(&self, reported_pos: Option<f64>) -> f64 {
        self.playback_clock
            .lock()
            .map(|mut c| c.effective_playing_position(reported_pos))
            .unwrap_or_else(|_| reported_pos.filter(|p| p.is_finite() && *p >= 0.0).unwrap_or(0.0))
    }
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

    pub(crate) fn advertised_ip_addr(&self) -> Ipv4Addr {
        self.advertised_ip
    }

    pub(crate) fn active_session_arc(&self) -> Arc<Mutex<Option<Arc<ActiveMediaSession>>>> {
        Arc::clone(&self.active_session)
    }

    pub(crate) fn paused_flag_arc(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.paused_flag)
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
            session.pacer_config.unwrap_or(pacer_config),
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

    pub(crate) fn stop_active_session(&self) {
        if let Ok(mut guard) = self.active_session.lock() {
            if let Some(prev) = guard.take() {
                prev.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn shutdown(&mut self) {
        self.stop_active_session();
        self.stop_listener.store(true, Ordering::Release);
        if let Some(join) = self.listener_join.take() {
            let wake_addr = if self.listen_addr.ip().is_unspecified() {
                SocketAddr::from(([127, 0, 0, 1], self.listen_addr.port()))
            } else {
                self.listen_addr
            };
            let _ = StdTcpStream::connect_timeout(&wake_addr, Duration::from_millis(50));
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
pub(crate) struct TrackMediaMeta {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) album: String,
    pub(crate) duration_secs: f64,
    pub(crate) extension: String,
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
    ExternalActive,
    StartedPlaying,
    Paused,
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

pub(crate) struct UpnpBridgeRenderer {
    pub(crate) device: Rs130DeviceDescriptor,
    pub(crate) established_uri: Option<String>,
    pub(crate) pacer_config: CorePacerConfig,
    pub(crate) media_server_addr: SocketAddr,
    pub(crate) advertised_ip: Ipv4Addr,
    pub(crate) active_session: Arc<Mutex<Option<Arc<ActiveMediaSession>>>>,
    pub(crate) paused_flag: Arc<AtomicBool>,
    pub(crate) shared_buffers: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>,
    pub(crate) track_meta: Arc<Mutex<HashMap<String, TrackMediaMeta>>>,
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
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&entry.track_id).cloned())
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
                    pacer_config: Some(self.pacer_config),
                    has_streamed_audio: AtomicBool::new(false),
                    last_audio_end_offset: AtomicU64::new(0),
                    cancelled: AtomicBool::new(false),
                    playback_clock: Mutex::new(PlaybackClockState {
                        base_position_secs: 0.0,
                        playing_since: None,
                        last_seek_at: None,
                        duration_secs: meta.duration_secs.max(0.0),
                    }),
                });

                if let Ok(mut guard) = self.active_session.lock() {
                    *guard = Some(session);
                }

                self.established_uri = None;
                send_set_avtransport_uri_and_play(&self.device.control_url, &stream_url, &meta)
                    .map_err(|_| RendererError)?;
                self.established_uri = Some(stream_url);
                Ok(())
            }
            RendererAction::Pause => {
                self.paused_flag.store(true, Ordering::Release);
                if let Ok(guard) = self.active_session.lock() {
                    if let Some(s) = guard.as_ref() {
                        s.mark_paused(None);
                    }
                }
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
                        s.mark_resumed();
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
                let is_paused = self.paused_flag.load(Ordering::Acquire);
                if let Ok(guard) = self.active_session.lock() {
                    if let Some(s) = guard.as_ref() {
                        if let Ok(mut tok_guard) = s.run_token.lock() {
                            *tok_guard = token.clone();
                        }
                        s.mark_seek(*position_seconds, is_paused);
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
                // A local session alone does not establish current ownership: another
                // controller may have replaced the renderer URI since reconciliation.
                let owned_uri = self.established_uri.take();
                let still_owned = owned_uri.as_deref().is_some_and(|uri| {
                    query_renderer_state(&self.device.control_url).is_ok_and(|state| {
                        state.current_uri == uri
                            && matches!(state.transport_state.as_str(), "PLAYING" | "PAUSED_PLAYBACK" | "TRANSITIONING")
                    })
                });
                if let Ok(mut guard) = self.active_session.lock() {
                    if let Some(old) = guard.take() {
                        old.cancelled.store(true, Ordering::Release);
                    }
                }
                if still_owned {
                    let _ = send_simple_avtransport_action(&self.device.control_url, "Stop", "");
                }
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

        let track_meta = Arc::new(Mutex::new(load_track_media_meta(&headless_config.db_path)?));
        let shared_buffers = Arc::new(Mutex::new(HashMap::new()));

        let bridge = UpnpBridgeRenderer {
            device: upnp_config.target_device.clone(),
            established_uri: None,
            pacer_config: upnp_config.pacer_config,
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
        let probe_result = query_renderer_state(&self.device.control_url);
        let paused_flag = self.media_server.paused_flag_arc();
        Ok(apply_reconcile_probe_to_runtime(
            &mut self.inner,
            &self.media_server.active_session,
            &paused_flag,
            &self.shared_buffers,
            active.as_ref(),
            probe_result,
            &mut self.consecutive_failures,
        ))
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

pub(crate) fn parse_rel_time_seconds(rel_time: &str) -> Option<f64> {
    let trimmed = rel_time.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("NOT_IMPLEMENTED") {
        return None;
    }
    let parts: Vec<&str> = trimmed.split(':').collect();
    let secs = match parts.len() {
        3 => {
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let s: f64 = parts[2].parse().ok()?;
            h * 3600.0 + m * 60.0 + s
        }
        2 => {
            let m: f64 = parts[0].parse().ok()?;
            let s: f64 = parts[1].parse().ok()?;
            m * 60.0 + s
        }
        1 => parts[0].parse::<f64>().ok()?,
        _ => return None,
    };
    if secs.is_finite() && secs >= 0.0 {
        Some(secs)
    } else {
        None
    }
}

pub(crate) fn apply_reconcile_probe_to_runtime<R: Renderer, P: PlatformProbe, L: MemoryLocker>(
    rt: &mut HeadlessCoreRuntime<R, P, L>,
    active_session_ref: &Arc<Mutex<Option<Arc<ActiveMediaSession>>>>,
    paused_flag: &Arc<AtomicBool>,
    shared_buffers: &Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>,
    active_session: Option<&Arc<ActiveMediaSession>>,
    probe_result: Result<RestartProbeSnapshot, String>,
    consecutive_failures: &mut u32,
) -> TransportReport {
    let Some(session) = active_session else {
        *consecutive_failures = 0;
        if let Ok(probe) = probe_result {
            let ext_active = !probe.current_uri.is_empty()
                && matches!(
                    probe.transport_state.as_str(),
                    "PLAYING" | "PAUSED_PLAYBACK" | "TRANSITIONING"
                );
            if ext_active {
                let _ = rt.sync_external_renderer(Some(ExternalPlaybackInfo {
                    active: true,
                    transport_state: probe.transport_state,
                    current_uri: Some(probe.current_uri),
                    position_seconds: parse_rel_time_seconds(&probe.rel_time),
                }));
                return TransportReport::ExternalActive;
            } else {
                let _ = rt.sync_external_renderer(None);
            }
        }
        return TransportReport::NoActiveRun;
    };

    let Ok(token) = session.run_token.lock().map(|g| g.clone()) else {
        return TransportReport::Steady;
    };

    let probe = match probe_result {
        Ok(p) => {
            *consecutive_failures = 0;
            p
        }
        Err(_) => {
            *consecutive_failures = consecutive_failures.saturating_add(1);
            if *consecutive_failures >= 3 {
                if let Ok(mut guard) = active_session_ref.lock() {
                    if let Some(prev) = guard.take() {
                        prev.cancelled.store(true, Ordering::Release);
                    }
                }
                paused_flag.store(false, Ordering::Release);
                let _ = rt.on_renderer_event(RendererEvent::Failed(token));
                return TransportReport::RendererFailed;
            }
            return TransportReport::Steady;
        }
    };

    // Detect external takeover: renderer's CurrentURI changed away from our opaque session URI.
    if !probe.current_uri.is_empty() && probe.current_uri != session.stream_url {
        if let Ok(mut guard) = active_session_ref.lock() {
            if let Some(prev) = guard.take() {
                prev.cancelled.store(true, Ordering::Release);
            }
        }
        paused_flag.store(false, Ordering::Release);
        let pos = parse_rel_time_seconds(&probe.rel_time);
        let _ = rt.on_renderer_external_takeover_at(
            token,
            probe.transport_state,
            Some(probe.current_uri),
            pos,
            Instant::now(),
        );
        return TransportReport::ExternalTakeover;
    }

    let pos = parse_rel_time_seconds(&probe.rel_time);
    match probe.transport_state.as_str() {
        "PLAYING" => {
            paused_flag.store(false, Ordering::Release);
            let effective_pos = session.effective_playing_position(pos);
            let changed = rt
                .sync_active_playback(&token, "PLAYING", Some(effective_pos))
                .unwrap_or(false);
            if changed {
                TransportReport::StartedPlaying
            } else {
                TransportReport::Steady
            }
        }
        "PAUSED_PLAYBACK" => {
            paused_flag.store(true, Ordering::Release);
            let effective_pos = session.mark_paused(pos);
            let changed = rt
                .sync_active_playback(&token, "PAUSED_PLAYBACK", Some(effective_pos))
                .unwrap_or(false);
            if changed {
                TransportReport::Paused
            } else {
                TransportReport::Steady
            }
        }
        "STOPPED" => {
            let streamed = session.has_streamed_audio.load(Ordering::Acquire);
            let end_offset = session.last_audio_end_offset.load(Ordering::Acquire);
            if streamed && end_offset >= session.audio_payload_end {
                if let Some(next_id) = rt.peek_next_queue_track_id() {
                    let mut keep = HashSet::new();
                    keep.insert(next_id.clone());
                    if let Ok(admitted) =
                        rt.admit_tracks_for_explicit_user_play(&[next_id], &keep)
                    {
                        if let Ok(mut guard) = shared_buffers.lock() {
                            guard.retain(|id, _| keep.contains(id));
                            for (id, buf) in admitted {
                                guard.insert(id, buf);
                            }
                        }
                    }
                }
                let advanced = rt
                    .on_renderer_event(RendererEvent::Completed(token))
                    .unwrap_or(false);
                if advanced {
                    return TransportReport::CompletedAndAdvanced;
                }
            }
            TransportReport::Steady
        }
        _ => TransportReport::Steady,
    }
}

pub(crate) fn load_track_media_meta(db_path: &std::path::Path) -> Result<HashMap<String, TrackMediaMeta>, RuntimeError> {
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
    let duration_attr = if meta.duration_secs > 0.5 {
        format!(" duration=\"{}\"", format_rel_time(meta.duration_secs))
    } else {
        String::new()
    };
    let res_elements = if meta.extension == "dsf" || meta.extension == "dff" {
        format!(
            "&lt;res protocolInfo=\"http-get:*:audio/x-dsd:*\"{}&gt;{}&lt;/res&gt;\
             &lt;res protocolInfo=\"http-get:*:audio/dsf:*\"{}&gt;{}&lt;/res&gt;",
            duration_attr, stream_url, duration_attr, stream_url
        )
    } else {
        format!(
            "&lt;res protocolInfo=\"http-get:*:{}:*\"{}&gt;{}&lt;/res&gt;",
            mime, duration_attr, stream_url
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

pub(crate) fn query_renderer_state(control_url: &str) -> Result<RestartProbeSnapshot, String> {
    let transport_xml = send_simple_avtransport_action(control_url, "GetTransportInfo", "")?;
    let pos_xml = send_simple_avtransport_action(control_url, "GetPositionInfo", "").ok();
    let transport_state =
        extract_xml_tag(&transport_xml, "CurrentTransportState").unwrap_or_else(|| "UNKNOWN".into());
    let current_uri = pos_xml
        .as_deref()
        .and_then(|xml| extract_xml_tag(xml, "TrackURI"))
        .unwrap_or_default();
    let rel_time = pos_xml
        .as_deref()
        .and_then(|xml| extract_xml_tag(xml, "RelTime"))
        .unwrap_or_else(|| "00:00:00".into());
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
    let mut cursor = 0usize;
    while let Some(rel_lt) = xml[cursor..].find('<') {
        let lt_idx = cursor + rel_lt;
        let rest = &xml[lt_idx + 1..];
        if rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('!') {
            cursor = lt_idx + 1;
            continue;
        }
        let Some(rel_gt) = rest.find('>') else {
            break;
        };
        let tag_header = &rest[..rel_gt];
        let raw_name = tag_header.split_whitespace().next().unwrap_or("").trim_end_matches('/');
        let local_name = raw_name.rsplit(':').next().unwrap_or(raw_name);
        if local_name.eq_ignore_ascii_case(tag) && !tag_header.trim_end().ends_with('/') {
            let content_start = lt_idx + 1 + rel_gt + 1;
            let mut close_cursor = content_start;
            while let Some(rel_close) = xml[close_cursor..].find("</") {
                let close_start = close_cursor + rel_close;
                let close_rest = &xml[close_start + 2..];
                if let Some(close_gt) = close_rest.find('>') {
                    let close_raw = close_rest[..close_gt].trim();
                    let close_local = close_raw.rsplit(':').next().unwrap_or(close_raw);
                    if close_local.eq_ignore_ascii_case(tag) {
                        return Some(xml[content_start..close_start].trim().to_string());
                    }
                }
                close_cursor = close_start + 2;
            }
        }
        cursor = lt_idx + 1 + rel_gt + 1;
    }
    None
}

fn extract_avtransport_control_url(xml: &str) -> Option<String> {
    let pos = xml.find("AVTransport")?;
    let section = &xml[pos..];
    let end_service = section.find("</service>")?;
    extract_xml_tag(&section[..end_service], "controlURL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_xml_tag_handles_attributes_and_namespaces() {
        let bare = "<RelTime>00:01:23</RelTime>";
        assert_eq!(extract_xml_tag(bare, "RelTime").as_deref(), Some("00:01:23"));

        let namespaced = "<u:RelTime xmlns:u=\"urn:rose\">00:02:15</u:RelTime>";
        assert_eq!(extract_xml_tag(namespaced, "RelTime").as_deref(), Some("00:02:15"));
    }

    #[test]
    fn active_media_session_clock_advances_when_rel_time_is_zero_and_latches_on_pause() {
        let mut clock = PlaybackClockState::new(220.0);
        clock.playing_since = Some(Instant::now() - Duration::from_secs(3));

        let elapsed = clock.effective_playing_position(Some(0.0));
        assert!(elapsed >= 2.9 && elapsed < 10.0, "expected >=3s monotonic fallback, got {}", elapsed);

        let paused = clock.mark_paused(Some(0.0));
        assert!(paused >= 2.9, "pause must preserve accumulated clock instead of resetting to 0");

        let hw_pos = clock.effective_playing_position(Some(42.0));
        assert!((hw_pos - 42.0).abs() < 0.01, "non-zero RelTime must re-anchor clock");

        clock.mark_seek(120.0, false);
        let after_seek = clock.effective_playing_position(Some(42.0));
        assert!(after_seek >= 119.9 && after_seek <= 122.0, "seek must reject stale pre-seek RelTime");
    }

    #[test]
    fn dsd256_pacer_does_not_drop_to_flow_suppressed_when_peer_snd_wnd_is_open() {
        let metrics = Arc::new(CorePacingMetrics::default());
        let paused = Arc::new(AtomicBool::new(false));
        let mut pacer = CorePacer::new(
            CorePacerConfig::default(),
            Some(2_822_400.0), // DSD256: steady_sndbuf=32768 -> low_wnd_floor=65536
            0,
            MAX_CORE_STEADY_SNDBUF_BYTES,
            false,
            true,
            false,
            Arc::clone(&metrics),
            paused,
        );

        let t0 = Instant::now();
        // Simulated healthy RS130 peer TCP window observed via `ss -tin` (1,476,992 bytes).
        let open_sample = CoreTcpSample {
            rtt_us: 476,
            min_rtt_us: 208,
            bytes_in_flight: 16 * 1024,
            cwnd: 194 * 1448,
            snd_wnd: 1_476_992,
            bytes_retrans: 0,
        };
        for step in 0..8u64 {
            let now = t0 + Duration::from_millis(step * 200);
            pacer.set_sent_for_test((step + 1) * 620_000);
            let _ = pacer.advance_with_sample(
                now,
                4096,
                Duration::from_micros(20),
                false,
                Some(open_sample),
            );
        }

        let snap = metrics.snapshot();
        assert_eq!(snap.flow_control_events, 0, "open RWIN must not trigger flow backoff");
        assert!(
            snap.current_multiplier >= 1.000,
            "expected >= 1.000x steady rate with open RWIN, got {}",
            snap.current_multiplier
        );
        assert_ne!(snap.current_regime, "flow_suppressed");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_tcp_info_extracts_real_snd_wnd_even_when_kernel_struct_is_shorter_than_libc() {
        let mut info = unsafe { std::mem::zeroed::<libc::tcp_info>() };
        info.tcpi_state = 1;
        info.tcpi_rtt = 476;
        info.tcpi_min_rtt = 208;
        info.tcpi_snd_mss = 1448;
        info.tcpi_unacked = 4;
        info.tcpi_snd_cwnd = 194;
        info.tcpi_rcv_space = 14_480; // Small server receive space must NOT mask peer snd_wnd
        info.tcpi_snd_wnd = 1_476_992;
        info.tcpi_bytes_retrans = 0;

        // Simulate Linux 6.12 kernel returning 248 bytes (< full libc::tcp_info with 6.14+ fields).
        let linux_612_len = (core::mem::offset_of!(libc::tcp_info, tcpi_rcv_wnd) + 16)
            .min(core::mem::size_of::<libc::tcp_info>());
        let sample = core_tcp_sample_from_linux_tcp_info(&info, linux_612_len).unwrap();
        assert_eq!(sample.snd_wnd, 1_476_992);
        assert_eq!(sample.min_rtt_us, 208);

        // Preserve genuine TCP ZeroWindow when peer actually closes RWIN to 0.
        info.tcpi_snd_wnd = 0;
        let zero_wnd = core_tcp_sample_from_linux_tcp_info(&info, linux_612_len).unwrap();
        assert_eq!(zero_wnd.snd_wnd, 0);

        // Verify live loopback socket query returns peer's real non-zero window (> 65536).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = std::net::TcpStream::connect(addr).unwrap();
        let (server, _peer) = listener.accept().unwrap();
        let live = query_socket_tcp_info(&server).expect("TCP_INFO must succeed on Linux loopback");
        assert!(live.snd_wnd > 65_536, "expected real loopback snd_wnd > 65536, got {}", live.snd_wnd);
        drop(client);
    }

    #[test]
    fn renderer_profiles_json_seeds_parses_and_resolves_rs130_vs_generic_and_udn_override() {
        let dir = std::env::temp_dir().join(format!("cadence_profiles_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();

        let seeded = load_or_seed_renderer_profiles(&dir);
        assert_eq!(seeded.schema_version, RENDERER_PROFILES_SCHEMA_VERSION);
        assert!(dir.join(RENDERER_PROFILES_FILENAME).is_file());

        let reloaded = load_or_seed_renderer_profiles(&dir);
        assert_eq!(reloaded, seeded);

        let rs130 = Rs130DeviceDescriptor {
            udn: "uuid:ROSE-RS130-MAIN".into(),
            friendly_name: "HiFi ROSE RS130".into(),
            model_name: Some("RS130".into()),
            model_description: Some("HiFi ROSE".into()),
            manufacturer: Some("CITECH".into()),
            description_url: "http://192.168.1.106:9999/description.xml".into(),
            control_url: "http://192.168.1.106:9999/AVTransport/ctrl".into(),
        };
        let (id, cfg) = reloaded.resolve_for_device(&rs130);
        assert_eq!(id, "hifi-rose-rs130");
        assert!(cfg.lock_cruise_on_fill_or_backoff);
        assert!(cfg.retrans_only_backoff);
        assert_eq!(cfg.relative_wnd_dip_pct, Some(92));
        assert!((cfg.initial_overfeed_multiplier - 1.0).abs() < 1e-6);

        let generic = Rs130DeviceDescriptor {
            udn: "uuid:ANTHEM-AVM70".into(),
            friendly_name: "Living Room AVR".into(),
            model_name: Some("AVM 70".into()),
            model_description: None,
            manufacturer: Some("Anthem".into()),
            description_url: "http://192.168.1.120:9999/description.xml".into(),
            control_url: "http://192.168.1.120:9999/AVTransport/ctrl".into(),
        };
        let (gid, gcfg) = reloaded.resolve_for_device(&generic);
        assert_eq!(gid, "generic");
        assert_eq!(gcfg, CorePacerConfig::default());

        // Learned per-UDN override must beat generic keyword match.
        let mut custom = reloaded.clone();
        let mut learned_cfg = rs130_default_pacer_config();
        learned_cfg.initial_fill_lead_ms = 1_500;
        custom.profiles.push(RendererPacerProfile {
            id: "learned-rs130-main".into(),
            description: "Learned from calibration".into(),
            learned_from_stress_test: true,
            matcher: RendererPacerMatch {
                udn: Some("uuid:rose-rs130-main".into()),
                ..RendererPacerMatch::default()
            },
            pacer_config: learned_cfg,
        });
        std::fs::write(
            dir.join(RENDERER_PROFILES_FILENAME),
            serde_json::to_vec_pretty(&custom).unwrap(),
        )
        .unwrap();
        let overridden = load_or_seed_renderer_profiles(&dir);
        let (oid, ocfg) = overridden.resolve_for_device(&rs130);
        assert_eq!(oid, "learned-rs130-main");
        assert_eq!(ocfg.initial_fill_lead_ms, 1_500);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rs130_config_transitions_from_initial_fill_straight_to_locked_cruise() {
        let metrics = Arc::new(CorePacingMetrics::default());
        let paused = Arc::new(AtomicBool::new(false));
        let mut pacer = CorePacer::new(
            rs130_default_pacer_config(),
            Some(2_822_400.0), // DSD256
            MAX_CORE_PREROLL_BYTES,
            MAX_CORE_STEADY_SNDBUF_BYTES,
            false,
            false,
            false,
            Arc::clone(&metrics),
            paused,
        );
        pacer.clamped_to_steady = true;

        let t0 = Instant::now();
        let healthy = CoreTcpSample {
            rtt_us: 490,
            min_rtt_us: 200,
            bytes_in_flight: 16_384,
            cwnd: 194 * 1448,
            snd_wnd: 700_864,
            bytes_retrans: 0,
        };

        // At t=0.5s with ~600ms lead (< 1200ms target), remains in InitialFill (1.180x).
        pacer.set_sent_for_test(524_288 + (0.5 * 2_822_400.0 * 1.180) as u64);
        let _ = pacer.advance_with_sample(
            t0 + Duration::from_millis(500),
            4096,
            Duration::from_micros(20),
            false,
            Some(healthy),
        );
        let s1 = metrics.snapshot();
        assert_eq!(s1.current_state, "initial_fill");
        assert!((s1.current_multiplier - 1.180).abs() < 1e-6);

        // Once lead passes 1,200 ms (~5.0s), transitions straight to 1.000x cruise.
        pacer.set_sent_for_test((5.0 * 2_822_400.0 + 1.35 * 2_822_400.0) as u64);
        let _ = pacer.advance_with_sample(
            t0 + Duration::from_millis(5_000),
            4096,
            Duration::from_micros(20),
            false,
            Some(healthy),
        );
        let s2 = metrics.snapshot();
        assert_eq!(s2.current_state, "steady_maintain");
        assert_eq!(s2.current_regime, "cruise");
        assert!((s2.current_multiplier - 1.000).abs() < 1e-6);

        // Even after 40s clean, locked profile does NOT ramp back up to 1.08x / 1.12x.
        for sec in [12u64, 24, 42] {
            pacer.set_sent_for_test(((sec as f64 + 1.35) * 2_822_400.0) as u64);
            let _ = pacer.advance_with_sample(
                t0 + Duration::from_secs(sec),
                4096,
                Duration::from_micros(20),
                false,
                Some(healthy),
            );
        }
        let s3 = metrics.snapshot();
        assert_eq!(s3.current_regime, "cruise");
        assert!((s3.current_multiplier - 1.000).abs() < 1e-6);
        assert_eq!(s3.flow_control_events, 0);
    }

    #[test]
    fn rs130_config_backs_off_on_retrans_delta_and_relative_high_window_dip() {
        // Case A: +1200B TLP retransmission delta without write stall triggers backoff under RS130 profile.
        let metrics_a = Arc::new(CorePacingMetrics::default());
        let paused_a = Arc::new(AtomicBool::new(false));
        let mut pacer_a = CorePacer::new(
            rs130_default_pacer_config(),
            Some(2_822_400.0),
            0,
            MAX_CORE_STEADY_SNDBUF_BYTES,
            false,
            true,
            false,
            Arc::clone(&metrics_a),
            paused_a,
        );
        let t0 = Instant::now();
        let base_sample = CoreTcpSample {
            rtt_us: 490,
            min_rtt_us: 200,
            bytes_in_flight: 16_384,
            cwnd: 194 * 1448,
            snd_wnd: 700_864,
            bytes_retrans: 0,
        };
        pacer_a.set_sent_for_test(700_000);
        let _ = pacer_a.advance_with_sample(t0, 4096, Duration::from_micros(20), false, Some(base_sample));

        let mut tlp_sample = base_sample;
        tlp_sample.bytes_retrans = 1200;
        pacer_a.set_sent_for_test(1_300_000);
        let _ = pacer_a.advance_with_sample(
            t0 + Duration::from_millis(200),
            4096,
            Duration::from_micros(20),
            false,
            Some(tlp_sample),
        );
        let snap_a = metrics_a.snapshot();
        assert_eq!(snap_a.flow_control_events, 1);
        assert_eq!(snap_a.current_regime, "flow_suppressed");

        // After flow clear window (1.5s), must remain locked at 1.000x cruise.
        pacer_a.set_sent_for_test(6_000_000);
        let _ = pacer_a.advance_with_sample(
            t0 + Duration::from_millis(2_000),
            4096,
            Duration::from_micros(20),
            false,
            Some(tlp_sample),
        );
        let snap_a2 = metrics_a.snapshot();
        assert_eq!(snap_a2.current_regime, "cruise");
        assert!((snap_a2.current_multiplier - 1.000).abs() < 1e-6);

        // Case B: High-window dip (700,864 -> 639,296, ~91.2% <= 92%) triggers backoff in SteadyMaintain.
        let metrics_b = Arc::new(CorePacingMetrics::default());
        let paused_b = Arc::new(AtomicBool::new(false));
        let mut pacer_b = CorePacer::new(
            rs130_default_pacer_config(),
            Some(2_822_400.0),
            0,
            MAX_CORE_STEADY_SNDBUF_BYTES,
            true, // starts in SteadyMaintain
            true,
            false,
            Arc::clone(&metrics_b),
            paused_b,
        );
        pacer_b.set_sent_for_test(700_000);
        let _ = pacer_b.advance_with_sample(t0, 4096, Duration::from_micros(20), false, Some(base_sample));
        assert_eq!(metrics_b.snapshot().flow_control_events, 0);

        let mut dipped = base_sample;
        dipped.snd_wnd = 639_296;
        pacer_b.set_sent_for_test(1_300_000);
        let _ = pacer_b.advance_with_sample(
            t0 + Duration::from_millis(200),
            4096,
            Duration::from_micros(20),
            false,
            Some(dipped),
        );
        assert_eq!(metrics_b.snapshot().flow_control_events, 1);
    }
}
