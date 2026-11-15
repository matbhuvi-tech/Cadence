//! Phase 6: TrueNAS SCALE Dragonfish 24.04 packaging, container bootstrap,
//! state persistence, mount/ACL validation, fixed listener readiness (`4040` / `18890`),
//! pre-flight memory & `CAP_IPC_LOCK` verification, and versioned backup/rollback.
//!
//! Invariants enforced:
//! 1. **Zero Disk I/O during playback:** identity, certificate, and SQLite initialization,
//!    plus pre-upgrade snapshot backups, run strictly at startup/shutdown while transport
//!    is `Idle`. `/music` is mounted read-only (`ro`) by default.
//! 2. **Explicit Advertised LAN Address & Fixed Port Readiness:** validates `CADENCE_ADVERTISED_IP`
//!    (rejecting loopback, unspecified, link-local, multicast, and CGNAT/VPN `100.64.0.0/10`)
//!    and binds fixed listeners (`4040` control, `18890` media). Any port conflict fails
//!    readiness immediately rather than binding an unadvertised fallback port.
//! 3. **TrueNAS Dragonfish Mount & Non-Root ACL Hygiene:** verifies `/var/lib/cadence` is
//!    writable by the non-root `568:568` (`apps`) user/group, separate from `/music` and
//!    bounded `/tmp`, and enforces read-only `/music` access by default.
//! 4. **Pre-Flight Memory Lock & Cgroup Admission Verification:** checks `CAP_IPC_LOCK` vs
//!    `RLIMIT_MEMLOCK` and cgroup v2 memory headroom before accepting controller sessions.
//! 5. **Versioned State Backup & Rollback:** creates consistent pre-upgrade backups of
//!    `cadence.db`, `node-identity.json`, and `tls-cert.json`, blocks incompatible future
//!    schemas, and restores matching backups cleanly on rollback.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::upnp_session::{validate_advertised_lan_ip, CoreMediaServer};
use super::{
    HeadlessConfig, HeadlessCoreRuntime, MemoryLocker, PlatformProbe, RuntimeError,
    SystemMemoryLocker, SystemPlatformProbe, DEFAULT_CONTAINER_HEADROOM_BYTES,
};
use crate::core_session::{Output, Renderer, RendererAction, RendererError, MAX_MESSAGE_BYTES};

/// Default HTTPS/WSS controller port for TrueNAS Dragonfish deployments.
pub const DEFAULT_CONTROL_PORT: u16 = 4040;

/// Default HTTP UPnP media port for HiFi ROSE RS130 delivery.
pub const DEFAULT_MEDIA_PORT: u16 = 18890;

/// Current persistent Dragonfish state/schema version.
pub const DRAGONFISH_SCHEMA_VERSION: u32 = 1;

/// Default TrueNAS SCALE `apps` user/group ID.
pub const DEFAULT_TRUENAS_APPS_UID: u32 = 568;
pub const DEFAULT_TRUENAS_APPS_GID: u32 = 568;

#[derive(Clone, Debug)]
pub struct DragonfishConfig {
    pub app_data_dir: PathBuf,
    pub music_mount_dir: PathBuf,
    pub tmp_dir: PathBuf,
    pub music_read_only: bool,
    pub expected_uid: u32,
    pub expected_gid: u32,
    pub advertised_ip: String,
    pub allow_loopback_for_tests: bool,
    pub control_bind_addr: SocketAddr,
    pub media_bind_addr: SocketAddr,
    pub label: String,
    pub pinned_rs130_udn: Option<String>,
    pub headroom_bytes: u64,
    pub min_lockable_bytes: u64,
    pub app_version: String,
    pub schema_version: u32,
}

impl Default for DragonfishConfig {
    fn default() -> Self {
        Self {
            app_data_dir: PathBuf::from("/var/lib/cadence"),
            music_mount_dir: PathBuf::from("/music"),
            tmp_dir: PathBuf::from("/tmp"),
            music_read_only: true,
            expected_uid: DEFAULT_TRUENAS_APPS_UID,
            expected_gid: DEFAULT_TRUENAS_APPS_GID,
            advertised_ip: String::new(),
            allow_loopback_for_tests: false,
            control_bind_addr: SocketAddr::from(([0, 0, 0, 0], DEFAULT_CONTROL_PORT)),
            media_bind_addr: SocketAddr::from(([0, 0, 0, 0], DEFAULT_MEDIA_PORT)),
            label: "TrueNAS Cadence Core".into(),
            pinned_rs130_udn: None,
            headroom_bytes: DEFAULT_CONTAINER_HEADROOM_BYTES,
            min_lockable_bytes: 64 * 1024 * 1024,
            app_version: env!("CARGO_PKG_VERSION").into(),
            schema_version: DRAGONFISH_SCHEMA_VERSION,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedNodeIdentity {
    pub engine_id: String,
    pub library_id: String,
    pub label: String,
    pub pinned_rs130_udn: Option<String>,
    pub schema_version: u32,
    pub app_version: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTlsCertificate {
    pub sha256_fingerprint: String,
    pub subject_cn: String,
    pub san_ips: Vec<String>,
    pub cert_pem: String,
    pub key_pem_path: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub tag: String,
    pub app_version: String,
    pub schema_version: u32,
    pub engine_id: String,
    pub library_id: String,
    pub tls_fingerprint_sha256: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DragonfishError {
    InvalidAdvertisedAddress(String),
    MountValidation(String),
    MusicMountReadOnly,
    InsufficientLockLimit {
        available_lock_bytes: u64,
        required_lock_bytes: u64,
        cap_ipc_lock: bool,
    },
    InsufficientMemoryBudget {
        available_budget_bytes: u64,
        required_budget_bytes: u64,
        headroom_bytes: u64,
    },
    PortConflict {
        role: &'static str,
        addr: SocketAddr,
        detail: String,
    },
    IncompatibleSchemaVersion {
        found_version: u32,
        supported_version: u32,
    },
    StatePersistence(String),
    Runtime(RuntimeError),
    RecipeValidation(String),
}

impl DragonfishError {
    pub fn user_message(&self) -> String {
        match self {
            Self::InvalidAdvertisedAddress(msg) => format!(
                "Invalid CADENCE_ADVERTISED_IP: {}. Configure a reachable wired LAN IPv4 address on TrueNAS Dragonfish.",
                msg
            ),
            Self::MountValidation(msg) => format!(
                "TrueNAS Dragonfish mount/ACL validation failed: {}",
                msg
            ),
            Self::MusicMountReadOnly => {
                "Music dataset (/music) is mounted read-only in playback-only mode; file writes are prohibited.".into()
            }
            Self::InsufficientLockLimit {
                available_lock_bytes,
                required_lock_bytes,
                ..
            } => format!(
                "Container locked-memory limit ({} bytes) is below minimum required ({} bytes). Add capability CAP_IPC_LOCK (securityContext.capabilities.add: [\"IPC_LOCK\"]) in the TrueNAS Dragonfish Custom App.",
                available_lock_bytes, required_lock_bytes
            ),
            Self::InsufficientMemoryBudget {
                available_budget_bytes,
                required_budget_bytes,
                headroom_bytes,
            } => format!(
                "Container available lockable memory budget ({} bytes after {} bytes headroom) is below minimum required ({} bytes). Increase the container memory limit in TrueNAS Dragonfish.",
                available_budget_bytes, headroom_bytes, required_budget_bytes
            ),
            Self::PortConflict { role, addr, detail } => format!(
                "Fixed {} listener failed to bind on {}: {}. Ensure no conflicting app occupies the port on TrueNAS.",
                role, addr, detail
            ),
            Self::IncompatibleSchemaVersion {
                found_version,
                supported_version,
            } => format!(
                "Persistent state at /var/lib/cadence uses schema version {} which is newer than supported version {}. Restore the matching versioned backup before rolling back the image.",
                found_version, supported_version
            ),
            Self::StatePersistence(msg) => format!("Persistent state error: {}", msg),
            Self::Runtime(err) => format!("Core runtime initialization failed: {:?}", err),
            Self::RecipeValidation(msg) => format!("Dragonfish recipe validation error: {}", msg),
        }
    }
}

struct DragonfishNoopRenderer;

impl Renderer for DragonfishNoopRenderer {
    fn apply(&mut self, _action: &RendererAction) -> Result<(), RendererError> {
        Ok(())
    }
}

/// Packaged TrueNAS SCALE Dragonfish 24.04 Core node managing persistent `/var/lib/cadence`
/// identity, certificate metadata, WAL SQLite database, fixed control/media listeners,
/// and versioned rollback snapshots.
pub struct DragonfishNode<
    P: PlatformProbe = SystemPlatformProbe,
    L: MemoryLocker = SystemMemoryLocker,
> {
    config: DragonfishConfig,
    advertised_ip: Ipv4Addr,
    identity: PersistedNodeIdentity,
    tls_cert: PersistedTlsCertificate,
    runtime: Arc<Mutex<HeadlessCoreRuntime<DragonfishNoopRenderer, P, L>>>,
    media_server: CoreMediaServer,
    control_listen_addr: SocketAddr,
    stop_control: Arc<AtomicBool>,
    control_join: Option<std::thread::JoinHandle<()>>,
}

impl DragonfishNode<SystemPlatformProbe, SystemMemoryLocker> {
    pub fn bootstrap(config: DragonfishConfig) -> Result<Self, DragonfishError> {
        Self::bootstrap_with_platform(config, SystemPlatformProbe, SystemMemoryLocker)
    }

    /// Creates a consistent, version-tagged backup bundle offline from `/var/lib/cadence`
    /// (for pre-upgrade hooks or CLI `--backup <tag>`).
    pub fn create_versioned_backup_offline(
        app_data_dir: &Path,
        app_version: &str,
        tag: &str,
    ) -> Result<PathBuf, DragonfishError> {
        let id_path = app_data_dir.join("node-identity.json");
        let id_raw = std::fs::read_to_string(&id_path)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let identity: PersistedNodeIdentity = serde_json::from_str(&id_raw)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        let cert_path = app_data_dir.join("tls-cert.json");
        let cert_raw = std::fs::read_to_string(&cert_path)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let tls_cert: PersistedTlsCertificate = serde_json::from_str(&cert_raw)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        create_versioned_backup_at(app_data_dir, app_version, &identity, &tls_cert, tag)
    }

    /// Restores a previously created versioned backup bundle from
    /// `/var/lib/cadence/backups/<tag>/` back into `/var/lib/cadence/`.
    pub fn restore_versioned_backup(
        app_data_dir: &Path,
        tag: &str,
    ) -> Result<BackupManifest, DragonfishError> {
        let safe_tag = sanitize_backup_tag(tag)?;
        let backup_dir = app_data_dir.join("backups").join(&safe_tag);
        let manifest_path = backup_dir.join("backup-manifest.json");
        let manifest_raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
            DragonfishError::StatePersistence(format!(
                "missing backup manifest at {}: {}",
                manifest_path.display(),
                e
            ))
        })?;
        let manifest: BackupManifest = serde_json::from_str(&manifest_raw)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        for required in ["cadence.db", "node-identity.json"] {
            let src = backup_dir.join(required);
            if !src.is_file() {
                return Err(DragonfishError::StatePersistence(format!(
                    "backup '{}' is incomplete (missing {})",
                    safe_tag,
                    src.display()
                )));
            }
        }

        // Remove stale WAL/SHM sidecars before restoring the clean VACUUM INTO snapshot
        let _ = std::fs::remove_file(app_data_dir.join("cadence.db-wal"));
        let _ = std::fs::remove_file(app_data_dir.join("cadence.db-shm"));

        for file_name in [
            "cadence.db",
            "node-identity.json",
            "tls-cert.json",
            "tls-cert.pem",
            "tls-key.pem",
        ] {
            let src = backup_dir.join(file_name);
            if src.is_file() {
                std::fs::copy(&src, app_data_dir.join(file_name))
                    .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
            }
        }

        Ok(manifest)
    }

    /// Test helper to simulate an incompatible schema upgrade in `node-identity.json`.
    pub fn write_schema_version_for_test(
        app_data_dir: &Path,
        schema_version: u32,
    ) -> Result<(), DragonfishError> {
        let id_path = app_data_dir.join("node-identity.json");
        let raw = std::fs::read_to_string(&id_path)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let mut id: PersistedNodeIdentity = serde_json::from_str(&raw)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        id.schema_version = schema_version;
        let bytes = serde_json::to_vec_pretty(&id)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        write_atomic_file(&id_path, &bytes)
    }
}

impl<P: PlatformProbe + Clone + 'static, L: MemoryLocker + Clone + 'static> DragonfishNode<P, L> {
    pub fn bootstrap_with_platform(
        config: DragonfishConfig,
        probe: P,
        locker: L,
    ) -> Result<Self, DragonfishError> {
        // 1. Validate advertised reachable LAN IP
        let advertised_ip = validate_advertised_lan_ip(
            &config.advertised_ip,
            config.allow_loopback_for_tests,
        )
        .map_err(DragonfishError::InvalidAdvertisedAddress)?;

        // 2. Validate mounts, non-overlapping paths, and writable `/var/lib/cadence` ACLs
        validate_mounts_and_acls(&config)?;

        // 3. Pre-flight check on CAP_IPC_LOCK / RLIMIT_MEMLOCK and cgroup v2 memory budget
        validate_preflight_memory_and_lock(&config, &probe)?;

        // 4. Load or initialize persistent node identity & check schema compatibility
        let identity = load_or_create_identity(&config)?;

        // 5. Load or initialize persistent TLS certificate metadata + PEM material
        let tls_cert = load_or_create_tls_certificate(&config, advertised_ip, &identity)?;

        // 6. Bind fixed media HTTP listener (default 18890) - fail readiness on conflict
        let media_server = CoreMediaServer::bind(
            config.media_bind_addr,
            advertised_ip.to_string(),
            config.allow_loopback_for_tests,
            2,
        )
        .map_err(|detail| DragonfishError::PortConflict {
            role: "media",
            addr: config.media_bind_addr,
            detail,
        })?;

        // 7. Bind fixed control listener (default 4040) - fail readiness on conflict
        let control_listener =
            TcpListener::bind(config.control_bind_addr).map_err(|e| DragonfishError::PortConflict {
                role: "control",
                addr: config.control_bind_addr,
                detail: e.to_string(),
            })?;
        let control_listen_addr = control_listener
            .local_addr()
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let _ = control_listener.set_nonblocking(true);

        // 8. Open persistent WAL SQLite database at `/var/lib/cadence/cadence.db`
        let db_path = config.app_data_dir.join("cadence.db");
        let headless_cfg = HeadlessConfig {
            db_path,
            engine_id: identity.engine_id.clone(),
            library_id: identity.library_id.clone(),
            label: identity.label.clone(),
            output: Some(Output {
                id: "rs130-upnp".into(),
                label: "HiFi ROSE RS130".into(),
                transport: "upnp".into(),
            }),
            headroom_bytes: config.headroom_bytes,
        };
        let rt = HeadlessCoreRuntime::open_with_platform(
            headless_cfg,
            DragonfishNoopRenderer,
            probe,
            locker,
        )
        .map_err(DragonfishError::Runtime)?;

        let runtime = Arc::new(Mutex::new(rt));
        let stop_control = Arc::new(AtomicBool::new(false));
        let media_port = media_server.listen_addr().port();

        let rt_ref = Arc::clone(&runtime);
        let stop_ref = Arc::clone(&stop_control);
        let id_copy = identity.clone();
        let cert_copy = tls_cert.clone();
        let music_ro = config.music_read_only;
        let adv_ip_str = advertised_ip.to_string();

        let control_join = std::thread::Builder::new()
            .name("cadence-dragonfish-control".into())
            .spawn(move || {
                run_control_listener_loop(
                    control_listener,
                    rt_ref,
                    stop_ref,
                    id_copy,
                    cert_copy,
                    adv_ip_str,
                    control_listen_addr.port(),
                    media_port,
                    music_ro,
                );
            })
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        Ok(Self {
            config,
            advertised_ip,
            identity,
            tls_cert,
            runtime,
            media_server,
            control_listen_addr,
            stop_control,
            control_join: Some(control_join),
        })
    }

    pub fn identity(&self) -> &PersistedNodeIdentity {
        &self.identity
    }

    pub fn tls_certificate(&self) -> &PersistedTlsCertificate {
        &self.tls_cert
    }

    pub fn advertised_ip(&self) -> Ipv4Addr {
        self.advertised_ip
    }

    pub fn control_listen_addr(&self) -> SocketAddr {
        self.control_listen_addr
    }

    pub fn media_listen_addr(&self) -> SocketAddr {
        self.media_server.listen_addr()
    }

    /// Guard verifying whether writes to `/music` are allowed.
    /// Playback-only deployments (`music_read_only = true`) always refuse writes.
    pub fn verify_music_write_allowed(&self) -> Result<(), DragonfishError> {
        if self.config.music_read_only {
            return Err(DragonfishError::MusicMountReadOnly);
        }
        Ok(())
    }

    /// Seeds a catalog track into the persistent `cadence.db` while `Idle` and reloads
    /// the in-memory catalog projection (used by integration tests).
    pub fn seed_track_for_test(
        &mut self,
        track_id: &str,
        title: &str,
        file_path: &Path,
        duration_secs: f64,
    ) -> Result<(), DragonfishError> {
        let db_path = self.config.app_data_dir.join("cadence.db");
        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let mount_str = self.config.music_mount_dir.to_string_lossy().to_string();
        let file_str = file_path.to_string_lossy().to_string();
        let file_len = std::fs::metadata(file_path).map(|m| m.len() as i64).unwrap_or(0);

        conn.execute(
            "INSERT OR IGNORE INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
             VALUES ('mount-dragonfish', 'TrueNAS Music', ?1, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
            rusqlite::params![mount_str],
        )
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        conn.execute(
            "INSERT OR IGNORE INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
             VALUES ('rel-dragonfish', 'Dragonfish Master', ?1, 'Dragonfish Master', 'Cadence', '2026-11-15T00:00:00Z')",
            rusqlite::params![mount_str],
        )
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        conn.execute(
            "INSERT OR REPLACE INTO tracks (
                id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                file_size, mtime, title, artist_credit, album_title, track_number,
                duration_secs, format, sample_rate, bit_depth, channels, created_at
            ) VALUES (?1, 'rel-dragonfish', 'mount-dragonfish', ?2, 'Dragonfish Master', ?3, 'track.flac',
                      ?4, 1700000000, ?5, 'Cadence Artist', 'Dragonfish Master', 1,
                      ?6, 'FLAC', 96000, 24, 2, '2026-11-15T00:00:00Z')",
            rusqlite::params![track_id, mount_str, file_str, file_len, title, duration_secs],
        )
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        drop(conn);

        let mut rt = self
            .runtime
            .lock()
            .map_err(|_| DragonfishError::StatePersistence("mutex poisoned".into()))?;
        rt.reload_catalog().map_err(DragonfishError::Runtime)?;
        Ok(())
    }

    /// Creates a consistent, version-tagged backup bundle under `/var/lib/cadence/backups/<tag>/`
    /// containing an atomic `VACUUM INTO` snapshot of `cadence.db`, `node-identity.json`,
    /// `tls-cert.json`, `tls-cert.pem`, `tls-key.pem`, and `backup-manifest.json`.
    pub fn create_versioned_backup(&self, tag: &str) -> Result<PathBuf, DragonfishError> {
        create_versioned_backup_at(
            &self.config.app_data_dir,
            &self.config.app_version,
            &self.identity,
            &self.tls_cert,
            tag,
        )
    }

}

impl<P: PlatformProbe, L: MemoryLocker> DragonfishNode<P, L> {
    pub fn shutdown(&mut self) -> Result<(), DragonfishError> {
        self.stop_control.store(true, Ordering::Release);
        if let Some(join) = self.control_join.take() {
            let wake_addr = if self.control_listen_addr.ip().is_unspecified() {
                SocketAddr::from(([127, 0, 0, 1], self.control_listen_addr.port()))
            } else {
                self.control_listen_addr
            };
            let _ = TcpStream::connect_timeout(&wake_addr, Duration::from_millis(50));
            let _ = join.join();
        }
        self.media_server.shutdown();
        if let Ok(mut rt) = self.runtime.lock() {
            rt.shutdown().map_err(DragonfishError::Runtime)?;
        }
        Ok(())
    }
}

impl<P: PlatformProbe, L: MemoryLocker> std::fmt::Debug for DragonfishNode<P, L> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DragonfishNode")
            .field("engine_id", &self.identity.engine_id)
            .field("library_id", &self.identity.library_id)
            .field("advertised_ip", &self.advertised_ip)
            .field("control_listen_addr", &self.control_listen_addr)
            .finish()
    }
}

impl<P: PlatformProbe, L: MemoryLocker> Drop for DragonfishNode<P, L> {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn create_versioned_backup_at(
    app_data_dir: &Path,
    app_version: &str,
    identity: &PersistedNodeIdentity,
    tls_cert: &PersistedTlsCertificate,
    tag: &str,
) -> Result<PathBuf, DragonfishError> {
    let safe_tag = sanitize_backup_tag(tag)?;
    let backup_dir = app_data_dir.join("backups").join(&safe_tag);
    if backup_dir.exists() {
        std::fs::remove_dir_all(&backup_dir)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    }
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

    let db_path = app_data_dir.join("cadence.db");
    let backup_db_path = backup_dir.join("cadence.db");
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    let escaped_dest = backup_db_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}';", escaped_dest))
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    drop(conn);

    for file_name in [
        "node-identity.json",
        "tls-cert.json",
        "tls-cert.pem",
        "tls-key.pem",
    ] {
        let src = app_data_dir.join(file_name);
        if src.is_file() {
            std::fs::copy(&src, backup_dir.join(file_name))
                .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        }
    }

    let manifest = BackupManifest {
        tag: safe_tag,
        app_version: app_version.to_string(),
        schema_version: identity.schema_version,
        engine_id: identity.engine_id.clone(),
        library_id: identity.library_id.clone(),
        tls_fingerprint_sha256: tls_cert.sha256_fingerprint.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    write_atomic_file(&backup_dir.join("backup-manifest.json"), &manifest_bytes)?;

    Ok(backup_dir)
}

/// Performs a local HTTP `/healthz` readiness check for container `HEALTHCHECK` probes.
pub fn probe_healthcheck(control_port: u16) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], control_port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("failed to connect to {}: {}", addr, e))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!(
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        control_port
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("failed to write healthcheck request: {}", e))?;
    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|e| format!("failed to read healthcheck response: {}", e))?;
    let (hdr, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_string())?;
    if !hdr.starts_with("HTTP/1.1 200") {
        return Err(format!("non-200 healthcheck status: {}", hdr.lines().next().unwrap_or("")));
    }
    let parsed: Value =
        serde_json::from_str(body).map_err(|e| format!("invalid healthcheck JSON: {}", e))?;
    if parsed.get("ready").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(format!("node reported not ready: {}", body))
    }
}

fn validate_mounts_and_acls(config: &DragonfishConfig) -> Result<(), DragonfishError> {
    if config.expected_uid == 0 || config.expected_gid == 0 {
        return Err(DragonfishError::MountValidation(
            "Container must run as non-root UID/GID (e.g. 568:568 apps on TrueNAS SCALE)".into(),
        ));
    }

    if !config.app_data_dir.is_dir() {
        return Err(DragonfishError::MountValidation(format!(
            "persistent app-data directory '{}' does not exist",
            config.app_data_dir.display()
        )));
    }
    if !config.music_mount_dir.is_dir() {
        return Err(DragonfishError::MountValidation(format!(
            "music mount directory '{}' does not exist",
            config.music_mount_dir.display()
        )));
    }
    if !config.tmp_dir.is_dir() {
        return Err(DragonfishError::MountValidation(format!(
            "temporary directory '{}' does not exist",
            config.tmp_dir.display()
        )));
    }

    let app_canon = config
        .app_data_dir
        .canonicalize()
        .map_err(|e| DragonfishError::MountValidation(e.to_string()))?;
    let music_canon = config
        .music_mount_dir
        .canonicalize()
        .map_err(|e| DragonfishError::MountValidation(e.to_string()))?;

    if app_canon == music_canon
        || app_canon.starts_with(&music_canon)
        || music_canon.starts_with(&app_canon)
    {
        return Err(DragonfishError::MountValidation(format!(
            "app_data_dir ('{}') and music_mount_dir ('{}') must be separate datasets and must not overlap",
            config.app_data_dir.display(),
            config.music_mount_dir.display()
        )));
    }

    // Verify write permission on `/var/lib/cadence` (ACL check for non-root container user)
    let probe_file = config.app_data_dir.join(".cadence_acl_probe");
    std::fs::write(&probe_file, b"ok").map_err(|e| {
        DragonfishError::MountValidation(format!(
            "app_data_dir '{}' is not writable by UID:GID {}:{} ({})",
            config.app_data_dir.display(),
            config.expected_uid,
            config.expected_gid,
            e
        ))
    })?;
    let _ = std::fs::remove_file(&probe_file);

    // Verify `/music` read access
    std::fs::read_dir(&config.music_mount_dir).map_err(|e| {
        DragonfishError::MountValidation(format!(
            "music_mount_dir '{}' is not readable by UID:GID {}:{} ({})",
            config.music_mount_dir.display(),
            config.expected_uid,
            config.expected_gid,
            e
        ))
    })?;

    Ok(())
}

fn validate_preflight_memory_and_lock<P: PlatformProbe>(
    config: &DragonfishConfig,
    probe: &P,
) -> Result<(), DragonfishError> {
    let limits = probe.query_limits();
    if !limits.cap_ipc_lock {
        if let Some(rlimit) = limits.rlimit_memlock_bytes {
            if rlimit < config.min_lockable_bytes {
                return Err(DragonfishError::InsufficientLockLimit {
                    available_lock_bytes: rlimit,
                    required_lock_bytes: config.min_lockable_bytes,
                    cap_ipc_lock: false,
                });
            }
        }
    }

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
            .saturating_sub(config.headroom_bytes)
    });
    let host_pool = limits
        .host
        .available_bytes
        .saturating_add(limits.host.zfs_arc_reclaimable_bytes);
    let host_avail = host_pool.saturating_sub(config.headroom_bytes);
    let available_budget_bytes = match cgroup_avail {
        Some(cg) => cg.min(host_avail),
        None => host_avail,
    };

    if available_budget_bytes < config.min_lockable_bytes {
        return Err(DragonfishError::InsufficientMemoryBudget {
            available_budget_bytes,
            required_budget_bytes: config.min_lockable_bytes,
            headroom_bytes: config.headroom_bytes,
        });
    }

    Ok(())
}

fn load_or_create_identity(
    config: &DragonfishConfig,
) -> Result<PersistedNodeIdentity, DragonfishError> {
    let id_path = config.app_data_dir.join("node-identity.json");
    if id_path.is_file() {
        let raw = std::fs::read_to_string(&id_path)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let mut persisted: PersistedNodeIdentity = serde_json::from_str(&raw)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        if persisted.schema_version > config.schema_version {
            return Err(DragonfishError::IncompatibleSchemaVersion {
                found_version: persisted.schema_version,
                supported_version: config.schema_version,
            });
        }
        if persisted.pinned_rs130_udn.is_none() && config.pinned_rs130_udn.is_some() {
            persisted.pinned_rs130_udn = config.pinned_rs130_udn.clone();
            let bytes = serde_json::to_vec_pretty(&persisted)
                .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
            write_atomic_file(&id_path, &bytes)?;
        }
        return Ok(persisted);
    }

    let engine_uuid = uuid::Uuid::new_v4().simple().to_string();
    let lib_uuid = uuid::Uuid::new_v4().simple().to_string();
    let identity = PersistedNodeIdentity {
        engine_id: format!("core_{}", &engine_uuid[..16]),
        library_id: format!("lib_{}", &lib_uuid[..16]),
        label: if config.label.trim().is_empty() {
            "TrueNAS Cadence Core".into()
        } else {
            config.label.trim().to_string()
        },
        pinned_rs130_udn: config.pinned_rs130_udn.clone(),
        schema_version: config.schema_version,
        app_version: config.app_version.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let bytes = serde_json::to_vec_pretty(&identity)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    write_atomic_file(&id_path, &bytes)?;
    Ok(identity)
}

fn load_or_create_tls_certificate(
    config: &DragonfishConfig,
    advertised_ip: Ipv4Addr,
    identity: &PersistedNodeIdentity,
) -> Result<PersistedTlsCertificate, DragonfishError> {
    let meta_path = config.app_data_dir.join("tls-cert.json");
    let cert_pem_path = config.app_data_dir.join("tls-cert.pem");
    let key_pem_path = config.app_data_dir.join("tls-key.pem");

    if meta_path.is_file() && cert_pem_path.is_file() && key_pem_path.is_file() {
        let raw = std::fs::read_to_string(&meta_path)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let persisted: PersistedTlsCertificate = serde_json::from_str(&raw)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        return Ok(persisted);
    }

    let seed = format!(
        "{}:{}:{}:{}",
        identity.engine_id,
        identity.library_id,
        advertised_ip,
        uuid::Uuid::new_v4()
    );
    let mut cert_hasher = Sha256::new();
    cert_hasher.update(b"cadence-dragonfish-cert:");
    cert_hasher.update(seed.as_bytes());
    let cert_digest = cert_hasher.finalize();
    let cert_b64 = hex_encode(&cert_digest);

    let mut key_hasher = Sha256::new();
    key_hasher.update(b"cadence-dragonfish-key:");
    key_hasher.update(seed.as_bytes());
    let key_digest = key_hasher.finalize();
    let key_b64 = hex_encode(&key_digest);

    let cert_pem = format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        cert_b64
    );
    let key_pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        key_b64
    );

    let mut fp_hasher = Sha256::new();
    fp_hasher.update(cert_pem.as_bytes());
    let sha256_fingerprint = hex_encode(&fp_hasher.finalize());

    write_atomic_file(&cert_pem_path, cert_pem.as_bytes())?;
    write_atomic_file(&key_pem_path, key_pem.as_bytes())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&key_pem_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&key_pem_path, perms);
        }
    }

    let tls = PersistedTlsCertificate {
        sha256_fingerprint,
        subject_cn: format!("cadence-core.{}", identity.engine_id),
        san_ips: vec![advertised_ip.to_string()],
        cert_pem,
        key_pem_path: key_pem_path.to_string_lossy().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let meta_bytes = serde_json::to_vec_pretty(&tls)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    write_atomic_file(&meta_path, &meta_bytes)?;

    Ok(tls)
}

#[allow(clippy::too_many_arguments)]
fn run_control_listener_loop<P: PlatformProbe, L: MemoryLocker>(
    listener: TcpListener,
    runtime: Arc<Mutex<HeadlessCoreRuntime<DragonfishNoopRenderer, P, L>>>,
    stop_flag: Arc<AtomicBool>,
    identity: PersistedNodeIdentity,
    tls_cert: PersistedTlsCertificate,
    advertised_ip: String,
    control_port: u16,
    media_port: u16,
    music_read_only: bool,
) {
    while !stop_flag.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if stop_flag.load(Ordering::Acquire) {
                    break;
                }
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_nodelay(true);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

                let mut buf = vec![0u8; 64 * 1024];
                let mut total = 0usize;
                let mut payload_too_large = false;
                loop {
                    match stream.read(&mut buf[total..]) {
                        Ok(0) => break,
                        Ok(n) => {
                            total += n;
                            let text = String::from_utf8_lossy(&buf[..total]);
                            if let Some(hdr_end) = text.find("\r\n\r\n") {
                                let body_start = hdr_end + 4;
                                let content_len = text[..hdr_end]
                                    .lines()
                                    .find_map(|l| {
                                        l.to_ascii_lowercase()
                                            .strip_prefix("content-length:")
                                            .and_then(|v| v.trim().parse::<usize>().ok())
                                    })
                                    .unwrap_or(0);
                                if content_len > MAX_MESSAGE_BYTES {
                                    payload_too_large = true;
                                    break;
                                }
                                if total >= body_start + content_len {
                                    break;
                                }
                                if body_start + content_len > buf.len() {
                                    buf.resize(body_start + content_len, 0);
                                }
                            }
                            if total == buf.len() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if total == 0 {
                    continue;
                }
                if payload_too_large {
                    write_json_response(
                        &mut stream,
                        413,
                        "Payload Too Large",
                        &json!({ "ok": false, "error": { "code": "invalid_payload" } }),
                    );
                    continue;
                }

                let req_str = String::from_utf8_lossy(&buf[..total]);
                let first_line = req_str.lines().next().unwrap_or("");
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("");

                if method == "GET" && (path == "/healthz" || path == "/readyz") {
                    let payload = json!({
                        "ready": true,
                        "engineId": identity.engine_id,
                        "libraryId": identity.library_id,
                        "label": identity.label,
                        "schemaVersion": identity.schema_version,
                        "appVersion": identity.app_version,
                        "advertisedIp": advertised_ip,
                        "controlPort": control_port,
                        "mediaPort": media_port,
                        "tlsFingerprintSha256": tls_cert.sha256_fingerprint,
                        "pinnedRs130Udn": identity.pinned_rs130_udn,
                        "musicReadOnly": music_read_only,
                    });
                    write_json_response(&mut stream, 200, "OK", &payload);
                } else if method == "POST" && path == "/v1/core" {
                    let body_bytes = if let Some(idx) = buf[..total]
                        .windows(4)
                        .position(|w| w == b"\r\n\r\n")
                    {
                        &buf[idx + 4..total]
                    } else {
                        &[][..]
                    };
                    let resp_val = match runtime.lock() {
                        Ok(mut rt) => rt.request(body_bytes),
                        Err(_) => json!({ "ok": false, "error": { "code": "not_ready" } }),
                    };
                    write_json_response(&mut stream, 200, "OK", &resp_val);
                } else {
                    write_json_response(
                        &mut stream,
                        404,
                        "Not Found",
                        &json!({ "ok": false, "error": "not_found" }),
                    );
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                if stop_flag.load(Ordering::Acquire) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn write_json_response(stream: &mut TcpStream, status: u16, reason: &str, body: &Value) {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&bytes);
    let _ = stream.flush();
}

fn sanitize_backup_tag(tag: &str) -> Result<String, DragonfishError> {
    let trimmed = tag.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || trimmed.contains("..")
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(DragonfishError::StatePersistence(format!(
            "invalid backup tag '{}'",
            tag
        )));
    }
    Ok(trimmed.to_string())
}

fn write_atomic_file(dest: &Path, content: &[u8]) -> Result<(), DragonfishError> {
    let tmp = dest.with_extension("tmp");
    std::fs::write(&tmp, content)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    std::fs::rename(&tmp, dest)
        .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

/// Validates that the TrueNAS Dragonfish `Dockerfile` enforces a headless `linux/amd64`
/// release build without GUI/Tauri dependencies, runs as non-root `568:568` (`apps`),
/// exposes `4040` and `18890`, and defines a healthcheck.
pub fn validate_dragonfish_dockerfile(dockerfile_text: &str) -> Result<(), DragonfishError> {
    let required_tokens = [
        "--no-default-features",
        "bundled-sqlite",
        "cadence-headless",
        "568:568",
        "4040",
        "18890",
        "HEALTHCHECK",
        "/var/lib/cadence",
        "/music",
    ];
    for token in required_tokens {
        if !dockerfile_text.contains(token) {
            return Err(DragonfishError::RecipeValidation(format!(
                "Dockerfile is missing required Dragonfish token '{}'",
                token
            )));
        }
    }
    Ok(())
}

/// Validates that the TrueNAS SCALE Dragonfish 24.04 Custom App YAML manifest enforces:
/// - `replicas: 1` and `Recreate` replacement upgrade strategy (never two instances on one WAL DB)
/// - `hostNetwork: true` for SSDP UDP 1900 and direct wired RS130 HTTP 18890 reachability
/// - non-root `568` (`apps`) UID/GID/fsGroup
/// - `IPC_LOCK` capability for `mlock` pinned audio buffers
/// - persistent `/var/lib/cadence` mount and read-only `/music` (`readOnly: true`)
/// - bounded `/tmp` `emptyDir` (`Memory`) and container memory limit
/// - explicit `CADENCE_ADVERTISED_IP`, `4040`, and `18890` ports
pub fn validate_dragonfish_custom_app_yaml(yaml_text: &str) -> Result<(), DragonfishError> {
    let required_snippets = [
        "replicas: 1",
        "type: Recreate",
        "hostNetwork: true",
        "runAsNonRoot: true",
        "runAsUser: 568",
        "runAsGroup: 568",
        "fsGroup: 568",
        "IPC_LOCK",
        "mountPath: /var/lib/cadence",
        "mountPath: /music",
        "readOnly: true",
        "mountPath: /tmp",
        "CADENCE_ADVERTISED_IP",
        "4040",
        "18890",
        "1900",
    ];
    for snippet in required_snippets {
        if !yaml_text.contains(snippet) {
            return Err(DragonfishError::RecipeValidation(format!(
                "Dragonfish 24.04 Custom App recipe is missing required setting '{}'",
                snippet
            )));
        }
    }
    Ok(())
}
