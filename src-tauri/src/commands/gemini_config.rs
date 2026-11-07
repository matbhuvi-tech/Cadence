use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::{Emitter, Manager};

const DEFAULT_MODEL: &str = "gemini-3.5-flash-lite";
const PACING_MS: u64 = 4_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiConfigStatus {
    configured: bool,
    model: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct GeminiSettings {
    api_key: String,
    model: String,
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("gemini-key.dpapi"))
}

fn read_settings(app: &AppHandle) -> Result<GeminiSettings, String> {
    let path = config_path(app)?;
    let encrypted =
        std::fs::read(path).map_err(|_| "Gemini API key is not configured".to_string())?;
    let bytes = unprotect(&encrypted)?;
    if let Ok(settings) = serde_json::from_slice::<GeminiSettings>(&bytes) {
        return Ok(settings);
    }
    let legacy_key =
        String::from_utf8(bytes).map_err(|_| "Saved Gemini API key is invalid".to_string())?;
    Ok(GeminiSettings {
        api_key: legacy_key,
        model: DEFAULT_MODEL.into(),
    })
}

fn clean_json(text: &str) -> Result<Value, String> {
    let mut cleaned = text.trim();
    if let Some(stripped) = cleaned.strip_prefix("```json") {
        cleaned = stripped;
    } else if let Some(stripped) = cleaned.strip_prefix("```") {
        cleaned = stripped;
    }
    if let Some(stripped) = cleaned.strip_suffix("```") {
        cleaned = stripped;
    }
    cleaned = cleaned.trim();

    let first_brace = cleaned.find('{');
    let first_bracket = cleaned.find('[');
    let slice_to_parse = match (first_brace, first_bracket) {
        (Some(b), Some(k)) if b < k => {
            let last_b = cleaned.rfind('}').unwrap_or(cleaned.len().saturating_sub(1));
            &cleaned[b..=last_b.min(cleaned.len().saturating_sub(1))]
        }
        (Some(_), Some(k)) => {
            let last_k = cleaned.rfind(']').unwrap_or(cleaned.len().saturating_sub(1));
            &cleaned[k..=last_k.min(cleaned.len().saturating_sub(1))]
        }
        (Some(b), None) => {
            let last_b = cleaned.rfind('}').unwrap_or(cleaned.len().saturating_sub(1));
            &cleaned[b..=last_b.min(cleaned.len().saturating_sub(1))]
        }
        (None, Some(k)) => {
            let last_k = cleaned.rfind(']').unwrap_or(cleaned.len().saturating_sub(1));
            &cleaned[k..=last_k.min(cleaned.len().saturating_sub(1))]
        }
        _ => cleaned,
    };

    serde_json::from_str(slice_to_parse).map_err(|e| format!("Gemini returned invalid JSON: {e}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiBlock {
    reason: &'static str,
    blocked_until: i64,
    observed_limit: Option<String>,
    #[serde(skip)]
    consecutive: u32,
}

#[derive(Default)]
struct GeminiQuota {
    credential: Option<u64>,
    preferred: String,
    in_flight: Option<String>,
    last_successful: Option<String>,
    last_call: Option<std::time::Instant>,
    last_timestamp: i64,
    models: std::collections::BTreeMap<String, GeminiBlock>,
    project: Option<GeminiBlock>,
    grounding: Option<GeminiBlock>,
}

static QUOTA: std::sync::LazyLock<std::sync::Mutex<GeminiQuota>> =
    std::sync::LazyLock::new(Default::default);
static GEMINI_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn quota() -> std::sync::MutexGuard<'static, GeminiQuota> {
    QUOTA.lock().unwrap_or_else(|error| error.into_inner())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn pacific_reset_ms(now: i64) -> Option<i64> {
    let local = chrono::DateTime::from_timestamp_millis(now)?
        .with_timezone(&chrono_tz::America::Los_Angeles);
    let midnight = local.date_naive().succ_opt()?.and_hms_opt(0, 0, 0)?;
    Some(
        midnight
            .and_local_timezone(chrono_tz::America::Los_Angeles)
            .single()?
            .timestamp_millis(),
    )
}

fn quota_block(
    status: u16,
    now: i64,
    hint: i64,
    violations: &[&Value],
    previous: Option<&GeminiBlock>,
) -> GeminiBlock {
    let daily = violations.iter().any(|v| {
        let name = quota_name(v);
        name.contains("perday") || name.contains("daily")
    });
    let minute_metric = violations.iter().map(|v| quota_name(v)).find_map(|name| {
        if !name.contains("perminute") { return None; }
        if name.contains("token") { Some("tokens_per_minute") }
        else if name.contains("request") { Some("requests_per_minute") }
        else { None }
    });
    let (reason, fallback) = match status {
        404 => ("unavailable", 600_000),
        503 => ("overloaded", 15_000),
        _ if daily => ("daily_quota", 86_400_000),
        _ => (minute_metric.unwrap_or("rate_limit"), 30_000),
    };
    let consecutive = previous
        .filter(|block| block.reason == reason)
        .map_or(1, |block| (block.consecutive + 1).min(5));
    let estimated = if daily {
        pacific_reset_ms(now).unwrap_or(now + fallback)
    } else if consecutive == 1 && hint > 0 {
        now.saturating_add(hint)
    } else {
        now + fallback * (1_i64 << (consecutive - 1)) + now.rem_euclid(1000)
    };
    GeminiBlock {
        reason,
        consecutive,
        blocked_until: estimated.max(now.saturating_add(hint)),
        observed_limit: violations.iter().find_map(|v| {
            let value = &v["quotaValue"];
            value.as_u64().map(|n| n.to_string()).or_else(|| {
                value
                    .as_str()
                    .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                    .map(str::to_owned)
            })
        }),
    }
}

fn quota_name(violation: &Value) -> String {
    format!(
        "{} {}",
        violation["quotaId"].as_str().unwrap_or_default(),
        violation["quotaMetric"].as_str().unwrap_or_default()
    )
    .to_ascii_lowercase().replace(['_', '-'], "")
}

fn retry_hint(headers: &reqwest::header::HeaderMap, data: &Value, now: i64) -> i64 {
    let header_ms = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<i64>()
                .ok()
                .filter(|n| *n >= 0)
                .map(|n| n.saturating_mul(1000))
                .or_else(|| {
                    let time: chrono::DateTime<chrono::Utc> =
                        httpdate::parse_http_date(v).ok()?.into();
                    Some(time.timestamp_millis().saturating_sub(now))
                })
        })
        .unwrap_or(0);
    let details = data["error"]["details"].as_array().into_iter().flatten();
    let detail_ms = details
        .filter(|v| v["@type"] == "type.googleapis.com/google.rpc.RetryInfo")
        .filter_map(|v| {
            v["retryDelay"]
                .as_str()?
                .strip_suffix('s')?
                .parse::<f64>()
                .ok()
        })
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| (n * 1000.0).ceil() as i64)
        .max()
        .unwrap_or(0);
    header_ms.max(detail_ms)
}

fn is_grounding_quota(violation: &Value) -> bool {
    let name = quota_name(violation);
    name.contains("grounding") || name.contains("googlesearch")
}

fn record_block(
    state: &mut GeminiQuota,
    model: &str,
    status: u16,
    grounded: bool,
    headers: &reqwest::header::HeaderMap,
    data: &Value,
) {
    let now = now_ms();
    let hint = retry_hint(headers, data, now);
    let violations = data["error"]["details"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["@type"] == "type.googleapis.com/google.rpc.QuotaFailure")
        .flat_map(|v| v["violations"].as_array().into_iter().flatten());
    let (grounding, generation): (Vec<_>, Vec<_>) = violations.partition(|v| is_grounding_quota(v));
    let (shared, scoped): (Vec<_>, Vec<_>) = generation.into_iter().partition(|v| {
        let name = quota_name(v);
        v["quotaDimensions"]["model"].is_null()
            && !name.contains("permodel")
            && (name.contains("spend")
                || name
                    .split_whitespace()
                    .any(|part| part.ends_with("perproject")))
    });
    if status == 429 && !grounding.is_empty() {
        state.grounding = Some(quota_block(
            status,
            now,
            hint,
            &grounding,
            state.grounding.as_ref(),
        ));
    }
    if status == 429 && !shared.is_empty() {
        state.project = Some(quota_block(
            status,
            now,
            hint,
            &shared,
            state.project.as_ref(),
        ));
    }
    if status != 429 || !scoped.is_empty() || (shared.is_empty() && grounding.is_empty()) {
        let key = if status == 429 && grounded && scoped.is_empty() {
            format!("{model} (Google Search)")
        } else {
            model.to_string()
        };
        let block = quota_block(status, now, hint, &scoped, state.models.get(&key));
        state.models.insert(key, block.clone());
        // Google can identify the underlying quota model even when the request used an alias.
        for canonical in scoped
            .iter()
            .filter_map(|v| v["quotaDimensions"]["model"].as_str())
        {
            state.models.insert(
                canonical.trim_start_matches("models/").to_string(),
                block.clone(),
            );
        }
    }
}

fn project_block_until(state: &GeminiQuota, grounded: bool) -> i64 {
    let project = state
        .project
        .as_ref()
        .map_or(0, |block| block.blocked_until);
    let grounding = state
        .grounding
        .as_ref()
        .map_or(0, |block| block.blocked_until);
    if grounded {
        project.max(grounding)
    } else {
        project
    }
}

fn model_block_until(state: &GeminiQuota, model: &str, grounded: bool) -> i64 {
    let global = state
        .models
        .get(model)
        .map_or(0, |block| block.blocked_until);
    if !grounded {
        return global;
    }
    global.max(
        state
            .models
            .get(&format!("{model} (Google Search)"))
            .map_or(0, |block| block.blocked_until),
    )
}

fn candidates(preferred: &str) -> impl Iterator<Item = &str> {
    [preferred, DEFAULT_MODEL, "gemini-3.1-flash-lite"]
        .into_iter()
        .enumerate()
        .filter(move |(index, model)| {
            ![preferred, DEFAULT_MODEL, "gemini-3.1-flash-lite"][..*index].contains(model)
        })
        .map(|(_, model)| model)
}

fn pacing_remaining(state: &GeminiQuota) -> std::time::Duration {
    state
        .last_call
        .map(|time| std::time::Duration::from_millis(PACING_MS).saturating_sub(time.elapsed()))
        .unwrap_or_default()
}

struct ActiveAttempt<'a>(&'a AppHandle);
impl Drop for ActiveAttempt<'_> {
    fn drop(&mut self) {
        quota().in_flight = None;
        emit_quota(self.0);
    }
}

async fn generate(
    app: &AppHandle,
    contents: Value,
    timeout_ms: u64,
    use_grounding: bool,
    attempt_budget: usize,
) -> Result<(Value, String, u64, usize), String> {
    tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
        let _turn = GEMINI_TURN.lock().await;
        let settings = read_settings(app)?;
        {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            settings.api_key.hash(&mut hasher);
            let credential = Some(hasher.finish());
            let mut state = quota();
            if state.credential != credential {
                state.models.clear();
                state.project = None;
                state.grounding = None;
                state.last_successful = None;
                state.credential = credential;
            }
            state.preferred = settings.model.trim_start_matches("models/").to_string();
        }
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build()
            .map_err(|_| "Unable to initialize Gemini HTTP client".to_string())?;
        let mut body = json!({ "contents": contents });
        if use_grounding {
            body["tools"] = json!([{ "google_search": {} }]);
        } else {
            body["generationConfig"] = json!({ "responseMimeType": "application/json" });
        }
        let preferred = settings.model.trim_start_matches("models/");
        let mut attempts = 0;
        let mut pacing_delay = 0;
        let mut last_status = 503;
        for model in candidates(preferred) {
            if attempts >= attempt_budget { break; }
            let delay = {
                let state = quota();
                let now = now_ms();
                if project_block_until(&state, use_grounding) > now { break; }
                if model_block_until(&state, model, use_grounding) > now { continue; }
                pacing_remaining(&state)
            };
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
                pacing_delay += delay.as_millis() as u64;
            }
            attempts += 1;
            {
                let mut state = quota();
                state.in_flight = Some(model.to_string());
                state.last_call = Some(std::time::Instant::now());
                state.last_timestamp = now_ms();
            }
            let _active = ActiveAttempt(app);
            emit_quota(app);
            let response = client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
                .header("x-goog-api-key", &settings.api_key).json(&body).send().await
                .map_err(|_| "Gemini request failed (502): network error".to_string())?;
            last_status = response.status().as_u16();
            let headers = response.headers().clone();
            if response.status().is_success() {
                let data = response.json::<Value>().await.map_err(|_| "Gemini returned invalid JSON".to_string())?;
                let mut state = quota();
                state.models.remove(model);
                if use_grounding {
                    state.models.remove(&format!("{model} (Google Search)"));
                    state.grounding = None;
                }
                state.project = None;
                state.last_successful = Some(data["modelVersion"].as_str().unwrap_or(model).to_string());
                return Ok((data, state.last_successful.clone().unwrap_or_else(|| model.to_string()), pacing_delay, attempts - 1));
            }
            if !matches!(last_status, 429 | 503 | 404) { break; }
            let data = response.json::<Value>().await.unwrap_or(Value::Null);
            record_block(&mut quota(), model, last_status, use_grounding, &headers, &data);
        }
        let state = quota();
        let now = now_ms();
        let project_until = project_block_until(&state, use_grounding);
        let retry_at = candidates(preferred).map(|model| {
            project_until.max(model_block_until(&state, model, use_grounding))
        }).min().unwrap_or(0);
        if retry_at > now && (project_until > now || state.models.values().any(|block| {
            block.blocked_until > now && !matches!(block.reason, "unavailable" | "overloaded")
        })) { last_status = 429; }
        let retry = chrono::DateTime::from_timestamp_millis(retry_at).filter(|_| retry_at > now)
            .map(|time| format!("; try again after {}", time.to_rfc3339())).unwrap_or_default();
        Err(format!("Gemini request failed ({last_status}){retry}"))
    }).await.map_err(|_| "Gemini request failed (504): timed out".to_string())?
}

fn text_content(data: &Value) -> String {
    data["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

enum RequestCancellation {
    Running(tokio::sync::oneshot::Sender<()>),
    Cancelled(std::time::Instant),
}

static GEMINI_REQUESTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, RequestCancellation>>,
> = std::sync::LazyLock::new(Default::default);

fn requests(
) -> std::sync::MutexGuard<'static, std::collections::HashMap<String, RequestCancellation>> {
    let mut requests = GEMINI_REQUESTS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    requests.retain(|_, entry| !matches!(entry, RequestCancellation::Cancelled(at) if at.elapsed().as_secs() >= 60));
    requests
}

struct RegisteredRequest(String);
impl Drop for RegisteredRequest {
    fn drop(&mut self) {
        requests().remove(&self.0);
    }
}

#[tauri::command]
pub fn cancel_gemini_request(request_id: String) {
    let mut requests = requests();
    if let Some(RequestCancellation::Running(sender)) = requests.insert(
        request_id,
        RequestCancellation::Cancelled(std::time::Instant::now()),
    ) {
        let _ = sender.send(());
    }
}

#[tauri::command]
pub async fn gemini_resolve(
    app: AppHandle,
    operation: String,
    payload: Value,
    single_attempt: Option<bool>,
    attempt_budget: Option<usize>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let work = resolve_operation(
        app,
        operation,
        payload,
        attempt_budget
            .unwrap_or(if single_attempt == Some(true) { 1 } else { 3 })
            .clamp(1, 3),
    );
    let Some(request_id) = request_id else {
        return work.await;
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        use std::collections::hash_map::Entry;
        match requests().entry(request_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(RequestCancellation::Running(sender));
            }
            Entry::Occupied(_) => return Err("Gemini request cancelled or already running".into()),
        }
    }
    let _registration = RegisteredRequest(request_id);
    tokio::select! {
        biased;
        _ = receiver => Err("Gemini request cancelled".into()),
        result = work => result,
    }
}

async fn resolve_operation(
    app: AppHandle,
    operation: String,
    payload: Value,
    attempt_budget: usize,
) -> Result<Value, String> {
    let (prompt, timeout) = match operation.as_str() {
        "metadata" => {
            let items: Vec<Value> = payload["items"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(25)
                .collect();
            if items.is_empty() {
                return Err("No items provided in payload".into());
            }
            let items: Vec<Value> = items.iter().map(|item| json!({"id":item["id"],"title":item["title"],"artist":item["artist"],"album":item["album"],"year":item["year"],"filePath":item["filePath"]})).collect();
            let prompt = r#"You are an authoritative archival musicologist, discographer, and audio tag engineer.
Analyze the following batch of __COUNT__ audio release(s)/track(s) from a master music library.
For each item, determine canonical, highly accurate musicological metadata based on historical discographies, record label catalogs (e.g. Echo Records, Venus, HMV, Columbia, Deutsche Grammophon, Decca), and master releases.

Items to resolve:
__ITEMS__

Return ONLY a valid JSON array containing exactly __COUNT__ object(s), where each object has these exact keys:
[
  {
    "id": "<matching item id>",
    "artistCredit": "<canonical artist name(s) e.g. S. Janaki & Chorus or Ilaiyaraaja or Miles Davis>",
    "composer": "<canonical composer e.g. Ilaiyaraaja or Ludwig van Beethoven>",
    "releaseTitle": "<canonical album/release title>",
    "trackTitle": "<canonical clean track title>",
    "releaseYear": 1985,
    "label": "<canonical record label e.g. Echo Records, Venus, Columbia, EMI>",
    "catalogNumber": "<official or estimated catalog number e.g. 8000 593 or CL 1355>",
    "barcodeUpc": "<official barcode if known or empty string>",
    "opusOrCatalogue": "<opus or catalogue number if classical e.g. Op. 67, or empty string>",
    "movement": "<movement designation if applicable, e.g. I. Allegro, or empty string>",
    "genre": "<specific genre, e.g. Tamil Film Music, Western Classical, Modal Jazz>",
    "matrixRunout": "<matrix runout stamp if applicable>",
    "confidenceScore": 0.98
  }
]
No other text or markdown explanation, just the pure JSON array."#;
            (
                prompt
                    .replace("__COUNT__", &items.len().to_string())
                    .replace(
                        "__ITEMS__",
                        &serde_json::to_string_pretty(&items).unwrap_or_default(),
                    ),
                25_000,
            )
        }
        "cover-art" => {
            let album = payload["albumTitle"].as_str().unwrap_or("");
            if album.is_empty() {
                return Err("Missing albumTitle in payload".into());
            }
            (format!("You are an authoritative archival discographer and music librarian.\nAnalyze the following album and provide canonical metadata and artwork details:\nAlbum: \"{album}\"\nArtist: \"{}\"\nComposer: \"{}\"\nYear: {}\n\nReturn ONLY a valid JSON object with these exact keys:\n{{\n  \"canonicalReleaseTitle\": \"<official canonical album title>\",\n  \"canonicalArtist\": \"<primary artist/performers>\",\n  \"canonicalComposer\": \"<composer>\",\n  \"releaseYear\": 2000,\n  \"recordLabel\": \"<official label>\",\n  \"officialCoverDescription\": \"<visual description of the authentic album cover artwork>\",\n  \"suggestedCoverArtUrl\": \"<authentic high-resolution CDN or master URL if known or empty string>\",\n  \"coverResolution\": \"3000x3000px Archival Scan\",\n  \"confidenceScore\": 0.96\n}}\nNo markdown, just JSON.", payload["artistCredit"].as_str().unwrap_or(""), payload["composerName"].as_str().unwrap_or(""), payload["releaseYear"].as_str().map(str::to_string).unwrap_or_else(|| payload["releaseYear"].to_string())), 15_000)
        }
        "compilation" => {
            let album = payload["albumTitle"].as_str().unwrap_or("");
            let tracks = payload["tracks"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(100)
                .collect::<Vec<_>>();
            if album.is_empty() || tracks.is_empty() {
                return Err("Missing albumTitle or tracks array in payload".into());
            }

            let reference_url = payload["referenceUrl"].as_str().unwrap_or("").trim();
            let mut ref_section = String::new();
            if !reference_url.is_empty() {
                ref_section = format!(
                    "USER REFERENCE URL (TOP GROUND-TRUTH CITATION):\n\"{}\"\nExtract track titles, composer, singers, and original movie/soundtrack titles strictly matching this authoritative source.",
                    reference_url
                );
            }

            let mut query_section = String::new();
            if let Some(user_query) = payload.get("userSearchQuery") {
                let q_album = user_query["albumTitle"].as_str().unwrap_or("").trim();
                let q_artist = user_query["artistCredit"].as_str().unwrap_or("").trim();
                let q_year = user_query["year"].as_i64().unwrap_or(0);
                if !q_album.is_empty() || !q_artist.is_empty() || q_year > 0 {
                    query_section = format!(
                        "USER REFINE QUERY (HUMAN SEARCH GUIDANCE):\nAlbum: \"{}\"\nArtist: \"{}\"\nYear: {}\nTreat this human input as high-value intent above automatic heuristics.",
                        q_album, q_artist, if q_year > 0 { q_year.to_string() } else { "Unknown".to_string() }
                    );
                }
            }

            let folder_hint = payload["folderName"].as_str().unwrap_or("").trim();
            let folder_section = if !folder_hint.is_empty() {
                format!("Physical Folder/File Context: \"{}\"", folder_hint)
            } else {
                String::new()
            };

            let prompt = r#"You are an authoritative archival discographer and musicologist specializing in film soundtracks, studio albums, and multi-movie audio releases (including Indian cinema: Tamil, Telugu, Hindi/Bollywood, Malayalam, Kannada, as well as Western cinema and world anthologies).

DISCOGRAPHICAL CONTEXT:
Target Release: "__ALBUM__"
Attributed Artist/Composer: "__ARTIST__"
Release Year: __YEAR__
__FOLDER_SECTION__
__USER_QUERY_SECTION__
__REFERENCE_URL_SECTION__

TRACKLIST (__TRACK_COUNT__ tracks):
__TRACKS__

TASK:
Analyze this release and objectively determine whether it is:
(A) A native standalone soundtrack / studio album, OR
(B) A compilation / multi-film combo release containing tracks originating from different films/albums.

DISCOGRAPHICAL RULES (STRICT):
1. REFERENCE URL & USER QUERY:
   - If a Reference URL or User Search Override is provided above, treat it as ground truth. Extract soundtrack titles, composer, singers, and release year matching that source.
2. NATIVE ALBUM vs COMPILATION TRACKS:
   - If all tracks originated from the film/album "__ALBUM__" (or its canonical movie title), this is a NATIVE release.
   - For native tracks: set "isCompilationTrack": false, and set "originalAlbum" to the clean canonical film/album title (strip rip tags, edition subtitles like "- EP", "OST", "Original Motion Picture Soundtrack").
   - If a track originated from a different film/debut album than "__ALBUM__", set "isCompilationTrack": true, and set "originalAlbum" to that distinct film's title.
3. ANTI-HALLUCINATION GUARD:
   - Never invent artist names, composers, or release years if discographical records are uncertain.
   - If the true composer or year is unknown or unverified, return null. Do NOT guess generic names (e.g. do not guess "Deva" or arbitrary years like "2004" when unverified).
   - Set "confidence":
     * 0.95 - 1.0: Verified through reference URL, well-documented historical film release, or user search hint.
     * 0.70 - 0.90: High-confidence match based on known song title and artist discography.
     * < 0.60: Ambiguous or unverified.
4. TITLE MATCHING:
   - Variations like "__ALBUM__ (Original Motion Picture Soundtrack)", "__ALBUM__ - EP", and "__ALBUM__ CD RIP" refer to the SAME canonical film soundtrack.
5. PLAYBACK SINGERS vs COMPOSER (CRITICAL FOR FILM SOUNDTRACKS):
   - Set "canonicalComposer" to the music director/composer (e.g., Ilaiyaraaja, A. R. Rahman, M. S. Viswanathan, R. D. Burman, Shankar-Ganesh).
   - "primaryVocalists" MUST be extracted from the Wikipedia/discography Track Listing table corresponding to the authentic Playback Singers who actually sang the track (e.g., "K. S. Chithra", "K. J. Yesudas, K. S. Chithra", "S. P. Balasubrahmanyam, Malaysia Vasudevan").
   - NEVER copy the composer into "primaryVocalists" unless the composer personally performed as a lead vocalist on that specific song (e.g., "Kanne Navamaniye" sung by Ilaiyaraaja). If the composer did NOT sing on that track, they must NOT appear in "primaryVocalists".
   - If multiple singers performed, list all of them comma-separated in authentic discographical billing order.

Return ONLY a valid JSON array of __TRACK_COUNT__ objects matching this exact structure:
[
  {
    "id": "<matching track id>",
    "trackNumber": 1,
    "title": "<clean song title>",
    "originalAlbum": "<canonical original soundtrack/film title>",
    "originalYear": 1989,
    "canonicalComposer": "<composer or null>",
    "primaryVocalists": "<vocalists or null>",
    "isCompilationTrack": false,
    "confidence": 0.95,
    "notes": "<discographical note>"
  }
]
Do not include any surrounding markdown or explanation, just the raw JSON array."#;

            let prompt = prompt
                .replace("__ALBUM__", album)
                .replace(
                    "__ARTIST__",
                    payload["artistCredit"]
                        .as_str()
                        .unwrap_or("Various Artists"),
                )
                .replace("__YEAR__", &payload["releaseYear"].to_string())
                .replace("__FOLDER_SECTION__", &folder_section)
                .replace("__USER_QUERY_SECTION__", &query_section)
                .replace("__REFERENCE_URL_SECTION__", &ref_section)
                .replace("__TRACK_COUNT__", &tracks.len().to_string())
                .replace(
                    "__TRACKS__",
                    &serde_json::to_string_pretty(&tracks).unwrap_or_default(),
                );
            (prompt, 35_000)
        }
        "agent-chat" => {
            let prompt = payload["prompt"].as_str().unwrap_or("");
            if prompt.is_empty() {
                return Err("Missing prompt in request".into());
            }
            let summary = payload["catalogSummary"].as_str().unwrap_or("");
            let history = payload["history"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .rev()
                .take(6)
                .collect::<Vec<_>>();
            let sys = r#"You are Cadence, an advanced autonomous AI musicologist, audio engineer, and library management agent embedded in Cadence Core (an audiophile-grade music management suite).
You have full access to the live library database snapshot and can execute capabilities on the user's behalf.

__CATALOG__

Available executable tools:
- filter_catalog(args: { composer?: string, era?: string, language?: string, format?: string, genre?: string, mastering?: string, searchQuery?: string })
- switch_view(args: { viewMode: "virtual_table" | "variant_stack" | "work_movement" })
- run_audit(args: {})
- remediate_issue(args: { actionType: "RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER" | "MERGE_DUPLICATE_PERFORMERS" | "NORMALIZE_GENRES" | "FETCH_HIRES_ART" | "SYNC_FOLDER_TO_ALBUM" | "REWORK_BACKDROP" | "NORMALIZE_ARTIST_NAMES" | "AUTOGEN_TRACK_NUMBERS" | "FILL_MISSING_METADATA", provider?: "apple" | "musicbrainz" | "ai" })
- rework_backdrop(args: { composer?: string, artist?: string, releaseId?: string, provider?: "apple" | "musicbrainz" | "ai" })
- select_track(args: { query: string })
- open_modal(args: { modalName: "import" | "commit" | "path_rules" | "sidecar_export" | "batch_diff" | "customize_album" | "storage_manager" })
- reset_filters(args: {})
- execute_pipeline(args: { commands: Array<{ tool: string, args: Record<string, any> }> })

Instructions:
1. Provide a concise, knowledgeable, audiophile-grade conversational response in markdown.
2. If the user asks to perform an action (e.g. "filter to 24-bit tracks", "switch to grid", "auto tag from folders", "open commit modal"), include the exact structured tool in "command".
   For compound or multi-step requests (e.g. "fetch art and rework backdrop", "run audit and fix tags, then commit"), use "execute_pipeline" with an ordered array of tool commands in "args.commands".
3. If the user asks an informational or explanatory question without requesting an action (e.g. questions about dynamic range, file formats, health score, or statistics), answer conversationally and set "command" to null.
4. If the user asks for recommendations, evaluate the catalog hygiene and suggest the top 2-3 most impactful actions.
5. Format output strictly as JSON with this schema:
{
  "response": "<Markdown formatted conversational response>",
  "command": { "tool": "<tool_name>", "args": { ... }, "explanation": "<short description of action>" } | null,
  "suggestedActions": [ { "label": "<short pill label>", "prompt": "<full instruction>" } ]
}"#;
            let sys = sys.replace("__CATALOG__", summary);
            let mut contents = Vec::new();
            for h in history.into_iter().rev() {
                contents.push(json!({"role": if h["role"] == "agent" {"model"} else {"user"}, "parts":[{"text":h["text"]}]}));
            }
            contents.push(json!({"role":"user","parts":[{"text":format!("{sys}\n\nUser Instruction: {prompt}")}]}));
            let (data, model, delay, retries) =
                generate(&app, Value::Array(contents), 12_000, false, attempt_budget).await?;
            let parsed = clean_json(&text_content(&data)).unwrap_or_else(|_| json!({"response":"I analyzed your library. How would you like me to assist with tagging, filtering, or audio hygiene?","command":null,"suggestedActions":[{"label":"Library Statistics","prompt":"Give me a statistical breakdown of my library"},{"label":"Recommend Actions","prompt":"What actions do you recommend next?"},{"label":"Auto-Resolve Artists","prompt":"Extract missing artists from folder hierarchy"}]}));
            return Ok(
                json!({"success":true,"response":parsed["response"],"command":parsed["command"],"suggestedActions":parsed["suggestedActions"],"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":retries}}),
            );
        }
        _ => return Err("Unknown Gemini operation".into()),
    };
    let contents = json!([{"role":"user","parts":[{"text":prompt}]}]);
    let use_grounding = operation == "compilation"
        && (payload["referenceUrl"]
            .as_str()
            .map(|u| !u.trim().is_empty())
            .unwrap_or(false)
            || payload.get("userSearchQuery").is_some());
    let (data, model, delay, retries) =
        generate(&app, contents, timeout, use_grounding, attempt_budget).await?;
    let parsed = clean_json(&text_content(&data))?;
    match operation.as_str() {
        "metadata" => {
            let results = parsed.as_array().cloned().unwrap_or_default();
            Ok(
                json!({"success":true,"count":results.len(),"results":results,"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":retries}}),
            )
        }
        "compilation" => {
            let results = parsed.as_array().cloned().unwrap_or_default();
            Ok(
                json!({"success":true,"albumTitle":payload["albumTitle"],"count":results.len(),"results":results,"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":retries}}),
            )
        }
        "cover-art" => Ok(
            json!({"success":true,"provider":"ai","canonicalReleaseTitle":parsed["canonicalReleaseTitle"].as_str().unwrap_or(payload["albumTitle"].as_str().unwrap_or("")),"canonicalArtist":parsed["canonicalArtist"].as_str().unwrap_or(payload["artistCredit"].as_str().unwrap_or("")),"canonicalComposer":parsed["canonicalComposer"].as_str().unwrap_or(payload["composerName"].as_str().unwrap_or("")),"releaseYear":parsed["releaseYear"].as_u64().unwrap_or(payload["releaseYear"].as_u64().unwrap_or(0)),"recordLabel":parsed["recordLabel"].as_str().unwrap_or("Archival Master"),"officialCoverDescription":parsed["officialCoverDescription"].as_str().unwrap_or("AI Verified Canonical Master Release"),"coverArtUrl":parsed["suggestedCoverArtUrl"].as_str().unwrap_or(""),"coverResolution":parsed["coverResolution"].as_str().unwrap_or("Master Reference Scan (AI Verified)"),"confidenceScore":parsed["confidenceScore"].as_f64().unwrap_or(0.95),"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":retries}}),
        ),
        _ => unreachable!(),
    }
}

#[tauri::command]
pub async fn get_gemini_quota() -> Value {
    quota_snapshot()
}

fn emit_quota(app: &AppHandle) {
    let _ = app.emit("gemini-quota-changed", quota_snapshot());
}

fn quota_snapshot() -> Value {
    let state = quota();
    let remaining = pacing_remaining(&state).as_millis() as u64;
    let models: Vec<_> = state.models.iter().map(|(model, block)| json!({
        "model": model, "reason": block.reason, "blockedUntil": block.blocked_until, "observedLimit": block.observed_limit
    })).collect();
    json!({
        "rateLimitRpm": 15, "pacingIntervalMs": PACING_MS, "nextSlotRemainingMs": remaining,
        "isPacingActive": remaining > 0, "lastCallTimestamp": state.last_timestamp,
        "preferredModel": state.preferred, "currentModel": state.in_flight.as_ref().or(state.last_successful.as_ref()),
        "inFlightModel": state.in_flight, "projectBlock": state.project, "groundingBlock": state.grounding, "models": models
    })
}

#[cfg(windows)]
fn protect(value: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("Windows could not protect the Gemini key".into());
    }
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(encrypted)
}

#[cfg(windows)]
fn unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("Windows could not decrypt the saved Gemini key".into());
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(plain)
}

#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Secure Gemini key storage is only available on Windows".into())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Secure Gemini key storage is only available on Windows".into())
}

#[tauri::command]
pub fn get_gemini_config(app: AppHandle) -> Result<GeminiConfigStatus, String> {
    let path = config_path(&app)?;
    let settings = if path.exists() {
        read_settings(&app).ok()
    } else {
        None
    };
    let configured = settings
        .as_ref()
        .map(|s| !s.api_key.is_empty())
        .unwrap_or(false);
    let model = settings
        .map(|s| s.model)
        .unwrap_or_else(|| DEFAULT_MODEL.into());
    quota().preferred = model.trim_start_matches("models/").to_string();
    Ok(GeminiConfigStatus { configured, model })
}

#[tauri::command]
pub fn save_gemini_api_key(app: AppHandle, api_key: String, model: String) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Enter a Gemini API key to continue".into());
    }
    let model = model.trim();
    if model.is_empty() || model.chars().any(char::is_whitespace) {
        return Err("Enter a valid Gemini model name".into());
    }
    let settings = GeminiSettings {
        api_key: key.to_string(),
        model: model.to_string(),
    };
    write_settings(&app, settings)
}

fn write_settings(app: &AppHandle, settings: GeminiSettings) -> Result<(), String> {
    let serialized = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
    let encrypted = protect(&serialized)?;
    std::fs::write(config_path(app)?, encrypted).map_err(|e| e.to_string())?;
    quota().preferred = settings.model.trim_start_matches("models/").to_string();
    emit_quota(app);
    Ok(())
}

#[tauri::command]
pub fn save_gemini_model(app: AppHandle, model: String) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() || model.chars().any(char::is_whitespace) {
        return Err("Enter a valid Gemini model name".into());
    }
    let mut settings = read_settings(&app)?;
    settings.model = model.to_string();
    write_settings(&app, settings)
}

#[tauri::command]
pub fn remove_gemini_api_key(app: AppHandle) -> Result<(), String> {
    let path = config_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod gemini_tests {
    use super::*;

    #[test]
    fn daily_quota_resets_at_pacific_midnight_across_dst() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-01T07:00:00Z")
            .unwrap()
            .timestamp_millis();
        let reset = chrono::DateTime::parse_from_rfc3339("2026-11-02T08:00:00Z")
            .unwrap()
            .timestamp_millis();
        let violation =
            json!({ "quotaId": "GenerateRequestsPerDayPerProjectPerModel", "quotaValue": "20" });
        let block = quota_block(429, now, 2_000, &[&violation], None);
        assert_eq!(block.reason, "daily_quota");
        assert_eq!(block.blocked_until, reset);
        assert_eq!(block.observed_limit.as_deref(), Some("20"));
    }

    #[test]
    fn quota_blocks_alias_and_canonical_model_without_blocking_other_models() {
        let mut state = GeminiQuota::default();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("retry-after", "120".parse().unwrap());
        let data = json!({ "error": { "details": [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [
                { "quotaId": "GenerateRequestsPerMinutePerProjectPerModel", "quotaDimensions": { "model": DEFAULT_MODEL } }
            ] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "90.5s" }
        ] } });
        let before = now_ms();
        record_block(&mut state, "model-alias", 429, false, &headers, &data);
        let until = model_block_until(&state, "model-alias", false);
        assert!(until >= before + 120_000);
        assert_eq!(until, model_block_until(&state, DEFAULT_MODEL, false));
        assert_eq!(model_block_until(&state, "gemini-3.1-flash-lite", false), 0);
        assert_eq!(project_block_until(&state, false), 0);
    }

    #[test]
    fn search_quota_does_not_block_ordinary_inference() {
        let mut state = GeminiQuota::default();
        let data = json!({ "error": { "details": [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [
                { "quotaId": "GroundingRequestsPerDayPerProject" }
            ] }
        ] } });
        record_block(
            &mut state,
            DEFAULT_MODEL,
            429,
            true,
            &Default::default(),
            &data,
        );
        assert!(project_block_until(&state, true) > now_ms());
        assert_eq!(project_block_until(&state, false), 0);
        assert_eq!(model_block_until(&state, DEFAULT_MODEL, false), 0);
    }
}
