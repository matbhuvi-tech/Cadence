use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::mpsc::{channel, Sender};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use rodio::{Decoder, OutputStream, Sink};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct PlaybackStatus {
    pub is_playing: bool,
    pub is_paused: bool,
    pub current_file: Option<String>,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,
    pub active_device: Option<String>,
    pub stream_info: Option<AudioStreamInfo>,
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
    GetStatus {
        responder: Sender<PlaybackStatus>,
    },
}

#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<AudioWorkerMsg>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioWorkerMsg>();

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
            let mut active_device_name = default_device;
            let mut current_info: Option<AudioStreamInfo> = None;

            while let Ok(msg) = rx.recv() {
                match msg {
                    AudioWorkerMsg::Play { file_path, responder } => {
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

                        let handle = match stream_handle.as_ref() {
                            Some(h) => h,
                            None => {
                                let _ = responder.send(Err("No audio output stream handle available".into()));
                                continue;
                            }
                        };

                        let file = match File::open(path) {
                            Ok(f) => f,
                            Err(e) => {
                                let _ = responder.send(Err(format!("Failed to open file: {}", e)));
                                continue;
                            }
                        };
                        let reader = BufReader::new(file);

                        let new_sink = match Sink::try_new(handle) {
                            Ok(s) => s,
                            Err(e) => {
                                let _ = responder.send(Err(format!("Failed to create audio sink: {}", e)));
                                continue;
                            }
                        };

                        let source = match Decoder::new(reader) {
                            Ok(src) => src,
                            Err(e) => {
                                let _ = responder.send(Err(format!("Decoder failed for audio stream: {}", e)));
                                continue;
                            }
                        };

                        new_sink.set_volume(volume);
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
                        if let Some(s) = &sink {
                            if !is_paused {
                                s.pause();
                                if let Some(start) = playback_start {
                                    accumulated_position += start.elapsed();
                                }
                                playback_start = None;
                                is_paused = true;
                            }
                        }
                    }
                    AudioWorkerMsg::Resume => {
                        if let Some(s) = &sink {
                            if is_paused {
                                s.play();
                                playback_start = Some(Instant::now());
                                is_paused = false;
                            }
                        }
                    }
                    AudioWorkerMsg::Stop => {
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        playback_start = None;
                        accumulated_position = Duration::ZERO;
                        is_paused = false;
                        current_file = None;
                    }
                    AudioWorkerMsg::Seek { position_secs } => {
                        if let (Some(fp), Some(handle)) = (current_file.as_ref(), stream_handle.as_ref()) {
                            let target_pos = Duration::from_secs_f64(position_secs.max(0.0));
                            let path = Path::new(fp);
                            if let Ok(file) = File::open(path) {
                                let reader = BufReader::new(file);
                                if let Ok(new_sink) = Sink::try_new(handle) {
                                    if let Ok(source) = Decoder::new(reader) {
                                        new_sink.set_volume(volume);
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
                        let clamped = new_vol.clamp(0.0, 1.0);
                        volume = clamped;
                        if let Some(s) = &sink {
                            s.set_volume(clamped);
                        }
                    }
                    AudioWorkerMsg::SetDevice { device_name, responder } => {
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

                        // Calculate current elapsed position if playing
                        let mut current_pos = accumulated_position.as_secs_f64();
                        if let Some(start) = playback_start {
                            if !is_paused {
                                current_pos += start.elapsed().as_secs_f64();
                            }
                        }
                        let was_playing = sink.as_ref().map(|s| !s.is_paused() && !s.empty()).unwrap_or(false);

                        // Replace stream & handle
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        _stream = Some(new_s);
                        stream_handle = Some(new_h.clone());
                        active_device_name = Some(device_name.clone());

                        // Recreate sink on new device if a track was active
                        if let Some(fp) = current_file.as_ref() {
                            let path = Path::new(fp);
                            if let Ok(file) = File::open(path) {
                                let reader = BufReader::new(file);
                                if let Ok(new_sink) = Sink::try_new(&new_h) {
                                    if let Ok(source) = Decoder::new(reader) {
                                        new_sink.set_volume(volume);
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

                        let is_playing = sink.as_ref().map(|s| !s.is_paused() && !s.empty()).unwrap_or(false);

                        let status = PlaybackStatus {
                            is_playing,
                            is_paused,
                            current_file: current_file.clone(),
                            position_secs: current_pos.min(duration.as_secs_f64()),
                            duration_secs: duration.as_secs_f64(),
                            volume,
                            active_device: active_device_name.clone(),
                            stream_info: current_info.clone(),
                        };

                        let _ = responder.send(status);
                    }
                }
            }
        });

        Self { tx }
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
        }
    }

    pub fn list_output_devices() -> Vec<String> {
        let host = cpal::default_host();
        match host.output_devices() {
            Ok(devices) => devices.filter_map(|d| d.name().ok()).collect(),
            Err(_) => vec!["Default Audio Device".into()],
        }
    }

    fn inspect_audio_file(path: &Path) -> Result<AudioStreamInfo, String> {
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("unknown")
            .to_uppercase();

        let probe = Probe::open(path)
            .map_err(|e| format!("Failed to probe audio file: {}", e))?
            .read()
            .map_err(|e| format!("Failed to read tags: {}", e))?;

        let properties = probe.properties();
        let duration_secs = properties.duration().as_secs_f64();
        let sample_rate = properties.sample_rate();
        let bit_depth = properties.bit_depth();
        let channels = properties.channels();

        let is_high_res = match (sample_rate, bit_depth) {
            (Some(sr), Some(bd)) => sr >= 88200 || bd >= 24,
            (Some(sr), None) => sr >= 88200,
            _ => false,
        };

        let tag = probe.primary_tag().or_else(|| probe.first_tag());
        let title = tag.and_then(|t| t.title().map(|s| s.to_string()));
        let artist = tag.and_then(|t| t.artist().map(|s| s.to_string()));
        let album = tag.and_then(|t| t.album().map(|s| s.to_string()));

        Ok(AudioStreamInfo {
            file_path: path.to_string_lossy().to_string(),
            title,
            artist,
            album,
            duration_secs,
            sample_rate,
            bit_depth,
            channels: channels.map(|c| c as u16),
            format: extension,
            is_high_res,
        })
    }
}
