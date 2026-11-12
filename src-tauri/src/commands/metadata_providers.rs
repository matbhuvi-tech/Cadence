use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::oneshot;

const USER_AGENT: &str = "CadenceMusicAgent/1.0.0 (https://github.com/cadence-audio)";
const APPLE_DEFAULT_RETRY_MS: u64 = 60_000;
const MB_MIN_INTERVAL: Duration = Duration::from_millis(1100);

enum RequestCancellation {
    Running(oneshot::Sender<()>),
    Cancelled(Instant),
}

static PROVIDER_REQUESTS: LazyLock<Mutex<HashMap<String, RequestCancellation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static MB_LAST_REQUEST: LazyLock<tokio::sync::Mutex<Option<Instant>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

static CLIENT_FOLLOW: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .expect("HTTP client")
});

static CLIENT_NO_REDIRECT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client")
});

fn requests() -> std::sync::MutexGuard<'static, HashMap<String, RequestCancellation>> {
    let mut guard = PROVIDER_REQUESTS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.retain(
        |_, entry| !matches!(entry, RequestCancellation::Cancelled(at) if at.elapsed().as_secs() >= 60),
    );
    guard
}

struct RegisteredRequest(String);
impl Drop for RegisteredRequest {
    fn drop(&mut self) {
        requests().remove(&self.0);
    }
}

#[tauri::command]
pub fn cancel_provider_request(request_id: String) {
    let mut guard = requests();
    if let Some(RequestCancellation::Running(sender)) = guard.insert(
        request_id,
        RequestCancellation::Cancelled(Instant::now()),
    ) {
        let _ = sender.send(());
    }
}

async fn run_cancellable<F>(request_id: Option<String>, work: F) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>>,
{
    let Some(request_id) = request_id else {
        return work.await;
    };
    let (sender, receiver) = oneshot::channel();
    {
        use std::collections::hash_map::Entry;
        match requests().entry(request_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(RequestCancellation::Running(sender));
            }
            Entry::Occupied(_) => return Err("Provider request cancelled or already running".into()),
        }
    }
    let _registration = RegisteredRequest(request_id);
    tokio::select! {
        biased;
        _ = receiver => Err("Provider request cancelled".into()),
        result = work => result,
    }
}

fn http_client(bounded: bool) -> &'static reqwest::Client {
    if bounded {
        &CLIENT_NO_REDIRECT
    } else {
        &CLIENT_FOLLOW
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItunesSearchParams {
    pub album: Option<String>,
    pub artist: Option<String>,
    pub composer: Option<String>,
    pub title: Option<String>,
    pub entity: Option<String>,
    pub release_id: Option<String>,
    pub max_requests: Option<usize>,
    pub refresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicBrainzSearchParams {
    pub album: Option<String>,
    pub artist: Option<String>,
    pub composer: Option<String>,
    pub title: Option<String>,
    pub track_num: Option<u32>,
    pub max_requests: Option<usize>,
}

fn strip_delimited(input: &str, open: char, close: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        if ch == open {
            depth += 1;
            out.push(' ');
        } else if ch == close && depth > 0 {
            depth -= 1;
            out.push(' ');
        } else if depth == 0 {
            out.push(ch);
        }
    }
    out
}

fn clean_term(raw: &str, strip_audio_tokens: bool) -> String {
    let mut s = raw.trim().to_string();
    for ext in [
        ".mp3", ".flac", ".wav", ".m4a", ".aac", ".alac", ".dsf", ".dff", ".ogg", ".aiff", ".aif",
        ".wma",
    ] {
        if s.to_ascii_lowercase().ends_with(ext) {
            s.truncate(s.len() - ext.len());
            break;
        }
    }
    // Strip leading track numbers like "01 - " or "01."
    let trimmed = s.trim_start();
    let digit_len = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digit_len > 0 {
        let rest = &trimmed[digit_len..];
        let sep_len = rest
            .bytes()
            .take_while(|b| matches!(b, b' ' | b'.' | b'_' | b'-'))
            .count();
        if sep_len > 0 {
            s = rest[sep_len..].to_string();
        }
    }
    s = strip_delimited(&s, '(', ')');
    s = strip_delimited(&s, '[', ']');

    let words: Vec<&str> = s
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|w| !w.is_empty())
        .collect();
    let mut kept: Vec<String> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        let lower = words[i].to_ascii_lowercase();
        if lower == "cd"
            && words
                .get(i + 1)
                .is_some_and(|next| next.eq_ignore_ascii_case("rip"))
        {
            i += 2;
            continue;
        }
        if lower == "cdrip" {
            i += 1;
            continue;
        }
        if strip_audio_tokens
            && matches!(
                lower.as_str(),
                "flac" | "alac" | "wav" | "mp3" | "dsd" | "dsf" | "hi-res" | "hires"
                    | "remaster" | "remastered"
            )
        {
            i += 1;
            continue;
        }
        kept.push(words[i].to_string());
        i += 1;
    }
    kept.join(" ")
}

fn is_placeholder_artist(value: &str) -> bool {
    let norm: String = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    matches!(
        norm.as_str(),
        "unknown"
            | "unknown artist"
            | "unknown composer"
            | "various"
            | "various artists"
            | "various composers"
            | "untitled"
            | "untagged"
            | "cd rip"
    )
}

fn expand_composer_alias(value: &str) -> String {
    let lower = value.trim().to_ascii_lowercase();
    if lower.starts_with("illayara") || lower.starts_with("ilayara") {
        let rest = &lower[lower.find("ra").unwrap_or(0) + 2..];
        if rest.chars().all(|c| matches!(c, 'a' | 'j' | 'h')) && !rest.is_empty() {
            return "Ilaiyaraaja".to_string();
        }
    }
    value.to_string()
}

fn collapse_double_vowels(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev: Option<char> = None;
    for ch in input.chars() {
        let lower = ch.to_ascii_lowercase();
        let is_vowel = matches!(lower, 'a' | 'e' | 'i' | 'o' | 'u');
        if is_vowel && prev == Some(lower) {
            continue;
        }
        prev = Some(lower);
        out.push(ch);
    }
    out
}

fn phonetic_stem(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev: Option<char> = None;
    for ch in input.chars() {
        let mapped = match ch.to_ascii_lowercase() {
            'y' => 'i',
            'w' => 'v',
            'u' | 'a' | 'e' => 'o',
            c if c.is_ascii_alphanumeric() => c,
            _ => continue,
        };
        if prev == Some(mapped) {
            continue;
        }
        prev = Some(mapped);
        out.push(mapped);
    }
    out
}

fn album_matches(candidate_name: &str, target_album: &str) -> bool {
    if candidate_name.is_empty() || target_album.is_empty() {
        return false;
    }
    let c = candidate_name.to_ascii_lowercase();
    let t = target_album.to_ascii_lowercase();
    if c.contains(&t) || t.contains(&c) {
        return true;
    }
    let stem_c = phonetic_stem(&c);
    let stem_t = phonetic_stem(&t);
    !stem_c.is_empty()
        && !stem_t.is_empty()
        && (stem_c.contains(&stem_t) || stem_t.contains(&stem_c))
}

fn is_regional_version(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "[tamil version]",
        "(tamil version)",
        "[telugu version]",
        "(telugu version)",
        "[kannada version]",
        "(kannada version)",
        "[malayalam version]",
        "(malayalam version)",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn is_single_release(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if let Some(pos) = lower.find("- single") {
        let after = lower[pos + "- single".len()..].chars().next();
        return after.is_none_or(|c| !c.is_ascii_alphanumeric());
    }
    false
}

fn apple_retry_delay(retry_after: Option<&str>) -> Duration {
    let Some(header) = retry_after else {
        return Duration::from_millis(APPLE_DEFAULT_RETRY_MS);
    };
    let trimmed = header.trim();
    if let Ok(seconds) = trimmed.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            let ms = (seconds * 1000.0).round() as u64;
            return Duration::from_millis(ms.max(1000));
        }
    }
    if let Ok(target) = httpdate::parse_http_date(trimmed) {
        let ms = target
            .duration_since(SystemTime::now())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        return Duration::from_millis(ms.max(1000));
    }
    Duration::from_millis(APPLE_DEFAULT_RETRY_MS)
}

async fn apple_fetch(
    url: &str,
    query: &[(&str, &str)],
    timeout: Duration,
    refresh: bool,
    bounded: bool,
) -> Result<reqwest::Response, String> {
    let client = http_client(bounded || refresh);
    loop {
        let mut req = client.get(url).timeout(timeout);
        if !query.is_empty() {
            req = req.query(query);
        }
        let response = req.send().await.map_err(|err| err.to_string())?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if !refresh || (status != 429 && !(status == 503 && retry_after.is_some())) {
            return Ok(response);
        }
        let delay = apple_retry_delay(retry_after.as_deref());
        drop(response);
        tokio::time::sleep(delay).await;
    }
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !item.is_empty() && !list.contains(&item) {
        list.push(item);
    }
}

fn parse_apple_tracks(lookup_data: &Value) -> Vec<Value> {
    lookup_data["results"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item["wrapperType"] == "track")
                .map(|t| {
                    let track_id = t["trackId"]
                        .as_i64()
                        .map(|id| id.to_string())
                        .or_else(|| t["trackId"].as_u64().map(|id| id.to_string()))
                        .or_else(|| t["trackId"].as_str().map(str::to_string));
                    json!({
                        "trackId": track_id,
                        "trackNumber": t["trackNumber"],
                        "trackName": t["trackName"],
                        "artistName": t["artistName"],
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn search_itunes_metadata(
    params: ItunesSearchParams,
    request_id: Option<String>,
) -> Result<Value, String> {
    run_cancellable(request_id, execute_itunes_search(params)).await
}

async fn execute_itunes_search(params: ItunesSearchParams) -> Result<Value, String> {
    let refresh = params.refresh.unwrap_or(false);
    let limit = params.max_requests.unwrap_or(0);
    let bounded = limit > 0;

    if let Some(release_id) = params
        .release_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
    {
        let lookup_url = "https://itunes.apple.com/lookup";
        if let Ok(resp) = apple_fetch(
            lookup_url,
            &[("id", release_id), ("country", "in"), ("entity", "song")],
            Duration::from_secs(6),
            refresh,
            bounded,
        )
        .await
        {
            if resp.status().is_success() {
                if let Ok(evidence) = resp.json::<Value>().await {
                    return Ok(json!({ "status": 200, "body": evidence }));
                }
            }
        }
        return Ok(json!({
            "status": 502,
            "body": { "success": false, "message": "The Apple release lookup did not complete." }
        }));
    }

    let mut clean_artist = clean_term(params.artist.as_deref().unwrap_or(""), true);
    let mut clean_composer = clean_term(params.composer.as_deref().unwrap_or(""), true);
    let clean_title = clean_term(params.title.as_deref().unwrap_or(""), true);
    let clean_album = clean_term(params.album.as_deref().unwrap_or(""), true);

    if is_placeholder_artist(&clean_artist) {
        clean_artist.clear();
    }
    if is_placeholder_artist(&clean_composer) {
        clean_composer.clear();
    }
    clean_artist = expand_composer_alias(&clean_artist);
    clean_composer = expand_composer_alias(&clean_composer);

    let entity = params
        .entity
        .as_deref()
        .filter(|e| !e.is_empty())
        .unwrap_or(if clean_title.is_empty() { "album" } else { "song" });

    let mut album_variants = Vec::new();
    if !clean_album.is_empty() {
        push_unique(&mut album_variants, clean_album.clone());
        let collapsed = collapse_double_vowels(&clean_album);
        push_unique(&mut album_variants, collapsed);
    }

    let mut found_item: Option<Value> = None;

    if entity == "album" || clean_title.is_empty() {
        let mut album_queries = Vec::new();
        for alb in &album_variants {
            if !clean_composer.is_empty() {
                push_unique(&mut album_queries, format!("{alb} {clean_composer}"));
            }
            if !clean_artist.is_empty() && clean_artist != clean_composer {
                push_unique(&mut album_queries, format!("{alb} {clean_artist}"));
            }
        }
        for alb in &album_variants {
            push_unique(&mut album_queries, alb.clone());
        }

        let search_limit = if limit > 0 {
            limit.min(6).saturating_sub(1).max(1)
        } else {
            album_queries.len()
        };

        for q in album_queries.into_iter().take(search_limit) {
            let resp = match apple_fetch(
                "https://itunes.apple.com/search",
                &[
                    ("term", q.as_str()),
                    ("country", "in"),
                    ("entity", "album"),
                    ("limit", "8"),
                ],
                Duration::from_secs(6),
                refresh,
                bounded,
            )
            .await
            {
                Ok(resp) => resp,
                Err(_) => {
                    if refresh {
                        return Ok(json!({
                            "status": 502,
                            "body": { "success": false, "message": "Apple album search did not complete." }
                        }));
                    }
                    continue;
                }
            };

            if refresh && !resp.status().is_success() {
                return Ok(json!({
                    "status": 502,
                    "body": { "success": false, "message": "Apple album search failed." }
                }));
            }

            if resp.status().is_success() {
                if let Ok(data) = resp.json::<Value>().await {
                    if let Some(results) = data["results"].as_array().filter(|r| !r.is_empty()) {
                        let matched = results
                            .iter()
                            .find(|r| {
                                let name = r["collectionName"].as_str().unwrap_or("");
                                album_matches(name, &clean_album)
                                    && !is_single_release(name)
                                    && !is_regional_version(name)
                            })
                            .or_else(|| {
                                results.iter().find(|r| {
                                    let name = r["collectionName"].as_str().unwrap_or("");
                                    album_matches(name, &clean_album) && !is_single_release(name)
                                })
                            })
                            .or_else(|| {
                                results.iter().find(|r| {
                                    let name = r["collectionName"].as_str().unwrap_or("");
                                    album_matches(name, &clean_album)
                                })
                            });
                        if let Some(m) = matched {
                            found_item = Some(json!({
                                "artistName": m["artistName"],
                                "trackName": m["collectionName"],
                                "collectionName": m["collectionName"],
                                "releaseDate": m["releaseDate"],
                                "primaryGenreName": m["primaryGenreName"],
                                "artworkUrl100": m["artworkUrl100"],
                                "copyright": m["copyright"],
                                "collectionId": m["collectionId"],
                            }));
                            break;
                        }
                    }
                }
            }
        }
    }

    if found_item.is_none() && limit == 0 {
        let mut song_queries = Vec::new();
        if !clean_composer.is_empty() && !clean_title.is_empty() {
            push_unique(&mut song_queries, format!("{clean_composer} {clean_title}"));
        }
        if !clean_artist.is_empty() && !clean_title.is_empty() {
            push_unique(&mut song_queries, format!("{clean_artist} {clean_title}"));
        }
        if !clean_composer.is_empty() && !clean_album.is_empty() {
            push_unique(&mut song_queries, format!("{clean_composer} {clean_album}"));
        }
        if !clean_artist.is_empty() && !clean_album.is_empty() {
            push_unique(&mut song_queries, format!("{clean_artist} {clean_album}"));
        }
        if !clean_title.is_empty() {
            push_unique(&mut song_queries, clean_title.clone());
        }
        if !clean_album.is_empty() {
            push_unique(&mut song_queries, clean_album.clone());
        }
        for q in song_queries {
            if let Ok(resp) = apple_fetch(
                "https://itunes.apple.com/search",
                &[("term", q.as_str()), ("entity", "song"), ("limit", "5")],
                Duration::from_secs(6),
                refresh,
                bounded,
            )
            .await
            {
                if resp.status().is_success() {
                    if let Ok(data) = resp.json::<Value>().await {
                        if let Some(first) = data["results"].as_array().and_then(|r| r.first()) {
                            found_item = Some(first.clone());
                            break;
                        }
                    }
                }
            }
        }
    }

    if found_item.is_none() && !clean_album.is_empty() && limit == 0 {
        let target_artist: String = if !clean_composer.is_empty() {
            clean_composer.as_str()
        } else {
            clean_artist.as_str()
        }
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();

        for alb in &album_variants {
            if let Ok(resp) = apple_fetch(
                "https://itunes.apple.com/search",
                &[("term", alb.as_str()), ("entity", "album"), ("limit", "5")],
                Duration::from_secs(6),
                refresh,
                bounded,
            )
            .await
            {
                if resp.status().is_success() {
                    if let Ok(data) = resp.json::<Value>().await {
                        if let Some(results) = data["results"].as_array().filter(|r| !r.is_empty()) {
                            let matched = if target_artist.is_empty() {
                                results.first()
                            } else {
                                results.iter().find(|r| {
                                    let cand: String = r["artistName"]
                                        .as_str()
                                        .unwrap_or("")
                                        .chars()
                                        .filter(|c| c.is_ascii_alphanumeric())
                                        .map(|c| c.to_ascii_lowercase())
                                        .collect();
                                    cand.contains(&target_artist) || target_artist.contains(&cand)
                                })
                            };
                            if let Some(m) = matched {
                                found_item = Some(json!({
                                    "artistName": m["artistName"],
                                    "trackName": if clean_title.is_empty() {
                                        m["collectionName"].as_str().unwrap_or("")
                                    } else {
                                        clean_title.as_str()
                                    },
                                    "collectionName": m["collectionName"],
                                    "releaseDate": m["releaseDate"],
                                    "primaryGenreName": m["primaryGenreName"],
                                    "artworkUrl100": m["artworkUrl100"],
                                    "copyright": m["copyright"],
                                    "collectionId": m["collectionId"],
                                }));
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let Some(found) = found_item else {
        return Ok(json!({
            "status": 404,
            "body": { "success": false, "message": "No iTunes match found" }
        }));
    };

    let collection_id = found["collectionId"]
        .as_i64()
        .map(|id| id.to_string())
        .or_else(|| found["collectionId"].as_u64().map(|id| id.to_string()))
        .or_else(|| found["collectionId"].as_str().map(str::to_string));

    let mut provider_tracks = Vec::new();
    if let Some(cid) = collection_id.as_deref() {
        if let Ok(resp) = apple_fetch(
            "https://itunes.apple.com/lookup",
            &[("id", cid), ("country", "in"), ("entity", "song")],
            Duration::from_secs(4),
            refresh,
            bounded,
        )
        .await
        {
            if resp.status().is_success() {
                if let Ok(lookup_data) = resp.json::<Value>().await {
                    provider_tracks = parse_apple_tracks(&lookup_data);
                }
            }
        }
    }

    if refresh && provider_tracks.is_empty() {
        return Ok(json!({
            "status": 502,
            "body": {
                "success": false,
                "message": "Apple matched the release, but the track lookup did not return songs."
            }
        }));
    }

    let track_id = found["trackId"]
        .as_i64()
        .map(|id| id.to_string())
        .or_else(|| found["trackId"].as_u64().map(|id| id.to_string()));
    let resolved_id = collection_id.or(track_id).unwrap_or_default();
    let high_res_art = found["artworkUrl100"]
        .as_str()
        .map(|u| u.replace("100x100bb.jpg", "3000x3000bb.jpg"))
        .unwrap_or_default();
    let release_year = found["releaseDate"]
        .as_str()
        .and_then(|d| d.get(..4))
        .and_then(|y| y.parse::<i32>().ok());
    let release_title = found["collectionName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(&clean_album);
    let artist_credit = found["artistName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(&clean_artist);

    Ok(json!({
        "status": 200,
        "body": {
            "success": true,
            "provider": "itunes",
            "releaseId": resolved_id,
            "confidenceScore": 0.95,
            "releaseTitle": release_title,
            "artistCredit": artist_credit,
            "composer": artist_credit,
            "trackTitle": found["trackName"].as_str().unwrap_or(&clean_title),
            "releaseYear": release_year,
            "genre": found["primaryGenreName"].as_str().unwrap_or("Soundtrack"),
            "label": found["copyright"].as_str().unwrap_or("Apple Music Catalog"),
            "catalogNumber": format!("ITUNES-{}", if resolved_id.is_empty() { "MSTR" } else { &resolved_id }),
            "barcodeUpc": "",
            "coverArtUrl": high_res_art,
            "coverResolution": "3000x3000px (Apple Music Master Scan)",
            "tracks": provider_tracks,
        }
    }))
}

async fn mb_fetch(
    url: &str,
    query: &[(&str, &str)],
    bounded: bool,
    remaining: &mut usize,
) -> Result<reqwest::Response, String> {
    if *remaining == 0 {
        return Err("MusicBrainz request budget exhausted".into());
    }
    *remaining -= 1;

    {
        let mut last = MB_LAST_REQUEST.lock().await;
        if let Some(prev) = *last {
            let elapsed = prev.elapsed();
            if elapsed < MB_MIN_INTERVAL {
                tokio::time::sleep(MB_MIN_INTERVAL - elapsed).await;
            }
        }
        *last = Some(Instant::now());
    }

    let mut req = http_client(bounded)
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(Duration::from_secs(7));
    if !query.is_empty() {
        req = req.query(query);
    }
    req.send().await.map_err(|err| err.to_string())
}

fn join_artist_credits(credits: &Value) -> String {
    credits
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["name"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn is_generic_album_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "music" | "audio" | "songs" | "flac" | "wav" | "mp3" | "master" | "local"
    )
}

#[tauri::command]
pub async fn search_musicbrainz_metadata(
    params: MusicBrainzSearchParams,
    request_id: Option<String>,
) -> Result<Value, String> {
    run_cancellable(request_id, execute_musicbrainz_search(params)).await
}

async fn execute_musicbrainz_search(params: MusicBrainzSearchParams) -> Result<Value, String> {
    let limit = params.max_requests.unwrap_or(0);
    let bounded = limit > 0;
    let mut remaining = if limit > 0 { limit.min(6) } else { usize::MAX };

    let mut clean_artist = clean_term(params.artist.as_deref().unwrap_or(""), false);
    let mut clean_composer = clean_term(params.composer.as_deref().unwrap_or(""), false);
    let clean_title = clean_term(params.title.as_deref().unwrap_or(""), false);
    let clean_album = clean_term(params.album.as_deref().unwrap_or(""), false);
    let track_num = params.track_num.unwrap_or(0);

    if is_placeholder_artist(&clean_artist) {
        clean_artist.clear();
    }
    clean_artist = expand_composer_alias(&clean_artist);
    clean_composer = expand_composer_alias(&clean_composer);

    let mut had_upstream_error = false;
    let mut seen_queries: HashSet<String> = HashSet::new();

    if !clean_album.is_empty() && !is_generic_album_name(&clean_album) {
        let target_artist = if !clean_composer.is_empty() {
            clean_composer.as_str()
        } else {
            clean_artist.as_str()
        };
        let artist_clause = if !target_artist.is_empty() {
            let first = target_artist.split_whitespace().next().unwrap_or(target_artist);
            format!(
                " AND (artist:\"{target_artist}\" OR creditname:\"{target_artist}\" OR artist:{first})"
            )
        } else {
            String::new()
        };
        let fuzzy_words = clean_album
            .split_whitespace()
            .map(|w| if w.len() >= 4 { format!("{w}~1") } else { w.to_string() })
            .collect::<Vec<_>>()
            .join(" ");

        let mut release_queries = Vec::new();
        if !target_artist.is_empty() {
            release_queries.push(format!("release:\"{clean_album}\"{artist_clause}"));
            release_queries.push(format!("release:({fuzzy_words}){artist_clause}"));
            release_queries.push(format!("release:({clean_album}){artist_clause}"));
        }
        release_queries.push(format!("release:\"{clean_album}\""));
        release_queries.push(format!("release:({fuzzy_words})"));
        release_queries.push(format!("release:({clean_album})"));

        for rq in release_queries {
            if remaining == 0 {
                break;
            }
            if !seen_queries.insert(rq.clone()) {
                continue;
            }
            let resp = match mb_fetch(
                "https://musicbrainz.org/ws/2/release",
                &[("query", rq.as_str()), ("fmt", "json"), ("limit", "5")],
                bounded,
                &mut remaining,
            )
            .await
            {
                Ok(resp) => resp,
                Err(_) => {
                    had_upstream_error = true;
                    continue;
                }
            };
            if !resp.status().is_success() {
                if resp.status().as_u16() >= 500 || resp.status().as_u16() == 429 {
                    had_upstream_error = true;
                }
                continue;
            }
            let Ok(rel_data) = resp.json::<Value>().await else {
                had_upstream_error = true;
                continue;
            };
            let matching_releases: Vec<&Value> = rel_data["releases"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter(|r| {
                            album_matches(r["title"].as_str().unwrap_or(""), &clean_album)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let top_rel = matching_releases
                .iter()
                .copied()
                .find(|r| r["cover-art-archive"]["front"] == true)
                .or_else(|| {
                    matching_releases
                        .iter()
                        .copied()
                        .find(|r| r["score"].as_i64().unwrap_or(0) >= 80)
                })
                .or_else(|| matching_releases.first().copied());

            let Some(top) = top_rel else { continue };
            let Some(rel_id) = top["id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            if remaining == 0 {
                break;
            }
            let detail_url = format!("https://musicbrainz.org/ws/2/release/{rel_id}");
            let detail_resp = match mb_fetch(
                &detail_url,
                &[
                    ("inc", "recordings+artist-credits+labels+media"),
                    ("fmt", "json"),
                ],
                bounded,
                &mut remaining,
            )
            .await
            {
                Ok(resp) => resp,
                Err(_) => {
                    had_upstream_error = true;
                    continue;
                }
            };
            if !detail_resp.status().is_success() {
                if detail_resp.status().as_u16() >= 500 || detail_resp.status().as_u16() == 429 {
                    had_upstream_error = true;
                }
                continue;
            }
            let Ok(detail) = detail_resp.json::<Value>().await else {
                had_upstream_error = true;
                continue;
            };

            let tracks = detail["media"][0]["tracks"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let matched_track = if track_num > 0 {
                tracks
                    .iter()
                    .find(|t| {
                        t["position"]
                            .as_u64()
                            .or_else(|| t["position"].as_str().and_then(|s| s.parse().ok()))
                            == Some(u64::from(track_num))
                    })
                    .or_else(|| tracks.first())
            } else if !clean_title.is_empty() {
                let norm = clean_title.to_ascii_lowercase();
                tracks
                    .iter()
                    .find(|t| {
                        let title = t["title"].as_str().unwrap_or("").to_ascii_lowercase();
                        title.contains(&norm) || norm.contains(&title)
                    })
                    .or_else(|| tracks.first())
            } else {
                tracks.first()
            };

            let release_artist = {
                let joined = join_artist_credits(&detail["artist-credit"]);
                if joined.is_empty() {
                    clean_artist.clone()
                } else {
                    joined
                }
            };
            let track_artist = matched_track
                .map(|t| join_artist_credits(&t["artist-credit"]))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| release_artist.clone());
            let release_year = detail["date"]
                .as_str()
                .and_then(|d| d.get(..4))
                .and_then(|y| y.parse::<i32>().ok());
            let mb_tracks: Vec<Value> = tracks
                .iter()
                .map(|t| {
                    let pos = t["position"]
                        .as_u64()
                        .or_else(|| t["position"].as_str().and_then(|s| s.parse().ok()));
                    let artist = {
                        let joined = join_artist_credits(&t["artist-credit"]);
                        if joined.is_empty() {
                            release_artist.clone()
                        } else {
                            joined
                        }
                    };
                    json!({
                        "trackId": t["id"],
                        "trackNumber": pos,
                        "trackName": t["title"],
                        "artistName": artist,
                    })
                })
                .collect();
            let catalog_number = detail["catalog-number"]
                .as_str()
                .or_else(|| detail["label-info"][0]["catalog-number"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("MB-{}", rel_id.chars().take(8).collect::<String>().to_uppercase()));
            let score = top["score"].as_i64().unwrap_or(0);
            return Ok(json!({
                "status": 200,
                "body": {
                    "success": true,
                    "provider": "musicbrainz",
                    "releaseId": rel_id,
                    "confidenceScore": if score >= 90 { 0.95 } else { 0.85 },
                    "releaseTitle": detail["title"].as_str().or_else(|| top["title"].as_str()).unwrap_or(&clean_album),
                    "artistCredit": track_artist,
                    "composer": if release_artist.is_empty() { track_artist.clone() } else { release_artist },
                    "trackTitle": matched_track.and_then(|t| t["title"].as_str()).unwrap_or(&clean_title),
                    "releaseYear": release_year,
                    "label": detail["label-info"][0]["label"]["name"].as_str().unwrap_or("MusicBrainz Verified"),
                    "catalogNumber": catalog_number,
                    "barcodeUpc": detail["barcode"].as_str().unwrap_or(""),
                    "coverArtUrl": format!("https://coverartarchive.org/release/{rel_id}/front-500"),
                    "coverResolution": "Archival 1000px (Cover Art Archive)",
                    "tracks": mb_tracks,
                }
            }));
        }
    }

    if !clean_title.is_empty() && remaining > 0 {
        let mut rec_queries = Vec::new();
        if !clean_artist.is_empty() {
            rec_queries.push(format!(
                "recording:\"{clean_title}\" AND artist:\"{clean_artist}\""
            ));
        }
        if !clean_album.is_empty() {
            rec_queries.push(format!(
                "recording:\"{clean_title}\" AND release:\"{clean_album}\""
            ));
        }
        rec_queries.push(format!("recording:\"{clean_title}\""));

        for rq in rec_queries {
            if remaining == 0 {
                break;
            }
            let resp = match mb_fetch(
                "https://musicbrainz.org/ws/2/recording",
                &[("query", rq.as_str()), ("fmt", "json"), ("limit", "5")],
                bounded,
                &mut remaining,
            )
            .await
            {
                Ok(resp) => resp,
                Err(_) => {
                    had_upstream_error = true;
                    continue;
                }
            };
            if !resp.status().is_success() {
                if resp.status().as_u16() >= 500 || resp.status().as_u16() == 429 {
                    had_upstream_error = true;
                }
                continue;
            }
            let Ok(rec_data) = resp.json::<Value>().await else {
                had_upstream_error = true;
                continue;
            };
            let Some(top_rec) = rec_data["recordings"]
                .as_array()
                .and_then(|arr| arr.iter().find(|r| r["score"].as_i64().unwrap_or(0) >= 75))
            else {
                continue;
            };
            let primary_release = &top_rec["releases"][0];
            let rec_artist = {
                let joined = join_artist_credits(&top_rec["artist-credit"]);
                if joined.is_empty() {
                    clean_artist.clone()
                } else {
                    joined
                }
            };
            let release_id = primary_release["id"].as_str();
            let year = top_rec["first-release-date"]
                .as_str()
                .or_else(|| primary_release["date"].as_str())
                .and_then(|d| d.get(..4))
                .and_then(|y| y.parse::<i32>().ok());
            let catalog_number = primary_release["catalog-number"]
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    release_id.map(|id| {
                        format!("MB-{}", id.chars().take(8).collect::<String>().to_uppercase())
                    })
                })
                .unwrap_or_default();
            let score = top_rec["score"].as_i64().unwrap_or(0);
            return Ok(json!({
                "status": 200,
                "body": {
                    "success": true,
                    "provider": "musicbrainz",
                    "confidenceScore": if score >= 90 { 0.92 } else { 0.8 },
                    "releaseTitle": primary_release["title"].as_str().unwrap_or(&clean_album),
                    "artistCredit": rec_artist,
                    "composer": rec_artist,
                    "trackTitle": top_rec["title"].as_str().unwrap_or(&clean_title),
                    "releaseYear": year,
                    "label": primary_release["label-info"][0]["label"]["name"].as_str().unwrap_or("MusicBrainz Verified"),
                    "catalogNumber": catalog_number,
                    "barcodeUpc": primary_release["barcode"].as_str().unwrap_or(""),
                    "coverArtUrl": release_id.map(|id| format!("https://coverartarchive.org/release/{id}/front-500")).unwrap_or_default(),
                    "coverResolution": "Archival Front (Cover Art Archive)",
                }
            }));
        }
    }

    if had_upstream_error {
        return Ok(json!({
            "status": 502,
            "body": { "success": false, "message": "MusicBrainz lookup did not complete." }
        }));
    }

    Ok(json!({
        "status": 404,
        "body": { "success": false, "message": "No confident MusicBrainz archival match found" }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_terms_and_expands_composer_aliases() {
        assert_eq!(clean_term("01 - Amaran (CD Rip) [FLAC].flac", true), "Amaran");
        assert_eq!(expand_composer_alias("Illayaraja"), "Ilaiyaraaja");
        assert_eq!(expand_composer_alias("ilayaraajah"), "Ilaiyaraaja");
        assert!(is_placeholder_artist("Unknown Artist"));
    }

    #[test]
    fn matches_phonetic_album_titles_and_filters_singles() {
        assert!(album_matches("Amaran (Original Motion Picture Soundtrack)", "Amaran"));
        assert!(album_matches("En Bommukutty Ammavukku", "En Bommukutti Amavuku"));
        assert!(is_single_release("Amaran - Single"));
        assert!(!is_single_release("Amaran (Original Soundtrack)"));
        assert!(is_regional_version("Amaran [Tamil Version]"));
    }

    #[test]
    fn parses_retry_after_and_apple_tracks() {
        assert_eq!(apple_retry_delay(Some("2")), Duration::from_millis(2000));
        assert_eq!(apple_retry_delay(Some("0")), Duration::from_millis(1000));
        assert_eq!(apple_retry_delay(None), Duration::from_millis(APPLE_DEFAULT_RETRY_MS));
        let tracks = parse_apple_tracks(&json!({
            "results": [
                { "wrapperType": "collection", "collectionId": 123 },
                { "wrapperType": "track", "trackId": 456, "trackNumber": 1, "trackName": "Abhayam Krishna", "artistName": "Adithan" }
            ]
        }));
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0]["trackId"], "456");
        assert_eq!(tracks[0]["trackName"], "Abhayam Krishna");
    }
}

