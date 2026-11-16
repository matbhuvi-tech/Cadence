use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use lofty::config::ParseOptions;
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::tag::{ItemKey, Tag, TagType};

const MAX_ID3_TAG_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DFF_CHUNKS: usize = 128;
const MAX_DFF_PROP_BYTES: u64 = 64 * 1024;

/// Audio stream properties and optional parsed ID3v2 tag recovered directly from DSD containers (`.dsf` / `.dff`).
pub struct DsdProbeResult {
    pub channels: Option<u16>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub duration_secs: f64,
    pub tag: Option<Tag>,
}

/// Returns true when `path` has a DSD container extension (`.dsf`, `.dff`, `.dsdiff`).
pub fn is_dsd_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            ext.eq_ignore_ascii_case("dsf")
                || ext.eq_ignore_ascii_case("dff")
                || ext.eq_ignore_ascii_case("dsdiff")
        })
        .unwrap_or(false)
}

/// Parses DSD container properties and embedded ID3v2 metadata without reading the multi-hundred-MB audio payload.
pub fn probe_dsd_file(path: &Path) -> Option<DsdProbeResult> {
    probe_dsd_as(path, path.extension()?.to_str()?)
}

pub fn probe_dsd_as(path: &Path, ext: &str) -> Option<DsdProbeResult> {
    if ext.eq_ignore_ascii_case("dsf") {
        probe_dsf(path)
    } else if ext.eq_ignore_ascii_case("dff") || ext.eq_ignore_ascii_case("dsdiff") {
        probe_dff(path)
    } else {
        None
    }
}

/// Extracts `original_year` from either standard `OriginalReleaseDate` (`TDOR`) or `TXXX:ORIGINALYEAR` frames.
pub fn extract_original_year(tag: &Tag) -> Option<i32> {
    if let Some(year) = tag
        .get_string(&ItemKey::OriginalReleaseDate)
        .and_then(parse_leading_year)
    {
        return Some(year);
    }

    for item in tag.items() {
        let key_desc = match item.key() {
            ItemKey::Unknown(desc) => desc.as_str(),
            _ => continue,
        };
        if key_desc.eq_ignore_ascii_case("ORIGINALYEAR")
            || key_desc.eq_ignore_ascii_case("ORIGINAL_YEAR")
            || key_desc.eq_ignore_ascii_case("ORIGINAL YEAR")
            || key_desc.eq_ignore_ascii_case("----:com.apple.iTunes:ORIGINALYEAR")
        {
            if let Some(year) = item.value().text().and_then(parse_leading_year) {
                return Some(year);
            }
        }
    }

    None
}

/// Extracts `original_album` from standard `OriginalAlbumTitle` (`TOAL`) or custom Vorbis/MP4/TXXX frames.
pub fn extract_original_album(tag: &Tag) -> Option<String> {
    if let Some(album) = tag.get_string(&ItemKey::OriginalAlbumTitle) {
        let trimmed = album.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    for item in tag.items() {
        let key_desc = match item.key() {
            ItemKey::Unknown(desc) => desc.as_str(),
            _ => continue,
        };
        if key_desc.eq_ignore_ascii_case("ORIGINALALBUM")
            || key_desc.eq_ignore_ascii_case("ORIGINAL_ALBUM")
            || key_desc.eq_ignore_ascii_case("ORIGINAL ALBUM")
            || key_desc.eq_ignore_ascii_case("----:com.apple.iTunes:ORIGINALALBUM")
        {
            if let Some(album) = item.value().text() {
                let trimmed = album.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn parse_leading_year(raw: &str) -> Option<i32> {
    let digits: String = raw.trim().chars().take(4).collect();
    if digits.len() == 4 && digits.chars().all(|c| c.is_ascii_digit()) {
        digits.parse::<i32>().ok()
    } else {
        None
    }
}

fn probe_dsf(path: &Path) -> Option<DsdProbeResult> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut header = [0u8; 92];
    file.read_exact(&mut header).ok()?;
    if &header[..4] != b"DSD " || &header[28..32] != b"fmt " || &header[80..84] != b"data" {
        return None;
    }
    let u32_at = |n| u32::from_le_bytes(header[n..n + 4].try_into().unwrap());
    let u64_at = |n| u64::from_le_bytes(header[n..n + 8].try_into().unwrap());
    let metadata_offset = u64_at(20);
    let channels = u32_at(52);
    let sample_rate = u32_at(56);
    let bits = u32_at(60);
    let count = u64_at(64);
    let data_size = u64_at(84);
    if u64_at(4) != 28
        || u64_at(32) != 52
        || u64_at(12) != len
        || !(1..=32).contains(&channels)
        || sample_rate == 0
        || !matches!(bits, 1 | 8)
        || data_size < 12
        || data_size.checked_add(80)? > len
        || count.checked_mul(channels as u64)?.div_ceil(8) > data_size - 12
        || (metadata_offset != 0 && (metadata_offset < 80 + data_size || metadata_offset >= len))
    {
        return None;
    }
    let tag = if metadata_offset > 0 {
        read_id3v2_at_offset(path, metadata_offset, None)
    } else {
        None
    };

    Some(DsdProbeResult {
        channels: Some(channels as u16),
        sample_rate: Some(sample_rate),
        bit_depth: Some(1),
        duration_secs: count as f64 / sample_rate as f64,
        tag,
    })
}

fn probe_dff(path: &Path) -> Option<DsdProbeResult> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    if file_len < 16 {
        return None;
    }

    let mut form_hdr = [0u8; 16];
    file.read_exact(&mut form_hdr).ok()?;
    if &form_hdr[0..4] != b"FRM8" || &form_hdr[12..16] != b"DSD " {
        return None;
    }

    let form_size = u64::from_be_bytes(form_hdr[4..12].try_into().ok()?);
    let form_end = 12u64.checked_add(form_size)?;
    if form_end > file_len || form_end < 16 {
        return None;
    }

    let mut channels: Option<u16> = None;
    let mut sample_rate: Option<u32> = None;
    let mut dsd_audio_bytes: Option<u64> = None;
    let mut dst_duration_secs: Option<f64> = None;
    let mut id3_tag: Option<Tag> = None;

    let mut pos: u64 = 16;
    for _ in 0..MAX_DFF_CHUNKS {
        if pos + 12 > form_end {
            break;
        }

        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut chunk_hdr = [0u8; 12];
        if file.read_exact(&mut chunk_hdr).is_err() {
            break;
        }

        // Handle EA IFF word-alignment padding after odd-sized chunks.
        if chunk_hdr[0] == 0 && pos + 13 <= form_end {
            pos += 1;
            file.seek(SeekFrom::Start(pos)).ok()?;
            if file.read_exact(&mut chunk_hdr).is_err() {
                break;
            }
        }

        let chunk_id = &chunk_hdr[0..4];
        if !chunk_id.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
            break;
        }

        let chunk_size = u64::from_be_bytes(chunk_hdr[4..12].try_into().ok()?);
        let data_start = pos + 12;
        let data_end = data_start.checked_add(chunk_size)?;
        if data_end > form_end {
            return None;
        }

        match chunk_id {
            b"PROP" => {
                let to_read = chunk_size.min(MAX_DFF_PROP_BYTES) as usize;
                if to_read >= 4 {
                    let mut prop_buf = vec![0u8; to_read];
                    if file.read_exact(&mut prop_buf).is_ok() && &prop_buf[0..4] == b"SND " {
                        parse_dff_snd_props(&prop_buf[4..], &mut sample_rate, &mut channels);
                    }
                }
            }
            b"DSD " => {
                dsd_audio_bytes = Some(chunk_size);
            }
            b"DST " => {
                if dst_duration_secs.is_none() && chunk_size >= 18 {
                    let mut frte_hdr = [0u8; 18];
                    if file.read_exact(&mut frte_hdr).is_ok() && &frte_hdr[0..4] == b"FRTE" {
                        let sub_size =
                            u64::from_be_bytes(frte_hdr[4..12].try_into().unwrap_or([0; 8]));
                        if sub_size >= 6 {
                            let num_frames =
                                u32::from_be_bytes(frte_hdr[12..16].try_into().unwrap_or([0; 4]));
                            let frame_rate =
                                u16::from_be_bytes(frte_hdr[16..18].try_into().unwrap_or([0; 2]));
                            if frame_rate > 0 {
                                dst_duration_secs = Some(num_frames as f64 / frame_rate as f64);
                            }
                        }
                    }
                }
            }
            b"ID3 " => {
                if id3_tag.is_none() {
                    id3_tag = read_id3v2_at_offset(path, data_start, Some(chunk_size));
                }
            }
            _ => {}
        }

        if data_end <= pos {
            break;
        }
        pos = data_end;
    }

    // Some DSDIFF taggers append a bare ID3v2 block immediately after the FRM8 container.
    if id3_tag.is_none() && form_end + 10 <= file_len {
        id3_tag = read_id3v2_at_offset(path, form_end, None);
    }

    if sample_rate.unwrap_or(0) == 0
        || channels.unwrap_or(0) == 0
        || (dsd_audio_bytes.is_none() && dst_duration_secs.is_none())
    {
        return None;
    }

    let duration_secs = if let Some(dur) = dst_duration_secs {
        dur
    } else if let (Some(bytes), Some(sr), Some(ch)) = (dsd_audio_bytes, sample_rate, channels) {
        if sr > 0 && ch > 0 {
            (bytes as f64 * 8.0) / (sr as f64 * ch as f64)
        } else {
            0.0
        }
    } else {
        0.0
    };

    Some(DsdProbeResult {
        channels,
        sample_rate,
        bit_depth: Some(1),
        duration_secs,
        tag: id3_tag,
    })
}

fn parse_dff_snd_props(buf: &[u8], sample_rate: &mut Option<u32>, channels: &mut Option<u16>) {
    let mut sub = 0usize;
    while sub + 12 <= buf.len() {
        let sub_id = &buf[sub..sub + 4];
        let sub_size = u64::from_be_bytes(buf[sub + 4..sub + 12].try_into().unwrap_or([0; 8]));
        let val_start = sub + 12;
        let Ok(sub_size_usize) = usize::try_from(sub_size) else {
            break;
        };
        let Some(val_end) = val_start.checked_add(sub_size_usize) else {
            break;
        };
        if val_end > buf.len() {
            break;
        }

        match sub_id {
            b"FS  " if sub_size_usize >= 4 => {
                *sample_rate = Some(u32::from_be_bytes(
                    buf[val_start..val_start + 4].try_into().unwrap_or([0; 4]),
                ));
            }
            b"CHNL" if sub_size_usize >= 2 => {
                *channels = Some(u16::from_be_bytes(
                    buf[val_start..val_start + 2].try_into().unwrap_or([0; 2]),
                ));
            }
            _ => {}
        }

        sub = val_end;
    }
}

/// Reads an ID3v2 tag starting at `offset` without touching surrounding audio bytes.
fn read_id3v2_at_offset(path: &Path, offset: u64, max_len: Option<u64>) -> Option<Tag> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    if offset.saturating_add(10) > file_len {
        return None;
    }

    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut id3_hdr = [0u8; 10];
    file.read_exact(&mut id3_hdr).ok()?;
    if &id3_hdr[0..3] != b"ID3" {
        return None;
    }

    if id3_hdr[6..10].iter().any(|&b| b >= 0x80) {
        return None;
    }

    let body_size = ((id3_hdr[6] as u64) << 21)
        | ((id3_hdr[7] as u64) << 14)
        | ((id3_hdr[8] as u64) << 7)
        | (id3_hdr[9] as u64);
    let footer_size = if id3_hdr[5] & 0x10 != 0 { 10 } else { 0 };
    let declared_total = 10u64.saturating_add(body_size).saturating_add(footer_size);

    let avail = file_len.saturating_sub(offset);
    let max_allowed = max_len.unwrap_or(MAX_ID3_TAG_BYTES).min(MAX_ID3_TAG_BYTES);
    let total_len = declared_total.min(avail).min(max_allowed);
    if total_len < 10 {
        return None;
    }

    let body_to_read = (total_len - 10) as usize;
    // Append 160 zero bytes so MpegFile's tail ID3v1/Lyrics3/APE seeks succeed on compact tags.
    let mut buf = vec![0u8; 10 + body_to_read + 160];
    buf[..10].copy_from_slice(&id3_hdr);
    if body_to_read > 0 {
        file.read_exact(&mut buf[10..10 + body_to_read]).ok()?;
    }

    let mpeg = lofty::mpeg::MpegFile::read_from(
        &mut Cursor::new(&buf),
        ParseOptions::new().read_properties(false),
    )
    .ok()?;
    let tagged: TaggedFile = mpeg.into();
    tagged
        .tag(TagType::Id3v2)
        .cloned()
        .or_else(|| tagged.primary_tag().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::Accessor;
    use std::io::Write;
    use std::path::PathBuf;

    struct TempTestFile {
        path: PathBuf,
    }

    impl TempTestFile {
        fn new(ext: &str, bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "cadence_dsd_test_{}.{}",
                uuid::Uuid::new_v4().simple(),
                ext
            ));
            let mut f = File::create(&path).expect("create temp test file");
            f.write_all(bytes).expect("write temp test file");
            f.flush().expect("flush temp test file");
            Self { path }
        }
    }

    impl Drop for TempTestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn synchsafe_u32(val: u32) -> [u8; 4] {
        [
            ((val >> 21) & 0x7F) as u8,
            ((val >> 14) & 0x7F) as u8,
            ((val >> 7) & 0x7F) as u8,
            (val & 0x7F) as u8,
        ]
    }

    fn id3v24_text_frame(id: &[u8; 4], value: &str) -> Vec<u8> {
        let mut payload = Vec::with_capacity(1 + value.len());
        payload.push(3); // UTF-8
        payload.extend_from_slice(value.as_bytes());
        let mut frame = Vec::with_capacity(10 + payload.len());
        frame.extend_from_slice(id);
        frame.extend_from_slice(&synchsafe_u32(payload.len() as u32));
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&payload);
        frame
    }

    fn id3v24_txxx_frame(desc: &str, value: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(3); // UTF-8
        payload.extend_from_slice(desc.as_bytes());
        payload.push(0);
        payload.extend_from_slice(value.as_bytes());
        let mut frame = Vec::with_capacity(10 + payload.len());
        frame.extend_from_slice(b"TXXX");
        frame.extend_from_slice(&synchsafe_u32(payload.len() as u32));
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&payload);
        frame
    }

    fn id3v24_apic_frame() -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0); // Latin-1
        payload.extend_from_slice(b"image/jpeg\0");
        payload.push(3); // Front cover
        payload.push(0); // Empty description
        payload.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
        let mut frame = Vec::with_capacity(10 + payload.len());
        frame.extend_from_slice(b"APIC");
        frame.extend_from_slice(&synchsafe_u32(payload.len() as u32));
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&payload);
        frame
    }

    fn build_id3v24_tag() -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&id3v24_text_frame(b"TIT2", "Aila Aila"));
        body.extend_from_slice(&id3v24_text_frame(b"TPE1", "Aditya & Natalie Di Luccio"));
        body.extend_from_slice(&id3v24_text_frame(b"TALB", "I (Sony)"));
        body.extend_from_slice(&id3v24_text_frame(b"TPE2", "A. R. Rahman"));
        body.extend_from_slice(&id3v24_text_frame(b"TCOM", "A. R. Rahman"));
        body.extend_from_slice(&id3v24_text_frame(b"TDRC", "2014"));
        body.extend_from_slice(&id3v24_text_frame(b"TRCK", "5/7"));
        body.extend_from_slice(&id3v24_text_frame(b"TPOS", "1/1"));
        body.extend_from_slice(&id3v24_text_frame(b"TCON", "OST"));
        body.extend_from_slice(&id3v24_txxx_frame("ORIGINALYEAR", "2014"));
        body.extend_from_slice(&id3v24_txxx_frame("DYNAMIC RANGE (DR)", "6"));
        body.extend_from_slice(&id3v24_apic_frame());

        let mut tag = Vec::with_capacity(10 + body.len());
        tag.extend_from_slice(b"ID3");
        tag.extend_from_slice(&[4, 0, 0]);
        tag.extend_from_slice(&synchsafe_u32(body.len() as u32));
        tag.extend_from_slice(&body);
        tag
    }

    #[test]
    fn test_probe_dsf_reads_header_and_trailing_id3v2() {
        let id3 = build_id3v24_tag();
        let data_chunk_len: u64 = 12 + (11_289_600u64 * 10 * 2 / 8);
        let metadata_offset: u64 = 80 + data_chunk_len;
        let total_size: u64 = metadata_offset + id3.len() as u64;

        let sample_rate: u32 = 11_289_600;
        let sample_count: u64 = 11_289_600 * 10; // 10 seconds

        let mut dsf = Vec::new();
        // DSD chunk (28 bytes)
        dsf.extend_from_slice(b"DSD ");
        dsf.extend_from_slice(&28u64.to_le_bytes());
        dsf.extend_from_slice(&total_size.to_le_bytes());
        dsf.extend_from_slice(&metadata_offset.to_le_bytes());
        // fmt chunk (52 bytes)
        dsf.extend_from_slice(b"fmt ");
        dsf.extend_from_slice(&52u64.to_le_bytes());
        dsf.extend_from_slice(&1u32.to_le_bytes()); // version
        dsf.extend_from_slice(&0u32.to_le_bytes()); // format id
        dsf.extend_from_slice(&2u32.to_le_bytes()); // channel type
        dsf.extend_from_slice(&2u32.to_le_bytes()); // channels
        dsf.extend_from_slice(&sample_rate.to_le_bytes());
        dsf.extend_from_slice(&1u32.to_le_bytes()); // bits per sample
        dsf.extend_from_slice(&sample_count.to_le_bytes());
        dsf.extend_from_slice(&4096u32.to_le_bytes()); // block size
        dsf.extend_from_slice(&0u32.to_le_bytes()); // reserved
                                                    // data chunk (16 bytes)
        dsf.extend_from_slice(b"data");
        dsf.extend_from_slice(&data_chunk_len.to_le_bytes());
        dsf.resize(dsf.len() + (data_chunk_len - 12) as usize, 0);
        // ID3v2 chunk
        dsf.extend_from_slice(&id3);

        let tmp = TempTestFile::new("dsf", &dsf);

        let probed = probe_dsd_file(&tmp.path).expect("DSF should probe");
        assert_eq!(probed.channels, Some(2));
        assert_eq!(probed.sample_rate, Some(11_289_600));
        assert_eq!(probed.bit_depth, Some(1));
        assert!((probed.duration_secs - 10.0).abs() < 1e-6);

        let tag = probed.tag.expect("DSF ID3v2 tag should be parsed");
        assert_eq!(tag.title().as_deref(), Some("Aila Aila"));
        assert_eq!(tag.artist().as_deref(), Some("Aditya & Natalie Di Luccio"));
        assert_eq!(tag.album().as_deref(), Some("I (Sony)"));
        assert_eq!(tag.get_string(&ItemKey::AlbumArtist), Some("A. R. Rahman"));
        assert_eq!(tag.get_string(&ItemKey::Composer), Some("A. R. Rahman"));
        assert_eq!(tag.year(), Some(2014));
        assert_eq!(tag.track(), Some(5));
        assert_eq!(tag.disk(), Some(1));
        assert_eq!(tag.genre().as_deref(), Some("OST"));
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(extract_original_year(&tag), Some(2014));
        #[cfg(feature = "desktop")]
        assert_eq!(
            crate::scanner::engine::calculate_dr_score(
                Some(&tag),
                Some(1),
                10.0,
                Some(11_289_600),
                "DSF",
                "test.dsf"
            ),
            6
        );
    }

    #[test]
    fn test_probe_dff_reads_prop_dsd_and_id3_chunk() {
        let id3 = build_id3v24_tag();

        // PROP chunk payload: "SND " + FS (16 bytes) + CHNL (14 bytes)
        let mut prop_body = Vec::new();
        prop_body.extend_from_slice(b"SND ");
        prop_body.extend_from_slice(b"FS  ");
        prop_body.extend_from_slice(&4u64.to_be_bytes());
        prop_body.extend_from_slice(&2_822_400u32.to_be_bytes());
        prop_body.extend_from_slice(b"CHNL");
        prop_body.extend_from_slice(&2u64.to_be_bytes());
        prop_body.extend_from_slice(&2u16.to_be_bytes());

        // 2 seconds of stereo DSD64: 2 * 2,822,400 * 2 bits / 8 = 1,411,200 bytes.
        let dsd_audio_size: u64 = 1_411_200;
        let mut body = Vec::new();
        body.extend_from_slice(b"DSD ");
        body.extend_from_slice(b"PROP");
        body.extend_from_slice(&(prop_body.len() as u64).to_be_bytes());
        body.extend_from_slice(&prop_body);

        body.extend_from_slice(b"DSD ");
        body.extend_from_slice(&dsd_audio_size.to_be_bytes());
        let dsd_data_pos = body.len();
        body.resize(dsd_data_pos + dsd_audio_size as usize, 0);

        body.extend_from_slice(b"ID3 ");
        body.extend_from_slice(&(id3.len() as u64).to_be_bytes());
        body.extend_from_slice(&id3);

        let mut dff = Vec::with_capacity(12 + body.len());
        dff.extend_from_slice(b"FRM8");
        dff.extend_from_slice(&(body.len() as u64).to_be_bytes());
        dff.extend_from_slice(b"DSD ");
        dff.extend_from_slice(&body[4..]);

        let tmp = TempTestFile::new("dff", &dff);

        let probed = probe_dsd_file(&tmp.path).expect("DFF should probe");
        assert_eq!(probed.channels, Some(2));
        assert_eq!(probed.sample_rate, Some(2_822_400));
        assert_eq!(probed.bit_depth, Some(1));
        assert!((probed.duration_secs - 2.0).abs() < 1e-6);

        let tag = probed.tag.expect("DFF ID3 chunk should be parsed");
        assert_eq!(tag.title().as_deref(), Some("Aila Aila"));
        assert_eq!(tag.get_string(&ItemKey::AlbumArtist), Some("A. R. Rahman"));
    }
}
