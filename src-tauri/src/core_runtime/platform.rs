//! TrueNAS / Linux & cross-platform memory locking, cgroup v2 admission,
//! cpuset core partitioning, and socket normalization primitives.

use std::collections::HashMap;
use std::io::Read;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Mandatory safety headroom (64 MiB default) reserved inside a container or host
/// for the executable, SQLite cache, and kernel TCP send buffers.
pub const DEFAULT_CONTAINER_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CgroupMemoryLimits {
    pub max_bytes: Option<u64>,
    pub high_bytes: Option<u64>,
    pub current_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostMemoryLimits {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub zfs_arc_reclaimable_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlatformLimits {
    pub cgroup: CgroupMemoryLimits,
    pub host: HostMemoryLimits,
    pub rlimit_memlock_bytes: Option<u64>,
    pub cap_ipc_lock: bool,
}

pub trait PlatformProbe: Send + Sync {
    fn query_limits(&self) -> PlatformLimits;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemPlatformProbe;

impl PlatformProbe for SystemPlatformProbe {
    fn query_limits(&self) -> PlatformLimits {
        query_system_platform_limits()
    }
}

pub trait MemoryLocker: Send + Sync + 'static {
    /// Pre-faults all pages in `data` and pins them in physical RAM (`mlock` / `VirtualLock`).
    fn lock_and_prefault(&self, data: &mut [u8]) -> bool;
    /// Unpins previously locked pages (`munlock` / `VirtualUnlock`).
    fn unlock(&self, data: &[u8]);
}

impl<T: MemoryLocker + ?Sized> MemoryLocker for std::sync::Arc<T> {
    fn lock_and_prefault(&self, data: &mut [u8]) -> bool {
        (**self).lock_and_prefault(data)
    }
    fn unlock(&self, data: &[u8]) {
        (**self).unlock(data);
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemMemoryLocker;

impl MemoryLocker for SystemMemoryLocker {
    fn lock_and_prefault(&self, data: &mut [u8]) -> bool {
        if data.is_empty() {
            return true;
        }
        for page in data.chunks_mut(4096) {
            std::hint::black_box(&mut page[0]);
        }
        os_lock_memory(data)
    }

    fn unlock(&self, data: &[u8]) {
        if !data.is_empty() {
            os_unlock_memory(data);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmissionError {
    LockLimitTooLow {
        requested_bytes: u64,
        available_lock_bytes: u64,
        cap_ipc_lock: bool,
    },
    OverBudget {
        requested_bytes: u64,
        available_budget_bytes: u64,
    },
    LockUnavailable,
    TrackNotFound(String),
    TrackNotAdmitted(String),
    IoError(String),
}

impl AdmissionError {
    pub fn user_message(&self) -> String {
        match self {
            Self::LockLimitTooLow {
                requested_bytes,
                available_lock_bytes,
                ..
            } => format!(
                "Requested {} bytes exceeds locked-memory limit ({} bytes). Grant CAP_IPC_LOCK or raise RLIMIT_MEMLOCK (ulimit -l) on the TrueNAS container.",
                requested_bytes, available_lock_bytes
            ),
            Self::OverBudget {
                requested_bytes,
                available_budget_bytes,
            } => format!(
                "Selection requires {} bytes but only {} bytes of locked RAM budget remain; choose a smaller selection.",
                requested_bytes, available_budget_bytes
            ),
            Self::LockUnavailable => {
                "Physical RAM page locking (mlock/VirtualLock) failed; strict admission refuses pageable fallback."
                    .into()
            }
            Self::TrackNotFound(id) => format!("Track '{}' is not in the active catalog.", id),
            Self::TrackNotAdmitted(id) => {
                format!("Track '{}' has not been admitted into locked RAM.", id)
            }
            Self::IoError(msg) => format!("Media read failed during idle admission: {}", msg),
        }
    }
}

/// Owns a page lock for as long as any renderer or HTTP response uses the bytes.
pub struct LockedTrack {
    storage: Vec<u8>,
    bytes: Range<usize>,
    path: PathBuf,
    locker: Arc<dyn MemoryLocker>,
}

impl LockedTrack {
    pub fn as_slice(&self) -> &[u8] {
        &self.storage[self.bytes.clone()]
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(feature = "engine-audio")]
pub(crate) struct LockedTrackReader(pub(crate) Arc<LockedTrack>);

#[cfg(feature = "engine-audio")]
impl AsRef<[u8]> for LockedTrackReader {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Drop for LockedTrack {
    fn drop(&mut self) {
        self.locker.unlock(self.as_slice());
    }
}

/// Strict RAM arena holding pre-faulted, page-locked media bytes.
pub struct LockedBytesArena<P: PlatformProbe = SystemPlatformProbe, L: MemoryLocker = SystemMemoryLocker> {
    probe: P,
    locker: Arc<L>,
    headroom_bytes: u64,
    buffers: HashMap<String, Arc<LockedTrack>>,
    retained_bytes: u64,
}

impl<P: PlatformProbe, L: MemoryLocker> LockedBytesArena<P, L> {
    pub fn new(probe: P, locker: L, headroom_bytes: u64) -> Self {
        Self {
            probe,
            locker: Arc::new(locker),
            headroom_bytes,
            buffers: HashMap::new(),
            retained_bytes: 0,
        }
    }

    pub fn retained_locked_bytes(&self) -> u64 {
        self.retained_bytes
    }

    pub fn is_admitted(&self, track_id: &str) -> bool {
        self.buffers.contains_key(track_id)
    }

    pub fn get_slice(&self, track_id: &str) -> Option<&[u8]> {
        self.buffers.get(track_id).map(|v| v.as_slice())
    }

    /// Returns a zero-copy reference-counted handle to the page-locked track buffer.
    pub fn get_shared_buffer(&self, track_id: &str) -> Option<Arc<LockedTrack>> {
        self.buffers.get(track_id).cloned()
    }

    /// Computes remaining lockable RAM budget after accounting for container cgroup v2
    /// (`memory.max` / `memory.high` / `memory.current`), host `MemAvailable` + ZFS ARC
    /// reclaimable bytes, mandatory headroom, and already-retained locked buffers.
    pub fn available_budget_bytes(&self) -> u64 {
        let limits = self.probe.query_limits();
        let cgroup_ceiling = match (limits.cgroup.max_bytes, limits.cgroup.high_bytes) {
            (Some(max), Some(high)) => Some(max.min(high)),
            (Some(max), None) => Some(max),
            (None, Some(high)) => Some(high),
            (None, None) => None,
        };
        let cgroup_avail = cgroup_ceiling.map(|ceiling| {
            let current = limits.cgroup.current_bytes.unwrap_or(0);
            ceiling
                .saturating_sub(current)
                .saturating_sub(self.headroom_bytes)
                .saturating_sub(self.retained_bytes)
        });

        let host_pool = limits
            .host
            .available_bytes
            .saturating_add(limits.host.zfs_arc_reclaimable_bytes);
        let host_avail = host_pool
            .saturating_sub(self.headroom_bytes)
            .saturating_sub(self.retained_bytes);

        match cgroup_avail {
            Some(cg) => cg.min(host_avail),
            None => host_avail,
        }
    }

    /// Admits a bounded set of tracks into locked RAM atomically.
    /// Rejects before reading if the uncached selection exceeds `RLIMIT_MEMLOCK` (when
    /// `CAP_IPC_LOCK` is absent) or exceeds `available_budget_bytes()`.
    /// If any page lock fails, rolls back the batch and leaves no pageable buffer behind.
    pub fn admit_files(
        &mut self,
        track_files: &HashMap<String, PathBuf>,
        track_ids: &[String],
    ) -> Result<(), AdmissionError> {
        let mut to_load: Vec<(String, PathBuf, u64)> = Vec::new();
        let mut requested_bytes: u64 = 0;

        for id in track_ids {
            if self.buffers.contains_key(id) || to_load.iter().any(|(existing, _, _)| existing == id) {
                continue;
            }
            let path = track_files
                .get(id)
                .ok_or_else(|| AdmissionError::TrackNotFound(id.clone()))?;
            let meta = std::fs::metadata(path).map_err(|e| AdmissionError::IoError(e.to_string()))?;
            let len = meta.len();
            if !meta.is_file() || len == 0 {
                return Err(AdmissionError::IoError("Track is not a nonempty regular file".into()));
            }
            requested_bytes = requested_bytes.saturating_add(len);
            to_load.push((id.clone(), path.clone(), len));
        }

        if to_load.is_empty() {
            return Ok(());
        }

        let limits = self.probe.query_limits();
        if !limits.cap_ipc_lock {
            if let Some(rlimit) = limits.rlimit_memlock_bytes {
                let available_lock_bytes = rlimit.saturating_sub(self.retained_bytes);
                if requested_bytes > available_lock_bytes {
                    return Err(AdmissionError::LockLimitTooLow {
                        requested_bytes,
                        available_lock_bytes,
                        cap_ipc_lock: false,
                    });
                }
            }
        }

        let available_budget_bytes = self.available_budget_bytes();
        if requested_bytes > available_budget_bytes {
            return Err(AdmissionError::OverBudget {
                requested_bytes,
                available_budget_bytes,
            });
        }

        let mut newly_locked = Vec::with_capacity(to_load.len());
        for (id, path, expected_len) in to_load {
            let (mut storage, bytes) = read_media_file_hygienic(&path, expected_len as usize)
                .map_err(|e| AdmissionError::IoError(e.to_string()))?;
            if !self.locker.lock_and_prefault(&mut storage[bytes.clone()]) {
                return Err(AdmissionError::LockUnavailable);
            }
            newly_locked.push((id, Arc::new(LockedTrack {
                storage,
                bytes,
                path,
                locker: self.locker.clone(),
            })));
        }

        for (id, data) in newly_locked {
            self.retained_bytes = self.retained_bytes.saturating_add(data.len() as u64);
            self.buffers.insert(id, data);
        }

        Ok(())
    }

    pub(crate) fn retain_keys(&mut self, keep_ids: &std::collections::HashSet<String>) {
        let remove_ids: Vec<String> = self
            .buffers
            .keys()
            .filter(|id| !keep_ids.contains(*id))
            .cloned()
            .collect();
        for id in remove_ids {
            if let Some(buf) = self.buffers.remove(&id) {
                self.retained_bytes = self.retained_bytes.saturating_sub(buf.len() as u64);
            }
        }
    }

    pub fn clear(&mut self) {
        self.buffers.clear();
        self.retained_bytes = 0;
    }
}

impl<P: PlatformProbe, L: MemoryLocker> Drop for LockedBytesArena<P, L> {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Parses a cgroup v2 byte limit file (`"max\n"` -> `Ok(None)`, `"268435456\n"` -> `Ok(Some(268435456))`).
pub fn parse_cgroup_limit_bytes(raw: &str) -> Result<Option<u64>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("max") {
        return Ok(None);
    }
    trimmed
        .parse::<u64>()
        .map(Some)
        .map_err(|e| format!("invalid cgroup byte limit '{}': {}", trimmed, e))
}

/// Parses `/proc/self/status` for `CapEff` bit 14 (`CAP_IPC_LOCK`).
pub fn parse_proc_status_cap_ipc_lock(status_text: &str) -> bool {
    const CAP_IPC_LOCK_BIT: u64 = 1u64 << 14;
    for line in status_text.lines() {
        if let Some(rest) = line.strip_prefix("CapEff:") {
            if let Ok(mask) = u64::from_str_radix(rest.trim(), 16) {
                return (mask & CAP_IPC_LOCK_BIT) != 0;
            }
        }
    }
    false
}

/// Parses `/proc/meminfo` (`MemTotal`, `MemAvailable`) in bytes.
pub fn parse_meminfo_bytes(meminfo_text: &str) -> (u64, u64) {
    let mut total_kb = 0u64;
    let mut avail_kb = 0u64;
    for line in meminfo_text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = parse_kb_field(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            avail_kb = parse_kb_field(rest);
        }
    }
    (total_kb.saturating_mul(1024), avail_kb.saturating_mul(1024))
}

fn parse_kb_field(rest: &str) -> u64 {
    rest.split_whitespace()
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Parses `/proc/spl/kstat/zfs/arcstats` to estimate reclaimable ZFS ARC bytes (`size - c_min`).
pub fn parse_zfs_arc_reclaimable_bytes(arcstats_text: &str) -> u64 {
    let mut size = 0u64;
    let mut c_min = 0u64;
    for line in arcstats_text.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let _type = parts.next();
        let Some(val_str) = parts.next() else { continue };
        if name == "size" {
            size = val_str.parse::<u64>().unwrap_or(0);
        } else if name == "c_min" {
            c_min = val_str.parse::<u64>().unwrap_or(0);
        }
    }
    size.saturating_sub(c_min)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CpuPartition {
    pub pacer_core: Option<usize>,
    pub control_cores: Vec<usize>,
    pub control_worker_threads: usize,
}

/// Parses Linux `cpuset.cpus.effective` syntax (e.g., `"0-1,4-7\n"`).
pub fn parse_cpuset_list(raw: &str) -> Result<Vec<usize>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty cpuset".into());
    }
    let mut cpus = Vec::new();
    for segment in trimmed.split(',') {
        let seg = segment.trim();
        if let Some((start_s, end_s)) = seg.split_once('-') {
            let start = start_s
                .trim()
                .parse::<usize>()
                .map_err(|e| e.to_string())?;
            let end = end_s.trim().parse::<usize>().map_err(|e| e.to_string())?;
            if start > end {
                return Err(format!("invalid cpuset range {}-{}", start, end));
            }
            for cpu in start..=end {
                if !cpus.contains(&cpu) {
                    cpus.push(cpu);
                }
            }
        } else {
            let cpu = seg.parse::<usize>().map_err(|e| e.to_string())?;
            if !cpus.contains(&cpu) {
                cpus.push(cpu);
            }
        }
    }
    cpus.sort_unstable();
    Ok(cpus)
}

/// Partitions the container/process allowed CPU set on TrueNAS/Linux:
/// - Strips Core 0 and Core 1 (IRQ/NDIS cores) whenever at least one core `>= 2` is allowed.
/// - Assigns the highest allowed core ID to the dedicated synchronous pacer.
/// - Assigns the remaining allowed cores to the control plane with a bounded 1..=2 worker count.
pub fn partition_truenas_cpus(allowed_cpus: &[usize]) -> CpuPartition {
    let mut sorted: Vec<usize> = allowed_cpus.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() {
        return CpuPartition {
            pacer_core: None,
            control_cores: Vec::new(),
            control_worker_threads: 1,
        };
    }

    let non_irq: Vec<usize> = sorted.iter().copied().filter(|&c| c >= 2).collect();
    let pool = if non_irq.is_empty() { sorted } else { non_irq };

    let pacer_core = pool.last().copied();
    let control_cores = if pool.len() > 1 {
        pool[..pool.len() - 1].to_vec()
    } else {
        pool
    };
    let control_worker_threads = control_cores.len().clamp(1, 2);

    CpuPartition {
        pacer_core,
        control_cores,
        control_worker_threads,
    }
}

/// Normalizes a requested steady-state `SO_SNDBUF` ceiling for Linux `setsockopt(SO_SNDBUF)`.
/// Linux (`man 7 socket`) doubles the user value (`sk_sndbuf = 2 * val`). Dividing by 2 before
/// `setsockopt` prevents a 32 KiB steady-state ceiling from becoming a 64 KiB kernel buffer.
#[inline]
pub const fn normalize_linux_setsockopt_sndbuf(desired_ceiling_bytes: usize) -> usize {
    let half = desired_ceiling_bytes / 2;
    if half < 2048 {
        2048
    } else {
        half
    }
}

/// Normalizes the doubled `SO_SNDBUF` value returned by Linux `getsockopt(SO_SNDBUF)` back to
/// the effective application ceiling.
#[inline]
pub const fn normalize_linux_getsockopt_sndbuf(raw_kernel_sndbuf_bytes: usize) -> usize {
    raw_kernel_sndbuf_bytes / 2
}

// Give each Windows track exclusive ownership of every page it locks. VirtualLock
// does not count multiple locks on a shared heap page.
fn read_media_file_hygienic(path: &Path, len: usize) -> std::io::Result<(Vec<u8>, Range<usize>)> {
    let (allocation_len, page_size) = if cfg!(windows) {
        const PAGE_SIZE: usize = 4096; // Supported Windows x86_64 target.
        let allocation_len = len.checked_add(2 * (PAGE_SIZE - 1)).ok_or_else(|| {
            std::io::Error::other("Track allocation exceeds the addressable size")
        })?;
        (allocation_len, PAGE_SIZE)
    } else {
        (len, 1)
    };
    let mut storage = Vec::new();
    storage.try_reserve_exact(allocation_len).map_err(std::io::Error::other)?;
    storage.resize(allocation_len, 0);
    let start = storage.as_ptr().align_offset(page_size);
    let bytes = start..start + len;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::io::AsRawFd;

        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOATIME)
            .open(path)
            .or_else(|_| std::fs::File::open(path))?;

        let fd = file.as_raw_fd();
        unsafe {
            let _ = libc::posix_fadvise(fd, 0, len as libc::off_t, libc::POSIX_FADV_SEQUENTIAL);
        }
        read_exact_track(&mut file, &mut storage[bytes.clone()])?;
        unsafe {
            let _ = libc::posix_fadvise(fd, 0, len as libc::off_t, libc::POSIX_FADV_DONTNEED);
        }
        Ok((storage, bytes))
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut file = std::fs::File::open(path)?;
        read_exact_track(&mut file, &mut storage[bytes.clone()])?;
        Ok((storage, bytes))
    }
}

fn read_exact_track(file: &mut std::fs::File, bytes: &mut [u8]) -> std::io::Result<()> {
    file.read_exact(bytes)?;
    if file.read(&mut [0])? != 0 {
        return Err(std::io::Error::other("Track length changed during admission"));
    }
    Ok(())
}

#[cfg(unix)]
fn query_system_platform_limits() -> PlatformLimits {
    let cgroup_max = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .ok()
        .and_then(|s| parse_cgroup_limit_bytes(&s).ok().flatten());
    let cgroup_high = std::fs::read_to_string("/sys/fs/cgroup/memory.high")
        .ok()
        .and_then(|s| parse_cgroup_limit_bytes(&s).ok().flatten());
    let cgroup_current = std::fs::read_to_string("/sys/fs/cgroup/memory.current")
        .ok()
        .and_then(|s| parse_cgroup_limit_bytes(&s).ok().flatten());

    let (total_bytes, available_bytes) = std::fs::read_to_string("/proc/meminfo")
        .map(|s| parse_meminfo_bytes(&s))
        .unwrap_or((4 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024));
    let zfs_arc_reclaimable_bytes = std::fs::read_to_string("/proc/spl/kstat/zfs/arcstats")
        .map(|s| parse_zfs_arc_reclaimable_bytes(&s))
        .unwrap_or(0);
    let cap_ipc_lock = std::fs::read_to_string("/proc/self/status")
        .map(|s| parse_proc_status_cap_ipc_lock(&s))
        .unwrap_or(false);

    let rlimit_memlock_bytes = unsafe {
        let mut rlim = std::mem::zeroed::<libc::rlimit>();
        if libc::getrlimit(libc::RLIMIT_MEMLOCK, &mut rlim) == 0 {
            if rlim.rlim_cur == libc::RLIM_INFINITY {
                None
            } else {
                Some(rlim.rlim_cur as u64)
            }
        } else {
            None
        }
    };

    PlatformLimits {
        cgroup: CgroupMemoryLimits {
            max_bytes: cgroup_max,
            high_bytes: cgroup_high,
            current_bytes: cgroup_current,
        },
        host: HostMemoryLimits {
            total_bytes,
            available_bytes,
            zfs_arc_reclaimable_bytes,
        },
        rlimit_memlock_bytes,
        cap_ipc_lock,
    }
}

#[cfg(windows)]
fn query_system_platform_limits() -> PlatformLimits {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let (total_bytes, available_bytes) = unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) != 0 {
            (status.ullTotalPhys, status.ullAvailPhys)
        } else {
            (8 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024)
        }
    };
    PlatformLimits {
        cgroup: CgroupMemoryLimits::default(),
        host: HostMemoryLimits {
            total_bytes,
            available_bytes,
            zfs_arc_reclaimable_bytes: 0,
        },
        rlimit_memlock_bytes: None,
        cap_ipc_lock: true,
    }
}

#[cfg(unix)]
fn os_lock_memory(data: &[u8]) -> bool {
    unsafe { libc::mlock(data.as_ptr() as *const libc::c_void, data.len()) == 0 }
}

#[cfg(unix)]
fn os_unlock_memory(data: &[u8]) {
    unsafe {
        let _ = libc::munlock(data.as_ptr() as *const libc::c_void, data.len());
    }
}

#[cfg(all(windows, feature = "engine-audio"))]
fn os_lock_memory(data: &[u8]) -> bool {
    crate::audio::stream_tuning::lock_raw_slice(data)
}

#[cfg(all(windows, not(feature = "engine-audio")))]
fn os_lock_memory(data: &[u8]) -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::System::Memory::VirtualLock;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessWorkingSetSize, SetProcessWorkingSetSize,
    };
    const HEADROOM: usize = 64 * 1024 * 1024;
    unsafe {
        let (mut min_ws, mut max_ws) = (0usize, 0usize);
        GetProcessWorkingSetSize(GetCurrentProcess(), &mut min_ws, &mut max_ws);
        let new_min = min_ws.saturating_add(data.len()).saturating_add(HEADROOM);
        let new_max = max_ws.max(new_min.saturating_add(HEADROOM));
        SetProcessWorkingSetSize(GetCurrentProcess(), new_min, new_max);
        VirtualLock(data.as_ptr() as *const c_void, data.len()) != 0
    }
}

#[cfg(all(windows, feature = "engine-audio"))]
fn os_unlock_memory(data: &[u8]) {
    crate::audio::stream_tuning::unlock_raw_slice(data);
}

#[cfg(all(windows, not(feature = "engine-audio")))]
fn os_unlock_memory(data: &[u8]) {
    use std::ffi::c_void;
    use windows_sys::Win32::System::Memory::VirtualUnlock;
    unsafe {
        VirtualUnlock(data.as_ptr() as *const c_void, data.len());
    }
}
