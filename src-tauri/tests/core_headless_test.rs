//! Phase 4 acceptance: Tauri-independent headless Core runtime, temp SQLite lifecycle,
//! TrueNAS cgroup v2 / CAP_IPC_LOCK / RLIMIT_MEMLOCK strict locked-RAM admission,
//! 30-second storage-bus cooldown silence, and cpuset/socket platform primitives.

use cadence_core_lib::core_runtime::{
    normalize_linux_getsockopt_sndbuf, normalize_linux_setsockopt_sndbuf, parse_cgroup_limit_bytes,
    parse_cpuset_list, parse_proc_status_cap_ipc_lock, partition_truenas_cpus, AdmissionError,
    CgroupMemoryLimits, CpuPartition, HeadlessConfig, HeadlessCoreRuntime, HostMemoryLimits,
    LockedBytesArena, MemoryLocker, PlatformLimits, PlatformProbe, RuntimeError, COOLDOWN_DURATION,
    DEFAULT_CONTAINER_HEADROOM_BYTES,
};
use cadence_core_lib::core_session::{Output, Renderer, RendererAction, RendererError, RendererEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct FakeRendererState {
    actions: Vec<RendererAction>,
}

#[derive(Clone, Default)]
struct RecordingRenderer(Arc<Mutex<FakeRendererState>>);

impl Renderer for RecordingRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        self.0.lock().unwrap().actions.push(action.clone());
        Ok(())
    }
}

struct FakeLocker {
    should_succeed: bool,
    lock_calls: AtomicUsize,
    unlock_calls: AtomicUsize,
    locked_bytes: AtomicUsize,
}

impl FakeLocker {
    fn new(should_succeed: bool) -> Arc<Self> {
        Arc::new(Self {
            should_succeed,
            lock_calls: AtomicUsize::new(0),
            unlock_calls: AtomicUsize::new(0),
            locked_bytes: AtomicUsize::new(0),
        })
    }
}

impl MemoryLocker for FakeLocker {
    fn lock_and_prefault(&self, data: &mut [u8]) -> bool {
        self.lock_calls.fetch_add(1, Ordering::SeqCst);
        for page in data.chunks_mut(4096) {
            page[0] = page[0];
        }
        if self.should_succeed {
            self.locked_bytes.fetch_add(data.len(), Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    fn unlock(&self, data: &[u8]) {
        self.unlock_calls.fetch_add(1, Ordering::SeqCst);
        self.locked_bytes.fetch_sub(data.len(), Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct FakePlatformProbe {
    limits: PlatformLimits,
}

impl PlatformProbe for FakePlatformProbe {
    fn query_limits(&self) -> PlatformLimits {
        self.limits.clone()
    }
}

struct TempWorkspace {
    dir: PathBuf,
    db_path: PathBuf,
    song_a_path: PathBuf,
    song_b_path: PathBuf,
}

impl TempWorkspace {
    fn create(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "cadence_phase4_{}_{}_{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let db_path = dir.join("cadence.db");
        let song_a_path = dir.join("song_a.flac");
        let song_b_path = dir.join("song_b.dsf");
        std::fs::write(&song_a_path, vec![0xA5u8; 64 * 1024]).expect("write song_a");
        std::fs::write(&song_b_path, vec![0x5Au8; 128 * 1024]).expect("write song_b");
        seed_temp_database(&db_path, &dir, &song_a_path, &song_b_path);
        Self {
            dir,
            db_path,
            song_a_path,
            song_b_path,
        }
    }
}

fn seed_temp_database(db_path: &Path, mount_dir: &Path, song_a: &Path, song_b: &Path) {
    let conn = rusqlite::Connection::open(db_path).expect("open seed db");
    cadence_core_lib::db::schema::initialize_schema(&conn).expect("init schema");
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES (?1, ?2, ?3, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
        rusqlite::params!["mount-main", "TrueNAS Music", mount_dir.to_string_lossy().as_ref()],
    )
    .expect("insert mount");
    conn.execute(
        "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '2026-11-15T00:00:00Z')",
        rusqlite::params![
            "rel-1",
            "Reference Master",
            mount_dir.to_string_lossy().as_ref(),
            "Reference Master",
            "Cadence Ensemble"
        ],
    )
    .expect("insert release");
    conn.execute(
        "INSERT INTO tracks (
            id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
            file_size, mtime, title, artist_credit, album_title, track_number,
            duration_secs, format, sample_rate, bit_depth, channels, created_at
        ) VALUES (?1, 'rel-1', 'mount-main', ?2, 'Reference Master', ?3, 'song_a.flac',
                  ?4, 1700000000, 'Prelude in C', 'Cadence Ensemble', 'Reference Master', 1,
                  180.0, 'FLAC', 96000, 24, 2, '2026-11-15T00:00:00Z')",
        rusqlite::params![
            "track-alpha",
            mount_dir.to_string_lossy().as_ref(),
            song_a.to_string_lossy().as_ref(),
            64 * 1024i64,
        ],
    )
    .expect("insert track alpha");
    conn.execute(
        "INSERT INTO tracks (
            id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
            file_size, mtime, title, artist_credit, album_title, track_number,
            duration_secs, format, sample_rate, bit_depth, channels, created_at
        ) VALUES (?1, 'rel-1', 'mount-main', ?2, 'Reference Master', ?3, 'song_b.dsf',
                  ?4, 1700000000, 'Nocturne DSD', 'Cadence Ensemble', 'Reference Master', 2,
                  240.0, 'DSF', 2822400, 1, 2, '2026-11-15T00:00:00Z')",
        rusqlite::params![
            r"\\NAS\Music\unsafe path id\song_b.dsf",
            mount_dir.to_string_lossy().as_ref(),
            song_b.to_string_lossy().as_ref(),
            128 * 1024i64,
        ],
    )
    .expect("insert track beta with legacy path id");
}

fn default_config(db_path: PathBuf) -> HeadlessConfig {
    HeadlessConfig {
        db_path,
        engine_id: "truenas-core".into(),
        library_id: "main-library".into(),
        label: "TrueNAS Music Core".into(),
        output: Some(Output {
            id: "rs130-main".into(),
            label: "HiFi ROSE RS130".into(),
            transport: "upnp".into(),
        }),
        headroom_bytes: 16 * 1024 * 1024,
    }
}

fn generous_probe() -> FakePlatformProbe {
    FakePlatformProbe {
        limits: PlatformLimits {
            cgroup: CgroupMemoryLimits {
                max_bytes: Some(512 * 1024 * 1024),
                high_bytes: Some(448 * 1024 * 1024),
                current_bytes: Some(64 * 1024 * 1024),
            },
            host: HostMemoryLimits {
                total_bytes: 64 * 1024 * 1024 * 1024,
                available_bytes: 16 * 1024 * 1024 * 1024,
                zfs_arc_reclaimable_bytes: 8 * 1024 * 1024 * 1024,
            },
            rlimit_memlock_bytes: Some(64 * 1024),
            cap_ipc_lock: true,
        },
    }
}

fn wire(mut body: Value) -> Vec<u8> {
    let obj = body.as_object_mut().unwrap();
    obj.insert("protocolVersion".into(), json!(1));
    obj.insert("engineId".into(), json!("truenas-core"));
    obj.insert("libraryId".into(), json!("main-library"));
    serde_json::to_vec(&body).unwrap()
}

#[test]
fn temp_db_startup_projects_catalog_runs_v1_protocol_and_shuts_down_cleanly() {
    let ws = TempWorkspace::create("startup_shutdown");
    let renderer = RecordingRenderer::default();
    let locker = FakeLocker::new(true);
    let mut runtime = HeadlessCoreRuntime::open_with_platform(
        default_config(ws.db_path.clone()),
        renderer.clone(),
        generous_probe(),
        locker.clone(),
    )
    .expect("open headless runtime");

    assert_eq!(runtime.wal_enabled().expect("check wal"), true);

    let hello = runtime.request(&wire(json!({ "operation": "core.hello" })));
    assert_eq!(hello["ok"], true, "{hello}");
    assert_eq!(hello["data"]["ready"], true);

    let snap = runtime.request(&wire(json!({ "operation": "session.snapshot" })));
    assert_eq!(snap["ok"], true, "{snap}");
    let tracks = snap["data"]["catalog"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    for t in tracks {
        let id = t["id"].as_str().unwrap();
        assert!(!id.contains('\\') && !id.contains('/') && !id.contains(' '));
        assert!(t.get("filePath").is_none());
    }

    let track_ids: Vec<String> = tracks
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect();

    runtime
        .admit_tracks(&track_ids)
        .expect("admit both tracks while idle");
    assert_eq!(runtime.retained_locked_bytes(), (64 + 128) * 1024);

    let play_resp = runtime.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": track_ids[0],
        "commandId": "cmd-play-1",
        "expectedRevision": 0
    })));
    assert_eq!(play_resp["ok"], true, "{play_resp}");
    assert_eq!(play_resp["data"]["playback"]["activity"], "loading");

    runtime.shutdown().expect("clean shutdown");
    assert_eq!(runtime.retained_locked_bytes(), 0);
    assert_eq!(locker.locked_bytes.load(Ordering::SeqCst), 0);
    assert!(matches!(
        renderer.0.lock().unwrap().actions.last(),
        Some(RendererAction::Stop)
    ));

    drop(runtime);
    std::fs::remove_dir_all(&ws.dir).expect("temp dir should have no open SQLite file handles");
}

#[test]
fn truenas_cgroup_v2_and_cap_ipc_lock_admission_enforces_container_limits() {
    assert_eq!(parse_cgroup_limit_bytes("max\n"), Ok(None));
    assert_eq!(parse_cgroup_limit_bytes("268435456\n"), Ok(Some(268_435_456)));
    assert_eq!(
        parse_proc_status_cap_ipc_lock("Name:\tcadence\nCapEff:\t0000000000004000\n"),
        true
    );
    assert_eq!(
        parse_proc_status_cap_ipc_lock("Name:\tcadence\nCapEff:\t0000000000000000\n"),
        false
    );

    let mut files = HashMap::new();
    let ws = TempWorkspace::create("cgroup_limits");
    files.insert("t-small".to_string(), ws.song_a_path.clone()); // 64 KiB
    files.insert("t-large".to_string(), ws.song_b_path.clone()); // 128 KiB

    // 1. Unprivileged container without CAP_IPC_LOCK and 64 KiB RLIMIT_MEMLOCK rejects 128 KiB track.
    let unprivileged_probe = FakePlatformProbe {
        limits: PlatformLimits {
            cgroup: CgroupMemoryLimits {
                max_bytes: Some(256 * 1024 * 1024),
                high_bytes: Some(224 * 1024 * 1024),
                current_bytes: Some(64 * 1024 * 1024),
            },
            host: HostMemoryLimits {
                total_bytes: 64 * 1024 * 1024 * 1024,
                available_bytes: 2 * 1024 * 1024 * 1024,
                zfs_arc_reclaimable_bytes: 32 * 1024 * 1024 * 1024,
            },
            rlimit_memlock_bytes: Some(64 * 1024),
            cap_ipc_lock: false,
        },
    };
    let locker = FakeLocker::new(true);
    let mut arena = LockedBytesArena::new(
        unprivileged_probe.clone(),
        locker.clone(),
        DEFAULT_CONTAINER_HEADROOM_BYTES,
    );
    let err = arena
        .admit_files(&files, &["t-large".to_string()])
        .expect_err("must reject when RLIMIT_MEMLOCK is 64 KiB and CAP_IPC_LOCK is missing");
    assert!(matches!(
        err,
        AdmissionError::LockLimitTooLow {
            requested_bytes: 131_072,
            available_lock_bytes: 65_536,
            cap_ipc_lock: false
        }
    ));
    assert!(err.user_message().contains("CAP_IPC_LOCK"));
    assert_eq!(arena.retained_locked_bytes(), 0);

    // 2. With CAP_IPC_LOCK enabled on TrueNAS, 64 KiB RLIMIT_MEMLOCK is bypassed and container cgroup applies.
    let cap_probe = FakePlatformProbe {
        limits: PlatformLimits {
            cap_ipc_lock: true,
            ..unprivileged_probe.limits
        },
    };
    let mut cap_arena = LockedBytesArena::new(cap_probe, locker.clone(), 64 * 1024 * 1024);
    // Container high_bytes (224 MiB) - current (64 MiB) - headroom (64 MiB) = 96 MiB budget
    assert_eq!(cap_arena.available_budget_bytes(), 96 * 1024 * 1024);
    cap_arena
        .admit_files(&files, &["t-small".to_string(), "t-large".to_string()])
        .expect("admit with CAP_IPC_LOCK");
    assert_eq!(cap_arena.retained_locked_bytes(), (64 + 128) * 1024);
    assert_eq!(
        cap_arena.get_slice("t-small").map(|b| b.len()),
        Some(64 * 1024)
    );

    drop(cap_arena);
    assert_eq!(locker.locked_bytes.load(Ordering::SeqCst), 0);
    let _ = std::fs::remove_dir_all(&ws.dir);
}

#[test]
fn strict_admission_rejects_over_budget_and_lock_failures_without_windowed_or_pageable_fallback() {
    let ws = TempWorkspace::create("strict_failures");
    let mut files = HashMap::new();
    files.insert("t-64k".to_string(), ws.song_a_path.clone());
    files.insert("t-128k".to_string(), ws.song_b_path.clone());

    // Tight container budget: max 128 KiB above current + headroom -> 64 KiB fits, +128 KiB overflows
    let tight_probe = FakePlatformProbe {
        limits: PlatformLimits {
            cgroup: CgroupMemoryLimits {
                max_bytes: Some(10 * 1024 * 1024 + 128 * 1024),
                high_bytes: None,
                current_bytes: Some(2 * 1024 * 1024),
            },
            host: HostMemoryLimits {
                total_bytes: 32 * 1024 * 1024 * 1024,
                available_bytes: 16 * 1024 * 1024 * 1024,
                zfs_arc_reclaimable_bytes: 0,
            },
            rlimit_memlock_bytes: None,
            cap_ipc_lock: true,
        },
    };
    let locker = FakeLocker::new(true);
    let mut arena = LockedBytesArena::new(tight_probe.clone(), locker.clone(), 8 * 1024 * 1024);
    assert_eq!(arena.available_budget_bytes(), 128 * 1024);

    arena
        .admit_files(&files, &["t-64k".to_string()])
        .expect("64 KiB fits within 128 KiB budget");
    assert_eq!(arena.retained_locked_bytes(), 64 * 1024);
    assert_eq!(arena.available_budget_bytes(), 64 * 1024);

    let over = arena
        .admit_files(&files, &["t-128k".to_string()])
        .expect_err("128 KiB exceeds remaining 64 KiB budget");
    assert!(matches!(
        over,
        AdmissionError::OverBudget {
            requested_bytes: 131_072,
            available_budget_bytes: 65_536
        }
    ));
    assert!(over.user_message().contains("smaller selection"));
    // Previously admitted track remains locked; failed batch did not allocate or lock
    assert_eq!(arena.retained_locked_bytes(), 64 * 1024);

    // Failing OS locker (ENOMEM / EPERM) must never leave pageable buffers in the arena
    let failing_locker = FakeLocker::new(false);
    let mut failing_arena =
        LockedBytesArena::new(generous_probe(), failing_locker.clone(), 16 * 1024 * 1024);
    let lock_err = failing_arena
        .admit_files(&files, &["t-64k".to_string()])
        .expect_err("mlock failure must reject strict admission");
    assert_eq!(lock_err, AdmissionError::LockUnavailable);
    assert_eq!(failing_arena.retained_locked_bytes(), 0);
    assert_eq!(failing_locker.locked_bytes.load(Ordering::SeqCst), 0);

    let _ = std::fs::remove_dir_all(&ws.dir);
}

#[test]
fn storage_bus_silence_blocks_admission_and_db_reload_during_playback_and_30s_cooldown() {
    let ws = TempWorkspace::create("silence_cooldown");
    let renderer = RecordingRenderer::default();
    let locker = FakeLocker::new(true);
    let mut runtime = HeadlessCoreRuntime::open_with_platform(
        default_config(ws.db_path.clone()),
        renderer.clone(),
        generous_probe(),
        locker,
    )
    .expect("open runtime");

    let browse_root=ws.dir.with_extension("library");std::fs::create_dir(&browse_root).unwrap();
    runtime.configure_library(vec![browse_root.clone()]).unwrap();
    let v2 = |operation:&str, path:Option<&Path>| serde_json::to_vec(&json!({"protocolVersion":2,"engineId":"truenas-core","libraryId":"main-library","operation":operation,"path":path.map(|p|p.to_string_lossy())})).unwrap();
    let browse=v2("fs.browse",Some(&browse_root));
    assert_eq!(runtime.request(&browse)["ok"],true);
    let protected_checks=|runtime:&mut HeadlessCoreRuntime<RecordingRenderer,FakePlatformProbe,Arc<FakeLocker>>, now:Instant| {
        assert_eq!(runtime.request_at(&browse,now)["data"]["cached"],true);
        let miss=v2("fs.browse",Some(&browse_root.join("uncached")));
        assert_eq!(runtime.request_at(&miss,now)["error"]["code"],"deferred_until_idle");
        assert_eq!(runtime.request_at(&v2("folders.scan",None),now)["error"]["code"],"deferred_until_idle");
        assert_eq!(runtime.request_at(&v2("curate.approve",None),now)["error"]["code"],"deferred_until_idle");
        assert!(runtime.artwork_at("missing",now).is_err());
        runtime.library_step_at(now).unwrap();
    };

    let snap = runtime.request(&wire(json!({ "operation": "session.snapshot" })));
    let tracks = snap["data"]["catalog"]["tracks"].as_array().unwrap();
    let track_a = tracks[0]["id"].as_str().unwrap().to_string();
    let track_b = tracks[1]["id"].as_str().unwrap().to_string();

    // Unadmitted track cannot be played or queued (no on-demand disk read or windowed fallback)
    let unadmitted_queue = runtime.request(&wire(json!({
        "operation": "queue.replace",
        "entries": [{ "entryId": "e-1", "trackId": track_a }],
        "commandId": "cmd-unadmitted-queue",
        "expectedRevision": 0
    })));
    assert_eq!(unadmitted_queue["ok"], false);
    assert_eq!(unadmitted_queue["error"]["code"], "not_ready");

    let unadmitted_play = runtime.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": track_a,
        "commandId": "cmd-unadmitted",
        "expectedRevision": 0
    })));
    assert_eq!(unadmitted_play["ok"], false);
    assert_eq!(unadmitted_play["error"]["code"], "not_ready");

    // Admit track_a while Idle
    let t0 = Instant::now();
    runtime
        .admit_tracks_at(&[track_a.clone()], t0)
        .expect("admit track_a while idle");

    // Start playback of track_a -> state becomes Loading
    let rev = runtime.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"]
        .as_u64()
        .unwrap();
    let play_ok = runtime.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": track_a,
        "commandId": "cmd-play-admitted",
        "expectedRevision": rev
    })));
    assert_eq!(play_ok["ok"], true, "{play_ok}");

    protected_checks(&mut runtime,t0+Duration::from_secs(1));
    // While Loading: admission and DB reload are blocked
    assert_eq!(
        runtime.admit_tracks_at(&[track_b.clone()], t0 + Duration::from_secs(1)),
        Err(RuntimeError::TransportNotIdle)
    );
    assert_eq!(
        runtime.reload_catalog_at(t0 + Duration::from_secs(1)),
        Err(RuntimeError::TransportNotIdle)
    );

    // Transition to Playing
    let token = renderer
        .0
        .lock()
        .unwrap()
        .actions
        .iter()
        .rev()
        .find_map(|a| a.token().cloned())
        .unwrap();
    runtime
        .on_renderer_event_at(RendererEvent::Started(token), t0 + Duration::from_secs(2))
        .unwrap();

    protected_checks(&mut runtime,t0+Duration::from_secs(5));
    // While Playing: admission and DB reload are blocked
    assert_eq!(
        runtime.admit_tracks_at(&[track_b.clone()], t0 + Duration::from_secs(5)),
        Err(RuntimeError::TransportNotIdle)
    );

    // Transition to Paused: still blocked
    let rev = runtime.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"]
        .as_u64()
        .unwrap();
    assert_eq!(
        runtime.request(&wire(json!({
            "operation": "playback.control",
            "action": "pause",
            "commandId": "cmd-pause",
            "expectedRevision": rev
        })))["ok"],
        true
    );
    assert_eq!(
        runtime.admit_tracks_at(&[track_b.clone()], t0 + Duration::from_secs(6)),
        Err(RuntimeError::TransportNotIdle)
    );

    protected_checks(&mut runtime,t0+Duration::from_secs(6));
    // Stop at t0 + 10s -> enters 30s post-playback cooldown
    let stop_at = t0 + Duration::from_secs(10);
    let rev = runtime.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"]
        .as_u64()
        .unwrap();
    assert_eq!(
        runtime.request_at(
            &wire(json!({
                "operation": "playback.control",
                "action": "stop",
                "commandId": "cmd-stop",
                "expectedRevision": rev
            })),
            stop_at
        )["ok"],
        true
    );

    // At stop_at + 15s (15s remaining in cooldown): blocked by CooldownActive
    let during_cooldown = runtime
        .admit_tracks_at(&[track_b.clone()], stop_at + Duration::from_secs(15))
        .expect_err("must block during 30s cooldown");
    assert!(matches!(
        during_cooldown,
        RuntimeError::CooldownActive {
            remaining_ms: 15_000
        }
    ));
    assert!(matches!(
        runtime.reload_catalog_at(stop_at + Duration::from_secs(29)),
        Err(RuntimeError::CooldownActive { remaining_ms: 1_000 })
    ));

    protected_checks(&mut runtime,stop_at+Duration::from_secs(29));
    // At stop_at + 30s (cooldown elapsed): admission and catalog reload succeed!
    runtime
        .admit_tracks_at(&[track_b], stop_at + COOLDOWN_DURATION)
        .expect("admission allowed after 30s cooldown");
    runtime
        .reload_catalog_at(stop_at + COOLDOWN_DURATION)
        .expect("catalog reload allowed after 30s cooldown");

    runtime.shutdown().unwrap();
    drop(runtime);
    let _ = std::fs::remove_dir_all(&ws.dir);
    let _ = std::fs::remove_dir_all(&browse_root);
}

#[test]
fn truenas_cpuset_affinity_and_linux_sndbuf_normalization_preserve_core_isolation() {
    assert_eq!(
        parse_cpuset_list("0-1,4-7\n").unwrap(),
        vec![0, 1, 4, 5, 6, 7]
    );
    assert_eq!(parse_cpuset_list("4-7\n").unwrap(), vec![4, 5, 6, 7]);

    // Container pinned to cores 4-7 on TrueNAS: never assumes 0..3; pacer gets 7, control gets 4..=6
    let part = partition_truenas_cpus(&[4, 5, 6, 7]);
    assert_eq!(
        part,
        CpuPartition {
            pacer_core: Some(7),
            control_cores: vec![4, 5, 6],
            control_worker_threads: 2,
        }
    );

    // 4-core system 0..=3: strips Core 0 and Core 1; pacer gets 3, control gets [2]
    let part_0_3 = partition_truenas_cpus(&[0, 1, 2, 3]);
    assert_eq!(
        part_0_3,
        CpuPartition {
            pacer_core: Some(3),
            control_cores: vec![2],
            control_worker_threads: 1,
        }
    );

    // Linux SO_SNDBUF doubles setsockopt requests in kernel sk_sndbuf
    assert_eq!(normalize_linux_setsockopt_sndbuf(32 * 1024), 16 * 1024);
    assert_eq!(normalize_linux_getsockopt_sndbuf(64 * 1024), 32 * 1024);
}

#[test]
fn headless_executable_runs_stdio_session_without_gui_or_audio_output_dependencies() {
    let ws = TempWorkspace::create("headless_bin");
    let exe = env!("CARGO_BIN_EXE_cadence-headless");
    let mut child = Command::new(exe)
        .arg("--db")
        .arg(&ws.db_path)
        .arg("--engine-id")
        .arg("truenas-core")
        .arg("--library-id")
        .arg("main-library")
        .arg("--label")
        .arg("TrueNAS Music Core")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn cadence-headless binary");

    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));

    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&json!({
            "protocolVersion": 1,
            "engineId": "truenas-core",
            "libraryId": "main-library",
            "operation": "core.hello"
        }))
        .unwrap()
    )
    .unwrap();
    stdin.flush().unwrap();

    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let hello: Value = serde_json::from_str(&line).expect("valid hello JSON");
    assert_eq!(hello["ok"], true, "{hello}");
    assert_eq!(hello["data"]["engineId"], "truenas-core");
    assert_eq!(hello["data"]["ready"], true);

    line.clear();
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&json!({
            "protocolVersion": 1,
            "engineId": "truenas-core",
            "libraryId": "main-library",
            "operation": "session.snapshot"
        }))
        .unwrap()
    )
    .unwrap();
    stdin.flush().unwrap();
    stdout.read_line(&mut line).unwrap();
    let snap: Value = serde_json::from_str(&line).expect("valid snapshot JSON");
    assert_eq!(snap["ok"], true, "{snap}");
    assert_eq!(
        snap["data"]["catalog"]["tracks"].as_array().unwrap().len(),
        2
    );

    drop(stdin);
    let status = child.wait().expect("wait for cadence-headless exit");
    assert!(status.success());

    let _ = std::fs::remove_dir_all(&ws.dir);
}

#[test]
fn headless_dependency_tree_excludes_gui_and_local_audio_crates() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest_path = manifest_dir.join("Cargo.toml");

    let output = Command::new("cargo")
        .arg("tree")
        .arg("--manifest-path")
        .arg(&manifest_path)
        .arg("--target")
        .arg("x86_64-unknown-linux-gnu")
        .arg("--no-default-features")
        .output()
        .expect("run cargo tree for linux headless target");
    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tree = String::from_utf8_lossy(&output.stdout);
    for forbidden in [
        "tauri v",
        "tauri-build",
        "wry v",
        "tao v",
        "cpal v",
        "rodio v",
        "alsa-sys",
        "windows v",
    ] {
        assert!(
            !tree.contains(forbidden),
            "headless Linux dependency tree must not contain '{}':\n{}",
            forbidden,
            tree
        );
    }
}

