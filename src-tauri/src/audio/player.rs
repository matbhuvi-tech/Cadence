use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use rodio::{Decoder, OutputStream, Sink};
use serde::{Deserialize, Serialize};

use super::upnp::UpnpManager;

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
}

enum AudioWorkerMsg {
    Play {
        file_path: String,
        responder: Sender<Result<AudioStreamInfo, String>>,
    },
    Pause,
    Resume,
    Stop,
    Seek {
        position_secs: f64,
    },
    SetVolume {
        volume: f32,
    },
    SetDevice {
        device_name: String,
        responder: Sender<Result<(), String>>,
    },
    SetPurityMode {
        enabled: bool,
        responder: Sender<bool>,
    },
    GetPurityMode {
        responder: Sender<bool>,
    },
    GetStatus {
        responder: Sender<PlaybackStatus>,
    },
}

#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioWorkerMsg>,
    upnp_manager: Arc<UpnpManager>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioWorkerMsg>();
        let upnp_manager = Arc::new(UpnpManager::new());
        let upnp_worker_ref = Arc::clone(&upnp_manager);

        // Run initial background SSDP scan on engine startup so devices like HiFi Rose are ready immediately
        let bg_upnp = Arc::clone(&upnp_manager);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
            if let Ok(runtime) = rt {
                runtime.block_on(async {
                    let devs = bg_upnp.discover_devices().await;
                    eprintln!("[Cadence AudioEngine] Initial SSDP scan discovered {} UPnP devices", devs.len());
                    if let Some(top_streamer) = devs.iter().find(|d| !d.is_display_device()) {
                        let _ = bg_upnp.set_active_device(&top_streamer.id);
                        eprintln!("[Cadence AudioEngine] Auto-locked active UPnP streamer to '{}' [{:?}]", top_streamer.friendly_name, top_streamer.model_name);
                    }
                });
            }
        });

        std::thread::spawn(move || {
            let (mut _stream, mut stream_handle) = match OutputStream::try_default() {
                Ok((s, h)) => (Some(s), Some(h)),
                Err(e) => {
                    eprintln!("[Cadence AudioEngine] Failed to init default output stream: {}", e);
                    (None, None)
                }
            };

            let default_device = cpal::default_host()
                .default_output_device()
                .map(|d| d.name().unwrap_or_else(|_| "Default Audio Device".into()));

            let mut sink: Option<Sink> = None;
            let mut current_file: Option<String> = None;
            let mut duration = Duration::ZERO;
            let mut playback_start: Option<Instant> = None;
            let mut accumulated_position = Duration::ZERO;
            let mut is_paused = false;
            let mut volume: f32 = 1.0;
            let mut saved_user_volume: f32 = 1.0;
            let mut purity_mode: bool = false;
            let mut active_device_name = default_device;
            let mut current_info: Option<AudioStreamInfo> = None;
            let mut current_stream_rate: Option<u32> = Some(48000);
            let mut current_stream_channels: Option<u16> = Some(2);
            let mut is_upnp_active = false;

            while let Ok(msg) = rx.recv() {
                match msg {
                    AudioWorkerMsg::SetPurityMode { enabled, responder } => {
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
                        let _ = responder.send(purity_mode);
                    }

                    AudioWorkerMsg::GetPurityMode { responder } => {
                        let _ = responder.send(purity_mode);
                    }

                    AudioWorkerMsg::Play { file_path, responder } => {
                        // Immediately stop any running local sink or UPnP playback
                        // This prevents previous song from continuing to play from memory on errors or transitions!
                        if let Some(s) = sink.take() {
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
                            let _ = responder.send(Err(format!("File does not exist: {}", file_path)));
                            continue;
                        }

                        let info_res = Self::inspect_audio_file(path);
                        let stream_info = match info_res {
                            Ok(i) => i,
                            Err(e) => {
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

                        // Check if active device is a UPnP network streamer
                        let mut is_upnp_target = active_device_name
                            .as_ref()
                            .map(|n| n.starts_with("[UPnP]") || n.starts_with("uuid:"))
                            .unwrap_or(false);

                        // If active device is currently pointing to a display/monitor, override it with dedicated audiophile streamer:
                        if let Some(ref name) = active_device_name {
                            if name.to_lowercase().contains("odyssey") || name.to_lowercase().contains("oled") || name.to_lowercase().contains("tv") {
                                eprintln!("[Cadence AudioEngine] Active device was set to display monitor ('{}'). Overriding with audiophile streamer...", name);
                                let devices = upnp_worker_ref.get_devices();
                                if let Some(streamer) = devices.iter().find(|d| !d.is_display_device()) {
                                    let _ = upnp_worker_ref.set_active_device(&streamer.id);
                                    active_device_name = Some(format!("[UPnP] {}", streamer.friendly_name));
                                    is_upnp_target = true;
                                }
                            }
                        }

                        // If not explicitly set to UPnP, check if UpnpManager has an active device,
                        // or if active_device_name matches a UPnP streamer:
                        if !is_upnp_target {
                            if let Some(active_dev) = upnp_worker_ref.get_active_device() {
                                active_device_name = Some(format!("[UPnP] {}", active_dev.friendly_name));
                                is_upnp_target = true;
                            } else if let Some(ref name) = active_device_name {
                                if upnp_worker_ref.set_active_device(name).is_ok() {
                                    if let Some(active_dev) = upnp_worker_ref.get_active_device() {
                                        active_device_name = Some(format!("[UPnP] {}", active_dev.friendly_name));
                                        is_upnp_target = true;
                                    }
                                }
                            }
                        }

                        // For native DSD playback:
                        if is_dsd && !is_upnp_target {
                            let devices = upnp_worker_ref.get_devices();
                            // Pick dedicated audiophile streamer, strictly excluding display monitors/TVs
                            if let Some(streamer) = devices.iter().find(|d| !d.is_display_device()).or_else(|| devices.first()) {
                                eprintln!(
                                    "[Cadence AudioEngine] Bit-Perfect DSD stream requested. Selecting audiophile network streamer '{}' ({})",
                                    streamer.friendly_name, streamer.id
                                );
                                let _ = upnp_worker_ref.set_active_device(&streamer.id);
                                active_device_name = Some(format!("[UPnP] {}", streamer.friendly_name));
                                is_upnp_target = true;
                            }
                        }

                        if is_dsd && !is_upnp_target {
                            // Bit-perfect DSD without decoding requires an active UPnP network streamer endpoint
                            let _ = responder.send(Err(
                                "Bit-Perfect DSD Passthrough requires an active UPnP/DLNA endpoint (e.g. HiFi Rose). No network streamer is currently active. Please select your network streamer in Audio Outputs.".to_string()
                            ));
                            continue;
                        }

                        if is_upnp_target {
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
                                    upnp_clone.play_file(&target_path, track_duration, &title, &artist, &album).await
                                }),
                                Err(e) => Err(format!("Tokio runtime error: {}", e)),
                            };

                            match upnp_res {
                                Ok(_) => {
                                    is_upnp_active = true;
                                    current_file = Some(file_path.clone());
                                    duration = Duration::from_secs_f64(stream_info.duration_secs);
                                    playback_start = Some(Instant::now());
                                    accumulated_position = Duration::ZERO;
                                    is_paused = false;
                                    current_info = Some(stream_info.clone());
                                    let _ = responder.send(Ok(stream_info));
                                    continue;
                                }
                                Err(e) => {
                                    eprintln!("[Cadence AudioEngine] UPnP playback failed on '{}': {}", active_device_name.as_deref().unwrap_or(""), e);
                                    is_upnp_active = false;
                                    let _ = responder.send(Err(format!("UPnP streamer error: {}", e)));
                                    continue;
                                }
                            }
                        } else {
                            is_upnp_active = false;
                        }

                        // Local Playback Path: Dynamic Clock/Sample-Rate Matching & Bit-Perfect Stream Negotiation
                        let target_rate = stream_info.sample_rate.unwrap_or(48000);
                        let target_channels = stream_info.channels.unwrap_or(2);

                        let rate_mismatch = current_stream_rate != Some(target_rate)
                            || current_stream_channels != Some(target_channels)
                            || stream_handle.is_none();

                        if rate_mismatch {
                            // Find target cpal Device
                            let host = cpal::default_host();
                            let target_device = match active_device_name.as_ref() {
                                Some(name) if !name.to_lowercase().contains("default") => {
                                    host.output_devices()
                                        .ok()
                                        .and_then(|mut devs| devs.find(|d| d.name().map(|n| &n == name).unwrap_or(false)))
                                        .or_else(|| host.default_output_device())
                                }
                                _ => host.default_output_device(),
                            };

                            if let Some(device) = target_device {
                                let stream_config = cpal::SupportedStreamConfig::new(
                                    target_channels,
                                    cpal::SampleRate(target_rate),
                                    cpal::SupportedBufferSize::Unknown,
                                    cpal::SampleFormat::F32,
                                );

                                eprintln!(
                                    "[Cadence AudioEngine] Negotiating native clock: {} Hz, {} channels on '{}'...",
                                    target_rate,
                                    target_channels,
                                    device.name().unwrap_or_default()
                                );

                                match OutputStream::try_from_device_config(&device, stream_config) {
                                    Ok((s, h)) => {
                                        _stream = Some(s);
                                        stream_handle = Some(h);
                                        current_stream_rate = Some(target_rate);
                                        current_stream_channels = Some(target_channels);
                                        eprintln!("[Cadence AudioEngine] Native clock locked at {} Hz (Exclusive Clock Matching)", target_rate);
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "[Cadence AudioEngine] Target rate {} Hz not natively accepted ({:?}). Falling back to device default...",
                                            target_rate, e
                                        );
                                        if let Ok((s, h)) = OutputStream::try_from_device(&device) {
                                            _stream = Some(s);
                                            stream_handle = Some(h);
                                            if let Ok(cfg) = device.default_output_config() {
                                                current_stream_rate = Some(cfg.sample_rate().0);
                                                current_stream_channels = Some(cfg.channels());
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Re-initialize default output stream if still missing
                        if stream_handle.is_none() {
                            match OutputStream::try_default() {
                                Ok((s, h)) => {
                                    active_device_name = cpal::default_host()
                                        .default_output_device()
                                        .map(|d| d.name().unwrap_or_else(|_| "Default Audio Device".into()));
                                    _stream = Some(s);
                                    stream_handle = Some(h);
                                }
                                Err(e) => {
                                    let _ = responder.send(Err(format!("Audio output device is not available: {}", e)));
                                    continue;
                                }
                            }
                        }

                        let file = match File::open(path) {
                            Ok(f) => f,
                            Err(e) => {
                                let _ = responder.send(Err(format!("Failed to open file: {}", e)));
                                continue;
                            }
                        };
                        let reader = BufReader::new(file);

                        let source = match Decoder::new(reader) {
                            Ok(src) => src,
                            Err(e) => {
                                let _ = responder.send(Err(format!("Decoder failed for audio stream: {}", e)));
                                continue;
                            }
                        };

                        let handle = stream_handle.as_ref().unwrap();
                        let new_sink = match Sink::try_new(handle) {
                            Ok(s) => s,
                            Err(sink_err) => {
                                eprintln!("[Cadence AudioEngine] Sink creation failed ({}), attempting to refresh...", sink_err);
                                match OutputStream::try_default() {
                                    Ok((s, h)) => {
                                        active_device_name = cpal::default_host()
                                            .default_output_device()
                                            .map(|d| d.name().unwrap_or_else(|_| "Default Audio Device".into()));
                                        let sink_result = Sink::try_new(&h);
                                        _stream = Some(s);
                                        stream_handle = Some(h);
                                        match sink_result {
                                            Ok(s) => s,
                                            Err(e) => {
                                                let _ = responder.send(Err(format!("Failed to create audio sink after refresh: {}", e)));
                                                continue;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        let _ = responder.send(Err(format!("Failed to create audio sink: {}", e)));
                                        continue;
                                    }
                                }
                            }
                        };

                        let effective_vol = if purity_mode { 1.0 } else { volume };
                        new_sink.set_volume(effective_vol);
                        new_sink.append(source);
                        new_sink.play();

                        sink = Some(new_sink);
                        current_file = Some(file_path.clone());
                        duration = Duration::from_secs_f64(stream_info.duration_secs);
                        playback_start = Some(Instant::now());
                        accumulated_position = Duration::ZERO;
                        is_paused = false;
                        current_info = Some(stream_info.clone());

                        let _ = responder.send(Ok(stream_info));
                    }

                    AudioWorkerMsg::Pause => {
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
                    }

                    AudioWorkerMsg::Resume => {
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
                    }

                    AudioWorkerMsg::Stop => {
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
                    }

                    AudioWorkerMsg::Seek { position_secs } => {
                        let target_pos = Duration::from_secs_f64(position_secs.max(0.0));
                        if stream_handle.is_none() {
                            if let Ok((s, h)) = OutputStream::try_default() {
                                active_device_name = cpal::default_host()
                                    .default_output_device()
                                    .map(|d| d.name().unwrap_or_else(|_| "Default Audio Device".into()));
                                _stream = Some(s);
                                stream_handle = Some(h);
                            }
                        }
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
                                    }
                                }
                            }
                        }
                    }

                    AudioWorkerMsg::SetVolume { volume: new_vol } => {
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
                    }

                    AudioWorkerMsg::SetDevice { device_name, responder } => {
                        let clean = device_name.trim_start_matches("[UPnP]").trim();
                        // Check if device is explicitly UPnP or matches any discovered UPnP streamer
                        let is_upnp = device_name.starts_with("[UPnP]")
                            || device_name.starts_with("uuid:")
                            || upnp_worker_ref.set_active_device(&device_name).is_ok();

                        if is_upnp {
                            let _ = upnp_worker_ref.set_active_device(&device_name);
                            let resolved_label = upnp_worker_ref
                                .get_active_device()
                                .map(|d| format!("[UPnP] {}", d.friendly_name))
                                .unwrap_or_else(|| format!("[UPnP] {}", clean));

                            eprintln!(
                                "[Cadence AudioEngine] Output route set to network streamer '{}'",
                                resolved_label
                            );

                            active_device_name = Some(resolved_label);
                            is_upnp_active = true;

                            // Stop local sink immediately so sound stops coming from the computer/monitor
                            let was_playing = sink.as_ref().map(|s| !s.is_paused() && !s.empty()).unwrap_or(false);
                            if let Some(s) = sink.take() {
                                s.stop();
                            }

                            // If a track was actively playing, seamlessly transfer streaming to the UPnP renderer
                            if was_playing && !is_paused {
                                if let Some(fp) = current_file.as_ref() {
                                    let upnp_clone = Arc::clone(&upnp_worker_ref);
                                    let target_path = Path::new(fp).to_path_buf();
                                    let track_duration = duration.as_secs_f64();
                                    let title = current_info.as_ref().and_then(|i| i.title.clone()).unwrap_or_else(|| "Cadence Track".into());
                                    let artist = current_info.as_ref().and_then(|i| i.artist.clone()).unwrap_or_else(|| "Unknown Artist".into());
                                    let album = current_info.as_ref().and_then(|i| i.album.clone()).unwrap_or_else(|| "Album".into());

                                    std::thread::spawn(move || {
                                        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                                        if let Ok(runtime) = rt {
                                            let _ = runtime.block_on(async {
                                                let res = upnp_clone.play_file(&target_path, track_duration, &title, &artist, &album).await;
                                                if let Err(err) = res {
                                                    eprintln!("[Cadence AudioEngine] Transfer to UPnP failed: {}", err);
                                                }
                                            });
                                        }
                                    });
                                }
                            }

                            let _ = responder.send(Ok(()));
                            continue;
                        }

                        // Local CPAL Device
                        upnp_worker_ref.clear_active_device();
                        is_upnp_active = false;

                        let host = cpal::default_host();
                        let target_device = if device_name.to_lowercase().contains("default") {
                            host.default_output_device()
                        } else {
                            match host.output_devices() {
                                Ok(mut devs) => devs.find(|d| d.name().map(|n| n == device_name).unwrap_or(false)),
                                Err(e) => {
                                    let _ = responder.send(Err(format!("Error querying devices: {}", e)));
                                    continue;
                                }
                            }
                        };

                        let device = match target_device {
                            Some(d) => d,
                            None => {
                                let _ = responder.send(Err(format!("Audio device '{}' not found", device_name)));
                                continue;
                            }
                        };

                        let (new_s, new_h) = match OutputStream::try_from_device(&device) {
                            Ok(pair) => pair,
                            Err(e) => {
                                let _ = responder.send(Err(format!("Failed to open output stream: {}", e)));
                                continue;
                            }
                        };

                        if let Ok(cfg) = device.default_output_config() {
                            current_stream_rate = Some(cfg.sample_rate().0);
                            current_stream_channels = Some(cfg.channels());
                        }

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
                        active_device_name = Some(device_name.clone());

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

                        let _ = responder.send(Ok(()));
                    }

                    AudioWorkerMsg::GetStatus { responder } => {
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

                        let is_bit_perfect = if is_upnp_active {
                            true // UPnP transmits identical untouched raw audio stream
                        } else if purity_mode {
                            // Local bit-perfect if rates match and volume is unity
                            current_info.as_ref().map(|i| {
                                i.sample_rate == current_stream_rate && (volume - 1.0).abs() < f32::EPSILON
                            }).unwrap_or(true)
                        } else {
                            false
                        };

                        let device_type = if is_upnp_active {
                            "upnp_streamer".to_string()
                        } else if purity_mode {
                            "wasapi_exclusive_clock".to_string()
                        } else {
                            "wasapi_shared".to_string()
                        };

                        let status = PlaybackStatus {
                            is_playing,
                            is_paused,
                            current_file: current_file.clone(),
                            position_secs: current_pos.min(duration.as_secs_f64()),
                            duration_secs: duration.as_secs_f64(),
                            volume,
                            active_device: active_device_name.clone(),
                            stream_info: current_info.clone(),
                            purity_mode,
                            is_bit_perfect,
                            output_sample_rate: current_stream_rate,
                            output_channels: current_stream_channels,
                            device_type,
                        };

                        let _ = responder.send(status);
                    }
                }
            }
        });

        Self {
            tx,
            upnp_manager,
        }
    }

    pub fn play_track(&self, file_path: &str) -> Result<AudioStreamInfo, String> {
        let (resp_tx, resp_rx) = channel();
        self.tx
            .send(AudioWorkerMsg::Play {
                file_path: file_path.to_string(),
                responder: resp_tx,
            })
            .map_err(|e| format!("Audio worker disconnected: {}", e))?;

        resp_rx
            .recv()
            .map_err(|e| format!("Audio response timeout: {}", e))?
    }

    pub fn pause(&self) -> Result<(), String> {
        self.tx
            .send(AudioWorkerMsg::Pause)
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn resume(&self) -> Result<(), String> {
        self.tx
            .send(AudioWorkerMsg::Resume)
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx
            .send(AudioWorkerMsg::Stop)
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn seek(&self, position_secs: f64) -> Result<(), String> {
        self.tx
            .send(AudioWorkerMsg::Seek { position_secs })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), String> {
        self.tx
            .send(AudioWorkerMsg::SetVolume { volume })
            .map_err(|e| format!("Audio worker error: {}", e))
    }

    pub fn set_audio_device(&self, device_name: &str) -> Result<(), String> {
        let (resp_tx, resp_rx) = channel();
        self.tx
            .send(AudioWorkerMsg::SetDevice {
                device_name: device_name.to_string(),
                responder: resp_tx,
            })
            .map_err(|e| format!("Audio worker error: {}", e))?;

        resp_rx
            .recv()
            .map_err(|e| format!("Audio response timeout: {}", e))?
    }

    pub fn set_purity_mode(&self, enabled: bool) -> Result<bool, String> {
        let (resp_tx, resp_rx) = channel();
        self.tx
            .send(AudioWorkerMsg::SetPurityMode {
                enabled,
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
        if self.tx.send(AudioWorkerMsg::GetStatus { responder: resp_tx }).is_ok() {
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
            device_type: "wasapi_shared".to_string(),
        }
    }

    pub fn list_output_devices(&self) -> Vec<String> {
        let host = cpal::default_host();
        let mut devices: Vec<String> = match host.output_devices() {
            Ok(devs) => devs.filter_map(|d| d.name().ok()).collect(),
            Err(_) => vec!["Default Audio Device".into()],
        };

        // Append all discovered UPnP devices
        let upnp_devices = self.upnp_manager.get_devices();
        for upnp in upnp_devices {
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
