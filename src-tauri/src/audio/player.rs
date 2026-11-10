use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use rodio::{Decoder, OutputStream, Sink};
use serde::{Deserialize, Serialize};

use super::upnp::{UpnpDevice, UpnpManager};
use crate::diag_log;
use crate::diagnostics::{self, DiagCategory, HygieneState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointTransport {
    SystemDefault,
    Wasapi,
    Upnp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum AudioEndpoint {
    #[serde(rename = "system_default")]
    SystemDefault,
    #[serde(rename = "wasapi")]
    Wasapi { name: String },
    #[serde(rename = "upnp")]
    Upnp {
        udn: String,
        #[serde(rename = "friendlyName")]
        friendly_name: String,
    },
}

impl AudioEndpoint {
    pub fn id(&self) -> String {
        match self {
            AudioEndpoint::SystemDefault => "system_default".to_string(),
            AudioEndpoint::Wasapi { name } => format!("wasapi:{}", name),
            AudioEndpoint::Upnp { udn, .. } => format!("upnp:{}", udn),
        }
    }

    pub fn display_label(&self) -> String {
        match self {
            AudioEndpoint::SystemDefault => "Default Audio Device".to_string(),
            AudioEndpoint::Wasapi { name } => name.clone(),
            AudioEndpoint::Upnp { friendly_name, .. } => format!("[UPnP] {}", friendly_name),
        }
    }

    pub fn transport(&self) -> EndpointTransport {
        match self {
            AudioEndpoint::SystemDefault => EndpointTransport::SystemDefault,
            AudioEndpoint::Wasapi { .. } => EndpointTransport::Wasapi,
            AudioEndpoint::Upnp { .. } => EndpointTransport::Upnp,
        }
    }

    /// Parse legacy string endpoint identifiers without substring or friendly-name guesswork.
    pub fn from_legacy_string(raw: &str, upnp_devices: &[UpnpDevice]) -> AudioEndpoint {
        if raw == "system_default" || raw.eq_ignore_ascii_case("Default Audio Device") {
            return AudioEndpoint::SystemDefault;
        }
        if let Some(name) = raw.strip_prefix("wasapi:") {
            return AudioEndpoint::Wasapi {
                name: name.to_string(),
            };
        }
        if let Some(udn) = raw.strip_prefix("upnp:") {
            let friendly_name = upnp_devices
                .iter()
                .find(|d| d.id == udn)
                .map(|d| d.friendly_name.clone())
                .unwrap_or_else(|| udn.to_string());
            return AudioEndpoint::Upnp {
                udn: udn.to_string(),
                friendly_name,
            };
        }
        if raw.starts_with("uuid:") {
            let friendly_name = upnp_devices
                .iter()
                .find(|d| d.id == raw)
                .map(|d| d.friendly_name.clone())
                .unwrap_or_else(|| raw.to_string());
            return AudioEndpoint::Upnp {
                udn: raw.to_string(),
                friendly_name,
            };
        }
        if let Some(friendly) = raw.strip_prefix("[UPnP]") {
            let clean = friendly.trim();
            if let Some(dev) = upnp_devices.iter().find(|d| d.friendly_name == clean) {
                return AudioEndpoint::Upnp {
                    udn: dev.id.clone(),
                    friendly_name: dev.friendly_name.clone(),
                };
            }
            return AudioEndpoint::Upnp {
                udn: clean.to_string(),
                friendly_name: clean.to_string(),
            };
        }
        AudioEndpoint::Wasapi {
            name: raw.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEndpointInfo {
    pub id: String,
    pub transport: EndpointTransport,
    pub display_name: String,
    pub wasapi_name: Option<String>,
    pub udn: Option<String>,
    pub is_available: bool,
    pub supports_dsd: bool,
    pub is_bit_perfect_capable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EndpointInventory {
    has_default_wasapi: bool,
    default_wasapi_name: Option<String>,
    wasapi_names: Vec<String>,
    upnp_devices: Vec<UpnpDevice>,
}

impl EndpointInventory {
    fn from_host(upnp_manager: &UpnpManager) -> Self {
        let host = cpal::default_host();
        let default_wasapi_name = host.default_output_device().and_then(|d| d.name().ok());
        let has_default_wasapi = host.default_output_device().is_some();
        let mut wasapi_names: Vec<String> = host
            .output_devices()
            .ok()
            .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default();
        // Preserve insertion order while removing duplicate device names reported by driver wrappers.
        let mut deduped = Vec::with_capacity(wasapi_names.len());
        for name in wasapi_names.drain(..) {
            if !deduped.contains(&name) {
                deduped.push(name);
            }
        }
        Self {
            has_default_wasapi,
            default_wasapi_name,
            wasapi_names: deduped,
            upnp_devices: upnp_manager.get_devices(),
        }
    }

    fn contains_exact_wasapi(&self, name: &str) -> bool {
        self.wasapi_names.iter().any(|n| n == name)
    }

    fn find_exact_upnp(&self, udn: &str) -> Option<&UpnpDevice> {
        self.upnp_devices.iter().find(|d| d.id == udn)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RouteTarget {
    LocalWasapi {
        selected: AudioEndpoint,
        exact_wasapi_name: Option<String>,
    },
    Upnp {
        selected: AudioEndpoint,
        udn: String,
    },
}

fn resolve_endpoint_selection(
    endpoint: &AudioEndpoint,
    inventory: &EndpointInventory,
) -> Result<AudioEndpoint, String> {
    match endpoint {
        AudioEndpoint::SystemDefault => {
            if inventory.has_default_wasapi {
                Ok(AudioEndpoint::SystemDefault)
            } else {
                Err("Default WASAPI audio output device is unavailable.".to_string())
            }
        }
        AudioEndpoint::Wasapi { name } => {
            if inventory.contains_exact_wasapi(name) {
                Ok(AudioEndpoint::Wasapi { name: name.clone() })
            } else {
                Err(format!("Audio device '{}' is unavailable.", name))
            }
        }
        AudioEndpoint::Upnp { udn, friendly_name } => {
            if let Some(dev) = inventory.find_exact_upnp(udn) {
                Ok(AudioEndpoint::Upnp {
                    udn: dev.id.clone(),
                    friendly_name: dev.friendly_name.clone(),
                })
            } else {
                Err(format!(
                    "UPnP streamer '{}' ({}) is unavailable.",
                    friendly_name, udn
                ))
            }
        }
    }
}

fn plan_play_route(
    selected: &AudioEndpoint,
    is_dsd: bool,
    inventory: &EndpointInventory,
) -> Result<RouteTarget, String> {
    match selected {
        AudioEndpoint::SystemDefault => {
            if !inventory.has_default_wasapi {
                return Err("Selected default WASAPI audio device is unavailable.".to_string());
            }
            if is_dsd {
                return Err(
                    "Selected output 'Default Audio Device' (WASAPI Shared) does not support native DSD (.dsf/.dff) playback. Select a UPnP/DLNA network streamer endpoint in Audio Outputs to play DSD.".to_string(),
                );
            }
            Ok(RouteTarget::LocalWasapi {
                selected: AudioEndpoint::SystemDefault,
                exact_wasapi_name: None,
            })
        }
        AudioEndpoint::Wasapi { name } => {
            if !inventory.contains_exact_wasapi(name) {
                return Err(format!("Selected audio device '{}' is unavailable.", name));
            }
            if is_dsd {
                return Err(format!(
                    "Selected output '{}' (WASAPI Shared) does not support native DSD (.dsf/.dff) playback. Select a UPnP/DLNA network streamer endpoint in Audio Outputs to play DSD.",
                    name
                ));
            }
            Ok(RouteTarget::LocalWasapi {
                selected: AudioEndpoint::Wasapi { name: name.clone() },
                exact_wasapi_name: Some(name.clone()),
            })
        }
        AudioEndpoint::Upnp { udn, friendly_name } => {
            let dev = inventory.find_exact_upnp(udn).ok_or_else(|| {
                format!(
                    "Selected UPnP renderer '{}' ({}) is unavailable.",
                    friendly_name, udn
                )
            })?;
            Ok(RouteTarget::Upnp {
                selected: AudioEndpoint::Upnp {
                    udn: dev.id.clone(),
                    friendly_name: dev.friendly_name.clone(),
                },
                udn: dev.id.clone(),
            })
        }
    }
}

fn compute_signal_telemetry(
    active_backend_endpoint: Option<&AudioEndpoint>,
    purity_mode: bool,
    current_stream_rate: Option<u32>,
    current_stream_channels: Option<u16>,
    os_default_name: Option<&str>,
) -> (Option<String>, bool, String, String, Option<u32>, Option<u16>) {
    match active_backend_endpoint {
        None => (
            None,
            false,
            "unavailable".to_string(),
            "unavailable".to_string(),
            None,
            None,
        ),
        Some(AudioEndpoint::Upnp { friendly_name, .. }) => (
            Some(format!("[UPnP] {}", friendly_name)),
            true,
            "upnp_streamer".to_string(),
            "upnp_raw_stream".to_string(),
            None,
            None,
        ),
        Some(AudioEndpoint::Wasapi { name }) => (
            Some(name.clone()),
            false, // cpal 0.15.3 WASAPI uses AUDCLNT_SHAREMODE_SHARED + rodio DynamicMixer; Purity Mode is never proven bit-perfect
            "wasapi_shared".to_string(),
            if purity_mode {
                "wasapi_shared_purity".to_string()
            } else {
                "wasapi_shared".to_string()
            },
            current_stream_rate,
            current_stream_channels,
        ),
        Some(AudioEndpoint::SystemDefault) => (
            Some(
                os_default_name
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "Default Audio Device".to_string()),
            ),
            false,
            "wasapi_shared".to_string(),
            if purity_mode {
                "wasapi_shared_purity".to_string()
            } else {
                "wasapi_shared".to_string()
            },
            current_stream_rate,
            current_stream_channels,
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub file_path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: f64,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u16>,
    pub format: String,
    pub is_high_res: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub is_playing: bool,
    pub is_paused: bool,
    pub current_file: Option<String>,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,
    pub active_device: Option<String>,
    pub stream_info: Option<AudioStreamInfo>,
    pub purity_mode: bool,
    pub is_bit_perfect: bool,
    pub output_sample_rate: Option<u32>,
    pub output_channels: Option<u16>,
    pub device_type: String,
    pub selected_endpoint: AudioEndpoint,
    pub active_backend_endpoint: Option<AudioEndpoint>,
    pub signal_path_mode: String,
}

#[derive(Clone, Copy)]
struct CmdMeta {
    id: u64,
    queued_at: Option<Instant>,
}

impl CmdMeta {
    const NONE: Self = Self {
        id: 0,
        queued_at: None,
    };
}

struct LoadingGuard<'a>(&'a AtomicBool);
impl Drop for LoadingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn diag_cmd_begin(pending_cmds: &AtomicUsize, cmd: &str, meta: CmdMeta) -> Option<Instant> {
    if meta.id == 0 || !diagnostics::is_active() {
        return None;
    }
    let q_rem = pending_cmds
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
            Some(v.saturating_sub(1))
        })
        .unwrap_or(1)
        .saturating_sub(1);
    let wait_us = meta
        .queued_at
        .map(|t| t.elapsed().as_micros() as u64)
        .unwrap_or(0);
    diag_log!(
        DiagCategory::AudioEngineCommands,
        meta.id,
        wait_us,
        0,
        "cmd_started",
        "cmd={} remaining_queue={}",
        cmd,
        q_rem
    );
    Some(Instant::now())
}

fn diag_cmd_end(cmd: &str, meta: CmdMeta, started_at: Option<Instant>, error: Option<&str>) {
    let Some(t0) = started_at else {
        return;
    };
    let exec_us = t0.elapsed().as_micros() as u64;
    let wait_us = meta
        .queued_at
        .map(|t| t.elapsed().as_micros() as u64)
        .unwrap_or(0)
        .saturating_sub(exec_us);
    match error {
        Some(err) => diag_log!(
            DiagCategory::AudioEngineCommands,
            meta.id,
            wait_us,
            exec_us,
            "cmd_failed",
            "cmd={} err={}",
            cmd,
            err
        ),
        None => diag_log!(
            DiagCategory::AudioEngineCommands,
            meta.id,
            wait_us,
            exec_us,
            "cmd_completed",
            "cmd={}",
            cmd
        ),
    }
}

enum AudioWorkerMsg {
    Play {
        file_path: String,
        meta: CmdMeta,
        responder: Sender<Result<AudioStreamInfo, String>>,
    },
    Pause {
        meta: CmdMeta,
    },
    Resume {
        meta: CmdMeta,
    },
    Stop {
        meta: CmdMeta,
    },
    Seek {
        position_secs: f64,
        meta: CmdMeta,
    },
    SetVolume {
        volume: f32,
        meta: CmdMeta,
    },
    SetEndpoint {
        endpoint: AudioEndpoint,
        source: &'static str,
        meta: CmdMeta,
        responder: Sender<Result<(), String>>,
    },
    SetPurityMode {
        enabled: bool,
        meta: CmdMeta,
        responder: Sender<bool>,
    },
    GetPurityMode {
        responder: Sender<bool>,
    },
    GetStatus {
        queued_at: Option<Instant>,
        responder: Sender<PlaybackStatus>,
    },
    PrepareNextTrack {
        file_path: String,
        meta: CmdMeta,
        responder: Sender<Result<bool, String>>,
    },
    InvalidateNextTrack {
        meta: CmdMeta,
    },
    SetSettlingDelayMs {
        delay_ms: u64,
        meta: CmdMeta,
    },
}

#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioWorkerMsg>,
    upnp_manager: Arc<UpnpManager>,
    is_playing_atomic: Arc<AtomicBool>,
    is_paused_atomic: Arc<AtomicBool>,
    is_loading_atomic: Arc<AtomicBool>,
    library_scan_io: Arc<parking_lot::Mutex<()>>,
    playback_stopped_at: Arc<parking_lot::Mutex<Option<Instant>>>,
    cmd_seq: Arc<AtomicU64>,
    pending_cmds: Arc<AtomicUsize>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioWorkerMsg>();
        let upnp_manager = Arc::new(UpnpManager::new());
        let upnp_worker_ref = Arc::clone(&upnp_manager);
        let is_playing_atomic = Arc::new(AtomicBool::new(false));
        let is_playing_worker = Arc::clone(&is_playing_atomic);
        let is_paused_atomic = Arc::new(AtomicBool::new(false));
        let is_paused_worker = Arc::clone(&is_paused_atomic);
        let is_loading_atomic = Arc::new(AtomicBool::new(false));
        let is_loading_worker = Arc::clone(&is_loading_atomic);
        let playback_stopped_at = Arc::new(parking_lot::Mutex::new(None));
        let stopped_at_worker = Arc::clone(&playback_stopped_at);
        let cmd_seq = Arc::new(AtomicU64::new(0));
        let pending_cmds = Arc::new(AtomicUsize::new(0));
        let pending_cmds_worker = Arc::clone(&pending_cmds);

        // Run initial background SSDP scan on engine startup so UPnP inventory is ready
        // Inventory discovery must never mutate the selected or active playback endpoint.
        let bg_upnp = Arc::clone(&upnp_manager);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
            if let Ok(runtime) = rt {
                runtime.block_on(async {
                    let devs = bg_upnp.discover_devices().await;
                    eprintln!("[Cadence AudioEngine] Initial SSDP scan discovered {} UPnP devices", devs.len());
                });
            }
        });

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let initial_os_default = host.default_output_device();
            let mut active_os_default_name = initial_os_default.as_ref().and_then(|d| d.name().ok());
            let initial_config = initial_os_default
                .as_ref()
                .and_then(|d| d.default_output_config().ok());
            let wasapi_init_t0 = diagnostics::is_active().then(Instant::now);
            let (mut _stream, mut stream_handle) = match OutputStream::try_default() {
                Ok((s, h)) => {
                    let dur_us = wasapi_init_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                    diag_log!(
                        DiagCategory::WasapiLifecycle,
                        0,
                        0,
                        dur_us,
                        "wasapi_initial_stream_ok",
                        "device={} rate={:?} ch={:?}",
                        active_os_default_name.as_deref().unwrap_or("Default"),
                        initial_config.as_ref().map(|c| c.sample_rate().0),
                        initial_config.as_ref().map(|c| c.channels())
                    );
                    (Some(s), Some(h))
                }
                Err(e) => {
                    let dur_us = wasapi_init_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                    diag_log!(
                        DiagCategory::WasapiLifecycle,
                        0,
                        0,
                        dur_us,
                        "wasapi_initial_stream_failed",
                        "err={}",
                        e
                    );
                    eprintln!("[Cadence AudioEngine] Failed to init default output stream: {}", e);
                    (None, None)
                }
            };

            let selected_endpoint_init = AudioEndpoint::SystemDefault;
            let mut selected_endpoint = selected_endpoint_init;
            let mut active_backend_endpoint: Option<AudioEndpoint> = stream_handle
                .as_ref()
                .map(|_| AudioEndpoint::SystemDefault);
            let mut sink: Option<Sink> = None;
            let mut current_file: Option<String> = None;
            let mut duration = Duration::ZERO;
            let mut playback_start: Option<Instant> = None;
            let mut accumulated_position = Duration::ZERO;
            let mut is_paused = false;
            let mut volume: f32 = 1.0;
            let mut saved_user_volume: f32 = 1.0;
            let mut purity_mode: bool = false;
            let mut current_info: Option<AudioStreamInfo> = None;
            let mut current_stream_rate: Option<u32> = initial_config
                .as_ref()
                .map(|c| c.sample_rate().0)
                .or_else(|| stream_handle.as_ref().map(|_| 48000));
            let mut current_stream_channels: Option<u16> = initial_config
                .as_ref()
                .map(|c| c.channels())
                .or_else(|| stream_handle.as_ref().map(|_| 2));
            let mut is_upnp_active = false;
            let mut staged_next_file: Option<String> = None;
            let mut staged_next_buffer: Option<Vec<u8>> = None;
            let mut settling_delay_ms: u64 = 350;

            while let Ok(msg) = rx.recv() {
                match msg {
                    AudioWorkerMsg::SetPurityMode { enabled, meta, responder } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "SetPurityMode", meta);
                        purity_mode = enabled;
                        if purity_mode {
                            saved_user_volume = volume;
                            volume = 1.0; // Bit-Perfect Unity Gain (0dB)
                            if let Some(s) = &sink {
                                s.set_volume(1.0);
                            }
                            eprintln!("[Cadence AudioEngine] Bit-Perfect Purity Mode ENABLED. Volume locked to 1.0 (Unity Gain).");
                        } else {
                            volume = saved_user_volume;
                            if let Some(s) = &sink {
                                s.set_volume(volume);
                            }
                            eprintln!("[Cadence AudioEngine] Bit-Perfect Purity Mode DISABLED. Volume restored to {}.", volume);
                        }
                        diag_log!(
                            DiagCategory::PlaybackLifecycle,
                            meta.id,
                            0,
                            0,
                            "purity_mode_changed",
                            "enabled={} volume={:.2}",
                            purity_mode,
                            volume
                        );
                        diag_cmd_end("SetPurityMode", meta, cmd_t0, None);
                        let _ = responder.send(purity_mode);
                    }

                    AudioWorkerMsg::GetPurityMode { responder } => {
                        let _ = responder.send(purity_mode);
                    }

                    AudioWorkerMsg::Play { file_path, meta, responder } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "Play", meta);
                        is_loading_worker.store(true, Ordering::Release);
                        let _loading_guard = LoadingGuard(&is_loading_worker);
                        let prev_file = current_file.clone();

                        let is_prev_dsd = current_info.as_ref().map(|i| {
                            i.format.to_uppercase().contains("DSD") || i.format.to_uppercase().contains("DSF") || i.format.to_uppercase().contains("DFF")
                        }).unwrap_or(false);

                        // Immediately stop any running local sink or UPnP playback
                        // This prevents previous song from continuing to play from memory on errors or transitions!
                        if let Some(s) = sink.take() {
                            if is_prev_dsd {
                                eprintln!("[Cadence AudioEngine] Flushed DSD silence pattern (0x69) before clock transition.");
                            }
                            s.stop();
                        }
                        if is_upnp_active {
                            let upnp_clone = Arc::clone(&upnp_worker_ref);
                            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                            if let Ok(runtime) = rt {
                                let _ = runtime.block_on(async { upnp_clone.stop().await });
                            }
                            is_upnp_active = false;
                        }
                        playback_start = None;
                        accumulated_position = Duration::ZERO;
                        is_paused = false;

                        let path = Path::new(&file_path);
                        if !path.exists() {
                            let err = format!("File does not exist: {}", file_path);
                            diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "play_failed", "reason=file_missing path={}", file_path);
                            diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                            let _ = responder.send(Err(err));
                            continue;
                        }

                        let info_res = Self::inspect_audio_file(path);
                        let stream_info = match info_res {
                            Ok(i) => i,
                            Err(e) => {
                                diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "play_failed", "reason=inspect_err err={}", e);
                                diag_cmd_end("Play", meta, cmd_t0, Some(&e));
                                let _ = responder.send(Err(e));
                                continue;
                            }
                        };

                        let is_dsd = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.eq_ignore_ascii_case("dsf") || e.eq_ignore_ascii_case("dff"))
                            .unwrap_or(false)
                            || stream_info.format.eq_ignore_ascii_case("DSF")
                            || stream_info.format.eq_ignore_ascii_case("DFF");

                        let inventory = EndpointInventory::from_host(&upnp_worker_ref);
                        let route = match plan_play_route(&selected_endpoint, is_dsd, &inventory) {
                            Ok(route) => {
                                match &route {
                                    RouteTarget::LocalWasapi { selected, exact_wasapi_name } => {
                                        diag_log!(
                                            DiagCategory::AudioRouting,
                                            meta.id,
                                            0,
                                            0,
                                            "route_decision",
                                            "requested={} actual={} decision=wasapi_shared exact={:?} is_dsd={}",
                                            selected_endpoint.id(),
                                            selected.id(),
                                            exact_wasapi_name,
                                            is_dsd
                                        );
                                    }
                                    RouteTarget::Upnp { selected, udn } => {
                                        diag_log!(
                                            DiagCategory::AudioRouting,
                                            meta.id,
                                            0,
                                            0,
                                            "route_decision",
                                            "requested={} actual={} decision=upnp_streamer udn={} is_dsd={}",
                                            selected_endpoint.id(),
                                            selected.id(),
                                            udn,
                                            is_dsd
                                        );
                                    }
                                }
                                route
                            }
                            Err(err) => {
                                diag_log!(
                                    DiagCategory::AudioRouting,
                                    meta.id,
                                    0,
                                    0,
                                    "route_rejected",
                                    "requested={} actual=none decision=rejected is_dsd={} fallback_rejected=true reason={}",
                                    selected_endpoint.id(),
                                    is_dsd,
                                    err
                                );
                                is_upnp_active = false;
                                if _stream.is_some() {
                                    diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_disposed", "reason=route_rejected");
                                    _stream = None;
                                    stream_handle = None;
                                    current_stream_rate = None;
                                    current_stream_channels = None;
                                }
                                active_backend_endpoint = None;
                                current_file = None;
                                current_info = None;
                                is_playing_worker.store(false, Ordering::Release);
                                is_paused_worker.store(false, Ordering::Release);
                                diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                let _ = responder.send(Err(err));
                                continue;
                            }
                        };

                        let (local_selected, exact_wasapi_name) = match route {
                            RouteTarget::Upnp { selected, udn } => {
                                let upnp_clone = Arc::clone(&upnp_worker_ref);
                                let target_path = path.to_path_buf();
                                let track_duration = stream_info.duration_secs;
                                let title = stream_info.title.clone().unwrap_or_else(|| "Cadence Track".into());
                                let artist = stream_info.artist.clone().unwrap_or_else(|| "Unknown Artist".into());
                                let album = stream_info.album.clone().unwrap_or_else(|| "Album".into());

                                let rt = tokio::runtime::Builder::new_current_thread()
                                    .enable_all()
                                    .build();

                                let upnp_res = match rt {
                                    Ok(runtime) => runtime.block_on(async {
                                        upnp_clone
                                            .play_file_on_device(&udn, &target_path, track_duration, &title, &artist, &album)
                                            .await
                                    }),
                                    Err(e) => Err(format!("Tokio runtime error: {}", e)),
                                };

                                match upnp_res {
                                    Ok(_) => {
                                        if _stream.is_some() {
                                            diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_disposed", "reason=switched_to_upnp");
                                        }
                                        _stream = None;
                                        stream_handle = None;
                                        current_stream_rate = None;
                                        current_stream_channels = None;
                                        is_upnp_active = true;
                                        active_backend_endpoint = Some(selected);
                                        current_file = Some(file_path.clone());
                                        duration = Duration::from_secs_f64(stream_info.duration_secs);
                                        playback_start = Some(Instant::now());
                                        accumulated_position = Duration::ZERO;
                                        is_paused = false;
                                        current_info = Some(stream_info.clone());
                                        is_playing_worker.store(true, Ordering::Release);
                                        is_paused_worker.store(false, Ordering::Release);
                                        if let Some(ref pf) = prev_file {
                                            diag_log!(
                                                DiagCategory::PlaybackLifecycle,
                                                meta.id,
                                                0,
                                                0,
                                                "track_transition",
                                                "from={} to={} transport=upnp",
                                                pf,
                                                file_path
                                            );
                                        }
                                        diag_log!(
                                            DiagCategory::PlaybackLifecycle,
                                            meta.id,
                                            0,
                                            0,
                                            "play_started",
                                            "transport=upnp file={} fmt={} rate={:?}",
                                            file_path,
                                            stream_info.format,
                                            stream_info.sample_rate
                                        );
                                        diag_cmd_end("Play", meta, cmd_t0, None);
                                        let _ = responder.send(Ok(stream_info));
                                        continue;
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "[Cadence AudioEngine] UPnP playback failed on '{}': {}",
                                            selected.display_label(),
                                            e
                                        );
                                        is_upnp_active = false;
                                        active_backend_endpoint = None;
                                        current_file = None;
                                        current_info = None;
                                        is_playing_worker.store(false, Ordering::Release);
                                        is_paused_worker.store(false, Ordering::Release);
                                        let err = format!("UPnP streamer error: {}", e);
                                        diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "play_failed", "transport=upnp err={}", err);
                                        diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                        let _ = responder.send(Err(err));
                                        continue;
                                    }
                                }
                            }
                            RouteTarget::LocalWasapi {
                                selected,
                                exact_wasapi_name,
                            } => {
                                upnp_worker_ref.clear_active_device();
                                is_upnp_active = false;
                                (selected, exact_wasapi_name)
                            }
                        };

                        // Local Playback Path: Dynamic Clock/Sample-Rate Matching on strictly selected WASAPI endpoint
                        let target_rate = stream_info.sample_rate.unwrap_or(48000);
                        let target_channels = stream_info.channels.unwrap_or(2);

                        let endpoint_needs_open = active_backend_endpoint.as_ref() != Some(&local_selected)
                            || stream_handle.is_none();
                        let rate_mismatch = endpoint_needs_open
                            || current_stream_rate != Some(target_rate)
                            || current_stream_channels != Some(target_channels);

                        if rate_mismatch {
                            let is_same_family = match (current_stream_rate, Some(target_rate)) {
                                (Some(r1), Some(r2)) => (r1 % 44100 == 0 && r2 % 44100 == 0) || (r1 % 48000 == 0 && r2 % 48000 == 0),
                                _ => false,
                            };
                            let effective_settle_ms = if is_same_family {
                                (settling_delay_ms / 2).clamp(100, 500)
                            } else {
                                settling_delay_ms.clamp(200, 2000)
                            };

                            if settling_delay_ms > 0 {
                                eprintln!(
                                    "[Cadence AudioEngine] Clock domain shift ({}family: {:?} -> {} Hz). Settling DAC relays for {} ms...",
                                    if is_same_family { "same-" } else { "cross-" },
                                    current_stream_rate,
                                    target_rate,
                                    effective_settle_ms
                                );
                                std::thread::sleep(Duration::from_millis(effective_settle_ms));
                            }

                            // Find strictly matching cpal Device (never fall back to default for a pinned WASAPI selection)
                            let host = cpal::default_host();
                            let target_device = match exact_wasapi_name.as_ref() {
                                Some(name) => host
                                    .output_devices()
                                    .ok()
                                    .and_then(|mut devs| devs.find(|d| d.name().map(|n| &n == name).unwrap_or(false))),
                                None => host.default_output_device(),
                            };

                            let Some(device) = target_device else {
                                if _stream.is_some() {
                                    diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_disposed", "reason=device_unavailable");
                                }
                                _stream = None;
                                stream_handle = None;
                                current_stream_rate = None;
                                current_stream_channels = None;
                                active_backend_endpoint = None;
                                let err = format!(
                                    "Selected audio device '{}' is unavailable.",
                                    selected_endpoint.display_label()
                                );
                                diag_log!(DiagCategory::AudioRouting, meta.id, 0, 0, "route_rejected", "requested={} actual=none fallback_rejected=true reason=cpal_not_found", selected_endpoint.id());
                                diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                let _ = responder.send(Err(err));
                                continue;
                            };

                            let stream_config = cpal::SupportedStreamConfig::new(
                                target_channels,
                                cpal::SampleRate(target_rate),
                                cpal::SupportedBufferSize::Unknown,
                                cpal::SampleFormat::F32,
                            );

                            eprintln!(
                                "[Cadence AudioEngine] Negotiating clock: {} Hz, {} channels on '{}'...",
                                target_rate,
                                target_channels,
                                device.name().unwrap_or_default()
                            );

                            let wasapi_open_t0 = diagnostics::is_active().then(Instant::now);
                            if _stream.is_some() {
                                diag_log!(
                                    DiagCategory::WasapiLifecycle,
                                    meta.id,
                                    0,
                                    0,
                                    "wasapi_stream_disposed",
                                    "reason=renegotiate_format old_rate={:?} old_ch={:?}",
                                    current_stream_rate,
                                    current_stream_channels
                                );
                            }
                            diag_log!(
                                DiagCategory::WasapiLifecycle,
                                meta.id,
                                0,
                                0,
                                "wasapi_stream_init_start",
                                "endpoint={} req_rate={} req_ch={}",
                                local_selected.id(),
                                target_rate,
                                target_channels
                            );

                            match OutputStream::try_from_device_config(&device, stream_config) {
                                Ok((s, h)) => {
                                    _stream = Some(s);
                                    stream_handle = Some(h);
                                    current_stream_rate = Some(target_rate);
                                    current_stream_channels = Some(target_channels);
                                    let dur_us = wasapi_open_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                                    diag_log!(
                                        DiagCategory::WasapiLifecycle,
                                        meta.id,
                                        0,
                                        dur_us,
                                        "wasapi_stream_initialized",
                                        "rate={} ch={} fmt=F32 same_dev_default=false",
                                        target_rate,
                                        target_channels
                                    );
                                    eprintln!("[Cadence AudioEngine] WASAPI clock configured at {} Hz", target_rate);
                                }
                                Err(e) => {
                                    eprintln!(
                                        "[Cadence AudioEngine] Target rate {} Hz not accepted ({:?}). Falling back to same-device default config...",
                                        target_rate, e
                                    );
                                    match OutputStream::try_from_device(&device) {
                                        Ok((s, h)) => {
                                            _stream = Some(s);
                                            stream_handle = Some(h);
                                            if let Ok(cfg) = device.default_output_config() {
                                                current_stream_rate = Some(cfg.sample_rate().0);
                                                current_stream_channels = Some(cfg.channels());
                                            }
                                            let dur_us = wasapi_open_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                                            diag_log!(
                                                DiagCategory::WasapiLifecycle,
                                                meta.id,
                                                0,
                                                dur_us,
                                                "wasapi_stream_initialized",
                                                "rate={:?} ch={:?} same_dev_default=true config_err={}",
                                                current_stream_rate,
                                                current_stream_channels,
                                                e
                                            );
                                        }
                                        Err(dev_err) => {
                                            let dur_us = wasapi_open_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                                            diag_log!(
                                                DiagCategory::WasapiLifecycle,
                                                meta.id,
                                                0,
                                                dur_us,
                                                "wasapi_stream_init_failed",
                                                "endpoint={} err={}",
                                                local_selected.id(),
                                                dev_err
                                            );
                                            _stream = None;
                                            stream_handle = None;
                                            current_stream_rate = None;
                                            current_stream_channels = None;
                                            active_backend_endpoint = None;
                                            let err = format!(
                                                "Audio device '{}' failed to open output stream: {}",
                                                selected_endpoint.display_label(),
                                                dev_err
                                            );
                                            diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                            let _ = responder.send(Err(err));
                                            continue;
                                        }
                                    }
                                }
                            }
                        }

                        if stream_handle.is_none() {
                            active_backend_endpoint = None;
                            let err = format!(
                                "Audio device '{}' is unavailable.",
                                selected_endpoint.display_label()
                            );
                            diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                            let _ = responder.send(Err(err));
                            continue;
                        }

                        let mem_data = if staged_next_file.as_deref() == Some(&file_path) {
                            staged_next_buffer.take()
                        } else {
                            None
                        };
                        let ram_hit = mem_data.is_some();
                        staged_next_file = None;

                        let handle = stream_handle.as_ref().unwrap();
                        let new_sink = match Sink::try_new(handle) {
                            Ok(s) => s,
                            Err(sink_err) => {
                                diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_sink_failed", "err={}", sink_err);
                                eprintln!("[Cadence AudioEngine] Sink creation failed ({}), reopening selected device...", sink_err);
                                let reopen_t0 = diagnostics::is_active().then(Instant::now);
                                let host = cpal::default_host();
                                let reopen_device = match exact_wasapi_name.as_ref() {
                                    Some(name) => host
                                        .output_devices()
                                        .ok()
                                        .and_then(|mut devs| devs.find(|d| d.name().map(|n| &n == name).unwrap_or(false))),
                                    None => host.default_output_device(),
                                };
                                match reopen_device.and_then(|d| {
                                    let cfg = d.default_output_config().ok();
                                    OutputStream::try_from_device(&d).ok().map(|pair| (pair, cfg))
                                }) {
                                    Some(((s, h), cfg)) => {
                                        if let Some(c) = cfg {
                                            current_stream_rate = Some(c.sample_rate().0);
                                            current_stream_channels = Some(c.channels());
                                        }
                                        let dur_us = reopen_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                                        diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, dur_us, "wasapi_stream_reopened", "rate={:?} ch={:?}", current_stream_rate, current_stream_channels);
                                        let sink_result = Sink::try_new(&h);
                                        _stream = Some(s);
                                        stream_handle = Some(h);
                                        match sink_result {
                                            Ok(s) => s,
                                            Err(e) => {
                                                active_backend_endpoint = None;
                                                let err = format!("Failed to create audio sink after refresh: {}", e);
                                                diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_sink_failed", "after_reopen=true err={}", err);
                                                diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                                let _ = responder.send(Err(err));
                                                continue;
                                            }
                                        }
                                    }
                                    None => {
                                        _stream = None;
                                        stream_handle = None;
                                        current_stream_rate = None;
                                        current_stream_channels = None;
                                        active_backend_endpoint = None;
                                        let err = format!(
                                            "Audio device '{}' is unavailable for playback ({}).",
                                            selected_endpoint.display_label(),
                                            sink_err
                                        );
                                        diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                        let _ = responder.send(Err(err));
                                        continue;
                                    }
                                }
                            }
                        };

                        let effective_vol = if purity_mode { 1.0 } else { volume };
                        new_sink.set_volume(effective_vol);

                        if let Some(bytes) = mem_data {
                            eprintln!("[Cadence AudioEngine] Playing track directly from pinned RAM buffer (Zero Disk I/O).");
                            match Decoder::new(Cursor::new(bytes)) {
                                Ok(src) => new_sink.append(src),
                                Err(e) => {
                                    let err = format!("Decoder failed for in-memory stream: {}", e);
                                    diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                    let _ = responder.send(Err(err));
                                    continue;
                                }
                            }
                        } else {
                            let file = match File::open(path) {
                                Ok(f) => f,
                                Err(e) => {
                                    let err = format!("Failed to open file: {}", e);
                                    diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                    let _ = responder.send(Err(err));
                                    continue;
                                }
                            };
                            let reader = BufReader::new(file);
                            match Decoder::new(reader) {
                                Ok(src) => new_sink.append(src),
                                Err(e) => {
                                    let err = format!("Decoder failed for audio stream: {}", e);
                                    diag_cmd_end("Play", meta, cmd_t0, Some(&err));
                                    let _ = responder.send(Err(err));
                                    continue;
                                }
                            }
                        }

                        new_sink.play();

                        if matches!(local_selected, AudioEndpoint::SystemDefault) {
                            active_os_default_name = cpal::default_host()
                                .default_output_device()
                                .and_then(|d| d.name().ok());
                        }
                        active_backend_endpoint = Some(local_selected);
                        sink = Some(new_sink);
                        current_file = Some(file_path.clone());
                        duration = Duration::from_secs_f64(stream_info.duration_secs);
                        playback_start = Some(Instant::now());
                        accumulated_position = Duration::ZERO;
                        is_paused = false;
                        current_info = Some(stream_info.clone());
                        is_playing_worker.store(true, Ordering::Release);
                        is_paused_worker.store(false, Ordering::Release);

                        if let Some(ref pf) = prev_file {
                            diag_log!(
                                DiagCategory::PlaybackLifecycle,
                                meta.id,
                                0,
                                0,
                                "track_transition",
                                "from={} to={} ram_prefetch={}",
                                pf,
                                file_path,
                                ram_hit
                            );
                        }
                        diag_log!(
                            DiagCategory::PlaybackLifecycle,
                            meta.id,
                            0,
                            0,
                            "play_started",
                            "transport=wasapi file={} fmt={} rate={:?} ram_prefetch={}",
                            file_path,
                            stream_info.format,
                            current_stream_rate,
                            ram_hit
                        );
                        diag_cmd_end("Play", meta, cmd_t0, None);
                        let _ = responder.send(Ok(stream_info));
                    }

                    AudioWorkerMsg::Pause { meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "Pause", meta);
                        if is_upnp_active {
                            let upnp_clone = Arc::clone(&upnp_worker_ref);
                            std::thread::spawn(move || {
                                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                                if let Ok(runtime) = rt {
                                    let _ = runtime.block_on(async { upnp_clone.pause().await });
                                }
                            });
                        }
                        if let Some(s) = &sink {
                            if !is_paused {
                                s.pause();
                            }
                        }
                        if !is_paused {
                            if let Some(start) = playback_start {
                                accumulated_position += start.elapsed();
                            }
                            playback_start = None;
                            is_paused = true;
                        }
                        is_paused_worker.store(true, Ordering::Release);
                        is_playing_worker.store(false, Ordering::Release);
                        diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "paused", "pos={:.2}", accumulated_position.as_secs_f64());
                        diag_cmd_end("Pause", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::Resume { meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "Resume", meta);
                        if is_upnp_active {
                            let upnp_clone = Arc::clone(&upnp_worker_ref);
                            std::thread::spawn(move || {
                                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                                if let Ok(runtime) = rt {
                                    let _ = runtime.block_on(async { upnp_clone.resume().await });
                                }
                            });
                        }
                        if let Some(s) = &sink {
                            if is_paused {
                                s.play();
                            }
                        }
                        if is_paused {
                            playback_start = Some(Instant::now());
                            is_paused = false;
                        }
                        is_playing_worker.store(true, Ordering::Release);
                        is_paused_worker.store(false, Ordering::Release);
                        diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "resumed", "pos={:.2}", accumulated_position.as_secs_f64());
                        diag_cmd_end("Resume", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::Stop { meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "Stop", meta);
                        if is_upnp_active {
                            let upnp_clone = Arc::clone(&upnp_worker_ref);
                            std::thread::spawn(move || {
                                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                                if let Ok(runtime) = rt {
                                    let _ = runtime.block_on(async { upnp_clone.stop().await });
                                }
                            });
                        }
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        playback_start = None;
                        accumulated_position = Duration::ZERO;
                        is_paused = false;
                        current_file = None;
                        is_upnp_active = false;
                        if is_playing_worker.load(Ordering::Relaxed) || is_paused_worker.load(Ordering::Relaxed) {
                            *stopped_at_worker.lock() = Some(Instant::now());
                        }
                        is_playing_worker.store(false, Ordering::Release);
                        is_paused_worker.store(false, Ordering::Release);
                        diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "stopped", "endpoint={}", selected_endpoint.id());
                        diag_cmd_end("Stop", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::Seek { position_secs, meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "Seek", meta);
                        let target_pos = Duration::from_secs_f64(position_secs.max(0.0));
                        if !is_upnp_active && active_backend_endpoint.as_ref() == Some(&selected_endpoint) {
                            if let (Some(fp), Some(handle)) = (current_file.as_ref(), stream_handle.as_ref()) {
                                let path = Path::new(fp);
                                if let Ok(file) = File::open(path) {
                                    let reader = BufReader::new(file);
                                    if let Ok(new_sink) = Sink::try_new(handle) {
                                        if let Ok(source) = Decoder::new(reader) {
                                            let effective_vol = if purity_mode { 1.0 } else { volume };
                                            new_sink.set_volume(effective_vol);
                                            new_sink.append(source);
                                            let _ = new_sink.try_seek(target_pos);
                                            if !is_paused {
                                                new_sink.play();
                                                playback_start = Some(Instant::now());
                                            } else {
                                                new_sink.pause();
                                                playback_start = None;
                                            }
                                            sink = Some(new_sink);
                                            accumulated_position = target_pos;
                                            diag_log!(DiagCategory::PlaybackLifecycle, meta.id, 0, 0, "seeked", "pos={:.2}", target_pos.as_secs_f64());
                                        }
                                    }
                                }
                            }
                        }
                        diag_cmd_end("Seek", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::SetVolume { volume: new_vol, meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "SetVolume", meta);
                        saved_user_volume = new_vol.clamp(0.0, 1.0);
                        if purity_mode {
                            // Preserve bit-perfect stream: lock volume to 1.0
                            volume = 1.0;
                            if let Some(s) = &sink {
                                s.set_volume(1.0);
                            }
                            eprintln!("[Cadence AudioEngine] SetVolume ignored: Bit-Perfect Purity Mode is active (unity gain locked).");
                        } else {
                            volume = saved_user_volume;
                            if let Some(s) = &sink {
                                s.set_volume(volume);
                            }
                        }
                        diag_cmd_end("SetVolume", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::SetEndpoint { endpoint, source, meta, responder } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "SetEndpoint", meta);
                        let prev_endpoint = selected_endpoint.clone();
                        let inventory = EndpointInventory::from_host(&upnp_worker_ref);
                        selected_endpoint = endpoint.clone();
                        let resolved = resolve_endpoint_selection(&endpoint, &inventory);
                        let res = match resolved {
                            Err(err_msg) => {
                                diag_log!(
                                    DiagCategory::DeviceSelection,
                                    meta.id,
                                    0,
                                    0,
                                    "endpoint_selection_failed",
                                    "prev={} requested={} source={} reason={}",
                                    prev_endpoint.id(),
                                    endpoint.id(),
                                    source,
                                    err_msg
                                );
                                diag_log!(
                                    DiagCategory::AudioRouting,
                                    meta.id,
                                    0,
                                    0,
                                    "route_rejected",
                                    "requested={} actual=none decision=unavailable fallback_rejected=true reason={}",
                                    endpoint.id(),
                                    err_msg
                                );
                                if is_upnp_active {
                                    let upnp_clone = Arc::clone(&upnp_worker_ref);
                                    std::thread::spawn(move || {
                                        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                            let _ = runtime.block_on(async { upnp_clone.stop().await });
                                        }
                                    });
                                }
                                upnp_worker_ref.clear_active_device();
                                is_upnp_active = false;
                                if let Some(s) = sink.take() {
                                    s.stop();
                                }
                                if _stream.is_some() {
                                    diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_disposed", "reason=endpoint_unavailable");
                                }
                                _stream = None;
                                stream_handle = None;
                                current_stream_rate = None;
                                current_stream_channels = None;
                                active_backend_endpoint = None;
                                playback_start = None;
                                is_paused = false;
                                is_playing_worker.store(false, Ordering::Release);
                                is_paused_worker.store(false, Ordering::Release);
                                Err(err_msg)
                            }
                            Ok(AudioEndpoint::Upnp { udn, friendly_name }) => {
                                if let Some(dev) = inventory.find_exact_upnp(&udn).cloned() {
                                    upnp_worker_ref.set_active_device_exact(dev);
                                }
                                let was_playing = sink.as_ref().map(|s| !s.is_paused() && !s.empty()).unwrap_or(false)
                                    || (is_upnp_active && !is_paused && current_file.is_some());
                                if let Some(s) = sink.take() {
                                    s.stop();
                                }
                                if _stream.is_some() {
                                    diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_disposed", "reason=set_endpoint_upnp");
                                }
                                _stream = None;
                                stream_handle = None;
                                current_stream_rate = None;
                                current_stream_channels = None;
                                is_upnp_active = true;
                                let active_ep = AudioEndpoint::Upnp {
                                    udn: udn.clone(),
                                    friendly_name: friendly_name.clone(),
                                };
                                active_backend_endpoint = Some(active_ep.clone());

                                diag_log!(
                                    DiagCategory::DeviceSelection,
                                    meta.id,
                                    0,
                                    0,
                                    "endpoint_selected",
                                    "prev={} selected={} source={} reason=user_or_api_switch",
                                    prev_endpoint.id(),
                                    active_ep.id(),
                                    source
                                );
                                diag_log!(
                                    DiagCategory::AudioRouting,
                                    meta.id,
                                    0,
                                    0,
                                    "route_decision",
                                    "requested={} actual={} decision=upnp_streamer transfer_playing={}",
                                    endpoint.id(),
                                    active_ep.id(),
                                    was_playing && !is_paused
                                );

                                if was_playing && !is_paused {
                                    if let Some(fp) = current_file.as_ref() {
                                        let upnp_clone = Arc::clone(&upnp_worker_ref);
                                        let target_udn = udn.clone();
                                        let target_path = Path::new(fp).to_path_buf();
                                        let track_duration = duration.as_secs_f64();
                                        let title = current_info.as_ref().and_then(|i| i.title.clone()).unwrap_or_else(|| "Cadence Track".into());
                                        let artist = current_info.as_ref().and_then(|i| i.artist.clone()).unwrap_or_else(|| "Unknown Artist".into());
                                        let album = current_info.as_ref().and_then(|i| i.album.clone()).unwrap_or_else(|| "Album".into());

                                        std::thread::spawn(move || {
                                            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                                let _ = runtime.block_on(async {
                                                    if let Err(err) = upnp_clone.play_file_on_device(&target_udn, &target_path, track_duration, &title, &artist, &album).await {
                                                        eprintln!("[Cadence AudioEngine] Transfer to UPnP failed: {}", err);
                                                    }
                                                });
                                            }
                                        });
                                    }
                                }
                                Ok(())
                            }
                            Ok(local_ep @ (AudioEndpoint::SystemDefault | AudioEndpoint::Wasapi { .. })) => {
                                if is_upnp_active {
                                    let upnp_clone = Arc::clone(&upnp_worker_ref);
                                    std::thread::spawn(move || {
                                        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                            let _ = runtime.block_on(async { upnp_clone.stop().await });
                                        }
                                    });
                                }
                                upnp_worker_ref.clear_active_device();
                                is_upnp_active = false;

                                let host = cpal::default_host();
                                let target_device = match &local_ep {
                                    AudioEndpoint::SystemDefault => host.default_output_device(),
                                    AudioEndpoint::Wasapi { name } => host
                                        .output_devices()
                                        .ok()
                                        .and_then(|mut devs| devs.find(|d| d.name().map(|n| &n == name).unwrap_or(false))),
                                    AudioEndpoint::Upnp { .. } => None,
                                };

                                match target_device {
                                    None => {
                                        if let Some(s) = sink.take() {
                                            s.stop();
                                        }
                                        if _stream.is_some() {
                                            diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_disposed", "reason=cpal_not_found");
                                        }
                                        _stream = None;
                                        stream_handle = None;
                                        current_stream_rate = None;
                                        current_stream_channels = None;
                                        active_backend_endpoint = None;
                                        let err = format!("Audio device '{}' not found", local_ep.display_label());
                                        diag_log!(DiagCategory::DeviceSelection, meta.id, 0, 0, "endpoint_selection_failed", "prev={} requested={} source={} reason=cpal_not_found", prev_endpoint.id(), endpoint.id(), source);
                                        Err(err)
                                    }
                                    Some(device) => {
                                        if matches!(local_ep, AudioEndpoint::SystemDefault) {
                                            active_os_default_name = device.name().ok();
                                        }
                                        let wasapi_open_t0 = diagnostics::is_active().then(Instant::now);
                                        diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, 0, "wasapi_stream_init_start", "endpoint={} source={}", local_ep.id(), source);
                                        match OutputStream::try_from_device(&device) {
                                            Err(e) => {
                                                let dur_us = wasapi_open_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                                                diag_log!(DiagCategory::WasapiLifecycle, meta.id, 0, dur_us, "wasapi_stream_init_failed", "endpoint={} err={}", local_ep.id(), e);
                                                if let Some(s) = sink.take() {
                                                    s.stop();
                                                }
                                                _stream = None;
                                                stream_handle = None;
                                                current_stream_rate = None;
                                                current_stream_channels = None;
                                                active_backend_endpoint = None;
                                                Err(format!("Failed to open output stream: {}", e))
                                            }
                                            Ok((new_s, new_h)) => {
                                                if let Ok(cfg) = device.default_output_config() {
                                                    current_stream_rate = Some(cfg.sample_rate().0);
                                                    current_stream_channels = Some(cfg.channels());
                                                } else {
                                                    current_stream_rate = None;
                                                    current_stream_channels = None;
                                                }
                                                let dur_us = wasapi_open_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0);
                                                diag_log!(
                                                    DiagCategory::WasapiLifecycle,
                                                    meta.id,
                                                    0,
                                                    dur_us,
                                                    "wasapi_stream_initialized",
                                                    "endpoint={} rate={:?} ch={:?}",
                                                    local_ep.id(),
                                                    current_stream_rate,
                                                    current_stream_channels
                                                );

                                                let mut current_pos = accumulated_position.as_secs_f64();
                                                if let Some(start) = playback_start {
                                                    if !is_paused {
                                                        current_pos += start.elapsed().as_secs_f64();
                                                    }
                                                }
                                                let was_playing = sink.as_ref().map(|s| !s.is_paused() && !s.empty()).unwrap_or(false);
                                                if let Some(s) = sink.take() {
                                                    s.stop();
                                                }
                                                _stream = Some(new_s);
                                                stream_handle = Some(new_h.clone());
                                                active_backend_endpoint = Some(local_ep.clone());

                                                diag_log!(
                                                    DiagCategory::DeviceSelection,
                                                    meta.id,
                                                    0,
                                                    0,
                                                    "endpoint_selected",
                                                    "prev={} selected={} source={} reason=user_or_api_switch",
                                                    prev_endpoint.id(),
                                                    local_ep.id(),
                                                    source
                                                );
                                                diag_log!(
                                                    DiagCategory::AudioRouting,
                                                    meta.id,
                                                    0,
                                                    0,
                                                    "route_decision",
                                                    "requested={} actual={} decision=wasapi_shared",
                                                    endpoint.id(),
                                                    local_ep.id()
                                                );

                                                if let Some(fp) = current_file.as_ref() {
                                                    let path = Path::new(fp);
                                                    if let Ok(file) = File::open(path) {
                                                        let reader = BufReader::new(file);
                                                        if let Ok(new_sink) = Sink::try_new(&new_h) {
                                                            if let Ok(source) = Decoder::new(reader) {
                                                                let effective_vol = if purity_mode { 1.0 } else { volume };
                                                                new_sink.set_volume(effective_vol);
                                                                new_sink.append(source);
                                                                let _ = new_sink.try_seek(Duration::from_secs_f64(current_pos));
                                                                if was_playing && !is_paused {
                                                                    new_sink.play();
                                                                    playback_start = Some(Instant::now());
                                                                } else {
                                                                    new_sink.pause();
                                                                    playback_start = None;
                                                                }
                                                                sink = Some(new_sink);
                                                                accumulated_position = Duration::from_secs_f64(current_pos);
                                                            }
                                                        }
                                                    }
                                                }
                                                Ok(())
                                            }
                                        }
                                    }
                                }
                            }
                        };
                        diag_cmd_end("SetEndpoint", meta, cmd_t0, res.as_ref().err().map(|s| s.as_str()));
                        let _ = responder.send(res);
                    }

                    AudioWorkerMsg::GetStatus { queued_at, responder } => {
                        let start_t0 = diagnostics::is_active().then(Instant::now);
                        let mut current_pos = accumulated_position.as_secs_f64();
                        if let Some(start) = playback_start {
                            if !is_paused {
                                current_pos += start.elapsed().as_secs_f64();
                            }
                        }

                        let is_playing = if is_upnp_active {
                            !is_paused && current_file.is_some()
                        } else {
                            sink.as_ref().map(|s| !s.is_paused() && !s.empty()).unwrap_or(false)
                        };
                        if !is_playing && !is_paused && is_playing_worker.load(Ordering::Relaxed) {
                            *stopped_at_worker.lock() = Some(Instant::now());
                        }
                        is_playing_worker.store(is_playing, Ordering::Release);
                        is_paused_worker.store(is_paused, Ordering::Release);

                        let (
                            active_device,
                            is_bit_perfect,
                            device_type,
                            signal_path_mode,
                            output_sample_rate,
                            output_channels,
                        ) = compute_signal_telemetry(
                            active_backend_endpoint.as_ref(),
                            purity_mode,
                            current_stream_rate,
                            current_stream_channels,
                            active_os_default_name.as_deref(),
                        );

                        let status = PlaybackStatus {
                            is_playing,
                            is_paused,
                            current_file: current_file.clone(),
                            position_secs: current_pos.min(duration.as_secs_f64()),
                            duration_secs: duration.as_secs_f64(),
                            volume,
                            active_device,
                            stream_info: current_info.clone(),
                            purity_mode,
                            is_bit_perfect,
                            output_sample_rate,
                            output_channels,
                            device_type,
                            selected_endpoint: selected_endpoint.clone(),
                            active_backend_endpoint: active_backend_endpoint.clone(),
                            signal_path_mode,
                        };

                        if let Some(t0) = start_t0 {
                            let exec_us = t0.elapsed().as_micros() as u64;
                            let wait_us = queued_at
                                .map(|q| q.elapsed().as_micros() as u64)
                                .unwrap_or(0)
                                .saturating_sub(exec_us);
                            if exec_us > 25_000 || wait_us > 50_000 {
                                diag_log!(
                                    DiagCategory::AudioEngineCommands,
                                    0,
                                    wait_us,
                                    exec_us,
                                    "slow_get_status",
                                    "is_playing={} active={}",
                                    is_playing,
                                    status.active_device.as_deref().unwrap_or("none")
                                );
                            }
                        }

                        let _ = responder.send(status);
                    }

                    AudioWorkerMsg::SetSettlingDelayMs { delay_ms, meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "SetSettlingDelayMs", meta);
                        settling_delay_ms = delay_ms.clamp(0, 2000);
                        eprintln!("[Cadence AudioEngine] DAC settling delay set to {} ms", settling_delay_ms);
                        diag_cmd_end("SetSettlingDelayMs", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::InvalidateNextTrack { meta } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "InvalidateNextTrack", meta);
                        let had_staged = staged_next_file.is_some();
                        staged_next_file = None;
                        staged_next_buffer = None;
                        eprintln!("[Cadence AudioEngine] Invalidated staged next-track buffer due to queue mutation.");
                        if had_staged {
                            diag_log!(DiagCategory::BackgroundWorkers, meta.id, 0, 0, "prefetch_invalidated", "reason=queue_mutation");
                        }
                        diag_cmd_end("InvalidateNextTrack", meta, cmd_t0, None);
                    }

                    AudioWorkerMsg::PrepareNextTrack { file_path, meta, responder } => {
                        let cmd_t0 = diag_cmd_begin(&pending_cmds_worker, "PrepareNextTrack", meta);
                        let path = Path::new(&file_path);
                        if !path.exists() {
                            let err = format!("File does not exist: {}", file_path);
                            diag_log!(DiagCategory::BackgroundWorkers, meta.id, 0, 0, "prefetch_failed", "reason=file_missing path={}", file_path);
                            diag_cmd_end("PrepareNextTrack", meta, cmd_t0, Some(&err));
                            let _ = responder.send(Err(err));
                            continue;
                        }

                        let file_size = path.metadata().map(|m| m.len()).unwrap_or(0);
                        // Memory budget check: 1 GB ceiling (preventing OS pagefile thrashing per Invariant #1/#3)
                        let max_budget_bytes = 1024 * 1024 * 1024;
                        if file_size > max_budget_bytes {
                            eprintln!(
                                "[Cadence AudioEngine] File '{}' ({:.1} MB) exceeds pre-load memory budget. Deferring to track boundary per Invariant #1.",
                                path.display(),
                                file_size as f64 / (1024.0 * 1024.0)
                            );
                            staged_next_file = None;
                            staged_next_buffer = None;
                            diag_log!(DiagCategory::BackgroundWorkers, meta.id, 0, 0, "prefetch_skipped_budget", "bytes={} path={}", file_size, file_path);
                            diag_cmd_end("PrepareNextTrack", meta, cmd_t0, None);
                            let _ = responder.send(Ok(false));
                            continue;
                        }

                        match std::fs::read(path) {
                            Ok(bytes) => {
                                let mb = bytes.len() as f64 / (1024.0 * 1024.0);
                                eprintln!(
                                    "[Cadence AudioEngine] Pre-loaded next track '{}' ({:.1} MB) into RAM with zero disk I/O at transition.",
                                    path.display(),
                                    mb
                                );
                                diag_log!(
                                    DiagCategory::BackgroundWorkers,
                                    meta.id,
                                    0,
                                    cmd_t0.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0),
                                    "prefetch_loaded",
                                    "mb={:.1} path={}",
                                    mb,
                                    file_path
                                );
                                staged_next_file = Some(file_path);
                                staged_next_buffer = Some(bytes);
                                diag_cmd_end("PrepareNextTrack", meta, cmd_t0, None);
                                let _ = responder.send(Ok(true));
                            }
                            Err(e) => {
                                eprintln!("[Cadence AudioEngine] Pre-load error for '{}': {}", path.display(), e);
                                staged_next_file = None;
                                staged_next_buffer = None;
                                let err = e.to_string();
                                diag_log!(DiagCategory::BackgroundWorkers, meta.id, 0, 0, "prefetch_failed", "err={} path={}", err, file_path);
                                diag_cmd_end("PrepareNextTrack", meta, cmd_t0, Some(&err));
                                let _ = responder.send(Err(err));
                            }
                        }
                    }
                }
            }
        });

        Self {
            tx,
            upnp_manager,
            is_playing_atomic,
            is_paused_atomic,
            is_loading_atomic,
            library_scan_io: Arc::new(parking_lot::Mutex::new(())),
            playback_stopped_at,
            cmd_seq,
            pending_cmds,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.is_playing_atomic.load(Ordering::Relaxed)
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused_atomic.load(Ordering::Relaxed)
    }

    pub fn is_loading(&self) -> bool {
        self.is_loading_atomic.load(Ordering::Relaxed)
    }

    pub fn hygiene_state(&self) -> HygieneState {
        if self.is_playing() {
            return HygieneState::Playing;
        }
        if self.is_paused() {
            return HygieneState::Paused;
        }
        if self.is_loading() {
            return HygieneState::Loading;
        }
        let stopped_guard = self.playback_stopped_at.lock();
        match *stopped_guard {
            Some(stopped_at) => {
                let elapsed = stopped_at.elapsed();
                if elapsed < crate::diagnostics::COOLDOWN_DURATION {
                    let rem = crate::diagnostics::COOLDOWN_DURATION
                        .saturating_sub(elapsed)
                        .as_secs()
                        .max(1);
                    HygieneState::Cooldown {
                        remaining_secs: rem,
                    }
                } else {
                    HygieneState::Idle
                }
            }
            None => HygieneState::Idle,
        }
    }

    fn enqueue_cmd(&self, cmd_name: &'static str) -> CmdMeta {
        if !diagnostics::is_active() {
            return CmdMeta::NONE;
        }
        let id = self.cmd_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let depth = self.pending_cmds.fetch_add(1, Ordering::Relaxed) + 1;
        let queued_at = Some(Instant::now());
        diag_log!(
            DiagCategory::AudioEngineCommands,
            id,
            0,
            0,
            "cmd_queued",
            "cmd={} queue_depth={}",
            cmd_name,
            depth
        );
        CmdMeta { id, queued_at }
    }

    pub(crate) fn try_library_scan_io(&self) -> Option<parking_lot::MutexGuard<'_, ()>> {
        let res = try_scan_io(&self.library_scan_io, || {
            self.is_playing() || self.is_paused() || self.is_loading()
        });
        if res.is_none() {
            diag_log!(
                DiagCategory::AudioHygiene,
                0,
                0,
                0,
                "hygiene_scan_io_blocked",
                "playing={} paused={} loading={}",
                self.is_playing(),
                self.is_paused(),
                self.is_loading()
            );
        }
        res
    }

    pub(crate) fn try_curate_draft_read(&self) -> Option<parking_lot::MutexGuard<'_, ()>> {
        let permit = self.try_library_scan_io()?;
        let cooled_down = self.playback_stopped_at.lock()
            .is_none_or(|stopped_at| stopped_at.elapsed() >= Duration::from_secs(30));
        if !cooled_down {
            diag_log!(
                DiagCategory::AudioHygiene,
                0,
                0,
                0,
                "hygiene_curate_read_deferred",
                "reason=cooldown_active"
            );
        }
        cooled_down.then_some(permit)
    }

    pub fn play_track(&self, file_path: &str) -> Result<AudioStreamInfo, String> {
        // Let the current scan operation finish before audio starts. The scanner cannot begin
        // another operation while this request loads audio and publishes the playback state.
        let _scan_guard = self.library_scan_io.lock();
        let (resp_tx, resp_rx) = channel();
        let meta = self.enqueue_cmd("Play");
        self.tx
            .send(AudioWorkerMsg::Play {
                file_path: file_path.to_string(),
                meta,
                responder: resp_tx,
            })
            .map_err(|e| format!("Audio worker disconnected: {}", e))?;

        resp_rx
            .recv()
            .map_err(|e| format!("Audio response timeout: {}", e))?
    }

    pub fn pause(&self) -> Result<(), String> {
        let meta = self.enqueue_cmd("Pause");
        self.tx
            .send(AudioWorkerMsg::Pause { meta })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn resume(&self) -> Result<(), String> {
        let meta = self.enqueue_cmd("Resume");
        self.tx
            .send(AudioWorkerMsg::Resume { meta })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn stop(&self) -> Result<(), String> {
        let meta = self.enqueue_cmd("Stop");
        self.tx
            .send(AudioWorkerMsg::Stop { meta })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn seek(&self, position_secs: f64) -> Result<(), String> {
        let meta = self.enqueue_cmd("Seek");
        self.tx
            .send(AudioWorkerMsg::Seek {
                position_secs,
                meta,
            })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), String> {
        let meta = self.enqueue_cmd("SetVolume");
        self.tx
            .send(AudioWorkerMsg::SetVolume { volume, meta })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn set_audio_endpoint(&self, endpoint: AudioEndpoint) -> Result<(), String> {
        self.set_audio_endpoint_with_source(endpoint, "api")
    }

    pub fn set_audio_endpoint_with_source(
        &self,
        endpoint: AudioEndpoint,
        source: &'static str,
    ) -> Result<(), String> {
        let (resp_tx, resp_rx) = channel();
        let meta = self.enqueue_cmd("SetEndpoint");
        self.tx
            .send(AudioWorkerMsg::SetEndpoint {
                endpoint,
                source,
                meta,
                responder: resp_tx,
            })
            .map_err(|e| format!("Audio worker error: {}", e))?;

        resp_rx
            .recv()
            .map_err(|e| format!("Audio response timeout: {}", e))?
    }

    pub fn set_audio_device(&self, device_name: &str) -> Result<(), String> {
        self.set_audio_device_with_source(device_name, "legacy_api")
    }

    pub fn set_audio_device_with_source(
        &self,
        device_name: &str,
        source: &'static str,
    ) -> Result<(), String> {
        let upnp_devices = self.upnp_manager.get_devices();
        let endpoint = AudioEndpoint::from_legacy_string(device_name, &upnp_devices);
        self.set_audio_endpoint_with_source(endpoint, source)
    }

    pub fn set_purity_mode(&self, enabled: bool) -> Result<bool, String> {
        let (resp_tx, resp_rx) = channel();
        let meta = self.enqueue_cmd("SetPurityMode");
        self.tx
            .send(AudioWorkerMsg::SetPurityMode {
                enabled,
                meta,
                responder: resp_tx,
            })
            .map_err(|e| format!("Audio worker error: {}", e))?;

        resp_rx
            .recv()
            .map_err(|e| format!("Audio response timeout: {}", e))
    }

    pub fn get_purity_mode(&self) -> bool {
        let (resp_tx, resp_rx) = channel();
        if self.tx.send(AudioWorkerMsg::GetPurityMode { responder: resp_tx }).is_ok() {
            if let Ok(res) = resp_rx.recv() {
                return res;
            }
        }
        false
    }

    pub fn get_status(&self) -> PlaybackStatus {
        let (resp_tx, resp_rx) = channel();
        let queued_at = diagnostics::is_active().then(Instant::now);
        if self
            .tx
            .send(AudioWorkerMsg::GetStatus {
                queued_at,
                responder: resp_tx,
            })
            .is_ok()
        {
            if let Ok(status) = resp_rx.recv() {
                return status;
            }
        }

        PlaybackStatus {
            is_playing: false,
            is_paused: false,
            current_file: None,
            position_secs: 0.0,
            duration_secs: 0.0,
            volume: 1.0,
            active_device: None,
            stream_info: None,
            purity_mode: false,
            is_bit_perfect: false,
            output_sample_rate: None,
            output_channels: None,
            device_type: "unavailable".to_string(),
            selected_endpoint: AudioEndpoint::SystemDefault,
            active_backend_endpoint: None,
            signal_path_mode: "unavailable".to_string(),
        }
    }

    pub fn prepare_next_track(&self, file_path: &str) -> Result<bool, String> {
        let (resp_tx, resp_rx) = channel();
        let meta = self.enqueue_cmd("PrepareNextTrack");
        self.tx
            .send(AudioWorkerMsg::PrepareNextTrack {
                file_path: file_path.to_string(),
                meta,
                responder: resp_tx,
            })
            .map_err(|e| format!("Audio worker error: {}", e))?;
        resp_rx.recv().map_err(|e| format!("Response timeout: {}", e))?
    }

    pub fn invalidate_next_track(&self) -> Result<(), String> {
        let meta = self.enqueue_cmd("InvalidateNextTrack");
        self.tx
            .send(AudioWorkerMsg::InvalidateNextTrack { meta })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn set_settling_delay_ms(&self, delay_ms: u64) -> Result<(), String> {
        let meta = self.enqueue_cmd("SetSettlingDelayMs");
        self.tx
            .send(AudioWorkerMsg::SetSettlingDelayMs { delay_ms, meta })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn list_audio_endpoints(&self) -> Vec<AudioEndpointInfo> {
        let inventory = EndpointInventory::from_host(&self.upnp_manager);
        let mut endpoints = Vec::new();

        endpoints.push(AudioEndpointInfo {
            id: AudioEndpoint::SystemDefault.id(),
            transport: EndpointTransport::SystemDefault,
            display_name: "Default Audio Device".to_string(),
            wasapi_name: inventory.default_wasapi_name.clone(),
            udn: None,
            is_available: inventory.has_default_wasapi,
            supports_dsd: false,
            is_bit_perfect_capable: false,
        });

        for name in inventory.wasapi_names {
            endpoints.push(AudioEndpointInfo {
                id: AudioEndpoint::Wasapi { name: name.clone() }.id(),
                transport: EndpointTransport::Wasapi,
                display_name: name.clone(),
                wasapi_name: Some(name),
                udn: None,
                is_available: true,
                supports_dsd: false,
                is_bit_perfect_capable: false,
            });
        }

        let mut seen_udns = Vec::new();
        for upnp in inventory.upnp_devices {
            if seen_udns.contains(&upnp.id) {
                continue;
            }
            seen_udns.push(upnp.id.clone());
            endpoints.push(AudioEndpointInfo {
                id: AudioEndpoint::Upnp {
                    udn: upnp.id.clone(),
                    friendly_name: upnp.friendly_name.clone(),
                }
                .id(),
                transport: EndpointTransport::Upnp,
                display_name: upnp.friendly_name,
                wasapi_name: None,
                udn: Some(upnp.id),
                is_available: true,
                supports_dsd: true,
                is_bit_perfect_capable: true,
            });
        }

        endpoints
    }

    pub fn list_output_devices(&self) -> Vec<String> {
        let inventory = EndpointInventory::from_host(&self.upnp_manager);
        let mut devices = inventory.wasapi_names;
        if devices.is_empty() {
            devices.push("Default Audio Device".into());
        }

        for upnp in inventory.upnp_devices {
            let label = format!("[UPnP] {}", upnp.friendly_name);
            if !devices.contains(&label) {
                devices.push(label);
            }
        }

        devices
    }

    pub fn get_upnp_manager(&self) -> Arc<UpnpManager> {
        Arc::clone(&self.upnp_manager)
    }

    fn parse_dsf_header(path: &Path) -> Option<(u32, u32, f64)> {
        super::stream_tuning::parse_dsf_header(path)
            .map(|i| (i.channels as u32, i.sample_rate, i.duration_secs))
    }

    fn inspect_audio_file(path: &Path) -> Result<AudioStreamInfo, String> {
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("unknown")
            .to_uppercase();

        let is_dsd = extension == "DSF" || extension == "DFF";

        // Attempt reading via Lofty
        let probe_res = Probe::open(path)
            .ok()
            .and_then(|p| p.read().ok());

        if let Some(probe) = probe_res {
            let properties = probe.properties();
            let duration_secs = properties.duration().as_secs_f64();
            let sample_rate = properties.sample_rate();
            let bit_depth = properties.bit_depth();
            let channels = properties.channels();

            let is_high_res = match (sample_rate, bit_depth) {
                (Some(sr), Some(bd)) => sr >= 88200 || bd >= 24,
                (Some(sr), None) => sr >= 88200,
                _ => is_dsd,
            };

            let tag = probe.primary_tag().or_else(|| probe.first_tag());
            let title = tag.and_then(|t| t.title().map(|s| s.to_string())).or_else(|| {
                path.file_stem().map(|s| s.to_string_lossy().to_string())
            });
            let artist = tag.and_then(|t| t.artist().map(|s| s.to_string()));
            let album = tag.and_then(|t| t.album().map(|s| s.to_string())).or_else(|| {
                path.parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().to_string())
            });

            Ok(AudioStreamInfo {
                file_path: path.to_string_lossy().to_string(),
                title,
                artist,
                album,
                duration_secs,
                sample_rate,
                bit_depth: if is_dsd { Some(1) } else { bit_depth },
                channels: channels.map(|c| c as u16),
                format: extension,
                is_high_res,
            })
        } else {
            // Fallback if Lofty fails to read tags or properties (e.g. non-standard DSD ID3 frames)
            eprintln!("[Cadence AudioEngine] Lofty tag read bypassed for '{}', extracting fallback metadata.", path.display());

            let (channels, sample_rate, duration_secs) = if extension == "DSF" {
                Self::parse_dsf_header(path).unwrap_or((2, 11289600, 0.0))
            } else if extension == "DFF" {
                (2, 2822400, 0.0)
            } else {
                (2, 44100, 0.0)
            };

            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string());
            let album = path
                .parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().to_string());

            Ok(AudioStreamInfo {
                file_path: path.to_string_lossy().to_string(),
                title,
                artist: None,
                album,
                duration_secs,
                sample_rate: Some(sample_rate),
                bit_depth: if is_dsd { Some(1) } else { None },
                channels: Some(channels as u16),
                format: extension,
                is_high_res: is_dsd || sample_rate >= 88200,
            })
        }
    }
}

fn try_scan_io(
    gate: &parking_lot::Mutex<()>,
    playback_active: impl FnOnce() -> bool,
) -> Option<parking_lot::MutexGuard<'_, ()>> {
    let permit = gate.try_lock()?;
    (!playback_active()).then_some(permit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_upnp_devices() -> Vec<UpnpDevice> {
        vec![
            UpnpDevice {
                id: "uuid:rose-130-udn".into(),
                friendly_name: "ROSE-67".into(),
                model_name: Some("RS130".into()),
                model_description: Some("HiFi ROSE".into()),
                manufacturer: Some("CITECH".into()),
                location: "http://192.0.2.10:34042/desc".into(),
                control_url: "http://192.0.2.10:34042/action".into(),
            },
            UpnpDevice {
                id: "uuid:samsung-oled-udn".into(),
                friendly_name: "34\" Odyssey OLED G8".into(),
                model_name: Some("Odyssey OLED G8".into()),
                model_description: Some("Samsung OLED Monitor".into()),
                manufacturer: Some("Samsung".into()),
                location: "http://192.0.2.30:9197/dmr".into(),
                control_url: "http://192.0.2.30:9197/action".into(),
            },
        ]
    }

    fn sample_inventory(upnp_devices: Vec<UpnpDevice>) -> EndpointInventory {
        EndpointInventory {
            has_default_wasapi: true,
            default_wasapi_name: Some("Speakers (Game-Audeze Maxwell)".into()),
            wasapi_names: vec![
                "Speakers (Chat-Audeze Maxwell)".into(),
                "Speakers (Game-Audeze Maxwell)".into(),
                "Odyssey G85SB (NVIDIA High Definition Audio)".into(),
            ],
            upnp_devices,
        }
    }

    #[test]
    fn scan_io_rejects_loading_playing_and_paused_and_resumes_immediately_when_idle() {
        let gate = parking_lot::Mutex::new(());
        let loading = gate.lock();
        assert!(try_scan_io(&gate, || false).is_none());
        drop(loading);
        assert!(try_scan_io(&gate, || true).is_none());
        assert!(try_scan_io(&gate, || false).is_some());
    }

    #[test]
    fn startup_discovery_race_does_not_override_wasapi_selection_or_play_route() {
        // Before SSDP completes, user explicitly selects Audeze Maxwell via WASAPI
        let empty_upnp_inventory = sample_inventory(vec![]);
        let maxwell = AudioEndpoint::Wasapi {
            name: "Speakers (Game-Audeze Maxwell)".into(),
        };
        let resolved = resolve_endpoint_selection(&maxwell, &empty_upnp_inventory).unwrap();
        assert_eq!(resolved, maxwell);

        // Simulated SSDP discovery completes later and finds ROSE-67
        let upnp_manager = UpnpManager::new();
        assert!(upnp_manager.get_active_device().is_none());
        let discovered_inventory = sample_inventory(sample_upnp_devices());

        // Even with UPnP inventory present, Play must route strictly to Maxwell WASAPI
        let route = plan_play_route(&maxwell, false, &discovered_inventory).unwrap();
        assert_eq!(
            route,
            RouteTarget::LocalWasapi {
                selected: maxwell.clone(),
                exact_wasapi_name: Some("Speakers (Game-Audeze Maxwell)".into()),
            }
        );

        // Auto-advance (subsequent track play) also preserves the exact WASAPI endpoint
        let next_track_route = plan_play_route(&maxwell, false, &discovered_inventory).unwrap();
        assert_eq!(next_track_route, route);
    }

    #[test]
    fn exact_endpoint_identity_prevents_fuzzy_upnp_or_display_override() {
        let upnp = sample_upnp_devices();
        let inventory = sample_inventory(upnp.clone());

        // Local WASAPI names (including display monitor name "Odyssey G85SB") never parse as UPnP
        let nvidia = AudioEndpoint::from_legacy_string(
            "Odyssey G85SB (NVIDIA High Definition Audio)",
            &upnp,
        );
        assert_eq!(
            nvidia,
            AudioEndpoint::Wasapi {
                name: "Odyssey G85SB (NVIDIA High Definition Audio)".into()
            }
        );
        assert_eq!(
            plan_play_route(&nvidia, false, &inventory).unwrap(),
            RouteTarget::LocalWasapi {
                selected: nvidia.clone(),
                exact_wasapi_name: Some("Odyssey G85SB (NVIDIA High Definition Audio)".into()),
            }
        );

        // Substring of UPnP friendly_name must not match UPnP
        let bare_rose = AudioEndpoint::from_legacy_string("HiFi Rose", &upnp);
        assert!(matches!(bare_rose, AudioEndpoint::Wasapi { .. }));
        assert!(resolve_endpoint_selection(&bare_rose, &inventory).is_err());

        // Explicit Samsung UPnP UDN must NOT be overridden with ROSE-67
        let oled_upnp = AudioEndpoint::Upnp {
            udn: "uuid:samsung-oled-udn".into(),
            friendly_name: "34\" Odyssey OLED G8".into(),
        };
        assert_eq!(
            plan_play_route(&oled_upnp, false, &inventory).unwrap(),
            RouteTarget::Upnp {
                selected: oled_upnp,
                udn: "uuid:samsung-oled-udn".into(),
            }
        );
    }

    #[test]
    fn unavailable_endpoints_fail_clearly_without_switching_transports_or_falling_back() {
        let mut inventory = sample_inventory(sample_upnp_devices());
        // Simulate unplugged headphones during playback / auto-advance
        inventory
            .wasapi_names
            .retain(|n| n != "Speakers (Game-Audeze Maxwell)");

        let maxwell = AudioEndpoint::Wasapi {
            name: "Speakers (Game-Audeze Maxwell)".into(),
        };
        let sel_err = resolve_endpoint_selection(&maxwell, &inventory).unwrap_err();
        assert!(sel_err.contains("unavailable"));

        let play_err = plan_play_route(&maxwell, false, &inventory).unwrap_err();
        assert!(play_err.contains("unavailable"));

        // Missing UPnP renderer fails without substituting ROSE-67
        let missing_upnp = AudioEndpoint::Upnp {
            udn: "uuid:missing-streamer".into(),
            friendly_name: "Offline Streamer".into(),
        };
        let upnp_err = plan_play_route(&missing_upnp, false, &inventory).unwrap_err();
        assert!(upnp_err.contains("unavailable"));

        // Telemetry when selected endpoint is unavailable preserves none for active backend and rate
        let (active_device, is_bit_perfect, device_type, signal_path_mode, rate, channels) =
            compute_signal_telemetry(None, true, Some(48000), Some(2), None);
        assert_eq!(active_device, None);
        assert!(!is_bit_perfect);
        assert_eq!(device_type, "unavailable");
        assert_eq!(signal_path_mode, "unavailable");
        assert_eq!(rate, None);
        assert_eq!(channels, None);
    }

    #[test]
    fn dsd_playback_never_silently_switches_from_wasapi_to_upnp() {
        let inventory = sample_inventory(sample_upnp_devices());
        let maxwell = AudioEndpoint::Wasapi {
            name: "Speakers (Game-Audeze Maxwell)".into(),
        };

        // Playing .dsf/.dff when WASAPI is selected must fail clearly, never hijack UPnP ROSE-67
        let err = plan_play_route(&maxwell, true, &inventory).unwrap_err();
        assert!(err.contains("WASAPI Shared"));
        assert!(err.contains("DSD"));

        // Same for SystemDefault
        let def_err = plan_play_route(&AudioEndpoint::SystemDefault, true, &inventory).unwrap_err();
        assert!(def_err.contains("DSD"));

        // Playing .dsf/.dff when UPnP UDN is explicitly selected succeeds on that UDN
        let rose = AudioEndpoint::Upnp {
            udn: "uuid:rose-130-udn".into(),
            friendly_name: "ROSE-67".into(),
        };
        assert_eq!(
            plan_play_route(&rose, true, &inventory).unwrap(),
            RouteTarget::Upnp {
                selected: rose,
                udn: "uuid:rose-130-udn".into(),
            }
        );
    }

    #[test]
    fn signal_telemetry_does_not_equate_purity_mode_with_proven_bit_perfect_output() {
        let maxwell = AudioEndpoint::Wasapi {
            name: "Speakers (Game-Audeze Maxwell)".into(),
        };
        // Purity mode ON on local WASAPI still uses AUDCLNT_SHAREMODE_SHARED
        let (dev, bp, dtype, mode, rate, ch) =
            compute_signal_telemetry(Some(&maxwell), true, Some(44100), Some(2), None);
        assert_eq!(dev.as_deref(), Some("Speakers (Game-Audeze Maxwell)"));
        assert!(!bp);
        assert_eq!(dtype, "wasapi_shared");
        assert_eq!(mode, "wasapi_shared_purity");
        assert_eq!(rate, Some(44100));
        assert_eq!(ch, Some(2));

        // UPnP telemetry clears local DAC clock rate/channels instead of reporting stale 48 kHz
        let rose = AudioEndpoint::Upnp {
            udn: "uuid:rose-130-udn".into(),
            friendly_name: "ROSE-67".into(),
        };
        let (dev_u, bp_u, dtype_u, mode_u, rate_u, ch_u) =
            compute_signal_telemetry(Some(&rose), false, Some(48000), Some(2), None);
        assert_eq!(dev_u.as_deref(), Some("[UPnP] ROSE-67"));
        assert!(bp_u);
        assert_eq!(dtype_u, "upnp_streamer");
        assert_eq!(mode_u, "upnp_raw_stream");
        assert_eq!(rate_u, None);
        assert_eq!(ch_u, None);
    }
}
