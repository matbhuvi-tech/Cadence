use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

use crate::audio::{AudioEngine, AudioStreamInfo, PlaybackStatus};
use crate::db::AppDb;
use super::artwork_cache::ArtworkCache;
use super::net_discovery::{
    generate_pairing_token, load_or_create_pairing_token, save_pairing_token,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrackItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_path: String,
    pub duration_secs: f64,
    pub format: String,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub is_high_res: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteQueue {
    pub items: Vec<RemoteTrackItem>,
    pub current_index: isize,
    pub repeat_mode: String, // "off" | "all" | "one"
    pub is_shuffle: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteEvent {
    StateChange {
        is_playing: bool,
        is_paused: bool,
        current_file: Option<String>,
        position_secs: f64,
        duration_secs: f64,
        timestamp_ms: u64,
        volume: f32,
        is_purity_mode: bool,
        is_bit_perfect: bool,
        active_device: Option<String>,
        stream_info: Option<AudioStreamInfo>,
    },
    Heartbeat {
        position_secs: f64,
        duration_secs: f64,
        timestamp_ms: u64,
        is_playing: bool,
        rate: f32,
    },
    QueueUpdated {
        items: Vec<RemoteTrackItem>,
        current_index: isize,
    },
}

#[derive(Clone)]
pub struct RemoteState {
    pub engine: AudioEngine,
    pub db: AppDb,
    pub artwork_cache: ArtworkCache,
    pub token: Arc<Mutex<String>>,
    pub token_file: PathBuf,
    pub queue: Arc<Mutex<RemoteQueue>>,
    pub event_tx: broadcast::Sender<RemoteEvent>,
    pub app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl RemoteState {
    pub fn new(engine: AudioEngine, db: AppDb, cache_dir: PathBuf, token_file: PathBuf) -> Self {
        let (event_tx, _) = broadcast::channel(128);
        let eng_clone = engine.clone();
        let artwork_cache = ArtworkCache::new(cache_dir, move || {
            let status = eng_clone.get_status();
            status.is_playing && !status.is_paused
        });

        let initial_token = load_or_create_pairing_token(&token_file);

        Self {
            engine,
            db,
            artwork_cache,
            token: Arc::new(Mutex::new(initial_token)),
            token_file,
            queue: Arc::new(Mutex::new(RemoteQueue::default())),
            event_tx,
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub fn reset_token(&self) -> String {
        let new_token = generate_pairing_token();
        *self.token.lock() = new_token.clone();
        save_pairing_token(&self.token_file, &new_token);
        new_token
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock() = Some(handle);
    }

    pub fn validate_token(&self, token_input: Option<&str>) -> bool {
        let active = self.token.lock();
        if active.is_empty() {
            return true;
        }
        match token_input {
            Some(t) => t == active.as_str(),
            None => false,
        }
    }

    pub fn current_timestamp_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Dispatches a state change to both mobile WebSocket clients and desktop Tauri window
    pub fn broadcast_state_change(&self, status: &PlaybackStatus) {
        let event = RemoteEvent::StateChange {
            is_playing: status.is_playing,
            is_paused: status.is_paused,
            current_file: status.current_file.clone(),
            position_secs: status.position_secs,
            duration_secs: status.duration_secs,
            timestamp_ms: Self::current_timestamp_ms(),
            volume: status.volume,
            is_purity_mode: status.purity_mode,
            is_bit_perfect: status.is_bit_perfect,
            active_device: status.active_device.clone(),
            stream_info: status.stream_info.clone(),
        };

        // 1. Send to all mobile WebSockets
        let _ = self.event_tx.send(event.clone());

        // 2. Send to Desktop Tauri window for 100% bi-directional sync
        if let Some(ref handle) = *self.app_handle.lock() {
            let _ = handle.emit("cadence:remote-state-changed", &event);
        }
    }

    /// Dispatches queue updates to mobile and desktop
    pub fn broadcast_queue_update(&self) {
        let (items, current_index) = {
            let q = self.queue.lock();
            (q.items.clone(), q.current_index)
        };

        let event = RemoteEvent::QueueUpdated {
            items,
            current_index,
        };

        let _ = self.event_tx.send(event.clone());
        if let Some(ref handle) = *self.app_handle.lock() {
            let _ = handle.emit("cadence:remote-queue-changed", &event);
        }
    }
}
