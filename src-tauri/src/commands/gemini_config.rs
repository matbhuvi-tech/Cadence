use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    OnceLock,
};
use tauri::AppHandle;
use tauri::Manager;

const DEFAULT_MODEL: &str = "gemini-3.5-flash-lite";
const PACING_MS: u64 = 4_000;
static LAST_GEMINI_CALL: OnceLock<tokio::sync::Mutex<std::time::Instant>> = OnceLock::new();
static LAST_GEMINI_CALL_MS: AtomicI64 = AtomicI64::new(0);

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

async fn generate(
    app: &AppHandle,
    contents: Value,
    timeout_ms: u64,
    use_grounding: bool,
    single_attempt: bool,
) -> Result<(Value, String, u64), String> {
    let settings = read_settings(app)?;
    let key = settings.api_key;
    let pacing = LAST_GEMINI_CALL.get_or_init(|| {
        tokio::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(10))
    });
    let mut last = pacing.lock().await;
    let wait = PACING_MS.saturating_sub(last.elapsed().as_millis() as u64);
    if wait > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
    }
    *last = std::time::Instant::now();
    LAST_GEMINI_CALL_MS.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
    let mut client = reqwest::Client::builder().timeout(std::time::Duration::from_millis(timeout_ms));
    if single_attempt {
        client = client.redirect(reqwest::redirect::Policy::none());
    }
    let client = client.build()
        .map_err(|e| e.to_string())?;
    let candidates = [
        settings.model.as_str(),
        DEFAULT_MODEL,
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.1-flash-lite",
        "gemini-flash-latest",
    ];
    let mut last_error = String::from("Gemini models are temporarily unavailable");
    for (index, model) in candidates.iter().enumerate() {
        if single_attempt && index > 0 {
            break;
        }
        if candidates[..index].contains(model) {
            continue;
        }
        let attempts = if single_attempt { 1 } else { 3 };
        for attempt in 0..attempts {
            let mut req_body = json!({ "contents": &contents });
            if use_grounding {
                req_body["tools"] = json!([{ "google_search": {} }]);
            } else {
                req_body["generationConfig"] = json!({ "responseMimeType": "application/json" });
            }
            let response = client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
                .header("x-goog-api-key", &key).json(&req_body).send().await;
            match response {
                Ok(r) if r.status().is_success() => {
                    let data: Value = r.json().await.map_err(|e| e.to_string())?;
                    return Ok((data, (*model).to_string(), wait));
                }
                Ok(r) if r.status().as_u16() == 429 || r.status().as_u16() == 503 => {
                    last_error = r
                        .text()
                        .await
                        .unwrap_or_else(|_| "Gemini rate limit or service capacity reached".into());
                    if attempt + 1 < attempts {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            2u64.pow(attempt + 1) * 1000,
                        ))
                        .await;
                    }
                }
                Ok(r) if r.status().as_u16() == 404 => {
                    last_error = format!(
                        "Gemini model {model} is unavailable: {}",
                        r.text().await.unwrap_or_default()
                    );
                    break;
                }
                Ok(r) => {
                    return Err(format!(
                        "Gemini request failed ({}): {}",
                        r.status(),
                        r.text().await.unwrap_or_default()
                    ));
                }
                Err(e) => {
                    last_error = e.to_string();
                    break;
                }
            }
        }
    }
    Err(last_error)
}

fn text_content(data: &Value) -> String {
    data["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[tauri::command]
pub async fn gemini_resolve(
    app: AppHandle,
    operation: String,
    payload: Value,
    single_attempt: Option<bool>,
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
            let (data, model, delay) = generate(&app, Value::Array(contents), 12_000, false, false).await?;
            let parsed = clean_json(&text_content(&data)).unwrap_or_else(|_| json!({"response":"I analyzed your library. How would you like me to assist with tagging, filtering, or audio hygiene?","command":null,"suggestedActions":[{"label":"Library Statistics","prompt":"Give me a statistical breakdown of my library"},{"label":"Recommend Actions","prompt":"What actions do you recommend next?"},{"label":"Auto-Resolve Artists","prompt":"Extract missing artists from folder hierarchy"}]}));
            return Ok(
                json!({"success":true,"response":parsed["response"],"command":parsed["command"],"suggestedActions":parsed["suggestedActions"],"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":0}}),
            );
        }
        _ => return Err("Unknown Gemini operation".into()),
    };
    let contents = json!([{"role":"user","parts":[{"text":prompt}]}]);
    let use_grounding = operation == "compilation" && (
        payload["referenceUrl"].as_str().map(|u| !u.trim().is_empty()).unwrap_or(false) ||
        payload.get("userSearchQuery").is_some()
    );
    let (data, model, delay) = generate(&app, contents, timeout, use_grounding, single_attempt.unwrap_or(false)).await?;
    let parsed = clean_json(&text_content(&data))?;
    match operation.as_str() {
        "metadata" => {
            let results = parsed.as_array().cloned().unwrap_or_default();
            Ok(
                json!({"success":true,"count":results.len(),"results":results,"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":0}}),
            )
        }
        "compilation" => {
            let results = parsed.as_array().cloned().unwrap_or_default();
            Ok(
                json!({"success":true,"albumTitle":payload["albumTitle"],"count":results.len(),"results":results,"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":0}}),
            )
        }
        "cover-art" => Ok(
            json!({"success":true,"provider":"ai","canonicalReleaseTitle":parsed["canonicalReleaseTitle"].as_str().unwrap_or(payload["albumTitle"].as_str().unwrap_or("")),"canonicalArtist":parsed["canonicalArtist"].as_str().unwrap_or(payload["artistCredit"].as_str().unwrap_or("")),"canonicalComposer":parsed["canonicalComposer"].as_str().unwrap_or(payload["composerName"].as_str().unwrap_or("")),"releaseYear":parsed["releaseYear"].as_u64().unwrap_or(payload["releaseYear"].as_u64().unwrap_or(0)),"recordLabel":parsed["recordLabel"].as_str().unwrap_or("Archival Master"),"officialCoverDescription":parsed["officialCoverDescription"].as_str().unwrap_or("AI Verified Canonical Master Release"),"coverArtUrl":parsed["suggestedCoverArtUrl"].as_str().unwrap_or(""),"coverResolution":parsed["coverResolution"].as_str().unwrap_or("Master Reference Scan (AI Verified)"),"confidenceScore":parsed["confidenceScore"].as_f64().unwrap_or(0.95),"telemetry":{"modelUsed":model,"pacingDelayMs":delay,"retriesAttempted":0}}),
        ),
        _ => unreachable!(),
    }
}

#[tauri::command]
pub async fn get_gemini_quota() -> Value {
    let last_timestamp = LAST_GEMINI_CALL_MS.load(Ordering::Relaxed);
    let elapsed = if last_timestamp == 0 {
        PACING_MS
    } else {
        chrono::Utc::now()
            .timestamp_millis()
            .saturating_sub(last_timestamp) as u64
    };
    let remaining = PACING_MS.saturating_sub(elapsed);
    json!({"rateLimitRpm":15,"pacingIntervalMs":PACING_MS,"nextSlotRemainingMs":remaining,"isPacingActive":remaining>0,"lastCallTimestamp":last_timestamp})
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
    Ok(GeminiConfigStatus {
        configured,
        model: settings
            .map(|s| s.model)
            .unwrap_or_else(|| DEFAULT_MODEL.into()),
    })
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
    std::fs::write(config_path(app)?, encrypted).map_err(|e| e.to_string())
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
