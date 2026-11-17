//! Shared native container inspection, used by headless library indexing.
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey, Tag};
use std::path::Path;

pub struct MediaMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u16>,
    pub tag: Option<Tag>,
}

pub fn inspect(path: &Path, extension: &str) -> Result<MediaMetadata, String> {
    let (duration, sample_rate, bit_depth, channels, tag) =
        if matches!(extension, "dsf" | "dff" | "dsdiff") {
            let parsed =
                super::dsd::probe_dsd_as(path, extension).ok_or("Invalid DSD container")?;
            (
                parsed.duration_secs,
                parsed.sample_rate,
                parsed.bit_depth,
                parsed.channels,
                parsed.tag,
            )
        } else {
            let parsed = lofty::probe::Probe::open(path)
                .map_err(|e| e.to_string())?
                .guess_file_type()
                .map_err(|e| e.to_string())?
                .read()
                .map_err(|e| e.to_string())?;
            let props = parsed.properties();
            (
                props.duration().as_secs_f64(),
                props.sample_rate(),
                props.bit_depth(),
                props.channels().map(u16::from),
                parsed.primary_tag().or_else(|| parsed.first_tag()).cloned(),
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
    })
}

pub fn text(tag: Option<&Tag>, key: ItemKey) -> Option<String> {
    tag.and_then(|t| t.get_string(&key)).map(str::to_string)
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

        let metadata = inspect(&file.0, "wav").expect(
            "a malformed optional RIFF INFO value must not make the WAV unscannable",
        );

        assert_eq!(metadata.sample_rate, Some(44_100));
        assert_eq!(metadata.bit_depth, Some(16));
        assert_eq!(metadata.channels, Some(2));
    }
}
