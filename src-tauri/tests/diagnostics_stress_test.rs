use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use cadence_core_lib::diagnostics::{
    self, CaptureMode, DiagCategory, DiagRuntime, HygieneState, LockFreeDiagRing,
};
use parking_lot::Mutex;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cadence_diag_stress_{}_{}",
        tag,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn debug_off_and_on_long_running_playback_and_track_transitions() {
    let dir = temp_dir("long_run");
    let ring = Arc::new(LockFreeDiagRing::with_capacity(1024));
    let state = Arc::new(Mutex::new(HygieneState::Playing));
    let state_ref = Arc::clone(&state);

    let rt = DiagRuntime::new(
        Arc::clone(&ring),
        false,
        dir.clone(),
        Arc::new(move || *state_ref.lock()),
    );

    // 1. DEBUG OFF during long playback sequence emits nothing and creates no files
    rt.set_mode(CaptureMode::Off, false);
    for track_idx in 0..200u64 {
        assert!(!rt.submit_test_event(
            DiagCategory::PlaybackLifecycle,
            track_idx,
            "track_transition",
            "auto_advance=true"
        ));
    }
    assert_eq!(ring.buffered_approx(), 0);
    assert!(!rt.main_log_path().exists());

    // 2. DEBUG ON across Playing -> Paused -> Cooldown -> Idle preserves hygiene until Idle
    rt.set_mode(CaptureMode::Debug, false);
    for cycle in 1..=60u64 {
        assert!(rt.submit_test_event(
            DiagCategory::AudioRouting,
            cycle,
            "route_decision",
            "requested=wasapi:Speakers actual=wasapi:Speakers decision=wasapi_shared fallback_rejected=true"
        ));
        assert!(rt.submit_test_event(
            DiagCategory::PlaybackLifecycle,
            cycle,
            "track_transition",
            "owner=ws_monitor rev=42 auto_advance=true"
        ));
        assert!(rt.submit_test_event(
            DiagCategory::AudioHygiene,
            cycle,
            "hygiene_maintenance_suppressed",
            "state=paused_playback"
        ));
    }

    // Playing & Paused & Cooldown must NOT touch disk in normal Debug mode
    *state.lock() = HygieneState::Playing;
    assert!(rt.flush_now_if_allowed().is_err());
    *state.lock() = HygieneState::Paused;
    assert!(rt.flush_now_if_allowed().is_err());
    *state.lock() = HygieneState::Cooldown { remaining_secs: 29 };
    assert!(rt.flush_now_if_allowed().is_err());
    assert!(!rt.main_log_path().exists());

    // Once Idle, all 180 buffered events persist completely in order
    *state.lock() = HygieneState::Idle;
    let persisted = rt.flush_now_if_allowed().unwrap();
    assert_eq!(persisted, 180);
    let content = fs::read_to_string(rt.main_log_path()).unwrap();
    assert!(content.contains("track_transition"));
    assert!(content.contains("route_decision"));
    assert!(content.contains("hygiene_maintenance_suppressed"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn rapid_commands_endpoint_switching_and_overflow_never_stall_under_slow_writer() {
    let dir = temp_dir("rapid_stall");
    let ring = Arc::new(LockFreeDiagRing::with_capacity(256));
    let flush_delay_active = Arc::new(AtomicBool::new(true));
    let slow_hook_flag = Arc::clone(&flush_delay_active);

    let rt = Arc::new(
        DiagRuntime::new(
            Arc::clone(&ring),
            false,
            dir.clone(),
            Arc::new(|| HygieneState::Idle),
        )
        .with_flush_hook(Arc::new(move |_| {
            if slow_hook_flag.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(60));
            }
        })),
    );
    rt.set_mode(CaptureMode::DiagnosticCapture, false);

    // Concurrent producer swarm: rapid Play/Pause/Resume/Seek, endpoint switches,
    // discovery generations, queue advances while writer runs concurrently.
    let rt_writer = Arc::clone(&rt);
    let writer_stop = Arc::new(AtomicBool::new(false));
    let writer_stop_ref = Arc::clone(&writer_stop);
    let writer = thread::Builder::new()
        .name("cadence-test-slow-writer".into())
        .spawn(move || {
            let mut scratch = Vec::with_capacity(64);
            let mut lines = String::with_capacity(2048);
            while !writer_stop_ref.load(Ordering::Relaxed) {
                let _ = rt_writer.flush_pending_batch(&mut scratch, &mut lines, 64);
                thread::sleep(Duration::from_millis(5));
            }
        })
        .unwrap();

    let max_push_us = Arc::new(AtomicU64::new(0));
    let total_accepted = Arc::new(AtomicUsize::new(0));
    let start_all = Instant::now();

    let mut handles = Vec::new();
    for worker_idx in 0..4u64 {
        let rt_ref = Arc::clone(&rt);
        let max_push_ref = Arc::clone(&max_push_us);
        let accepted_ref = Arc::clone(&total_accepted);
        handles.push(
            thread::Builder::new()
                .name(format!("audio-stress-{}", worker_idx))
                .spawn(move || {
                    for step in 0..2_500u64 {
                        let cid = worker_idx * 10_000 + step;
                        let (cat, ev, detail) = match step % 4 {
                            0 => (
                                DiagCategory::AudioEngineCommands,
                                "cmd_completed",
                                "cmd=Play queue_depth=1",
                            ),
                            1 => (
                                DiagCategory::DeviceSelection,
                                "endpoint_selected",
                                "prev=wasapi:A selected=upnp:uuid:rose source=desktop_ui",
                            ),
                            2 => (
                                DiagCategory::WasapiLifecycle,
                                "wasapi_stream_initialized",
                                "rate=44100 ch=2 fmt=F32",
                            ),
                            _ => (
                                DiagCategory::QueueCoordination,
                                "stale_advance_rejected",
                                "owner=ws_monitor rev=12",
                            ),
                        };
                        let t0 = Instant::now();
                        if rt_ref.submit_test_event(cat, cid, ev, detail) {
                            accepted_ref.fetch_add(1, Ordering::Relaxed);
                        }
                        let us = t0.elapsed().as_micros() as u64;
                        max_push_ref.fetch_max(us, Ordering::Relaxed);
                    }
                })
                .unwrap(),
        );
    }

    for h in handles {
        h.join().unwrap();
    }
    let total_elapsed = start_all.elapsed();

    flush_delay_active.store(false, Ordering::Relaxed);
    writer_stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();

    let accepted = total_accepted.load(Ordering::Relaxed) as u64;
    let dropped = ring.dropped_total();
    assert_eq!(accepted + dropped, 10_000);
    assert!(
        max_push_us.load(Ordering::Relaxed) < 10_000,
        "Producer submission spiked to {} us under slow writer contention",
        max_push_us.load(Ordering::Relaxed)
    );
    assert!(
        total_elapsed < Duration::from_millis(250),
        "10k rapid cross-thread diagnostic submissions took {:?} (stalled)",
        total_elapsed
    );

    // Ensure global DEBUG OFF baseline helper remains safe as well
    diagnostics::set_mode(CaptureMode::Off);
    let _ = fs::remove_dir_all(&dir);
}
