use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream as StdTcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::time::timeout;

use super::stream_tuning::{self, LockedBuffer, StreamingThreadGuard};

/// How the current track's untouched bytes are held for serving.
enum BufferMode {
    /// Entire file pre-loaded into page-locked RAM. Storage is idle during playback.
    WholeTrack(LockedBuffer),
    /// File exceeds the RAM budget: served from page-locked read-ahead windows.
    /// Storage wakes briefly once per window instead of reading continuously.
    Windowed { window_bytes: u64 },
}

/// The track currently exposed by the HTTP streamer. Bytes are always the
/// untouched file contents.
struct StreamSource {
    path: PathBuf,
    content_type: &'static str,
    len: u64,
    /// Initial paced delivery rate in bytes/sec (`None` = unpaced, e.g. unknown duration).
    #[allow(dead_code)]
    pace_bytes_per_sec: Option<f64>,
    /// Steady-state delivery rate in bytes/sec once buffer saturation is detected.
    #[allow(dead_code)]
    steady_pace_bytes_per_sec: Option<f64>,
    /// Calculated audio bitrate in bytes/sec (`None` = unknown duration).
    #[allow(dead_code)]
    realtime_bytes_per_sec: Option<f64>,
    /// Bytes sent unpaced at the start of each request.
    preroll_bytes: u64,
    /// Dynamic steady-state kernel TCP send buffer (holds 100 ms of audio in flight).
    sndbuf_bytes: usize,
    /// Dynamic fast-start kernel TCP send buffer for unpaced pre-roll.
    fast_start_sndbuf_bytes: usize,
    /// Byte offset where ID3v2 / album artwork metadata begins (if known).
    metadata_offset: Option<u64>,
    mode: BufferMode,
}

impl StreamSource {
    fn prepare(path: &Path, duration_secs: f64, user_limit_mb: u64) -> Result<Self, String> {
        let len = std::fs::metadata(path)
            .map_err(|e| format!("Cannot stat stream file: {}", e))?
            .len();

        let budget = stream_tuning::effective_budget_bytes(user_limit_mb);
        let window_bytes = stream_tuning::window_bytes_for_budget(budget);

        let mode = if len > 0 && len <= budget {
            match LockedBuffer::load(path) {
                Ok(buf) => {
                    eprintln!(
                        "[Cadence UPnP Streamer] Whole-track buffer: {:.1} MB in RAM (page-locked: {}, budget {:.0} MB).",
                        len as f64 / 1_048_576.0,
                        buf.is_locked(),
                        budget as f64 / 1_048_576.0
                    );
                    BufferMode::WholeTrack(buf)
                }
                Err(e) => {
                    eprintln!("[Cadence UPnP Streamer] Whole-track load failed ({}), using windowed read-ahead.", e);
                    BufferMode::Windowed { window_bytes }
                }
            }
        } else {
            eprintln!(
                "[Cadence UPnP Streamer] {:.1} MB exceeds RAM budget ({:.0} MB): windowed read-ahead, {:.0} MB windows.",
                len as f64 / 1_048_576.0,
                budget as f64 / 1_048_576.0,
                window_bytes as f64 / 1_048_576.0
            );
            BufferMode::Windowed { window_bytes }
        };

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let is_dsd = ext == "dsf" || ext == "dff";

        // Node B --> D: On-the-fly DSF sniffing & Bitrate Sanity Check
        // If file is DSF, directly inspect fixed-offset 80-byte header to recover true 1-bit clock and duration
        let dsf_info = if ext == "dsf" {
            stream_tuning::parse_dsf_header(path)
        } else {
            None
        };

        let effective_duration = if let Some(ref info) = dsf_info {
            if info.duration_secs > 0.5 {
                info.duration_secs
            } else if duration_secs > 0.5 {
                duration_secs
            } else {
                0.0
            }
        } else if duration_secs > 0.5 {
            duration_secs
        } else {
            0.0
        };

        // Compute bitrate:
        // 1. If DSF header was parsed, calculate directly from 1-bit clock * channels / 8.
        // 2. Otherwise if duration > 0.5s, calculate from file_size_bytes / duration_secs (universal for WAV/AIFF/DSF/DFF).
        let calculated_realtime: Option<f64> = if let Some(ref info) = dsf_info {
            let direct_dsd_bitrate = stream_tuning::calculate_audio_bitrate(
                info.sample_rate,
                info.channels,
                1,
                true,
            );
            if direct_dsd_bitrate > 0.0 {
                Some(direct_dsd_bitrate)
            } else if effective_duration > 0.5 {
                Some(len as f64 / effective_duration)
            } else {
                None
            }
        } else if effective_duration > 0.5 {
            Some(len as f64 / effective_duration)
        } else {
            None
        };

        let (pace_bytes_per_sec, steady_pace_bytes_per_sec, realtime_bytes_per_sec, preroll_bytes, sndbuf_bytes, fast_start_sndbuf_bytes) = if let Some(realtime) = calculated_realtime {
            let initial_pace = (realtime * stream_tuning::INITIAL_PACE_MULTIPLIER).max(stream_tuning::MIN_PACE_BYTES_PER_SEC);
            let steady_pace = (realtime * stream_tuning::STEADY_PACE_MULTIPLIER).max(stream_tuning::MIN_PACE_BYTES_PER_SEC);
            let sndbuf = stream_tuning::calculate_sndbuf_bytes(realtime);
            let fast_start = stream_tuning::calculate_fast_start_sndbuf_bytes(realtime);
            // Cap pre-roll burst to MAX_PREROLL_BYTES (2 MB) to prevent FIFO bufferbloat
            let raw_preroll = (realtime * stream_tuning::PREROLL_SECS) as u64;
            let preroll = raw_preroll.min(stream_tuning::MAX_PREROLL_BYTES);

            eprintln!(
                "[Cadence UPnP Streamer] Format: {} | Audio Bitrate: {:.1} KB/s ({:.2} Mbps) | State 1 Ramp-Up: {:.1} KB/s ({:.2}x) | State 2 Step-Down: {:.1} KB/s ({:.2}x) | Fast-Start: {} KB | SO_SNDBUF: {} KB",
                if is_dsd { "DSD" } else { "PCM" },
                realtime / 1024.0,
                (realtime * 8.0) / 1_000_000.0,
                initial_pace / 1024.0,
                stream_tuning::RAMP_UP_MULTIPLIER,
                steady_pace / 1024.0,
                stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER,
                preroll / 1024,
                sndbuf / 1024
            );
            (Some(initial_pace), Some(steady_pace), Some(realtime), preroll, sndbuf, fast_start)
        } else {
            (None, None, None, 0, stream_tuning::MIN_SOCKET_SNDBUF_BYTES, stream_tuning::SOCKET_FAST_START_SNDBUF)
        };

        let metadata_offset = if let Some(ref info) = dsf_info {
            if info.metadata_offset > 0 {
                Some(info.metadata_offset)
            } else {
                None
            }
        } else {
            None
        };

        Ok(Self {
            path: path.to_path_buf(),
            content_type: content_type_for(path),
            len,
            pace_bytes_per_sec,
            steady_pace_bytes_per_sec,
            realtime_bytes_per_sec,
            preroll_bytes,
            sndbuf_bytes,
            fast_start_sndbuf_bytes,
            metadata_offset,
            mode,
        })
    }
}

/// Snapshot of the stream-buffer configuration for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamBufferInfo {
    /// User limit in MB; 0 = Auto.
    pub limit_mb: u64,
    /// Budget that would apply to the next track, in MB.
    pub effective_budget_mb: u64,
    pub available_ram_mb: Option<u64>,
    pub total_ram_mb: Option<u64>,
    /// "whole_track" | "windowed" | "idle"
    pub current_mode: String,
    pub current_file_mb: Option<f64>,
    pub current_window_mb: Option<u64>,
    pub current_locked: Option<bool>,
}

fn content_type_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "dsf" | "dff" => "audio/x-dsd",
        "mp3" => "audio/mpeg",
        "m4a" | "alac" => "audio/mp4",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// 3-State Adaptive Pacing Engine for DSD and High-Bitrate PCM streaming:
/// - State 1 (Ramp-Up): Delivers at 1.25x real-time bitrate to smoothly prime the streamer's
///   hardware FIFO buffer (typically 4–8 MB) without wire-speed gigabit burst currents.
/// - State 2 (Backpressure Detected): When kernel write blocks or schedule lag exceed 25 ms
///   (TCP ZeroWindow), drops delivery rate to 1.02x, clamps SO_SNDBUF to 32 KB, and re-anchors
///   the timeline baseline to prevent any catch-up bursts.
/// - State 3 (Stable Operation): Cruising delivery matching DAC consumption (+0.2% to +2%).
///   Monitors for an 8-second continuous clean window before probing upward in +0.005x increments.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PacingState {
    Unpaced,
    RampUp,
    BackpressureDetected {
        entered_at: Instant,
        last_stall_at: Instant,
        consecutive_stalls: u32,
    },
    StableOperation {
        stable_since: Instant,
        current_multiplier: f64,
        last_adjustment: Instant,
    },
}

struct SynchronousPacer {
    realtime_rate: Option<f64>,
    state: PacingState,
    preroll: u64,
    sent: u64,
    paced_start: Option<Instant>,
    steady_sndbuf: usize,
    clamped_to_steady: bool,
    transition_sent: u64,
}

impl SynchronousPacer {
    fn unpaced() -> Self {
        Self {
            realtime_rate: None,
            state: PacingState::Unpaced,
            preroll: 0,
            sent: 0,
            paced_start: None,
            steady_sndbuf: stream_tuning::MIN_SOCKET_SNDBUF_BYTES,
            clamped_to_steady: true,
            transition_sent: 0,
        }
    }

    fn new(source: &StreamSource, range_start: u64, is_metadata: bool) -> Self {
        if is_metadata {
            return Self::unpaced();
        }

        // Only requests mid-track (start >= 1 MB) are sequential range continuations.
        // Initial requests (start < 1 MB, such as byte 0, or byte 80/92 after header sniff)
        // receive the 512 KB fast-start pre-roll burst to prime the streamer's DAC instantly.
        let is_range_continuation = range_start >= 1024 * 1024;
        let initial_state = if is_range_continuation {
            PacingState::StableOperation {
                stable_since: Instant::now(),
                current_multiplier: stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER,
                last_adjustment: Instant::now(),
            }
        } else {
            PacingState::RampUp
        };

        Self {
            realtime_rate: source.realtime_bytes_per_sec,
            state: initial_state,
            preroll: if is_range_continuation { 0 } else { source.preroll_bytes },
            sent: 0,
            paced_start: None,
            steady_sndbuf: source.sndbuf_bytes,
            clamped_to_steady: is_range_continuation,
            transition_sent: 0,
        }
    }

    fn on_chunk_sent(&mut self, stream: &mut StdTcpStream, n: usize, write_block_dur: Duration) {
        self.sent += n as u64;
        let realtime = match self.realtime_rate {
            Some(r) => r,
            None => return,
        };

        // Phase 1: Fast-Start Pre-roll Burst (unpaced up to MAX_PREROLL_BYTES)
        if self.sent <= self.preroll {
            return;
        }

        // Phase 2: Transition Boundary (Clean Drain):
        // When pre-roll finishes, down-clamp SO_SNDBUF to steady_sndbuf (32 KB ceiling).
        if !self.clamped_to_steady {
            let sock = socket2::SockRef::from(&*stream);
            let _ = sock.set_send_buffer_size(self.steady_sndbuf);
            self.clamped_to_steady = true;
            self.transition_sent = self.sent;
            self.paced_start = Some(Instant::now());
            return;
        }

        // Phase 3: Rate determination based on 3-State Machine
        let current_rate = match self.state {
            PacingState::Unpaced => return,
            PacingState::RampUp => realtime * stream_tuning::RAMP_UP_MULTIPLIER,
            PacingState::BackpressureDetected { consecutive_stalls, .. } => {
                if consecutive_stalls > 1 {
                    realtime * stream_tuning::STABLE_MIN_MULTIPLIER
                } else {
                    realtime * stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER
                }
            }
            PacingState::StableOperation { current_multiplier, .. } => {
                realtime * current_multiplier
            }
        };

        let start = *self.paced_start.get_or_insert_with(Instant::now);
        let paced_bytes = (self.sent - self.transition_sent) as f64;
        let target_time = start + Duration::from_secs_f64(paced_bytes / current_rate);

        let now = Instant::now();
        let stall_threshold = Duration::from_millis(stream_tuning::BACKPRESSURE_STALL_MS);
        let schedule_lag = now.saturating_duration_since(target_time);
        let is_stall = write_block_dur > stall_threshold || schedule_lag > stall_threshold;

        if target_time > now && !is_stall {
            std::thread::sleep(target_time - now);
        }

        if is_stall {
            // True TCP backpressure / ZeroWindow stall detected.
            // Re-anchor baseline to prevent wire-speed catch-up burst!
            self.paced_start = Some(Instant::now());
            self.transition_sent = self.sent;

            match self.state {
                PacingState::RampUp => {
                    eprintln!(
                        "[Cadence UPnP Pacer] State 1 (Ramp-Up {:.2}x) -> State 2 (Backpressure Detected, stall {:?}). Stepping down to {:.2}x.",
                        stream_tuning::RAMP_UP_MULTIPLIER,
                        write_block_dur.max(schedule_lag),
                        stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER
                    );
                    self.state = PacingState::BackpressureDetected {
                        entered_at: Instant::now(),
                        last_stall_at: Instant::now(),
                        consecutive_stalls: 1,
                    };
                }
                PacingState::BackpressureDetected { entered_at, last_stall_at, consecutive_stalls } => {
                    let now_t = Instant::now();
                    let recent = now_t.duration_since(last_stall_at) < Duration::from_secs(2);
                    let stalls = if recent { consecutive_stalls + 1 } else { 1 };
                    let effective_mult = if stalls > 1 {
                        stream_tuning::STABLE_MIN_MULTIPLIER
                    } else {
                        stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER
                    };
                    eprintln!(
                        "[Cadence UPnP Pacer] State 2 (Repeated Backpressure #{}). Holding rate at {:.3}x.",
                        stalls, effective_mult
                    );
                    self.state = PacingState::BackpressureDetected {
                        entered_at,
                        last_stall_at: now_t,
                        consecutive_stalls: stalls,
                    };
                }
                PacingState::StableOperation { current_multiplier, .. } => {
                    eprintln!(
                        "[Cadence UPnP Pacer] State 3 -> State 2 (Renewed Backpressure). Stepping down from {:.3}x to {:.2}x.",
                        current_multiplier,
                        stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER
                    );
                    self.state = PacingState::BackpressureDetected {
                        entered_at: Instant::now(),
                        last_stall_at: Instant::now(),
                        consecutive_stalls: 1,
                    };
                }
                PacingState::Unpaced => {}
            }
        } else {
            // Clean progress without stall on this chunk
            match self.state {
                PacingState::BackpressureDetected { last_stall_at, consecutive_stalls, .. } => {
                    // If stall-free for 5 seconds, promote to State 3 (Stable Operation)
                    if last_stall_at.elapsed() >= Duration::from_secs(5) {
                        let initial_mult = if consecutive_stalls > 1 {
                            stream_tuning::STABLE_MIN_MULTIPLIER
                        } else {
                            stream_tuning::BACKPRESSURE_STEPDOWN_MULTIPLIER
                        };
                        eprintln!(
                            "[Cadence UPnP Pacer] State 2 -> State 3 (Stable Operation). Progress recovered, cruising at {:.3}x.",
                            initial_mult
                        );
                        self.state = PacingState::StableOperation {
                            stable_since: Instant::now(),
                            current_multiplier: initial_mult,
                            last_adjustment: Instant::now(),
                        };
                    }
                }
                PacingState::StableOperation { stable_since, current_multiplier, last_adjustment } => {
                    // If stable for STABILITY_WINDOW_SECS (8s) and last adjustment was >= 8s ago, probe headroom
                    if stable_since.elapsed() >= Duration::from_secs_f64(stream_tuning::STABILITY_WINDOW_SECS)
                        && last_adjustment.elapsed() >= Duration::from_secs_f64(stream_tuning::STABILITY_WINDOW_SECS)
                        && current_multiplier < stream_tuning::STABLE_PROBE_CEILING
                    {
                        let new_mult = (current_multiplier + stream_tuning::STABLE_PROBE_INCREMENT).min(stream_tuning::STABLE_PROBE_CEILING);
                        if new_mult > current_multiplier {
                            eprintln!(
                                "[Cadence UPnP Pacer] State 3: Sustained stability for {:.1}s. Probing headroom: {:.3}x -> {:.3}x.",
                                stable_since.elapsed().as_secs_f64(),
                                current_multiplier,
                                new_mult
                            );
                            self.state = PacingState::StableOperation {
                                stable_since,
                                current_multiplier: new_mult,
                                last_adjustment: Instant::now(),
                            };
                            self.paced_start = Some(Instant::now());
                            self.transition_sent = self.sent;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    #[inline]
    #[allow(dead_code)]
    fn on_sent(&mut self, stream: &mut StdTcpStream, n: usize) {
        self.on_chunk_sent(stream, n, Duration::ZERO);
    }
}


fn configure_initial_socket(stream: &StdTcpStream, fast_start_sndbuf: usize) {
    // Disable Nagle's algorithm for immediate packet dispatch
    let _ = stream.set_nodelay(true);
    // Initial fast-start buffer: allows unpaced pre-roll to flush instantaneously
    let sock = socket2::SockRef::from(stream);
    let _ = sock.set_send_buffer_size(fast_start_sndbuf);
}


/// Parses `Range: bytes=a-b`, `bytes=a-` and suffix `bytes=-n`.
/// Returns `Err(())` when the range is unsatisfiable.
fn parse_range(header_value: &str, len: u64) -> Result<(u64, u64), ()> {
    let spec = header_value.split('=').nth(1).ok_or(())?;
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = spec.split_once('-').ok_or(())?;
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Err(());
    }
    let (start, end) = if a.is_empty() {
        let suffix: u64 = b.parse().map_err(|_| ())?;
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = a.parse().map_err(|_| ())?;
        let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().map_err(|_| ())?.min(len - 1) };
        (start, end)
    };
    if start >= len || end < start {
        return Err(());
    }
    Ok((start, end))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpnpDevice {
    pub id: String,
    pub friendly_name: String,
    pub model_name: Option<String>,
    pub model_description: Option<String>,
    pub manufacturer: Option<String>,
    pub location: String,
    pub control_url: String,
}

impl UpnpDevice {
    /// Calculate priority score: Dedicated audiophile network streamers score high (> 100),
    /// generic audio renderers score normal (50),
    /// displays/monitors/TVs score low (< 0).
    pub fn priority_score(&self) -> i32 {
        let text = format!(
            "{} {} {} {}",
            self.friendly_name,
            self.model_name.as_deref().unwrap_or(""),
            self.model_description.as_deref().unwrap_or(""),
            self.manufacturer.as_deref().unwrap_or("")
        ).to_lowercase();

        let mut score = 50;

        // Audiophile streamers & DAC brands get top priority
        if text.contains("rose") || text.contains("rs130") || text.contains("rs150") || text.contains("rs250") || text.contains("rs520") {
            score += 200;
        }
        if text.contains("avm") || text.contains("anthem") || text.contains("eversolo") || text.contains("lumin")
            || text.contains("auralic") || text.contains("cambridge") || text.contains("wiim") || text.contains("bluesound")
            || text.contains("naim") || text.contains("krell") || text.contains("marantz") || text.contains("denon")
            || text.contains("hifi") {
            score += 100;
        }

        // Displays, TVs, computer monitors get heavily penalized so they are never default
        if text.contains("odyssey") || text.contains("oled") || text.contains("tv") || text.contains("monitor")
            || text.contains("screen") || text.contains("display") || text.contains("samsung") || text.contains("sec") {
            score -= 150;
        }

        score
    }

    /// Check if this device is likely a display monitor or TV rather than a dedicated audio streamer
    pub fn is_display_device(&self) -> bool {
        let text = format!(
            "{} {} {}",
            self.friendly_name,
            self.model_name.as_deref().unwrap_or(""),
            self.model_description.as_deref().unwrap_or("")
        ).to_lowercase();
        text.contains("odyssey") || text.contains("oled") || text.contains("tv")
            || text.contains("monitor") || text.contains("screen") || text.contains("display")
    }
}

#[derive(Debug, Clone, Default)]
pub struct UpnpPlaybackState {
    pub is_playing: bool,
    pub is_paused: bool,
    pub current_uri: Option<String>,
    pub current_file: Option<String>,
    pub position_secs: f64,
    pub duration_secs: f64,
}

pub struct UpnpManager {
    devices: Arc<Mutex<Vec<UpnpDevice>>>,
    active_device: Arc<Mutex<Option<UpnpDevice>>>,
    playback_state: Arc<Mutex<UpnpPlaybackState>>,
    http_port: u16,
    server_running: Arc<AtomicBool>,
    current_stream: Arc<Mutex<Option<Arc<StreamSource>>>>,
    /// Whole-track RAM limit in MB (0 = Auto, derived from available RAM).
    buffer_limit_mb: Arc<AtomicU64>,
}

impl UpnpManager {
    pub fn new() -> Self {
        let manager = Self {
            devices: Arc::new(Mutex::new(Vec::new())),
            active_device: Arc::new(Mutex::new(None)),
            playback_state: Arc::new(Mutex::new(UpnpPlaybackState::default())),
            http_port: 18890,
            server_running: Arc::new(AtomicBool::new(false)),
            current_stream: Arc::new(Mutex::new(None)),
            buffer_limit_mb: Arc::new(AtomicU64::new(0)),
        };

        manager.ensure_http_server();
        manager
    }

    /// Resolve the local LAN IPv4 address of this machine
    pub fn get_local_lan_ip() -> String {
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    return addr.ip().to_string();
                }
            }
        }
        "127.0.0.1".to_string()
    }

    /// Set the whole-track RAM limit in MB (0 = Auto). Applies from the next track.
    pub fn set_buffer_limit_mb(&self, limit_mb: u64) -> StreamBufferInfo {
        self.buffer_limit_mb.store(limit_mb, Ordering::SeqCst);
        self.get_buffer_info()
    }

    pub fn get_buffer_info(&self) -> StreamBufferInfo {
        let limit_mb = self.buffer_limit_mb.load(Ordering::SeqCst);
        let mem = stream_tuning::memory_info();
        let to_mb = |b: u64| b / (1024 * 1024);
        let current = self.current_stream.lock().clone();

        let (current_mode, current_file_mb, current_window_mb, current_locked) = match current.as_deref() {
            Some(src) => {
                let file_mb = Some(src.len as f64 / 1_048_576.0);
                match &src.mode {
                    BufferMode::WholeTrack(buf) => ("whole_track", file_mb, None, Some(buf.is_locked())),
                    BufferMode::Windowed { window_bytes } => ("windowed", file_mb, Some(to_mb(*window_bytes)), None),
                }
            }
            None => ("idle", None, None, None),
        };

        StreamBufferInfo {
            limit_mb,
            effective_budget_mb: to_mb(stream_tuning::effective_budget_bytes(limit_mb)),
            available_ram_mb: mem.map(|m| to_mb(m.available_bytes)),
            total_ram_mb: mem.map(|m| to_mb(m.total_bytes)),
            current_mode: current_mode.to_string(),
            current_file_mb,
            current_window_mb,
            current_locked,
        }
    }

    /// Ensures the low-noise HTTP streaming server is running. It serves untouched
    /// Ensures the low-noise HTTP streaming server is running. It serves untouched
    /// FLAC/WAV/DSD bytes (bit-perfect) from page-locked RAM with paced delivery.
    pub fn ensure_http_server(&self) {
        if self.server_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let port = self.http_port;
        let current = Arc::clone(&self.current_stream);

        std::thread::Builder::new()
            .name("cadence-upnp-listener".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();

                rt.block_on(async move {
                    let addr = SocketAddr::from(([0, 0, 0, 0], port));
                    let listener = match TcpListener::bind(addr).await {
                        Ok(l) => {
                            eprintln!("[Cadence UPnP Streamer] Listening on http://0.0.0.0:{}", port);
                            l
                        }
                        Err(e) => {
                            eprintln!("[Cadence UPnP Streamer] Failed to bind HTTP port {}: {}", port, e);
                            return;
                        }
                    };

                    while let Ok((tokio_stream, _)) = listener.accept().await {
                        // Convert to std::net::TcpStream and hand off to a dedicated OS thread.
                        // CRITICAL: into_std() leaves the socket in non-blocking mode.
                        // We must explicitly switch back to blocking mode so synchronous write_all
                        // does not prematurely error out with WouldBlock (WSAEWOULDBLOCK) during
                        // fast-start pre-rolls or when TCP receive windows fill up.
                        match tokio_stream.into_std() {
                            Ok(std_stream) => {
                                if let Err(e) = std_stream.set_nonblocking(false) {
                                    eprintln!("[Cadence UPnP Streamer] Failed to set blocking socket mode: {}", e);
                                    continue;
                                }

                                // 10-second write timeout prevents infinite hangs if the renderer
                                // suddenly loses power or disconnects without sending TCP FIN/RST.
                                let _ = std_stream.set_write_timeout(Some(Duration::from_secs(10)));

                                let source_ref = Arc::clone(&current);
                                std::thread::Builder::new()
                                    .name("cadence-paced-stream".into())
                                    .spawn(move || {
                                        Self::handle_connection_sync(std_stream, source_ref);
                                    })
                                    .expect("failed to spawn dedicated paced streaming thread");
                            }
                            Err(e) => {
                                eprintln!("[Cadence UPnP Streamer] Failed to convert socket to std: {}", e);
                            }
                        }
                    }
                });
            })
            .expect("failed to spawn UPnP listener thread");
    }

    fn handle_connection_sync(mut stream: StdTcpStream, source_ref: Arc<Mutex<Option<Arc<StreamSource>>>>) {
        // Register this dedicated OS thread with Windows MMCSS Pro Audio, pin off Core 0/1,
        // and lock 1 ms timer resolution. Reverts cleanly on drop (even upon early socket broken-pipe).
        let _thread_guard = StreamingThreadGuard::acquire();
        let initial_fast_start = source_ref
            .lock()
            .as_ref()
            .map(|s| s.fast_start_sndbuf_bytes)
            .unwrap_or(stream_tuning::SOCKET_FAST_START_SNDBUF);
        configure_initial_socket(&stream, initial_fast_start);

        // Set a reasonable read timeout for parsing HTTP headers
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

        let mut buf = [0u8; 4096];
        let n = match stream.read(&mut buf) {
            Ok(n) if n > 0 => n,
            _ => return,
        };

        let request = String::from_utf8_lossy(&buf[..n]);
        let method = request.split_whitespace().next().unwrap_or("");
        let is_head = method == "HEAD";
        if method != "GET" && !is_head {
            let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
            return;
        }

        let snapshot = source_ref.lock().clone();
        let source = match snapshot {
            Some(s) if matches!(s.mode, BufferMode::WholeTrack(_)) || s.path.exists() => s,
            _ => {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                return;
            }
        };

        let len = source.len;
        let range_header = request
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("range:"))
            .and_then(|l| l.splitn(2, ':').nth(1))
            .map(|v| v.trim().to_string());

        let (start, end, header) = match range_header {
            Some(r) => match parse_range(&r, len) {
                Ok((start, end)) => (
                    start,
                    end,
                    format!(
                        "HTTP/1.1 206 Partial Content\r\n\
                         Content-Type: {}\r\n\
                         Content-Range: bytes {}-{}/{}\r\n\
                         Content-Length: {}\r\n\
                         Accept-Ranges: bytes\r\n\
                         transferMode.dlna.org: Streaming\r\n\
                         Connection: close\r\n\r\n",
                        source.content_type, start, end, len, end - start + 1
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
                    source.content_type, len
                ),
            ),
        };

        // Detect if this is an ID3v2 / album artwork fetch:
        // 1. In DSF files, metadata chunk is pointed to by metadata_offset.
        // 2. In general audio files, requests near the tail end of the file (within 10 MB of EOF)
        //    for < 5 MB slices are reading embedded cover art / metadata.
        let is_metadata_request = if let Some(meta_off) = source.metadata_offset {
            meta_off > 0 && start >= meta_off
        } else {
            start >= len.saturating_sub(10 * 1024 * 1024) && (end - start + 1) < 5 * 1024 * 1024
        };

        let is_range_continuation = !is_metadata_request && start >= 1024 * 1024;

        // Socket send buffer:
        // - Range continuation (start >= 1 MB): steady-state clamped to 32 KB ceiling to physically prevent micro-bursts.
        // - Initial playback start (start < 1 MB): fast-start send buffer for initial 512 KB pre-roll.
        let sock = socket2::SockRef::from(&stream);
        if is_range_continuation {
            let _ = sock.set_send_buffer_size(source.sndbuf_bytes);
        } else if source.fast_start_sndbuf_bytes != initial_fast_start {
            let _ = sock.set_send_buffer_size(source.fast_start_sndbuf_bytes);
        }

        if stream.write_all(header.as_bytes()).is_err() || is_head || len == 0 {
            return;
        }

        if is_metadata_request {
            eprintln!(
                "[Cadence UPnP Streamer] Serving metadata / cover art bytes {}-{} of {} (unpaced wire-speed)",
                start, end, len
            );
        } else {
            eprintln!(
                "[Cadence UPnP Streamer] Serving audio bytes {}-{} of {} (Range continuation: {})",
                start, end, len, is_range_continuation
            );
        }

        // Disable read timeout during the active streaming phase
        let _ = stream.set_read_timeout(None);

        let mut pacer = SynchronousPacer::new(&source, start, is_metadata_request);

        match &source.mode {
            BufferMode::WholeTrack(ram) => {
                // Zero-copy, zero-allocation: write fixed-size slices of the locked buffer.
                let body = &ram.as_slice()[start as usize..=end as usize];
                for chunk in body.chunks(stream_tuning::CHUNK_BYTES) {
                    let t0 = Instant::now();
                    if stream.write_all(chunk).is_err() {
                        return;
                    }
                    let write_block_dur = t0.elapsed();
                    pacer.on_chunk_sent(&mut stream, chunk.len(), write_block_dur);
                }
            }
            BufferMode::Windowed { window_bytes } => {
                Self::stream_windowed_sync(&mut stream, &source.path, start, end, *window_bytes, &mut pacer);
            }
        }
        let _ = stream.flush();
    }

    /// Serve `start..=end` from page-locked read-ahead windows on the dedicated OS thread.
    /// Double ping-pong buffering: while one window is being paced out, the next is
    /// prefetched in a single background thread read, keeping disk seeks down to once
    /// per window. The prefetch thread runs with normal priority outside MMCSS.
    fn stream_windowed_sync(
        stream: &mut StdTcpStream,
        path: &Path,
        start: u64,
        end: u64,
        window_bytes: u64,
        pacer: &mut SynchronousPacer,
    ) {
        let spawn_load = |offset: u64, len: u64| {
            let p = path.to_path_buf();
            std::thread::Builder::new()
                .name("cadence-disk-prefetch".into())
                .spawn(move || {
                    stream_tuning::set_prefetch_thread_priority();
                    LockedBuffer::load_range(&p, offset, len)
                })
                .expect("failed to spawn disk prefetch thread")
        };



        let mut pos = start;
        let first_len = (end - pos + 1).min(stream_tuning::first_window_bytes(window_bytes));
        let mut pending = Some(spawn_load(pos, first_len));

        while let Some(handle) = pending.take() {
            let window = match handle.join() {
                Ok(Ok(buf)) if !buf.as_slice().is_empty() => buf,
                Ok(Err(e)) => {
                    eprintln!("[Cadence UPnP Streamer] Window read failed at {}: {}", pos, e);
                    return;
                }
                _ => return,
            };

            let next_pos = pos + window.as_slice().len() as u64;
            if next_pos <= end {
                pending = Some(spawn_load(next_pos, (end - next_pos + 1).min(window_bytes)));
            }

            for chunk in window.as_slice().chunks(stream_tuning::CHUNK_BYTES) {
                let t0 = Instant::now();
                if stream.write_all(chunk).is_err() {
                    return;
                }
                let write_block_dur = t0.elapsed();
                pacer.on_chunk_sent(stream, chunk.len(), write_block_dur);
            }
            pos = next_pos;
        }
    }



    /// Discover UPnP / DLNA MediaRenderer devices on the LAN using SSDP M-SEARCH
    pub async fn discover_devices(&self) -> Vec<UpnpDevice> {
        let mut discovered = Vec::new();
        let socket = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Cadence UPnP] Failed to bind SSDP socket: {}", e);
                return self.devices.lock().clone();
            }
        };

        let msearch_msg = "M-SEARCH * HTTP/1.1\r\n\
                           HOST: 239.255.255.250:1900\r\n\
                           MAN: \"ssdp:discover\"\r\n\
                           MX: 2\r\n\
                           ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";

        let _ = socket.send_to(msearch_msg.as_bytes(), "239.255.255.250:1900").await;

        // Also search for all devices to catch renderers that don't match the specific ST
        let msearch_all = "M-SEARCH * HTTP/1.1\r\n\
                           HOST: 239.255.255.250:1900\r\n\
                           MAN: \"ssdp:discover\"\r\n\
                           MX: 2\r\n\
                           ST: ssdp:all\r\n\r\n";
        let _ = socket.send_to(msearch_all.as_bytes(), "239.255.255.250:1900").await;

        let mut buf = [0u8; 4096];
        let start = std::time::Instant::now();
        let mut locations = Vec::new();

        while start.elapsed() < Duration::from_millis(1500) {
            match timeout(Duration::from_millis(300), socket.recv_from(&mut buf)).await {
                Ok(Ok((len, _addr))) => {
                    let resp = String::from_utf8_lossy(&buf[..len]);
                    for line in resp.lines() {
                        let lower = line.to_lowercase();
                        if lower.starts_with("location:") {
                            if let Some(loc) = line.splitn(2, ':').nth(1) {
                                let loc_str = loc.trim().to_string();
                                if !locations.contains(&loc_str) {
                                    locations.push(loc_str);
                                }
                            }
                        }
                    }
                }
                _ => break,
            }
        }

        // Also include locations of previously discovered devices so that transient Wi-Fi multicast drops don't lose them
        {
            let guard = self.devices.lock();
            for dev in guard.iter() {
                if !locations.contains(&dev.location) {
                    locations.push(dev.location.clone());
                }
            }
        }

        // Direct static unicast fallback candidates (empty by default; can be populated from user network settings)
        let static_candidates: [&str; 0] = [];
        for cand in static_candidates {
            let cand_str = cand.to_string();
            if !locations.contains(&cand_str) {
                locations.push(cand_str);
            }
        }

        // Fetch description XML for each unique location
        for loc in locations {
            if let Some(device) = Self::parse_device_description(&loc).await {
                if !discovered.iter().any(|d: &UpnpDevice| d.id == device.id || d.control_url == device.control_url) {
                    discovered.push(device);
                }
            }
        }

        // Sort discovered devices by priority score descending:
        // Dedicated audiophile streamers (HiFi Rose, Anthem AVM) will always be first,
        // while monitors/TVs (Odyssey OLED G8) will be sorted to the bottom.
        discovered.sort_by(|a, b| b.priority_score().cmp(&a.priority_score()));

        // Update cached devices
        let mut guard = self.devices.lock();
        *guard = discovered.clone();
        discovered
    }

    /// Fetch and parse the UPnP XML description
    async fn parse_device_description(location_url: &str) -> Option<UpnpDevice> {
        let (host, port, path) = Self::parse_url(location_url)?;
        let addr = format!("{}:{}", host, port);

        let mut stream = timeout(Duration::from_millis(1000), TcpStream::connect(&addr)).await.ok()?.ok()?;

        let req = format!(
            "GET {} HTTP/1.1\r\n\
             Host: {}\r\n\
             Connection: close\r\n\r\n",
            path, host
        );
        stream.write_all(req.as_bytes()).await.ok()?;

        let mut response = String::new();
        stream.read_to_string(&mut response).await.ok()?;

        // Check if device implements AVTransport
        if !response.contains("urn:schemas-upnp-org:service:AVTransport") && !response.contains("AVTransport") {
            return None;
        }

        let friendly_name = Self::extract_xml_tag(&response, "friendlyName")
            .unwrap_or_else(|| "Network Audio Streamer".to_string());
        let model_name = Self::extract_xml_tag(&response, "modelName");
        let model_description = Self::extract_xml_tag(&response, "modelDescription");
        let manufacturer = Self::extract_xml_tag(&response, "manufacturer");
        let udn = Self::extract_xml_tag(&response, "UDN")
            .unwrap_or_else(|| format!("uuid:{}", friendly_name.replace(' ', "_")));

        let raw_control_url = Self::extract_avtransport_control_url(&response)
            .unwrap_or_else(|| "/AVTransport/control".to_string());

        let control_url = if raw_control_url.starts_with("http") {
            raw_control_url
        } else {
            let base = format!("http://{}:{}", host, port);
            if raw_control_url.starts_with('/') {
                format!("{}{}", base, raw_control_url)
            } else {
                format!("{}/{}", base, raw_control_url)
            }
        };

        Some(UpnpDevice {
            id: udn,
            friendly_name,
            model_name,
            model_description,
            manufacturer,
            location: location_url.to_string(),
            control_url,
        })
    }

    fn parse_url(url: &str) -> Option<(String, u16, String)> {
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
        let open_tag = format!("<{}>", tag);
        let close_tag = format!("</{}>", tag);
        let start = xml.find(&open_tag)? + open_tag.len();
        let end = xml[start..].find(&close_tag)? + start;
        Some(xml[start..end].trim().to_string())
    }

    fn extract_avtransport_control_url(xml: &str) -> Option<String> {
        let pos = xml.find("urn:schemas-upnp-org:service:AVTransport")?;
        let section = &xml[pos..];
        let end_service = section.find("</service>")?;
        let service_xml = &section[..end_service];
        Self::extract_xml_tag(service_xml, "controlURL")
    }

    /// Set active UPnP device by friendly name, ID, model, or partial match
    pub fn set_active_device(&self, name_or_id: &str) -> Result<(), String> {
        let clean = name_or_id.trim_start_matches("[UPnP]").trim();
        let clean_lower = clean.to_lowercase();
        let devices = self.devices.lock();

        let matches_device = |d: &UpnpDevice| -> bool {
            if d.id == name_or_id || d.friendly_name == name_or_id || format!("[UPnP] {}", d.friendly_name) == name_or_id {
                return true;
            }
            let fn_lower = d.friendly_name.to_lowercase();
            let mn_lower = d.model_name.as_deref().map(|s| s.to_lowercase()).unwrap_or_default();
            let md_lower = d.model_description.as_deref().map(|s| s.to_lowercase()).unwrap_or_default();
            let mfg_lower = d.manufacturer.as_deref().map(|s| s.to_lowercase()).unwrap_or_default();

            // Direct equality (case-insensitive)
            if fn_lower == clean_lower || mn_lower == clean_lower || md_lower == clean_lower {
                return true;
            }

            // Mutual substring containment (e.g. "hifi rose (Rose-67)" contains "rose-67" or "hifi rose")
            if fn_lower.contains(&clean_lower) || clean_lower.contains(&fn_lower) {
                return true;
            }
            if !mn_lower.is_empty() && (mn_lower.contains(&clean_lower) || clean_lower.contains(&mn_lower)) {
                return true;
            }
            if !md_lower.is_empty() && (md_lower.contains(&clean_lower) || clean_lower.contains(&md_lower)) {
                return true;
            }
            if !mfg_lower.is_empty() && (mfg_lower.contains(&clean_lower) || clean_lower.contains(&mfg_lower)) {
                return true;
            }

            // Keyword matching: e.g. "rose" in both
            if (clean_lower.contains("rose") || clean_lower.contains("rs130"))
                && (fn_lower.contains("rose") || md_lower.contains("rose") || mn_lower.contains("rs130")) {
                return true;
            }

            // AVM / Anthem matching
            if (clean_lower.contains("avm") || clean_lower.contains("anthem"))
                && (fn_lower.contains("avm") || fn_lower.contains("anthem")) {
                return true;
            }

            false
        };

        let found = devices.iter().find(|d| matches_device(d)).cloned();

        match found {
            Some(dev) => {
                eprintln!(
                    "[Cadence UPnP] Active device successfully set to '{}' ({:?}) at {}",
                    dev.friendly_name, dev.model_name, dev.control_url
                );
                let mut active = self.active_device.lock();
                *active = Some(dev);
                Ok(())
            }
            None => {
                drop(devices);
                // Attempt synchronous SSDP discovery if cache was empty or device was newly connected
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                if let Ok(runtime) = rt {
                    let discovered = runtime.block_on(async { self.discover_devices().await });
                    let found_retry = discovered.into_iter().find(|d| matches_device(d));
                    if let Some(dev) = found_retry {
                        eprintln!(
                            "[Cadence UPnP] Discovered and set active device to '{}' ({:?}) at {}",
                            dev.friendly_name, dev.model_name, dev.control_url
                        );
                        let mut active = self.active_device.lock();
                        *active = Some(dev);
                        return Ok(());
                    }
                }
                Err(format!("UPnP device '{}' not found", name_or_id))
            }
        }
    }

    pub fn get_devices(&self) -> Vec<UpnpDevice> {
        self.devices.lock().clone()
    }

    pub fn get_active_device(&self) -> Option<UpnpDevice> {
        self.active_device.lock().clone()
    }

    pub fn clear_active_device(&self) {
        let mut active = self.active_device.lock();
        *active = None;
    }

    fn escape_xml(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// Play a local file through the active UPnP renderer
    pub async fn play_file(
        &self,
        file_path: &Path,
        duration_secs: f64,
        title: &str,
        artist: &str,
        album: &str,
    ) -> Result<(), String> {
        let device = {
            let mut active = self.active_device.lock();
            let should_reselect = match active.as_ref() {
                None => true,
                Some(current) => current.is_display_device(),
            };
            if should_reselect {
                let devs = self.devices.lock();
                if let Some(best) = devs.iter().find(|d| !d.is_display_device()).cloned() {
                    eprintln!(
                        "[Cadence UPnP Streamer] Overriding display device with dedicated network streamer '{}' (score {}) for playback",
                        best.friendly_name, best.priority_score()
                    );
                    *active = Some(best);
                }
            }
            active
                .clone()
                .ok_or_else(|| "No active UPnP audio streamer selected. Please select your network streamer in Audio Outputs.".to_string())?
        };

        eprintln!(
            "[Cadence UPnP Streamer] Initiating bit-perfect stream to '{}' [{}] at {}",
            device.friendly_name,
            device.model_name.as_deref().unwrap_or(""),
            device.control_url
        );

        // Pre-load the untouched file into page-locked RAM before the renderer
        // starts pulling, so storage is idle for the duration of playback.
        let already_loaded = self
            .current_stream
            .lock()
            .as_ref()
            .map(|s| s.path == file_path && matches!(s.mode, BufferMode::WholeTrack(_)))
            .unwrap_or(false);
        if !already_loaded {
            // Release the previous track's buffer first so peak RAM isn't old + new.
            *self.current_stream.lock() = None;
            let limit_mb = self.buffer_limit_mb.load(Ordering::SeqCst);
            let source = StreamSource::prepare(file_path, duration_secs, limit_mb)?;
            *self.current_stream.lock() = Some(Arc::new(source));
        }

        let lan_ip = Self::get_local_lan_ip();
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("flac")
            .to_lowercase();
        let stream_url = format!("http://{}:{}/stream.{}", lan_ip, self.http_port, ext);

        let mime_type = match ext.as_str() {
            "flac" => "audio/flac",
            "wav" => "audio/wav",
            "dsf" | "dff" => "audio/x-dsd",
            "mp3" => "audio/mpeg",
            "m4a" | "alac" => "audio/mp4",
            "ogg" => "audio/ogg",
            _ => "audio/flac",
        };

        let safe_title = Self::escape_xml(if title.is_empty() { "Cadence Track" } else { title });
        let safe_artist = Self::escape_xml(if artist.is_empty() { "Unknown Artist" } else { artist });
        let safe_album = Self::escape_xml(if album.is_empty() { "Album" } else { album });

        let res_elements = if ext == "dsf" || ext == "dff" {
            format!(
                "&lt;res protocolInfo=\"http-get:*:audio/x-dsd:*\"&gt;{}&lt;/res&gt;\
                 &lt;res protocolInfo=\"http-get:*:audio/dsf:*\"&gt;{}&lt;/res&gt;",
                stream_url, stream_url
            )
        } else {
            format!("&lt;res protocolInfo=\"http-get:*:{}:*\"&gt;{}&lt;/res&gt;", mime_type, stream_url)
        };

        let didl_metadata = format!(
            "&lt;DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"&gt;\
               &lt;item id=\"0\" parentID=\"0\" restricted=\"1\"&gt;\
                 &lt;dc:title&gt;{}&lt;/dc:title&gt;\
                 &lt;dc:creator&gt;{}&lt;/dc:creator&gt;\
                 &lt;upnp:album&gt;{}&lt;/upnp:album&gt;\
                 &lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;\
                 {}\
               &lt;/item&gt;\
             &lt;/DIDL-Lite&gt;",
            safe_title, safe_artist, safe_album, res_elements
        );

        // 1. Send SetAVTransportURI
        let set_uri_soap = format!(
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
            stream_url, didl_metadata
        );

        Self::send_soap_action(
            &device.control_url,
            "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI",
            &set_uri_soap,
        )
        .await?;

        // 2. Send Play action
        let play_soap = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
                         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
                           <s:Body>\
                             <u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
                               <InstanceID>0</InstanceID>\
                               <Speed>1</Speed>\
                             </u:Play>\
                           </s:Body>\
                         </s:Envelope>";

        Self::send_soap_action(
            &device.control_url,
            "urn:schemas-upnp-org:service:AVTransport:1#Play",
            play_soap,
        )
        .await?;

        // Update playback state
        {
            let mut state = self.playback_state.lock();
            state.is_playing = true;
            state.is_paused = false;
            state.current_uri = Some(stream_url);
            state.current_file = Some(file_path.to_string_lossy().to_string());
            state.position_secs = 0.0;
            state.duration_secs = duration_secs;
        }

        Ok(())
    }

    pub async fn pause(&self) -> Result<(), String> {
        let device = self
            .active_device
            .lock()
            .clone()
            .ok_or_else(|| "No active UPnP device selected".to_string())?;

        let pause_soap = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
                          <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
                            <s:Body>\
                              <u:Pause xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
                                <InstanceID>0</InstanceID>\
                              </u:Pause>\
                            </s:Body>\
                          </s:Envelope>";

        Self::send_soap_action(
            &device.control_url,
            "urn:schemas-upnp-org:service:AVTransport:1#Pause",
            pause_soap,
        )
        .await?;

        let mut state = self.playback_state.lock();
        state.is_paused = true;
        state.is_playing = false;
        Ok(())
    }

    pub async fn resume(&self) -> Result<(), String> {
        let device = self
            .active_device
            .lock()
            .clone()
            .ok_or_else(|| "No active UPnP device selected".to_string())?;

        let play_soap = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
                         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
                           <s:Body>\
                             <u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
                               <InstanceID>0</InstanceID>\
                               <Speed>1</Speed>\
                             </u:Play>\
                           </s:Body>\
                         </s:Envelope>";

        Self::send_soap_action(
            &device.control_url,
            "urn:schemas-upnp-org:service:AVTransport:1#Play",
            play_soap,
        )
        .await?;

        let mut state = self.playback_state.lock();
        state.is_paused = false;
        state.is_playing = true;
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let device = match self.active_device.lock().clone() {
            Some(d) => d,
            None => return Ok(()),
        };

        let stop_soap = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
                         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
                           <s:Body>\
                             <u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
                               <InstanceID>0</InstanceID>\
                             </u:Stop>\
                           </s:Body>\
                         </s:Envelope>";

        let _ = Self::send_soap_action(
            &device.control_url,
            "urn:schemas-upnp-org:service:AVTransport:1#Stop",
            stop_soap,
        )
        .await;

        let mut state = self.playback_state.lock();
        state.is_playing = false;
        state.is_paused = false;
        state.position_secs = 0.0;
        drop(state);
        // Free the page-locked track buffer while idle (in-flight requests keep
        // their own reference until they finish).
        *self.current_stream.lock() = None;
        Ok(())
    }

    pub fn get_playback_state(&self) -> UpnpPlaybackState {
        self.playback_state.lock().clone()
    }

    /// Send a SOAP action over HTTP POST
    async fn send_soap_action(control_url: &str, soap_action: &str, body: &str) -> Result<String, String> {
        let (host, port, path) = Self::parse_url(control_url)
            .ok_or_else(|| format!("Invalid control URL: {}", control_url))?;

        let addr = format!("{}:{}", host, port);
        let mut stream = timeout(Duration::from_millis(2000), TcpStream::connect(&addr))
            .await
            .map_err(|_| "UPnP connection timeout".to_string())?
            .map_err(|e| format!("Failed to connect to UPnP renderer: {}", e))?;

        let request = format!(
            "POST {} HTTP/1.1\r\n\
             Host: {}:{}\r\n\
             Content-Type: text/xml; charset=\"utf-8\"\r\n\
             Content-Length: {}\r\n\
             SOAPACTION: \"{}\"\r\n\
             Connection: close\r\n\r\n\
             {}",
            path,
            host,
            port,
            body.as_bytes().len(),
            soap_action,
            body
        );

        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("Failed to send SOAP request: {}", e))?;

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .await
            .map_err(|e| format!("Failed to read SOAP response: {}", e))?;

        if response.contains("200 OK") {
            Ok(response)
        } else {
            let err_desc = Self::extract_xml_tag(&response, "errorDescription")
                .or_else(|| Self::extract_xml_tag(&response, "faultstring"))
                .unwrap_or_else(|| response.lines().next().unwrap_or("Unknown error").to_string());
            Err(format!("UPnP device returned error: {}", err_desc))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_priority_and_display_detection() {
        let rose = UpnpDevice {
            id: "uuid:00000000-0000-0000-0000-000000000001".into(),
            friendly_name: "ROSE-67".into(),
            model_name: Some("RS130".into()),
            model_description: Some("HiFi ROSE".into()),
            manufacturer: Some("CITECH".into()),
            location: "http://192.0.2.10:34042/desc".into(),
            control_url: "http://192.0.2.10:34042/action".into(),
        };

        let avm = UpnpDevice {
            id: "uuid:00000000-0000-0000-0000-000000000002".into(),
            friendly_name: "Hifi Cine AVM 70".into(),
            model_name: Some("AVM 70".into()),
            model_description: Some("Anthem A/V Processor".into()),
            manufacturer: Some("Anthem".into()),
            location: "http://192.0.2.20:34929/desc".into(),
            control_url: "http://192.0.2.20:34929/action".into(),
        };

        let monitor = UpnpDevice {
            id: "uuid:00000000-0000-0000-0000-000000000003".into(),
            friendly_name: "34\" Odyssey OLED G8".into(),
            model_name: Some("Odyssey OLED G8".into()),
            model_description: Some("Samsung OLED Monitor".into()),
            manufacturer: Some("Samsung Electronics".into()),
            location: "http://192.0.2.30:9197/dmr".into(),
            control_url: "http://192.0.2.30:9197/action".into(),
        };

        // Priority scoring: Audiophile streamers must score significantly higher than display monitors
        assert!(rose.priority_score() > avm.priority_score());
        assert!(avm.priority_score() > monitor.priority_score());
        assert!(rose.priority_score() >= 300);
        assert!(monitor.priority_score() < 0);

        // Display detection: monitor must be flagged as display, streamers must not
        assert!(monitor.is_display_device());
        assert!(!rose.is_display_device());
        assert!(!avm.is_display_device());
    }

    #[test]
    fn test_smart_device_matching() {
        let manager = UpnpManager::new();
        let rose = UpnpDevice {
            id: "uuid:00000000-0000-0000-0000-000000000001".into(),
            friendly_name: "ROSE-67".into(),
            model_name: Some("RS130".into()),
            model_description: Some("HiFi ROSE".into()),
            manufacturer: Some("CITECH".into()),
            location: "http://192.0.2.10:34042/desc".into(),
            control_url: "http://192.0.2.10:34042/action".into(),
        };

        let monitor = UpnpDevice {
            id: "uuid:00000000-0000-0000-0000-000000000003".into(),
            friendly_name: "34\" Odyssey OLED G8".into(),
            model_name: Some("Odyssey OLED G8".into()),
            model_description: Some("Samsung OLED Monitor".into()),
            manufacturer: Some("Samsung Electronics".into()),
            location: "http://192.0.2.30:9197/dmr".into(),
            control_url: "http://192.0.2.30:9197/action".into(),
        };

        // Cache devices in reverse order (monitor first, as SSDP often returns)
        *manager.devices.lock() = vec![monitor, rose];

        // 1. Match exact friendly name
        assert!(manager.set_active_device("ROSE-67").is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");

        // 2. Match with [UPnP] prefix
        assert!(manager.set_active_device("[UPnP] ROSE-67").is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");

        // 3. Match user phrase "hifi rose (Rose-67)"
        assert!(manager.set_active_device("hifi rose (Rose-67)").is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");

        // 4. Match brand "HiFi Rose"
        assert!(manager.set_active_device("HiFi Rose").is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");

        // 5. Match model "RS130"
        assert!(manager.set_active_device("RS130").is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");
    }
}
