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
    HeadlessConfig, HeadlessCoreRuntime, SharedTrackBuffers, DEFAULT_CONTAINER_HEADROOM_BYTES,
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

pub const WINDOWS_SERVICE_NAME: &str = "CadencePlaybackEngine";

pub fn default_windows_engine_data_dir() -> PathBuf {
    let fallback = if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        if !local_app_data.trim().is_empty() {
            PathBuf::from(local_app_data).join("CadenceEngine")
        } else {
            PathBuf::from(".cadence-engine")
        }
    } else {
        PathBuf::from(".cadence-engine")
    };
    crate::core_runtime::dragonfish::resolve_env_data_dir(fallback)
}

#[cfg(windows)]
pub fn default_windows_service_data_dir() -> PathBuf {
    if let Ok(program_data) = std::env::var("ProgramData") {
        let trimmed = program_data.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("CadenceEngine");
        }
    }
    PathBuf::from(r"C:\ProgramData\CadenceEngine")
}

#[cfg(not(windows))]
pub fn default_windows_service_data_dir() -> PathBuf {
    PathBuf::from("/var/lib/cadence")
}

#[cfg(windows)]
pub fn is_windows_service_running() -> bool {
    use windows_sys::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_HANDLE,
        SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START_PENDING,
        SERVICE_STATUS, SERVICE_STOP_PENDING,
    };

    struct ScmHandle(SC_HANDLE);
    impl Drop for ScmHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseServiceHandle(self.0);
                }
            }
        }
    }

    let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if scm_raw.is_null() {
        return false;
    }
    let scm = ScmHandle(scm_raw);
    let svc_name: Vec<u16> = WINDOWS_SERVICE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let svc_raw = unsafe { OpenServiceW(scm.0, svc_name.as_ptr(), SERVICE_QUERY_STATUS) };
    if svc_raw.is_null() {
        return false;
    }
    let svc = ScmHandle(svc_raw);
    let mut st: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { QueryServiceStatus(svc.0, &mut st) } == 0 {
        return false;
    }
    matches!(
        st.dwCurrentState,
        SERVICE_RUNNING | SERVICE_START_PENDING | SERVICE_STOP_PENDING
    )
}

#[cfg(not(windows))]
pub fn is_windows_service_running() -> bool {
    false
}

pub(crate) fn parse_data_dir_from_service_cmd(cmd: &str) -> Option<PathBuf> {
    let mut tokens: Vec<String> = Vec::new();
    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let mut token = String::new();
        let mut in_quotes = false;
        while i < chars.len() {
            let ch = chars[i];
            if !in_quotes && ch.is_whitespace() {
                break;
            }
            if ch == '\\' {
                let mut slashes = 0;
                while i + slashes < chars.len() && chars[i + slashes] == '\\' {
                    slashes += 1;
                }
                if i + slashes < chars.len() && chars[i + slashes] == '"' {
                    for _ in 0..(slashes / 2) {
                        token.push('\\');
                    }
                    if slashes % 2 == 1 {
                        token.push('"');
                        i += slashes + 1;
                    } else {
                        in_quotes = !in_quotes;
                        i += slashes + 1;
                    }
                } else {
                    for _ in 0..slashes {
                        token.push('\\');
                    }
                    i += slashes;
                }
            } else if ch == '"' {
                in_quotes = !in_quotes;
                i += 1;
            } else {
                token.push(ch);
                i += 1;
            }
        }
        tokens.push(token);
    }

    for pair in tokens.windows(2) {
        if matches!(pair[0].as_str(), "--data-dir" | "--app-data-dir") {
            let trimmed = pair[1].trim();
            if !trimmed.is_empty() {
                return Some(PathBuf::from(trimmed));
            }
        }
    }
    None
}

#[cfg(windows)]
pub fn installed_windows_service_data_dir() -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceConfigW,
        QUERY_SERVICE_CONFIGW, SC_HANDLE, SC_MANAGER_CONNECT, SERVICE_QUERY_CONFIG,
    };

    struct ScmHandle(SC_HANDLE);
    impl Drop for ScmHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseServiceHandle(self.0);
                }
            }
        }
    }

    let scm_raw = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if scm_raw.is_null() {
        return None;
    }
    let scm = ScmHandle(scm_raw);
    let svc_name: Vec<u16> = WINDOWS_SERVICE_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let svc_raw = unsafe { OpenServiceW(scm.0, svc_name.as_ptr(), SERVICE_QUERY_CONFIG) };
    if svc_raw.is_null() {
        return None;
    }
    let svc = ScmHandle(svc_raw);

    let mut needed: u32 = 0;
    let first_ok = unsafe { QueryServiceConfigW(svc.0, std::ptr::null_mut(), 0, &mut needed) };
    if first_ok != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return None;
    }
    if needed == 0 || needed > 64 * 1024 {
        return None;
    }

    let words = ((needed as usize) + 7) / 8;
    let mut buf = vec![0u64; words];
    let ok = unsafe {
        QueryServiceConfigW(
            svc.0,
            buf.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>(),
            (words * 8) as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return None;
    }

    let cfg = unsafe { &*buf.as_ptr().cast::<QUERY_SERVICE_CONFIGW>() };
    if cfg.lpBinaryPathName.is_null() {
        return None;
    }
    let mut len = 0usize;
    unsafe {
        while len < 32 * 1024 && *cfg.lpBinaryPathName.add(len) != 0 {
            len += 1;
        }
    }
    let cmd = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(cfg.lpBinaryPathName, len) });
    parse_data_dir_from_service_cmd(&cmd)
}

#[cfg(not(windows))]
pub fn installed_windows_service_data_dir() -> Option<PathBuf> {
    None
}

pub(crate) fn resolve_localhost_candidate_dirs(
    explicit_env: Option<&str>,
    local_app_data: Option<&str>,
    program_data: Option<&str>,
    installed_service_dir: Option<&Path>,
    service_running: bool,
) -> Vec<PathBuf> {
    if let Some(trimmed) = explicit_env.map(str::trim).filter(|s| !s.is_empty()) {
        return vec![PathBuf::from(trimmed)];
    }

    let tray_dir = local_app_data
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| PathBuf::from(s).join("CadenceEngine"));
    let configured_svc_dir = installed_service_dir.and_then(|p| {
        if p.to_string_lossy().trim().is_empty() {
            None
        } else {
            Some(p.to_path_buf())
        }
    });
    let default_svc_dir = program_data
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| PathBuf::from(s).join("CadenceEngine"));

    let ordered = if service_running {
        [configured_svc_dir, tray_dir, default_svc_dir]
    } else {
        [tray_dir, configured_svc_dir, default_svc_dir]
    };

    let mut out: Vec<PathBuf> = Vec::new();
    for dir in ordered.into_iter().flatten() {
        #[cfg(windows)]
        let already = out.iter().any(|existing| {
            existing.to_string_lossy().to_ascii_lowercase()
                == dir.to_string_lossy().to_ascii_lowercase()
        });
        #[cfg(not(windows))]
        let already = out.contains(&dir);
        if !already {
            out.push(dir);
        }
    }
    out
}

pub fn localhost_windows_engine_candidate_dirs() -> Vec<PathBuf> {
    let explicit_env = std::env::var("CADENCE_DATA_DIR").ok();
    let local_app_data = std::env::var("LOCALAPPDATA").ok();
    let env_program_data = std::env::var("ProgramData").ok();
    #[cfg(windows)]
    let program_data = env_program_data
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(Some(r"C:\ProgramData"));
    #[cfg(not(windows))]
    let program_data = env_program_data
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let installed_service_dir = installed_windows_service_data_dir();

    resolve_localhost_candidate_dirs(
        explicit_env.as_deref(),
        local_app_data.as_deref(),
        program_data,
        installed_service_dir.as_deref(),
        is_windows_service_running(),
    )
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

#[derive(Clone, Debug)]
pub(crate) struct ActiveRunState {
    token: Option<RunToken>,
    saw_active: bool,
}

pub struct WindowsEngineRenderer {
    audio: Arc<AudioEngine>,
    shared_buffers: SharedTrackBuffers,
    run_state: Arc<Mutex<ActiveRunState>>,
}

impl WindowsEngineRenderer {
    fn new(
        audio: Arc<AudioEngine>,
        shared_buffers: SharedTrackBuffers,
        run_state: Arc<Mutex<ActiveRunState>>,
    ) -> Self {
        Self { audio, shared_buffers, run_state }
    }
}

impl Renderer for WindowsEngineRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        match action {
            RendererAction::Play { entry, token } => {
                let track = self.shared_buffers.lock().map_err(|_| RendererError)?
                    .get(&entry.track_id).and_then(std::sync::Weak::upgrade).ok_or(RendererError)?;
                self.audio.play_admitted_track(track).map_err(|_| RendererError)?;
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
    enrichment_worker: Option<crate::core_runtime::enrichment::worker::EnrichmentWorker>,
    curate_worker: Option<crate::core_runtime::curate::CurateJobWorker>,
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
        if !config.allow_loopback_for_tests {
            if let Some(legacy_db_path) = detect_legacy_desktop_db() {
                if legacy_db_path != db_path {
                    let target_count = Connection::open(&db_path)
                        .and_then(|c| {
                            c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))
                        })
                        .unwrap_or(0);
                    let target_empty = !db_path.is_file() || target_count == 0;
                    if target_empty {
                        match migrate_legacy_desktop_db(&legacy_db_path, &config.app_data_dir) {
                            Ok(res) => {
                                record_migration_history(
                                    &config.app_data_dir,
                                    &legacy_db_path,
                                    &db_path,
                                    "migrated",
                                    Some(res.imported_tracks),
                                    Some(res.imported_playlists),
                                    Some(res.imported_drafts),
                                    None,
                                );
                                crate::diag_log!(
                                    crate::diagnostics::DiagCategory::DatabaseMigration,
                                    0,
                                    0,
                                    0,
                                    "legacy_db_migrated",
                                    "tracks={} playlists={} drafts={}",
                                    res.imported_tracks,
                                    res.imported_playlists,
                                    res.imported_drafts
                                );
                            }
                            Err(err) => {
                                record_migration_history(
                                    &config.app_data_dir,
                                    &legacy_db_path,
                                    &db_path,
                                    "error",
                                    None,
                                    None,
                                    None,
                                    Some(&err),
                                );
                                crate::diag_log!(
                                    crate::diagnostics::DiagCategory::DatabaseMigration,
                                    0,
                                    0,
                                    0,
                                    "legacy_db_migration_failed",
                                    "err={}",
                                    err
                                );
                            }
                        }
                    } else {
                        let art_res = copy_cached_artwork_from_legacy(&legacy_db_path, &db_path);
                        record_migration_history(
                            &config.app_data_dir,
                            &legacy_db_path,
                            &db_path,
                            "skipped_target_non_empty",
                            Some(target_count.max(0) as usize),
                            None,
                            None,
                            art_res.err().as_deref(),
                        );
                    }
                }
            }
        }
        let run_state = Arc::new(Mutex::new(ActiveRunState {
            token: None,
            saw_active: false,
        }));
        let shared_buffers = Arc::new(Mutex::new(HashMap::new()));
        let renderer = WindowsEngineRenderer::new(
            Arc::clone(&audio),
            Arc::clone(&shared_buffers),
            Arc::clone(&run_state),
        );

        let headless_cfg = HeadlessConfig {
            db_path: db_path.clone(),
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

        let enrichment_worker = if std::env::var("CADENCE_DISABLE_ENRICHMENT").as_deref() != Ok("1") {
            rt.db().map(|db_ref| {
                crate::core_runtime::enrichment::worker::EnrichmentWorker::start(
                    db_ref,
                    crate::core_runtime::enrichment::worker::EnrichmentWorkerConfig {
                        db_path: db_path.clone(),
                        artwork_dir: rt.artwork_dir(),
                        enable_external: !config.allow_loopback_for_tests
                            && std::env::var("CADENCE_DISABLE_ENRICHMENT_EXTERNAL").as_deref() != Ok("1"),
                    },
                    rt.enrichment_idle_gate(),
                    rt.enrichment_gate_registry(),
                )
            })
        } else {
            None
        };
        let idle_gate_rec = rt.enrichment_idle_gate();
        if !config.allow_loopback_for_tests {
            crate::diagnostics::install_panic_hook("cadence-engine", config.app_data_dir.clone());
            let gate_for_diag = Arc::clone(&idle_gate_rec);
            let _ = crate::diagnostics::configure_persistence(
                config.app_data_dir.clone(),
                Arc::new(move || {
                    if gate_for_diag.is_transport_active() {
                        crate::diagnostics::HygieneState::Playing
                    } else {
                        let rem_ms = gate_for_diag.cooldown_remaining_ms();
                        if rem_ms > 0 {
                            crate::diagnostics::HygieneState::Cooldown {
                                remaining_secs: rem_ms.div_ceil(1000).max(1),
                            }
                        } else {
                            crate::diagnostics::HygieneState::Idle
                        }
                    }
                }),
            );
        }
        rt.set_curate_worker_active(true);
        let curate_worker = Some(crate::core_runtime::curate::CurateJobWorker::start(
            db_path.clone(),
            false,
            Arc::clone(&idle_gate_rec),
        ));

        let runtime = Arc::new(Mutex::new(rt));
        let stop_flag = Arc::new(AtomicBool::new(false));

        let audio_for_ops = Arc::clone(&audio);
        let expected_engine_id = identity.engine_id.clone();
        let expected_library_id = identity.library_id.clone();
        let extra_op_handler: ExtraV1OpHandler<_, _, _> = Arc::new(move |req, rt| {
            let op = req.get("operation").and_then(Value::as_str)?;
            let req_engine = req.get("engineId").and_then(Value::as_str);
            let req_lib = req.get("libraryId").and_then(Value::as_str);
            if matches!(op, "outputs.list" | "outputs.scan" | "output.select" | "player.volume" | "player.purity" | "player.upnp_pacer" | "player.upnp_delivery")
                && (req_engine != Some(expected_engine_id.as_str())
                    || req_lib != Some(expected_library_id.as_str()))
            {
                return Some(json!({"ok": false, "error": {"code": "identity_mismatch"}}));
            }
            match op {
                "player.upnp_delivery" => {
                    Some(json!({ "ok": true, "data": audio_for_ops.get_upnp_manager().delivery_snapshot(req) }))
                }
                "outputs.list" => {
                    let list = audio_for_ops.list_audio_endpoints();
                    Some(json!({ "ok": true, "data": { "outputs": list } }))
                }
                "outputs.scan" => {
                    if !rt.output_discovery_is_allowed() {
                        return Some(json!({ "ok": false, "error": { "code": "not_ready" } }));
                    }
                    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                        Ok(runtime) => runtime,
                        Err(_) => return Some(json!({ "ok": false, "error": { "code": "unavailable" } })),
                    };
                    let manager = audio_for_ops.get_upnp_manager();
                    let result = runtime.block_on(async {
                        tokio::time::timeout(Duration::from_secs(6), manager.discover_devices()).await
                    });
                    if result.is_err() {
                        return Some(json!({ "ok": false, "error": { "code": "unavailable" } }));
                    }
                    Some(json!({ "ok": true, "data": { "outputs": audio_for_ops.list_audio_endpoints() } }))
                }
                "output.select" => {
                    if !rt.output_selection_is_idle() {
                        return Some(json!({ "ok": false, "error": { "code": "not_ready" } }));
                    }
                    let target_id = req
                        .get("outputId")
                        .or_else(|| req.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let list = audio_for_ops.list_audio_endpoints();
                    let upnp_devices = audio_for_ops.get_upnp_manager().get_devices();
                    let chosen = list.iter().find(|e| e.id == target_id && e.is_available).cloned();
                    if chosen.is_none() {
                        return Some(json!({ "ok": false, "error": { "code": "invalid_payload" } }));
                    }
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
                            match rt.set_output(out.clone()) {
                                Ok(()) => Some(json!({ "ok": true, "data": { "output": out } })),
                                Err(_) => Some(json!({ "ok": false, "error": { "code": "not_ready" } })),
                            }
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
                "player.upnp_pacer" => {
                    let manager = audio_for_ops.get_upnp_manager();
                    let actual = if let Some(enabled) = req.get("enabled").and_then(Value::as_bool) {
                        manager.set_pacer_enabled(enabled)
                    } else {
                        manager.is_pacer_enabled()
                    };
                    Some(json!({ "ok": true, "data": { "pacerEnabled": actual } }))
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
                    true,
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
                run_windows_reconcile_loop(rt_rec, stop_rec, audio_rec, run_rec, idle_gate_rec);
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
            enrichment_worker,
            curate_worker,
        })
    }

    pub fn status(&self) -> PlaybackStatus {
        self.audio.get_status()
    }

    pub fn shutdown(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(mut ew) = self.enrichment_worker.take() {
            ew.shutdown();
        }
        if let Some(mut cw) = self.curate_worker.take() {
            cw.shutdown();
        }
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
    idle_gate: Arc<crate::core_runtime::enrichment::worker::EnrichmentIdleGate>,
) where
    P: crate::core_runtime::PlatformProbe,
    L: crate::core_runtime::MemoryLocker,
{
    let mut prev_active = false;
    while !stop_flag.load(Ordering::Acquire) {
        let status = audio.get_status();
        let is_loading = audio.is_loading();
        let active = status.is_playing || status.is_paused || is_loading;
        if active != prev_active {
            idle_gate.set_transport_active(active);
            prev_active = active;
        }

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
                let _ = rt.on_windows_renderer_completed(tok);
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
    let build_info = crate::build_info::current_build_info();
    let props = [
        ("role", "core"),
        ("engineId", identity.engine_id.as_str()),
        ("libraryId", identity.library_id.as_str()),
        ("label", identity.label.as_str()),
        ("protocol", "https"),
        ("fp", tls_fingerprint),
        ("ver", build_info.display.as_str()),
        ("proto", "2"),
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
pub fn record_migration_history(
    engine_data_dir: &Path,
    source_db: &Path,
    target_db: &Path,
    status: &str,
    imported_tracks: Option<usize>,
    imported_playlists: Option<usize>,
    imported_drafts: Option<usize>,
    error: Option<&str>,
) {
    let history_path = engine_data_dir.join("migration-history.json");
    let mut entries: Vec<Value> = std::fs::read_to_string(&history_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    entries.push(json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "sourceDb": source_db.to_string_lossy(),
        "targetDb": target_db.to_string_lossy(),
        "status": status,
        "importedTracks": imported_tracks,
        "importedPlaylists": imported_playlists,
        "importedDrafts": imported_drafts,
        "error": error,
    }));
    if entries.len() > 32 {
        let drop_n = entries.len() - 32;
        entries.drain(0..drop_n);
    }
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = std::fs::write(&history_path, json);
    }
}

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
    dst.execute_batch("CREATE TABLE IF NOT EXISTS engine_artwork (release_id TEXT PRIMARY KEY, etag TEXT NOT NULL, jpeg BLOB NOT NULL);")
        .map_err(|e| e.to_string())?;
    if let Ok(mut stmt) = src.prepare(
        "SELECT id, cache_path FROM artwork_cache_state WHERE entity_type='release' AND status='cached' AND cache_path IS NOT NULL",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for row in rows.flatten() {
                let (release_id, cache_path) = row;
                if let Ok(bytes) = std::fs::read(&cache_path) {
                    if !bytes.is_empty() {
                        let hash = format!("{:x}", Sha256::digest(&bytes));
                        let etag = format!("art_{}", &hash[..16]);
                        dst.execute(
                            "INSERT INTO engine_artwork(release_id, etag, jpeg) VALUES(?1, ?2, ?3) ON CONFLICT(release_id) DO UPDATE SET etag=excluded.etag, jpeg=excluded.jpeg",
                            rusqlite::params![release_id, etag, bytes],
                        ).map_err(|e| e.to_string())?;
                        dst.execute("UPDATE tracks SET has_embedded_art=1 WHERE release_id=?1", rusqlite::params![release_id])
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    // Backfill any release still missing from `engine_artwork` using legacy `front_cover_url` or local folder art
    if let Ok(mut stmt) = src.prepare("SELECT id, folder_path, front_cover_url FROM releases") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2).ok().flatten(),
            ))
        }) {
            for (release_id, folder_path, front_cover_url) in rows.flatten() {
                let already_cached: bool = dst
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM engine_artwork WHERE release_id=?1)",
                        rusqlite::params![release_id],
                        |r| r.get(0),
                    )
                    .unwrap_or(false);
                if already_cached {
                    continue;
                }
                let candidate_path = front_cover_url
                    .as_deref()
                    .and_then(|u| {
                        let clean = u
                            .strip_prefix("file:///")
                            .or_else(|| u.strip_prefix("file://"))
                            .unwrap_or(u);
                        let p = Path::new(clean);
                        p.is_file().then(|| p.to_path_buf())
                    })
                    .or_else(|| {
                        crate::scanner::find_local_cover_art(Path::new(&folder_path))
                            .map(PathBuf::from)
                    });
                if let Some(img_path) = candidate_path {
                    if let Ok(bytes) = std::fs::read(&img_path) {
                        if !bytes.is_empty() {
                            let hash = format!("{:x}", Sha256::digest(&bytes));
                            let etag = format!("art_{}", &hash[..16]);
                            let _ = dst.execute(
                                "INSERT INTO engine_artwork(release_id, etag, jpeg) VALUES(?1, ?2, ?3) ON CONFLICT(release_id) DO UPDATE SET etag=excluded.etag, jpeg=excluded.jpeg",
                                rusqlite::params![release_id, etag, bytes],
                            );
                            let _ = dst.execute(
                                "UPDATE tracks SET has_embedded_art=1 WHERE release_id=?1",
                                rusqlite::params![release_id],
                            );
                        }
                    }
                }
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

    #[cfg(windows)]
    #[test]
    fn windows_http_queue_admits_existing_track_and_rejects_missing_track_atomically() {
        let data_dir = temp_dir("queue");
        let file = data_dir.join("available.wav");
        std::fs::write(&file, vec![0; 64 * 1024]).unwrap();
        {
            let db = crate::db::AppDb::new(data_dir.join("cadence.db")).unwrap();
            let conn = db.conn.lock();
            let folder = data_dir.to_string_lossy();
            conn.execute(
                "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp)
                 VALUES ('m','Music',?1,'local_disk','ntfs',CURRENT_TIMESTAMP)",
                [folder.as_ref()],
            ).unwrap();
            conn.execute(
                "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at)
                 VALUES ('r','Album',?1,'Album','Artist',CURRENT_TIMESTAMP)",
                [folder.as_ref()],
            ).unwrap();
            for (id, path) in [("available", file), ("missing", data_dir.join("missing.wav"))] {
                conn.execute(
                    "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,
                     file_size,mtime,title,artist_credit,album_title,duration_secs,format,created_at)
                     VALUES (?1,'r','m',?2,'Album',?3,?1,65536,1,?1,'Artist','Album',1,'WAV',CURRENT_TIMESTAMP)",
                    rusqlite::params![id, folder, path.to_string_lossy()],
                ).unwrap();
            }
        }
        let mut node = WindowsEngineNode::bootstrap(WindowsEngineConfig {
            app_data_dir: data_dir.clone(),
            control_bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_for_tests: true,
            enable_mdns: false,
            ..WindowsEngineConfig::default()
        }).unwrap();

        let request = |mut fields: Value| -> Value {
            fields["protocolVersion"] = json!(1);
            fields["engineId"] = json!(node.identity.engine_id);
            fields["libraryId"] = json!(node.identity.library_id);
            let body = fields.to_string();
            let response = http_request(node.control_listen_addr, &format!(
                "POST /v1/core HTTP/1.1\r\nHost: 127.0.0.1\r\nx-cadence-token: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                node.pairing_token, body.len(),
            ));
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
        };

        let initial = request(json!({"operation": "session.snapshot"}));
        let accepted = request(json!({
            "operation": "queue.replace", "commandId": "available-cmd",
            "expectedRevision": initial["data"]["revision"],
            "entries": [{"entryId": "available-entry", "trackId": "available"}],
        }));
        assert_eq!(accepted["ok"], true, "{accepted}");
        assert_eq!(accepted["data"]["queue"]["entries"][0]["trackId"], "available");

        let rejected = request(json!({
            "operation": "queue.replace", "commandId": "missing-cmd",
            "expectedRevision": accepted["data"]["revision"],
            "entries": [{"entryId": "missing-entry", "trackId": "missing"}],
        }));
        assert_eq!(rejected["error"]["code"], "not_ready", "{rejected}");
        assert_eq!(request(json!({"operation": "session.snapshot"})), accepted);

        node.shutdown();
        let _ = std::fs::remove_dir_all(data_dir);
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

    #[test]
    fn fresh_legacy_migration_preserves_cached_release_artwork() {
        let root = temp_dir("migrate-art");
        let source = root.join("legacy.db");
        let engine_dir = root.join("engine-data");
        let image = root.join("cached.jpg");
        std::fs::write(&image, b"cached-image").unwrap();
        {
            let db = crate::db::AppDb::new(source.clone()).unwrap();
            let conn = db.conn.lock();
            conn.execute("INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES ('m','Music','C:\\Music','local_disk','ntfs',CURRENT_TIMESTAMP)", []).unwrap();
            conn.execute("INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES ('r','Album','C:\\Music','Album','Artist',CURRENT_TIMESTAMP)", []).unwrap();
            conn.execute("INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,duration_secs,format,created_at) VALUES ('t','r','m','C:\\Music','Album','C:\\Music\\track.flac','track.flac',1,1,'Track','Artist','Album',1,'FLAC',CURRENT_TIMESTAMP)", []).unwrap();
            conn.execute("INSERT INTO artwork_cache_state(id,entity_type,source_path,cache_path,status,checked_at) VALUES ('r','release','C:\\Music',?1,'cached',CURRENT_TIMESTAMP)", rusqlite::params![image.to_string_lossy()]).unwrap();
        }
        migrate_legacy_desktop_db(&source, &engine_dir).unwrap();
        let conn = Connection::open(engine_dir.join("cadence.db")).unwrap();
        let bytes: Vec<u8> = conn.query_row("SELECT jpeg FROM engine_artwork WHERE release_id='r'", [], |r| r.get(0)).unwrap();
        assert_eq!(bytes, b"cached-image");
        let advertised: bool = conn.query_row("SELECT has_embedded_art FROM tracks WHERE id='t'", [], |r| r.get(0)).unwrap();
        assert!(advertised, "migrated artwork must be advertised to the catalogue");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_migration_preserves_front_cover_url_and_backfills_uncached_folder_art() {
        let root = temp_dir("migrate-folder-art");
        let album_dir = root.join("AlbumDir");
        std::fs::create_dir_all(&album_dir).unwrap();
        let folder_cover = album_dir.join("Cover.jpg");
        std::fs::write(&folder_cover, b"folder-cover-bytes").unwrap();
        let source = root.join("legacy.db");
        let engine_dir = root.join("engine-data");
        {
            let db = crate::db::AppDb::new(source.clone()).unwrap();
            let conn = db.conn.lock();
            conn.execute(
                "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES ('m','Music',?1,'local_disk','ntfs',CURRENT_TIMESTAMP)",
                rusqlite::params![root.to_string_lossy()],
            ).unwrap();
            conn.execute(
                "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,front_cover_url,created_at) VALUES ('r_uncached','Album',?1,'AlbumDir','Artist',?2,CURRENT_TIMESTAMP)",
                rusqlite::params![album_dir.to_string_lossy(), folder_cover.to_string_lossy()],
            ).unwrap();
            conn.execute(
                "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,duration_secs,format,has_embedded_art,created_at) VALUES ('t_uncached','r_uncached','m',?1,'AlbumDir',?2,'01.flac',1,1,'Track','Artist','Album',1,'FLAC',0,CURRENT_TIMESTAMP)",
                rusqlite::params![album_dir.to_string_lossy(), album_dir.join("01.flac").to_string_lossy()],
            ).unwrap();
        }
        migrate_legacy_desktop_db(&source, &engine_dir).unwrap();
        let conn = Connection::open(engine_dir.join("cadence.db")).unwrap();
        let front_cover: Option<String> = conn
            .query_row("SELECT front_cover_url FROM releases WHERE id='r_uncached'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(front_cover.as_deref(), Some(folder_cover.to_string_lossy().as_ref()));
        let bytes: Vec<u8> = conn
            .query_row("SELECT jpeg FROM engine_artwork WHERE release_id='r_uncached'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bytes, b"folder-cover-bytes");
        let advertised: bool = conn
            .query_row("SELECT has_embedded_art FROM tracks WHERE id='t_uncached'", [], |r| r.get(0))
            .unwrap();
        assert!(advertised, "backfilled folder cover must set has_embedded_art=1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_data_dir_from_service_cmd_extracts_quoted_and_unquoted_paths() {
        assert_eq!(
            parse_data_dir_from_service_cmd(
                r#"C:\Apps\cadence-engine.exe --service-run --no-tray --data-dir C:\ProgramData\CadenceEngine --port 4040"#,
            ),
            Some(PathBuf::from(r"C:\ProgramData\CadenceEngine"))
        );
        assert_eq!(
            parse_data_dir_from_service_cmd(
                r#""C:\Program Files\Cadence\cadence-engine.exe" --service-run --data-dir "C:\Users\John Doe\AppData\Local\CadenceEngine" --port 4040"#,
            ),
            Some(PathBuf::from(r"C:\Users\John Doe\AppData\Local\CadenceEngine"))
        );
        assert_eq!(
            parse_data_dir_from_service_cmd(
                r#"cadence-engine.exe --app-data-dir "D:\My \"Audio\" Data\Cadence""#,
            ),
            Some(PathBuf::from(r#"D:\My "Audio" Data\Cadence"#))
        );
        assert_eq!(
            parse_data_dir_from_service_cmd(r#"cadence-engine.exe --service-run --port 4040"#),
            None
        );
    }

    #[test]
    fn resolve_localhost_candidate_dirs_respects_explicit_override_ordering_and_dedup() {
        assert_eq!(
            resolve_localhost_candidate_dirs(
                Some("  D:\\CustomCadence  "),
                Some("C:\\Users\\Test\\AppData\\Local"),
                Some("C:\\ProgramData"),
                Some(Path::new("E:\\ServiceData")),
                true,
            ),
            vec![PathBuf::from("D:\\CustomCadence")]
        );

        assert_eq!(
            resolve_localhost_candidate_dirs(
                Some("   "),
                Some("C:\\Users\\Test\\AppData\\Local"),
                Some("C:\\ProgramData"),
                Some(Path::new("E:\\ServiceData")),
                true,
            ),
            vec![
                PathBuf::from("E:\\ServiceData"),
                PathBuf::from("C:\\Users\\Test\\AppData\\Local").join("CadenceEngine"),
                PathBuf::from("C:\\ProgramData").join("CadenceEngine"),
            ]
        );

        assert_eq!(
            resolve_localhost_candidate_dirs(
                None,
                Some("C:\\Users\\Test\\AppData\\Local"),
                Some("C:\\ProgramData"),
                Some(Path::new("E:\\ServiceData")),
                false,
            ),
            vec![
                PathBuf::from("C:\\Users\\Test\\AppData\\Local").join("CadenceEngine"),
                PathBuf::from("E:\\ServiceData"),
                PathBuf::from("C:\\ProgramData").join("CadenceEngine"),
            ]
        );

        assert_eq!(
            resolve_localhost_candidate_dirs(
                None,
                Some("C:\\Users\\Test\\AppData\\Local"),
                Some("C:\\ProgramData"),
                Some(Path::new("c:\\users\\test\\appdata\\local\\CadenceEngine")),
                true,
            ),
            vec![
                PathBuf::from("c:\\users\\test\\appdata\\local\\CadenceEngine"),
                PathBuf::from("C:\\ProgramData").join("CadenceEngine"),
            ]
        );
    }
}
