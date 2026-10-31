use std::net::IpAddr;
use std::path::Path as FsPath;
use std::sync::Arc;
use std::collections::HashMap;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::cors::CorsLayer;

use super::pwa_assets::PwaAssets;
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRelease {
    #[serde(flatten)]
    release: crate::db::DbRelease,
    has_dsd: bool,
    has_high_res: bool,
    has_flac: bool,
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
        .fallback(serve_embedded_pwa)






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

    let (cert_path, key_path) = ensure_tls_certificate(&state.token_file)?;

    // Playback status checks stay local to the host. A track boundary produces
    // one event-driven broadcast; this does not increase WebSocket traffic.
    tokio::spawn(super::ws::monitor_queue_completion(Arc::clone(&state)));

    eprintln!(
        "[Cadence Remote] Embedded Audiophile PWA server listening on https://0.0.0.0:{}",
        bound_port
    );

    tokio::spawn(async move {
        if let Err(e) = axum_server::from_tcp_rustls(
            tcp_listener.into_std().expect("Tokio listener conversion failed"),
            axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
                .await
                .expect("Cadence Remote TLS certificate could not be loaded"),
        )
        .serve(app.into_make_service())
        .await
        {
            eprintln!("[Cadence Remote] Server error: {}", e);
        }
    });

    Ok(bound_port)
}

fn ensure_tls_certificate(
    token_path: &FsPath,
) -> Result<(std::path::PathBuf, std::path::PathBuf), Box<dyn std::error::Error + Send + Sync>> {
    let cert_path = token_path.with_file_name("remote_tls_cert.pem");
    let key_path = token_path.with_file_name("remote_tls_key.pem");
    if cert_path.is_file() && key_path.is_file() {
        return Ok((cert_path, key_path));
    }

    let discovery = super::net_discovery::discover_lan_interfaces(0, "");
    let mut params = rcgen::CertificateParams::new(
        discovery
            .interfaces
            .iter()
            .map(|iface| iface.ip.clone())
            .chain(std::iter::once(discovery.m_dns_host))
            .collect::<Vec<_>>(),
    )?;
    params.subject_alt_names.extend(
        discovery
            .interfaces
            .iter()
            .filter_map(|iface| iface.ip.parse::<IpAddr>().ok())
            .map(rcgen::SanType::IpAddress),
    );
    let key_pair = rcgen::KeyPair::generate()?;
    let certificate = params.self_signed(&key_pair)?;
    std::fs::write(&cert_path, certificate.pem())?;
    std::fs::write(&key_path, key_pair.serialize_pem())?;
    Ok((cert_path, key_path))
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

async fn serve_embedded_pwa(uri: Uri) -> impl IntoResponse {
    let raw_path = uri.path().trim_start_matches('/');
    let path = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    if let Some(file) = PwaAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache, must-revalidate"
        };
        (
            [
                (header::CONTENT_TYPE, mime.as_ref()),
                (header::CACHE_CONTROL, cache),
            ],
            file.data,
        )
            .into_response()
    } else if !path.starts_with("api/") && !path.starts_with("assets/") {
        if let Some(index) = PwaAssets::get("index.html") {
            (
                [
                    (header::CONTENT_TYPE, "text/html"),
                    (header::CACHE_CONTROL, "no-cache, must-revalidate"),
                ],
                index.data,
            )
                .into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        }
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
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
    state
        .engine
        .set_audio_device(&payload.device_name)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
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
) -> Result<Json<Vec<RemoteRelease>>, StatusCode> {
    let token = resolve_token(&headers, q.token.as_deref());
    if !state.validate_token(token.as_deref()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let conn = state.db.conn.lock();
    let releases = DbOperations::get_releases(&conn, Some(true))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = conn
        .prepare(
            "SELECT release_id,
                    MAX(CASE WHEN upper(format) IN ('DSF', 'DFF', 'DSDIFF') THEN 1 ELSE 0 END),
                    MAX(CASE WHEN COALESCE(sample_rate, 0) > 48000 OR COALESCE(bit_depth, 0) > 16 THEN 1 ELSE 0 END),
                    MAX(CASE WHEN upper(format) = 'FLAC' THEN 1 ELSE 0 END)
             FROM tracks WHERE is_online = 1 GROUP BY release_id",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let facet_rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i32>(1)? != 0,
                row.get::<_, i32>(2)? != 0,
                row.get::<_, i32>(3)? != 0,
            ))
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut facets = HashMap::new();
    for row in facet_rows {
        let (release_id, has_dsd, has_high_res, has_flac) =
            row.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        facets.insert(release_id, (has_dsd, has_high_res, has_flac));
    }
    let limit = q.limit.unwrap_or(100);
    let offset = q.offset.unwrap_or(0);
    let sliced = releases
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|release| {
            let (has_dsd, has_high_res, has_flac) =
                facets.get(&release.id).copied().unwrap_or_default();
            RemoteRelease {
                release,
                has_dsd,
                has_high_res,
                has_flac,
            }
        })
        .collect();
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
