use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use cadence_core_lib::diagnostics::{self, CaptureMode, DiagCategory};

struct CountingAllocator;

thread_local! {
    static COUNTING_ENABLED: Cell<bool> = const { Cell::new(false) };
}

static ALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);
static ALLOC_BYTES: AtomicUsize = AtomicUsize::new(0);
static DEALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNTING_ENABLED.with(|c| c.get()) {
            ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if COUNTING_ENABLED.with(|c| c.get()) {
            DEALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(ptr, layout) }
    }
}

fn reset_counters() {
    ALLOC_CALLS.store(0, Ordering::SeqCst);
    ALLOC_BYTES.store(0, Ordering::SeqCst);
    DEALLOC_CALLS.store(0, Ordering::SeqCst);
}

#[test]
fn debug_off_path_performs_zero_heap_allocations_zero_disk_writes_and_zero_blocking() {
    // Ensure global mode starts Off and configure a temporary AppData log directory.
    let dir = std::env::temp_dir().join(format!("cadence_zero_alloc_off_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let _rt = diagnostics::configure_persistence(
        dir.clone(),
        std::sync::Arc::new(|| diagnostics::HygieneState::Idle),
    );
    diagnostics::set_mode(CaptureMode::Off);
    assert_eq!(diagnostics::capture_mode(), CaptureMode::Off);

    reset_counters();
    COUNTING_ENABLED.with(|c| c.set(true));

    let t0 = Instant::now();
    for i in 0..10_000u64 {
        cadence_core_lib::diag_log!(
            DiagCategory::AudioEngineCommands,
            i,
            12,
            345,
            "rapid_command",
            "requested={} actual={} decision=wasapi_shared fallback_rejected=true",
            "Speakers (Game-Audeze Maxwell)",
            "Speakers (Game-Audeze Maxwell)"
        );
    }
    let elapsed = t0.elapsed();

    COUNTING_ENABLED.with(|c| c.set(false));

    assert_eq!(ALLOC_CALLS.load(Ordering::SeqCst), 0, "DEBUG OFF must perform 0 heap allocations");
    assert_eq!(ALLOC_BYTES.load(Ordering::SeqCst), 0, "DEBUG OFF must allocate 0 bytes");
    assert_eq!(DEALLOC_CALLS.load(Ordering::SeqCst), 0, "DEBUG OFF must perform 0 deallocations");
    assert!(elapsed.as_millis() < 20, "10k DEBUG OFF calls should finish nearly instantly: {:?}", elapsed);
    assert!(
        !dir.join("logs").join("cadence-debug.log").exists(),
        "DEBUG OFF must never create or write debug log files"
    );

    // Preallocate ring buffer once when switching Debug ON, then verify hot-path submission
    // across overflow still performs 0 heap allocations.
    diagnostics::set_mode(CaptureMode::Debug);
    // Warm thread name TLS/ring initialization outside measured section
    cadence_core_lib::diag_log!(
        DiagCategory::PlaybackLifecycle,
        1,
        0,
        0,
        "warmup",
        "init=true"
    );

    reset_counters();
    COUNTING_ENABLED.with(|c| c.set(true));

    for i in 0..5_000u64 {
        cadence_core_lib::diag_log!(
            DiagCategory::WasapiLifecycle,
            i,
            50,
            1200,
            "wasapi_stream_init",
            "rate={} ch={} format=F32 endpoint={}",
            44100,
            2,
            "Speakers (Game-Audeze Maxwell)"
        );
    }

    COUNTING_ENABLED.with(|c| c.set(false));

    assert_eq!(
        ALLOC_CALLS.load(Ordering::SeqCst),
        0,
        "Even with DEBUG ON and ring buffer overflow, producer submission must perform 0 heap allocations"
    );
    assert_eq!(ALLOC_BYTES.load(Ordering::SeqCst), 0);
    assert_eq!(DEALLOC_CALLS.load(Ordering::SeqCst), 0);
    assert!(diagnostics::get_state().dropped_count > 0);

    diagnostics::set_mode(CaptureMode::Off);
    let _ = std::fs::remove_dir_all(&dir);
}

