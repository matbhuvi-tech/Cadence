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
