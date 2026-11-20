use super::gate::{GateOutcome, GateRegistry};
use super::image_store::MAX_IMAGE_BYTES;
use super::matcher::{is_placeholder_value, is_va_artist, string_dist, CandidateAlbum, CandidateTrack, LocalAlbum};
use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

const USER_AGENT: &str = "CadenceMusicAgent/1.0.0 (https://github.com/cadence-audio)";
const VARIOUS_ARTISTS_MBID: &str = "89ad4ac3-39f7-470e-963a-56509c546377";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderError {
    NotFound,
    RetryLater(Duration),
    CircuitOpen(Duration),
    Transient(String),
    Cancelled,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait MetadataProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn lookup_album<'a>(
        &'a self,
        local: &'a LocalAlbum,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<Vec<CandidateAlbum>, ProviderError>>;
}

pub trait ExternalArtworkProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn fetch_album_cover<'a>(
        &'a self,
        local: &'a LocalAlbum,
        mb_release_id: Option<&'a str>,
        artwork_url_hint: Option<&'a str>,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String), ProviderError>>;

    fn fetch_artist_portrait<'a>(
        &'a self,
        artist_name: &'a str,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String), ProviderError>>;
}

fn build_http_client() -> Client {
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .expect("reqwest client")
}

fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| Duration::from_secs(secs.clamp(5, 3600)))
}

async fn gated_get_json(
    client: &Client,
    gates: &GateRegistry,
    provider: &str,
    url: &str,
    query: &[(&str, String)],
    cancel: &Notify,
) -> Result<Value, ProviderError> {
    let (pace_wait, gen) = gates
        .try_acquire_at(provider, Instant::now())
        .map_err(ProviderError::CircuitOpen)?;
    if !pace_wait.is_zero() {
        tokio::select! {
            biased;
            _ = cancel.notified() => {
                gates.record_at(provider, gen, GateOutcome::Cancelled, Instant::now());
                return Err(ProviderError::Cancelled);
            }
            _ = tokio::time::sleep(pace_wait) => {}
        }
    }

    let req = client.get(url).query(query);
    let resp = tokio::select! {
        biased;
        _ = cancel.notified() => {
            gates.record_at(provider, gen, GateOutcome::Cancelled, Instant::now());
            return Err(ProviderError::Cancelled);
        }
        res = req.send() => {
            match res {
                Ok(r) => r,
                Err(e) => {
                    gates.record_at(provider, gen, GateOutcome::TransientError, Instant::now());
                    return Err(ProviderError::Transient(e.to_string()));
                }
            }
        }
    };

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
        gates.record_at(provider, gen, GateOutcome::NotFound, Instant::now());
        return Err(ProviderError::NotFound);
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
    {
        let delay = parse_retry_after(resp.headers()).unwrap_or(Duration::from_secs(60));
        gates.record_at(provider, gen, GateOutcome::RetryLater(delay), Instant::now());
        return Err(ProviderError::RetryLater(delay));
    }
    if !status.is_success() {
        gates.record_at(provider, gen, GateOutcome::TransientError, Instant::now());
        return Err(ProviderError::Transient(format!("HTTP {status}")));
    }

    let json = tokio::select! {
        biased;
        _ = cancel.notified() => {
            gates.record_at(provider, gen, GateOutcome::Cancelled, Instant::now());
            return Err(ProviderError::Cancelled);
        }
        parsed = resp.json::<Value>() => {
            match parsed {
                Ok(v) => v,
                Err(e) => {
                    gates.record_at(provider, gen, GateOutcome::TransientError, Instant::now());
                    return Err(ProviderError::Transient(e.to_string()));
                }
            }
        }
    };
    gates.record_at(provider, gen, GateOutcome::Success, Instant::now());
    Ok(json)
}

async fn gated_get_bytes(
    client: &Client,
    gates: &GateRegistry,
    provider: &str,
    url: &str,
    cancel: &Notify,
) -> Result<Vec<u8>, ProviderError> {
    let (pace_wait, gen) = gates
        .try_acquire_at(provider, Instant::now())
        .map_err(ProviderError::CircuitOpen)?;
    if !pace_wait.is_zero() {
        tokio::select! {
            biased;
            _ = cancel.notified() => {
                gates.record_at(provider, gen, GateOutcome::Cancelled, Instant::now());
                return Err(ProviderError::Cancelled);
            }
            _ = tokio::time::sleep(pace_wait) => {}
        }
    }

    let resp = tokio::select! {
        biased;
        _ = cancel.notified() => {
            gates.record_at(provider, gen, GateOutcome::Cancelled, Instant::now());
            return Err(ProviderError::Cancelled);
        }
        res = client.get(url).send() => {
            match res {
                Ok(r) => r,
                Err(e) => {
                    gates.record_at(provider, gen, GateOutcome::TransientError, Instant::now());
                    return Err(ProviderError::Transient(e.to_string()));
                }
            }
        }
    };

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
        gates.record_at(provider, gen, GateOutcome::NotFound, Instant::now());
        return Err(ProviderError::NotFound);
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
    {
        let delay = parse_retry_after(resp.headers()).unwrap_or(Duration::from_secs(60));
        gates.record_at(provider, gen, GateOutcome::RetryLater(delay), Instant::now());
        return Err(ProviderError::RetryLater(delay));
    }
    if !status.is_success() {
        gates.record_at(provider, gen, GateOutcome::TransientError, Instant::now());
        return Err(ProviderError::Transient(format!("HTTP {status}")));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_IMAGE_BYTES {
            gates.record_at(provider, gen, GateOutcome::NotFound, Instant::now());
            return Err(ProviderError::NotFound);
        }
    }

    let bytes = tokio::select! {
        biased;
        _ = cancel.notified() => {
            gates.record_at(provider, gen, GateOutcome::Cancelled, Instant::now());
            return Err(ProviderError::Cancelled);
        }
        raw = resp.bytes() => {
            match raw {
                Ok(b) => b,
                Err(e) => {
                    gates.record_at(provider, gen, GateOutcome::TransientError, Instant::now());
                    return Err(ProviderError::Transient(e.to_string()));
                }
            }
        }
    };
    if bytes.len() > MAX_IMAGE_BYTES {
        gates.record_at(provider, gen, GateOutcome::NotFound, Instant::now());
        return Err(ProviderError::NotFound);
    }
    gates.record_at(provider, gen, GateOutcome::Success, Instant::now());
    Ok(bytes.to_vec())
}

fn escape_lucene(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        if matches!(
            ch,
            '+' | '-' | '&' | '|' | '!' | '(' | ')' | '{' | '}' | '[' | ']' | '^' | '"' | '~' | '*' | '?' | ':' | '\\' | '/'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn parse_year(date_str: Option<&str>) -> Option<i32> {
    let raw = date_str?.trim();
    if raw.len() < 4 {
        return None;
    }
    let y: i32 = raw[..4].parse().ok()?;
    (1889..=2100).contains(&y).then_some(y)
}

fn parse_mb_artist_credits(credits: Option<&Value>) -> (String, bool) {
    let Some(arr) = credits.and_then(Value::as_array) else {
        return (String::new(), false);
    };
    let mut joined = String::new();
    let mut is_va = false;
    for el in arr {
        let artist_obj = el.get("artist");
        if artist_obj.and_then(|a| a.get("id")).and_then(Value::as_str) == Some(VARIOUS_ARTISTS_MBID) {
            is_va = true;
        }
        let name = el
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| artist_obj.and_then(|a| a.get("name")).and_then(Value::as_str))
            .unwrap_or("");
        joined.push_str(name);
        if let Some(jp) = el.get("joinphrase").and_then(Value::as_str) {
            joined.push_str(jp);
        }
    }
    if is_va {
        return ("Various Artists".to_string(), true);
    }
    (joined.trim().to_string(), false)
}

fn parse_mb_release(release: &Value) -> Option<CandidateAlbum> {
    let mbid = release.get("id").and_then(Value::as_str)?.to_string();
    let album = release.get("title").and_then(Value::as_str)?.trim().to_string();
    if album.is_empty() {
        return None;
    }
    let (mut artist, is_va) = parse_mb_artist_credits(release.get("artist-credit"));
    if artist.is_empty() && is_va {
        artist = "Various Artists".to_string();
    }

    let rg = release.get("release-group");
    let original_year = parse_year(rg.and_then(|g| g.get("first-release-date")).and_then(Value::as_str));
    let year = parse_year(release.get("date").and_then(Value::as_str)).or(original_year);

    let genre = release
        .get("genres")
        .and_then(Value::as_array)
        .or_else(|| rg.and_then(|g| g.get("genres")).and_then(Value::as_array))
        .and_then(|arr| arr.first())
        .and_then(|g| g.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let media = release.get("media").and_then(Value::as_array)?;
    let mediums = media.len().max(1) as u32;
    let mut tracks = Vec::new();
    let mut global_idx = 0u32;

    for (m_idx, medium) in media.iter().enumerate() {
        let disc_num = medium
            .get("position")
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .unwrap_or((m_idx + 1) as u32);
        let Some(m_tracks) = medium.get("tracks").and_then(Value::as_array) else {
            continue;
        };
        for (t_idx, trk) in m_tracks.iter().enumerate() {
            let rec = trk.get("recording");
            let is_video = rec
                .and_then(|r| r.get("video"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_video {
                continue;
            }
            let title = trk
                .get("title")
                .and_then(Value::as_str)
                .or_else(|| rec.and_then(|r| r.get("title")).and_then(Value::as_str))
                .unwrap_or("")
                .trim()
                .to_string();
            if title.is_empty() || title == "[data track]" {
                continue;
            }
            let (trk_artist, _) = parse_mb_artist_credits(
                trk.get("artist-credit")
                    .or_else(|| rec.and_then(|r| r.get("artist-credit"))),
            );
            let effective_artist = if trk_artist.is_empty() {
                artist.clone()
            } else {
                trk_artist
            };
            let length_ms = trk
                .get("length")
                .and_then(Value::as_f64)
                .or_else(|| rec.and_then(|r| r.get("length")).and_then(Value::as_f64));
            global_idx += 1;
            let medium_index = trk
                .get("position")
                .and_then(Value::as_u64)
                .map(|n| n as u32)
                .unwrap_or((t_idx + 1) as u32);
            tracks.push(CandidateTrack {
                track_id: rec.and_then(|r| r.get("id")).and_then(Value::as_str).map(str::to_string),
                title,
                artist: effective_artist,
                index: global_idx,
                medium_index,
                medium: disc_num,
                duration_secs: length_ms.map(|ms| ms / 1000.0),
            });
        }
    }

    if tracks.is_empty() {
        return None;
    }

    let has_caa_front = release
        .get("cover-art-archive")
        .and_then(|c| c.get("front"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let artwork_url = has_caa_front.then(|| format!("https://coverartarchive.org/release/{mbid}/front-1200"));

    Some(CandidateAlbum {
        provider: "musicbrainz".to_string(),
        external_release_id: mbid,
        album,
        artist,
        is_va,
        year,
        original_year,
        mediums,
        composer: None,
        genre,
        artwork_url,
        tracks,
    })
}

pub struct MusicBrainzProvider {
    client: Client,
    gates: Arc<GateRegistry>,
}

impl MusicBrainzProvider {
    pub fn new(gates: Arc<GateRegistry>) -> Self {
        Self {
            client: build_http_client(),
            gates,
        }
    }

    async fn hydrate_release(
        &self,
        mbid: &str,
        cancel: &Notify,
    ) -> Result<Option<CandidateAlbum>, ProviderError> {
        let url = format!("https://musicbrainz.org/ws/2/release/{mbid}");
        let query = vec![
            ("fmt", "json".to_string()),
            (
                "inc",
                "artists+media+recordings+release-groups+artist-credits+aliases+genres+tags".to_string(),
            ),
        ];
        match gated_get_json(&self.client, &self.gates, "musicbrainz", &url, &query, cancel).await {
            Ok(v) => Ok(parse_mb_release(&v)),
            Err(ProviderError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

impl MetadataProvider for MusicBrainzProvider {
    fn name(&self) -> &'static str {
        "musicbrainz"
    }

    fn lookup_album<'a>(
        &'a self,
        local: &'a LocalAlbum,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<Vec<CandidateAlbum>, ProviderError>> {
        Box::pin(async move {
            let mut release_ids: Vec<String> = Vec::new();
            let mut seen = HashSet::new();

            // 1. Structured Lucene album/artist search (or recording search if album title missing)
            let lucene = if !is_placeholder_value(&local.title) {
                let rel_q = format!("release:\"{}\"", escape_lucene(local.title.trim()));
                if local.is_compilation || is_va_artist(&local.artist) {
                    format!("{rel_q} AND arid:{VARIOUS_ARTISTS_MBID}")
                } else if !is_placeholder_value(&local.artist) {
                    format!("{rel_q} AND artist:\"{}\"", escape_lucene(local.artist.trim()))
                } else {
                    format!("{rel_q} AND tracks:{}", local.tracks.len())
                }
            } else if let Some(first) = local.tracks.iter().find(|t| !is_placeholder_value(&t.title)) {
                let rec_q = format!("recording:\"{}\"", escape_lucene(first.title.trim()));
                if !is_placeholder_value(&first.artist) {
                    format!("{rec_q} AND artist:\"{}\"", escape_lucene(first.artist.trim()))
                } else {
                    rec_q
                }
            } else {
                return Ok(Vec::new());
            };

            let search_json = gated_get_json(
                &self.client,
                &self.gates,
                "musicbrainz",
                "https://musicbrainz.org/ws/2/release",
                &[
                    ("query", lucene),
                    ("limit", "6".to_string()),
                    ("fmt", "json".to_string()),
                ],
                cancel,
            )
            .await?;

            if let Some(releases) = search_json.get("releases").and_then(Value::as_array) {
                let mut ranked: Vec<(i64, String)> = releases
                    .iter()
                    .filter_map(|r| {
                        let id = r.get("id").and_then(Value::as_str)?.to_string();
                        let trk_cnt = r
                            .get("track-count")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as i64;
                        let score = r.get("score").and_then(Value::as_i64).unwrap_or(0);
                        let count_diff = (trk_cnt - local.tracks.len() as i64).abs();
                        Some((count_diff * 100 - score, id))
                    })
                    .collect();
                ranked.sort_by_key(|(k, _)| *k);
                for (_, id) in ranked.into_iter().take(3) {
                    if seen.insert(id.clone()) {
                        release_ids.push(id);
                    }
                }
            }

            let mut out = Vec::new();
            for mbid in release_ids {
                if let Some(cand) = self.hydrate_release(&mbid, cancel).await? {
                    out.push(cand);
                }
            }
            Ok(out)
        })
    }
}

pub struct AppleMusicProvider {
    client: Client,
    gates: Arc<GateRegistry>,
}

impl AppleMusicProvider {
    pub fn new(gates: Arc<GateRegistry>) -> Self {
        Self {
            client: build_http_client(),
            gates,
        }
    }

    async fn lookup_collection(
        &self,
        collection_id: i64,
        cancel: &Notify,
    ) -> Result<Option<CandidateAlbum>, ProviderError> {
        let json = gated_get_json(
            &self.client,
            &self.gates,
            "apple_music",
            "https://itunes.apple.com/lookup",
            &[
                ("id", collection_id.to_string()),
                ("entity", "song".to_string()),
            ],
            cancel,
        )
        .await?;
        let Some(results) = json.get("results").and_then(Value::as_array) else {
            return Ok(None);
        };
        let collection = results.iter().find(|r| {
            r.get("wrapperType").and_then(Value::as_str) == Some("collection")
        });
        let Some(col) = collection else {
            return Ok(None);
        };

        let album = col
            .get("collectionName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let artist = col
            .get("artistName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if album.is_empty() {
            return Ok(None);
        }
        let year = parse_year(col.get("releaseDate").and_then(Value::as_str));
        let genre = col
            .get("primaryGenreName")
            .and_then(Value::as_str)
            .map(str::to_string);
        let artwork_url = col
            .get("artworkUrl100")
            .and_then(Value::as_str)
            .map(|u| u.replace("100x100bb.jpg", "1200x1200bb.jpg"));
        let is_va = is_va_artist(&artist)
            || col.get("collectionType").and_then(Value::as_str) == Some("Compilation")
                && artist.eq_ignore_ascii_case("Various Artists");

        let mut tracks = Vec::new();
        let mut max_disc = 1u32;
        let mut idx = 0u32;
        for item in results {
            if item.get("wrapperType").and_then(Value::as_str) != Some("track") {
                continue;
            }
            let title = item
                .get("trackName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if title.is_empty() {
                continue;
            }
            idx += 1;
            let trk_artist = item
                .get("artistName")
                .and_then(Value::as_str)
                .unwrap_or(&artist)
                .trim()
                .to_string();
            let disc = item
                .get("discNumber")
                .and_then(Value::as_u64)
                .unwrap_or(1) as u32;
            max_disc = max_disc.max(disc);
            let trk_num = item
                .get("trackNumber")
                .and_then(Value::as_u64)
                .unwrap_or(idx as u64) as u32;
            let dur = item
                .get("trackTimeMillis")
                .and_then(Value::as_f64)
                .map(|ms| ms / 1000.0);
            tracks.push(CandidateTrack {
                track_id: item
                    .get("trackId")
                    .and_then(Value::as_i64)
                    .map(|id| id.to_string()),
                title,
                artist: trk_artist,
                index: idx,
                medium_index: trk_num,
                medium: disc,
                duration_secs: dur,
            });
        }
        if tracks.is_empty() {
            return Ok(None);
        }
        Ok(Some(CandidateAlbum {
            provider: "apple_music".to_string(),
            external_release_id: collection_id.to_string(),
            album,
            artist: if artist.is_empty() {
                "Various Artists".to_string()
            } else {
                artist
            },
            is_va,
            year,
            original_year: year,
            mediums: max_disc,
            composer: None,
            genre,
            artwork_url,
            tracks,
        }))
    }
}

impl MetadataProvider for AppleMusicProvider {
    fn name(&self) -> &'static str {
        "apple_music"
    }

    fn lookup_album<'a>(
        &'a self,
        local: &'a LocalAlbum,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<Vec<CandidateAlbum>, ProviderError>> {
        Box::pin(async move {
            let term = if !is_placeholder_value(&local.title) {
                if !is_placeholder_value(&local.artist) && !is_va_artist(&local.artist) {
                    format!("{} {}", local.title.trim(), local.artist.trim())
                } else {
                    local.title.trim().to_string()
                }
            } else if let Some(first) = local.tracks.iter().find(|t| !is_placeholder_value(&t.title)) {
                if !is_placeholder_value(&first.artist) {
                    format!("{} {}", first.title.trim(), first.artist.trim())
                } else {
                    first.title.trim().to_string()
                }
            } else {
                return Ok(Vec::new());
            };

            let entity = if is_placeholder_value(&local.title) {
                "song"
            } else {
                "album"
            };
            let json = gated_get_json(
                &self.client,
                &self.gates,
                "apple_music",
                "https://itunes.apple.com/search",
                &[
                    ("term", term),
                    ("entity", entity.to_string()),
                    ("limit", "6".to_string()),
                ],
                cancel,
            )
            .await?;

            let mut collection_ids = Vec::new();
            let mut seen = HashSet::new();
            if let Some(results) = json.get("results").and_then(Value::as_array) {
                let mut scored: Vec<(f64, i64)> = results
                    .iter()
                    .filter_map(|r| {
                        let cid = r.get("collectionId").and_then(Value::as_i64)?;
                        let cname = r.get("collectionName").and_then(Value::as_str).unwrap_or("");
                        let trk_cnt = r.get("trackCount").and_then(Value::as_u64).unwrap_or(0) as isize;
                        let count_pen = (trk_cnt - local.tracks.len() as isize).abs() as f64;
                        let name_pen = if is_placeholder_value(&local.title) {
                            0.0
                        } else {
                            string_dist(Some(&local.title), Some(cname))
                        };
                        Some((count_pen * 0.5 + name_pen, cid))
                    })
                    .collect();
                scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                for (_, cid) in scored.into_iter().take(3) {
                    if seen.insert(cid) {
                        collection_ids.push(cid);
                    }
                }
            }

            let mut out = Vec::new();
            for cid in collection_ids {
                if let Some(cand) = self.lookup_collection(cid, cancel).await? {
                    out.push(cand);
                }
            }
            Ok(out)
        })
    }
}

pub struct CompositeArtworkProvider {
    client: Client,
    gates: Arc<GateRegistry>,
    apple: AppleMusicProvider,
}

impl CompositeArtworkProvider {
    pub fn new(gates: Arc<GateRegistry>) -> Self {
        Self {
            client: build_http_client(),
            apple: AppleMusicProvider::new(Arc::clone(&gates)),
            gates,
        }
    }
}

impl ExternalArtworkProvider for CompositeArtworkProvider {
    fn name(&self) -> &'static str {
        "external"
    }

    fn fetch_album_cover<'a>(
        &'a self,
        local: &'a LocalAlbum,
        mb_release_id: Option<&'a str>,
        artwork_url_hint: Option<&'a str>,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String), ProviderError>> {
        Box::pin(async move {
            let mut last_transient: Option<ProviderError> = None;

            if let Some(url) = artwork_url_hint.filter(|u| u.starts_with("https://")) {
                let provider = if url.contains("coverartarchive.org") {
                    "coverartarchive"
                } else {
                    "apple_music"
                };
                match gated_get_bytes(&self.client, &self.gates, provider, url, cancel).await {
                    Ok(bytes) => return Ok((bytes, provider.to_string())),
                    Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
                    Err(ProviderError::NotFound) => {}
                    Err(e) => last_transient = Some(e),
                }
            }

            if let Some(mbid) = mb_release_id {
                let caa_url = format!("https://coverartarchive.org/release/{mbid}/front-1200");
                match gated_get_bytes(&self.client, &self.gates, "coverartarchive", &caa_url, cancel).await {
                    Ok(bytes) => return Ok((bytes, "coverartarchive".to_string())),
                    Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
                    Err(ProviderError::NotFound) => {}
                    Err(e) => last_transient = Some(e),
                }
            }

            if !is_placeholder_value(&local.title) {
                match self.apple.lookup_album(local, cancel).await {
                    Ok(cands) => {
                        for c in cands {
                            let same_album = string_dist(Some(&local.title), Some(&c.album)) <= 0.25;
                            let same_count = c.tracks.len() == local.tracks.len() || local.tracks.is_empty();
                            if same_album && same_count {
                                if let Some(ref art_url) = c.artwork_url {
                                    match gated_get_bytes(&self.client, &self.gates, "apple_music", art_url, cancel).await {
                                        Ok(bytes) => return Ok((bytes, "apple_music".to_string())),
                                        Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
                                        Err(ProviderError::NotFound) => {}
                                        Err(e) => last_transient = Some(e),
                                    }
                                }
                            }
                        }
                    }
                    Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
                    Err(ProviderError::NotFound) => {}
                    Err(e) => last_transient = Some(e),
                }
            }

            Err(last_transient.unwrap_or(ProviderError::NotFound))
        })
    }

    fn fetch_artist_portrait<'a>(
        &'a self,
        artist_name: &'a str,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String), ProviderError>> {
        Box::pin(async move {
            let trimmed = artist_name.trim();
            if trimmed.is_empty() || is_va_artist(trimmed) {
                return Err(ProviderError::NotFound);
            }
            let json = gated_get_json(
                &self.client,
                &self.gates,
                "apple_music",
                "https://itunes.apple.com/search",
                &[
                    ("term", trimmed.to_string()),
                    ("entity", "album".to_string()),
                    ("attribute", "artistTerm".to_string()),
                    ("limit", "3".to_string()),
                ],
                cancel,
            )
            .await?;
            let Some(results) = json.get("results").and_then(Value::as_array) else {
                return Err(ProviderError::NotFound);
            };
            for item in results {
                let candidate_artist = item.get("artistName").and_then(Value::as_str).unwrap_or("");
                if string_dist(Some(trimmed), Some(candidate_artist)) > 0.2 {
                    continue;
                }
                if let Some(url) = item.get("artworkUrl100").and_then(Value::as_str) {
                    let hi = url.replace("100x100bb.jpg", "600x600bb.jpg");
                    match gated_get_bytes(&self.client, &self.gates, "apple_music", &hi, cancel).await {
                        Ok(bytes) => return Ok((bytes, "apple_music".to_string())),
                        Err(ProviderError::Cancelled) => return Err(ProviderError::Cancelled),
                        Err(_) => continue,
                    }
                }
            }
            Err(ProviderError::NotFound)
        })
    }
}
