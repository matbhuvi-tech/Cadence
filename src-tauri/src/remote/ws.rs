use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::time::interval;

use super::state::{RemoteEvent, RemoteState};

static CONNECTED_CLIENTS: AtomicUsize = AtomicUsize::new(0);

pub fn get_connected_client_count() -> usize {
    CONNECTED_CLIENTS.load(Ordering::Relaxed)
}

pub async fn monitor_queue_completion(state: Arc<RemoteState>) {
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    let mut advanced_file: Option<String> = None;

    loop {
        timer.tick().await;
        let engine = Arc::clone(&state);
        let status = match tokio::task::spawn_blocking(move || engine.engine.get_status()).await {
            Ok(status) => status,
            Err(_) => continue,
        };

        let Some(current_file) = status.current_file.as_ref() else {
            advanced_file = None;
            continue;
        };
        if advanced_file.as_deref() != Some(current_file.as_str()) {
            advanced_file = None;
        } else if status.position_secs < status.duration_secs - 0.75 {
            // A duplicate queue entry can have the same path; re-arm after the
            // new instance has started from its beginning.
            advanced_file = None;
        }

        let near_end = status.duration_secs > 1.0
            && status.position_secs >= status.duration_secs - 0.25;
        let renderer_reports_progress = matches!(
            status.active_backend_endpoint,
            Some(crate::audio::AudioEndpoint::Upnp { .. })
        );
        let track_finished = near_end
            && !status.is_paused
            && (renderer_reports_progress || (!status.is_playing && !status.is_paused));
        if !track_finished || advanced_file.as_deref() == Some(current_file.as_str()) {
            continue;
        }

        let is_current_queue_item = {
            let queue = state.queue.lock();
            queue.current_index >= 0
                && queue
                    .items
                    .get(queue.current_index as usize)
                    .map(|item| item.file_path == *current_file)
                    .unwrap_or(false)
        };
        if is_current_queue_item {
            advanced_file = Some(current_file.clone());
            advance_queue(&state, 1).await;
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ClientCommand {
    PlayTrack { file_path: String },
    Pause,
    Resume,
    Stop,
    Seek { position_secs: f64 },
    SetVolume { volume: f32 },
    TogglePurity { enabled: bool },
    NextTrack,
    PrevTrack,
    JumpToQueueIndex { index: usize },
    PlayRelease { release_id: String },
    PlayTrackInRelease { release_id: String, track_id: String },
    QueueTrack {
        file_path: String,
        #[serde(default)]
        play_next: Option<bool>,
        #[serde(default)]
        expected_revision: Option<u64>,
    },
    QueueRelease {
        release_id: String,
        #[serde(default)]
        play_next: Option<bool>,
        #[serde(default)]
        play_now: Option<bool>,
        #[serde(default)]
        expected_revision: Option<u64>,
    },
    RemoveFromQueue {
        #[serde(default)]
        index: Option<usize>,
        #[serde(default)]
        track_id: Option<String>,
        #[serde(default)]
        queue_entry_id: Option<String>,
        #[serde(default)]
        expected_revision: Option<u64>,
    },
    ReorderQueue {
        queue_entry_id: String,
        target_queue_entry_id: String,
        #[serde(default)]
        expected_revision: Option<u64>,
    },
    ClearQueue {
        #[serde(default)]
        expected_revision: Option<u64>,
    },
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    Query(query): Query<WsAuthQuery>,
    State(state): State<Arc<RemoteState>>,
) -> impl IntoResponse {
    let token = query.token.as_deref().or_else(|| {
        headers
            .get("x-cadence-token")
            .and_then(|h| h.to_str().ok())
            .or_else(|| {
                headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|h| h.to_str().ok())
                    .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).trim())
            })
    });

    // Validate token
    if !state.validate_token(token) {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<RemoteState>) {
    CONNECTED_CLIENTS.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();

    // 1. Send initial state and queue to newly connected client
    let initial_status = state.engine.get_status();
    let initial_event = RemoteEvent::StateChange {
        is_playing: initial_status.is_playing,
        is_paused: initial_status.is_paused,
        current_file: initial_status.current_file.clone(),
        position_secs: initial_status.position_secs,
        duration_secs: initial_status.duration_secs,
        timestamp_ms: RemoteState::current_timestamp_ms(),
        volume: initial_status.volume,
        is_purity_mode: initial_status.purity_mode,
        is_bit_perfect: initial_status.is_bit_perfect,
        active_device: initial_status.active_device.clone(),
        stream_info: initial_status.stream_info.clone(),
    };

    if let Ok(json) = serde_json::to_string(&initial_event) {
        let _ = sender.send(Message::Text(json)).await;
    }

    let (queue_items, queue_idx, queue_rev, current_entry_id) = {
        let q = state.queue.lock();
        (
            q.items.clone(),
            q.current_index,
            q.revision,
            q.current_queue_entry_id.clone(),
        )
    };
    let initial_queue_event = RemoteEvent::QueueUpdated {
        items: queue_items,
        current_index: queue_idx,
        revision: queue_rev,
        current_queue_entry_id: current_entry_id,
    };
    if let Ok(json) = serde_json::to_string(&initial_queue_event) {
        let _ = sender.send(Message::Text(json)).await;
    }

    let mut event_rx = state.event_tx.subscribe();
    let state_for_heartbeat = Arc::clone(&state);

    // 2. Outgoing Task: Event-Driven broadcasts + Slow 5s Heartbeat
    let mut send_task = tokio::spawn(async move {
        let mut heartbeat_timer = interval(Duration::from_secs(5));

        loop {
            tokio::select! {
                // Event-driven broadcast received (Play/Pause/TrackChange/etc.)
                Ok(event) = event_rx.recv() => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        if sender.send(Message::Text(json)).await.is_err() {
                            break;
                        }
                    }
                }
                // Slow 5-second Heartbeat Sync (Only sent if playing to eliminate Wi-Fi traffic)
                _ = heartbeat_timer.tick() => {
                    let status = state_for_heartbeat.engine.get_status();
                    if status.is_playing && !status.is_paused {
                        let heartbeat = RemoteEvent::Heartbeat {
                            position_secs: status.position_secs,
                            duration_secs: status.duration_secs,
                            timestamp_ms: RemoteState::current_timestamp_ms(),
                            is_playing: true,
                            rate: 1.0,
                        };
                        if let Ok(json) = serde_json::to_string(&heartbeat) {
                            if sender.send(Message::Text(json)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });

    // 3. Incoming Task: Process client commands from mobile
    let state_for_recv = Arc::clone(&state);
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(cmd) = serde_json::from_str::<ClientCommand>(&text) {
                    handle_client_command(cmd, &state_for_recv).await;
                }
            }
        }
    });

    // Wait until either sender or receiver closes
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    }

    CONNECTED_CLIENTS.fetch_sub(1, Ordering::Relaxed);
}

async fn handle_client_command(cmd: ClientCommand, state: &RemoteState) {
    match cmd {
        ClientCommand::PlayTrack { file_path } => {
            let found_idx = {
                let mut q = state.queue.lock();
                let norm_target = file_path.replace('\\', "/").to_lowercase();
                if let Some(pos) = q.items.iter().position(|t| {
                    t.file_path.replace('\\', "/").to_lowercase() == norm_target || t.id == file_path
                }) {
                    if pos > 0 {
                        q.items = q.items.split_off(pos);
                    }
                    q.current_index = 0;
                    q.current_queue_entry_id = q.items.first().map(|t| t.queue_entry_id.clone());
                    q.revision += 1;
                    Some(0)
                } else {
                    None
                }
            };

            if found_idx.is_some() {
                let _ = state.engine.play_track(&file_path);
                let status = state.engine.get_status();
                state.broadcast_state_change(&status);
                state.broadcast_queue_update();
            } else {
                let alt_path = if file_path.contains('/') {
                    file_path.replace('/', "\\")
                } else {
                    file_path.replace('\\', "/")
                };
                let release_match: Option<(String, String)> = {
                    let conn = state.db.conn.lock();
                    let stmt = conn.prepare(
                        "SELECT release_id, id FROM tracks WHERE file_path = ?1 OR file_path = ?2 OR id = ?1 LIMIT 1"
                    ).ok();
                    stmt.and_then(|mut s| {
                        s.query_row([&file_path, &alt_path], |row| {
                            let r_id: Option<String> = row.get(0)?;
                            let t_id: String = row.get(1)?;
                            Ok((r_id, t_id))
                        }).ok()
                    }).and_then(|(r_id, t_id)| r_id.map(|r| (r, t_id)))
                };

                if let Some((rel_id, trk_id)) = release_match {
                    play_release_track(state, &rel_id, &trk_id).await;
                } else {
                    let _ = state.engine.play_track(&file_path);
                    let status = state.engine.get_status();
                    state.broadcast_state_change(&status);
                }
            }
        }
        ClientCommand::Pause => {
            let _ = state.engine.pause();
            let status = state.engine.get_status();
            state.broadcast_state_change(&status);
        }
        ClientCommand::Resume => {
            let _ = state.engine.resume();
            let status = state.engine.get_status();
            state.broadcast_state_change(&status);
        }
        ClientCommand::Stop => {
            let _ = state.engine.stop();
            let status = state.engine.get_status();
            state.broadcast_state_change(&status);
        }
        ClientCommand::Seek { position_secs } => {
            let _ = state.engine.seek(position_secs);
            let status = state.engine.get_status();
            state.broadcast_state_change(&status);
        }
        ClientCommand::SetVolume { volume } => {
            let _ = state.engine.set_volume(volume);
            let status = state.engine.get_status();
            state.broadcast_state_change(&status);
        }
        ClientCommand::TogglePurity { enabled } => {
            let _ = state.engine.set_purity_mode(enabled);
            let status = state.engine.get_status();
            state.broadcast_state_change(&status);
        }
        ClientCommand::NextTrack => {
            advance_queue(state, 1).await;
        }
        ClientCommand::PrevTrack => {
            advance_queue(state, -1).await;
        }
        ClientCommand::JumpToQueueIndex { index } => {
            jump_queue(state, index).await;
        }
        ClientCommand::PlayRelease { release_id } => {
            play_release(state, &release_id).await;
        }
        ClientCommand::PlayTrackInRelease { release_id, track_id } => {
            play_release_track(state, &release_id, &track_id).await;
        }
        ClientCommand::QueueTrack { file_path, play_next, expected_revision } => {
            queue_track(state, &file_path, play_next.unwrap_or(false), expected_revision).await;
        }
        ClientCommand::QueueRelease { release_id, play_next, play_now, expected_revision } => {
            queue_release(
                state,
                &release_id,
                play_next.unwrap_or(false),
                play_now.unwrap_or(false),
                expected_revision,
            )
            .await;
        }
        ClientCommand::RemoveFromQueue { index, track_id, queue_entry_id, expected_revision } => {
            remove_from_queue(state, index, track_id, queue_entry_id, expected_revision).await;
        }
        ClientCommand::ReorderQueue { queue_entry_id, target_queue_entry_id, expected_revision } => {
            reorder_queue(state, &queue_entry_id, &target_queue_entry_id, expected_revision).await;
        }
        ClientCommand::ClearQueue { expected_revision } => {
            clear_queue(state, expected_revision).await;
        }
    }
}

fn check_revision(state: &RemoteState, expected_revision: Option<u64>) -> Result<(), RemoteEvent> {
    if let Some(exp) = expected_revision {
        let q = state.queue.lock();
        if exp != q.revision {
            return Err(RemoteEvent::QueueConflict {
                current_revision: q.revision,
                items: q.items.clone(),
                current_index: q.current_index,
            });
        }
    }
    Ok(())
}

async fn advance_queue(state: &RemoteState, delta: isize) {
    let next_file: Option<String> = {
        let mut q = state.queue.lock();
        if q.items.is_empty() {
            None
        } else if delta > 0 {
            if q.items.len() > 1 {
                if q.repeat_mode == "all" {
                    let finished = q.items.remove(0);
                    q.items.push(finished);
                } else {
                    q.items.remove(0);
                }
                q.current_index = 0;
                q.current_queue_entry_id = q.items.first().map(|t| t.queue_entry_id.clone());
                q.revision += 1;
                q.items.first().map(|t| t.file_path.clone())
            } else if q.repeat_mode == "all" {
                q.current_index = 0;
                q.current_queue_entry_id = q.items.first().map(|t| t.queue_entry_id.clone());
                q.revision += 1;
                q.items.first().map(|t| t.file_path.clone())
            } else {
                q.items.clear();
                q.current_index = -1;
                q.current_queue_entry_id = None;
                q.revision += 1;
                None
            }
        } else {
            // Restart or seek to beginning of active track
            q.current_index = 0;
            q.items.first().map(|t| t.file_path.clone())
        }
    };

    if let Some(path) = next_file {
        let _ = state.engine.play_track(&path);
        let status = state.engine.get_status();
        state.broadcast_state_change(&status);
        state.broadcast_queue_update();
    } else {
        let _ = state.engine.stop();
        let status = state.engine.get_status();
        state.broadcast_state_change(&status);
        state.broadcast_queue_update();
    }
}

async fn jump_queue(state: &RemoteState, index: usize) {
    let target_file: Option<String> = {
        let mut q = state.queue.lock();
        if index < q.items.len() {
            if index > 0 {
                q.items = q.items.split_off(index);
            }
            q.current_index = 0;
            q.current_queue_entry_id = q.items.first().map(|t| t.queue_entry_id.clone());
            q.revision += 1;
            q.items.first().map(|t| t.file_path.clone())
        } else {
            None
        }
    };

    if let Some(path) = target_file {
        let _ = state.engine.play_track(&path);
        let status = state.engine.get_status();
        state.broadcast_state_change(&status);
        state.broadcast_queue_update();
    }
}

fn query_release_tracks(state: &RemoteState, release_id: &str) -> Vec<crate::remote::state::RemoteTrackItem> {
    let conn = state.db.conn.lock();
    let query = (|| -> rusqlite::Result<Vec<crate::remote::state::RemoteTrackItem>> {
        let mut stmt = conn.prepare(
            "SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                    file_size, mtime, title, artist_credit, album_title, release_year, track_number,
                    genre, composer, duration_secs, format, sample_rate, bit_depth, channels,
                    dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online,
                    work_title, movement_number, movement_title, created_at
             FROM tracks WHERE release_id = ?1 AND is_online = 1
             ORDER BY track_number ASC",
        )?;
        let rows = stmt.query_map([release_id], |row| {
            let sr: Option<u32> = row.get(18)?;
            let bd: Option<u8> = row.get(19)?;
            let is_high_res = sr.unwrap_or(0) > 48000 || bd.unwrap_or(0) > 16;
            Ok(crate::remote::state::RemoteTrackItem {
                queue_entry_id: uuid::Uuid::new_v4().to_string(),
                id: row.get(0)?,
                title: row.get(9)?,
                artist: row.get(10)?,
                album: row.get(11)?,
                file_path: row.get(5)?,
                duration_secs: row.get(16)?,
                format: row.get(17)?,
                sample_rate: sr,
                bit_depth: bd,
                is_high_res,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            if let Ok(t) = r {
                list.push(t);
            }
        }
        Ok(list)
    })();
    query.unwrap_or_default()
}

async fn play_release(state: &RemoteState, release_id: &str) {
    queue_release(state, release_id, false, true, None).await;
}

async fn play_release_track(state: &RemoteState, release_id: &str, track_id: &str) {
    let tracks = query_release_tracks(state, release_id);
    if !tracks.is_empty() {
        let target_idx = tracks.iter().position(|t| t.id == track_id).unwrap_or(0);
        let target_path = tracks[target_idx].file_path.clone();
        {
            let mut q = state.queue.lock();
            let split_at = (q.current_index as usize) + 1;
            let remaining_upcoming = if q.current_index >= 0 && split_at < q.items.len() {
                q.items.split_off(split_at)
            } else {
                Vec::new()
            };
            // Prune tracks preceding target_idx so past tracks are excluded from queue
            let mut new_items: Vec<crate::remote::state::RemoteTrackItem> =
                tracks.into_iter().skip(target_idx).collect();
            new_items.extend(remaining_upcoming);
            q.items = new_items;
            q.current_index = 0;
            q.current_queue_entry_id = q.items.first().map(|t| t.queue_entry_id.clone());
            q.next_up_end_index = None;
            q.revision += 1;
        }
        let _ = state.engine.play_track(&target_path);
        let status = state.engine.get_status();
        state.broadcast_state_change(&status);
        state.broadcast_queue_update();
    }
}

async fn queue_track(
    state: &RemoteState,
    file_path: &str,
    play_next: bool,
    expected_revision: Option<u64>,
) {
    if let Err(conflict) = check_revision(state, expected_revision) {
        let _ = state.event_tx.send(conflict);
        return;
    }

    let item: Option<crate::remote::state::RemoteTrackItem> = {
        let conn = state.db.conn.lock();
        let query = (|| -> rusqlite::Result<Option<crate::remote::state::RemoteTrackItem>> {
            let mut stmt = conn.prepare(
                "SELECT id, title, artist_credit, album_title, file_path, duration_secs, format, sample_rate, bit_depth
                 FROM tracks WHERE file_path = ?1 OR id = ?1 LIMIT 1",
            )?;
            let mut rows = stmt.query_map([file_path], |row| {
                let sr: Option<u32> = row.get(7)?;
                let bd: Option<u8> = row.get(8)?;
                let is_high_res = sr.unwrap_or(0) > 48000 || bd.unwrap_or(0) > 16;
                Ok(crate::remote::state::RemoteTrackItem {
                    queue_entry_id: uuid::Uuid::new_v4().to_string(),
                    id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    album: row.get(3)?,
                    file_path: row.get(4)?,
                    duration_secs: row.get(5)?,
                    format: row.get(6)?,
                    sample_rate: sr,
                    bit_depth: bd,
                    is_high_res,
                })
            })?;
            if let Some(r) = rows.next() {
                Ok(r.ok())
            } else {
                Ok(None)
            }
        })();
        query.unwrap_or(None)
    };

    if let Some(track) = item {
        {
            let mut q = state.queue.lock();
            if play_next && !q.items.is_empty() && q.current_index >= 0 {
                let insert_idx = q
                    .next_up_end_index
                    .unwrap_or(((q.current_index as usize) + 1).min(q.items.len()));
                q.items.insert(insert_idx, track);
                q.next_up_end_index = Some(insert_idx + 1);
            } else {
                q.items.push(track);
            }
            q.revision += 1;
        }
        state.broadcast_queue_update();
    }
}

async fn queue_release(
    state: &RemoteState,
    release_id: &str,
    play_next: bool,
    play_now: bool,
    expected_revision: Option<u64>,
) {
    if let Err(conflict) = check_revision(state, expected_revision) {
        let _ = state.event_tx.send(conflict);
        return;
    }

    let tracks = query_release_tracks(state, release_id);
    if tracks.is_empty() {
        return;
    }

    if play_now {
        let first_path = tracks[0].file_path.clone();
        {
            let mut q = state.queue.lock();
            let split_at = (q.current_index as usize) + 1;
            let remaining_upcoming = if q.current_index >= 0 && split_at < q.items.len() {
                q.items.split_off(split_at)
            } else {
                Vec::new()
            };
            let mut new_items = tracks;
            new_items.extend(remaining_upcoming);
            q.items = new_items;
            q.current_index = 0;
            q.current_queue_entry_id = q.items.first().map(|t| t.queue_entry_id.clone());
            q.next_up_end_index = None;
            q.revision += 1;
        }
        let _ = state.engine.play_track(&first_path);
        let status = state.engine.get_status();
        state.broadcast_state_change(&status);
        state.broadcast_queue_update();
    } else {
        {
            let mut q = state.queue.lock();
            let count = tracks.len();
            if play_next && !q.items.is_empty() && q.current_index >= 0 {
                let insert_idx = q
                    .next_up_end_index
                    .unwrap_or(((q.current_index as usize) + 1).min(q.items.len()));
                for (offset, t) in tracks.into_iter().enumerate() {
                    q.items.insert(insert_idx + offset, t);
                }
                q.next_up_end_index = Some(insert_idx + count);
            } else {
                q.items.extend(tracks);
            }
            q.revision += 1;
        }
        state.broadcast_queue_update();
    }
}

async fn remove_from_queue(
    state: &RemoteState,
    index: Option<usize>,
    track_id: Option<String>,
    queue_entry_id: Option<String>,
    expected_revision: Option<u64>,
) {
    if let Err(conflict) = check_revision(state, expected_revision) {
        let _ = state.event_tx.send(conflict);
        return;
    }

    let removed = {
        let mut q = state.queue.lock();
        let target_idx = if let Some(ref qid) = queue_entry_id {
            q.items.iter().position(|t| &t.queue_entry_id == qid)
        } else if let Some(idx) = index {
            if idx < q.items.len() && (track_id.is_none() || Some(&q.items[idx].id) == track_id.as_ref()) {
                Some(idx)
            } else if let Some(ref tid) = track_id {
                q.items.iter().position(|t| &t.id == tid)
            } else {
                None
            }
        } else if let Some(ref tid) = track_id {
            q.items.iter().position(|t| &t.id == tid)
        } else {
            None
        };

        if let Some(idx) = target_idx {
            q.items.remove(idx);
            let cur = q.current_index;
            q.revision += 1;
            if (idx as isize) < cur {
                q.current_index = cur - 1;
                q.current_queue_entry_id = q.items.get(q.current_index as usize).map(|t| t.queue_entry_id.clone());
                None
            } else if (idx as isize) == cur {
                if idx < q.items.len() {
                    q.current_queue_entry_id = Some(q.items[idx].queue_entry_id.clone());
                    Some(q.items[idx].file_path.clone())
                } else {
                    q.current_index = -1;
                    q.current_queue_entry_id = None;
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(next_file) = removed {
        let _ = state.engine.play_track(&next_file);
        let status = state.engine.get_status();
        state.broadcast_state_change(&status);
    }
    state.broadcast_queue_update();
}

async fn reorder_queue(
    state: &RemoteState,
    queue_entry_id: &str,
    target_queue_entry_id: &str,
    expected_revision: Option<u64>,
) {
    if let Err(conflict) = check_revision(state, expected_revision) {
        let _ = state.event_tx.send(conflict);
        return;
    }
    {
        let mut q = state.queue.lock();
        let src_idx = q.items.iter().position(|t| t.queue_entry_id == queue_entry_id);
        let tgt_idx = q.items.iter().position(|t| t.queue_entry_id == target_queue_entry_id);
        if let (Some(src), Some(tgt)) = (src_idx, tgt_idx) {
            let item = q.items.remove(src);
            q.items.insert(tgt, item);
            if let Some(ref cur_id) = q.current_queue_entry_id {
                if let Some(new_cur) = q.items.iter().position(|t| &t.queue_entry_id == cur_id) {
                    q.current_index = new_cur as isize;
                }
            }
            q.revision += 1;
        }
    }
    state.broadcast_queue_update();
}

async fn clear_queue(state: &RemoteState, expected_revision: Option<u64>) {
    if let Err(conflict) = check_revision(state, expected_revision) {
        let _ = state.event_tx.send(conflict);
        return;
    }
    {
        let mut q = state.queue.lock();
        if q.current_index >= 0 && (q.current_index as usize) < q.items.len() {
            let active = q.items[q.current_index as usize].clone();
            q.items = vec![active];
            q.current_index = 0;
            q.current_queue_entry_id = Some(q.items[0].queue_entry_id.clone());
        } else {
            q.items.clear();
            q.current_index = -1;
            q.current_queue_entry_id = None;
        }
        q.next_up_end_index = None;
        q.revision += 1;
    }
    state.broadcast_queue_update();
}
