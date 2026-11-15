//! WASAPI Exclusive RAM-Preloaded Transport (`AUDCLNT_SHAREMODE_EXCLUSIVE`).
//!
//! Architectural Guarantees:
//! 1. **Lossless Native Integer Decoding in `Loading`:**
//!    - Unpacks FLAC, ALAC (`.m4a`), WAV, and AIFF losslessly via `symphonia` directly from
//!      native `AudioBufferRef` (`S16`, `S24`, `S32`, `U8`) into native integer PCM samples
//!      (`I16`, `I24Packed`, `I24InI32Msb`, `I32`).
//!    - Zero `f32` conversion, zero software resampling, zero digital volume attenuation.
//!    - Rejects lossy or unsupported formats (e.g., MP3, Ogg Vorbis, AAC, DSD) with explicit
//!      errors rather than silently converting or falling back.
//! 2. **Bounded Memory Admission & Page Pre-Faulting (`VirtualLock` Separated):**
//!    - Computes exact uncompressed byte footprint upfront and enforces a strict RAM admission
//!      check (`max_track_bytes` ceiling AND mandatory free physical RAM reserve via
//!      `GlobalMemoryStatusEx` + `Vec::try_reserve_exact`).
//!    - Pre-faults all allocated 4 KB pages during `Loading` before `IAudioClient::Start()`.
//!    - Separates `VirtualLock` behind an opt-in evaluation flag (`virtual_lock_enabled`) so
//!      working-set quota behavior and demand-paging can be benchmarked independently.
//! 3. **Hardware-Interrupt Event-Driven WASAPI Exclusive (`AUDCLNT_STREAMFLAGS_EVENTCALLBACK`):**
//!    - Handles `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED` per the Microsoft Core Audio specification:
//!      queries the hardware's aligned `nFrames` via `GetBufferSize()`, releases the unaligned
//!      `IAudioClient`, reactivates a fresh `IAudioClient` instance on the `IMMDevice`, and
//!      re-initializes with the exact hardware-aligned periodicity (`hnsBufferDuration`).
//!    - Runs on a dedicated `cadence-wasapi-excl` thread registered with MMCSS `"Pro Audio"`
//!      and isolated off Core 0 and Core 1 via `StreamingThreadGuard`.
//! 4. **Zero-I/O, Zero-Allocation, Non-Blocking Render Callback:**
//!    - The real-time event loop performs only `WaitForSingleObject`, `GetBuffer`, a bounds-checked
//!      `ptr::copy_nonoverlapping` from the pre-faulted RAM slab, `ReleaseBuffer`, and relaxed
//!      atomic counter updates.
//!    - All diagnostic sampling (`GetProcessIoCounters`, `K32GetProcessMemoryInfo`) and ETW
//!      correlation happen strictly outside the time-critical rendering loop (at stream start/stop
//!      boundaries or on caller query threads).

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{
    DecoderOptions, CODEC_TYPE_ALAC, CODEC_TYPE_FLAC, CODEC_TYPE_PCM_ALAW, CODEC_TYPE_PCM_F32BE,
    CODEC_TYPE_PCM_F32LE, CODEC_TYPE_PCM_F64BE, CODEC_TYPE_PCM_F64LE, CODEC_TYPE_PCM_MULAW,
    CODEC_TYPE_PCM_S16BE, CODEC_TYPE_PCM_S16BE_PLANAR, CODEC_TYPE_PCM_S16LE,
    CODEC_TYPE_PCM_S16LE_PLANAR, CODEC_TYPE_PCM_S24BE, CODEC_TYPE_PCM_S24BE_PLANAR,
    CODEC_TYPE_PCM_S24LE, CODEC_TYPE_PCM_S24LE_PLANAR, CODEC_TYPE_PCM_S32BE,
    CODEC_TYPE_PCM_S32BE_PLANAR, CODEC_TYPE_PCM_S32LE, CODEC_TYPE_PCM_S32LE_PLANAR,
    CODEC_TYPE_PCM_U8,
};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::stream_tuning::{self, StreamingThreadGuard};
use crate::diag_log;
use crate::diagnostics::DiagCategory;

/// Default maximum uncompressed single-track allocation in RAM (512 MB).
/// Covers ~30 minutes of 96kHz/24-bit stereo or ~15 minutes of 192kHz/24-bit stereo.
pub const DEFAULT_MAX_PRELOAD_TRACK_BYTES: usize = 512 * 1024 * 1024;

/// Minimum physical RAM that must remain available *after* admitting the decoded track (1.5 GB).
pub const MIN_FREE_PHYSICAL_RAM_RESERVE_BYTES: u64 = 1536 * 1024 * 1024;

/// Maximum share of currently available physical RAM a single preloaded track may consume (40%).
pub const MAX_FRACTION_OF_AVAILABLE_RAM: f64 = 0.40;

/// Native integer PCM sample representation preserved without `f32` conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativePcmFormat {
    /// 16-bit signed little-endian integer (`wBitsPerSample = 16, wValidBitsPerSample = 16`).
    I16,
    /// 24-bit signed little-endian integer packed in 3 bytes (`wBitsPerSample = 24, wValidBitsPerSample = 24`).
    I24Packed,
    /// 24-bit signed integer MSB-aligned in a 32-bit little-endian container (`wBitsPerSample = 32, wValidBitsPerSample = 24`, lower 8 bits = `0x00`).
    I24InI32Msb,
    /// 32-bit signed little-endian integer (`wBitsPerSample = 32, wValidBitsPerSample = 32`).
    I32,
}

impl NativePcmFormat {
    #[inline]
    pub const fn container_bytes_per_sample(self) -> usize {
        match self {
            Self::I16 => 2,
            Self::I24Packed => 3,
            Self::I24InI32Msb | Self::I32 => 4,
        }
    }

    #[inline]
    pub const fn container_bits_per_sample(self) -> u16 {
        (self.container_bytes_per_sample() * 8) as u16
    }

    #[inline]
    pub const fn valid_bits_per_sample(self) -> u16 {
        match self {
            Self::I16 => 16,
            Self::I24Packed | Self::I24InI32Msb => 24,
            Self::I32 => 32,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::I16 => "S16_LE",
            Self::I24Packed => "S24_3LE",
            Self::I24InI32Msb => "S24_32LE_MSB",
            Self::I32 => "S32_LE",
        }
    }
}

/// Memory admission policy configuration for WASAPI Exclusive full-track RAM preload.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreloadAdmissionConfig {
    pub max_track_bytes: usize,
    pub min_free_ram_reserve_bytes: u64,
    pub max_available_ram_fraction: f64,
    pub virtual_lock_enabled: bool,
}

impl Default for PreloadAdmissionConfig {
    fn default() -> Self {
        Self {
            max_track_bytes: DEFAULT_MAX_PRELOAD_TRACK_BYTES,
            min_free_ram_reserve_bytes: MIN_FREE_PHYSICAL_RAM_RESERVE_BYTES,
            max_available_ram_fraction: MAX_FRACTION_OF_AVAILABLE_RAM,
            virtual_lock_enabled: false,
        }
    }
}

/// Explicit, typed error reasons for WASAPI Exclusive RAM preload & hardware initialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum WasapiPreloadError {
    Cancelled(String),
    UnsupportedFormat(String),
    AdmissionRejected(String),
    AllocationFailed(String),
    DecodeFailed(String),
    DeviceUnavailable(String),
    HardwareFormatUnsupported(String),
    ExclusiveInitFailed(String),
}

impl std::fmt::Display for WasapiPreloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled(m)
            | Self::UnsupportedFormat(m)
            | Self::AdmissionRejected(m)
            | Self::AllocationFailed(m)
            | Self::DecodeFailed(m)
            | Self::DeviceUnavailable(m)
            | Self::HardwareFormatUnsupported(m)
            | Self::ExclusiveInitFailed(m) => write!(f, "{}", m),
        }
    }
}

/// A pre-decoded, page-pre-faulted native integer PCM buffer residing in RAM.
#[derive(Debug)]
pub struct PreloadedPcmTrack {
    data: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u16,
    pub source_bit_depth: u8,
    pub format: NativePcmFormat,
    pub total_frames: usize,
    pub frame_stride_bytes: usize,
    pub decode_duration_us: u64,
    pub prefault_duration_us: u64,
    pub is_virtual_locked: bool,
}

impl PreloadedPcmTrack {
    #[inline]
    pub fn as_bytes(&self) -> &[u8] {
        &self.data
    }

    #[inline]
    pub fn duration_secs(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.total_frames as f64 / self.sample_rate as f64
        }
    }

    /// Converts a `I24Packed` (3-byte) buffer in-place/re-packed into `I24InI32Msb` (4-byte MSB-aligned)
    /// when a WASAPI Exclusive USB DAC driver requires 32-bit container alignment (`S24_32LE_MSB`)
    /// instead of 3-byte packed `S24_3LE`. Preserves all 24 bits bit-for-bit with zero precision loss.
    pub fn promote_i24_packed_to_i32_msb(
        &mut self,
        admission: &PreloadAdmissionConfig,
        cancel_token: Option<&AtomicBool>,
    ) -> Result<(), WasapiPreloadError> {
        if self.format != NativePcmFormat::I24Packed {
            return Ok(());
        }
        let total_samples = self
            .total_frames
            .checked_mul(self.channels as usize)
            .ok_or_else(|| {
                WasapiPreloadError::AdmissionRejected("Sample count overflow".to_string())
            })?;
        let new_bytes = total_samples.checked_mul(4).ok_or_else(|| {
            WasapiPreloadError::AdmissionRejected("Promoted 24-in-32 byte size overflow".to_string())
        })?;

        check_memory_admission(new_bytes, admission)?;

        let mut promoted: Vec<u8> = Vec::new();
        promoted.try_reserve_exact(new_bytes).map_err(|e| {
            WasapiPreloadError::AllocationFailed(format!(
                "Failed to reserve {} bytes for 24-in-32 MSB buffer: {}",
                new_bytes, e
            ))
        })?;

        if self.is_virtual_locked {
            stream_tuning::unlock_raw_slice(&self.data);
            self.is_virtual_locked = false;
        }

        for (idx, chunk) in self.data.chunks_exact(3).enumerate() {
            if idx & 0xFFFF == 0 {
                if let Some(tok) = cancel_token {
                    if tok.load(Ordering::Relaxed) {
                        return Err(WasapiPreloadError::Cancelled(
                            "Cancelled during 24-in-32 container promotion".to_string(),
                        ));
                    }
                }
            }
            // MSB-aligned 24-in-32 little-endian: low byte is 0x00, upper 3 bytes are the exact 24-bit signed value.
            promoted.extend_from_slice(&[0u8, chunk[0], chunk[1], chunk[2]]);
        }

        prefault_pages(&mut promoted);
        let locked = if admission.virtual_lock_enabled {
            stream_tuning::lock_raw_slice(&promoted)
        } else {
            false
        };

        self.data = promoted;
        self.format = NativePcmFormat::I24InI32Msb;
        self.frame_stride_bytes = (self.channels as usize) * 4;
        self.is_virtual_locked = locked;
        Ok(())
    }
}

impl Drop for PreloadedPcmTrack {
    fn drop(&mut self) {
        if self.is_virtual_locked {
            stream_tuning::unlock_raw_slice(&self.data);
            self.is_virtual_locked = false;
        }
    }
}

/// Checks whether allocating `required_bytes` is permitted under the bounded memory admission policy.
pub fn check_memory_admission(
    required_bytes: usize,
    config: &PreloadAdmissionConfig,
) -> Result<u64, WasapiPreloadError> {
    if required_bytes == 0 {
        return Err(WasapiPreloadError::AdmissionRejected(
            "Track contains 0 decoded PCM bytes.".to_string(),
        ));
    }

    if required_bytes > config.max_track_bytes {
        return Err(WasapiPreloadError::AdmissionRejected(format!(
            "Track uncompressed PCM size ({:.1} MB) exceeds WASAPI RAM preload limit ({:.1} MB).",
            required_bytes as f64 / (1024.0 * 1024.0),
            config.max_track_bytes as f64 / (1024.0 * 1024.0)
        )));
    }

    if let Some(mem) = stream_tuning::memory_info() {
        let avail = mem.available_bytes;
        let max_by_fraction = (avail as f64 * config.max_available_ram_fraction) as u64;
        let max_by_reserve = avail.saturating_sub(config.min_free_ram_reserve_bytes);
        let dynamic_cap = max_by_fraction.min(max_by_reserve);

        if (required_bytes as u64) > dynamic_cap {
            return Err(WasapiPreloadError::AdmissionRejected(format!(
                "Track uncompressed PCM size ({:.1} MB) exceeds available physical RAM admission budget ({:.1} MB; available RAM: {:.1} MB).",
                required_bytes as f64 / (1024.0 * 1024.0),
                dynamic_cap as f64 / (1024.0 * 1024.0),
                avail as f64 / (1024.0 * 1024.0)
            )));
        }
        Ok(dynamic_cap.min(config.max_track_bytes as u64))
    } else {
        Ok(config.max_track_bytes as u64)
    }
}

/// Touches every 4 KB page in `buf` so the OS commits the physical pages into the working set
/// during `Loading` before `IAudioClient::Start()` begins real-time playback.
#[inline]
pub fn prefault_pages(buf: &mut [u8]) {
    const PAGE_SIZE: usize = 4096;
    let mut offset = 0usize;
    while offset < buf.len() {
        unsafe {
            let ptr = buf.as_mut_ptr().add(offset);
            let val = std::ptr::read_volatile(ptr);
            std::ptr::write_volatile(ptr, val);
        }
        offset += PAGE_SIZE;
    }
    if !buf.is_empty() {
        let last = buf.len() - 1;
        unsafe {
            let ptr = buf.as_mut_ptr().add(last);
            let val = std::ptr::read_volatile(ptr);
            std::ptr::write_volatile(ptr, val);
        }
    }
}

/// Validates and maps a Symphonia codec + bits-per-sample to our lossless integer format.
/// Explicitly rejects lossy codecs (MP3, Vorbis, AAC) and floating-point PCM in Purity Mode.
fn resolve_lossless_pcm_format(
    codec: symphonia::core::codecs::CodecType,
    bits_per_sample: Option<u32>,
) -> Result<(NativePcmFormat, u8), WasapiPreloadError> {
    let is_lossless_codec = codec == CODEC_TYPE_FLAC
        || codec == CODEC_TYPE_ALAC
        || codec == CODEC_TYPE_PCM_S16LE
        || codec == CODEC_TYPE_PCM_S16BE
        || codec == CODEC_TYPE_PCM_S16LE_PLANAR
        || codec == CODEC_TYPE_PCM_S16BE_PLANAR
        || codec == CODEC_TYPE_PCM_S24LE
        || codec == CODEC_TYPE_PCM_S24BE
        || codec == CODEC_TYPE_PCM_S24LE_PLANAR
        || codec == CODEC_TYPE_PCM_S24BE_PLANAR
        || codec == CODEC_TYPE_PCM_S32LE
        || codec == CODEC_TYPE_PCM_S32BE
        || codec == CODEC_TYPE_PCM_S32LE_PLANAR
        || codec == CODEC_TYPE_PCM_S32BE_PLANAR
        || codec == CODEC_TYPE_PCM_U8;

    if !is_lossless_codec {
        if codec == CODEC_TYPE_PCM_F32LE
            || codec == CODEC_TYPE_PCM_F32BE
            || codec == CODEC_TYPE_PCM_F64LE
            || codec == CODEC_TYPE_PCM_F64BE
            || codec == CODEC_TYPE_PCM_ALAW
            || codec == CODEC_TYPE_PCM_MULAW
        {
            return Err(WasapiPreloadError::UnsupportedFormat(
                "Non-integer PCM format (float/companded) is not supported in WASAPI Exclusive integer bit-perfect mode.".to_string(),
            ));
        }
        return Err(WasapiPreloadError::UnsupportedFormat(
            "Unsupported or lossy codec for WASAPI Exclusive bit-perfect preload (only lossless integer FLAC, ALAC, WAV, and AIFF are permitted).".to_string(),
        ));
    }

    let bps = bits_per_sample.unwrap_or(match codec {
        CODEC_TYPE_PCM_U8 => 8,
        CODEC_TYPE_PCM_S16LE
        | CODEC_TYPE_PCM_S16BE
        | CODEC_TYPE_PCM_S16LE_PLANAR
        | CODEC_TYPE_PCM_S16BE_PLANAR => 16,
        CODEC_TYPE_PCM_S24LE
        | CODEC_TYPE_PCM_S24BE
        | CODEC_TYPE_PCM_S24LE_PLANAR
        | CODEC_TYPE_PCM_S24BE_PLANAR => 24,
        CODEC_TYPE_PCM_S32LE
        | CODEC_TYPE_PCM_S32BE
        | CODEC_TYPE_PCM_S32LE_PLANAR
        | CODEC_TYPE_PCM_S32BE_PLANAR => 32,
        _ => 0,
    });

    match bps {
        8 => Ok((NativePcmFormat::I16, 8)), // 8-bit unsigned widened losslessly (`(u8 ^ 0x80) << 8`) into 16-bit container
        16 => Ok((NativePcmFormat::I16, 16)),
        20 | 24 => Ok((NativePcmFormat::I24InI32Msb, bps as u8)),
        32 => Ok((NativePcmFormat::I32, 32)),
        0 => Err(WasapiPreloadError::UnsupportedFormat(
            "Audio stream is missing ground-truth bits_per_sample header metadata.".to_string(),
        )),
        other => Err(WasapiPreloadError::UnsupportedFormat(format!(
            "Unsupported PCM bit depth: {}-bit.",
            other
        ))),
    }
}

/// Decodes an entire lossless PCM audio file into a contiguous, page-pre-faulted native integer
/// RAM buffer during the `Loading` phase.
///
/// - Checks `cancel_token` between packet decodes so rapid user Stop / Next / Device Switch
///   aborts `Loading` immediately without waiting for the rest of the file.
/// - Enforces `PreloadAdmissionConfig` before and during decoding.
pub fn decode_file_to_ram(
    path: &Path,
    admission: &PreloadAdmissionConfig,
    cancel_token: Option<&AtomicBool>,
) -> Result<PreloadedPcmTrack, WasapiPreloadError> {
    let t0 = Instant::now();

    if let Some(tok) = cancel_token {
        if tok.load(Ordering::Relaxed) {
            return Err(WasapiPreloadError::Cancelled(
                "Cancelled before opening audio file".to_string(),
            ));
        }
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext == "dsf" || ext == "dff" {
        return Err(WasapiPreloadError::UnsupportedFormat(
            "Native DSD (.dsf/.dff) is not supported on WASAPI Exclusive PCM endpoints.".to_string(),
        ));
    }

    let file = File::open(path).map_err(|e| {
        WasapiPreloadError::DecodeFailed(format!("Failed to open '{}': {}", path.display(), e))
    })?;

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(&ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| {
            WasapiPreloadError::UnsupportedFormat(format!(
                "Unsupported or corrupted container '{}': {}",
                path.display(),
                e
            ))
        })?;

    let mut format_reader = probed.format;
    let track = format_reader.default_track().ok_or_else(|| {
        WasapiPreloadError::DecodeFailed("No default audio track found in container.".to_string())
    })?;

    let track_id = track.id;
    let track_params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&track_params, &DecoderOptions { verify: false })
        .map_err(|e| {
            WasapiPreloadError::UnsupportedFormat(format!("Failed to initialize decoder: {}", e))
        })?;

    // Merge track container parameters with codec-initialized parameters (e.g. ALAC magic cookie in .m4a)
    let dec_params = decoder.codec_params();
    let codec_type = if dec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL {
        dec_params.codec
    } else {
        track_params.codec
    };

    // Parse ground-truth Apple ALAC magic cookie (ISO-MP4 `alac` extra_data) when present
    let alac_cookie_info: Option<(u32, u16, u32)> = if codec_type == CODEC_TYPE_ALAC {
        dec_params
            .extra_data
            .as_deref()
            .or(track_params.extra_data.as_deref())
            .and_then(|cookie| {
                let cfg = if cookie.len() >= 36 && &cookie[4..8] == b"alac" {
                    Some(&cookie[12..36])
                } else if cookie.len() >= 24 {
                    Some(&cookie[0..24])
                } else {
                    None
                }?;
                let bit_depth = cfg[5] as u32;
                let ch = cfg[9] as u16;
                let sr = u32::from_be_bytes([cfg[20], cfg[21], cfg[22], cfg[23]]);
                Some((sr, ch, bit_depth))
            })
    } else {
        None
    };

    let sample_rate = dec_params
        .sample_rate
        .or(track_params.sample_rate)
        .or_else(|| alac_cookie_info.map(|(sr, _, _)| sr))
        .ok_or_else(|| {
            WasapiPreloadError::UnsupportedFormat("Missing sample rate in stream header.".to_string())
        })?;
    let mut channels = dec_params
        .channels
        .or(track_params.channels)
        .map(|c| c.count() as u16)
        .or_else(|| alac_cookie_info.map(|(_, ch, _)| ch))
        .unwrap_or(0);
    let bits_per_sample = dec_params
        .bits_per_sample
        .or(track_params.bits_per_sample)
        .or_else(|| alac_cookie_info.map(|(_, _, bps)| bps));

    if channels > 8 {
        return Err(WasapiPreloadError::UnsupportedFormat(format!(
            "Unsupported channel count: {}",
            channels
        )));
    }

    let (target_format, source_bit_depth) =
        resolve_lossless_pcm_format(codec_type, bits_per_sample)?;
    let bytes_per_sample = target_format.container_bytes_per_sample();
    let mut frame_stride_bytes = (channels.max(2) as usize) * bytes_per_sample;

    // Estimate uncompressed byte size upfront from n_frames if present.
    let estimated_frames = dec_params
        .n_frames
        .or(track_params.n_frames)
        .unwrap_or(0) as usize;
    let initial_reserve_bytes = if estimated_frames > 0 {
        estimated_frames
            .checked_mul(frame_stride_bytes)
            .ok_or_else(|| {
                WasapiPreloadError::AdmissionRejected("Track PCM byte size overflow.".to_string())
            })?
    } else {
        // Fallback initial estimate for containers without n_frames header (e.g. 16 MB).
        (16 * 1024 * 1024).min(admission.max_track_bytes)
    };

    let effective_cap_bytes = check_memory_admission(initial_reserve_bytes, admission)? as usize;

    let mut pcm_bytes: Vec<u8> = Vec::new();
    pcm_bytes
        .try_reserve_exact(initial_reserve_bytes)
        .map_err(|e| {
            WasapiPreloadError::AllocationFailed(format!(
                "Failed to allocate {:.1} MB RAM buffer for track preload: {}",
                initial_reserve_bytes as f64 / (1024.0 * 1024.0),
                e
            ))
        })?;

    let mut total_frames: usize = 0;

    loop {
        if let Some(tok) = cancel_token {
            if tok.load(Ordering::Relaxed) {
                return Err(WasapiPreloadError::Cancelled(
                    "Track preload cancelled during decoding".to_string(),
                ));
            }
        }

        let packet = match format_reader.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(WasapiPreloadError::UnsupportedFormat(
                    "Mid-stream codec parameter reset is not supported in WASAPI Exclusive mode."
                        .to_string(),
                ));
            }
            Err(e) => {
                return Err(WasapiPreloadError::DecodeFailed(format!(
                    "Packet read error: {}",
                    e
                )));
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder.decode(&packet).map_err(|e| {
            WasapiPreloadError::DecodeFailed(format!("Lossless frame decode error: {}", e))
        })?;

        let frames_in_pkt = decoded.frames();
        if frames_in_pkt == 0 {
            continue;
        }
        if channels == 0 {
            channels = decoded.spec().channels.count() as u16;
            if channels == 0 || channels > 8 {
                return Err(WasapiPreloadError::UnsupportedFormat(format!(
                    "Unsupported channel count: {}",
                    channels
                )));
            }
            frame_stride_bytes = (channels as usize) * bytes_per_sample;
        }

        let pkt_bytes = frames_in_pkt
            .checked_mul(frame_stride_bytes)
            .ok_or_else(|| {
                WasapiPreloadError::AdmissionRejected("Packet byte count overflow.".to_string())
            })?;
        let new_len = pcm_bytes.len().checked_add(pkt_bytes).ok_or_else(|| {
            WasapiPreloadError::AdmissionRejected("Total byte count overflow.".to_string())
        })?;

        if new_len > effective_cap_bytes {
            return Err(WasapiPreloadError::AdmissionRejected(format!(
                "Decoded PCM stream exceeded RAM admission limit ({:.1} MB).",
                effective_cap_bytes as f64 / (1024.0 * 1024.0)
            )));
        }

        if new_len > pcm_bytes.capacity() {
            let additional = new_len - pcm_bytes.len();
            pcm_bytes.try_reserve(additional).map_err(|e| {
                WasapiPreloadError::AllocationFailed(format!(
                    "RAM growth allocation failed at {:.1} MB: {}",
                    new_len as f64 / (1024.0 * 1024.0),
                    e
                ))
            })?;
        }

        append_native_integer_samples(
            &decoded,
            target_format,
            channels as usize,
            &mut pcm_bytes,
        )?;
        total_frames += frames_in_pkt;
    }

    if total_frames == 0 || pcm_bytes.is_empty() {
        return Err(WasapiPreloadError::DecodeFailed(
            "Decoded audio stream produced 0 PCM frames.".to_string(),
        ));
    }

    let decode_duration_us = t0.elapsed().as_micros() as u64;
    let tf0 = Instant::now();
    prefault_pages(&mut pcm_bytes);
    let prefault_duration_us = tf0.elapsed().as_micros() as u64;

    let is_virtual_locked = if admission.virtual_lock_enabled {
        stream_tuning::lock_raw_slice(&pcm_bytes)
    } else {
        false
    };

    Ok(PreloadedPcmTrack {
        data: pcm_bytes,
        sample_rate,
        channels,
        source_bit_depth,
        format: target_format,
        total_frames,
        frame_stride_bytes,
        decode_duration_us,
        prefault_duration_us,
        is_virtual_locked,
    })
}

/// Packs planar or interleaved Symphonia integer buffers directly into interleaved little-endian
/// hardware PCM bytes with zero `f32` conversion and zero precision loss.
fn append_native_integer_samples(
    decoded: &AudioBufferRef<'_>,
    target_format: NativePcmFormat,
    channels: usize,
    out: &mut Vec<u8>,
) -> Result<(), WasapiPreloadError> {
    let frames = decoded.frames();
    match (decoded, target_format) {
        (AudioBufferRef::S16(buf), NativePcmFormat::I16) => {
            for f in 0..frames {
                for ch in 0..channels {
                    let sample: i16 = buf.chan(ch)[f];
                    out.extend_from_slice(&sample.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::S24(buf), NativePcmFormat::I16) => {
            // Symphonia full-scale S24 shifts 16-bit samples left by (24 - 16) = 8 bits
            for f in 0..frames {
                for ch in 0..channels {
                    let s24_val: i32 = buf.chan(ch)[f].inner();
                    let sample: i16 = (s24_val >> 8) as i16;
                    out.extend_from_slice(&sample.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::S32(buf), NativePcmFormat::I16) => {
            // Symphonia full-scale S32 shifts 16-bit samples left by (32 - 16) = 16 bits
            for f in 0..frames {
                for ch in 0..channels {
                    let s32_val: i32 = buf.chan(ch)[f];
                    let sample: i16 = (s32_val >> 16) as i16;
                    out.extend_from_slice(&sample.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::U8(buf), NativePcmFormat::I16) => {
            for f in 0..frames {
                for ch in 0..channels {
                    let u: u8 = buf.chan(ch)[f];
                    let s16: i16 = ((u as i16) - 128) << 8;
                    out.extend_from_slice(&s16.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::S24(buf), NativePcmFormat::I24InI32Msb) => {
            for f in 0..frames {
                for ch in 0..channels {
                    // Symphonia `i24::inner()` returns the signed 24-bit integer in an `i32`
                    // (range `-8_388_608..=8_388_607`). Shift left by 8 bits to MSB-align in 32-bit container.
                    let s24_val: i32 = buf.chan(ch)[f].inner();
                    let msb32: i32 = s24_val << 8;
                    out.extend_from_slice(&msb32.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::S24(buf), NativePcmFormat::I24Packed) => {
            for f in 0..frames {
                for ch in 0..channels {
                    let s24_val: i32 = buf.chan(ch)[f].inner();
                    let le = s24_val.to_le_bytes();
                    out.extend_from_slice(&[le[0], le[1], le[2]]);
                }
            }
            Ok(())
        }
        (AudioBufferRef::S32(buf), NativePcmFormat::I24InI32Msb) => {
            // Note: Symphonia's FLAC/ALAC decoder shifts 20/24-bit samples to MSB of `i32`
            // when yielding `AudioBufferRef::S32` (low 8 bits are already 0).
            for f in 0..frames {
                for ch in 0..channels {
                    let s32_val: i32 = buf.chan(ch)[f];
                    out.extend_from_slice(&s32_val.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::S32(buf), NativePcmFormat::I24Packed) => {
            for f in 0..frames {
                for ch in 0..channels {
                    let s32_val: i32 = buf.chan(ch)[f];
                    let le = s32_val.to_le_bytes();
                    // Take upper 3 bytes of MSB-aligned S32
                    out.extend_from_slice(&[le[1], le[2], le[3]]);
                }
            }
            Ok(())
        }
        (AudioBufferRef::S32(buf), NativePcmFormat::I32) => {
            for f in 0..frames {
                for ch in 0..channels {
                    let s32_val: i32 = buf.chan(ch)[f];
                    out.extend_from_slice(&s32_val.to_le_bytes());
                }
            }
            Ok(())
        }
        (AudioBufferRef::S16(buf), NativePcmFormat::I24InI32Msb) => {
            for f in 0..frames {
                for ch in 0..channels {
                    let s32_val: i32 = (buf.chan(ch)[f] as i32) << 16;
                    out.extend_from_slice(&s32_val.to_le_bytes());
                }
            }
            Ok(())
        }
        _ => Err(WasapiPreloadError::UnsupportedFormat(
            "Decoder produced non-integer sample buffer incompatible with bit-perfect integer output.".to_string(),
        )),
    }
}

/// Converts a `NativePcmFormat::I24InI32Msb` buffer in-place to 3-byte `I24Packed` if a
/// hardware endpoint rejects 24-in-32 (`wBitsPerSample = 32, wValidBitsPerSample = 24`)
/// and only accepts 3-byte packed 24-bit (`wBitsPerSample = 24, wValidBitsPerSample = 24`).
pub fn pack_i24_msb32_to_i24_packed_in_place(track: &mut PreloadedPcmTrack) {
    if track.format != NativePcmFormat::I24InI32Msb {
        return;
    }
    let total_samples = track.total_frames * (track.channels as usize);
    let mut write_idx = 0usize;
    for s in 0..total_samples {
        let r = s * 4;
        let b1 = track.data[r + 1];
        let b2 = track.data[r + 2];
        let b3 = track.data[r + 3];
        track.data[write_idx] = b1;
        track.data[write_idx + 1] = b2;
        track.data[write_idx + 2] = b3;
        write_idx += 3;
    }
    track.data.truncate(write_idx);
    track.format = NativePcmFormat::I24Packed;
    track.frame_stride_bytes = (track.channels as usize) * 3;
}

/// Supplementary process-level OS I/O & working-set snapshot captured strictly outside the
/// real-time audio loop (at stream start/stop or when queried by UI/benchmark CLI).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessHygieneCounters {
    pub io_read_operations: u64,
    pub io_read_bytes: u64,
    pub io_write_operations: u64,
    pub io_write_bytes: u64,
    pub page_fault_count: u32,
    pub working_set_bytes: u64,
    pub peak_working_set_bytes: u64,
}

#[cfg(windows)]
pub fn snapshot_process_hygiene_counters() -> ProcessHygieneCounters {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessIoCounters, IO_COUNTERS};

    let mut out = ProcessHygieneCounters::default();
    unsafe {
        let proc = GetCurrentProcess();
        let mut io: IO_COUNTERS = std::mem::zeroed();
        if GetProcessIoCounters(proc, &mut io) != 0 {
            out.io_read_operations = io.ReadOperationCount;
            out.io_read_bytes = io.ReadTransferCount;
            out.io_write_operations = io.WriteOperationCount;
            out.io_write_bytes = io.WriteTransferCount;
        }
        let mut mem: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if K32GetProcessMemoryInfo(proc, &mut mem, mem.cb) != 0 {
            out.page_fault_count = mem.PageFaultCount;
            out.working_set_bytes = mem.WorkingSetSize as u64;
            out.peak_working_set_bytes = mem.PeakWorkingSetSize as u64;
        }
    }
    out
}

#[cfg(not(windows))]
pub fn snapshot_process_hygiene_counters() -> ProcessHygieneCounters {
    ProcessHygieneCounters::default()
}

/// Lock-free atomic telemetry updated inside the WASAPI Exclusive render thread.
/// Contains zero mutexes, zero heap allocations, and zero syscalls on the hot path.
#[derive(Default)]
pub struct WasapiExclusiveAtomicStats {
    pub rendered_frames: AtomicUsize,
    pub total_frames: AtomicUsize,
    pub callback_count: AtomicU64,
    pub underrun_count: AtomicU64,
    pub min_callback_interval_us: AtomicU64,
    pub max_callback_interval_us: AtomicU64,
    pub sum_callback_interval_us: AtomicU64,
    pub max_fill_duration_us: AtomicU64,
    pub sum_fill_duration_us: AtomicU64,
    pub aligned_buffer_frames: AtomicU32,
    pub buffer_realigned: AtomicBool,
    pub stream_finished: AtomicBool,
}

impl WasapiExclusiveAtomicStats {
    pub fn new(total_frames: usize, aligned_buffer_frames: u32, buffer_realigned: bool) -> Self {
        Self {
            rendered_frames: AtomicUsize::new(0),
            total_frames: AtomicUsize::new(total_frames),
            callback_count: AtomicU64::new(0),
            underrun_count: AtomicU64::new(0),
            min_callback_interval_us: AtomicU64::new(u64::MAX),
            max_callback_interval_us: AtomicU64::new(0),
            sum_callback_interval_us: AtomicU64::new(0),
            max_fill_duration_us: AtomicU64::new(0),
            sum_fill_duration_us: AtomicU64::new(0),
            aligned_buffer_frames: AtomicU32::new(aligned_buffer_frames),
            buffer_realigned: AtomicBool::new(buffer_realigned),
            stream_finished: AtomicBool::new(false),
        }
    }
}

/// Snapshot of WASAPI Exclusive preload & real-time playback telemetry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiExclusiveTelemetrySnapshot {
    pub active: bool,
    pub device_name: Option<String>,
    pub sample_rate: u32,
    pub channels: u16,
    pub source_bit_depth: u8,
    pub hardware_pcm_format: String,
    pub container_bits: u16,
    pub valid_bits: u16,
    pub preloaded_pcm_bytes: usize,
    pub total_frames: usize,
    pub rendered_frames: usize,
    pub decode_duration_us: u64,
    pub prefault_duration_us: u64,
    pub is_virtual_locked: bool,
    pub aligned_buffer_frames: u32,
    pub buffer_realigned_on_init: bool,
    pub callback_count: u64,
    pub underrun_count: u64,
    pub min_callback_interval_us: u64,
    pub max_callback_interval_us: u64,
    pub avg_callback_interval_us: u64,
    pub max_fill_duration_us: u64,
    pub avg_fill_duration_us: u64,
    /// Supplementary process-wide OS counters diffed since `IAudioClient::Start()`.
    /// Note: Authoritative per-file/per-thread disk I/O attribution uses ETW tracing.
    pub process_io_read_bytes_since_start: u64,
    pub process_io_read_ops_since_start: u64,
    pub page_faults_since_start: u32,
    pub working_set_bytes: u64,
}

/// Active WASAPI Exclusive playback session handle.
/// Dropping or calling `stop()` signals the event-driven render thread and joins it deterministically.
pub struct WasapiExclusiveSession {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    wake_event_raw: usize,
    join_handle: Option<JoinHandle<()>>,
    pub stats: Arc<WasapiExclusiveAtomicStats>,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub source_bit_depth: u8,
    pub format: NativePcmFormat,
    pub preloaded_pcm_bytes: usize,
    pub decode_duration_us: u64,
    pub prefault_duration_us: u64,
    pub is_virtual_locked: bool,
    pub baseline_counters: ProcessHygieneCounters,
}

impl WasapiExclusiveSession {
    #[inline]
    pub fn is_finished(&self) -> bool {
        self.stats.stream_finished.load(Ordering::Acquire)
    }

    #[inline]
    pub fn position_secs(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        let frames = self
            .stats
            .rendered_frames
            .load(Ordering::Relaxed)
            .min(self.stats.total_frames.load(Ordering::Relaxed));
        frames as f64 / self.sample_rate as f64
    }

    pub fn set_paused(&self, paused: bool) {
        self.pause_flag.store(paused, Ordering::Release);
        self.signal_wake_event();
    }

    pub fn seek_to_secs(&self, position_secs: f64) {
        let target_frame = ((position_secs.max(0.0) * self.sample_rate as f64).round() as usize)
            .min(self.stats.total_frames.load(Ordering::Relaxed));
        self.stats
            .rendered_frames
            .store(target_frame, Ordering::Release);
    }

    pub fn snapshot_telemetry(&self) -> WasapiExclusiveTelemetrySnapshot {
        let now_counters = snapshot_process_hygiene_counters();
        let cb_count = self.stats.callback_count.load(Ordering::Relaxed);
        let intervals = cb_count.saturating_sub(1);
        let sum_interval = self.stats.sum_callback_interval_us.load(Ordering::Relaxed);
        let sum_fill = self.stats.sum_fill_duration_us.load(Ordering::Relaxed);
        let min_cb = self.stats.min_callback_interval_us.load(Ordering::Relaxed);

        WasapiExclusiveTelemetrySnapshot {
            active: !self.is_finished(),
            device_name: Some(self.device_name.clone()),
            sample_rate: self.sample_rate,
            channels: self.channels,
            source_bit_depth: self.source_bit_depth,
            hardware_pcm_format: self.format.as_str().to_string(),
            container_bits: self.format.container_bits_per_sample(),
            valid_bits: self.format.valid_bits_per_sample(),
            preloaded_pcm_bytes: self.preloaded_pcm_bytes,
            total_frames: self.stats.total_frames.load(Ordering::Relaxed),
            rendered_frames: self.stats.rendered_frames.load(Ordering::Relaxed),
            decode_duration_us: self.decode_duration_us,
            prefault_duration_us: self.prefault_duration_us,
            is_virtual_locked: self.is_virtual_locked,
            aligned_buffer_frames: self.stats.aligned_buffer_frames.load(Ordering::Relaxed),
            buffer_realigned_on_init: self.stats.buffer_realigned.load(Ordering::Relaxed),
            callback_count: cb_count,
            underrun_count: self.stats.underrun_count.load(Ordering::Relaxed),
            min_callback_interval_us: if min_cb == u64::MAX { 0 } else { min_cb },
            max_callback_interval_us: self.stats.max_callback_interval_us.load(Ordering::Relaxed),
            avg_callback_interval_us: if intervals > 0 {
                sum_interval / intervals
            } else {
                0
            },
            max_fill_duration_us: self.stats.max_fill_duration_us.load(Ordering::Relaxed),
            avg_fill_duration_us: if cb_count > 0 {
                sum_fill / cb_count
            } else {
                0
            },
            process_io_read_bytes_since_start: now_counters
                .io_read_bytes
                .saturating_sub(self.baseline_counters.io_read_bytes),
            process_io_read_ops_since_start: now_counters
                .io_read_operations
                .saturating_sub(self.baseline_counters.io_read_operations),
            page_faults_since_start: now_counters
                .page_fault_count
                .saturating_sub(self.baseline_counters.page_fault_count),
            working_set_bytes: now_counters.working_set_bytes,
        }
    }

    fn signal_wake_event(&self) {
        #[cfg(windows)]
        if self.wake_event_raw != 0 {
            unsafe {
                let _ = windows_sys::Win32::System::Threading::SetEvent(
                    self.wake_event_raw as windows_sys::Win32::Foundation::HANDLE,
                );
            }
        }
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        self.signal_wake_event();
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for WasapiExclusiveSession {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
mod win_exclusive {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::GUID;
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::Media::KernelStreaming::{
        KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        STGM_READ,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_LPWSTR;

    /// `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED` (`0x88890019`).
    const AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED_HR: i32 = 0x88890019u32 as i32;

    /// Standard speaker channel masks for `WAVEFORMATEXTENSIBLE`.
    fn channel_mask_for_count(channels: u16) -> u32 {
        match channels {
            1 => 0x4,                   // SPEAKER_FRONT_CENTER
            2 => 0x1 | 0x2,             // SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT
            4 => 0x1 | 0x2 | 0x10 | 0x20,
            6 => 0x3F,                  // 5.1
            8 => 0x63F,                 // 7.1
            _ => (1u32 << channels).saturating_sub(1),
        }
    }

    pub fn build_waveformatextensible(
        sample_rate: u32,
        channels: u16,
        format: NativePcmFormat,
    ) -> WAVEFORMATEXTENSIBLE {
        let container_bytes = format.container_bytes_per_sample() as u16;
        let block_align = channels * container_bytes;
        let avg_bytes_per_sec = sample_rate * (block_align as u32);
        let mut wfx = WAVEFORMATEXTENSIBLE::default();
        wfx.Format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: avg_bytes_per_sec,
            nBlockAlign: block_align,
            wBitsPerSample: format.container_bits_per_sample(),
            cbSize: 22,
        };
        wfx.Samples.wValidBitsPerSample = format.valid_bits_per_sample();
        wfx.dwChannelMask = channel_mask_for_count(channels);
        wfx.SubFormat = GUID::from_u128(KSDATAFORMAT_SUBTYPE_PCM.to_u128());
        wfx
    }

    struct ComInitGuard(bool);
    impl ComInitGuard {
        fn acquire() -> Self {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                Self(hr.is_ok())
            }
        }
    }
    impl Drop for ComInitGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    unsafe fn read_device_friendly_name(device: &IMMDevice) -> Option<String> {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let mut prop = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let raw = &prop.as_raw().Anonymous.Anonymous;
        if raw.vt != VT_LPWSTR.0 {
            let _ = PropVariantClear(&mut prop);
            return None;
        }
        let ptr_utf16 = *(&raw.Anonymous as *const _ as *const *const u16);
        if ptr_utf16.is_null() {
            let _ = PropVariantClear(&mut prop);
            return None;
        }
        let mut len = 0usize;
        while *ptr_utf16.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr_utf16, len);
        let name = OsString::from_wide(slice).to_string_lossy().into_owned();
        let _ = PropVariantClear(&mut prop);
        Some(name)
    }

    unsafe fn find_matching_mmdevice(
        exact_name: Option<&str>,
    ) -> Result<(IMMDevice, String), WasapiPreloadError> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| {
                WasapiPreloadError::DeviceUnavailable(format!(
                    "Failed to create MMDeviceEnumerator: {}",
                    e
                ))
            })?;

        match exact_name {
            None => {
                let dev = enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|e| {
                        WasapiPreloadError::DeviceUnavailable(format!(
                            "Default WASAPI audio endpoint unavailable: {}",
                            e
                        ))
                    })?;
                let name =
                    read_device_friendly_name(&dev).unwrap_or_else(|| "Default Audio Device".into());
                Ok((dev, name))
            }
            Some(target) => {
                let collection = enumerator
                    .EnumAudioEndpoints(eRender, windows::Win32::Media::Audio::DEVICE_STATE_ACTIVE)
                    .map_err(|e| {
                        WasapiPreloadError::DeviceUnavailable(format!(
                            "Failed to enumerate WASAPI endpoints: {}",
                            e
                        ))
                    })?;
                let count = collection.GetCount().unwrap_or(0);
                for idx in 0..count {
                    if let Ok(dev) = collection.Item(idx) {
                        if let Some(name) = read_device_friendly_name(&dev) {
                            if name == target {
                                return Ok((dev, name));
                            }
                        }
                    }
                }
                Err(WasapiPreloadError::DeviceUnavailable(format!(
                    "Selected WASAPI endpoint '{}' is unavailable.",
                    target
                )))
            }
        }
    }

    /// Negotiates the hardware format on `IAudioClient` in `AUDCLNT_SHAREMODE_EXCLUSIVE`.
    /// For 24-bit tracks (`I24InI32Msb`), probes 24-in-32 MSB first (standard on USB Audio Class 2 drivers),
    /// and if rejected, falls back to packed 24-bit (`I24Packed`, 3 bytes/sample) in-place.
    unsafe fn negotiate_exclusive_format(
        client: &IAudioClient,
        track: &mut PreloadedPcmTrack,
    ) -> Result<WAVEFORMATEXTENSIBLE, WasapiPreloadError> {
        let primary_wfx =
            build_waveformatextensible(track.sample_rate, track.channels, track.format);
        let primary_ptr = &primary_wfx as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;

        if client
            .IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, primary_ptr, None)
            .is_ok()
        {
            return Ok(primary_wfx);
        }

        // If 24-in-32 MSB was rejected, check if the DAC requires 3-byte packed 24-bit (S24_3LE)
        if track.format == NativePcmFormat::I24InI32Msb {
            let packed_wfx = build_waveformatextensible(
                track.sample_rate,
                track.channels,
                NativePcmFormat::I24Packed,
            );
            let packed_ptr = &packed_wfx as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;
            if client
                .IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, packed_ptr, None)
                .is_ok()
            {
                pack_i24_msb32_to_i24_packed_in_place(track);
                return Ok(packed_wfx);
            }
        }

        // If 16-bit was rejected directly because the USB DAC only accepts 24-in-32 MSB or 32-bit
        // container words at that sample rate, we can losslessly MSB-align 16-bit into 24-in-32
        // only if the hardware requires a wider container for the exact same sample rate.
        if track.format == NativePcmFormat::I16 {
            let promoted_wfx = build_waveformatextensible(
                track.sample_rate,
                track.channels,
                NativePcmFormat::I24InI32Msb,
            );
            let promoted_ptr = &promoted_wfx as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;
            if client
                .IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, promoted_ptr, None)
                .is_ok()
            {
                // Losslessly widen 16-bit samples to 32-bit MSB (`s16 << 16`)
                let total_samples = track.total_frames * (track.channels as usize);
                let mut widened = Vec::new();
                if widened.try_reserve_exact(total_samples * 4).is_ok() {
                    if track.is_virtual_locked {
                        stream_tuning::unlock_raw_slice(&track.data);
                        track.is_virtual_locked = false;
                    }
                    for chunk in track.data.chunks_exact(2) {
                        widened.extend_from_slice(&[0u8, 0u8, chunk[0], chunk[1]]);
                    }
                    prefault_pages(&mut widened);
                    track.data = widened;
                    track.format = NativePcmFormat::I24InI32Msb;
                    track.frame_stride_bytes = (track.channels as usize) * 4;
                    return Ok(promoted_wfx);
                }
            }
        }

        Err(WasapiPreloadError::HardwareFormatUnsupported(format!(
            "Hardware rejected WASAPI Exclusive native format ({} Hz, {} ch, {}). No resampling permitted in Purity Mode.",
            track.sample_rate,
            track.channels,
            track.format.as_str()
        )))
    }

    /// Initializes `IAudioClient` in `AUDCLNT_SHAREMODE_EXCLUSIVE | AUDCLNT_STREAMFLAGS_EVENTCALLBACK`,
    /// implementing Microsoft's official `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED` (`0x88890019`)
    /// recovery sequence:
    /// 1. Query `GetDevicePeriod` for default/minimum exclusive period.
    /// 2. Call `Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period, wfx, None)`.
    /// 3. If `Initialize` returns `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED`:
    ///    - Call `GetBufferSize()` on the failed client to retrieve the hardware's required frame alignment.
    ///    - Compute `hnsAlignedPeriod = ((10_000_000.0 * aligned_frames / sample_rate) + 0.5) as i64`.
    ///    - Drop the old `IAudioClient`, call `device.Activate()` to obtain a fresh `IAudioClient`,
    ///      and call `Initialize` with `hnsAlignedPeriod`.
    unsafe fn initialize_exclusive_event_client(
        device: &IMMDevice,
        wfx: &WAVEFORMATEXTENSIBLE,
        sample_rate: u32,
    ) -> Result<(IAudioClient, u32, bool), WasapiPreloadError> {
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| {
            WasapiPreloadError::ExclusiveInitFailed(format!(
                "Failed to activate IAudioClient: {}",
                e
            ))
        })?;

        let mut default_period: i64 = 0;
        let mut min_period: i64 = 0;
        let _ = client.GetDevicePeriod(Some(&mut default_period), Some(&mut min_period));
        // Use a 10 ms target period (100_000 hns) or device default_period whichever is larger,
        // giving stable DMA cushions while remaining responsive.
        let target_period = default_period.max(100_000);
        let wfx_ptr = wfx as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;

        let init_res = client.Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            target_period,
            target_period,
            wfx_ptr,
            None,
        );

        match init_res {
            Ok(()) => {
                let buf_frames = client.GetBufferSize().map_err(|e| {
                    WasapiPreloadError::ExclusiveInitFailed(format!(
                        "GetBufferSize failed after Initialize: {}",
                        e
                    ))
                })?;
                Ok((client, buf_frames, false))
            }
            Err(err) if err.code().0 == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED_HR => {
                let aligned_frames = client.GetBufferSize().map_err(|e| {
                    WasapiPreloadError::ExclusiveInitFailed(format!(
                        "GetBufferSize failed during AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED recovery: {}",
                        e
                    ))
                })?;
                // Release the unaligned client before activating the replacement instance
                drop(client);

                let aligned_hns = ((10_000_000.0 * (aligned_frames as f64) / (sample_rate as f64))
                    + 0.5) as i64;

                let retry_client: IAudioClient =
                    device.Activate(CLSCTX_ALL, None).map_err(|e| {
                        WasapiPreloadError::ExclusiveInitFailed(format!(
                            "Failed to reactivate IAudioClient for aligned buffer size: {}",
                            e
                        ))
                    })?;

                retry_client
                    .Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                        aligned_hns,
                        aligned_hns,
                        wfx_ptr,
                        None,
                    )
                    .map_err(|e| {
                        WasapiPreloadError::ExclusiveInitFailed(format!(
                            "Aligned WASAPI Exclusive Initialize ({} frames / {} hns) failed: {}",
                            aligned_frames, aligned_hns, e
                        ))
                    })?;

                let final_frames = retry_client.GetBufferSize().unwrap_or(aligned_frames);
                Ok((retry_client, final_frames, true))
            }
            Err(err) => Err(WasapiPreloadError::ExclusiveInitFailed(format!(
                "WASAPI Exclusive Initialize failed (HRESULT {:#010x}): {}",
                err.code().0 as u32,
                err
            ))),
        }
    }

    pub fn spawn_exclusive_session(
        exact_wasapi_name: Option<String>,
        mut preloaded: PreloadedPcmTrack,
        cancel_token: Option<&AtomicBool>,
    ) -> Result<WasapiExclusiveSession, WasapiPreloadError> {
        if let Some(tok) = cancel_token {
            if tok.load(Ordering::Relaxed) {
                return Err(WasapiPreloadError::Cancelled(
                    "Cancelled before WASAPI Exclusive hardware init".to_string(),
                ));
            }
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let pause_flag = Arc::new(AtomicBool::new(false));

        // Create the manual/auto-reset event handle used by WASAPI event-driven DMA
        let event_handle: HANDLE =
            unsafe { CreateEventW(None, false, false, None) }.map_err(|e| {
                WasapiPreloadError::ExclusiveInitFailed(format!("CreateEventW failed: {}", e))
            })?;
        let wake_event_raw = event_handle.0 as usize;

        // Channel to report synchronous hardware initialization result from the dedicated render thread
        // before transitioning from `Loading` -> `Playing`.
        let (init_tx, init_rx) = std::sync::mpsc::channel::<
            Result<
                (
                    String,
                    NativePcmFormat,
                    usize,
                    Arc<WasapiExclusiveAtomicStats>,
                    ProcessHygieneCounters,
                ),
                WasapiPreloadError,
            >,
        >();

        let stop_worker = Arc::clone(&stop_flag);
        let pause_worker = Arc::clone(&pause_flag);
        let sample_rate = preloaded.sample_rate;
        let channels = preloaded.channels;
        let source_bit_depth = preloaded.source_bit_depth;
        let decode_duration_us = preloaded.decode_duration_us;
        let prefault_duration_us = preloaded.prefault_duration_us;
        let is_virtual_locked = preloaded.is_virtual_locked;

        let join_handle = thread::Builder::new()
            .name("cadence-wasapi-excl".to_string())
            .spawn(move || {
                let _com = ComInitGuard::acquire();
                let _thread_guard = StreamingThreadGuard::acquire();
                let hw_event = HANDLE(wake_event_raw as isize);

                let init_outcome = unsafe {
                    (|| -> Result<
                        (
                            IMMDevice,
                            IAudioClient,
                            IAudioRenderClient,
                            String,
                            u32,
                            bool,
                        ),
                        WasapiPreloadError,
                    > {
                        let (device, dev_name) =
                            find_matching_mmdevice(exact_wasapi_name.as_deref())?;
                        let probe_client: IAudioClient =
                            device.Activate(CLSCTX_ALL, None).map_err(|e| {
                                WasapiPreloadError::ExclusiveInitFailed(format!(
                                    "Failed to activate probe IAudioClient: {}",
                                    e
                                ))
                            })?;
                        let wfx = negotiate_exclusive_format(&probe_client, &mut preloaded)?;
                        drop(probe_client);

                        let (client, buf_frames, realigned) =
                            initialize_exclusive_event_client(&device, &wfx, preloaded.sample_rate)?;

                        client.SetEventHandle(hw_event).map_err(|e| {
                            WasapiPreloadError::ExclusiveInitFailed(format!(
                                "SetEventHandle failed: {}",
                                e
                            ))
                        })?;

                        let render_client: IAudioRenderClient =
                            client.GetService().map_err(|e| {
                                WasapiPreloadError::ExclusiveInitFailed(format!(
                                    "GetService(IAudioRenderClient) failed: {}",
                                    e
                                ))
                            })?;

                        // Prime the initial hardware DMA buffer before calling Start() so the DAC
                        // clock starts with a full buffer and zero initial underrun.
                        let prime_frames = (buf_frames as usize).min(preloaded.total_frames);
                        let stride = preloaded.frame_stride_bytes;
                        let dst_ptr = render_client.GetBuffer(buf_frames).map_err(|e| {
                            WasapiPreloadError::ExclusiveInitFailed(format!(
                                "Initial GetBuffer({}) failed: {}",
                                buf_frames, e
                            ))
                        })?;
                        let prime_bytes = prime_frames * stride;
                        std::ptr::copy_nonoverlapping(
                            preloaded.as_bytes().as_ptr(),
                            dst_ptr,
                            prime_bytes,
                        );
                        let total_buf_bytes = (buf_frames as usize) * stride;
                        if total_buf_bytes > prime_bytes {
                            std::ptr::write_bytes(
                                dst_ptr.add(prime_bytes),
                                0,
                                total_buf_bytes - prime_bytes,
                            );
                        }
                        render_client.ReleaseBuffer(buf_frames, 0).map_err(|e| {
                            WasapiPreloadError::ExclusiveInitFailed(format!(
                                "Initial ReleaseBuffer failed: {}",
                                e
                            ))
                        })?;

                        Ok((
                            device,
                            client,
                            render_client,
                            dev_name,
                            buf_frames,
                            realigned,
                        ))
                    })()
                };

                let (_device, client, render_client, dev_name, buf_frames, realigned) =
                    match init_outcome {
                        Ok(tuple) => tuple,
                        Err(e) => {
                            unsafe {
                                let _ = CloseHandle(hw_event);
                            }
                            let _ = init_tx.send(Err(e));
                            return;
                        }
                    };

                let initial_prime = (buf_frames as usize).min(preloaded.total_frames);
                let stats = Arc::new(WasapiExclusiveAtomicStats::new(
                    preloaded.total_frames,
                    buf_frames,
                    realigned,
                ));
                stats
                    .rendered_frames
                    .store(initial_prime, Ordering::Release);

                // Snapshot OS process I/O and page-fault counters right BEFORE starting the clock
                // (outside the real-time loop) so post-start deltas measure strictly the `Playing` window.
                let baseline_counters = snapshot_process_hygiene_counters();

                if let Err(e) = unsafe { client.Start() } {
                    unsafe {
                        let _ = CloseHandle(hw_event);
                    }
                    let _ = init_tx.send(Err(WasapiPreloadError::ExclusiveInitFailed(format!(
                        "IAudioClient::Start failed: {}",
                        e
                    ))));
                    return;
                }

                let _ = init_tx.send(Ok((
                    dev_name,
                    preloaded.format,
                    preloaded.as_bytes().len(),
                    Arc::clone(&stats),
                    baseline_counters,
                )));

                // =========================================================================
                // REAL-TIME EVENT-DRIVEN WASAPI EXCLUSIVE RENDER LOOP
                // Zero allocations, zero mutexes, zero logging, zero syscalls besides
                // WaitForSingleObject + GetBuffer/ReleaseBuffer.
                // =========================================================================
                let pcm_ptr = preloaded.as_bytes().as_ptr();
                let total_frames = preloaded.total_frames;
                let stride = preloaded.frame_stride_bytes;
                let total_buf_bytes = (buf_frames as usize) * stride;
                let mut is_client_started = true;
                let mut last_cb_instant: Option<Instant> = None;

                while !stop_worker.load(Ordering::Acquire) {
                    if pause_worker.load(Ordering::Acquire) {
                        if is_client_started {
                            unsafe {
                                let _ = client.Stop();
                            }
                            is_client_started = false;
                            last_cb_instant = None;
                        }
                        unsafe {
                            let _ = WaitForSingleObject(hw_event, 50);
                        }
                        continue;
                    } else if !is_client_started {
                        unsafe {
                            let _ = client.Start();
                        }
                        is_client_started = true;
                        last_cb_instant = None;
                    }

                    let wait_res = unsafe { WaitForSingleObject(hw_event, 200) };
                    if stop_worker.load(Ordering::Acquire) {
                        break;
                    }
                    if wait_res == WAIT_TIMEOUT {
                        stats.underrun_count.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    if wait_res != WAIT_OBJECT_0 {
                        break;
                    }

                    let cb_now = Instant::now();
                    if let Some(prev) = last_cb_instant {
                        let dt_us = cb_now.duration_since(prev).as_micros() as u64;
                        stats
                            .sum_callback_interval_us
                            .fetch_add(dt_us, Ordering::Relaxed);
                        let mut cur_min = stats.min_callback_interval_us.load(Ordering::Relaxed);
                        while dt_us < cur_min {
                            match stats.min_callback_interval_us.compare_exchange_weak(
                                cur_min,
                                dt_us,
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            ) {
                                Ok(_) => break,
                                Err(v) => cur_min = v,
                            }
                        }
                        let mut cur_max = stats.max_callback_interval_us.load(Ordering::Relaxed);
                        while dt_us > cur_max {
                            match stats.max_callback_interval_us.compare_exchange_weak(
                                cur_max,
                                dt_us,
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            ) {
                                Ok(_) => break,
                                Err(v) => cur_max = v,
                            }
                        }
                    }
                    last_cb_instant = Some(cb_now);

                    let cursor = stats.rendered_frames.load(Ordering::Relaxed);
                    if cursor >= total_frames {
                        stats.stream_finished.store(true, Ordering::Release);
                        break;
                    }

                    unsafe {
                        let Ok(dst_ptr) = render_client.GetBuffer(buf_frames) else {
                            stats.underrun_count.fetch_add(1, Ordering::Relaxed);
                            continue;
                        };

                        let remaining_frames = total_frames - cursor;
                        let copy_frames = remaining_frames.min(buf_frames as usize);
                        let copy_bytes = copy_frames * stride;
                        let src_offset = cursor * stride;

                        std::ptr::copy_nonoverlapping(
                            pcm_ptr.add(src_offset),
                            dst_ptr,
                            copy_bytes,
                        );
                        if total_buf_bytes > copy_bytes {
                            std::ptr::write_bytes(
                                dst_ptr.add(copy_bytes),
                                0,
                                total_buf_bytes - copy_bytes,
                            );
                        }

                        let _ = render_client.ReleaseBuffer(buf_frames, 0);
                        stats
                            .rendered_frames
                            .store(cursor + copy_frames, Ordering::Release);
                    }

                    let fill_us = cb_now.elapsed().as_micros() as u64;
                    stats.callback_count.fetch_add(1, Ordering::Relaxed);
                    stats
                        .sum_fill_duration_us
                        .fetch_add(fill_us, Ordering::Relaxed);
                    let mut max_fill = stats.max_fill_duration_us.load(Ordering::Relaxed);
                    while fill_us > max_fill {
                        match stats.max_fill_duration_us.compare_exchange_weak(
                            max_fill,
                            fill_us,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        ) {
                            Ok(_) => break,
                            Err(v) => max_fill = v,
                        }
                    }
                }

                // Drain final hardware buffer if stream finished naturally
                if stats.stream_finished.load(Ordering::Acquire)
                    && !stop_worker.load(Ordering::Acquire)
                {
                    let drain_ms = (((buf_frames as u64) * 1000) / (sample_rate.max(1) as u64))
                        .clamp(5, 100);
                    thread::sleep(Duration::from_millis(drain_ms));
                }

                unsafe {
                    if is_client_started {
                        let _ = client.Stop();
                    }
                    let _ = CloseHandle(hw_event);
                }
                // `preloaded` drops here after `client.Stop()`, unlocking `VirtualLock` if enabled.
            })
            .map_err(|e| {
                unsafe {
                    let _ = CloseHandle(event_handle);
                }
                WasapiPreloadError::ExclusiveInitFailed(format!(
                    "Failed to spawn cadence-wasapi-excl thread: {}",
                    e
                ))
            })?;

        match init_rx.recv() {
            Ok(Ok((device_name, format, preloaded_pcm_bytes, stats, baseline_counters))) => {
                diag_log!(
                    DiagCategory::WasapiLifecycle,
                    0,
                    decode_duration_us,
                    prefault_duration_us,
                    "wasapi_excl_started",
                    "dev={} rate={} ch={} fmt={} bytes={} vlock={} buf_frames={} realigned={}",
                    device_name,
                    sample_rate,
                    channels,
                    format.as_str(),
                    preloaded_pcm_bytes,
                    is_virtual_locked,
                    stats.aligned_buffer_frames.load(Ordering::Relaxed),
                    stats.buffer_realigned.load(Ordering::Relaxed)
                );
                Ok(WasapiExclusiveSession {
                    stop_flag,
                    pause_flag,
                    wake_event_raw,
                    join_handle: Some(join_handle),
                    stats,
                    device_name,
                    sample_rate,
                    channels,
                    source_bit_depth,
                    format,
                    preloaded_pcm_bytes,
                    decode_duration_us,
                    prefault_duration_us,
                    is_virtual_locked,
                    baseline_counters,
                })
            }
            Ok(Err(err)) => {
                let _ = join_handle.join();
                Err(err)
            }
            Err(e) => {
                let _ = join_handle.join();
                Err(WasapiPreloadError::ExclusiveInitFailed(format!(
                    "WASAPI Exclusive worker terminated during initialization: {}",
                    e
                )))
            }
        }
    }
}

#[cfg(windows)]
pub use win_exclusive::{build_waveformatextensible, spawn_exclusive_session};

#[cfg(not(windows))]
pub fn spawn_exclusive_session(
    _exact_wasapi_name: Option<String>,
    _preloaded: PreloadedPcmTrack,
    _cancel_token: Option<&AtomicBool>,
) -> Result<WasapiExclusiveSession, WasapiPreloadError> {
    Err(WasapiPreloadError::DeviceUnavailable(
        "WASAPI Exclusive is only supported on Windows.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Helper to generate a valid synthetic uncompressed WAV file (16-bit, 24-bit, or 32-bit PCM)
    fn write_test_wav(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        frame_samples_i32: &[i32],
    ) {
        let bytes_per_sample = (bits_per_sample / 8) as usize;
        let data_bytes_len = frame_samples_i32.len() * bytes_per_sample;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * (block_align as u32);
        let riff_size = (36 + data_bytes_len) as u32;

        let mut f = File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&riff_size.to_le_bytes()).unwrap();
        f.write_all(b"WAVE").unwrap();
        f.write_all(b"fmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM = 1
        f.write_all(&channels.to_le_bytes()).unwrap();
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&byte_rate.to_le_bytes()).unwrap();
        f.write_all(&block_align.to_le_bytes()).unwrap();
        f.write_all(&bits_per_sample.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&(data_bytes_len as u32).to_le_bytes()).unwrap();

        for &s in frame_samples_i32 {
            match bits_per_sample {
                16 => f.write_all(&(s as i16).to_le_bytes()).unwrap(),
                24 => {
                    let le = s.to_le_bytes();
                    f.write_all(&[le[0], le[1], le[2]]).unwrap();
                }
                32 => f.write_all(&s.to_le_bytes()).unwrap(),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn native_16bit_24bit_and_32bit_pcm_decode_bit_identically_without_f32_conversion() {
        let temp_dir = std::env::temp_dir();

        // 1. Test 16-bit exact bit-identity (including full-scale extremes -32768 and +32767)
        let wav16 = temp_dir.join("cadence_test_16bit.wav");
        let samples16: Vec<i32> = vec![-32768, 32767, -1, 0, 1, 12345, -23456, 42];
        write_test_wav(&wav16, 44_100, 2, 16, &samples16);

        let track16 =
            decode_file_to_ram(&wav16, &PreloadAdmissionConfig::default(), None).unwrap();
        assert_eq!(track16.sample_rate, 44_100);
        assert_eq!(track16.channels, 2);
        assert_eq!(track16.source_bit_depth, 16);
        assert_eq!(track16.format, NativePcmFormat::I16);
        assert_eq!(track16.total_frames, 4);
        for (idx, chunk) in track16.as_bytes().chunks_exact(2).enumerate() {
            let decoded_s16 = i16::from_le_bytes([chunk[0], chunk[1]]) as i32;
            assert_eq!(decoded_s16, samples16[idx], "16-bit sample mismatch at {}", idx);
        }
        let _ = std::fs::remove_file(&wav16);

        // 2. Test 24-bit exact bit-identity (including 24-bit extremes -8_388_608 and +8_388_607)
        // Note: Converting 8_388_607 through IEEE-754 f32 (which only has 24 bits of mantissa + sign)
        // and scaling can introduce LSB rounding error on asymmetric extremes; native integer preserves every bit.
        let wav24 = temp_dir.join("cadence_test_24bit.wav");
        let samples24: Vec<i32> = vec![
            -8_388_608,
            8_388_607,
            -1,
            0,
            1,
            0x0055_AA55,
            -0x0055_AA55,
            0x007F_FFFF,
        ];
        write_test_wav(&wav24, 96_000, 2, 24, &samples24);

        let mut track24 =
            decode_file_to_ram(&wav24, &PreloadAdmissionConfig::default(), None).unwrap();
        assert_eq!(track24.sample_rate, 96_000);
        assert_eq!(track24.channels, 2);
        assert_eq!(track24.source_bit_depth, 24);
        assert_eq!(track24.format, NativePcmFormat::I24InI32Msb);
        assert_eq!(track24.total_frames, 4);

        for (idx, chunk) in track24.as_bytes().chunks_exact(4).enumerate() {
            assert_eq!(chunk[0], 0, "LSB pad byte in 24-in-32 MSB must be 0x00");
            let raw32 = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let recovered_s24 = raw32 >> 8;
            assert_eq!(recovered_s24, samples24[idx], "24-bit sample mismatch at {}", idx);
        }

        // Also verify in-place conversion to 3-byte packed 24-bit (`S24_3LE`) and promotion back
        pack_i24_msb32_to_i24_packed_in_place(&mut track24);
        assert_eq!(track24.format, NativePcmFormat::I24Packed);
        assert_eq!(track24.as_bytes().len(), samples24.len() * 3);
        track24
            .promote_i24_packed_to_i32_msb(&PreloadAdmissionConfig::default(), None)
            .unwrap();
        assert_eq!(track24.format, NativePcmFormat::I24InI32Msb);
        for (idx, chunk) in track24.as_bytes().chunks_exact(4).enumerate() {
            let recovered_s24 =
                i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) >> 8;
            assert_eq!(recovered_s24, samples24[idx]);
        }
        let _ = std::fs::remove_file(&wav24);

        // 3. Test 32-bit integer exact bit-identity (32-bit values cannot be represented losslessly in f32!)
        let wav32 = temp_dir.join("cadence_test_32bit.wav");
        let samples32: Vec<i32> = vec![
            i32::MIN,
            i32::MAX,
            0x7FFF_FFFE,
            -0x7FFF_FFFD,
            0x1234_5678,
            -0x1234_5678,
        ];
        write_test_wav(&wav32, 192_000, 2, 32, &samples32);

        let track32 =
            decode_file_to_ram(&wav32, &PreloadAdmissionConfig::default(), None).unwrap();
        assert_eq!(track32.sample_rate, 192_000);
        assert_eq!(track32.format, NativePcmFormat::I32);
        for (idx, chunk) in track32.as_bytes().chunks_exact(4).enumerate() {
            let s32 = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            assert_eq!(s32, samples32[idx], "32-bit sample mismatch at {}", idx);
        }
        let _ = std::fs::remove_file(&wav32);
    }

    #[test]
    fn memory_admission_rejects_oversized_tracks_and_cancellation_aborts_cleanly() {
        let temp_dir = std::env::temp_dir();
        let wav_path = temp_dir.join("cadence_test_admission.wav");
        let samples: Vec<i32> = vec![1000; 4096];
        write_test_wav(&wav_path, 44_100, 2, 16, &samples);

        // 1. Strict cap smaller than the file's 8 KB PCM payload must reject explicitly
        let strict_cfg = PreloadAdmissionConfig {
            max_track_bytes: 1024,
            ..Default::default()
        };
        let err = decode_file_to_ram(&wav_path, &strict_cfg, None).unwrap_err();
        assert!(matches!(err, WasapiPreloadError::AdmissionRejected(_)));

        // 2. Pre-set cancellation token aborts during Loading before decoding completes
        let cancel = AtomicBool::new(true);
        let cancel_err =
            decode_file_to_ram(&wav_path, &PreloadAdmissionConfig::default(), Some(&cancel))
                .unwrap_err();
        assert!(matches!(cancel_err, WasapiPreloadError::Cancelled(_)));

        let _ = std::fs::remove_file(&wav_path);
    }

    #[test]
    fn unsupported_formats_and_dsd_fail_explicitly_without_silent_conversion() {
        let temp_dir = std::env::temp_dir();
        let dsf_path = temp_dir.join("cadence_test_fake.dsf");
        std::fs::write(&dsf_path, b"DSD ").unwrap();

        let err =
            decode_file_to_ram(&dsf_path, &PreloadAdmissionConfig::default(), None).unwrap_err();
        assert!(matches!(err, WasapiPreloadError::UnsupportedFormat(_)));
        let _ = std::fs::remove_file(&dsf_path);

        // Verify lossy codecs (e.g., MP3) are explicitly rejected by resolve_lossless_pcm_format
        let mp3_err = resolve_lossless_pcm_format(
            symphonia::core::codecs::CODEC_TYPE_MP3,
            Some(16),
        )
        .unwrap_err();
        assert!(matches!(mp3_err, WasapiPreloadError::UnsupportedFormat(_)));
    }

    #[test]
    fn flac_and_alac_lossless_integer_bit_identity_verification() {
        use std::process::Command;
        let ffmpeg_ok = Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ffmpeg_ok {
            return;
        }

        let temp_dir = std::env::temp_dir();

        // 1. 16-bit / 44.1 kHz FLAC & ALAC bit-identity
        let wav16 = temp_dir.join("cadence_bitid_16.wav");
        let flac16 = temp_dir.join("cadence_bitid_16.flac");
        let alac16 = temp_dir.join("cadence_bitid_16.m4a");
        let mut samples16 = Vec::with_capacity(44_100 * 2);
        for i in 0..(44_100 * 2) {
            let v = match i % 8 {
                0 => -32768,
                1 => 32767,
                2 => -1,
                3 => 0,
                4 => 1,
                _ => (((i as u32).wrapping_mul(1103515245).wrapping_add(12345) >> 16) & 0x7FFF) as i32,
            };
            samples16.push(v);
        }
        write_test_wav(&wav16, 44_100, 2, 16, &samples16);

        let _ = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-i",
                wav16.to_str().unwrap(),
                "-c:a",
                "flac",
                flac16.to_str().unwrap(),
            ])
            .status();
        let _ = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-i",
                wav16.to_str().unwrap(),
                "-c:a",
                "alac",
                alac16.to_str().unwrap(),
            ])
            .status();

        let ref16 = decode_file_to_ram(&wav16, &PreloadAdmissionConfig::default(), None).unwrap();
        let dec_flac16 =
            decode_file_to_ram(&flac16, &PreloadAdmissionConfig::default(), None).unwrap();
        let dec_alac16 =
            decode_file_to_ram(&alac16, &PreloadAdmissionConfig::default(), None).unwrap();

        assert_eq!(dec_flac16.format, NativePcmFormat::I16);
        assert_eq!(dec_alac16.format, NativePcmFormat::I16);
        assert_eq!(
            dec_flac16.as_bytes(),
            ref16.as_bytes(),
            "16-bit FLAC decoded RAM buffer must be 100% bit-identical to reference PCM"
        );
        assert_eq!(
            dec_alac16.as_bytes(),
            ref16.as_bytes(),
            "16-bit ALAC decoded RAM buffer must be 100% bit-identical to reference PCM"
        );

        let _ = std::fs::remove_file(&wav16);
        let _ = std::fs::remove_file(&flac16);
        let _ = std::fs::remove_file(&alac16);

        // 2. 24-bit / 96 kHz FLAC & ALAC bit-identity
        let wav24 = temp_dir.join("cadence_bitid_24.wav");
        let flac24 = temp_dir.join("cadence_bitid_24.flac");
        let alac24 = temp_dir.join("cadence_bitid_24.m4a");
        let mut samples24 = Vec::with_capacity(96_000 * 2);
        for i in 0..(96_000 * 2) {
            let v = match i % 8 {
                0 => -8_388_608,
                1 => 8_388_607,
                2 => -1,
                3 => 0,
                4 => 1,
                5 => 0x0055_AA55,
                6 => -0x0055_AA55,
                _ => (((i as u32).wrapping_mul(2654435761u32) >> 8) & 0x007F_FFFF) as i32,
            };
            samples24.push(v);
        }
        write_test_wav(&wav24, 96_000, 2, 24, &samples24);

        let _ = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-i",
                wav24.to_str().unwrap(),
                "-c:a",
                "flac",
                flac24.to_str().unwrap(),
            ])
            .status();
        let _ = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-i",
                wav24.to_str().unwrap(),
                "-c:a",
                "alac",
                "-sample_fmt",
                "s32p",
                "-bits_per_raw_sample",
                "24",
                alac24.to_str().unwrap(),
            ])
            .status();

        let ref24 = decode_file_to_ram(&wav24, &PreloadAdmissionConfig::default(), None).unwrap();
        let dec_flac24 =
            decode_file_to_ram(&flac24, &PreloadAdmissionConfig::default(), None).unwrap();
        let dec_alac24 =
            decode_file_to_ram(&alac24, &PreloadAdmissionConfig::default(), None).unwrap();

        assert_eq!(dec_flac24.format, NativePcmFormat::I24InI32Msb);
        assert_eq!(dec_alac24.format, NativePcmFormat::I24InI32Msb);
        assert_eq!(
            dec_flac24.as_bytes(),
            ref24.as_bytes(),
            "24-bit FLAC decoded RAM buffer must be 100% bit-identical to reference S24_32LE_MSB"
        );
        assert_eq!(
            dec_alac24.as_bytes(),
            ref24.as_bytes(),
            "24-bit ALAC decoded RAM buffer must be 100% bit-identical to reference S24_32LE_MSB"
        );

        let _ = std::fs::remove_file(&wav24);
        let _ = std::fs::remove_file(&flac24);
        let _ = std::fs::remove_file(&alac24);
    }

    #[test]
    fn tier3_wasapi_exclusive_benchmark_suite() {
        if std::env::var("CADENCE_RUN_TIER3_BENCH").as_deref() != Ok("1") {
            return;
        }
        use std::process::Command;
        let temp_dir = std::env::temp_dir();
        let pid = std::process::id();
        eprintln!("\n[BENCH_META] process_id={} (0x{:08X})", pid, pid);

        fn current_etw_filetime_100ns() -> u64 {
            // Windows Epoch (1601-01-01) to Unix Epoch (1970-01-01) is 116,444,736,000,000,000 100-ns ticks
            const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
            let dur = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            EPOCH_DIFF_100NS + (dur.as_secs() * 10_000_000) + (dur.subsec_nanos() as u64 / 100)
        }

        // Part A: Full-Track RAM Preload & Page Pre-Fault Benchmarks (WAV & FLAC)
        let profiles: &[(&str, u32, u16, u16, usize)] = &[
            ("16-bit / 44.1 kHz (180s)", 44_100, 2, 16, 44_100 * 180),
            ("24-bit / 48.0 kHz (180s)", 48_000, 2, 24, 48_000 * 180),
            ("24-bit / 96.0 kHz (180s)", 96_000, 2, 24, 96_000 * 180),
            ("24-bit / 192.0 kHz (60s)", 192_000, 2, 24, 192_000 * 60),
        ];

        eprintln!("\n=== TIER 3 BENCHMARK: FULL-TRACK LOSSLESS INTEGER RAM PRELOAD (WAV & FLAC) ===");
        for &(label, rate, ch, bits, frames) in profiles {
            let wav_path = temp_dir.join(format!("cadence_bench_{}_{}.wav", rate, bits));
            let flac_path = temp_dir.join(format!("cadence_bench_{}_{}.flac", rate, bits));
            {
                let bytes_per_sample = (bits / 8) as usize;
                let data_bytes_len = frames * (ch as usize) * bytes_per_sample;
                let block_align = ch * (bits / 8);
                let byte_rate = rate * (block_align as u32);
                let riff_size = (36 + data_bytes_len) as u32;
                let mut f = File::create(&wav_path).unwrap();
                f.write_all(b"RIFF").unwrap();
                f.write_all(&riff_size.to_le_bytes()).unwrap();
                f.write_all(b"WAVEfmt ").unwrap();
                f.write_all(&16u32.to_le_bytes()).unwrap();
                f.write_all(&1u16.to_le_bytes()).unwrap();
                f.write_all(&ch.to_le_bytes()).unwrap();
                f.write_all(&rate.to_le_bytes()).unwrap();
                f.write_all(&byte_rate.to_le_bytes()).unwrap();
                f.write_all(&block_align.to_le_bytes()).unwrap();
                f.write_all(&bits.to_le_bytes()).unwrap();
                f.write_all(b"data").unwrap();
                f.write_all(&(data_bytes_len as u32).to_le_bytes()).unwrap();
                // Deterministic pseudo-random audio waveform so FLAC predictor exercises real LPC decoding
                let mut chunk = vec![0u8; 1024 * 1024];
                for (idx, b) in chunk.iter_mut().enumerate() {
                    *b = ((idx.wrapping_mul(1315423911) >> 16) & 0x3F) as u8;
                }
                let mut rem = data_bytes_len;
                while rem > 0 {
                    let n = rem.min(chunk.len());
                    f.write_all(&chunk[..n]).unwrap();
                    rem -= n;
                }
            }

            let has_flac = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    wav_path.to_str().unwrap(),
                    "-c:a",
                    "flac",
                    flac_path.to_str().unwrap(),
                ])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            let mut containers = vec![("WAV", wav_path.as_path())];
            if has_flac {
                containers.push(("FLAC", flac_path.as_path()));
            }

            for (codec_label, target_path) in containers {
                for &vlock in &[false, true] {
                    let cfg = PreloadAdmissionConfig {
                        virtual_lock_enabled: vlock,
                        ..Default::default()
                    };
                    let c_before = snapshot_process_hygiene_counters();
                    let track = decode_file_to_ram(target_path, &cfg, None).unwrap();
                    let c_after_load = snapshot_process_hygiene_counters();

                    // Simulate full-track DMA ring-buffer pulls across every 4 KB page in RAM
                    let mut checksum: u64 = 0;
                    for page in track.as_bytes().chunks(4096) {
                        checksum = checksum.wrapping_add(page[0] as u64);
                    }
                    std::hint::black_box(checksum);
                    let c_after_scan = snapshot_process_hygiene_counters();

                    let pf_during_load = c_after_load
                        .page_fault_count
                        .saturating_sub(c_before.page_fault_count);
                    let pf_during_scan = c_after_scan
                        .page_fault_count
                        .saturating_sub(c_after_load.page_fault_count);
                    let io_during_scan = c_after_scan
                        .io_read_bytes
                        .saturating_sub(c_after_load.io_read_bytes);

                    eprintln!(
                        "[PRELOAD] {:<4} {:<24} | vlock={:<5} | fmt={:<12} | pcm_mb={:>6.2} MB | decode={:>6.2} ms | prefault={:>5.2} ms | pf_load={:>6} | pf_play_scan={} | disk_read_play_scan={} B",
                        codec_label,
                        label,
                        track.is_virtual_locked,
                        track.format.as_str(),
                        track.as_bytes().len() as f64 / (1024.0 * 1024.0),
                        track.decode_duration_us as f64 / 1000.0,
                        track.prefault_duration_us as f64 / 1000.0,
                        pf_during_load,
                        pf_during_scan,
                        io_during_scan
                    );
                    assert_eq!(
                        io_during_scan, 0,
                        "Zero disk read bytes must occur while reading preloaded RAM buffer"
                    );
                }
            }
            let _ = std::fs::remove_file(&wav_path);
            let _ = std::fs::remove_file(&flac_path);
        }

        // Part B: Live WASAPI Exclusive Hardware Session Benchmark (Digital Silence)
        eprintln!("\n=== TIER 3 BENCHMARK: LIVE WASAPI EXCLUSIVE HARDWARE SESSION ===");
        let hw_rates: &[(u32, u16)] = &[(48_000, 24), (44_100, 16), (96_000, 24)];
        for &(rate, bits) in hw_rates {
            let wav_path = temp_dir.join(format!("cadence_hw_excl_{}_{}.wav", rate, bits));
            let frames = (rate as usize) * 4; // 4 seconds track
            let samples = vec![0i32; frames * 2];
            write_test_wav(&wav_path, rate, 2, bits, &samples);

            let cfg = PreloadAdmissionConfig {
                virtual_lock_enabled: true,
                ..Default::default()
            };
            let preloaded = decode_file_to_ram(&wav_path, &cfg, None).unwrap();
            match spawn_exclusive_session(None, preloaded, None) {
                Ok(mut session) => {
                    let etw_clock_start = current_etw_filetime_100ns();
                    std::thread::sleep(Duration::from_millis(2500));
                    let etw_clock_end = current_etw_filetime_100ns();
                    let snap = session.snapshot_telemetry();
                    session.stop();
                    eprintln!(
                        "[HW_EXCL] pid=0x{:08X} | etw_window={}..{} | dev={:?} | rate={} Hz | fmt={} | buf_frames={} (realigned={}) | callbacks={} | cb_interval_us(min/avg/max)={}/{}/{} | fill_us(avg/max)={}/{} | underruns={} | pf_play={} | disk_read_play={} B (ops={})",
                        pid,
                        etw_clock_start,
                        etw_clock_end,
                        snap.device_name,
                        snap.sample_rate,
                        snap.hardware_pcm_format,
                        snap.aligned_buffer_frames,
                        snap.buffer_realigned_on_init,
                        snap.callback_count,
                        snap.min_callback_interval_us,
                        snap.avg_callback_interval_us,
                        snap.max_callback_interval_us,
                        snap.avg_fill_duration_us,
                        snap.max_fill_duration_us,
                        snap.underrun_count,
                        snap.page_faults_since_start,
                        snap.process_io_read_bytes_since_start,
                        snap.process_io_read_ops_since_start,
                    );
                    assert_eq!(snap.underrun_count, 0, "Zero underruns expected in WASAPI Exclusive");
                    assert_eq!(
                        snap.process_io_read_bytes_since_start, 0,
                        "Zero disk read bytes expected during WASAPI Exclusive playback"
                    );
                }
                Err(e) => {
                    eprintln!("[HW_EXCL] rate={} Hz bits={} skipped/rejected by default device: {}", rate, bits, e);
                }
            }
            let _ = std::fs::remove_file(&wav_path);
        }
    }
}
