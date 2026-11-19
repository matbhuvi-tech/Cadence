//! Shared native container inspection, used by headless library indexing.
use lofty::config::ParseOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{Picture, PictureType};
use lofty::tag::{Accessor, ItemKey, Tag};
use std::fs;
use std::path::{Path, PathBuf};

pub struct MediaMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u16>,
    pub tag: Option<Tag>,
    pub tag_parse_error: Option<String>,
}

pub fn inspect(path: &Path, extension: &str) -> Result<MediaMetadata, String> {
    let (duration, sample_rate, bit_depth, channels, tag, tag_parse_error) =
        if matches!(extension, "dsf" | "dff" | "dsdiff") {
            let parsed =
                super::dsd::probe_dsd_as(path, extension).ok_or("Invalid DSD container")?;
            (
                parsed.duration_secs,
                parsed.sample_rate,
                parsed.bit_depth,
                parsed.channels,
                parsed.tag,
                None,
            )
        } else {
            let parse = |read_tags| {
                lofty::probe::Probe::open(path)
                    .map_err(|error| error.to_string())?
                    .options(ParseOptions::new().read_tags(read_tags))
                    .guess_file_type()
                    .map_err(|error| error.to_string())?
                    .read()
                    .map_err(|error| error.to_string())
            };
            let (parsed, tag_parse_error) = match parse(true) {
                Ok(parsed) => (parsed, None),
                Err(original_error) if extension == "wav" => {
                    (parse(false).map_err(|_| original_error.clone())?, Some(original_error))
                }
                Err(error) => return Err(error),
            };
            let props = parsed.properties();
            let mut chosen_tag = parsed.primary_tag().or_else(|| parsed.first_tag()).cloned();
            if let Some(ref mut t) = chosen_tag {
                if t.pictures().is_empty() {
                    if let Some(pic_tag) = parsed.tags().iter().find(|other| !other.pictures().is_empty()) {
                        for pic in pic_tag.pictures() {
                            t.push_picture(pic.clone());
                        }
                    }
                }
            }
            (
                props.duration().as_secs_f64(),
                props.sample_rate(),
                props.bit_depth(),
                props.channels().map(u16::from),
                chosen_tag,
                tag_parse_error,
            )
        };
    let title = tag
        .as_ref()
        .and_then(|t| t.title().map(|s| s.to_string()))
        .unwrap_or_default();
    let artist = tag
        .as_ref()
        .and_then(|t| t.artist().map(|s| s.to_string()))
        .unwrap_or_else(|| "Unknown Artist".into());
    let album = tag
        .as_ref()
        .and_then(|t| t.album().map(|s| s.to_string()))
        .unwrap_or_default();
    Ok(MediaMetadata {
        title,
        artist,
        album,
        duration,
        sample_rate,
        bit_depth,
        channels,
        tag,
        tag_parse_error,
    })
}

pub fn text(tag: Option<&Tag>, key: ItemKey) -> Option<String> {
    tag.and_then(|t| t.get_string(&key)).map(str::to_string)
}

/// Selects the most appropriate album cover picture from an audio tag,
/// prioritizing `PictureType::CoverFront`, then `PictureType::Other`,
/// before falling back to the first embedded picture.
pub fn select_best_picture(tag: &Tag) -> Option<&Picture> {
    let pics = tag.pictures();
    if pics.is_empty() {
        return None;
    }
    pics.iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pics.iter().find(|p| p.pic_type() == PictureType::Other))
        .or_else(|| pics.first())
}

pub fn is_cover_image_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "bmp"
    )
}

/// Ranks a candidate image filename (case-insensitive) by standard audiophile cover conventions.
/// Lower score = higher priority. Returns `None` if the filename does not match cover conventions
/// (unless `allow_single_image_fallback` is true because it is the only image in the album folder).
pub fn rank_cover_filename(file_name: &str, allow_single_image_fallback: bool) -> Option<(u8, u8)> {
    let path = Path::new(file_name);
    let ext = path.extension().and_then(|e| e.to_str())?.to_ascii_lowercase();
    let ext_rank = match ext.as_str() {
        "jpg" | "jpeg" => 0,
        "png" => 1,
        "webp" => 2,
        "bmp" => 3,
        _ => return None,
    };
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())?
        .trim()
        .to_ascii_lowercase();
    if stem.is_empty() {
        return None;
    }
    let stem_rank = match stem.as_str() {
        "cover" => 0,
        "folder" => 1,
        "front" => 2,
        "album" => 3,
        "albumart" | "album_art" | "album-art" | "albumartsmall" => 4,
        "artwork" | "art" | "thumb" => 5,
        _ if stem.starts_with("cover")
            || stem.starts_with("front")
            || stem.starts_with("folder")
            || stem.ends_with("cover")
            || stem.ends_with("front") =>
        {
            6
        }
        _ if allow_single_image_fallback
            && !stem.contains("back")
            && !stem.contains("inlay")
            && !stem.contains("matrix") =>
        {
            7
        }
        _ => return None,
    };
    Some((stem_rank, ext_rank))
}

pub fn is_artwork_subdir_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "artwork" | "artworks" | "covers" | "cover" | "scans" | "scan" | "art" | "images"
    )
}

pub fn is_multidisc_subfolder_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    for prefix in ["cd", "disc", "disk", "vol", "volume", "lp", "side"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let trimmed = rest.trim_start_matches([' ', '-', '_', '.']);
            if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
                return true;
            }
        }
    }
    false
}

fn find_ranked_cover_in_dir(target_dir: &Path) -> Option<PathBuf> {
    let read_dir = fs::read_dir(target_dir).ok()?;
    let mut image_files: Vec<(String, PathBuf)> = Vec::new();
    for entry in read_dir.flatten() {
        let Ok(ty) = entry.file_type() else {
            continue;
        };
        if !ty.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if is_cover_image_extension(ext) {
            image_files.push((file_name.clone(), target_dir.join(file_name)));
        }
    }
    let allow_single = image_files.len() == 1;
    let mut ranked: Vec<((u8, u8), String, PathBuf)> = image_files
        .into_iter()
        .filter_map(|(name, p)| {
            let rank = rank_cover_filename(&name, allow_single)?;
            Some((rank, name.to_ascii_lowercase(), p))
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    ranked.into_iter().next().map(|(_, _, p)| p)
}

pub fn find_local_cover_art(dir: &Path) -> Option<String> {
    if let Some(found) = find_ranked_cover_in_dir(dir) {
        return Some(found.to_string_lossy().to_string());
    }
    if let Ok(read_dir) = fs::read_dir(dir) {
        let mut subdirs: Vec<PathBuf> = Vec::new();
        for entry in read_dir.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_artwork_subdir_name(&name) {
                    subdirs.push(dir.join(name));
                }
            }
        }
        subdirs.sort();
        for sub in subdirs {
            if let Some(found) = find_ranked_cover_in_dir(&sub) {
                return Some(found.to_string_lossy().to_string());
            }
        }
    }
    let folder_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if is_multidisc_subfolder_name(&folder_name) {
        if let Some(parent) = dir.parent() {
            if let Some(found) = find_ranked_cover_in_dir(parent) {
                return Some(found.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    struct TempFile(PathBuf);

    impl TempFile {
        fn new(bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "cadence-wav-info-test-{}.wav",
                uuid::Uuid::new_v4().simple()
            ));
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(bytes).unwrap();
            file.flush().unwrap();
            Self(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn chunk(id: &[u8; 4], contents: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::with_capacity(8 + contents.len() + contents.len() % 2);
        chunk.extend_from_slice(id);
        chunk.extend_from_slice(&(contents.len() as u32).to_le_bytes());
        chunk.extend_from_slice(contents);
        if contents.len() % 2 != 0 {
            chunk.push(0);
        }
        chunk
    }

    fn wav_with_unterminated_info_value() -> Vec<u8> {
        let mut body = b"WAVE".to_vec();
        let mut format = Vec::new();
        format.extend_from_slice(&1u16.to_le_bytes()); // PCM
        format.extend_from_slice(&2u16.to_le_bytes()); // stereo
        format.extend_from_slice(&44_100u32.to_le_bytes());
        format.extend_from_slice(&176_400u32.to_le_bytes());
        format.extend_from_slice(&4u16.to_le_bytes());
        format.extend_from_slice(&16u16.to_le_bytes());
        body.extend_from_slice(&chunk(b"fmt ", &format));
        body.extend_from_slice(&chunk(b"data", &[0; 4]));

        let mut info = b"INFO".to_vec();
        let mut malformed_value = Vec::new();
        malformed_value.extend_from_slice(&[0xFF, 0xFE]);
        info.extend_from_slice(&chunk(b"INAM", &malformed_value));
        body.extend_from_slice(&chunk(b"LIST", &info));

        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(body.len() as u32).to_le_bytes());
        wav.extend_from_slice(&body);
        wav
    }

    #[test]
    fn malformed_riff_info_does_not_prevent_wav_technical_metadata_import() {
        let file = TempFile::new(&wav_with_unterminated_info_value());

        let metadata = inspect(&file.0, "wav")
            .expect("a malformed optional RIFF INFO value must not make the WAV unscannable");

        assert_eq!(metadata.sample_rate, Some(44_100));
        assert_eq!(metadata.bit_depth, Some(16));
        assert_eq!(metadata.channels, Some(2));
        assert!(metadata.tag_parse_error.is_some());
        assert!(
            metadata.tag.is_none(),
            "broken INFO tags should be ignored on fallback"
        );
    }
}
