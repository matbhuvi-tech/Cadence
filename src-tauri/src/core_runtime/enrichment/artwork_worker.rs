use super::image_store::{DecodedImageMeta, ImageStore, MAX_IMAGE_BYTES};
use super::matcher::{LocalAlbum, LocalTrack};
use super::providers::{ExternalArtworkProvider, ProviderError};
use super::schema::{epoch_secs, mark_curate_queue_projection_stale};
use crate::scanner::media;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tokio::sync::Notify;

pub const GIVE_UP_AFTER_SECS: i64 = 12 * 3600;
pub const BACKOFF_BASE_SECS: i64 = 5;
pub const BACKOFF_MAX_SECS: i64 = 1800;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkTraceStep {
    pub candidate: String,
    pub outcome: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtworkProcessOutcome {
    Found,
    FoundStale,
    Absent,
    RetryLater(i64),
    Cancelled,
}

struct LocalCandidateResult {
    meta: DecodedImageMeta,
    source: String,
    source_path: String,
    ref_mtime: i64,
}

fn file_mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_capped_file(path: &Path) -> Option<Vec<u8>> {
    let f = fs::File::open(path).ok()?;
    let mut data = Vec::new();
    f.take((MAX_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .ok()?;
    if data.is_empty() || data.len() > MAX_IMAGE_BYTES {
        return None;
    }
    Some(data)
}

fn find_sidecar_cover(dir: &Path) -> Option<PathBuf> {
    let sidecar_path = dir.join("cadence-album.sidecar.json");
    let raw = read_capped_file(&sidecar_path)?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    let raw_cover = v
        .get("coverArtUrl")
        .or_else(|| v.get("artworkUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| {
            !s.is_empty()
                && !s.starts_with("http://")
                && !s.starts_with("https://")
                && !s.starts_with("cadence-art://")
        })?;
    let clean = raw_cover
        .strip_prefix("file:///")
        .or_else(|| raw_cover.strip_prefix("file://"))
        .unwrap_or(raw_cover);
    let candidate = Path::new(clean);
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        dir.join(candidate)
    };
    resolved.is_file().then_some(resolved)
}

fn find_folder_candidates(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let collect_dir = |target_dir: &Path, dst: &mut Vec<PathBuf>| {
        let Ok(read_dir) = fs::read_dir(target_dir) else {
            return;
        };
        let mut imgs = Vec::new();
        for entry in read_dir.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            if media::is_cover_image_extension(ext) {
                imgs.push((name.clone(), target_dir.join(name)));
            }
        }
        let allow_single = imgs.len() == 1;
        let mut ranked: Vec<((u8, u8), String, PathBuf)> = imgs
            .into_iter()
            .filter_map(|(name, p)| {
                let rank = media::rank_cover_filename(&name, allow_single)?;
                Some((rank, name.to_ascii_lowercase(), p))
            })
            .collect();
        ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        dst.extend(ranked.into_iter().map(|(_, _, p)| p));
    };

    collect_dir(dir, &mut out);

    if let Ok(read_dir) = fs::read_dir(dir) {
        let mut subdirs = Vec::new();
        for entry in read_dir.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if media::is_artwork_subdir_name(&name) {
                    subdirs.push(dir.join(name));
                }
            }
        }
        subdirs.sort();
        for sub in subdirs {
            collect_dir(&sub, &mut out);
        }
    }

    if out.is_empty() {
        let folder_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if media::is_multidisc_subfolder_name(&folder_name) {
            if let Some(parent) = dir.parent() {
                collect_dir(parent, &mut out);
            }
        }
    }

    out
}

fn load_album_context_for_artwork(
    conn: &Connection,
    release_id: &str,
) -> rusqlite::Result<Option<(LocalAlbum, Vec<String>, Option<String>, Option<String>, Option<String>)>> {
    let rel: Option<(String, String, String, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT r.title, r.artist_credit, r.folder_path, r.release_year, r.is_compilation
             FROM releases r WHERE r.id = ?1",
            params![release_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((title, artist, folder_path, year, is_comp)) = rel else {
        return Ok(None);
    };

    let mut tracks = Vec::new();
    let mut track_paths = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, title, artist_credit, album_artist, track_number, disc_number,
                duration_secs, release_year, musicbrainz_recording_id, original_album,
                is_compilation, file_path
         FROM tracks
         WHERE release_id = ?1 AND is_online != 0
         ORDER BY has_embedded_art DESC, COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC",
    )?;
    for row in stmt.query_map(params![release_id], |r| {
        Ok((
            LocalTrack {
                track_id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                album_artist: r.get(3)?,
                track_number: r.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u32),
                disc_number: r.get::<_, Option<i64>>(5)?.map(|v| v.max(0) as u32),
                duration_secs: r.get(6)?,
                release_year: r.get(7)?,
                mb_recording_id: r.get(8)?,
                original_album: r.get(9)?,
                is_compilation: r.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
                locked_fields: Default::default(),
            },
            r.get::<_, String>(11)?,
        ))
    })? {
        let (t, fp) = row?;
        tracks.push(t);
        track_paths.push(fp);
    }

    let enrich_row: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT provider, external_release_id, proposal_json FROM enrichment_album_state WHERE release_id = ?1",
            params![release_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (mb_release_id, art_hint) = if let Some((prov, ext_id, prop_s)) = enrich_row {
        let mbid = if prov.as_deref() == Some("musicbrainz") {
            ext_id
        } else {
            None
        };
        let hint = prop_s
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("artworkUrl").and_then(Value::as_str).map(str::to_string));
        (mbid, hint)
    } else {
        (None, None)
    };

    Ok(Some((
        LocalAlbum {
            release_id: release_id.to_string(),
            title,
            artist,
            year: year.map(|y| y as i32),
            is_compilation: is_comp.unwrap_or(0) != 0,
            discs_total: 1,
            locked_release_fields: Default::default(),
            album_locked: false,
            tracks,
        },
        track_paths,
        Some(folder_path),
        mb_release_id,
        art_hint,
    )))
}

fn persist_album_artwork(
    conn: &mut Connection,
    store: &ImageStore,
    release_id: &str,
    status: &str,
    meta: &DecodedImageMeta,
    raw_bytes: &[u8],
    source: &str,
    source_path: &str,
    ref_mtime: i64,
    trace: &[ArtworkTraceStep],
) -> Result<(), String> {
    let stored_meta = store.store_bytes(raw_bytes)?;
    let etag = format!(
        "art_{}",
        format!("{:x}", Sha256::digest(&stored_meta.serving_jpeg))
            .chars()
            .take(64)
            .collect::<String>()
    );
    let trace_json = serde_json::to_string(trace).unwrap_or_else(|_| "[]".to_string());
    let now = epoch_secs();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO artwork_items
            (entity_kind, entity_id, status, image_hash, mime, width, height, size_bytes, source, source_path, ref_mtime, trace_json, updated_at)
         VALUES('album', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
            status = excluded.status,
            image_hash = excluded.image_hash,
            mime = excluded.mime,
            width = excluded.width,
            height = excluded.height,
            size_bytes = excluded.size_bytes,
            source = excluded.source,
            source_path = excluded.source_path,
            ref_mtime = excluded.ref_mtime,
            trace_json = excluded.trace_json,
            updated_at = excluded.updated_at",
        params![
            release_id,
            status,
            meta.hash,
            meta.mime,
            meta.width as i64,
            meta.height as i64,
            meta.size_bytes as i64,
            source,
            source_path,
            ref_mtime,
            trace_json,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO engine_artwork(release_id, etag, jpeg) VALUES(?1, ?2, ?3)
         ON CONFLICT(release_id) DO UPDATE SET etag = excluded.etag, jpeg = excluded.jpeg",
        params![release_id, etag, stored_meta.serving_jpeg],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tracks SET has_embedded_art = 1 WHERE release_id = ?1",
        params![release_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE releases SET front_cover_url = ?2 WHERE id = ?1",
        params![release_id, format!("cadence-art://{release_id}")],
    )
    .map_err(|e| e.to_string())?;
    let _ = mark_curate_queue_projection_stale(&tx, release_id);
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn decode_base64_data_url(url: &str) -> Result<Vec<u8>, String> {
    let (_header, payload) = url
        .split_once(";base64,")
        .ok_or_else(|| "Unsupported data URL format".to_string())?;
    let mut out = Vec::with_capacity((payload.len() / 4) * 3);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in payload.bytes() {
        if b.is_ascii_whitespace() {
            continue;
        }
        if b == b'=' {
            break;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return Err("Invalid base64 character".into()),
        };
        buf = (buf << 6) | u32::from(val);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
            if out.len() > MAX_IMAGE_BYTES {
                return Err("Image exceeds maximum size".into());
            }
        }
    }
    if out.is_empty() {
        return Err("Empty image payload".into());
    }
    Ok(out)
}

fn override_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("CadenceMusicAgent/1.0.0 (https://github.com/cadence-audio)")
            .connect_timeout(std::time::Duration::from_secs(8))
            .read_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("override reqwest client")
    })
}

pub fn build_override_candidate_urls(url: &str) -> Vec<String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return vec![trimmed.to_string()];
    }
    let (base, query) = match trimmed.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (trimmed, None),
    };
    if !base.to_ascii_lowercase().contains("mzstatic.com/") {
        return vec![trimmed.to_string()];
    }
    let Some((prefix, leaf)) = base.rsplit_once('/') else {
        return vec![trimmed.to_string()];
    };
    let Some((stem, ext)) = leaf.rsplit_once('.') else {
        return vec![trimmed.to_string()];
    };
    if !matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp"
    ) {
        return vec![trimmed.to_string()];
    }
    if stem.len() < 3 || !stem[stem.len() - 2..].eq_ignore_ascii_case("bb") {
        return vec![trimmed.to_string()];
    }
    let dims = &stem[..stem.len() - 2];
    let Some((w_s, h_s)) = dims.split_once('x').or_else(|| dims.split_once('X')) else {
        return vec![trimmed.to_string()];
    };
    if w_s.is_empty()
        || h_s.is_empty()
        || !w_s.bytes().all(|b| b.is_ascii_digit())
        || !h_s.bytes().all(|b| b.is_ascii_digit())
    {
        return vec![trimmed.to_string()];
    }
    let (Ok(w), Ok(h)) = (w_s.parse::<u32>(), h_s.parse::<u32>()) else {
        return vec![trimmed.to_string()];
    };
    if w == 0 || h == 0 {
        return vec![trimmed.to_string()];
    }

    let make_url = |size: u32| -> String {
        let new_base = format!("{prefix}/{size}x{size}bb.{ext}");
        match query {
            Some(q) => format!("{new_base}?{q}"),
            None => new_base,
        }
    };

    let mut out = Vec::new();
    let mut push_unique = |cand: String| {
        if !out.contains(&cand) {
            out.push(cand);
        }
    };
    if w > 1200 {
        push_unique(make_url(1200));
        push_unique(make_url(600));
        push_unique(trimmed.to_string());
    } else if w > 600 {
        push_unique(trimmed.to_string());
        push_unique(make_url(600));
    } else {
        push_unique(trimmed.to_string());
    }
    out
}

async fn fetch_single_override_url(
    client: &reqwest::Client,
    url: &str,
    cancel: &Notify,
) -> Result<Vec<u8>, ProviderError> {
    let resp = tokio::select! {
        biased;
        _ = cancel.notified() => return Err(ProviderError::Cancelled),
        res = client.get(url).send() => res.map_err(|e| ProviderError::Transient(e.to_string()))?,
    };
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
        return Err(ProviderError::NotFound);
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
    {
        return Err(ProviderError::RetryLater(std::time::Duration::from_secs(60)));
    }
    if !status.is_success() {
        return Err(ProviderError::Transient(format!("HTTP {status}")));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_IMAGE_BYTES {
            return Err(ProviderError::NotFound);
        }
    }
    let bytes = tokio::select! {
        biased;
        _ = cancel.notified() => return Err(ProviderError::Cancelled),
        raw = resp.bytes() => raw.map_err(|e| ProviderError::Transient(e.to_string()))?,
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(ProviderError::NotFound);
    }
    Ok(bytes.to_vec())
}

async fn fetch_override_image_bytes(
    url: &str,
    cancel: &Notify,
) -> Result<(Vec<u8>, String), ProviderError> {
    if url.starts_with("data:image/") {
        return decode_base64_data_url(url)
            .map(|bytes| (bytes, "uploaded".to_string()))
            .map_err(|_| ProviderError::NotFound);
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(ProviderError::NotFound);
    }

    let client = override_http_client();
    let candidates = build_override_candidate_urls(url);
    let mut last_transient: Option<ProviderError> = None;

    for (idx, candidate) in candidates.iter().enumerate() {
        match fetch_single_override_url(client, candidate, cancel).await {
            Ok(bytes) => return Ok((bytes, candidate.clone())),
            Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
            Err(err @ ProviderError::RetryLater(_))
            | Err(err @ ProviderError::CircuitOpen(_)) => return Err(err),
            Err(ProviderError::NotFound) => continue,
            Err(ProviderError::Transient(msg)) => {
                let lower = msg.to_ascii_lowercase();
                if candidates.len() == 1
                    && idx == 0
                    && (lower.contains("connect") || lower.contains("timed out"))
                {
                    match fetch_single_override_url(client, candidate, cancel).await {
                        Ok(bytes) => return Ok((bytes, candidate.clone())),
                        Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
                        Err(err @ ProviderError::RetryLater(_))
                        | Err(err @ ProviderError::CircuitOpen(_)) => return Err(err),
                        Err(ProviderError::NotFound) => continue,
                        Err(ProviderError::Transient(retry_msg)) => {
                            last_transient = Some(ProviderError::Transient(retry_msg));
                        }
                    }
                } else {
                    last_transient = Some(ProviderError::Transient(msg));
                }
            }
        }
    }

    Err(last_transient.unwrap_or(ProviderError::NotFound))
}

fn record_permanent_override_failure(conn: &Connection, release_id: &str, detail: &str) {
    let now = epoch_secs();
    let trace_json = serde_json::to_string(&vec![ArtworkTraceStep {
        candidate: "user_override".into(),
        outcome: "error".into(),
        detail: detail.to_string(),
    }])
    .unwrap_or_else(|_| "[]".to_string());
    let _ = conn.execute(
        "INSERT INTO artwork_items(entity_kind, entity_id, status, trace_json, updated_at)
         VALUES('album', ?1, 'absent', ?2, ?3)
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
            status = CASE
                WHEN artwork_items.status IN ('found', 'found_stale', 'user_override')
                    THEN artwork_items.status
                ELSE 'absent'
            END,
            trace_json = excluded.trace_json,
            updated_at = excluded.updated_at",
        params![release_id, trace_json, now],
    );
    let _ = conn.execute(
        "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
        params![release_id],
    );
}

pub async fn process_album_artwork_item(
    conn: &mut Connection,
    store: &ImageStore,
    external: Option<&Arc<dyn ExternalArtworkProvider>>,
    release_id: &str,
    enqueued_at: i64,
    attempts: i64,
    min_local_px: u32,
    allow_external: bool,
    is_idle_fn: &(dyn Fn() -> bool + Send + Sync),
    cancel: &Notify,
) -> ArtworkProcessOutcome {
    if !is_idle_fn() {
        return ArtworkProcessOutcome::Cancelled;
    }

    let override_url: Option<String> = conn
        .query_row(
            "SELECT override_url FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
            params![release_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None)
        .flatten()
        .map(|s: String| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(ref url) = override_url {
        match fetch_override_image_bytes(url, cancel).await {
            Ok((bytes, resolved_url)) => {
                match ImageStore::inspect_and_prepare(&bytes) {
                    Ok(meta) => {
                        let trace = vec![ArtworkTraceStep {
                            candidate: "user_override".into(),
                            outcome: "hit".into(),
                            detail: format!(
                                "{}x{} ({} bytes)",
                                meta.width, meta.height, meta.size_bytes
                            ),
                        }];
                        let src_path = if url.starts_with("data:") {
                            "uploaded"
                        } else {
                            resolved_url.as_str()
                        };
                        if persist_album_artwork(
                            conn,
                            store,
                            release_id,
                            "user_override",
                            &meta,
                            &bytes,
                            "user_override",
                            src_path,
                            0,
                            &trace,
                        )
                        .is_ok()
                        {
                            let _ = conn.execute(
                                "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
                                params![release_id],
                            );
                            return ArtworkProcessOutcome::Found;
                        }
                        record_permanent_override_failure(
                            conn,
                            release_id,
                            "failed to persist decoded override cover image",
                        );
                        return ArtworkProcessOutcome::Absent;
                    }
                    Err(err) => {
                        record_permanent_override_failure(
                            conn,
                            release_id,
                            &format!("invalid image payload: {err}"),
                        );
                        return ArtworkProcessOutcome::Absent;
                    }
                }
            }
            Err(ProviderError::Cancelled) => return ArtworkProcessOutcome::Cancelled,
            Err(ProviderError::RetryLater(d)) | Err(ProviderError::CircuitOpen(d)) => {
                let secs = d.as_secs().max(5) as i64;
                let msg = format!("rate limited (retry in {secs}s)");
                let trace = [ArtworkTraceStep {
                    candidate: "user_override".into(),
                    outcome: "error".into(),
                    detail: msg.clone(),
                }];
                return handle_retry_budget(
                    conn,
                    "album",
                    release_id,
                    enqueued_at,
                    attempts,
                    secs,
                    Some(msg.as_str()),
                    &trace,
                );
            }
            Err(ProviderError::Transient(msg)) => {
                let backoff =
                    (BACKOFF_BASE_SECS * (1i64 << attempts.clamp(0, 10))).min(BACKOFF_MAX_SECS);
                let trace = [ArtworkTraceStep {
                    candidate: "user_override".into(),
                    outcome: "error".into(),
                    detail: msg.clone(),
                }];
                return handle_retry_budget(
                    conn,
                    "album",
                    release_id,
                    enqueued_at,
                    attempts,
                    backoff,
                    Some(msg.as_str()),
                    &trace,
                );
            }
            Err(ProviderError::NotFound) => {
                record_permanent_override_failure(
                    conn,
                    release_id,
                    "staged cover art URL returned HTTP 404 or unsupported payload",
                );
                return ArtworkProcessOutcome::Absent;
            }
        }
    }

    let existing_status: Option<String> = conn
        .query_row(
            "SELECT status FROM artwork_items WHERE entity_kind='album' AND entity_id=?1",
            params![release_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    if existing_status.as_deref() == Some("user_override") {
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
            params![release_id],
        );
        return ArtworkProcessOutcome::Found;
    }

    let Ok(Some((local_album, track_paths, folder_path_opt, mb_release_id, art_hint))) =
        load_album_context_for_artwork(conn, release_id)
    else {
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
            params![release_id],
        );
        return ArtworkProcessOutcome::Absent;
    };

    let mut trace: Vec<ArtworkTraceStep> = Vec::new();
    let mut local_best: Option<(LocalCandidateResult, Vec<u8>)> = None;

    if let Some(ref folder_str) = folder_path_opt {
        let dir = Path::new(folder_str);
        // 1. Sidecar
        if let Some(sidecar_img) = find_sidecar_cover(dir) {
            if let Some(bytes) = read_capped_file(&sidecar_img) {
                if let Ok(meta) = ImageStore::inspect_and_prepare(&bytes) {
                    let short_edge = meta.width.min(meta.height);
                    let detail = format!("{} ({}x{})", sidecar_img.display(), meta.width, meta.height);
                    let outcome = if short_edge < min_local_px {
                        "low_res"
                    } else {
                        "hit"
                    };
                    trace.push(ArtworkTraceStep {
                        candidate: "sidecar".into(),
                        outcome: outcome.into(),
                        detail,
                    });
                    local_best = Some((
                        LocalCandidateResult {
                            meta,
                            source: "sidecar".into(),
                            source_path: sidecar_img.to_string_lossy().to_string(),
                            ref_mtime: file_mtime_secs(&sidecar_img),
                        },
                        bytes,
                    ));
                }
            }
        } else {
            trace.push(ArtworkTraceStep {
                candidate: "sidecar".into(),
                outcome: "miss".into(),
                detail: "no local sidecar cover".into(),
            });
        }

        // 2. Folder images
        if local_best.is_none() {
            let folder_cands = find_folder_candidates(dir);
            if folder_cands.is_empty() {
                trace.push(ArtworkTraceStep {
                    candidate: "folder".into(),
                    outcome: "miss".into(),
                    detail: "no matching cover file in folder".into(),
                });
            } else {
                for cand_path in folder_cands {
                    let Some(bytes) = read_capped_file(&cand_path) else {
                        trace.push(ArtworkTraceStep {
                            candidate: "folder".into(),
                            outcome: "unreadable".into(),
                            detail: cand_path.to_string_lossy().to_string(),
                        });
                        continue;
                    };
                    match ImageStore::inspect_and_prepare(&bytes) {
                        Ok(meta) => {
                            let short_edge = meta.width.min(meta.height);
                            let outcome = if short_edge < min_local_px {
                                "low_res"
                            } else {
                                "hit"
                            };
                            trace.push(ArtworkTraceStep {
                                candidate: "folder".into(),
                                outcome: outcome.into(),
                                detail: format!("{} ({}x{})", cand_path.display(), meta.width, meta.height),
                            });
                            local_best = Some((
                                LocalCandidateResult {
                                    meta,
                                    source: "folder".into(),
                                    source_path: cand_path.to_string_lossy().to_string(),
                                    ref_mtime: file_mtime_secs(&cand_path),
                                },
                                bytes,
                            ));
                            break;
                        }
                        Err(err) => {
                            trace.push(ArtworkTraceStep {
                                candidate: "folder".into(),
                                outcome: "unreadable".into(),
                                detail: format!("{}: {err}", cand_path.display()),
                            });
                        }
                    }
                }
            }
        }
    }

    // 3. Embedded container art (inspects first eligible track, DSF tail-seek safe)
    if local_best.is_none() {
        let mut found_embedded = false;
        for track_path_str in &track_paths {
            if !is_idle_fn() {
                return ArtworkProcessOutcome::Cancelled;
            }
            let p = Path::new(track_path_str);
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if let Ok(inspected) = media::inspect(p, &ext) {
                if let Some(tag) = inspected.tag.as_ref() {
                    if let Some(pic) = media::select_best_picture(tag) {
                        let raw = pic.data().to_vec();
                        if let Ok(meta) = ImageStore::inspect_and_prepare(&raw) {
                            let short_edge = meta.width.min(meta.height);
                            let outcome = if short_edge < min_local_px {
                                "low_res"
                            } else {
                                "hit"
                            };
                            trace.push(ArtworkTraceStep {
                                candidate: "embedded".into(),
                                outcome: outcome.into(),
                                detail: format!("{} ({}x{})", p.display(), meta.width, meta.height),
                            });
                            local_best = Some((
                                LocalCandidateResult {
                                    meta,
                                    source: "embedded".into(),
                                    source_path: track_path_str.clone(),
                                    ref_mtime: file_mtime_secs(p),
                                },
                                raw,
                            ));
                            found_embedded = true;
                            break;
                        }
                    }
                }
            }
            break;
        }
        if !found_embedded {
            trace.push(ArtworkTraceStep {
                candidate: "embedded".into(),
                outcome: "miss".into(),
                detail: "no embedded cover picture".into(),
            });
        }
    }

    let local_short_edge = local_best
        .as_ref()
        .map(|(l, _)| l.meta.width.min(l.meta.height))
        .unwrap_or(0);
    let local_area = local_best
        .as_ref()
        .map(|(l, _)| u64::from(l.meta.width) * u64::from(l.meta.height))
        .unwrap_or(0);
    let needs_external = local_best.is_none() || local_short_edge < min_local_px;

    if !needs_external {
        if let Some((ref local, ref bytes)) = local_best {
            if persist_album_artwork(
                conn,
                store,
                release_id,
                "found",
                &local.meta,
                bytes,
                &local.source,
                &local.source_path,
                local.ref_mtime,
                &trace,
            )
            .is_ok()
            {
                let _ = conn.execute(
                    "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
                    params![release_id],
                );
                return ArtworkProcessOutcome::Found;
            }
        }
    }

    // If local art exists (low-res) and external fetch isn't allowed on this pass (local-only pool) or unavailable,
    // persist local art as found_stale immediately so UI shows art without blocking.
    if !allow_external || external.is_none() {
        if let Some((local, bytes)) = local_best {
            let _ = persist_album_artwork(
                conn,
                store,
                release_id,
                if allow_external { "found" } else { "found_stale" },
                &local.meta,
                &bytes,
                &local.source,
                &local.source_path,
                local.ref_mtime,
                &trace,
            );
            if allow_external {
                let _ = conn.execute(
                    "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
                    params![release_id],
                );
                return ArtworkProcessOutcome::Found;
            }
            return ArtworkProcessOutcome::FoundStale;
        }
        return ArtworkProcessOutcome::RetryLater(5);
    }

    // 4. External artwork acquisition
    let ext_provider = external.unwrap();
    if !is_idle_fn() {
        return ArtworkProcessOutcome::Cancelled;
    }
    match ext_provider
        .fetch_album_cover(
            &local_album,
            mb_release_id.as_deref(),
            art_hint.as_deref(),
            cancel,
        )
        .await
    {
        Ok((ext_bytes, prov_name)) => {
            if let Ok(ext_meta) = ImageStore::inspect_and_prepare(&ext_bytes) {
                let ext_short = ext_meta.width.min(ext_meta.height);
                let ext_area = u64::from(ext_meta.width) * u64::from(ext_meta.height);
                let accept_upgrade = local_best.is_none() || (ext_short >= 600 && ext_area > local_area);
                if accept_upgrade {
                    trace.push(ArtworkTraceStep {
                        candidate: format!("external:{prov_name}"),
                        outcome: "hit".into(),
                        detail: format!("{}x{} ({} bytes)", ext_meta.width, ext_meta.height, ext_meta.size_bytes),
                    });
                    if persist_album_artwork(
                        conn,
                        store,
                        release_id,
                        "found",
                        &ext_meta,
                        &ext_bytes,
                        &format!("external:{prov_name}"),
                        "",
                        0,
                        &trace,
                    )
                    .is_ok()
                    {
                        let _ = conn.execute(
                            "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
                            params![release_id],
                        );
                        return ArtworkProcessOutcome::Found;
                    }
                } else {
                    trace.push(ArtworkTraceStep {
                        candidate: format!("external:{prov_name}"),
                        outcome: "skipped".into(),
                        detail: format!(
                            "external {}x{} did not beat local resolution",
                            ext_meta.width, ext_meta.height
                        ),
                    });
                }
            }
        }
        Err(ProviderError::Cancelled) => return ArtworkProcessOutcome::Cancelled,
        Err(ProviderError::NotFound) => {
            trace.push(ArtworkTraceStep {
                candidate: "external".into(),
                outcome: "miss".into(),
                detail: "no external artwork match".into(),
            });
            if let Some((local, bytes)) = local_best {
                let _ = persist_album_artwork(
                    conn,
                    store,
                    release_id,
                    "found",
                    &local.meta,
                    &bytes,
                    &local.source,
                    &local.source_path,
                    local.ref_mtime,
                    &trace,
                );
                let _ = conn.execute(
                    "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
                    params![release_id],
                );
                return ArtworkProcessOutcome::Found;
            }
            let now = epoch_secs();
            let trace_json = serde_json::to_string(&trace).unwrap_or_else(|_| "[]".to_string());
            let _ = conn.execute(
                "INSERT INTO artwork_items(entity_kind, entity_id, status, trace_json, updated_at)
                 VALUES('album', ?1, 'absent', ?2, ?3)
                 ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                    status='absent', trace_json=excluded.trace_json, updated_at=excluded.updated_at",
                params![release_id, trace_json, now],
            );
            let _ = conn.execute(
                "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
                params![release_id],
            );
            return ArtworkProcessOutcome::Absent;
        }
        Err(ProviderError::RetryLater(d)) | Err(ProviderError::CircuitOpen(d)) => {
            let secs = d.as_secs().max(5) as i64;
            let err_msg = format!("deferred {secs}s by provider rate/breaker gate");
            trace.push(ArtworkTraceStep {
                candidate: "external".into(),
                outcome: "error".into(),
                detail: err_msg.clone(),
            });
            if let Some((local, bytes)) = local_best {
                let _ = persist_album_artwork(
                    conn,
                    store,
                    release_id,
                    "found_stale",
                    &local.meta,
                    &bytes,
                    &local.source,
                    &local.source_path,
                    local.ref_mtime,
                    &trace,
                );
            }
            return handle_retry_budget(
                conn,
                "album",
                release_id,
                enqueued_at,
                attempts,
                secs,
                Some(err_msg.as_str()),
                &trace,
            );
        }
        Err(ProviderError::Transient(msg)) => {
            trace.push(ArtworkTraceStep {
                candidate: "external".into(),
                outcome: "error".into(),
                detail: msg.clone(),
            });
            if let Some((local, bytes)) = local_best {
                let _ = persist_album_artwork(
                    conn,
                    store,
                    release_id,
                    "found_stale",
                    &local.meta,
                    &bytes,
                    &local.source,
                    &local.source_path,
                    local.ref_mtime,
                    &trace,
                );
            }
            let backoff = (BACKOFF_BASE_SECS * (1i64 << attempts.clamp(0, 10))).min(BACKOFF_MAX_SECS);
            return handle_retry_budget(
                conn,
                "album",
                release_id,
                enqueued_at,
                attempts,
                backoff,
                Some(msg.as_str()),
                &trace,
            );
        }
    }

    if let Some((local, bytes)) = local_best {
        let _ = persist_album_artwork(
            conn,
            store,
            release_id,
            "found",
            &local.meta,
            &bytes,
            &local.source,
            &local.source_path,
            local.ref_mtime,
            &trace,
        );
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind='album' AND entity_id=?1",
            params![release_id],
        );
        return ArtworkProcessOutcome::Found;
    }

    ArtworkProcessOutcome::Absent
}

pub(crate) fn handle_retry_budget(
    conn: &Connection,
    entity_kind: &str,
    entity_id: &str,
    enqueued_at: i64,
    attempts: i64,
    delay_secs: i64,
    last_error: Option<&str>,
    trace: &[ArtworkTraceStep],
) -> ArtworkProcessOutcome {
    let now = epoch_secs();
    if enqueued_at > 0 && now.saturating_sub(enqueued_at) >= GIVE_UP_AFTER_SECS {
        let trace_json = serde_json::to_string(trace).unwrap_or_else(|_| "[]".to_string());
        let _ = conn.execute(
            "INSERT INTO artwork_items(entity_kind, entity_id, status, trace_json, updated_at)
             VALUES(?1, ?2, 'absent', ?3, ?4)
             ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                status = CASE
                    WHEN artwork_items.status IN ('found', 'user_override') THEN artwork_items.status
                    WHEN artwork_items.status = 'found_stale' THEN 'found'
                    ELSE 'absent'
                END,
                trace_json = excluded.trace_json,
                updated_at = excluded.updated_at",
            params![entity_kind, entity_id, trace_json, now],
        );
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind=?1 AND entity_id=?2",
            params![entity_kind, entity_id],
        );
        return ArtworkProcessOutcome::Absent;
    }
    let next_retry = now + delay_secs.max(5);
    let clean_err = last_error
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut end = s.len().min(240);
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            &s[..end]
        });
    let _ = conn.execute(
        "UPDATE artwork_queue SET attempts = ?3, next_retry_at = ?4, last_error = ?5
         WHERE entity_kind = ?1 AND entity_id = ?2",
        params![entity_kind, entity_id, attempts + 1, next_retry, clean_err],
    );
    ArtworkProcessOutcome::RetryLater(delay_secs)
}

fn find_artist_image_in_dir(dir: &Path) -> Option<PathBuf> {
    let read_dir = fs::read_dir(dir).ok()?;
    let mut matches: Vec<(String, PathBuf)> = Vec::new();
    for entry in read_dir.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = dir.join(&name);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if stem.eq_ignore_ascii_case("artist") && media::is_cover_image_extension(ext) {
            matches.push((name.to_ascii_lowercase(), path));
        }
    }
    matches.sort_by(|a, b| a.0.cmp(&b.0));
    matches.into_iter().next().map(|(_, p)| p)
}

fn common_parent_dir(dirs: &[PathBuf]) -> Option<PathBuf> {
    if dirs.is_empty() {
        return None;
    }
    if dirs.len() == 1 {
        return dirs[0].parent().map(Path::to_path_buf);
    }
    let first: Vec<_> = dirs[0].components().collect();
    let mut shared_len = first.len();
    for d in &dirs[1..] {
        let comps: Vec<_> = d.components().collect();
        let common = first
            .iter()
            .zip(comps.iter())
            .take_while(|(a, b)| a == b)
            .count();
        shared_len = shared_len.min(common);
    }
    if shared_len == 0 {
        return None;
    }
    let mut out = PathBuf::new();
    for c in &first[..shared_len] {
        out.push(c.as_os_str());
    }
    Some(out)
}

fn find_local_artist_portrait(conn: &Connection, artist_id: &str) -> Option<(Vec<u8>, String, i64)> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT r.folder_path
             FROM track_artist_credits tac
             JOIN tracks t ON t.id = tac.track_id
             JOIN releases r ON r.id = t.release_id
             WHERE tac.canonical_artist_id = ?1
               AND t.is_online != 0
               AND TRIM(COALESCE(r.folder_path, '')) != ''",
        )
        .ok()?;
    let album_dirs: Vec<PathBuf> = stmt
        .query_map(params![artist_id], |r| r.get::<_, String>(0))
        .ok()?
        .flatten()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect();

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = common_parent_dir(&album_dirs) {
        if parent.is_dir() {
            search_dirs.push(parent);
        }
    }
    for dir in album_dirs {
        if !search_dirs.contains(&dir) {
            search_dirs.push(dir);
        }
    }

    for dir in search_dirs {
        if let Some(img_path) = find_artist_image_in_dir(&dir) {
            if let Some(bytes) = read_capped_file(&img_path) {
                return Some((
                    bytes,
                    img_path.to_string_lossy().to_string(),
                    file_mtime_secs(&img_path),
                ));
            }
        }
    }
    None
}

fn persist_artist_artwork(
    conn: &Connection,
    store: &ImageStore,
    artist_id: &str,
    bytes: &[u8],
    source: &str,
    source_path: &str,
    ref_mtime: i64,
    trace: &[ArtworkTraceStep],
) -> Result<(), String> {
    let meta = store.store_bytes(bytes)?;
    let now = epoch_secs();
    let trace_json = serde_json::to_string(trace).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO artwork_items
            (entity_kind, entity_id, status, image_hash, mime, width, height, size_bytes, source, source_path, ref_mtime, trace_json, updated_at)
         VALUES('artist', ?1, 'found', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
            status='found', image_hash=excluded.image_hash, mime=excluded.mime,
            width=excluded.width, height=excluded.height, size_bytes=excluded.size_bytes,
            source=excluded.source, source_path=excluded.source_path, ref_mtime=excluded.ref_mtime,
            trace_json=excluded.trace_json, updated_at=excluded.updated_at",
        params![
            artist_id,
            meta.hash,
            meta.mime,
            meta.width as i64,
            meta.height as i64,
            meta.size_bytes as i64,
            source,
            source_path,
            ref_mtime,
            trace_json,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE canonical_artists SET portrait_status='enriched', portrait_url=?2, portrait_checked_at=?3 WHERE id=?1",
        params![artist_id, format!("cadence-artist-art://{artist_id}"), now],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM artwork_queue WHERE entity_kind='artist' AND entity_id=?1",
        params![artist_id],
    );
    Ok(())
}

pub async fn process_artist_artwork_item(
    conn: &mut Connection,
    store: &ImageStore,
    external: Option<&Arc<dyn ExternalArtworkProvider>>,
    artist_id: &str,
    enqueued_at: i64,
    attempts: i64,
    is_idle_fn: &(dyn Fn() -> bool + Send + Sync),
    cancel: &Notify,
) -> ArtworkProcessOutcome {
    if !is_idle_fn() {
        return ArtworkProcessOutcome::Cancelled;
    }

    let existing_status: Option<String> = conn
        .query_row(
            "SELECT status FROM artwork_items WHERE entity_kind='artist' AND entity_id=?1",
            params![artist_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    if existing_status.as_deref() == Some("user_override") {
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind='artist' AND entity_id=?1",
            params![artist_id],
        );
        return ArtworkProcessOutcome::Found;
    }

    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM canonical_artists WHERE id = ?1",
            params![artist_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    let Some(artist_name) = name else {
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind='artist' AND entity_id=?1",
            params![artist_id],
        );
        return ArtworkProcessOutcome::Absent;
    };

    // 1. Local artist.* file in artist parent folder or album folders (idle-gated)
    if let Some((local_bytes, src_path, ref_mtime)) = find_local_artist_portrait(conn, artist_id) {
        let trace = vec![ArtworkTraceStep {
            candidate: "folder".into(),
            outcome: "hit".into(),
            detail: src_path.clone(),
        }];
        if persist_artist_artwork(
            conn,
            store,
            artist_id,
            &local_bytes,
            "folder",
            &src_path,
            ref_mtime,
            &trace,
        )
        .is_ok()
        {
            return ArtworkProcessOutcome::Found;
        }
    }

    let Some(ext_provider) = external else {
        let _ = conn.execute(
            "DELETE FROM artwork_queue WHERE entity_kind='artist' AND entity_id=?1",
            params![artist_id],
        );
        return ArtworkProcessOutcome::Absent;
    };

    match ext_provider.fetch_artist_portrait(&artist_name, cancel).await {
        Ok((bytes, prov)) => {
            let trace = vec![ArtworkTraceStep {
                candidate: format!("external:{prov}"),
                outcome: "hit".into(),
                detail: format!("{} bytes", bytes.len()),
            }];
            if persist_artist_artwork(
                conn,
                store,
                artist_id,
                &bytes,
                &format!("external:{prov}"),
                "",
                0,
                &trace,
            )
            .is_ok()
            {
                return ArtworkProcessOutcome::Found;
            }
            ArtworkProcessOutcome::Absent
        }
        Err(ProviderError::Cancelled) => ArtworkProcessOutcome::Cancelled,
        Err(ProviderError::NotFound) => {
            let now = epoch_secs();
            let _ = conn.execute(
                "INSERT INTO artwork_items(entity_kind, entity_id, status, trace_json, updated_at)
                 VALUES('artist', ?1, 'absent', '[]', ?2)
                 ON CONFLICT(entity_kind, entity_id) DO UPDATE SET status='absent', updated_at=excluded.updated_at",
                params![artist_id, now],
            );
            let _ = conn.execute(
                "UPDATE canonical_artists SET portrait_status='not_found', portrait_checked_at=?2 WHERE id=?1",
                params![artist_id, now],
            );
            let _ = conn.execute(
                "DELETE FROM artwork_queue WHERE entity_kind='artist' AND entity_id=?1",
                params![artist_id],
            );
            ArtworkProcessOutcome::Absent
        }
        Err(ProviderError::RetryLater(d)) | Err(ProviderError::CircuitOpen(d)) => {
            let secs = d.as_secs().max(5) as i64;
            let err_msg = format!("rate limited (retry in {secs}s)");
            handle_retry_budget(
                conn,
                "artist",
                artist_id,
                enqueued_at,
                attempts,
                secs,
                Some(err_msg.as_str()),
                &[],
            )
        }
        Err(ProviderError::Transient(msg)) => {
            let backoff = (BACKOFF_BASE_SECS * (1i64 << attempts.clamp(0, 10))).min(BACKOFF_MAX_SECS);
            handle_retry_budget(
                conn,
                "artist",
                artist_id,
                enqueued_at,
                attempts,
                backoff,
                Some(msg.as_str()),
                &[],
            )
        }
    }
}
