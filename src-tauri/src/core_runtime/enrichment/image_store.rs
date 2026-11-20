use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;

pub const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 64_000_000;
pub const MAX_SERVING_JPEG_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct DecodedImageMeta {
    pub hash: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
    pub serving_jpeg: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ImageStore {
    root: PathBuf,
}

impl ImageStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &PathBuf {
        &self.root
    }

    pub fn hash_bytes(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        let mut out = String::with_capacity(16);
        for b in &digest[..8] {
            use std::fmt::Write;
            let _ = write!(&mut out, "{b:02x}");
        }
        out
    }

    pub fn valid_hash(hash: &str) -> bool {
        hash.len() == 16
            && hash
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    pub fn ext_for_mime(mime: &str) -> &'static str {
        match mime {
            "image/jpeg" => ".jpg",
            "image/png" => ".png",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            _ => ".img",
        }
    }

    pub fn path_for(&self, hash: &str, mime: &str) -> Result<PathBuf, String> {
        if !Self::valid_hash(hash) {
            return Err(format!("imagestore: invalid hash '{hash}'"));
        }
        Ok(self
            .root
            .join(&hash[0..2])
            .join(&hash[2..4])
            .join(format!("{hash}{}", Self::ext_for_mime(mime))))
    }

    pub fn inspect_and_prepare(bytes: &[u8]) -> Result<DecodedImageMeta, String> {
        if bytes.is_empty() {
            return Err("Empty image payload".into());
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!("Image exceeds {MAX_IMAGE_BYTES} byte limit"));
        }
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let fmt = reader
            .format()
            .ok_or_else(|| "Unsupported or unknown image format".to_string())?;
        let mime = match fmt {
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Png => "image/png",
            ImageFormat::WebP => "image/webp",
            _ => return Err(format!("Unsupported image format: {fmt:?}")),
        }
        .to_string();

        let mut limits = Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);

        let img = reader.decode().map_err(|e| e.to_string())?;
        let width = img.width();
        let height = img.height();
        if width == 0 || height == 0 {
            return Err("Image has zero dimension".into());
        }
        if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
            return Err("Image exceeds maximum pixel limit".into());
        }

        let thumb = img.thumbnail(800, 800).to_rgb8();
        let mut serving_jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut serving_jpeg, 85)
            .encode_image(&thumb)
            .map_err(|e| e.to_string())?;
        if serving_jpeg.len() > MAX_SERVING_JPEG_BYTES {
            return Err("Compressed serving JPEG exceeded limit".into());
        }

        Ok(DecodedImageMeta {
            hash: Self::hash_bytes(bytes),
            mime,
            width,
            height,
            size_bytes: bytes.len(),
            serving_jpeg,
        })
    }

    pub fn store_bytes(&self, bytes: &[u8]) -> Result<DecodedImageMeta, String> {
        let meta = Self::inspect_and_prepare(bytes)?;
        let dst = self.path_for(&meta.hash, &meta.mime)?;
        if dst.is_file() {
            return Ok(meta);
        }
        let parent = dst
            .parent()
            .ok_or_else(|| "Missing ImageStore shard directory".to_string())?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let tmp = parent.join(format!(".{}.tmp-{}", meta.hash, uuid::Uuid::new_v4()));
        let write_res = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, &dst)?;
            Ok(())
        })();
        if write_res.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        write_res.map_err(|e| e.to_string())?;
        Ok(meta)
    }

    pub fn open_bytes(&self, hash: &str, mime: &str) -> Result<Vec<u8>, String> {
        let path = self.path_for(hash, mime)?;
        fs::read(&path).map_err(|e| e.to_string())
    }
}
