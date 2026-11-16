//! Conservative real tag writer. Formats without a qualified payload verifier fail closed.
//! All edits are prepared and reread in RAM before any original file is replaced.
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::tag::{ItemKey, ItemValue, Tag, TagExt, TagItem, TagType};
use sha2::{Digest, Sha256};
use std::io::Cursor;

pub fn writable(bytes: &[u8]) -> Result<FileType, String> {
    let file = lofty::probe::Probe::new(Cursor::new(bytes))
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let kind = file.file_type();
    if !matches!(
        kind,
        FileType::Flac | FileType::Wav | FileType::Mpeg | FileType::Mp4 | FileType::Aiff
    ) || !kind.supports_tag_type(kind.primary_tag_type())
    {
        return Err("No qualified embedded tag writer for this container".into());
    }
    payload_digest(bytes, kind)?;
    Ok(kind)
}

pub fn key(field: &str) -> Result<ItemKey, String> {
    Ok(match field {
        "title" => ItemKey::TrackTitle,
        "artist" | "artistCredit" => ItemKey::TrackArtist,
        "album" | "albumTitle" => ItemKey::AlbumTitle,
        "albumArtist" => ItemKey::AlbumArtist,
        "composer" | "composerName" => ItemKey::Composer,
        "genre" => ItemKey::Genre,
        "originalAlbum" => ItemKey::OriginalAlbumTitle,
        "originalYear" => ItemKey::OriginalReleaseDate,
        "lyrics" => ItemKey::Lyrics,
        _ => return Err(format!("Unsupported metadata field: {field}")),
    })
}

fn tag_key(tag_type: TagType, field: &str) -> Result<(ItemKey, bool), String> {
    match (tag_type, field) {
        (TagType::VorbisComments, "originalAlbum") => {
            Ok((ItemKey::Unknown("ORIGINALALBUM".into()), true))
        }
        (TagType::Mp4Ilst, "originalAlbum") => Ok((
            ItemKey::Unknown("----:com.apple.iTunes:ORIGINALALBUM".into()),
            true,
        )),
        (TagType::Mp4Ilst, "originalYear") => Ok((
            ItemKey::Unknown("----:com.apple.iTunes:ORIGINALYEAR".into()),
            true,
        )),
        _ => Ok((key(field)?, false)),
    }
}

fn set_tag_field(tag: &mut Tag, field: &str, value: &str) -> Result<bool, String> {
    let (k, unchecked) = tag_key(tag.tag_type(), field)?;
    if unchecked {
        tag.insert_unchecked(TagItem::new(k, ItemValue::Text(value.to_string())));
        Ok(true)
    } else {
        Ok(tag.insert_text(k, value.to_string()))
    }
}

pub fn prepare(bytes: &[u8], changes: &[(String, String)]) -> Result<Vec<u8>, String> {
    let kind = writable(bytes)?;
    let mut parsed = lofty::probe::Probe::new(Cursor::new(bytes))
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let props = parsed.properties().clone();
    let tag_type = kind.primary_tag_type();
    let mut tag = parsed
        .tag(tag_type)
        .cloned()
        .unwrap_or_else(|| Tag::new(tag_type));
    for (field, value) in changes {
        if !set_tag_field(&mut tag, field, value)? {
            return Err(format!("Tag does not support {field}"));
        }
    }
    parsed.insert_tag(tag.clone());
    let mut output = Cursor::new(bytes.to_vec());
    tag.save_to(&mut output, WriteOptions::default())
        .map_err(|e| e.to_string())?;
    // Keep existing alternate tag families consistent (e.g. WAV RIFF INFO plus
    // ID3v2); otherwise independent readers can legitimately see stale values.
    for existing in parsed.tags() {
        if existing.tag_type() == tag_type {
            continue;
        }
        let mut alternate = existing.clone();
        let mut changed = false;
        for (field, value) in changes {
            changed |= set_tag_field(&mut alternate, field, value)?;
        }
        if changed {
            output.set_position(0);
            alternate
                .save_to(&mut output, WriteOptions::default())
                .map_err(|e| e.to_string())?;
        }
    }
    let result = output.into_inner();
    let reread = lofty::probe::Probe::new(Cursor::new(&result))
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let after = reread.properties();
    if reread.file_type() != kind
        || props.sample_rate() != after.sample_rate()
        || props.bit_depth() != after.bit_depth()
        || props.channels() != after.channels()
        || payload_digest(bytes, kind)? != payload_digest(&result, kind)?
    {
        return Err("Audio payload or container properties changed".into());
    }
    let after_tag = reread.tag(tag_type).ok_or("Written tag missing")?;
    for (field, value) in changes {
        let (k, _) = tag_key(tag_type, field)?;
        if after_tag.get_string(&k) != Some(value.as_str()) {
            return Err(format!("Tag reread mismatch for {field}"));
        }
    }
    Ok(result)
}

/// Hash exact compressed/sample payload plus immutable codec descriptions.
/// Chunk lengths and bounds are checked; metadata bytes and relocation offsets are excluded.
pub fn payload_digest(bytes: &[u8], kind: FileType) -> Result<Vec<u8>, String> {
    let invalid = || "Invalid container structure".to_string();
    let mut hash = Sha256::new();
    let mut found = false;
    match kind {
        FileType::Flac => {
            if !bytes.starts_with(b"fLaC") {
                return Err(invalid());
            }
            let mut pos = 4;
            loop {
                let hdr = bytes.get(pos..pos + 4).ok_or_else(invalid)?;
                let len =
                    (usize::from(hdr[1]) << 16) | (usize::from(hdr[2]) << 8) | usize::from(hdr[3]);
                if (pos == 4 && hdr[0] & 0x7f != 0) || (pos != 4 && hdr[0] & 0x7f == 0) {
                    return Err(invalid());
                }
                let end = pos.checked_add(4 + len).ok_or_else(invalid)?;
                let block = bytes.get(pos + 4..end).ok_or_else(invalid)?;
                if hdr[0] & 0x7f == 0 {
                    if len != 34 {
                        return Err(invalid());
                    }
                    hash.update(block);
                }
                pos = end;
                if hdr[0] & 0x80 != 0 {
                    break;
                }
            }
            let audio = bytes
                .get(pos..)
                .filter(|b| !b.is_empty())
                .ok_or_else(invalid)?;
            hash.update(audio);
            found = true;
        }
        FileType::Wav | FileType::Aiff => {
            let little = kind == FileType::Wav;
            if bytes.len() < 12
                || (little && (&bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE"))
                || (!little
                    && (&bytes[..4] != b"FORM" || !matches!(&bytes[8..12], b"AIFF" | b"AIFC")))
            {
                return Err(invalid());
            }
            let number = |b: &[u8]| {
                if little {
                    u32::from_le_bytes(b.try_into().unwrap())
                } else {
                    u32::from_be_bytes(b.try_into().unwrap())
                }
            };
            let end = number(&bytes[4..8]) as usize + 8;
            if end != bytes.len() {
                return Err(invalid());
            }
            let mut pos = 12usize;
            while pos + 8 <= end {
                let name = &bytes[pos..pos + 4];
                let len = number(&bytes[pos + 4..pos + 8]) as usize;
                let finish = pos.checked_add(8 + len).ok_or_else(invalid)?;
                let data = bytes.get(pos + 8..finish).ok_or_else(invalid)?;
                if matches!(name, b"data" | b"SSND" | b"fmt " | b"COMM") {
                    hash.update(name);
                    hash.update(data);
                }
                if matches!(name, b"data" | b"SSND") {
                    found = true;
                }
                pos = finish + (len & 1);
            }
            if pos != end {
                return Err(invalid());
            }
        }
        FileType::Mpeg => {
            let mut pos = 0usize;
            if bytes.starts_with(b"ID3") {
                let hdr = bytes.get(..10).ok_or_else(invalid)?;
                if hdr[6..10].iter().any(|b| *b > 127) {
                    return Err(invalid());
                }
                let n = hdr[6..10]
                    .iter()
                    .fold(0usize, |a, b| (a << 7) | usize::from(*b));
                pos = 10 + n + if hdr[5] & 0x10 != 0 { 10 } else { 0 };
            }
            let mut end = bytes.len();
            if end >= 128 && &bytes[end - 128..end - 125] == b"TAG" {
                end -= 128;
            }
            let audio = bytes
                .get(pos..end)
                .filter(|a| a.len() >= 4 && a[0] == 255 && a[1] & 0xe0 == 0xe0)
                .ok_or_else(invalid)?;
            hash.update(audio);
            found = true;
        }
        FileType::Mp4 => {
            let mut pos = 0usize;
            while pos + 8 <= bytes.len() {
                let len32 = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap());
                let (len, header) = if len32 == 1 {
                    let n = u64::from_be_bytes(
                        bytes
                            .get(pos + 8..pos + 16)
                            .ok_or_else(invalid)?
                            .try_into()
                            .unwrap(),
                    );
                    (usize::try_from(n).map_err(|_| invalid())?, 16)
                } else if len32 == 0 {
                    (bytes.len() - pos, 8)
                } else {
                    (len32 as usize, 8)
                };
                if len < header {
                    return Err(invalid());
                }
                let end = pos.checked_add(len).ok_or_else(invalid)?;
                let data = bytes.get(pos + header..end).ok_or_else(invalid)?;
                if &bytes[pos + 4..pos + 8] == b"mdat" {
                    if data.is_empty() {
                        return Err(invalid());
                    }
                    hash.update(data);
                    found = true;
                }
                pos = end;
            }
            if pos != bytes.len() {
                return Err(invalid());
            }
        }
        _ => return Err("Payload verifier unavailable".into()),
    }
    if !found {
        return Err("Audio payload missing".into());
    }
    Ok(hash.finalize().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_container_lengths_fail_closed_without_panics() {
        for kind in [
            FileType::Flac,
            FileType::Wav,
            FileType::Aiff,
            FileType::Mpeg,
            FileType::Mp4,
            FileType::Opus,
        ] {
            for bytes in [
                b"".as_slice(),
                b"garbage",
                b"RIFF\xff\xff\xff\xffWAVE",
                b"FORM\xff\xff\xff\xffAIFF",
                b"fLaC\x80\0\0\x22",
                b"ID3\x04\0\0\xff\xff\xff\xff",
                b"\0\0\0\x01mdat\xff\xff\xff\xff\xff\xff\xff\xff",
                b"\0\0\0\x04mdat",
            ] {
                assert!(payload_digest(bytes, kind).is_err(), "{kind:?}: {bytes:?}");
            }
        }
        assert!(writable(b"DSD invalid").is_err());
        assert!(prepare(b"FRM8 invalid", &[("title".into(), "Unsafe".into())]).is_err());
        assert!(key("filePath").is_err());
    }

    #[test]
    fn mp4_extended_and_final_size_boxes_hash_the_exact_payload() {
        let mut extended = Vec::from(1u32.to_be_bytes());
        extended.extend_from_slice(b"mdat");
        extended.extend_from_slice(&20u64.to_be_bytes());
        extended.extend_from_slice(b"DATA");
        let mut final_box = Vec::from(0u32.to_be_bytes());
        final_box.extend_from_slice(b"mdatDATA");
        assert_eq!(
            payload_digest(&extended, FileType::Mp4).unwrap(),
            payload_digest(&final_box, FileType::Mp4).unwrap()
        );
        final_box[8] = b'X';
        assert_ne!(
            payload_digest(&extended, FileType::Mp4).unwrap(),
            payload_digest(&final_box, FileType::Mp4).unwrap()
        );
        assert!(payload_digest(b"\0\0\0\x08free", FileType::Mp4).is_err());
    }
}
