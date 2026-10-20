use std::fs;
use std::path::Path;
use base64::prelude::*;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagExt, TagItem};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedAudioFile {
    pub file_path: String,
    pub filename: String,
    pub extension: String,
    pub size_bytes: u64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub genre: Option<String>,
    pub composer: Option<String>,
    pub duration_secs: f64,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u16>,
    pub has_embedded_art: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitTagsPayload {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub composer: Option<String>,
    pub genre: Option<String>,
}

#[tauri::command]
pub fn scan_directory_native(directory_path: String) -> Result<Vec<ScannedAudioFile>, String> {
    let dir = Path::new(&directory_path);
    if !dir.exists() {
        return Err(format!("Directory does not exist: {}", directory_path));
    }

    let mut audio_files = Vec::new();

    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if ["flac", "wav", "mp3", "m4a", "aac", "aiff", "aif", "ogg", "dsf", "dff"].contains(&ext_lower.as_str()) {
                    let metadata = entry.metadata().ok();
                    let size_bytes = metadata.map(|m| m.len()).unwrap_or(0);
                    let filename = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

                    let probe_res = Probe::open(path).and_then(|p| p.read());
                    
                    let (title, artist, album, year, track_number, genre, composer, duration_secs, sample_rate, bit_depth, channels, has_embedded_art) = match probe_res {
                        Ok(tagged_file) => {
                            let props = tagged_file.properties();
                            let dur = props.duration().as_secs_f64();
                            let sr = props.sample_rate();
                            let bd = props.bit_depth();
                            let ch = props.channels().map(|c| c as u16);

                            let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
                            
                            let t = tag.and_then(|t| t.title().map(|s| s.to_string()));
                            let a = tag.and_then(|t| t.artist().map(|s| s.to_string()));
                            let alb = tag.and_then(|t| t.album().map(|s| s.to_string()));
                            let yr = tag.and_then(|t| t.year());
                            let trk = tag.and_then(|t| t.track());
                            let g = tag.and_then(|t| t.genre().map(|s| s.to_string()));
                            let comp = tag.and_then(|t| t.get_string(&ItemKey::Composer).map(|s| s.to_string()));
                            let has_art = tag.map(|t| !t.pictures().is_empty()).unwrap_or(false);

                            (t, a, alb, yr, trk, g, comp, dur, sr, bd, ch, has_art)
                        }
                        Err(_) => (None, None, None, None, None, None, None, 0.0, None, None, None, false),
                    };

                    audio_files.push(ScannedAudioFile {
                        file_path: path.to_string_lossy().to_string(),
                        filename,
                        extension: ext_lower,
                        size_bytes,
                        title,
                        artist,
                        album,
                        year,
                        track_number,
                        genre,
                        composer,
                        duration_secs,
                        sample_rate,
                        bit_depth,
                        channels,
                        has_embedded_art,
                    });
                }
            }
        }
    }

    Ok(audio_files)
}

#[tauri::command]
pub fn read_cover_art_base64(file_path: String) -> Result<Option<String>, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Ok(None);
    }

    // 1. Try embedded picture
    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
            if let Some(pic) = tag.pictures().first() {
                let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
                let b64 = BASE64_STANDARD.encode(pic.data());
                return Ok(Some(format!("data:{};base64,{}", mime, b64)));
            }
        }
    }

    // 2. Try adjacent folder images
    if let Some(parent) = path.parent() {
        let candidates = ["folder.jpg", "cover.jpg", "front.jpg", "album.jpg", "folder.png", "cover.png", "front.png"];
        for cand in candidates {
            let img_path = parent.join(cand);
            if img_path.exists() {
                if let Ok(data) = fs::read(&img_path) {
                    let mime = if cand.ends_with(".png") { "image/png" } else { "image/jpeg" };
                    let b64 = BASE64_STANDARD.encode(&data);
                    return Ok(Some(format!("data:{};base64,{}", mime, b64)));
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn commit_track_tags_native(
    file_path: String,
    tags: CommitTagsPayload,
) -> Result<bool, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let mut tagged_file = Probe::open(path)
        .map_err(|e| format!("Failed to open file: {}", e))?
        .read()
        .map_err(|e| format!("Failed to read tags: {}", e))?;

    let tag_type = tagged_file.primary_tag_type();
    let tag = match tagged_file.tag_mut(tag_type) {
        Some(t) => t,
        None => {
            tagged_file.insert_tag(Tag::new(tag_type));
            tagged_file.tag_mut(tag_type).unwrap()
        }
    };

    if let Some(title) = tags.title {
        tag.set_title(title);
    }
    if let Some(artist) = tags.artist {
        tag.set_artist(artist);
    }
    if let Some(album) = tags.album {
        tag.set_album(album);
    }
    if let Some(year) = tags.year {
        tag.set_year(year);
    }
    if let Some(track) = tags.track_number {
        tag.set_track(track);
    }
    if let Some(genre) = tags.genre {
        tag.set_genre(genre);
    }
    if let Some(composer) = tags.composer {
        tag.insert(TagItem::new(ItemKey::Composer, ItemValue::Text(composer)));
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Failed to save tags to disk: {}", e))?;

    Ok(true)
}
