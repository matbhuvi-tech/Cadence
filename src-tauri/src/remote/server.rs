use std::sync::Arc;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::cors::CorsLayer;

use super::pwa_assets::{MANIFEST_JSON, MOBILE_PWA_HTML};
use super::state::RemoteState;
use super::ws::ws_handler;
use crate::db::DbOperations;

#[derive(Debug, Deserialize)]
pub struct AuthQuery {
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PlaybackActionPayload {
    pub token: Option<String>,
    pub file_path: Option<String>,
    pub position_secs: Option<f64>,
    pub volume: Option<f32>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SetDevicePayload {
    pub token: Option<String>,
    #[serde(rename = "deviceName")]
    pub device_name: String,
}

#[derive(Debug, Deserialize)]
pub struct LibraryQuery {
    pub token: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    #[serde(rename = "releaseId")]
    pub release_id: Option<String>,
}

pub async fn start_remote_server(
    state: Arc<RemoteState>,
    preferred_port: u16,
) -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    // 1. Artwork route protected by ConcurrencyLimitLayer (Capped at 4 requests to avoid network bursts)
    let artwork_router = Router::new()
        .route("/:id", get(get_artwork))
        .layer(ConcurrencyLimitLayer::new(4))
        .with_state(Arc::clone(&state));

    // 2. Main API & PWA Router
    let app = Router::new()
        .route("/", get(serve_pwa))
        .route("/manifest.json", get(serve_manifest))
        .route("/api/remote/status", get(get_status))
        .route("/api/remote/playback/:action", post(handle_playback))
        .route("/api/remote/devices", get(list_devices).post(set_device))
        .route("/api/remote/queue", get(get_queue))
        .route("/api/remote/library/releases", get(get_releases))
        .route("/api/remote/library/tracks", get(get_tracks))
        .route("/api/remote/ws", get(ws_handler))
        .nest("/api/remote/library/artwork", artwork_router)
        .layer(CorsLayer::permissive())
        .with_state(Arc::clone(&state));

    // 3. Port binding with graceful fallback (4040 .. 4050)
    let mut bound_port = preferred_port;
    let mut listener = None;

    for port in preferred_port..=(preferred_port + 10) {
        let addr = format!("0.0.0.0:{}", port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => {
                bound_port = port;
                listener = Some(l);
                break;
            }
            Err(_) => continue,
        }
    }

    let tcp_listener = listener.ok_or_else(|| {
        format!(
            "Failed to bind Cadence Remote server on ports {}..{}",
            preferred_port,
            preferred_port + 10
        )
    })?;

    eprintln!(
        "[Cadence Remote] Embedded Audiophile PWA server listening on http://0.0.0.0:{}",
        bound_port
    );

    tokio::spawn(async move {
        if let Err(e) = axum::serve(tcp_listener, app).await {
            eprintln!("[Cadence Remote] Server error: {}", e);
        }
    });

    Ok(bound_port)
}

fn resolve_token(headers: &HeaderMap, explicit_token: Option<&str>) -> Option<String> {
    if let Some(t) = explicit_token {
        if !t.trim().is_empty() {
            return Some(t.trim().to_string());
        }
    }
    if let Some(auth_val) = headers.get(header::AUTHORIZATION) {
        if let Ok(auth_str) = auth_val.to_str() {
            if let Some(bearer) = auth_str.strip_prefix("Bearer ") {
                return Some(bearer.trim().to_string());
            }
            return Some(auth_str.trim().to_string());
        }
    }
    if let Some(custom) = headers.get("x-cadence-token") {
        if let Ok(c_str) = custom.to_str() {
            return Some(c_str.trim().to_string());
        }
    }
    None
}

async fn serve_pwa() -> Html<&'static str> {
    Html(MOBILE_PWA_HTML)
}

async fn serve_manifest() -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/manifest+json".parse().unwrap(),
    );
    (headers, MANIFEST_JSON)
}

async fn get_status(
    headers: HeaderMap,
    Query(q): Query<AuthQuery>,
    State(state): State<Arc<RemoteState>>,
) -> Result<Json<crate::audio::PlaybackStatus>, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Json(state.engine.get_status()))
}

async fn handle_playback(
    Path(action): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<RemoteState>>,
    Json(payload): Json<PlaybackActionPayload>,
) -> Result<StatusCode, StatusCode> {
    let token = resolve_token(&headers, payload.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    match action.as_str() {
        "play" => {
            if let Some(path) = payload.file_path {
                let _ = state.engine.play_track(&path);
            } else {
                let _ = state.engine.resume();
            }
        }
        "pause" => {
            let _ = state.engine.pause();
        }
        "resume" => {
            let _ = state.engine.resume();
        }
        "stop" => {
            let _ = state.engine.stop();
        }
        "seek" => {
            if let Some(pos) = payload.position_secs {
                let _ = state.engine.seek(pos);
            }
        }
        "volume" => {
            if let Some(vol) = payload.volume {
                let _ = state.engine.set_volume(vol);
            }
        }
        "purity" => {
            if let Some(enabled) = payload.enabled {
                let _ = state.engine.set_purity_mode(enabled);
            }
        }
        _ => return Err(StatusCode::BAD_REQUEST),
    }

    let status = state.engine.get_status();
    state.broadcast_state_change(&status);
    Ok(StatusCode::OK)
}

async fn list_devices(
    headers: HeaderMap,
    Query(q): Query<AuthQuery>,
    State(state): State<Arc<RemoteState>>,
) -> Result<Json<Vec<String>>, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Json(state.engine.list_output_devices()))
}

async fn set_device(
    headers: HeaderMap,
    State(state): State<Arc<RemoteState>>,
    Json(payload): Json<SetDevicePayload>,
) -> Result<StatusCode, StatusCode> {
    let token = resolve_token(&headers, payload.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let _ = state.engine.set_audio_device(&payload.device_name);
    let status = state.engine.get_status();
    state.broadcast_state_change(&status);
    Ok(StatusCode::OK)
}

async fn get_queue(
    headers: HeaderMap,
    Query(q): Query<AuthQuery>,
    State(state): State<Arc<RemoteState>>,
) -> Result<Json<super::state::RemoteQueue>, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let queue = state.queue.lock().clone();
    Ok(Json(queue))
}

async fn get_releases(
    headers: HeaderMap,
    Query(q): Query<LibraryQuery>,
    State(state): State<Arc<RemoteState>>,
) -> Result<Json<Vec<crate::db::DbRelease>>, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let conn = state.db.conn.lock();
    let releases = DbOperations::get_releases(&conn, Some(true)).unwrap_or_default();
    let limit = q.limit.unwrap_or(100);
    let offset = q.offset.unwrap_or(0);
    let sliced = releases.into_iter().skip(offset).take(limit).collect();
    Ok(Json(sliced))
}

async fn get_tracks(
    headers: HeaderMap,
    Query(q): Query<LibraryQuery>,
    State(state): State<Arc<RemoteState>>,
) -> Result<Json<Vec<crate::db::DbTrack>>, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let conn = state.db.conn.lock();
    let tracks = if let Some(ref rel_id) = q.release_id {
        let mut stmt = conn
            .prepare("SELECT id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, release_year, track_number, genre, composer, duration_secs, format, sample_rate, bit_depth, channels, dr_score, has_embedded_art, sidecar_status, sidecar_edits_json, is_online, work_title, movement_number, movement_title, is_compilation, album_artist, original_album, original_year, acoustid_fingerprint, musicbrainz_recording_id, created_at FROM tracks WHERE release_id = ?1 ORDER BY track_number ASC")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let rows = stmt
            .query_map(rusqlite::params![rel_id], |row| {
                Ok(crate::db::DbTrack {
                    id: row.get(0)?,
                    release_id: row.get(1)?,
                    mount_id: row.get(2)?,
                    folder_path: row.get(3)?,
                    folder_name: row.get(4)?,
                    file_path: row.get(5)?,
                    file_name: row.get(6)?,
                    file_size: row.get(7)?,
                    mtime: row.get(8)?,
                    title: row.get(9)?,
                    artist_credit: row.get(10)?,
                    album_title: row.get(11)?,
                    release_year: row.get(12)?,
                    track_number: row.get(13)?,
                    genre: row.get(14)?,
                    composer: row.get(15)?,
                    duration_secs: row.get(16)?,
                    format: row.get(17)?,
                    sample_rate: row.get(18)?,
                    bit_depth: row.get(19)?,
                    channels: row.get(20)?,
                    dr_score: row.get(21)?,
                    has_embedded_art: row.get::<_, i32>(22)? == 1,
                    sidecar_status: row.get(23)?,
                    sidecar_edits_json: row.get(24)?,
                    is_online: row.get::<_, i32>(25)? == 1,
                    work_title: row.get(26)?,
                    movement_number: row.get(27)?,
                    movement_title: row.get(28)?,
                    is_compilation: row.get::<_, i32>(29).unwrap_or(0) == 1,
                    album_artist: row.get(30)?,
                    original_album: row.get(31)?,
                    original_year: row.get(32)?,
                    acoustid_fingerprint: row.get(33)?,
                    musicbrainz_recording_id: row.get(34)?,
                    created_at: row.get(35)?,
                })
            })
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        rows.filter_map(|r| r.ok()).collect()
    } else {
        DbOperations::get_tracks(&conn, q.limit.map(|l| l as i64), q.offset.map(|o| o as i64), Some(true))
            .unwrap_or_default()
    };

    Ok(Json(tracks))
}

async fn get_artwork(
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<AuthQuery>,
    State(state): State<Arc<RemoteState>>,
) -> Result<Response, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // 1. Direct hit in thumbnail NVMe cache (zero disk reads on music drive)
    if let Some((bytes, mime)) = state.artwork_cache.get_cached_only(&id) {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, mime.parse().unwrap());
        headers.insert(
            header::CACHE_CONTROL,
            "public, max-age=604800, immutable".parse().unwrap(),
        );
        return Ok((headers, bytes).into_response());
    }

    // 2. Release-level Deduplication: Check if this id belongs to a parent release whose art is already cached
    let (release_id, source_path): (Option<String>, Option<String>) = {
        let conn = state.db.conn.lock();
        let stmt = conn
            .prepare("SELECT release_id, file_path FROM tracks WHERE id = ?1 OR file_path = ?1 LIMIT 1")
            .ok();
        stmt.and_then(|mut s| {
            s.query_row(rusqlite::params![&id], |row| Ok((row.get(0)?, row.get(1)?))).ok()
        }).unwrap_or((None, None))
    };

    if let Some(ref rel_id) = release_id {
        if let Some((bytes, mime)) = state.artwork_cache.get_cached_only(rel_id) {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, mime.parse().unwrap());
            headers.insert(
                header::CACHE_CONTROL,
                "public, max-age=604800, immutable".parse().unwrap(),
            );
            return Ok((headers, bytes).into_response());
        }
    }

    // 3. Fallback: Generate thumbnail if audio engine is idle
    let target_key = release_id.as_deref().unwrap_or(&id);
    let resolved_source = source_path.or_else(|| {
        let conn = state.db.conn.lock();
        let stmt = conn
            .prepare("SELECT file_path FROM tracks WHERE id = ?1 OR release_id = ?1 LIMIT 1")
            .ok();
        stmt.and_then(|mut s| {
            s.query_row(rusqlite::params![&id], |row| row.get(0)).ok()
        })
    });

    if let Some((bytes, mime)) = state
        .artwork_cache
        .get_or_create_thumbnail(target_key, resolved_source.as_deref())
    {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, mime.parse().unwrap());
        headers.insert(
            header::CACHE_CONTROL,
            "public, max-age=604800, immutable".parse().unwrap(),
        );
        Ok((headers, bytes).into_response())
    } else {
        // Return 204 No Content so client falls back to default placeholder with 0 network penalty
        Ok(StatusCode::NO_CONTENT.into_response())
    }
}
