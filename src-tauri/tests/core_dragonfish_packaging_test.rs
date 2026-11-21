//! Phase 6 acceptance: TrueNAS SCALE Dragonfish 24.04 packaging, container bootstrap,
//! state persistence, mount/ACL validation, fixed listener readiness, pre-flight
//! memory/CAP_IPC_LOCK checks, and versioned backup/rollback.
//!
//! Exit evidence covered:
//! 1. Clean test install in an empty `/var/lib/cadence` directory: generates and persists
//!    `node-identity.json`, `tls-cert.json`, and `cadence.db` (WAL mode), binds fixed
//!    control (4040) and media (18890) listeners, and serves `core.hello` + readiness probe.
//! 2. Advertised-address reachability & rejection: rejects pod/loopback/VPN/unspecified
//!    addresses in production mode and fails readiness clearly when the control or media
//!    port is already occupied.
//! 3. Mounts, ACLs & read-only `/music` enforcement: rejects missing/unwritable `/var/lib/cadence`,
//!    rejects overlapping `/var/lib/cadence` and `/music` mounts, and enforces read-only
//!    `/music` dataset access by default.
//! 4. Restart persistence: restarting `DragonfishNode` against the same `/var/lib/cadence`
//!    retains the exact `engineId`, `libraryId`, TLS certificate fingerprint, pinned RS130 UDN,
//!    and SQLite catalog rows.
//! 5. Pre-flight memory / `CAP_IPC_LOCK` readiness failures: rejects startup with actionable
//!    TrueNAS Dragonfish remediation messages when container memory budget is below mandatory
//!    headroom or when `CAP_IPC_LOCK` is missing and `RLIMIT_MEMLOCK` is below minimum lock floor.
//! 6. Versioned state backup & rollback: creates a consistent snapshot backup (`cadence.db`,
//!    `node-identity.json`, `tls-cert.json`), blocks startup against an incompatible newer
//!    schema/state version, and cleanly restores the matching backup on rollback.
//! 7. OCI Dockerfile & TrueNAS Dragonfish 24.04 Custom App recipe validation (`replicas: 1`,
//!    `Recreate` strategy, `hostNetwork: true`, `568:568` `apps` user/group, `IPC_LOCK`
//!    capability, read-only `/music`, persistent `/var/lib/cadence`, bounded `/tmp` tmpfs,
//!    explicit `4040`/`18890` ports).

use cadence_core_lib::core_runtime::dragonfish::{
    validate_dragonfish_custom_app_yaml, validate_dragonfish_dockerfile, DragonfishConfig,
    DragonfishError, DragonfishNode, DEFAULT_CONTROL_PORT, DEFAULT_MEDIA_PORT,
    DRAGONFISH_SCHEMA_VERSION,
};
use cadence_core_lib::core_runtime::{
    CgroupMemoryLimits, HostMemoryLimits, MemoryLocker, PlatformLimits, PlatformProbe,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct FakeLocker {
    locked_bytes: AtomicUsize,
}

impl FakeLocker {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            locked_bytes: AtomicUsize::new(0),
        })
    }
}

impl MemoryLocker for FakeLocker {
    fn lock_and_prefault(&self, data: &mut [u8]) -> bool {
        for page in data.chunks_mut(4096) {
            std::hint::black_box(&mut page[0]);
        }
        self.locked_bytes.fetch_add(data.len(), Ordering::SeqCst);
        true
    }

    fn unlock(&self, data: &[u8]) {
        self.locked_bytes.fetch_sub(data.len(), Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct ConfigurableProbe {
    limits: PlatformLimits,
}

impl PlatformProbe for ConfigurableProbe {
    fn query_limits(&self) -> PlatformLimits {
        self.limits.clone()
    }
}

fn generous_dragonfish_probe() -> ConfigurableProbe {
    ConfigurableProbe {
        limits: PlatformLimits {
            cgroup: CgroupMemoryLimits {
                max_bytes: Some(2 * 1024 * 1024 * 1024),
                high_bytes: Some(1792 * 1024 * 1024),
                current_bytes: Some(64 * 1024 * 1024),
            },
            host: HostMemoryLimits {
                total_bytes: 64 * 1024 * 1024 * 1024,
                available_bytes: 16 * 1024 * 1024 * 1024,
                zfs_arc_reclaimable_bytes: 16 * 1024 * 1024 * 1024,
            },
            rlimit_memlock_bytes: Some(64 * 1024),
            cap_ipc_lock: true,
        },
    }
}

struct DragonfishTestDirs {
    root: PathBuf,
    app_data_dir: PathBuf,
    music_dir: PathBuf,
    tmp_dir: PathBuf,
}

impl DragonfishTestDirs {
    fn create(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "cadence_phase6_{}_{}_{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let app_data_dir = root.join("var_lib_cadence");
        let music_dir = root.join("music_ro");
        let tmp_dir = root.join("tmp");
        std::fs::create_dir_all(&app_data_dir).expect("create app_data_dir");
        std::fs::create_dir_all(&music_dir).expect("create music_dir");
        std::fs::create_dir_all(&tmp_dir).expect("create tmp_dir");
        Self {
            root,
            app_data_dir,
            music_dir,
            tmp_dir,
        }
    }

    fn base_config(&self) -> DragonfishConfig {
        DragonfishConfig {
            app_data_dir: self.app_data_dir.clone(),
            music_mount_dir: self.music_dir.clone(),
            tmp_dir: self.tmp_dir.clone(),
            music_read_only: true,
            expected_uid: 568,
            expected_gid: 568,
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_for_tests: true,
            control_bind_addr: "127.0.0.1:0".parse().unwrap(),
            media_bind_addr: "127.0.0.1:0".parse().unwrap(),
            label: "Music Room Dragonfish Core".into(),
            pinned_rs130_udn: Some("uuid:rs130-music-room".into()),
            headroom_bytes: 64 * 1024 * 1024,
            min_lockable_bytes: 64 * 1024 * 1024,
            app_version: "0.1.0".into(),
            schema_version: DRAGONFISH_SCHEMA_VERSION,
        }
    }
}

impl Drop for DragonfishTestDirs {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn http_get_json(addr: SocketAddr, path: &str) -> (u16, Value) {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, addr
    );
    stream.write_all(req.as_bytes()).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let (hdr, body) = raw.split_once("\r\n\r\n").expect("http response split");
    let status = hdr
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(500);
    let parsed: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({ "raw": body }));
    (status, parsed)
}

fn http_post_json(
    app_data: &std::path::Path,
    addr: SocketAddr,
    path: &str,
    payload: &Value,
) -> (u16, Value) {
    let pairing_token = std::fs::read_to_string(app_data.join("pairing-token")).unwrap();
    let body_bytes = serde_json::to_vec(payload).unwrap();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let req = format!(
        "POST {} HTTP/1.1\r\nx-cadence-token: {pairing_token}\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        addr,
        body_bytes.len()
    );
    stream.write_all(req.as_bytes()).unwrap();
    stream.write_all(&body_bytes).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let (hdr, body) = raw.split_once("\r\n\r\n").expect("http response split");
    let status = hdr
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(500);
    let parsed: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({ "raw": body }));
    (status, parsed)
}

#[test]
fn upnp_delivery_control_is_identity_scoped_bounded_and_can_toggle_pacing() {
    let dirs = DragonfishTestDirs::create("delivery_control");
    let mut node = DragonfishNode::bootstrap_with_platform(
        dirs.base_config(), generous_dragonfish_probe(), FakeLocker::new(),
    ).unwrap();
    let identity = node.identity().clone();
    let mut request = json!({"protocolVersion": 2, "engineId": identity.engine_id,
        "libraryId": identity.library_id, "operation": "player.upnp_delivery"});
    let call = |value: &Value| http_post_json(&dirs.app_data_dir, node.control_listen_addr(), "/v1/core", value).1;
    let summary = call(&request);
    assert_eq!(summary["ok"], true, "{summary}");
    assert_eq!(summary["data"]["pacerEnabled"], true);
    assert!(summary["data"]["capture"].is_null());
    request["engineId"] = json!("wrong-engine");
    request["captureAction"] = json!("start");
    let rejected = call(&request);
    assert_eq!(rejected["error"]["code"], "identity_mismatch");
    request["engineId"] = json!(identity.engine_id);
    request["includeCapture"] = json!(true);
    let started = call(&request);
    let id = started["data"]["capture"]["id"].as_u64().unwrap();
    request["captureAction"] = json!("stop");
    request["captureId"] = json!(id);
    let stopped = call(&request);
    assert_eq!(stopped["data"]["capture"]["complete"], true);
    request = json!({"protocolVersion": 2, "engineId": identity.engine_id,
        "libraryId": identity.library_id, "operation": "player.upnp_pacer", "enabled": false});
    assert_eq!(call(&request)["data"]["pacerEnabled"], false);
    request["operation"] = json!("player.upnp_delivery");
    assert_eq!(call(&request)["data"]["pacerEnabled"], false);
    node.shutdown().unwrap();
}

#[test]
fn clean_install_persists_identity_cert_wal_db_and_serves_control_and_readiness() {
    let dirs = DragonfishTestDirs::create("clean_install");
    let cfg = dirs.base_config();
    let locker = FakeLocker::new();

    assert_eq!(DEFAULT_CONTROL_PORT, 4040);
    assert_eq!(DEFAULT_MEDIA_PORT, 18890);

    let mut node =
        DragonfishNode::bootstrap_with_platform(cfg, generous_dragonfish_probe(), locker)
            .expect("bootstrap clean install");

    // Verify persistent state files created on `/var/lib/cadence`
    assert!(dirs.app_data_dir.join("node-identity.json").is_file());
    assert!(dirs.app_data_dir.join("tls-cert.json").is_file());
    assert!(dirs.app_data_dir.join("tls-cert.pem").is_file());
    assert!(dirs.app_data_dir.join("tls-key.pem").is_file());
    assert!(dirs.app_data_dir.join("cadence.db").is_file());

    let identity = node.identity().clone();
    assert!(identity.engine_id.starts_with("core_"));
    assert!(identity.library_id.starts_with("lib_"));
    assert_eq!(
        identity.pinned_rs130_udn.as_deref(),
        Some("uuid:rs130-music-room")
    );
    assert_eq!(node.tls_certificate().sha256_fingerprint.len(), 64);

    // Verify HTTP readiness probe (`/healthz`) and control API (`/v1/core`)
    let control_addr = node.control_listen_addr();
    let (status_health, health_json) = http_get_json(control_addr, "/healthz");
    assert_eq!(status_health, 200, "{health_json}");
    assert_eq!(health_json["ready"], true);
    assert_eq!(health_json["engineId"], identity.engine_id);
    assert_eq!(health_json["libraryId"], identity.library_id);
    assert_eq!(
        health_json["tlsFingerprintSha256"],
        node.tls_certificate().sha256_fingerprint
    );
    assert_eq!(health_json["musicReadOnly"], true);
    let expected_build = cadence_core_lib::build_info::current_build_info();
    assert_eq!(health_json["protocolVersion"], 2);
    assert_eq!(
        health_json["protocolRevision"],
        cadence_core_lib::build_info::CORE_PROTOCOL_V2_REVISION
    );
    assert_eq!(health_json["build"]["display"], expected_build.display);
    assert_eq!(health_json["build"]["commitSha"], expected_build.commit_sha);

    let (status_hello, hello_json) = http_post_json(
        &dirs.app_data_dir,
        control_addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": identity.engine_id,
            "libraryId": identity.library_id,
            "operation": "core.hello"
        }),
    );
    assert_eq!(status_hello, 200, "{hello_json}");
    assert_eq!(hello_json["ok"], true);
    assert_eq!(hello_json["data"]["ready"], true);
    assert_eq!(hello_json["data"]["protocolVersion"], 1);
    assert!(hello_json["data"].get("build").is_none());

    let (status_hello_v2, hello_v2_json) = http_post_json(
        &dirs.app_data_dir,
        control_addr,
        "/v1/core",
        &json!({
            "protocolVersion": 2,
            "engineId": identity.engine_id,
            "libraryId": identity.library_id,
            "operation": "core.hello"
        }),
    );
    assert_eq!(status_hello_v2, 200, "{hello_v2_json}");
    assert_eq!(hello_v2_json["ok"], true);
    assert_eq!(hello_v2_json["data"]["protocolVersion"], 2);
    assert_eq!(
        hello_v2_json["data"]["protocolRevision"],
        cadence_core_lib::build_info::CORE_PROTOCOL_V2_REVISION
    );
    assert_eq!(hello_v2_json["data"]["build"]["display"], expected_build.display);

    node.shutdown().expect("clean shutdown");
}

#[test]
fn restart_retains_persisted_identity_certificate_pinned_udn_and_database_state() {
    let dirs = DragonfishTestDirs::create("restart_persistence");
    let cfg = dirs.base_config();
    let locker = FakeLocker::new();

    // First boot: initialize clean state and insert a track into persistent cadence.db
    let mut node1 = DragonfishNode::bootstrap_with_platform(
        cfg.clone(),
        generous_dragonfish_probe(),
        locker.clone(),
    )
    .expect("first boot");

    let id1 = node1.identity().clone();
    let cert1 = node1.tls_certificate().clone();

    let song_path = dirs.music_dir.join("symphony.flac");
    std::fs::write(&song_path, vec![0x42u8; 32 * 1024]).unwrap();
    node1
        .seed_track_for_test("trk_symphony_1", "First Symphony", &song_path, 120.0)
        .expect("seed track in persistent db");

    node1.shutdown().expect("shutdown node1");
    drop(node1);

    // Second boot (container restart): must preserve exact engineId, libraryId, TLS cert, UDN, and DB tracks
    let mut node2 = DragonfishNode::bootstrap_with_platform(
        DragonfishConfig {
            label: "Updated Label Ignored If Identity Persisted".into(),
            pinned_rs130_udn: None, // persisted UDN should be retained
            ..cfg
        },
        generous_dragonfish_probe(),
        locker,
    )
    .expect("second boot after restart");

    assert_eq!(node2.identity().engine_id, id1.engine_id);
    assert_eq!(node2.identity().library_id, id1.library_id);
    assert_eq!(
        node2.identity().pinned_rs130_udn,
        Some("uuid:rs130-music-room".into())
    );
    assert_eq!(
        node2.tls_certificate().sha256_fingerprint,
        cert1.sha256_fingerprint
    );
    assert_eq!(node2.tls_certificate().cert_pem, cert1.cert_pem);

    let (status, snap) = http_post_json(
        &dirs.app_data_dir,
        node2.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": id1.engine_id,
            "libraryId": id1.library_id,
            "operation": "session.snapshot"
        }),
    );
    assert_eq!(status, 200);
    assert_eq!(snap["ok"], true, "{snap}");
    let tracks = snap["data"]["catalog"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["id"], "trk_symphony_1");
    assert_eq!(tracks[0]["title"], "First Symphony");

    node2.shutdown().expect("shutdown node2");
}

#[test]
fn advertised_address_and_fixed_port_conflicts_fail_readiness_clearly() {
    let dirs = DragonfishTestDirs::create("net_conflicts");

    // 1. Production mode (`allow_loopback_for_tests: false`) rejects loopback, 0.0.0.0, VPN/CGNAT, link-local
    for bad_ip in ["127.0.0.1", "0.0.0.0", "100.90.1.2", "169.254.1.10"] {
        let mut cfg = dirs.base_config();
        cfg.allow_loopback_for_tests = false;
        cfg.advertised_ip = bad_ip.into();
        let err = DragonfishNode::bootstrap_with_platform(
            cfg,
            generous_dragonfish_probe(),
            FakeLocker::new(),
        )
        .expect_err("must reject invalid advertised IP");
        assert!(
            matches!(err, DragonfishError::InvalidAdvertisedAddress(_)),
            "unexpected error for {}: {:?}",
            bad_ip,
            err
        );
    }

    // 2. Occupied control port (e.g. 4040 conflict) fails readiness clearly without silent fallback
    let occupied_ctrl = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_ctrl_addr = occupied_ctrl.local_addr().unwrap();
    let mut cfg_ctrl = dirs.base_config();
    cfg_ctrl.control_bind_addr = occupied_ctrl_addr;
    let err_ctrl = DragonfishNode::bootstrap_with_platform(
        cfg_ctrl,
        generous_dragonfish_probe(),
        FakeLocker::new(),
    )
    .expect_err("occupied control port must fail readiness");
    assert!(matches!(
        err_ctrl,
        DragonfishError::PortConflict {
            role: "control",
            ..
        }
    ));

    // 3. Occupied media port (e.g. 18890 conflict) fails readiness clearly
    let occupied_media = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_media_addr = occupied_media.local_addr().unwrap();
    let mut cfg_media = dirs.base_config();
    cfg_media.media_bind_addr = occupied_media_addr;
    let err_media = DragonfishNode::bootstrap_with_platform(
        cfg_media,
        generous_dragonfish_probe(),
        FakeLocker::new(),
    )
    .expect_err("occupied media port must fail readiness");
    assert!(matches!(
        err_media,
        DragonfishError::PortConflict { role: "media", .. }
    ));
}

#[test]
fn mount_acl_and_read_only_music_validations_prevent_misconfiguration() {
    let dirs = DragonfishTestDirs::create("mounts_acl");

    // 1. Overlapping app_data_dir and music_mount_dir must be rejected
    let mut overlap_cfg = dirs.base_config();
    overlap_cfg.music_mount_dir = dirs.app_data_dir.join("nested_music");
    std::fs::create_dir_all(&overlap_cfg.music_mount_dir).unwrap();
    let err_overlap = DragonfishNode::bootstrap_with_platform(
        overlap_cfg,
        generous_dragonfish_probe(),
        FakeLocker::new(),
    )
    .expect_err("overlapping mounts must fail");
    assert!(matches!(err_overlap, DragonfishError::MountValidation(_)));

    // 2. Missing music mount directory must fail clearly
    let mut missing_music_cfg = dirs.base_config();
    missing_music_cfg.music_mount_dir = dirs.root.join("non_existent_music_dataset");
    let err_missing = DragonfishNode::bootstrap_with_platform(
        missing_music_cfg,
        generous_dragonfish_probe(),
        FakeLocker::new(),
    )
    .expect_err("missing music mount must fail");
    assert!(matches!(err_missing, DragonfishError::MountValidation(_)));

    // 3. Read-only music mode blocks any attempt to write into `/music` through the runtime guard
    let mut node = DragonfishNode::bootstrap_with_platform(
        dirs.base_config(),
        generous_dragonfish_probe(),
        FakeLocker::new(),
    )
    .expect("bootstrap valid mounts");
    let write_attempt = node.verify_music_write_allowed();
    assert_eq!(
        write_attempt,
        Err(DragonfishError::MusicMountReadOnly),
        "playback-only Dragonfish deployment must refuse music dataset writes"
    );
    node.shutdown().unwrap();
}

#[test]
fn preflight_memory_and_cap_ipc_lock_checks_fail_readiness_with_actionable_diagnostics() {
    let dirs = DragonfishTestDirs::create("memory_preflight");

    // 1. Missing CAP_IPC_LOCK with default 64 KiB RLIMIT_MEMLOCK fails pre-flight check
    let no_ipc_lock_probe = ConfigurableProbe {
        limits: PlatformLimits {
            cap_ipc_lock: false,
            rlimit_memlock_bytes: Some(64 * 1024),
            ..generous_dragonfish_probe().limits
        },
    };
    let err_lock = DragonfishNode::bootstrap_with_platform(
        dirs.base_config(),
        no_ipc_lock_probe,
        FakeLocker::new(),
    )
    .expect_err("missing CAP_IPC_LOCK with 64 KiB RLIMIT_MEMLOCK must fail readiness");
    assert!(matches!(
        err_lock,
        DragonfishError::InsufficientLockLimit { .. }
    ));
    assert!(err_lock.user_message().contains("CAP_IPC_LOCK"));

    // 2. Container cgroup memory limit too small for headroom + minimum lockable arena fails pre-flight
    let tiny_cgroup_probe = ConfigurableProbe {
        limits: PlatformLimits {
            cgroup: CgroupMemoryLimits {
                max_bytes: Some(96 * 1024 * 1024), // 96 MiB total < 64 MiB current + 64 MiB headroom + 64 MiB min lockable
                high_bytes: None,
                current_bytes: Some(64 * 1024 * 1024),
            },
            ..generous_dragonfish_probe().limits
        },
    };
    let err_budget = DragonfishNode::bootstrap_with_platform(
        dirs.base_config(),
        tiny_cgroup_probe,
        FakeLocker::new(),
    )
    .expect_err("tiny container memory limit must fail readiness");
    assert!(matches!(
        err_budget,
        DragonfishError::InsufficientMemoryBudget { .. }
    ));
}

#[test]
fn versioned_backup_blocks_incompatible_schema_and_restores_cleanly_on_rollback() {
    let dirs = DragonfishTestDirs::create("backup_rollback");
    let cfg = dirs.base_config();
    let locker = FakeLocker::new();

    // 1. Boot v0.1.0 (schema v1), seed a track, and create a pre-upgrade backup snapshot
    let mut node = DragonfishNode::bootstrap_with_platform(
        cfg.clone(),
        generous_dragonfish_probe(),
        locker.clone(),
    )
    .expect("boot v0.1.0");
    let original_id = node.identity().clone();
    let original_cert = node.tls_certificate().clone();
    let original_token = std::fs::read_to_string(dirs.app_data_dir.join("pairing-token")).unwrap();

    let song_path = dirs.music_dir.join("goldberg.flac");
    std::fs::write(&song_path, vec![0x77u8; 32 * 1024]).unwrap();
    node.seed_track_for_test("trk_goldberg", "Goldberg Variations", &song_path, 180.0)
        .unwrap();

    let backup_dir = node
        .create_versioned_backup("0.1.0-pre-upgrade")
        .expect("create consistent pre-upgrade backup");
    assert!(backup_dir.join("cadence.db").is_file());
    assert!(backup_dir.join("node-identity.json").is_file());
    assert!(backup_dir.join("tls-cert.json").is_file());
    assert!(backup_dir.join("pairing-token").is_file());
    assert!(backup_dir.join("backup-manifest.json").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(backup_dir.join("pairing-token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    node.shutdown().unwrap();
    drop(node);

    // 2. Simulate an incompatible newer schema version (e.g. schema_version = 99) written to state
    DragonfishNode::write_schema_version_for_test(&dirs.app_data_dir, 99).unwrap();
    std::fs::write(
        dirs.app_data_dir.join("pairing-token"),
        "corrupted-token-before-restore-000000000000000000",
    )
    .unwrap();
    // Also corrupt/delete the track in the live DB to verify rollback actually restores the snapshot
    {
        let conn = rusqlite::Connection::open(dirs.app_data_dir.join("cadence.db")).unwrap();
        conn.execute("DELETE FROM tracks;", []).unwrap();
    }

    // Booting v0.1.0 (which expects schema_version = 1) must block incompatible version 99
    let err_incompat = DragonfishNode::bootstrap_with_platform(
        cfg.clone(),
        generous_dragonfish_probe(),
        locker.clone(),
    )
    .expect_err("must block incompatible future schema version");
    assert!(matches!(
        err_incompat,
        DragonfishError::IncompatibleSchemaVersion {
            found_version: 99,
            supported_version: DRAGONFISH_SCHEMA_VERSION
        }
    ));

    // 3. Roll back to the `0.1.0-pre-upgrade` backup snapshot and verify clean boot + restored data
    DragonfishNode::restore_versioned_backup(&dirs.app_data_dir, "0.1.0-pre-upgrade")
        .expect("restore versioned backup");
    let restored_token = std::fs::read_to_string(dirs.app_data_dir.join("pairing-token")).unwrap();
    assert_eq!(restored_token, original_token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dirs.app_data_dir.join("pairing-token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    let mut restored_node =
        DragonfishNode::bootstrap_with_platform(cfg, generous_dragonfish_probe(), locker)
            .expect("boot after rollback restore");

    assert_eq!(restored_node.identity().engine_id, original_id.engine_id);
    assert_eq!(
        restored_node.tls_certificate().sha256_fingerprint,
        original_cert.sha256_fingerprint
    );

    let (status, snap) = http_post_json(
        &dirs.app_data_dir,
        restored_node.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": original_id.engine_id,
            "libraryId": original_id.library_id,
            "operation": "session.snapshot"
        }),
    );
    assert_eq!(status, 200);
    let tracks = snap["data"]["catalog"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["id"], "trk_goldberg");

    restored_node.shutdown().unwrap();
}

#[test]
fn dragonfish_dockerfile_and_custom_app_recipe_enforce_truenas_24_04_invariants() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root");
    let dockerfile_path = repo_root.join("deploy/truenas-dragonfish/Dockerfile");
    let custom_app_path = repo_root.join("deploy/truenas-dragonfish/custom-app-24.04.yaml");
    let compose_path = repo_root.join("deploy/truenas-dragonfish/docker-compose.yml");

    assert!(
        dockerfile_path.is_file(),
        "missing {}",
        dockerfile_path.display()
    );
    assert!(
        custom_app_path.is_file(),
        "missing {}",
        custom_app_path.display()
    );
    assert!(compose_path.is_file(), "missing {}", compose_path.display());

    let dockerfile_text = std::fs::read_to_string(&dockerfile_path).unwrap();
    let custom_app_text = std::fs::read_to_string(&custom_app_path).unwrap();

    validate_dragonfish_dockerfile(&dockerfile_text).expect("Dockerfile invariants");
    validate_dragonfish_custom_app_yaml(&custom_app_text)
        .expect("Dragonfish Custom App invariants");

    // Also test the CLI `--validate-dragonfish-recipe` mode on `cadence-headless`
    let exe = env!("CARGO_BIN_EXE_cadence-headless");
    let out = Command::new(exe)
        .arg("--validate-dragonfish-recipe")
        .arg(&custom_app_path)
        .arg("--validate-dockerfile")
        .arg(&dockerfile_path)
        .output()
        .expect("run cadence-headless recipe validator");
    assert!(
        out.status.success(),
        "cadence-headless recipe validation failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn free_loopback_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn cadence_headless_dragonfish_daemon_healthcheck_backup_and_restore_cli_roundtrip() {
    let dirs = DragonfishTestDirs::create("cli_daemon_roundtrip");
    let exe = env!("CARGO_BIN_EXE_cadence-headless");
    let ctrl_port = free_loopback_port();
    let media_port = free_loopback_port();

    // 1. Start `cadence-headless --dragonfish` with container env vars
    let mut child = Command::new(exe)
        .arg("--dragonfish")
        .env("CADENCE_APP_DATA_DIR", &dirs.app_data_dir)
        .env("CADENCE_MUSIC_DIR", &dirs.music_dir)
        .env("CADENCE_TMP_DIR", &dirs.tmp_dir)
        .env("CADENCE_ADVERTISED_IP", "127.0.0.1")
        .env("CADENCE_ALLOW_LOOPBACK", "true")
        .env("CADENCE_CONTROL_PORT", ctrl_port.to_string())
        .env("CADENCE_MEDIA_PORT", media_port.to_string())
        .env("CADENCE_HEADROOM_MB", "16")
        .env("CADENCE_MIN_LOCKABLE_MB", "16")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn cadence-headless --dragonfish");

    // 2. Poll `--healthcheck` CLI probe until ready (up to 3s)
    let mut healthy = false;
    for _ in 0..30 {
        let hc = Command::new(exe)
            .arg("--healthcheck")
            .arg("--control-port")
            .arg(ctrl_port.to_string())
            .env("CADENCE_ALLOW_LOOPBACK", "true")
            .env("CADENCE_APP_DATA_DIR", &dirs.app_data_dir)
            .output()
            .expect("run healthcheck");
        if hc.status.success() {
            healthy = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(healthy, "cadence-headless --healthcheck never succeeded");

    let doctor_out = Command::new(exe)
        .arg("--doctor")
        .arg("--data-dir")
        .arg(&dirs.app_data_dir)
        .arg("--port")
        .arg(ctrl_port.to_string())
        .env("CADENCE_ALLOW_LOOPBACK", "true")
        .output()
        .expect("run --doctor");
    assert!(
        doctor_out.status.success(),
        "--doctor failed: {}",
        String::from_utf8_lossy(&doctor_out.stderr)
    );
    let doctor_stdout = String::from_utf8_lossy(&doctor_out.stdout);
    assert!(
        doctor_stdout.contains("PRAGMA integrity_check passed"),
        "unexpected --doctor output: {doctor_stdout}"
    );
    assert!(
        doctor_stdout.contains("Overall: HEALTHY"),
        "unexpected --doctor summary: {doctor_stdout}"
    );

    let ctrl_addr: SocketAddr = format!("127.0.0.1:{}", ctrl_port).parse().unwrap();
    let (status_h, health_json) = http_get_json(ctrl_addr, "/healthz");
    assert_eq!(status_h, 200);
    let engine_id = health_json["engineId"].as_str().unwrap().to_string();
    let library_id = health_json["libraryId"].as_str().unwrap().to_string();

    let (status_hello, hello) = http_post_json(
        &dirs.app_data_dir,
        ctrl_addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": engine_id,
            "libraryId": library_id,
            "operation": "core.hello"
        }),
    );
    assert_eq!(status_hello, 200);
    assert_eq!(hello["ok"], true);

    let _ = child.kill();
    let _ = child.wait();

    // 3. Offline CLI `--backup` before simulated incompatible schema bump
    let backup_out = Command::new(exe)
        .arg("--app-data-dir")
        .arg(&dirs.app_data_dir)
        .arg("--backup")
        .arg("pre-0.2.0")
        .output()
        .expect("run --backup");
    assert!(
        backup_out.status.success(),
        "--backup failed: {}",
        String::from_utf8_lossy(&backup_out.stderr)
    );

    DragonfishNode::write_schema_version_for_test(&dirs.app_data_dir, 99).unwrap();
    let blocked_boot = Command::new(exe)
        .arg("--dragonfish")
        .env("CADENCE_APP_DATA_DIR", &dirs.app_data_dir)
        .env("CADENCE_MUSIC_DIR", &dirs.music_dir)
        .env("CADENCE_TMP_DIR", &dirs.tmp_dir)
        .env("CADENCE_ADVERTISED_IP", "127.0.0.1")
        .env("CADENCE_ALLOW_LOOPBACK", "true")
        .env("CADENCE_CONTROL_PORT", ctrl_port.to_string())
        .env("CADENCE_MEDIA_PORT", media_port.to_string())
        .env("CADENCE_HEADROOM_MB", "16")
        .env("CADENCE_MIN_LOCKABLE_MB", "16")
        .output()
        .expect("run incompatible boot");
    assert!(!blocked_boot.status.success());
    assert!(String::from_utf8_lossy(&blocked_boot.stderr).contains("schema version 99"));

    // 4. Offline CLI `--restore` and restart verifying identity preservation
    let restore_out = Command::new(exe)
        .arg("--app-data-dir")
        .arg(&dirs.app_data_dir)
        .arg("--restore")
        .arg("pre-0.2.0")
        .output()
        .expect("run --restore");
    assert!(
        restore_out.status.success(),
        "--restore failed: {}",
        String::from_utf8_lossy(&restore_out.stderr)
    );

    let mut restarted = Command::new(exe)
        .arg("--dragonfish")
        .env("CADENCE_APP_DATA_DIR", &dirs.app_data_dir)
        .env("CADENCE_MUSIC_DIR", &dirs.music_dir)
        .env("CADENCE_TMP_DIR", &dirs.tmp_dir)
        .env("CADENCE_ADVERTISED_IP", "127.0.0.1")
        .env("CADENCE_ALLOW_LOOPBACK", "true")
        .env("CADENCE_CONTROL_PORT", ctrl_port.to_string())
        .env("CADENCE_MEDIA_PORT", media_port.to_string())
        .env("CADENCE_HEADROOM_MB", "16")
        .env("CADENCE_MIN_LOCKABLE_MB", "16")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("respawn cadence-headless --dragonfish");

    let mut restarted_healthy = false;
    for _ in 0..30 {
        let hc = Command::new(exe)
            .arg("--healthcheck")
            .arg("--control-port")
            .arg(ctrl_port.to_string())
            .env("CADENCE_ALLOW_LOOPBACK", "true")
            .env("CADENCE_APP_DATA_DIR", &dirs.app_data_dir)
            .output()
            .expect("run healthcheck after restore");
        if hc.status.success() {
            restarted_healthy = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(restarted_healthy, "restarted node failed healthcheck");
    let (_, restored_health) = http_get_json(ctrl_addr, "/healthz");
    assert_eq!(restored_health["engineId"], engine_id);
    assert_eq!(restored_health["libraryId"], library_id);

    let _ = restarted.kill();
    let _ = restarted.wait();
}

#[test]
fn dragonfish_projects_track_formats_and_plays_multi_track_queue_with_navigation() {
    let dirs = DragonfishTestDirs::create("multi_track_queue_and_format");
    let mut cfg = dirs.base_config();
    cfg.headroom_bytes = 16 * 1024 * 1024;
    cfg.min_lockable_bytes = 16 * 1024 * 1024;

    let mut node = DragonfishNode::bootstrap_with_platform(
        cfg,
        generous_dragonfish_probe(),
        FakeLocker::new(),
    )
    .expect("bootstrap node");
    let addr = node.control_listen_addr();
    let engine_id = node.identity().engine_id.clone();
    let library_id = node.identity().library_id.clone();

    let mut track_ids = Vec::new();
    for idx in 1..=3u32 {
        let tid = format!("trk-wav-{}", idx);
        let file = dirs.music_dir.join(format!("track_{}.wav", idx));
        std::fs::write(&file, vec![0x52u8; 64 * 1024]).expect("write wav fixture");
        node.seed_track_for_test(&tid, &format!("Track {}", idx), &file, 210.0 + idx as f64)
            .expect("seed track");
        track_ids.push(tid);
    }

    // Patch track metadata directly while Idle to emulate imported WAV/2009 snapshot metadata,
    // then seed track 4 to trigger reload_catalog().
    {
        let db_path = dirs.app_data_dir.join("cadence.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open db");
        conn.execute(
            "UPDATE releases SET release_year = 2009 WHERE id = 'rel-dragonfish'",
            [],
        )
        .unwrap();
        for (idx, tid) in track_ids.iter().enumerate() {
            conn.execute(
                "UPDATE tracks SET format = 'WAV', sample_rate = 44100, bit_depth = 16, track_number = ?1, disc_number = 1, release_year = 2009 WHERE id = ?2",
                rusqlite::params![(idx + 1) as i64, tid],
            )
            .unwrap();
        }
    }
    let tid4 = "trk-wav-4".to_string();
    let file4 = dirs.music_dir.join("track_4.wav");
    std::fs::write(&file4, vec![0x52u8; 64 * 1024]).expect("write wav fixture 4");
    node.seed_track_for_test(&tid4, "Track 4", &file4, 214.0)
        .expect("seed track 4");
    track_ids.push(tid4);

    let (status, snap) = http_post_json(
        &dirs.app_data_dir,
        addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": engine_id,
            "libraryId": library_id,
            "operation": "session.snapshot"
        }),
    );
    assert_eq!(status, 200);
    assert_eq!(snap["ok"], true, "{snap}");
    let cat_tracks = snap["data"]["catalog"]["tracks"].as_array().unwrap();
    assert_eq!(cat_tracks.len(), 4);
    assert_eq!(cat_tracks[0]["format"], "WAV");
    assert_eq!(cat_tracks[0]["sampleRate"], 44100);
    assert_eq!(cat_tracks[0]["bitDepth"], 16);
    assert_eq!(cat_tracks[0]["trackNumber"], 1);
    assert_eq!(cat_tracks[0]["discNumber"], 1);
    assert_eq!(cat_tracks[0]["releaseYear"], 2009);

    let entries: Vec<Value> = track_ids
        .iter()
        .enumerate()
        .map(|(i, tid)| json!({ "entryId": format!("e-{}", i + 1), "trackId": tid }))
        .collect();
    let (_, replace_res) = http_post_json(
        &dirs.app_data_dir,
        addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": engine_id,
            "libraryId": library_id,
            "operation": "queue.replace",
            "commandId": "cmd-replace-4",
            "expectedRevision": 0,
            "entries": entries
        }),
    );
    assert_eq!(
        replace_res["ok"], true,
        "multi-track queue.replace failed: {replace_res}"
    );
    let rev1 = replace_res["data"]["revision"].as_u64().unwrap();

    let (_, play_res) = http_post_json(
        &dirs.app_data_dir,
        addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": engine_id,
            "libraryId": library_id,
            "operation": "playback.control",
            "action": "play",
            "trackId": track_ids[0],
            "commandId": "cmd-play-1",
            "expectedRevision": rev1
        }),
    );
    assert_eq!(play_res["ok"], true, "play failed: {play_res}");
    let rev2 = play_res["data"]["revision"].as_u64().unwrap();

    // Jump to entry #4 (previously unadmitted idx >= 2)
    let (_, jump_res) = http_post_json(
        &dirs.app_data_dir,
        addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": engine_id,
            "libraryId": library_id,
            "operation": "queue.control",
            "action": "jump",
            "entryId": "e-4",
            "commandId": "cmd-jump-4",
            "expectedRevision": rev2
        }),
    );
    assert_eq!(jump_res["ok"], true, "jump to 4th entry failed: {jump_res}");
    assert_eq!(jump_res["data"]["queue"]["currentEntryId"], "e-4");
    let rev3 = jump_res["data"]["revision"].as_u64().unwrap();

    let (_, prev_res) = http_post_json(
        &dirs.app_data_dir,
        addr,
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": engine_id,
            "libraryId": library_id,
            "operation": "queue.control",
            "action": "previous",
            "commandId": "cmd-prev-3",
            "expectedRevision": rev3
        }),
    );
    assert_eq!(prev_res["ok"], true, "previous failed: {prev_res}");
    assert_eq!(prev_res["data"]["queue"]["currentEntryId"], "e-3");

    node.shutdown().unwrap();
}
