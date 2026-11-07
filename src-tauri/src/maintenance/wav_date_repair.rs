use std::fs::OpenOptions;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use lofty::config::ParseOptions;
use lofty::error::ErrorKind;
use lofty::id3::v2::{FrameFlags, FrameId, TimestampFrame};

const MAX_ID3_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Default)]
pub(super) struct RepairedDates {
    pub year: bool,
    pub original_year: bool,
}

impl RepairedDates {
    pub fn any(&self) -> bool {
        self.year || self.original_year
    }
}

// Repair only simple RIFF/WAVE ID3 chunks on the staged copy. Keep chunk
// lengths and all non-target frames intact, then let Lofty read the copy again.
pub(super) fn remove_malformed_dates(
    path: &Path,
    year: Option<i64>,
    original_year: Option<i64>,
) -> io::Result<RepairedDates> {
    let valid_year = |year: Option<i64>| year.is_some_and(|year| (1000..=9999).contains(&year));
    let confirmed = RepairedDates { year: valid_year(year), original_year: valid_year(original_year) };
    let mut repaired = RepairedDates::default();
    if !confirmed.any() {
        return Ok(repaired);
    }

    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let mut header = [0; 12];
    file.read_exact(&mut header)?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Ok(repaired);
    }
    let riff_end = 8 + u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap()));
    if riff_end > file.metadata()?.len() {
        return Ok(repaired);
    }

    let mut offset = 12;
    while offset + 8 <= riff_end {
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = [0; 8];
        file.read_exact(&mut chunk)?;
        let size = u64::from(u32::from_le_bytes(chunk[4..].try_into().unwrap()));
        let data = offset + 8;
        offset = data + size + (size & 1);
        if offset > riff_end {
            break;
        }
        if !chunk[..4].eq_ignore_ascii_case(b"id3 ") || !(10..=MAX_ID3_BYTES).contains(&size) {
            continue;
        }

        let mut tag = vec![0; size as usize];
        file.read_exact(&mut tag)?;
        let dates = strip_bad_frames(&mut tag, &confirmed);
        if dates.any() {
            file.seek(SeekFrom::Start(data))?;
            file.write_all(&tag)?;
            repaired.year |= dates.year;
            repaired.original_year |= dates.original_year;
        }
    }
    Ok(repaired)
}

fn synchsafe_size(bytes: [u8; 4]) -> Option<usize> {
    bytes.into_iter().try_fold(0, |size, byte| {
        (byte < 128).then_some((size << 7) | usize::from(byte))
    })
}

fn strip_bad_frames(tag: &mut [u8], confirmed: &RepairedDates) -> RepairedDates {
    let mut repaired = RepairedDates::default();
    let version = tag[3];
    // Extended headers, tag-wide unsynchronization and footers need different offsets.
    if &tag[..3] != b"ID3" || !matches!(version, 3 | 4) || tag[5] != 0 {
        return repaired;
    }
    let Some(size) = synchsafe_size(tag[6..10].try_into().unwrap()) else {
        return repaired;
    };
    let mut end = 10 + size;
    if end > tag.len() {
        return repaired;
    }
    let mut offset = 10;
    while offset + 10 <= end {
        let frame = &tag[offset..offset + 10];
        let size_bytes = frame[4..8].try_into().unwrap();
        let size = if version == 4 {
            let Some(size) = synchsafe_size(size_bytes) else { break };
            size
        } else {
            u32::from_be_bytes(size_bytes) as usize
        };
        let next = offset + 10 + size;
        if frame[..4] == [0; 4] || next > end {
            break;
        }
        let repair = match &frame[..4] {
            b"TDRC" | b"TYER" if confirmed.year => Some(("TDRC", &mut repaired.year)),
            b"TDOR" | b"TORY" if confirmed.original_year => Some(("TDOR", &mut repaired.original_year)),
            _ => None,
        };
        if let Some((id, repaired)) = repair {
            if frame[8..] == [0, 0] {
                let mut body = &tag[offset + 10..next];
                let parsed = TimestampFrame::parse(
                    &mut body, FrameId::Valid(id.into()), FrameFlags::default(),
                    ParseOptions::DEFAULT_PARSING_MODE,
                );
                if parsed.is_err_and(|error| matches!(error.kind(), ErrorKind::BadTimestamp(_))) {
                    tag.copy_within(next..end, offset);
                    tag[end - (next - offset)..end].fill(0);
                    end -= next - offset;
                    *repaired = true;
                    continue;
                }
            }
        }
        offset = next;
    }
    repaired
}
