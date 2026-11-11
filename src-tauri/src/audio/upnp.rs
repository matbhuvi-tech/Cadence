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
use super::upnp_pacer::{PacerConfig, SynchronousPacer, UpnpPacingMetrics};
pub use super::upnp_pacer::UpnpPacingSnapshot;
use crate::diag_log;
use crate::diagnostics::{self, DiagCategory};

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
    /// Bounded initial headroom target in ms for `InitialFill` (default: 1200 ms).
    initial_lead_target_ms: u64,
    /// Monotonic audio payload progress across sequential HTTP Range connections.
    has_streamed_audio: AtomicBool,
    last_audio_end_offset: AtomicU64,
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

        let initial_lead_target_ms = std::env::var("CADENCE_INITIAL_LEAD_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|ms| ms.clamp(150, 2500))
            .unwrap_or_else(|| PacerConfig::default().initial_lead_target_ms);

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
            initial_lead_target_ms,
            has_streamed_audio: AtomicBool::new(false),
            last_audio_end_offset: AtomicU64::new(0),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    discovery_gen: Arc<AtomicU64>,
    pacing_metrics: Arc<UpnpPacingMetrics>,
    playback_paused: Arc<AtomicBool>,
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
            discovery_gen: Arc::new(AtomicU64::new(0)),
            pacing_metrics: Arc::new(UpnpPacingMetrics::default()),
            playback_paused: Arc::new(AtomicBool::new(false)),
        };

        manager.ensure_http_server();
        manager
    }

    pub fn get_pacing_stats(&self) -> UpnpPacingSnapshot {
        self.pacing_metrics.snapshot()
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
        let pacing_metrics = Arc::clone(&self.pacing_metrics);
        let paused_flag = Arc::clone(&self.playback_paused);

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
                            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, 0, "upnp_http_server_listening", "port={}", port);
                            l
                        }
                        Err(e) => {
                            eprintln!("[Cadence UPnP Streamer] Failed to bind HTTP port {}: {}", port, e);
                            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, 0, "upnp_http_server_bind_failed", "port={} err={}", port, e);
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
                                let metrics_ref = Arc::clone(&pacing_metrics);
                                let paused_ref = Arc::clone(&paused_flag);
                                std::thread::Builder::new()
                                    .name("cadence-paced-stream".into())
                                    .spawn(move || {
                                        Self::handle_connection_sync(
                                            std_stream,
                                            source_ref,
                                            metrics_ref,
                                            paused_ref,
                                        );
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

    fn handle_connection_sync(
        mut stream: StdTcpStream,
        source_ref: Arc<Mutex<Option<Arc<StreamSource>>>>,
        pacing_metrics: Arc<UpnpPacingMetrics>,
        playback_paused: Arc<AtomicBool>,
    ) {
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
            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, 0, "upnp_http_error", "status=405 method={}", method);
            let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
            return;
        }

        let snapshot = source_ref.lock().clone();
        let source = match snapshot {
            Some(s) if matches!(s.mode, BufferMode::WholeTrack(_)) || s.path.exists() => s,
            _ => {
                diag_log!(DiagCategory::UpnpLifecycle, 0, 0, 0, "upnp_http_error", "status=404 reason=no_active_stream");
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
        let is_contiguous_reconnect = if is_range_continuation
            && source.has_streamed_audio.load(Ordering::Acquire)
        {
            let prev_end = source.last_audio_end_offset.load(Ordering::Acquire);
            start >= prev_end.saturating_sub(256 * 1024)
                && start <= prev_end.saturating_add(512 * 1024)
        } else {
            false
        };
        let track_audio_progress =
            !is_metadata_request && !(start >= len / 2 && (end - start + 1) <= 256 * 1024);

        if !is_metadata_request {
            pacing_metrics
                .fast_start_sndbuf_bytes
                .store(source.fast_start_sndbuf_bytes as u64, Ordering::Relaxed);
        }

        // Socket send buffer:
        // - Range continuation (start >= 1 MB): steady-state clamped to 32 KB ceiling to physically prevent micro-bursts.
        // - Initial playback start (start < 1 MB): fast-start send buffer for initial 512 KB pre-roll.
        let sock = socket2::SockRef::from(&stream);
        if is_range_continuation {
            let _ = sock.set_send_buffer_size(source.sndbuf_bytes);
            if let Ok(actual) = sock.send_buffer_size() {
                pacing_metrics
                    .actual_sndbuf_bytes
                    .store(actual as u64, Ordering::Relaxed);
            }
        } else if source.fast_start_sndbuf_bytes != initial_fast_start {
            let _ = sock.set_send_buffer_size(source.fast_start_sndbuf_bytes);
        }

        if stream.write_all(header.as_bytes()).is_err() || is_head || len == 0 {
            diag_log!(
                DiagCategory::UpnpLifecycle,
                0,
                0,
                0,
                "upnp_http_connect",
                "method={} range={}-{} len={} meta={}",
                method,
                start,
                end,
                len,
                is_metadata_request
            );
            return;
        }

        diag_log!(
            DiagCategory::UpnpLifecycle,
            0,
            0,
            0,
            "upnp_http_connect",
            "method={} range={}-{} len={} meta={} range_cont={} contiguous={}",
            method,
            start,
            end,
            len,
            is_metadata_request,
            is_range_continuation,
            is_contiguous_reconnect
        );

        // Disable read timeout during the active streaming phase
        let _ = stream.set_read_timeout(None);

        if track_audio_progress {
            source.has_streamed_audio.store(true, Ordering::Release);
            source.last_audio_end_offset.store(start, Ordering::Release);
        }

        let mut config = PacerConfig::default();
        config.initial_lead_target_ms = source.initial_lead_target_ms;
        let mut pacer = SynchronousPacer::with_config(
            config,
            source.realtime_bytes_per_sec,
            source.preroll_bytes,
            source.sndbuf_bytes,
            is_contiguous_reconnect,
            is_range_continuation,
            is_metadata_request,
            pacing_metrics,
            playback_paused,
        );

        match &source.mode {
            BufferMode::WholeTrack(ram) => {
                // Zero-copy, zero-allocation: write fixed-size slices of the locked buffer.
                let body = &ram.as_slice()[start as usize..=end as usize];
                if !Self::write_paced_chunks(
                    &mut stream,
                    body,
                    start,
                    &source,
                    track_audio_progress,
                    &mut pacer,
                ) {
                    return;
                }
            }
            BufferMode::Windowed { window_bytes } => {
                Self::stream_windowed_sync(
                    &mut stream,
                    &source,
                    start,
                    end,
                    *window_bytes,
                    track_audio_progress,
                    &mut pacer,
                );
            }
        }
        let _ = stream.flush();
    }

    fn write_paced_chunks(
        stream: &mut StdTcpStream,
        slice: &[u8],
        base_offset: u64,
        source: &StreamSource,
        track_progress: bool,
        pacer: &mut SynchronousPacer,
    ) -> bool {
        let mut offset = base_offset;
        for chunk in slice.chunks(stream_tuning::CHUNK_BYTES) {
            let t0 = Instant::now();
            if stream.write_all(chunk).is_err() {
                return false;
            }
            let write_block_dur = t0.elapsed();
            offset = offset.saturating_add(chunk.len() as u64);
            if track_progress {
                source.last_audio_end_offset.store(offset, Ordering::Release);
            }
            pacer.on_chunk_sent(stream, chunk.len(), write_block_dur);
        }
        true
    }

    /// Serve `start..=end` from page-locked read-ahead windows on the dedicated OS thread.
    /// Double ping-pong buffering: while one window is being paced out, the next is
    /// prefetched in a single background thread read, keeping disk seeks down to once
    /// per window. The prefetch thread runs with normal priority outside MMCSS.
    fn stream_windowed_sync(
        stream: &mut StdTcpStream,
        source: &StreamSource,
        start: u64,
        end: u64,
        window_bytes: u64,
        track_progress: bool,
        pacer: &mut SynchronousPacer,
    ) {
        let path = &source.path;
        let spawn_load = |offset: u64, len: u64| {
            let p = path.to_path_buf();
            std::thread::Builder::new()
                .name("cadence-disk-prefetch".into())
                .spawn(move || {
                    stream_tuning::set_prefetch_thread_priority();
                    let t0 = diagnostics::is_active().then(Instant::now);
                    let res = LockedBuffer::load_range(&p, offset, len);
                    let dur_us = t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                    match &res {
                        Ok(b) => diag_log!(
                            DiagCategory::BackgroundWorkers,
                            0,
                            0,
                            dur_us,
                            "window_prefetch_done",
                            "offset={} bytes={}",
                            offset,
                            b.as_slice().len()
                        ),
                        Err(e) => diag_log!(
                            DiagCategory::BackgroundWorkers,
                            0,
                            0,
                            dur_us,
                            "window_prefetch_failed",
                            "offset={} req_len={} err={}",
                            offset,
                            len,
                            e
                        ),
                    }
                    res
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
                    diag_log!(
                        DiagCategory::UpnpLifecycle,
                        0,
                        0,
                        0,
                        "upnp_window_read_failed",
                        "pos={} err={}",
                        pos,
                        e
                    );
                    return;
                }
                _ => return,
            };
            pacer.metrics.window_reads.fetch_add(1, Ordering::Relaxed);

            let next_pos = pos + window.as_slice().len() as u64;
            if next_pos <= end {
                pending = Some(spawn_load(next_pos, (end - next_pos + 1).min(window_bytes)));
            }

            if !Self::write_paced_chunks(
                stream,
                window.as_slice(),
                pos,
                source,
                track_progress,
                pacer,
            ) {
                return;
            }
            pos = next_pos;
        }
    }



    /// Discover UPnP / DLNA MediaRenderer devices on the LAN using SSDP M-SEARCH
    pub async fn discover_devices(&self) -> Vec<UpnpDevice> {
        let gen = self.discovery_gen.fetch_add(1, Ordering::Relaxed) + 1;
        let disc_t0 = diagnostics::is_active().then(Instant::now);
        diag_log!(
            DiagCategory::DeviceDiscovery,
            gen,
            0,
            0,
            "ssdp_discovery_started",
            "gen={}",
            gen
        );
        let mut discovered = Vec::new();
        let socket = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Cadence UPnP] Failed to bind SSDP socket: {}", e);
                let dur_us = disc_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                diag_log!(
                    DiagCategory::DeviceDiscovery,
                    gen,
                    0,
                    dur_us,
                    "ssdp_discovery_failed",
                    "gen={} err=bind_failed:{}",
                    gen,
                    e
                );
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
        let loc_count = locations.len();
        for loc in locations {
            if let Some(device) = Self::parse_device_description(&loc).await {
                if !discovered.iter().any(|d: &UpnpDevice| d.id == device.id || d.control_url == device.control_url) {
                    diag_log!(
                        DiagCategory::DeviceDiscovery,
                        gen,
                        0,
                        0,
                        "ssdp_device_found",
                        "gen={} udn={} name={} model={:?}",
                        gen,
                        device.id,
                        device.friendly_name,
                        device.model_name
                    );
                    discovered.push(device);
                }
            } else {
                diag_log!(
                    DiagCategory::DeviceDiscovery,
                    gen,
                    0,
                    0,
                    "ssdp_desc_skipped",
                    "gen={} location={}",
                    gen,
                    loc
                );
            }
        }

        // Sort discovered devices by priority score descending:
        // Dedicated audiophile streamers (HiFi Rose, Anthem AVM) will always be first,
        // while monitors/TVs (Odyssey OLED G8) will be sorted to the bottom.
        discovered.sort_by(|a, b| b.priority_score().cmp(&a.priority_score()));

        let dur_us = disc_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
        diag_log!(
            DiagCategory::DeviceDiscovery,
            gen,
            0,
            dur_us,
            "ssdp_discovery_completed",
            "gen={} locations={} devices={}",
            gen,
            loc_count,
            discovered.len()
        );

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

    /// Resolve a UPnP device from the cached inventory strictly by UDN (`upnp:<udn>` or `uuid:...`)
    /// or exact `[UPnP] <friendly_name>` label. Never performs substring matching or network discovery.
    pub fn find_device_exact(&self, target: &str) -> Option<UpnpDevice> {
        let devices = self.devices.lock();
        if let Some(udn) = target.strip_prefix("upnp:") {
            return devices.iter().find(|d| d.id == udn).cloned();
        }
        if target.starts_with("uuid:") {
            return devices.iter().find(|d| d.id == target).cloned();
        }
        if let Some(friendly) = target.strip_prefix("[UPnP]") {
            let clean = friendly.trim();
            return devices.iter().find(|d| d.friendly_name == clean).cloned();
        }
        devices.iter().find(|d| d.id == target).cloned()
    }

    pub fn set_active_device_exact(&self, device: UpnpDevice) {
        eprintln!(
            "[Cadence UPnP] Active device explicitly set to '{}' ({}) at {}",
            device.friendly_name, device.id, device.control_url
        );
        let mut active = self.active_device.lock();
        *active = Some(device);
    }

    /// Set active UPnP device strictly by UDN or exact `[UPnP] <friendly_name>` label.
    /// Does not perform fuzzy substring matching or synchronous SSDP discovery.
    pub fn set_active_device(&self, name_or_id: &str) -> Result<(), String> {
        let found = self.find_device_exact(name_or_id);
        match found {
            Some(dev) => {
                self.set_active_device_exact(dev);
                Ok(())
            }
            None => Err(format!("UPnP device '{}' is unavailable", name_or_id)),
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

    /// Play a local file through an explicitly selected UPnP renderer by UDN.
    pub async fn play_file_on_device(
        &self,
        target_udn: &str,
        file_path: &Path,
        duration_secs: f64,
        title: &str,
        artist: &str,
        album: &str,
    ) -> Result<(), String> {
        let device = self
            .devices
            .lock()
            .iter()
            .find(|d| d.id == target_udn)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Selected UPnP renderer '{}' is unavailable.",
                    target_udn
                )
            })?;
        *self.active_device.lock() = Some(device.clone());

        self.play_file_with_device(device, file_path, duration_secs, title, artist, album)
            .await
    }

    /// Play a local file through the currently active UPnP renderer without implicit overrides.
    pub async fn play_file(
        &self,
        file_path: &Path,
        duration_secs: f64,
        title: &str,
        artist: &str,
        album: &str,
    ) -> Result<(), String> {
        let device = self
            .active_device
            .lock()
            .clone()
            .ok_or_else(|| {
                "No active UPnP audio streamer selected. Please select your network streamer in Audio Outputs.".to_string()
            })?;

        self.play_file_with_device(device, file_path, duration_secs, title, artist, album)
            .await
    }

    async fn play_file_with_device(
        &self,
        device: UpnpDevice,
        file_path: &Path,
        duration_secs: f64,
        title: &str,
        artist: &str,
        album: &str,
    ) -> Result<(), String> {

        eprintln!(
            "[Cadence UPnP Streamer] Initiating bit-perfect stream to '{}' [{}] at {}",
            device.friendly_name,
            device.model_name.as_deref().unwrap_or(""),
            device.control_url
        );
        diag_log!(
            DiagCategory::UpnpLifecycle,
            0,
            0,
            0,
            "upnp_play_dispatch",
            "udn={} name={} ctrl={} file={}",
            device.id,
            device.friendly_name,
            device.control_url,
            file_path.display()
        );

        self.playback_paused.store(false, Ordering::Release);
        self.pacing_metrics.reset_for_stream();

        // Pre-load the untouched file into page-locked RAM before the renderer
        // starts pulling, so storage is idle for the duration of playback.
        let reset_existing = {
            let guard = self.current_stream.lock();
            if let Some(s) = guard.as_ref() {
                if s.path == file_path && matches!(s.mode, BufferMode::WholeTrack(_)) {
                    s.has_streamed_audio.store(false, Ordering::Release);
                    s.last_audio_end_offset.store(0, Ordering::Release);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        if !reset_existing {
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

        diag_log!(
            DiagCategory::UpnpLifecycle,
            0,
            0,
            0,
            "upnp_transport_state",
            "state=paused udn={}",
            device.id
        );

        self.playback_paused.store(true, Ordering::Release);
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

        diag_log!(
            DiagCategory::UpnpLifecycle,
            0,
            0,
            0,
            "upnp_transport_state",
            "state=playing udn={}",
            device.id
        );

        self.playback_paused.store(false, Ordering::Release);
        let mut state = self.playback_state.lock();
        state.is_paused = false;
        state.is_playing = true;
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.playback_paused.store(false, Ordering::Release);
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

        let stop_res = Self::send_soap_action(
            &device.control_url,
            "urn:schemas-upnp-org:service:AVTransport:1#Stop",
            stop_soap,
        )
        .await;
        if let Err(ref e) = stop_res {
            diag_log!(
                DiagCategory::UpnpLifecycle,
                0,
                0,
                0,
                "upnp_transport_stop_err",
                "udn={} err={}",
                device.id,
                e
            );
        } else {
            diag_log!(
                DiagCategory::UpnpLifecycle,
                0,
                0,
                0,
                "upnp_transport_state",
                "state=stopped udn={}",
                device.id
            );
        }

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
        let action_short = soap_action.rsplit('#').next().unwrap_or(soap_action);
        let soap_t0 = diagnostics::is_active().then(Instant::now);
        diag_log!(
            DiagCategory::UpnpLifecycle,
            0,
            0,
            0,
            "soap_request_started",
            "action={} url={}",
            action_short,
            control_url
        );

        let (host, port, path) = Self::parse_url(control_url)
            .ok_or_else(|| format!("Invalid control URL: {}", control_url))?;

        let addr = format!("{}:{}", host, port);
        let mut stream = match timeout(Duration::from_millis(2000), TcpStream::connect(&addr)).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                let dur_us = soap_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                let msg = format!("Failed to connect to UPnP renderer: {}", e);
                diag_log!(DiagCategory::UpnpLifecycle, 0, 0, dur_us, "soap_connect_failed", "action={} addr={} err={}", action_short, addr, e);
                return Err(msg);
            }
            Err(_) => {
                let dur_us = soap_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                diag_log!(DiagCategory::UpnpLifecycle, 0, 0, dur_us, "soap_connect_timeout", "action={} addr={}", action_short, addr);
                return Err("UPnP connection timeout".to_string());
            }
        };

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

        if let Err(e) = stream.write_all(request.as_bytes()).await {
            let dur_us = soap_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, dur_us, "soap_write_failed", "action={} err={}", action_short, e);
            return Err(format!("Failed to send SOAP request: {}", e));
        }

        let mut response = String::new();
        if let Err(e) = stream.read_to_string(&mut response).await {
            let dur_us = soap_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, dur_us, "soap_read_failed", "action={} err={}", action_short, e);
            return Err(format!("Failed to read SOAP response: {}", e));
        }

        let dur_us = soap_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
        if response.contains("200 OK") {
            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, dur_us, "soap_request_completed", "action={} status=200", action_short);
            Ok(response)
        } else {
            let err_desc = Self::extract_xml_tag(&response, "errorDescription")
                .or_else(|| Self::extract_xml_tag(&response, "faultstring"))
                .unwrap_or_else(|| response.lines().next().unwrap_or("Unknown error").to_string());
            diag_log!(DiagCategory::UpnpLifecycle, 0, 0, dur_us, "soap_device_error", "action={} err={}", action_short, err_desc);
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
    fn test_exact_device_matching_rejects_fuzzy_substrings() {
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

        *manager.devices.lock() = vec![monitor, rose];

        // Typed ID & UDN must resolve strictly
        assert!(manager
            .set_active_device("upnp:uuid:00000000-0000-0000-0000-000000000001")
            .is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");

        // Switching explicitly to another UDN selects that exact renderer (no monitor override)
        assert!(manager
            .set_active_device("uuid:00000000-0000-0000-0000-000000000003")
            .is_ok());
        assert_eq!(
            manager.get_active_device().unwrap().id,
            "uuid:00000000-0000-0000-0000-000000000003"
        );

        // Explicit [UPnP] prefix + exact friendly_name works for legacy remote/PWA strings
        assert!(manager.set_active_device("[UPnP] ROSE-67").is_ok());
        assert_eq!(manager.get_active_device().unwrap().friendly_name, "ROSE-67");

        // Fuzzy substrings, model/brand names, and WASAPI names must never match a UPnP endpoint
        for non_matching in [
            "HiFi Rose",
            "RS130",
            "hifi rose (Rose-67)",
            "ROSE-67",
            "ROS",
            "Speakers (Game-Audeze Maxwell)",
            "Odyssey G85SB (NVIDIA High Definition Audio)",
        ] {
            assert!(
                manager.find_device_exact(non_matching).is_none(),
                "Expected '{}' not to match any UPnP endpoint",
                non_matching
            );
            assert!(
                manager.set_active_device(non_matching).is_err(),
                "Expected set_active_device('{}') to fail",
                non_matching
            );
        }
    }

    #[test]
    fn test_inventory_updates_and_missing_udn_behavior() {
        let manager = UpnpManager::new();
        assert!(manager.get_active_device().is_none());

        let rose = UpnpDevice {
            id: "uuid:00000000-0000-0000-0000-000000000001".into(),
            friendly_name: "ROSE-67".into(),
            model_name: Some("RS130".into()),
            model_description: Some("HiFi ROSE".into()),
            manufacturer: Some("CITECH".into()),
            location: "http://192.0.2.10:34042/desc".into(),
            control_url: "http://192.0.2.10:34042/action".into(),
        };

        // Updating inventory alone must never populate active_device
        *manager.devices.lock() = vec![rose.clone()];
        assert!(manager.get_active_device().is_none());

        // Attempting to play on an unknown/unavailable UDN must fail cleanly without substituting ROSE-67
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(manager.play_file_on_device(
                "uuid:00000000-0000-0000-0000-000000009999",
                Path::new("nonexistent.flac"),
                10.0,
                "Title",
                "Artist",
                "Album",
            ))
            .unwrap_err();
        assert!(err.contains("unavailable"));
        assert!(manager.get_active_device().is_none());
    }
}
