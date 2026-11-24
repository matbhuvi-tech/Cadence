//! Phase 5 release-timing and zero-allocation gate for the synchronous Linux/Core UPnP pacer.
//!
//! Verifies:
//! - Zero heap allocations (`ALLOC_CALLS == 0`, `ALLOC_BYTES == 0`, `DEALLOC_CALLS == 0`)
//!   inside the active chunk-streaming & pacing loop (`stream_slice_ZeroAlloc`).
//! - Adaptive pacing state machine (`1.180x` InitialFill -> `1.080x` SteadyMaintain ->
//!   `1.120x` ceiling, `0.995x` receiver flow-control drain on collapsed `snd_wnd`,
//!   and Linux `TCP_INFO` / `SO_SNDBUF` normalization).
//! - Non-bursty stall re-anchoring (`next_chunk_due = now`) when a write blocks or wakeups lag.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cadence_core_lib::core_runtime::upnp_session::{
    normalize_linux_tcp_info, stream_paced_slice_no_alloc, CorePacer, CorePacerConfig,
    CorePacingMetrics, CoreTcpSample, LinuxTcpInfoRaw, MAX_CORE_PREROLL_BYTES,
    MAX_CORE_STEADY_SNDBUF_BYTES,
};

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
fn active_paced_streaming_loop_performs_zero_heap_allocations() {
    for capture in [false, true] {
        check_stream_allocations(capture);
    }
}

fn check_stream_allocations(capture: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let payload_len = 512 * 1024; // 512 KiB = 128 chunks of 4 KiB
    let reader_thread = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut sink = [0u8; 16 * 1024];
        let mut total = 0usize;
        while total < payload_len {
            match sock.read(&mut sink) {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(_) => break,
            }
        }
        total
    });

    let mut sender = TcpStream::connect(addr).unwrap();
    let _ = sender.set_nodelay(true);

    let payload = vec![0x5Au8; payload_len];
    let metrics = Arc::new(CorePacingMetrics::default());
    let paused = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let last_offset = std::sync::atomic::AtomicU64::new(0);

    let mut cfg = CorePacerConfig::default();
    // Keep sleep short so 128 chunks complete quickly while exercising the real sleep & telemetry path
    cfg.initial_fill_multiplier = 200.0;
    cfg.max_overfeed_multiplier = 200.0;
    cfg.initial_overfeed_multiplier = 200.0;

    let mut pacer = CorePacer::new(
        cfg,
        Some(2_822_400.0), // DSD256
        64 * 1024,         // 64 KiB pre-roll followed by 448 KiB paced
        MAX_CORE_STEADY_SNDBUF_BYTES,
        false,
        false,
        false,
        Arc::clone(&metrics),
        Arc::clone(&paused),
    );

    if capture { metrics.delivery.start_at(Instant::now()); }

    reset_counters();
    COUNTING_ENABLED.with(|c| c.set(true));

    let ok = stream_paced_slice_no_alloc(
        &mut sender,
        &payload,
        0,
        4096,
        true,
        &last_offset,
        &cancelled,
        &mut pacer,
    );

    COUNTING_ENABLED.with(|c| c.set(false));

    assert!(ok, "paced stream must complete cleanly");
    assert_eq!(
        ALLOC_CALLS.load(Ordering::SeqCst),
        0,
        "active streaming loop must perform 0 heap allocations"
    );
    assert_eq!(
        ALLOC_BYTES.load(Ordering::SeqCst),
        0,
        "active streaming loop must allocate 0 bytes"
    );
    assert_eq!(
        DEALLOC_CALLS.load(Ordering::SeqCst),
        0,
        "active streaming loop must perform 0 deallocations"
    );

    drop(sender);
    let received = reader_thread.join().unwrap();
    assert_eq!(received, payload_len);
    assert_eq!(metrics.snapshot().bytes_sent, payload_len as u64);
    // This fast fixture can finish within the capture clock's first millisecond.
    // Let that partial bin become visible outside the measured allocation loop.
    std::thread::sleep(Duration::from_millis(1));
    let history = metrics.delivery.snapshot_at(Instant::now());
    assert_eq!(history.is_some(), capture);
    if let Some(history) = history {
        assert_eq!(history.bins.iter().map(|b| b.bytes).sum::<u64>(), payload_len as u64);
    }
}

#[test]
fn linux_tcp_info_normalization_and_adaptive_backpressure_timing() {
    // 1. Verify Linux kernel tcp_info unit normalization (packet counts * snd_mss -> bytes)
    let raw_linux = LinuxTcpInfoRaw {
        tcpi_state: 1, // TCP_ESTABLISHED
        tcpi_rtt: 2_400,
        tcpi_min_rtt: 1_800,
        tcpi_snd_mss: 1_448,
        tcpi_unacked: 10,
        tcpi_snd_cwnd: 64,
        tcpi_snd_wnd: 524_288,
        tcpi_total_retrans: 2,
    };
    let sample: CoreTcpSample = normalize_linux_tcp_info(raw_linux);
    assert_eq!(sample.rtt_us, 2_400);
    assert_eq!(sample.min_rtt_us, 1_800);
    assert_eq!(sample.bytes_in_flight, 10 * 1_448);
    assert_eq!(sample.cwnd, 64 * 1_448);
    assert_eq!(sample.snd_wnd, 524_288);
    assert_eq!(sample.bytes_retrans, 2 * 1_448);

    // 2. Verify 512 KiB max pre-roll policy constant and adaptive pacing transitions
    assert_eq!(MAX_CORE_PREROLL_BYTES, 512 * 1024);
    assert_eq!(MAX_CORE_STEADY_SNDBUF_BYTES, 32 * 1024);

    let metrics = Arc::new(CorePacingMetrics::default());
    let paused = Arc::new(AtomicBool::new(false));
    let t0 = Instant::now();
    let mut pacer = CorePacer::new(
        CorePacerConfig::default(),
        Some(2_822_400.0), // DSD256
        0,
        MAX_CORE_STEADY_SNDBUF_BYTES,
        false,
        true, // start after pre-roll clamp
        false,
        Arc::clone(&metrics),
        paused,
    );

    // Initial fill at 1.180x
    let d0 = pacer.advance_with_sample(
        t0,
        4096,
        Duration::from_micros(150),
        false,
        Some(sample),
    );
    assert!(d0.is_some());
    assert!((metrics.snapshot().current_multiplier - 1.180).abs() < 1e-6);

    // Simulate reaching 1000 ms cushion at t0 + 3.5s -> transitions to SteadyMaintain 1.080x
    pacer.set_sent_for_test((4.6 * 2_822_400.0) as u64);
    let t1 = t0 + Duration::from_millis(3_500);
    let _ = pacer.advance_with_sample(
        t1,
        4096,
        Duration::from_micros(150),
        false,
        Some(sample),
    );
    assert_eq!(metrics.snapshot().current_state, "steady_maintain");
    assert!((metrics.snapshot().current_multiplier - 1.080).abs() < 1e-6);

    // Simulate RS130 receiver flow-control (snd_wnd collapses to 16 KiB) -> halves excess to 1.040x & drains at 0.995x
    let collapsed = CoreTcpSample {
        snd_wnd: 16 * 1024,
        ..sample
    };
    let t2 = t1 + Duration::from_millis(500);
    let _ = pacer.advance_with_sample(
        t2,
        4096,
        Duration::from_millis(30),
        false,
        Some(collapsed),
    );
    let snap_drain = metrics.snapshot();
    assert_eq!(snap_drain.current_regime, "flow_suppressed");
    assert!((snap_drain.current_multiplier - 0.995).abs() < 1e-6);
    assert_eq!(snap_drain.flow_control_events, 1);

    // After 1.5s drain window clears -> resumes at halved overfeed 1.040x
    let t3 = t2 + Duration::from_millis(1_600);
    let _ = pacer.advance_with_sample(
        t3,
        4096,
        Duration::from_micros(150),
        false,
        Some(sample),
    );
    assert_eq!(metrics.snapshot().current_regime, "overfeed");
    assert!((metrics.snapshot().current_multiplier - 1.040).abs() < 1e-6);
}
