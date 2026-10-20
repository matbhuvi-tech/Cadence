//! Low-noise streaming primitives for the UPnP HTTP server.
//!
//! Everything in here operates on *untouched* file bytes — nothing is decoded,
//! resampled or altered. The goal is purely to reduce host/receiver activity:
//!   * RAM pre-loading with `VirtualLock` (storage stays idle during playback)
//!   * Windowed, page-locked read-ahead when a file is too large to hold whole
//!   * RAM budget derived from available physical memory (or a user limit)
//!   * MMCSS "Pro Audio" thread registration
//!   * CPU affinity away from Core 0 (where Windows services NIC DPCs/interrupts)
//!   * 1 ms system timer resolution while a paced stream is active
//!
//! On non-Windows targets the OS-specific helpers degrade to harmless no-ops.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MB: u64 = 1024 * 1024;

/// Fixed chunk size written per paced tick.
pub const CHUNK_BYTES: usize = 16 * 1024;

/// Rounds a buffer size up to the nearest 16 KB (16,384 byte) chunk boundary.
/// Matches Windows Winsock 4 KB physical memory page allocation granularity (4 x 4 KB pages)
/// and Cadence's 16 KB chunk delivery size, ensuring deterministic allocation without
/// internal kernel page fragmentation or unexpected heap doubling.
#[inline]
pub const fn align_to_chunk_boundary(size: usize) -> usize {
    const ALIGN_MASK: usize = CHUNK_BYTES - 1;
    (size + ALIGN_MASK) & !ALIGN_MASK
}

/// Target audio in-flight duration for steady-state SO_SNDBUF (100 ms).
pub const TARGET_SNDBUF_DURATION_SECS: f64 = 0.100;

/// Floor for kernel TCP send buffer (16 KB) to prevent underruns on low-bitrate streams.
pub const MIN_SOCKET_SNDBUF_BYTES: usize = 16 * 1024;

/// Backward-compatible alias for minimum socket send buffer.
pub const SOCKET_SNDBUF_BYTES: usize = MIN_SOCKET_SNDBUF_BYTES;

/// Ceiling for steady-state kernel TCP send buffer (32 KB) to physically prevent
/// kernel-level hoard-and-flush micro-bursts when TCP windows reopen after backpressure stalls.
pub const MAX_SOCKET_SNDBUF_BYTES: usize = 32 * 1024;

/// Baseline kernel TCP send buffer for the initial unpaced pre-roll burst.
pub const SOCKET_FAST_START_SNDBUF: usize = 256 * 1024;

/// Ceiling for fast-start send buffer (8 MB) for ultra-high-rate multi-channel DSD.
pub const MAX_SOCKET_FAST_START_SNDBUF: usize = 8 * 1024 * 1024;

/// Computes the dynamic steady-state kernel TCP send buffer (`SO_SNDBUF`).
/// Clamped between 16 KB and 32 KB (max 2 chunks) to prevent the OS kernel from
/// hoarding un-ACKed data during temporary TCP window stalls and blasting it onto the wire
/// when the receiver reopens its window:
///
///   `raw = clamp(bitrate_bytes_per_sec * 0.100, 16 KB, 32 KB)`
///   `SO_SNDBUF = (raw + 16383) & !16383`
pub fn calculate_sndbuf_bytes(bitrate_bytes_per_sec: f64) -> usize {
    if bitrate_bytes_per_sec <= 0.0 {
        return MIN_SOCKET_SNDBUF_BYTES;
    }
    let target = (bitrate_bytes_per_sec * TARGET_SNDBUF_DURATION_SECS).round() as usize;
    let clamped = target.clamp(MIN_SOCKET_SNDBUF_BYTES, MAX_SOCKET_SNDBUF_BYTES);
    align_to_chunk_boundary(clamped)
}

/// Computes the dynamic fast-start send buffer for unpaced pre-roll bursts.
/// Sized to accommodate initial bursts without blocking, scaling with high bitrate
/// and rounded up to the nearest 16 KB Winsock page boundary.
pub fn calculate_fast_start_sndbuf_bytes(bitrate_bytes_per_sec: f64) -> usize {
    let steady = calculate_sndbuf_bytes(bitrate_bytes_per_sec);
    let clamped = (steady * 4).clamp(SOCKET_FAST_START_SNDBUF, MAX_SOCKET_FAST_START_SNDBUF);
    align_to_chunk_boundary(clamped)
}

/// State 1: Ramp-Up delivery rate relative to real-time (1.25x).
/// Quickly primes the streamer's hardware FIFO ring buffer (4–8 MB) without wire-speed gigabit burst current.
pub const RAMP_UP_MULTIPLIER: f64 = 1.25;

/// State 2: Initial rate reduction upon detecting TCP backpressure / ZeroWindow stalls (1.02x).
pub const BACKPRESSURE_STEPDOWN_MULTIPLIER: f64 = 1.02;

/// State 3: Minimum steady cruising rate relative to real-time (+0.2% over real-time).
pub const STABLE_MIN_MULTIPLIER: f64 = 1.002;

/// State 3: Gentle rate increment per sustained stable observation window (+0.5%).
pub const STABLE_PROBE_INCREMENT: f64 = 0.005;

/// State 3: Maximum probing rate ceiling (1.05x).
pub const STABLE_PROBE_CEILING: f64 = 1.05;

/// Sustained period of stall-free transmission required before probing upward (8 seconds).
pub const STABILITY_WINDOW_SECS: f64 = 8.0;

/// Backward-compatible aliases
pub const INITIAL_PACE_MULTIPLIER: f64 = RAMP_UP_MULTIPLIER;
pub const STEADY_PACE_MULTIPLIER: f64 = BACKPRESSURE_STEPDOWN_MULTIPLIER;
pub const PACE_MULTIPLIER: f64 = INITIAL_PACE_MULTIPLIER;

/// Maximum duration of audio sent unpaced at the start of a request (0.5s).
pub const PREROLL_SECS: f64 = 0.5;

/// Ceiling for the initial fast-start pre-roll burst (512 KB) to ensure the streamer's
/// internal FIFO ring buffer remains ~90% empty, preventing high-watermark ZeroWindow stalls.
pub const MAX_PREROLL_BYTES: u64 = 512 * 1024;

/// Hysteresis threshold in milliseconds for TCP backpressure detection.
/// Minor OS sleep wakeup variance (< 25 ms) is absorbed by the cumulative deadline clock.
/// Stalls exceeding 25 ms indicate true kernel socket backpressure / TCP ZeroWindow.
pub const BACKPRESSURE_SLOP_MS: u64 = 25;
pub const BACKPRESSURE_STALL_MS: u64 = BACKPRESSURE_SLOP_MS;

/// Never pace slower than this (guards against bad duration metadata).
pub const MIN_PACE_BYTES_PER_SEC: f64 = 64.0 * 1024.0;

/// Calculates theoretical uncompressed audio bitrate in bytes per second.
/// - For DSD (1-bit): `(sample_rate * channels) / 8`
/// - For PCM: `sample_rate * (bit_depth / 8) * channels`
pub fn calculate_audio_bitrate(
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    is_dsd: bool,
) -> f64 {
    let ch = channels.max(1) as f64;
    if is_dsd {
        (sample_rate as f64 * ch) / 8.0
    } else {
        let bd = if bit_depth == 0 { 16.0 } else { bit_depth as f64 };
        sample_rate as f64 * (bd / 8.0) * ch
    }
}

/// Metadata extracted directly from a Sony DSF container header.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DsfHeaderInfo {
    pub channels: u16,
    pub sample_rate: u32,
    pub sample_count: u64,
    pub duration_secs: f64,
    pub bits_per_sample: u8,
    pub metadata_offset: u64,
}

/// Directly parses the fixed 80-byte DSF header (DSD chunk + fmt chunk).
/// Returns channel count, sample rate, sample count, duration in seconds, and metadata offset.
pub fn parse_dsf_header(path: &Path) -> Option<DsfHeaderInfo> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 80];
    file.read_exact(&mut header).ok()?;

    if &header[0..4] != b"DSD " || &header[28..32] != b"fmt " {
        return None;
    }

    let metadata_offset = u64::from_le_bytes(header[20..28].try_into().ok()?);
    let channels = u32::from_le_bytes(header[52..56].try_into().ok()?) as u16;
    let sample_rate = u32::from_le_bytes(header[56..60].try_into().ok()?);
    let bits_per_sample = u32::from_le_bytes(header[60..64].try_into().ok()?) as u8;
    let sample_count = u64::from_le_bytes(header[64..72].try_into().ok()?);

    let duration_secs = if sample_rate > 0 {
        sample_count as f64 / sample_rate as f64
    } else {
        0.0
    };

    Some(DsfHeaderInfo {
        channels,
        sample_rate,
        sample_count,
        duration_secs,
        bits_per_sample: if bits_per_sample == 0 { 1 } else { bits_per_sample },
        metadata_offset,
    })
}

// ---------------------------------------------------------------------------
// RAM budget policy
// ---------------------------------------------------------------------------

/// "Auto" mode: allow whole-track buffering up to this share of *available* RAM.
const AUTO_FRACTION_OF_AVAILABLE: f64 = 0.25;

/// A user-chosen limit is still clamped to this share of available RAM so a
/// large setting can never push the rest of the system into the pagefile.
const USER_MAX_FRACTION_OF_AVAILABLE: f64 = 0.60;

/// Floor for the budget so windowed mode always has workable windows.
const MIN_BUDGET_BYTES: u64 = 64 * MB;

/// Upper bound for a single read-ahead window. Two windows exist at once
/// (playing + prefetching), so peak windowed usage is `2 × window`.
const MAX_WINDOW_BYTES: u64 = 256 * MB;
const MIN_WINDOW_BYTES: u64 = 16 * MB;

/// The very first window of a request is kept small so playback / seeks
/// start quickly; subsequent windows use the full window size.
const FIRST_WINDOW_BYTES: u64 = 16 * MB;

/// Assumed available RAM when the OS can't be queried (non-Windows).
const FALLBACK_AVAILABLE_BYTES: u64 = 4 * 1024 * MB;

#[derive(Debug, Clone, Copy)]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

pub fn memory_info() -> Option<MemoryInfo> {
    platform::memory_info()
}

/// Effective whole-track RAM budget in bytes.
/// `user_limit_mb == 0` means Auto.
pub fn effective_budget_bytes(user_limit_mb: u64) -> u64 {
    let available = memory_info()
        .map(|m| m.available_bytes)
        .unwrap_or(FALLBACK_AVAILABLE_BYTES);

    let budget = if user_limit_mb == 0 {
        (available as f64 * AUTO_FRACTION_OF_AVAILABLE) as u64
    } else {
        let user = user_limit_mb.saturating_mul(MB);
        user.min((available as f64 * USER_MAX_FRACTION_OF_AVAILABLE) as u64)
    };
    budget.max(MIN_BUDGET_BYTES)
}

/// Window size used when a file exceeds the budget. Two windows (current +
/// prefetch) together never exceed the budget.
pub fn window_bytes_for_budget(budget: u64) -> u64 {
    (budget / 2).clamp(MIN_WINDOW_BYTES, MAX_WINDOW_BYTES)
}

pub fn first_window_bytes(window: u64) -> u64 {
    FIRST_WINDOW_BYTES.min(window)
}

// ---------------------------------------------------------------------------
// Locked RAM buffer
// ---------------------------------------------------------------------------

/// A page-locked copy of (a range of) an audio file.
/// The bytes are identical to the file on disk.
pub struct LockedBuffer {
    data: Vec<u8>,
    locked: bool,
}

impl LockedBuffer {
    /// Load the entire file.
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let len = std::fs::metadata(path)?.len();
        Self::load_range(path, 0, len)
    }

    /// Load `len` bytes starting at `offset` (shorter if the file ends first).
    pub fn load_range(path: &Path, offset: u64, len: u64) -> std::io::Result<Self> {
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut data = Vec::with_capacity(len as usize);
        file.take(len).read_to_end(&mut data)?;
        data.shrink_to_fit();

        let locked = platform::lock_memory(&data);
        Ok(Self { data, locked })
    }

    #[inline]
    pub fn as_slice(&self) -> &[u8] {
        &self.data
    }

    pub fn is_locked(&self) -> bool {
        self.locked
    }
}

impl Drop for LockedBuffer {
    fn drop(&mut self) {
        if self.locked {
            platform::unlock_memory(&self.data);
        }
    }
}

// ---------------------------------------------------------------------------
// Thread / timer tuning
// ---------------------------------------------------------------------------

/// Deterministic RAII guard for the active streaming thread:
/// - Registers with Windows MMCSS ("Pro Audio") and calls AvRevertMmThreadCharacteristics on drop.
/// - Pins thread away from Core 0 and Core 1 (NDIS network driver DPCs).
/// - Locks system timer resolution to 1 ms (timeBeginPeriod) and releases on drop (timeEndPeriod).
/// - Explicitly marked `!Send` via PhantomData so AvRevertMmThreadCharacteristics is guaranteed
///   at compile-time to execute on the exact thread that called AvSetMmThreadCharacteristicsW.
pub struct StreamingThreadGuard {
    _platform: platform::PlatformThreadGuard,
    _marker: std::marker::PhantomData<*const ()>,
}

impl StreamingThreadGuard {
    pub fn acquire() -> Self {
        Self {
            _platform: platform::PlatformThreadGuard::acquire(),
            _marker: std::marker::PhantomData,
        }
    }
}

/// Sets lower priority for the background prefetch thread so monster-track
/// disk reads never preempt the 16 KB network packet pacing loop.
pub fn set_prefetch_thread_priority() {
    platform::set_prefetch_thread_priority();
}

// ---------------------------------------------------------------------------
// Platform implementations
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::MemoryInfo;
    use std::ffi::c_void;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Media::{timeBeginPeriod, timeEndPeriod};
    use windows_sys::Win32::System::Memory::{VirtualLock, VirtualUnlock};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, GetCurrentProcess,
        GetCurrentThread, GetProcessWorkingSetSize, SetProcessWorkingSetSize,
        SetThreadAffinityMask, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
    };


    const TIMERR_NOERROR: u32 = 0;
    const WS_HEADROOM: usize = 64 * 1024 * 1024;

    /// Tracks how many bytes we've locked so the process working set can be
    /// grown to match (VirtualLock is bounded by the minimum working set).
    /// To prevent shrink races during track transitions / ping-pong buffering,
    /// we only revert back to baseline once all buffers are completely dropped.
    struct WorkingSetState {
        baseline: Option<(usize, usize)>,
        locked_bytes: usize,
    }

    static WS_STATE: Mutex<WorkingSetState> = Mutex::new(WorkingSetState {
        baseline: None,
        locked_bytes: 0,
    });

    unsafe fn apply_working_set(baseline: (usize, usize), locked: usize) {
        let (base_min, base_max) = baseline;
        let new_min = base_min.saturating_add(locked).saturating_add(WS_HEADROOM);
        let new_max = base_max.max(new_min.saturating_add(WS_HEADROOM));
        SetProcessWorkingSetSize(GetCurrentProcess(), new_min, new_max);
    }

    pub fn memory_info() -> Option<MemoryInfo> {
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut status) != 0 {
                Some(MemoryInfo {
                    total_bytes: status.ullTotalPhys,
                    available_bytes: status.ullAvailPhys,
                })
            } else {
                None
            }
        }
    }

    pub fn lock_memory(data: &[u8]) -> bool {
        if data.is_empty() {
            return false;
        }
        let mut state = match WS_STATE.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        unsafe {
            let baseline = *state.baseline.get_or_insert_with(|| {
                let (mut min_ws, mut max_ws) = (0usize, 0usize);
                GetProcessWorkingSetSize(GetCurrentProcess(), &mut min_ws, &mut max_ws);
                (min_ws, max_ws)
            });

            let target = state.locked_bytes.saturating_add(data.len());
            apply_working_set(baseline, target);

            if VirtualLock(data.as_ptr() as *const c_void, data.len()) != 0 {
                state.locked_bytes = target;
                true
            } else {
                apply_working_set(baseline, state.locked_bytes);
                eprintln!(
                    "[Cadence UPnP Streamer] VirtualLock failed for {} bytes; buffer stays in RAM but is pageable.",
                    data.len()
                );
                false
            }
        }
    }

    pub fn unlock_memory(data: &[u8]) {
        let mut state = match WS_STATE.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        unsafe {
            // 1. Unpin physical pages first so the Windows kernel (MmAdjustWorkingSetSize)
            //    does not reject reducing the working set limit with ERROR_WORKING_SET_QUOTA.
            VirtualUnlock(data.as_ptr() as *const c_void, data.len());
            state.locked_bytes = state.locked_bytes.saturating_sub(data.len());

            // 2. Step-down the process working set:
            //    - If all buffers are released, restore original baseline.
            //    - If other buffers remain active (e.g. ping-pong buffer swap or track transition),
            //      step down to baseline + remaining locked_bytes + headroom.
            if state.locked_bytes == 0 {
                if let Some(baseline) = state.baseline {
                    SetProcessWorkingSetSize(GetCurrentProcess(), baseline.0, baseline.1);
                }
            } else if let Some(baseline) = state.baseline {
                apply_working_set(baseline, state.locked_bytes);
            }
        }
    }

    pub struct PlatformThreadGuard {
        mmcss_handle: Option<HANDLE>,
        timer_active: bool,
    }

    impl PlatformThreadGuard {
        pub fn acquire() -> Self {
            pin_off_core_zero();

            let task: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
            let mut task_index: u32 = 0;
            let mmcss_handle = unsafe {
                let h = AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut task_index);
                if h.is_null() {
                    eprintln!("[Cadence UPnP Streamer] MMCSS 'Pro Audio' registration failed.");
                    None
                } else {
                    eprintln!("[Cadence UPnP Streamer] Streaming thread registered with MMCSS 'Pro Audio'.");
                    Some(h)
                }
            };

            let timer_active = unsafe { timeBeginPeriod(1) == TIMERR_NOERROR };

            Self {
                mmcss_handle,
                timer_active,
            }
        }
    }

    impl Drop for PlatformThreadGuard {
        fn drop(&mut self) {
            if self.timer_active {
                unsafe {
                    timeEndPeriod(1);
                }
            }
            if let Some(handle) = self.mmcss_handle {
                unsafe {
                    AvRevertMmThreadCharacteristics(handle);
                }
                eprintln!("[Cadence UPnP Streamer] MMCSS 'Pro Audio' reverted cleanly.");
            }
        }
    }

    fn pin_off_core_zero() {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(usize::BITS as usize);
        // Need enough cores to spare 0 and 1 (Core 0 + its likely SMT sibling).
        if cores < 4 {
            return;
        }
        let all: usize = if cores == usize::BITS as usize { usize::MAX } else { (1usize << cores) - 1 };
        let mask = all & !0b11;
        let prev = unsafe { SetThreadAffinityMask(GetCurrentThread(), mask) };
        if prev == 0 {
            eprintln!("[Cadence UPnP Streamer] SetThreadAffinityMask failed.");
        } else {
            eprintln!(
                "[Cadence UPnP Streamer] Streaming thread pinned away from Core 0/1 (mask {:#x}).",
                mask
            );
        }
    }

    pub fn set_prefetch_thread_priority() {
        unsafe {
            let res = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
            if res == 0 {
                eprintln!("[Cadence UPnP Streamer] SetThreadPriority for disk prefetch failed.");
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::MemoryInfo;

    pub fn memory_info() -> Option<MemoryInfo> {
        None
    }
    pub fn lock_memory(_data: &[u8]) -> bool {
        false
    }
    pub fn unlock_memory(_data: &[u8]) {}
    pub fn set_prefetch_thread_priority() {}

    pub struct PlatformThreadGuard;

    impl PlatformThreadGuard {
        pub fn acquire() -> Self {
            Self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_sndbuf_low_bitrates_clamped_to_min() {
        // Zero or negative bitrate falls back to 16 KB minimum
        assert_eq!(calculate_sndbuf_bytes(0.0), 16 * 1024);
        assert_eq!(calculate_sndbuf_bytes(-100.0), 16 * 1024);

        // Low MP3 bitrate: 128 kbps (16 KB/s) -> 100ms = 1.6 KB, clamped to 16 KB
        assert_eq!(calculate_sndbuf_bytes(16_000.0), 16 * 1024);
    }

    #[test]
    fn test_calculate_sndbuf_redbook_cd() {
        // 44.1 kHz, 16-bit, 2 ch = 176,400 bytes/sec
        // 100 ms in flight = 17,640 bytes -> aligned to 32 KB (2 x 16 KB chunks)
        let cd_bitrate = 44_100.0 * 2.0 * 2.0;
        let sndbuf = calculate_sndbuf_bytes(cd_bitrate);
        assert_eq!(sndbuf, 32 * 1024);
        assert_eq!(sndbuf % CHUNK_BYTES, 0);
    }

    #[test]
    fn test_calculate_sndbuf_hires_pcm() {
        // High-rate streams are clamped to the 32 KB steady-state ceiling to prevent kernel micro-bursts
        let sndbuf_96 = calculate_sndbuf_bytes(96_000.0 * 3.0 * 2.0);
        assert_eq!(sndbuf_96, 32 * 1024);
        assert_eq!(sndbuf_96 % CHUNK_BYTES, 0);

        let sndbuf_192 = calculate_sndbuf_bytes(192_000.0 * 3.0 * 2.0);
        assert_eq!(sndbuf_192, 32 * 1024);
        assert_eq!(sndbuf_192 % CHUNK_BYTES, 0);
    }

    #[test]
    fn test_calculate_sndbuf_dsd_rates() {
        // All DSD rates (DSD64 to DSD1024) are capped at the 32 KB steady ceiling (2 x 16 KB chunks)
        // so the OS kernel never hoards data during TCP ZeroWindow stalls.
        let dsd64 = calculate_sndbuf_bytes(705_600.0);
        assert_eq!(dsd64, 32 * 1024);
        assert_eq!(dsd64 % CHUNK_BYTES, 0);

        let dsd128 = calculate_sndbuf_bytes(1_411_200.0);
        assert_eq!(dsd128, 32 * 1024);
        assert_eq!(dsd128 % CHUNK_BYTES, 0);

        let dsd256 = calculate_sndbuf_bytes(2_822_400.0);
        assert_eq!(dsd256, 32 * 1024);
        assert_eq!(dsd256 % CHUNK_BYTES, 0);

        let dsd512 = calculate_sndbuf_bytes(5_644_800.0);
        assert_eq!(dsd512, 32 * 1024);
        assert_eq!(dsd512 % CHUNK_BYTES, 0);

        let dsd1024 = calculate_sndbuf_bytes(11_289_600.0);
        assert_eq!(dsd1024, 32 * 1024);
        assert_eq!(dsd1024 % CHUNK_BYTES, 0);
    }

    #[test]
    fn test_calculate_sndbuf_clamped_to_max() {
        // Extreme 50 MB/s stream -> clamped to MAX_SOCKET_SNDBUF_BYTES (32 KB)
        let max_buf = calculate_sndbuf_bytes(50_000_000.0);
        assert_eq!(max_buf, MAX_SOCKET_SNDBUF_BYTES);
        assert_eq!(max_buf, 32 * 1024);
        assert_eq!(max_buf % CHUNK_BYTES, 0);
    }

    #[test]
    fn test_calculate_fast_start_scaling() {
        // Standard CD -> clamped to minimum SOCKET_FAST_START_SNDBUF (256 KB)
        let cd_fast = calculate_fast_start_sndbuf_bytes(176_400.0);
        assert_eq!(cd_fast, 256 * 1024);
        assert_eq!(cd_fast % CHUNK_BYTES, 0);

        // High rates clamp to SOCKET_FAST_START_SNDBUF
        let dsd256_fast = calculate_fast_start_sndbuf_bytes(2_822_400.0);
        assert_eq!(dsd256_fast, 256 * 1024);
        assert_eq!(dsd256_fast % CHUNK_BYTES, 0);
    }
}


