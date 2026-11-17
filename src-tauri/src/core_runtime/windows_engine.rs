//! Phase 3: Standalone Windows Playback Engine (`cadence-engine`).
//! Hosts `HeadlessCoreRuntime` with `AudioEngine` (`WASAPI Exclusive`, `ASIO`, `UPnP`)
//! in a Tauri-free process with HTTPS/TLS, mDNS `_cadence-core._tcp.local.` discovery,
//! localhost pairing metadata, and Windows drive/UNC `fs.browse` roots.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::audio::{AudioEndpoint, AudioEndpointInfo, AudioEngine, EndpointTransport, PlaybackStatus};
use crate::core_runtime::dragonfish::{
    load_or_create_identity, load_or_create_tls_certificate, load_pairing_token, parse_tls,
    run_control_listener_loop, DragonfishConfig, DragonfishError, ExtraV1OpHandler,
    PersistedNodeIdentity, PersistedTlsCertificate, DEFAULT_CONTROL_PORT, DEFAULT_MEDIA_PORT,
    DRAGONFISH_SCHEMA_VERSION,
};
use crate::core_runtime::library::windows_default_browse_roots;
use crate::core_runtime::migration::{
    export_consistent_snapshot, import_snapshot_into_core, SnapshotImportOptions,
    SnapshotImportResult,
};
use crate::core_runtime::{
    HeadlessConfig, HeadlessCoreRuntime, DEFAULT_CONTAINER_HEADROOM_BYTES,
};
use crate::core_session::{Output, Renderer, RendererAction, RendererError, RendererEvent, RunToken};

#[derive(Clone, Debug)]
pub struct WindowsEngineConfig {
    pub app_data_dir: PathBuf,
    pub control_bind_addr: SocketAddr,
    pub advertised_ip: String,
    pub label: String,
    pub headroom_bytes: u64,
    pub allow_loopback_for_tests: bool,
    pub enable_mdns: bool,
}

impl Default for WindowsEngineConfig {
    fn default() -> Self {
        let app_data_dir = default_windows_engine_data_dir();
        let host_label = std::env::var("COMPUTERNAME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "This PC".to_string());
        Self {
            app_data_dir,
            control_bind_addr: SocketAddr::from(([0, 0, 0, 0], DEFAULT_CONTROL_PORT)),
            advertised_ip: detect_lan_ipv4().unwrap_or_else(|| "127.0.0.1".to_string()),
            label: format!("{host_label} (Windows Engine)"),
            headroom_bytes: DEFAULT_CONTAINER_HEADROOM_BYTES,
            allow_loopback_for_tests: false,
            enable_mdns: true,
        }
    }
}

pub fn default_windows_engine_data_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("CADENCE_DATA_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        if !local_app_data.trim().is_empty() {
            return PathBuf::from(local_app_data).join("CadenceEngine");
        }
    }
    PathBuf::from(".cadence-engine")
}

pub fn detect_legacy_desktop_db() -> Option<PathBuf> {
    let app_data = std::env::var("APPDATA").ok()?;
    let base = PathBuf::from(app_data);
    for candidate in [
        base.join("com.cadence.core").join("cadence.db"),
        base.join("com.cadence.app").join("cadence.db"),
        base.join("Cadence").join("cadence.db"),
        base.join("cadence.db"),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalhostPairingInfo {
    pub base_url: String,
    pub token: String,
    pub tls_fingerprint_sha256: String,
    pub engine_id: String,
    pub library_id: String,
    pub label: String,
}

fn to_core_output(info: &AudioEndpointInfo) -> Output {
    let sanitized_id: String = info
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    let id = if sanitized_id.is_empty() {
        "system-default".to_string()
    } else {
        sanitized_id
    };
    let transport = match info.transport {
        EndpointTransport::Upnp => "upnp",
        EndpointTransport::Wasapi => "wasapi",
        EndpointTransport::SystemDefault => "system_default",
    }
    .to_string();
    Output {
        id,
        label: info.display_name.clone(),
        transport,
    }
}

fn detect_lan_ipv4() -> Option<String> {
    match local_ip_address::local_ip() {
        Ok(IpAddr::V4(v4)) if !v4.is_loopback() && !v4.is_link_local() => Some(v4.to_string()),
        _ => None,
    }
}

fn load_track_paths(db_path: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(conn) = Connection::open(db_path) else {
        return map;
    };
    let Ok(mut stmt) = conn.prepare("SELECT id, file_path FROM tracks") else {
        return map;
    };
    if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
    }
    map
}

#[derive(Clone, Debug)]
pub(crate) struct ActiveRunState {
    token: Option<RunToken>,
    saw_active: bool,
}

pub struct WindowsEngineRenderer {
    audio: Arc<AudioEngine>,
    db_path: PathBuf,
    track_paths: HashMap<String, String>,
    run_state: Arc<Mutex<ActiveRunState>>,
}

impl WindowsEngineRenderer {
    pub(crate) fn new(audio: Arc<AudioEngine>, db_path: PathBuf, run_state: Arc<Mutex<ActiveRunState>>) -> Self {
        let track_paths = load_track_paths(&db_path);
        Self {
            audio,
            db_path,
            track_paths,
            run_state,
        }
    }

    fn resolve_track_path(&mut self, track_id: &str) -> Option<String> {
        if let Some(p) = self.track_paths.get(track_id) {
            return Some(p.clone());
        }
        self.track_paths = load_track_paths(&self.db_path);
        self.track_paths.get(track_id).cloned()
    }
}

impl Renderer for WindowsEngineRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        match action {
            RendererAction::Play { entry, token } => {
                let Some(path) = self.resolve_track_path(&entry.track_id) else {
                    return Err(RendererError);
                };
                if self.audio.play_track(&path).is_err() {
                    return Err(RendererError);
                }
                if let Ok(mut guard) = self.run_state.lock() {
                    guard.token = Some(token.clone());
                    guard.saw_active = false;
                }
                Ok(())
            }
            RendererAction::Pause => self.audio.pause().map_err(|_| RendererError),
            RendererAction::Resume { token } => {
                self.audio.resume().map_err(|_| RendererError)?;
                if let Ok(mut guard) = self.run_state.lock() {
                    guard.token = Some(token.clone());
                }
                Ok(())
            }
            RendererAction::Seek { position_seconds, token } => {
                self.audio.seek(*position_seconds).map_err(|_| RendererError)?;
                if let Ok(mut guard) = self.run_state.lock() {
                    guard.token = Some(token.clone());
                }
                Ok(())
            }
            RendererAction::Stop => {
                let _ = self.audio.stop();
                if let Ok(mut guard) = self.run_state.lock() {
                    guard.token = None;
                    guard.saw_active = false;
                }
                Ok(())
            }
        }
    }
}

pub struct WindowsEngineNode {
    pub identity: PersistedNodeIdentity,
    pub tls_cert: PersistedTlsCertificate,
    pub pairing_token: String,
    pub control_listen_addr: SocketAddr,
    audio: Arc<AudioEngine>,
    stop_flag: Arc<AtomicBool>,
    control_join: Option<std::thread::JoinHandle<()>>,
    reconcile_join: Option<std::thread::JoinHandle<()>>,
    mdns_daemon: Option<mdns_sd::ServiceDaemon>,
}

impl WindowsEngineNode {
    pub fn bootstrap(config: WindowsEngineConfig) -> Result<Self, DragonfishError> {
        std::fs::create_dir_all(&config.app_data_dir)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let adv_ipv4 = config
            .advertised_ip
            .parse::<Ipv4Addr>()
            .unwrap_or(Ipv4Addr::LOCALHOST);
        let df_cfg = DragonfishConfig {
            app_data_dir: config.app_data_dir.clone(),
            label: config.label.clone(),
            advertised_ip: adv_ipv4.to_string(),
            schema_version: DRAGONFISH_SCHEMA_VERSION,
            app_version,
            ..DragonfishConfig::default()
        };
        let identity = load_or_create_identity(&df_cfg)?;
        let tls_cert = load_or_create_tls_certificate(&df_cfg, adv_ipv4, &identity)?;
        let pairing_token = load_pairing_token(&config.app_data_dir)?;
        let tls_config = parse_tls(&tls_cert.cert_pem, Path::new(&tls_cert.key_pem_path))?;

        let control_listener = TcpListener::bind(config.control_bind_addr)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        control_listener
            .set_nonblocking(true)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let control_listen_addr = control_listener
            .local_addr()
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        let pairing_info = LocalhostPairingInfo {
            base_url: format!("https://127.0.0.1:{}", control_listen_addr.port()),
            token: pairing_token.clone(),
            tls_fingerprint_sha256: tls_cert.sha256_fingerprint.clone(),
            engine_id: identity.engine_id.clone(),
            library_id: identity.library_id.clone(),
            label: identity.label.clone(),
        };
        let pairing_json = serde_json::to_string_pretty(&pairing_info)
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;
        let _ = std::fs::write(
            config.app_data_dir.join("localhost-pairing.json"),
            pairing_json,
        );

        let audio = Arc::new(AudioEngine::new());
        let endpoints = audio.list_audio_endpoints();
        let initial_output = endpoints
            .first()
            .map(to_core_output)
            .unwrap_or_else(|| Output {
                id: "system-default".into(),
                label: "System Default Output".into(),
                transport: "system_default".into(),
            });

        let db_path = config.app_data_dir.join("cadence.db");
        let run_state = Arc::new(Mutex::new(ActiveRunState {
            token: None,
            saw_active: false,
        }));
        let renderer = WindowsEngineRenderer::new(
            Arc::clone(&audio),
            db_path.clone(),
            Arc::clone(&run_state),
        );

        let headless_cfg = HeadlessConfig {
            db_path,
            engine_id: identity.engine_id.clone(),
            library_id: identity.library_id.clone(),
            label: identity.label.clone(),
            output: Some(initial_output),
            headroom_bytes: config.headroom_bytes,
        };
        let mut rt = HeadlessCoreRuntime::open(headless_cfg, renderer)
            .map_err(DragonfishError::Runtime)?;
        rt.set_music_read_only(false);

        let browse_roots = if let Some(v) = std::env::var_os("CADENCE_BROWSE_ROOTS") {
            std::env::split_paths(&v).collect::<Vec<_>>()
        } else if let Some(db) = rt.db() {
            windows_default_browse_roots(db)
        } else {
            Vec::new()
        };
        rt.configure_library(browse_roots)
            .map_err(DragonfishError::Runtime)?;

        let runtime = Arc::new(Mutex::new(rt));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let shared_buffers = Arc::new(Mutex::new(HashMap::new()));

        let audio_for_ops = Arc::clone(&audio);
        let expected_engine_id = identity.engine_id.clone();
        let expected_library_id = identity.library_id.clone();
        let extra_op_handler: ExtraV1OpHandler<_, _, _> = Arc::new(move |req, rt| {
            let op = req.get("operation").and_then(Value::as_str)?;
            let req_engine = req.get("engineId").and_then(Value::as_str);
            let req_lib = req.get("libraryId").and_then(Value::as_str);
            if matches!(op, "outputs.list" | "output.select" | "player.volume" | "player.purity")
                && (req_engine != Some(expected_engine_id.as_str())
                    || req_lib != Some(expected_library_id.as_str()))
            {
                return Some(json!({"ok": false, "error": {"code": "identity_mismatch"}}));
            }
            match op {
                "outputs.list" => {
                    let list = audio_for_ops.list_audio_endpoints();
                    Some(json!({ "ok": true, "data": { "outputs": list } }))
                }
                "output.select" => {
                    let target_id = req
                        .get("outputId")
                        .or_else(|| req.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let list = audio_for_ops.list_audio_endpoints();
                    let upnp_devices = audio_for_ops.get_upnp_manager().get_devices();
                    let chosen = list.iter().find(|e| e.id == target_id).cloned();
                    let endpoint = AudioEndpoint::from_legacy_string(target_id, &upnp_devices);
                    match audio_for_ops.set_audio_endpoint(endpoint) {
                        Ok(()) => {
                            let out = chosen
                                .as_ref()
                                .map(to_core_output)
                                .unwrap_or_else(|| Output {
                                    id: "selected-output".to_string(),
                                    label: target_id.to_string(),
                                    transport: "wasapi".into(),
                                });
                            rt.set_output(out.clone());
                            Some(json!({ "ok": true, "data": { "output": out } }))
                        }
                        Err(e) => Some(
                            json!({ "ok": false, "error": { "code": "invalid_payload", "message": e } }),
                        ),
                    }
                }
                "player.volume" => {
                    let vol = req.get("volume").and_then(Value::as_f64).unwrap_or(1.0) as f32;
                    match audio_for_ops.set_volume(vol) {
                        Ok(()) => Some(json!({ "ok": true, "data": { "volume": vol } })),
                        Err(e) => Some(
                            json!({ "ok": false, "error": { "code": "invalid_payload", "message": e } }),
                        ),
                    }
                }
                "player.purity" => {
                    let enabled = req.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                    match audio_for_ops.set_purity_mode(enabled) {
                        Ok(actual) => Some(json!({ "ok": true, "data": { "purityMode": actual } })),
                        Err(e) => Some(
                            json!({ "ok": false, "error": { "code": "invalid_payload", "message": e } }),
                        ),
                    }
                }
                _ => None,
            }
        });

        let rt_ctrl = Arc::clone(&runtime);
        let stop_ctrl = Arc::clone(&stop_flag);
        let id_copy = identity.clone();
        let cert_copy = tls_cert.clone();
        let adv_ip = config.advertised_ip.clone();
        let token_copy = pairing_token.clone();
        let allow_plaintext_tests = config.allow_loopback_for_tests;

        let control_join = std::thread::Builder::new()
            .name("cadence-win-engine-control".into())
            .spawn(move || {
                run_control_listener_loop(
                    control_listener,
                    rt_ctrl,
                    shared_buffers,
                    stop_ctrl,
                    id_copy,
                    cert_copy,
                    adv_ip,
                    control_listen_addr.port(),
                    DEFAULT_MEDIA_PORT,
                    false,
                    token_copy,
                    tls_config,
                    allow_plaintext_tests,
                    false,
                    Some(extra_op_handler),
                );
            })
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        let rt_rec = Arc::clone(&runtime);
        let stop_rec = Arc::clone(&stop_flag);
        let audio_rec = Arc::clone(&audio);
        let run_rec = Arc::clone(&run_state);
        let reconcile_join = std::thread::Builder::new()
            .name("cadence-win-engine-reconcile".into())
            .spawn(move || {
                run_windows_reconcile_loop(rt_rec, stop_rec, audio_rec, run_rec);
            })
            .map_err(|e| DragonfishError::StatePersistence(e.to_string()))?;

        let mdns_daemon = if config.enable_mdns && !config.allow_loopback_for_tests {
            register_engine_mdns(
                &identity,
                &config.advertised_ip,
                control_listen_addr.port(),
                &tls_cert.sha256_fingerprint,
            )
        } else {
            None
        };

        Ok(Self {
            identity,
            tls_cert,
            pairing_token,
            control_listen_addr,
            audio,
            stop_flag,
            control_join: Some(control_join),
            reconcile_join: Some(reconcile_join),
            mdns_daemon,
        })
    }

    pub fn status(&self) -> PlaybackStatus {
        self.audio.get_status()
    }

    pub fn shutdown(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        let _ = self.audio.stop();
        if let Some(daemon) = self.mdns_daemon.take() {
            let _ = daemon.shutdown();
        }
        if let Some(j) = self.control_join.take() {
            let _ = j.join();
        }
        if let Some(j) = self.reconcile_join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for WindowsEngineNode {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_windows_reconcile_loop<P, L>(
    runtime: Arc<Mutex<HeadlessCoreRuntime<WindowsEngineRenderer, P, L>>>,
    stop_flag: Arc<AtomicBool>,
    audio: Arc<AudioEngine>,
    run_state: Arc<Mutex<ActiveRunState>>,
) where
    P: crate::core_runtime::PlatformProbe,
    L: crate::core_runtime::MemoryLocker,
{
    while !stop_flag.load(Ordering::Acquire) {
        let status = audio.get_status();
        let is_loading = audio.is_loading();
        let active = status.is_playing || status.is_paused || is_loading;

        let mut completed_token: Option<RunToken> = None;
        let mut started_token: Option<RunToken> = None;
        let mut current_token: Option<RunToken> = None;
        if let Ok(mut guard) = run_state.lock() {
            if let Some(tok) = guard.token.clone() {
                current_token = Some(tok.clone());
                if status.is_playing && !guard.saw_active {
                    guard.saw_active = true;
                    started_token = Some(tok);
                } else if !active && guard.saw_active {
                    guard.saw_active = false;
                    guard.token = None;
                    current_token = None;
                    completed_token = Some(tok);
                }
            }
        }

        if let Ok(mut rt) = runtime.lock() {
            if let Some(tok) = started_token {
                let _ = rt.on_renderer_event(RendererEvent::Started(tok));
            }
            if let Some(ref tok) = current_token {
                if status.is_playing || status.is_paused {
                    let transport_state = if status.is_playing {
                        "PLAYING"
                    } else {
                        "PAUSED_PLAYBACK"
                    };
                    let _ = rt.sync_active_playback(tok, transport_state, Some(status.position_secs));
                }
            }
            if let Some(tok) = completed_token {
                let _ = rt.on_renderer_event(RendererEvent::Completed(tok));
            }
        }

        std::thread::sleep(Duration::from_millis(if active { 250 } else { 750 }));
    }
}

fn register_engine_mdns(
    identity: &PersistedNodeIdentity,
    advertised_ip: &str,
    port: u16,
    tls_fingerprint: &str,
) -> Option<mdns_sd::ServiceDaemon> {
    let daemon = mdns_sd::ServiceDaemon::new().ok()?;
    let ip_addr: IpAddr = advertised_ip
        .parse::<Ipv4Addr>()
        .map(IpAddr::V4)
        .ok()?;
    let host_name = format!(
        "{}.local.",
        identity
            .engine_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(32)
            .collect::<String>()
    );
    let props = [
        ("role", "core"),
        ("engineId", identity.engine_id.as_str()),
        ("libraryId", identity.library_id.as_str()),
        ("label", identity.label.as_str()),
        ("protocol", "https"),
        ("fp", tls_fingerprint),
    ];
    let info = mdns_sd::ServiceInfo::new(
        "_cadence-core._tcp.local.",
        &identity.engine_id,
        &host_name,
        ip_addr,
        port,
        &props[..],
    )
    .ok()?;
    if daemon.register(info).is_ok() {
        Some(daemon)
    } else {
        let _ = daemon.shutdown();
        None
    }
}

/// One-time migration from a legacy Desktop `%APPDATA%/cadence.db` into the
/// Windows Playback Engine `cadence.db`.
pub fn migrate_legacy_desktop_db(
    legacy_db_path: &Path,
    engine_data_dir: &Path,
) -> Result<SnapshotImportResult, String> {
    if !legacy_db_path.is_file() {
        return Err(format!(
            "Legacy database not found at {}",
            legacy_db_path.display()
        ));
    }
    std::fs::create_dir_all(engine_data_dir).map_err(|e| e.to_string())?;
    let snapshot_path = engine_data_dir.join("legacy-import-snapshot.db");
    let rollback_dir = engine_data_dir.join("rollback");
    let target_db = engine_data_dir.join("cadence.db");

    export_consistent_snapshot(legacy_db_path, &snapshot_path).map_err(|e| format!("{e:?}"))?;
    let res = import_snapshot_into_core(
        &snapshot_path,
        &target_db,
        &rollback_dir,
        SnapshotImportOptions {
            mappings: Vec::new(),
            enforce_case_sensitive: false,
            include_unmapped: true,
            rollback_tag: format!("pre-legacy-migration-{}", chrono::Utc::now().timestamp()),
        },
    )
    .map_err(|e| format!("{e:?}"));
    let _ = std::fs::remove_file(&snapshot_path);
    if let Ok(ref _imported) = res {
        copy_watched_folders_from_legacy(legacy_db_path, &target_db)?;
        copy_cached_artwork_from_legacy(legacy_db_path, &target_db)?;
    }
    res
}

fn copy_cached_artwork_from_legacy(legacy_db_path: &Path, target_db: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let src = Connection::open(legacy_db_path).map_err(|e| e.to_string())?;
    let dst = Connection::open(target_db).map_err(|e| e.to_string())?;
    let Ok(mut stmt) = src.prepare(
        "SELECT id, cache_path FROM artwork_cache_state WHERE entity_type='release' AND status='cached' AND cache_path IS NOT NULL",
    ) else {
        return Ok(());
    };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows.flatten() {
        let (release_id, cache_path) = row;
        if let Ok(bytes) = std::fs::read(&cache_path) {
            if !bytes.is_empty() {
                let hash = format!("{:x}", Sha256::digest(&bytes));
                let etag = format!("art_{}", &hash[..16]);
                let _ = dst.execute(
                    "INSERT INTO engine_artwork(release_id, etag, jpeg) VALUES(?1, ?2, ?3) ON CONFLICT(release_id) DO UPDATE SET etag=excluded.etag, jpeg=excluded.jpeg",
                    rusqlite::params![release_id, etag, bytes],
                );
            }
        }
    }
    Ok(())
}

fn copy_watched_folders_from_legacy(legacy_db_path: &Path, target_db: &Path) -> Result<(), String> {
    let src = Connection::open(legacy_db_path).map_err(|e| e.to_string())?;
    let dst = Connection::open(target_db).map_err(|e| e.to_string())?;
    let mut stmt = src
        .prepare("SELECT id, mount_id, folder_path, display_name, scan_mode, last_scanned_timestamp FROM watched_folders")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows.flatten() {
        let (id, mount_id, folder_path, display_name, scan_mode, last_scanned) = row;
        let _ = dst.execute(
            "INSERT OR IGNORE INTO storage_mounts(id, name, mount_path, mount_type, file_system, last_seen_timestamp) VALUES(?1, ?2, ?3, 'local_disk', 'native', CURRENT_TIMESTAMP)",
            rusqlite::params![mount_id, display_name, folder_path],
        );
        let _ = dst.execute(
            "INSERT OR IGNORE INTO watched_folders(id, mount_id, folder_path, display_name, scan_mode, last_scanned_timestamp) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, mount_id, folder_path, display_name, scan_mode, last_scanned],
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cadence-win-engine-{}-{}",
            prefix,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn http_request(addr: SocketAddr, req: &str) -> String {
        let mut stream = TcpStream::connect(addr).expect("connect loopback");
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        stream.write_all(req.as_bytes()).expect("write request");
        stream.flush().ok();
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out);
        out
    }

    #[test]
    fn windows_engine_bootstraps_and_serves_healthz_outputs_and_fs_browse() {
        let data_dir = temp_dir("bootstrap");
        let cfg = WindowsEngineConfig {
            app_data_dir: data_dir.clone(),
            control_bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            advertised_ip: "127.0.0.1".into(),
            label: "Test Windows Engine".into(),
            headroom_bytes: DEFAULT_CONTAINER_HEADROOM_BYTES,
            allow_loopback_for_tests: true,
            enable_mdns: false,
        };
        let mut node = WindowsEngineNode::bootstrap(cfg).expect("bootstrap windows engine");

        let pairing_raw = std::fs::read_to_string(data_dir.join("localhost-pairing.json"))
            .expect("localhost-pairing.json written");
        let pairing: LocalhostPairingInfo =
            serde_json::from_str(&pairing_raw).expect("valid localhost-pairing.json");
        assert_eq!(pairing.engine_id, node.identity.engine_id);
        assert_eq!(pairing.token, node.pairing_token);

        let health_resp = http_request(
            node.control_listen_addr,
            "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert!(health_resp.contains("200 OK"), "healthz: {health_resp}");
        assert!(health_resp.contains("\"ready\":true"));

        let outputs_body = serde_json::to_string(&json!({
            "protocolVersion": 2,
            "engineId": node.identity.engine_id,
            "libraryId": node.identity.library_id,
            "operation": "outputs.list",
        }))
        .unwrap();
        let outputs_req = format!(
            "POST /v1/core HTTP/1.1\r\nHost: 127.0.0.1\r\nx-cadence-token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            node.pairing_token,
            outputs_body.len(),
            outputs_body
        );
        let outputs_resp = http_request(node.control_listen_addr, &outputs_req);
        assert!(outputs_resp.contains("\"ok\":true"), "outputs: {outputs_resp}");

        let browse_body = serde_json::to_string(&json!({
            "protocolVersion": 2,
            "engineId": node.identity.engine_id,
            "libraryId": node.identity.library_id,
            "operation": "fs.browse",
        }))
        .unwrap();
        let browse_req = format!(
            "POST /v1/core HTTP/1.1\r\nHost: 127.0.0.1\r\nx-cadence-token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            node.pairing_token,
            browse_body.len(),
            browse_body
        );
        let browse_resp = http_request(node.control_listen_addr, &browse_req);
        assert!(browse_resp.contains("\"ok\":true"), "browse: {browse_resp}");
        assert!(browse_resp.contains("\"entries\":"), "browse: {browse_resp}");

        node.shutdown();
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn migrate_legacy_desktop_db_imports_playlists_and_tracks() {
        let root = temp_dir("migrate");
        let legacy_db_path = root.join("legacy.db");
        let engine_dir = root.join("engine-data");
        {
            let db = crate::db::AppDb::new(legacy_db_path.clone()).expect("open legacy db");
            let conn = db.conn.lock();
            conn.execute(
                "INSERT INTO storage_mounts(id, name, mount_path, mount_type, file_system, last_seen_timestamp) VALUES ('m1', 'Music', 'E:\\\\Music', 'local_disk', 'ntfs', CURRENT_TIMESTAMP)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO watched_folders(id, mount_id, folder_path, display_name, scan_mode) VALUES ('wf1', 'm1', 'E:\\\\Music', 'Music', 'manual')",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO releases(id, title, folder_path, folder_name, artist_credit, created_at) VALUES ('r1', 'Album', 'E:\\\\Music\\\\Album', 'Album', 'Artist', CURRENT_TIMESTAMP)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO tracks(id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, sample_rate, bit_depth, channels, created_at) VALUES ('t1', 'r1', 'm1', 'E:\\\\Music\\\\Album', 'Album', 'E:\\\\Music\\\\Album\\\\01.flac', '01.flac', 1000, 1, 'Track One', 'Artist', 'Album', 180.0, 'FLAC', 44100, 16, 2, CURRENT_TIMESTAMP)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO playlists(id, title, created_at, updated_at) VALUES ('p1', 'Favorites', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES ('p1', 't1', 0, CURRENT_TIMESTAMP)",
                [],
            ).unwrap();
        }

        let res = migrate_legacy_desktop_db(&legacy_db_path, &engine_dir).expect("migrate legacy db");
        assert_eq!(res.imported_tracks, 1);
        assert_eq!(res.imported_playlists, 1);
        assert!(engine_dir.join("cadence.db").is_file());
        let migrated_conn = Connection::open(engine_dir.join("cadence.db")).unwrap();
        let wf_count: i64 = migrated_conn
            .query_row("SELECT count(*) FROM watched_folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(wf_count, 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
