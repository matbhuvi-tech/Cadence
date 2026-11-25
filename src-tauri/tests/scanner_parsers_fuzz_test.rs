use cadence_core_lib::scanner::dsd::{
    extract_original_album, extract_original_year, is_dsd_path, probe_dsd_as, probe_dsd_file,
};
use cadence_core_lib::scanner::media::{
    find_local_cover_art, inspect, is_artwork_subdir_name, is_cover_image_extension,
    is_multidisc_subfolder_name, rank_cover_filename,
};
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use proptest::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cadence_scanner_test_{}_{}",
        label,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_id3v23_title(title: &str) -> Vec<u8> {
    let mut value = vec![3u8]; // UTF-8
    value.extend_from_slice(title.as_bytes());
    let mut frame = Vec::new();
    frame.extend_from_slice(b"TIT2");
    frame.extend_from_slice(&(value.len() as u32).to_be_bytes());
    frame.extend_from_slice(&[0u8, 0u8]);
    frame.extend_from_slice(&value);

    let n = frame.len();
    let syncsafe = [
        ((n >> 21) & 0x7F) as u8,
        ((n >> 14) & 0x7F) as u8,
        ((n >> 7) & 0x7F) as u8,
        (n & 0x7F) as u8,
    ];
    let mut tag = Vec::new();
    tag.extend_from_slice(b"ID3\x03\x00\x00");
    tag.extend_from_slice(&syncsafe);
    tag.extend_from_slice(&frame);
    tag
}

fn build_valid_dsf(sample_rate: u32, channels: u32, payload_bytes: usize, title: Option<&str>) -> Vec<u8> {
    let payload = vec![0x55u8; payload_bytes];
    let sample_count: u64 = (payload_bytes as u64 * 8) / u64::from(channels);
    let tag = title.map(build_id3v23_title).unwrap_or_default();
    let fmt_size: u64 = 52;
    let data_chunk_size: u64 = 12 + payload.len() as u64;
    let metadata_offset: u64 = if tag.is_empty() {
        0
    } else {
        28 + fmt_size + data_chunk_size
    };
    let total_size: u64 = 28 + fmt_size + data_chunk_size + tag.len() as u64;

    let mut out = Vec::with_capacity(total_size as usize);
    out.extend_from_slice(b"DSD ");
    out.extend_from_slice(&28u64.to_le_bytes());
    out.extend_from_slice(&total_size.to_le_bytes());
    out.extend_from_slice(&metadata_offset.to_le_bytes());

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&fmt_size.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes()); // format version
    out.extend_from_slice(&0u32.to_le_bytes()); // format id (DSD raw)
    out.extend_from_slice(&2u32.to_le_bytes()); // channel type (stereo)
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes()); // bits per sample
    out.extend_from_slice(&sample_count.to_le_bytes());
    out.extend_from_slice(&4096u32.to_le_bytes()); // block size per channel
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_chunk_size.to_le_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&tag);
    out
}

fn dff_chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12 + data.len() + 1);
    buf.extend_from_slice(id);
    buf.extend_from_slice(&(data.len() as u64).to_be_bytes());
    buf.extend_from_slice(data);
    if data.len() % 2 == 1 {
        buf.push(0);
    }
    buf
}

fn build_valid_dff(sample_rate: u32, channels: u16, payload_len: usize, title: Option<&str>) -> Vec<u8> {
    let mut chnl_data = Vec::new();
    chnl_data.extend_from_slice(&channels.to_be_bytes());
    for _ in 0..channels {
        chnl_data.extend_from_slice(b"SLFT");
    }

    let mut props = Vec::new();
    props.extend_from_slice(b"SND ");
    props.extend_from_slice(&dff_chunk(b"FS  ", &sample_rate.to_be_bytes()));
    props.extend_from_slice(&dff_chunk(b"CHNL", &chnl_data));
    props.extend_from_slice(&dff_chunk(b"CMPR", b"DSD \x00"));

    let mut body = Vec::new();
    body.extend_from_slice(b"DSD ");
    body.extend_from_slice(&dff_chunk(b"FVER", &[1, 5, 0, 0]));
    body.extend_from_slice(&dff_chunk(b"PROP", &props));
    body.extend_from_slice(&dff_chunk(b"DSD ", &vec![0xAAu8; payload_len]));
    if let Some(t) = title {
        body.extend_from_slice(&dff_chunk(b"ID3 ", &build_id3v23_title(t)));
    }

    let mut out = Vec::new();
    out.extend_from_slice(b"FRM8");
    out.extend_from_slice(&(body.len() as u64).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

fn build_valid_wav(sample_rate: u32, bits: u16, channels: u16, frames: u32) -> Vec<u8> {
    let block_align = channels * (bits / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_bytes = frames * u32::from(block_align);
    let riff_size = 36 + data_bytes;

    let mut out = Vec::with_capacity((44 + data_bytes) as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    out.resize(out.len() + data_bytes as usize, 0);
    out
}

#[test]
fn dsf_ground_truth_headers_and_embedded_id3() {
    let dir = temp_dir("dsf_valid");
    let path = dir.join("dsd256.dsf");
    // DSD256 = 11,289,600 Hz, stereo -> 28,224 bytes = 112,896 samples/ch = 0.01s
    let bytes = build_valid_dsf(11_289_600, 2, 28_224, Some("DSD256 Reference"));
    fs::write(&path, bytes).unwrap();

    assert!(is_dsd_path(&path));
    let probed = probe_dsd_file(&path).expect("valid DSF must parse");
    assert_eq!(probed.sample_rate, Some(11_289_600));
    assert_eq!(probed.channels, Some(2));
    assert_eq!(probed.bit_depth, Some(1));
    assert!((probed.duration_secs - 0.01).abs() < 0.001);

    let meta = inspect(&path, "dsf").expect("media::inspect must parse DSF");
    assert_eq!(meta.title, "DSD256 Reference");
    assert_eq!(meta.sample_rate, Some(11_289_600));
    assert_eq!(meta.bit_depth, Some(1));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn dff_ground_truth_headers_and_embedded_id3() {
    let dir = temp_dir("dff_valid");
    let path = dir.join("dsd128.dff");
    // DSD128 = 5,644,800 Hz, stereo -> 1 second = 5,644,800 * 2 / 8 = 1,411,200 bytes; 0.01s = 14,112 bytes
    let bytes = build_valid_dff(5_644_800, 2, 14_112, Some("DSD128 DFF Reference"));
    fs::write(&path, bytes).unwrap();

    assert!(is_dsd_path(&path));
    let probed = probe_dsd_file(&path).expect("valid DFF must parse");
    assert_eq!(probed.sample_rate, Some(5_644_800));
    assert_eq!(probed.channels, Some(2));
    assert_eq!(probed.bit_depth, Some(1));
    assert!((probed.duration_secs - 0.01).abs() < 0.002);

    let meta = inspect(&path, "dff").expect("media::inspect must parse DFF");
    assert_eq!(meta.title, "DSD128 DFF Reference");
    assert_eq!(meta.sample_rate, Some(5_644_800));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn wav_ground_truth_pcm_inspection() {
    let dir = temp_dir("wav_valid");
    let path = dir.join("hi_res.wav");
    // 96kHz 24-bit stereo, 0.25s = 24,000 frames
    let bytes = build_valid_wav(96_000, 24, 2, 24_000);
    fs::write(&path, bytes).unwrap();

    let meta = inspect(&path, "wav").expect("valid WAV must parse");
    assert_eq!(meta.sample_rate, Some(96_000));
    assert_eq!(meta.bit_depth, Some(24));
    assert_eq!(meta.channels, Some(2));
    assert!((meta.duration - 0.25).abs() < 0.01);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn malformed_dsd_and_wav_files_fail_gracefully_without_panicking() {
    let dir = temp_dir("malformed");
    let cases: &[(&str, &[u8])] = &[
        ("empty.dsf", b""),
        ("short.dsf", b"DSD \x1c\x00"),
        ("bad_offset.dsf", b"DSD \x1c\x00\x00\x00\x00\x00\x00\x00\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"),
        ("empty.dff", b""),
        ("bad_frm8.dff", b"FRM8\xff\xff\xff\xff\xff\xff\xff\xffDSD "),
        ("corrupt.wav", b"RIFF\x04\x00\x00\x00WAVEfmt "),
    ];

    for (name, content) in cases {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        let ext = Path::new(name).extension().unwrap().to_str().unwrap();
        if ext == "dsf" || ext == "dff" {
            assert!(probe_dsd_as(&path, ext).is_none(), "corrupt {name} must return None");
        }
        assert!(inspect(&path, ext).is_err(), "corrupt {name} must return Err");
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn original_year_album_and_cover_ranking_helpers() {
    let mut tag = Tag::new(TagType::Id3v2);
    tag.insert_text(ItemKey::OriginalReleaseDate, "1959-08-17".to_string());
    tag.insert_text(ItemKey::OriginalAlbumTitle, "Kind of Blue".to_string());
    assert_eq!(extract_original_year(&tag), Some(1959));
    assert_eq!(extract_original_album(&tag).as_deref(), Some("Kind of Blue"));

    let mut custom_tag = Tag::new(TagType::Id3v2);
    custom_tag.insert_unchecked(TagItem::new(
        ItemKey::Unknown("ORIGINALYEAR".to_string()),
        ItemValue::Text("1973".to_string()),
    ));
    assert_eq!(extract_original_year(&custom_tag), Some(1973));

    assert!(is_cover_image_extension("jpg"));
    assert!(is_cover_image_extension("PNG"));
    assert!(!is_cover_image_extension("flac"));
    assert!(is_artwork_subdir_name("Artwork"));
    assert!(is_multidisc_subfolder_name("CD 2"));
    assert!(rank_cover_filename("cover.jpg", false) < rank_cover_filename("folder.jpg", false));

    let dir = temp_dir("cover_art");
    fs::write(dir.join("back.jpg"), b"fake").unwrap();
    fs::write(dir.join("cover.png"), b"fake").unwrap();
    let found = find_local_cover_art(&dir).expect("should find cover.png");
    assert!(found.ends_with("cover.png"));
    let _ = fs::remove_dir_all(&dir);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn fuzz_dsf_parser_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
        let dir = temp_dir("fuzz_dsf");
        let path = dir.join("fuzz.dsf");
        fs::write(&path, &bytes).unwrap();
        let _ = probe_dsd_as(&path, "dsf");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuzz_dff_parser_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
        let dir = temp_dir("fuzz_dff");
        let path = dir.join("fuzz.dff");
        fs::write(&path, &bytes).unwrap();
        let _ = probe_dsd_as(&path, "dff");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuzz_wav_inspector_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
        let dir = temp_dir("fuzz_wav");
        let path = dir.join("fuzz.wav");
        fs::write(&path, &bytes).unwrap();
        let _ = inspect(&path, "wav");
        let _ = fs::remove_dir_all(&dir);
    }
}
