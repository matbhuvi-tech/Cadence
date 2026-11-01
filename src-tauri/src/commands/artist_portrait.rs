use serde_json::{json, Value};

fn extract_og_image(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let marker = lower.find("og:image")?;
    let start = lower[..marker].rfind("<meta")?;
    let end = lower[marker..].find('>')? + marker;
    let tag = &html[start..=end];
    let tag_lower = tag.to_ascii_lowercase();
    let content = tag_lower.find("content=")? + "content=".len();
    let quote = tag.as_bytes().get(content).copied()?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let value_start = content + 1;
    let value_end = tag[value_start..].find(quote as char)? + value_start;
    Some(tag[value_start..value_end].to_string())
}

fn encode_path_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn candidate(provider: &str, label: &str, url: String) -> Value {
    json!({
        "provider": provider,
        "providerLabel": label,
        "portraitUrl": url,
        "width": 1000,
        "height": 1000,
    })
}

#[tauri::command]
pub async fn search_artist_portraits(artist: String) -> Result<Value, String> {
    let clean_artist = artist.trim();
    if clean_artist.is_empty() {
        return Ok(json!({ "success": false, "artist": "", "candidates": [] }));
    }

    let client = reqwest::Client::builder()
        .user_agent("CadenceMusicAgent/1.0.0 (https://github.com/cadence-audio)")
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();

    // Tier 1: Apple Music artist page OpenGraph portrait.
    if let Ok(response) = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", clean_artist), ("entity", "musicArtist"), ("limit", "1")])
        .send()
        .await
    {
        if let Ok(data) = response.json::<Value>().await {
            let artist_page = data["results"][0]["artistLinkUrl"]
                .as_str()
                .or_else(|| data["results"][0]["artistViewUrl"].as_str());
            if let Some(page) = artist_page {
                if let Ok(response) = client.get(page).send().await {
                    if let Ok(html) = response.text().await {
                        if let Some(image) = extract_og_image(&html) {
                            let high_res = image
                                .replace("/100x100", "/1000x1000")
                                .replace("/600x600", "/1000x1000");
                            candidates.push(candidate(
                                "apple",
                                "Apple Music Editorial (1000×1000)",
                                high_res,
                            ));
                        }
                    }
                }
            }
        }
    }

    // Tier 2: Deezer's public artist search API.
    if let Ok(response) = client
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", clean_artist), ("limit", "1")])
        .send()
        .await
    {
        if let Ok(data) = response.json::<Value>().await {
            if let Some(image) = data["data"][0]["picture_xl"].as_str() {
                if !image.contains("default_artist") {
                    candidates.push(candidate(
                        "deezer",
                        "Deezer Studio Headshot (1000×1000)",
                        image.to_string(),
                    ));
                }
            }
        }
    }

    // Tier 3: MusicBrainz artist relation -> Wikidata portrait -> Wikimedia.
    let mbid = if let Ok(response) = client
        .get("https://musicbrainz.org/ws/2/artist/")
        .query(&[("query", format!("artist:\"{clean_artist}\"")), ("fmt", "json".to_string()), ("limit", "1".to_string())])
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        response
            .json::<Value>()
            .await
            .ok()
            .and_then(|data| data["artists"][0]["id"].as_str().map(str::to_string))
    } else {
        None
    };

    if let Some(mbid) = mbid {
        if let Ok(response) = client
            .get(format!("https://musicbrainz.org/ws/2/artist/{mbid}"))
            .query(&[("inc", "url-rels"), ("fmt", "json")])
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
        {
            if let Ok(data) = response.json::<Value>().await {
                let wikidata = data["relations"].as_array().and_then(|relations| {
                    relations.iter().find_map(|relation| {
                        let resource = relation["url"]["resource"].as_str()?;
                        if relation["type"] == "wikidata" || resource.contains("wikidata.org/wiki/") {
                            resource.rsplit('/').next().map(str::to_string)
                        } else {
                            None
                        }
                    })
                });
                if let Some(qid) = wikidata.filter(|qid| qid.starts_with('Q')) {
                    if let Ok(response) = client
                        .get("https://www.wikidata.org/w/api.php")
                        .query(&[
                            ("action", "wbgetclaims".to_string()),
                            ("entity", qid.clone()),
                            ("property", "P18".to_string()),
                            ("format", "json".to_string()),
                        ])
                        .send()
                        .await
                    {
                        if let Ok(data) = response.json::<Value>().await {
                            if let Some(filename) = data["claims"]["P18"][0]["mainsnak"]["datavalue"]["value"].as_str() {
                                let image = format!(
                                    "https://commons.wikimedia.org/wiki/Special:FilePath/{}?width=1000",
                                    encode_path_component(filename)
                                );
                                candidates.push(candidate(
                                    "wikimedia",
                                    "Wikimedia Commons Archive",
                                    image,
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(json!({
        "success": !candidates.is_empty(),
        "artist": clean_artist,
        "candidates": candidates,
    }))
}
