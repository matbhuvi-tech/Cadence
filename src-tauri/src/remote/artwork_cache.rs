use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::imageops::FilterType;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;

#[derive(Clone)]
pub struct ArtworkCache {
    cache_dir: PathBuf,
    is_playing_fn: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl ArtworkCache {
    pub fn new<F>(cache_dir: PathBuf, is_playing_fn: F) -> Self
    where
        F: Fn() -> bool + Send + Sync + 'static,
    {
        let _ = fs::create_dir_all(&cache_dir);
        Self {
            cache_dir,
            is_playing_fn: Arc::new(is_playing_fn),
        }
    }

    /// Retrieve or generate a 300x300 thumbnail for the given track/release.
    /// Returns (image_bytes, mime_type).
    pub fn get_or_create_thumbnail(
        &self,
        id: &str,
        source_audio_path: Option<&str>,
    ) -> Option<(Vec<u8>, &'static str)> {
        let safe_id: String = id
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let cached_path = self.cache_dir.join(format!("{}.jpg", safe_id));

        // 1. If already cached in AppData NVMe, return immediately! (Zero disk reads on audio drive)
        if cached_path.is_file() {
            if let Ok(bytes) = fs::read(&cached_path) {
                return Some((bytes, "image/jpeg"));
            }
        }

        // 2. AUDIOPHILE GUARD: If audio is currently playing, DO NOT touch the audio storage bus!
        if (self.is_playing_fn)() {
            return None;
        }

        // 3. Audio is idle: Attempt extraction and resize to 300x300
        let audio_path_str = source_audio_path?;
        let audio_path = Path::new(audio_path_str);
        if !audio_path.exists() {
            return None;
        }

        // Try extracting embedded cover art first, then adjacent folder art
        let raw_bytes: Option<Vec<u8>> = (|| {
            if let Ok(tagged_file) = Probe::open(audio_path).and_then(|p| p.read()) {
                if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                    if let Some(pic) = tag.pictures().first() {
                        return Some(pic.data().to_vec());
                    }
                }
            }

            if let Some(parent) = audio_path.parent() {
                let candidates = [
                    "cover.jpg", "folder.jpg", "front.jpg", "album.jpg",
                    "cover.png", "folder.png", "front.png", "Cover.jpg", "Folder.jpg"
                ];
                for cand in candidates {
                    let p = parent.join(cand);
                    if p.is_file() {
                        if let Ok(b) = fs::read(&p) {
                            return Some(b);
                        }
                    }
                }
            }

            None
        })();

        let raw_data = raw_bytes?;

        // Resize image to max 300x300 JPEG thumbnail (~15-25 KB)
        if let Ok(img) = image::load_from_memory(&raw_data) {
            let thumb = img.resize(300, 300, FilterType::Triangle);
            let mut out = Cursor::new(Vec::new());
            if thumb.write_to(&mut out, image::ImageFormat::Jpeg).is_ok() {
                let thumb_bytes = out.into_inner();
                let _ = fs::write(&cached_path, &thumb_bytes);
                return Some((thumb_bytes, "image/jpeg"));
            }
        }

        None
    }
}
