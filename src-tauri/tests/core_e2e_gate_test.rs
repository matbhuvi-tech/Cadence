//! Stage P0 — Layer 2 Rust Integration & Reproduction Gate for Cadence Linux Core.
//!
//! Exercises the authoritative Core stack (`DragonfishNode`, `UpnpSessionRuntime`,
//! `CoreMediaServer`, `LockedBytesArena`, `E2eRs130Simulator`, and SQLite `cadence.db`)
//! end-to-end with per-action correlation IDs (`cid_...`).
//!
//! Includes:
//! 1. Multi-format (`16/44.1 WAV`, `24/96 PCM`, `24/192 PCM`, `DSD64 .dsf`), multi-disc,
//!    compilation, RAM-lock admission, HTTP stream byte verification, UPnP SOAP sequence,
//!    and queue next/prev/jump/pause/stop transitions.
//! 2. `>200`-track catalog pagination (`225` tracks across offset/limit windows) + tight memory
//!    budget `not_ready` rejection & clean recovery.
//! 3. Core restart recovery: active playback clears cleanly on restart without auto-play or
//!    mutation replay, while persisted catalog/identity remain intact.
//! 4. Deterministic Stage P0 reproduction probes for:
//!    - Bug A (CatalogTrack identity collision: `releaseId`, `discNumber`, `isCompilation` missing
//!      in `/v1/core` projection).
//!    - Bug B (External HiFi ROSE pre-existing playback invisible while Core idle; `ExternalTakeover`
//!      leaves stale `activity = "playing"`/`current`; `PAUSED_PLAYBACK` + `RelTime` drift).

use cadence_core_lib::core_runtime::dragonfish::{
    DragonfishConfig, DragonfishNode, DRAGONFISH_SCHEMA_VERSION,
};
use cadence_core_lib::core_runtime::upnp_session::{
    inspect_rs130_description, CorePacerConfig, TransportReport, UpnpSessionConfig,
    UpnpSessionRuntime,
};
use cadence_core_lib::core_runtime::{
    CgroupMemoryLimits, HeadlessConfig, HostMemoryLimits, MemoryLocker, PlatformLimits,
    PlatformProbe,
};
use cadence_core_lib::core_session::Output;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct TestLocker {
    locked_bytes: AtomicUsize,
}

impl TestLocker {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            locked_bytes: AtomicUsize::new(0),
        })
    }

    fn current_locked_bytes(&self) -> usize {
        self.locked_bytes.load(Ordering::SeqCst)
    }
}

impl MemoryLocker for TestLocker {
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
    max_bytes: u64,
    current_bytes: u64,
}

impl ConfigurableProbe {
    fn generous() -> Self {
        Self {
            max_bytes: 512 * 1024 * 1024,
            current_bytes: 64 * 1024 * 1024,
        }
    }

    fn constrained(max_bytes: u64, current_bytes: u64) -> Self {
        Self {
            max_bytes,
            current_bytes,
        }
    }
}

impl PlatformProbe for ConfigurableProbe {
    fn query_limits(&self) -> PlatformLimits {
        PlatformLimits {
            cgroup: CgroupMemoryLimits {
                max_bytes: Some(self.max_bytes),
                high_bytes: Some(self.max_bytes),
                current_bytes: Some(self.current_bytes),
            },
            host: HostMemoryLimits {
                total_bytes: 64 * 1024 * 1024 * 1024,
                available_bytes: self.max_bytes.saturating_sub(self.current_bytes),
                zfs_arc_reclaimable_bytes: 0,
            },
            rlimit_memlock_bytes: None,
            cap_ipc_lock: true,
        }
    }
}

#[derive(Clone, Debug)]
struct RecordedSoap {
    action: String,
    uri: Option<String>,
    didl_title: Option<String>,
    target: Option<String>,
}

struct E2eRs130State {
    soap_calls: Vec<RecordedSoap>,
    current_uri: String,
    current_didl_title: String,
    transport_state: String,
    rel_time: String,
    track_duration: String,
    fail_next_soap: bool,
}

struct E2eRs130Simulator {
    addr: SocketAddr,
    state: Arc<Mutex<E2eRs130State>>,
    stop_flag: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl E2eRs130Simulator {
    fn start(udn: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind E2E RS130");
        let addr = listener.local_addr().unwrap();
        let _ = listener.set_nonblocking(true);
        let state = Arc::new(Mutex::new(E2eRs130State {
            soap_calls: Vec::new(),
            current_uri: String::new(),
            current_didl_title: String::new(),
            transport_state: "STOPPED".into(),
            rel_time: "00:00:00".into(),
            track_duration: "00:03:00".into(),
            fail_next_soap: false,
        }));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let state_ref = Arc::clone(&state);
        let stop_ref = Arc::clone(&stop_flag);
        let udn_owned = udn.to_string();

        let join = std::thread::spawn(move || {
            while !stop_ref.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut buf = [0u8; 16384];
                        let mut total = 0usize;
                        loop {
                            match stream.read(&mut buf[total..]) {
                                Ok(0) => break,
                                Ok(n) => {
                                    total += n;
                                    let req_str = String::from_utf8_lossy(&buf[..total]);
                                    if let Some(hdr_end) = req_str.find("\r\n\r\n") {
                                        let body_start = hdr_end + 4;
                                        let content_len = req_str[..hdr_end]
                                            .lines()
                                            .find_map(|l| {
                                                let lower = l.to_ascii_lowercase();
                                                lower
                                                    .strip_prefix("content-length:")
                                                    .and_then(|v| v.trim().parse::<usize>().ok())
                                            })
                                            .unwrap_or(0);
                                        if total >= body_start + content_len {
                                            break;
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
                        let req = String::from_utf8_lossy(&buf[..total]);
                        let first_line = req.lines().next().unwrap_or("");
                        if first_line.starts_with("GET /desc.xml") {
                            let xml = format!(
                                r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>ROSE-RS130</friendlyName>
    <manufacturer>CITECH</manufacturer>
    <modelName>RS130</modelName>
    <modelDescription>HiFi ROSE Network Transport</modelDescription>
    <UDN>{}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/AVTransport/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>"#,
                                udn_owned
                            );
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                xml.len(),
                                xml
                            );
                            let _ = stream.write_all(resp.as_bytes());
                            continue;
                        }

                        let soap_action = req
                            .lines()
                            .find_map(|l| {
                                if l.to_ascii_lowercase().starts_with("soapaction:") {
                                    l.split_once(':').map(|(_, v)| {
                                        v.trim()
                                            .trim_matches('"')
                                            .rsplit('#')
                                            .next()
                                            .unwrap_or("")
                                            .to_string()
                                    })
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_default();
                        let body = req
                            .split_once("\r\n\r\n")
                            .map(|(_, b)| b.to_string())
                            .unwrap_or_default();

                        let mut st = state_ref.lock().unwrap();
                        if st.fail_next_soap {
                            st.fail_next_soap = false;
                            let err_xml = "<s:Envelope><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorDescription>Renderer unreachable</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
                            let resp = format!(
                                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                err_xml.len(),
                                err_xml
                            );
                            let _ = stream.write_all(resp.as_bytes());
                            continue;
                        }

                        let mut rec = RecordedSoap {
                            action: soap_action.clone(),
                            uri: None,
                            didl_title: None,
                            target: None,
                        };

                        let response_xml = match soap_action.as_str() {
                            "SetAVTransportURI" => {
                                if let (Some(s), Some(e)) =
                                    (body.find("<CurrentURI>"), body.find("</CurrentURI>"))
                                {
                                    let uri = body[s + 12..e].to_string();
                                    st.current_uri = uri.clone();
                                    rec.uri = Some(uri);
                                }
                                if let (Some(s), Some(e)) =
                                    (body.find("<dc:title>"), body.find("</dc:title>"))
                                {
                                    let title = body[s + 10..e].to_string();
                                    st.current_didl_title = title.clone();
                                    rec.didl_title = Some(title);
                                } else if let (Some(s), Some(e)) =
                                    (body.find("&lt;dc:title&gt;"), body.find("&lt;/dc:title&gt;"))
                                {
                                    let title = body[s + 16..e].to_string();
                                    st.current_didl_title = title.clone();
                                    rec.didl_title = Some(title);
                                }
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:SetAVTransportURIResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>".to_string()
                            }
                            "Play" => {
                                st.transport_state = "PLAYING".into();
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:PlayResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>".to_string()
                            }
                            "Pause" => {
                                st.transport_state = "PAUSED_PLAYBACK".into();
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:PauseResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>".to_string()
                            }
                            "Stop" => {
                                st.transport_state = "STOPPED".into();
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:StopResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>".to_string()
                            }
                            "Seek" => {
                                if let (Some(s), Some(e)) =
                                    (body.find("<Target>"), body.find("</Target>"))
                                {
                                    let target = body[s + 8..e].to_string();
                                    st.rel_time = target.clone();
                                    rec.target = Some(target);
                                }
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:SeekResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>".to_string()
                            }
                            "GetTransportInfo" => format!(
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetTransportInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><CurrentTransportState>{}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed></u:GetTransportInfoResponse></s:Body></s:Envelope>",
                                st.transport_state
                            ),
                            "GetPositionInfo" => format!(
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetPositionInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><Track>1</Track><TrackDuration>{}</TrackDuration><TrackURI>{}</TrackURI><RelTime>{}</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>",
                                st.track_duration, st.current_uri, st.rel_time
                            ),
                            "GetMediaInfo" => format!(
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetMediaInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><NrTracks>1</NrTracks><MediaDuration>{}</MediaDuration><CurrentURI>{}</CurrentURI></u:GetMediaInfoResponse></s:Body></s:Envelope>",
                                st.track_duration, st.current_uri
                            ),
                            _ => "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body/></s:Envelope>".to_string(),
                        };

                        st.soap_calls.push(rec);
                        let http_resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            response_xml.len(),
                            response_xml
                        );
                        let _ = stream.write_all(http_resp.as_bytes());
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            addr,
            state,
            stop_flag,
            join: Some(join),
        }
    }

    fn description_url(&self) -> String {
        format!("http://{}/desc.xml", self.addr)
    }
}

impl Drop for E2eRs130Simulator {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Builds a valid minimal RIFF/WAVE file with deterministic PCM audio bytes.
fn build_synthetic_wav(payload_len: usize, sample_rate: u32, bits_per_sample: u16) -> Vec<u8> {
    let channels: u16 = 2;
    let byte_rate = sample_rate * (channels as u32) * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let data_size = payload_len as u32;
    let riff_size = 36 + data_size;

    let mut buf = Vec::with_capacity(44 + payload_len);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&riff_size.to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());
    for i in 0..payload_len {
        buf.push(((i * 29 + 11) & 0xFF) as u8);
    }
    buf
}

/// Builds a synthetic Sony DSF file with valid 80-byte DSD/fmt header + trailing ID3v2 section.
fn build_synthetic_dsf(audio_bytes_len: usize, id3_bytes_len: usize) -> Vec<u8> {
    let metadata_offset = (80 + audio_bytes_len) as u64;
    let total_size = metadata_offset + id3_bytes_len as u64;
    let sample_rate: u32 = 2_822_400; // DSD64
    let sample_count: u64 = (sample_rate as u64) * 2;

    let mut buf = Vec::with_capacity(total_size as usize);
    buf.extend_from_slice(b"DSD ");
    buf.extend_from_slice(&28u64.to_le_bytes());
    buf.extend_from_slice(&total_size.to_le_bytes());
    buf.extend_from_slice(&metadata_offset.to_le_bytes());
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&52u64.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&2u32.to_le_bytes());
    buf.extend_from_slice(&2u32.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.extend_from_slice(&sample_count.to_le_bytes());
    buf.extend_from_slice(&4096u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    for i in 0..audio_bytes_len {
        buf.push(((i * 31 + 7) & 0xFF) as u8);
    }
    for i in 0..id3_bytes_len {
        buf.push((0xE0 ^ (i & 0x1F)) as u8);
    }
    buf
}

fn wire(mut body: Value) -> Vec<u8> {
    let obj = body.as_object_mut().unwrap();
    obj.insert("protocolVersion".into(), json!(1));
    obj.insert("engineId".into(), json!("e2e-core"));
    obj.insert("libraryId".into(), json!("e2e-library"));
    serde_json::to_vec(&body).unwrap()
}

fn send_raw_http(addr: SocketAddr, request: &str) -> (String, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).expect("connect media server");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP header separator");
    let headers = String::from_utf8_lossy(&raw[..sep]).to_string();
    let body = raw[sep + 4..].to_vec();
    (headers, body)
}

fn http_post_json(app_data: &std::path::Path, addr: SocketAddr, path: &str, payload: &Value) -> (u16, Value) {
    let pairing_token=std::fs::read_to_string(app_data.join("pairing-token")).unwrap();
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

fn redact_media_uri(uri: &str) -> String {
    if let Some((prefix, _token)) = uri.rsplit_once('/') {
        format!("{}/<redacted-run-token>", prefix)
    } else {
        "<empty-uri>".into()
    }
}

struct GateWorkspace {
    root: PathBuf,
    app_data_dir: PathBuf,
    music_dir: PathBuf,
    tmp_dir: PathBuf,
    db_path: PathBuf,
}

impl GateWorkspace {
    fn create(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "cadence_e2e_gate_{}_{}_{}",
            name,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let app_data_dir = root.join("var_lib_cadence");
        let music_dir = root.join("music_ro");
        let tmp_dir = root.join("tmp");
        std::fs::create_dir_all(&app_data_dir).unwrap();
        std::fs::create_dir_all(&music_dir).unwrap();
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let db_path = app_data_dir.join("cadence.db");
        Self {
            root,
            app_data_dir,
            music_dir,
            tmp_dir,
            db_path,
        }
    }

    fn dragonfish_config(&self) -> DragonfishConfig {
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
            label: "E2E Gate Core".into(),
            pinned_rs130_udn: Some("uuid:rs130-e2e-gate".into()),
            headroom_bytes: 32 * 1024 * 1024,
            min_lockable_bytes: 16 * 1024 * 1024,
            app_version: "0.1.0".into(),
            schema_version: DRAGONFISH_SCHEMA_VERSION,
        }
    }
}

impl Drop for GateWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn layer2_correlated_multi_format_ram_upnp_and_queue_flow() {
    let ws = GateWorkspace::create("multi_format_upnp");
    let wav_44k = build_synthetic_wav(96 * 1024, 44_100, 16);
    let flac_96k: Vec<u8> = (0..(128 * 1024)).map(|i| ((i * 13 + 5) & 0xFF) as u8).collect();
    let flac_192k: Vec<u8> = (0..(192 * 1024)).map(|i| ((i * 19 + 1) & 0xFF) as u8).collect();
    let dsf_64 = build_synthetic_dsf(160 * 1024, 8 * 1024);

    let wav_path = ws.music_dir.join("01_wav_44k.wav");
    let f96_path = ws.music_dir.join("02_pcm_96k.flac");
    let f192_path = ws.music_dir.join("03_pcm_192k.flac");
    let dsf_path = ws.music_dir.join("04_dsd64.dsf");
    std::fs::write(&wav_path, &wav_44k).unwrap();
    std::fs::write(&f96_path, &flac_96k).unwrap();
    std::fs::write(&f192_path, &flac_192k).unwrap();
    std::fs::write(&dsf_path, &dsf_64).unwrap();

    let conn = rusqlite::Connection::open(&ws.db_path).unwrap();
    cadence_core_lib::db::schema::initialize_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES ('m_e2e', 'E2E Pool', ?1, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
         VALUES ('rel_e2e_1', 'Reference Sessions', ?1, 'Reference Sessions', 'Ensemble E2E', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();

    let rows = [
        ("trk_wav_44k", "Opening Prelude", &wav_path, wav_44k.len(), 1, 1, "WAV", 44100, 16, 180.0),
        ("trk_pcm_96k", "Chamber 96k", &f96_path, flac_96k.len(), 1, 2, "FLAC", 96000, 24, 210.0),
        ("trk_pcm_192k", "Adagio 192k", &f192_path, flac_192k.len(), 2, 1, "FLAC", 192000, 24, 240.0),
        ("trk_dsd_64", "Nocturne DSD64", &dsf_path, dsf_64.len(), 2, 2, "DSF", 2822400, 1, 260.0),
    ];
    for (id, title, path, size, disc, num, fmt, sr, bd, dur) in rows {
        conn.execute(
            "INSERT INTO tracks (
                id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                file_size, mtime, title, artist_credit, album_title, disc_number, track_number,
                duration_secs, format, sample_rate, bit_depth, channels, created_at
            ) VALUES (?1, 'rel_e2e_1', 'm_e2e', ?2, 'Reference Sessions', ?3, ?4,
                      ?5, 1700000000, ?6, 'Ensemble E2E', 'Reference Sessions', ?7, ?8,
                      ?9, ?10, ?11, ?12, 2, '2026-11-15T00:00:00Z')",
            rusqlite::params![
                id,
                ws.music_dir.to_string_lossy().as_ref(),
                path.to_string_lossy().as_ref(),
                path.file_name().unwrap().to_string_lossy().as_ref(),
                size as i64,
                title,
                disc,
                num,
                dur,
                fmt,
                sr,
                bd
            ],
        )
        .unwrap();
    }
    drop(conn);

    let rs130 = E2eRs130Simulator::start("uuid:rs130-e2e");
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-e2e")).unwrap();
    let locker = TestLocker::new();
    let mut rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: ws.db_path.clone(),
            engine_id: "e2e-core".into(),
            library_id: "e2e-library".into(),
            label: "E2E Core".into(),
            output: Some(Output {
                id: "rs130-e2e".into(),
                label: "HiFi ROSE RS130".into(),
                transport: "upnp".into(),
            }),
            headroom_bytes: 32 * 1024 * 1024,
        },
        UpnpSessionConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_advertise: true,
            max_concurrent_streams: 2,
            pacer_config: CorePacerConfig::fast_for_tests(),
            target_device: desc,
        },
        ConfigurableProbe::generous(),
        locker.clone(),
    )
    .expect("open UpnpSessionRuntime");

    let cid = "cid_e2e_multi_fmt";
    let expected_ram: usize = wav_44k.len() + flac_96k.len() + flac_192k.len() + dsf_64.len();
    rt.admit_tracks(&[
        "trk_wav_44k".into(),
        "trk_pcm_96k".into(),
        "trk_pcm_192k".into(),
        "trk_dsd_64".into(),
    ])
    .unwrap();
    assert_eq!(locker.current_locked_bytes(), expected_ram);
    println!("[CORR {cid}] stage=ram_admitted locked_bytes={}", locker.current_locked_bytes());

    // Queue all 4 tracks with distinct entry IDs, then play middle track `trk_pcm_192k` (`e_192k`)
    let q_resp = rt.request(&wire(json!({
        "operation": "queue.replace",
        "entries": [
            { "entryId": "e_wav", "trackId": "trk_wav_44k" },
            { "entryId": "e_96k", "trackId": "trk_pcm_96k" },
            { "entryId": "e_192k", "trackId": "trk_pcm_192k" },
            { "entryId": "e_dsd", "trackId": "trk_dsd_64" }
        ],
        "commandId": format!("cmd_{cid}_qreplace"),
        "expectedRevision": 0
    })));
    assert_eq!(q_resp["ok"], true, "queue.replace failed: {q_resp}");

    let rev = q_resp["data"]["revision"].as_u64().unwrap();
    let jump_mid = rt.request(&wire(json!({
        "operation": "queue.control",
        "action": "jump",
        "entryId": "e_192k",
        "commandId": format!("cmd_{cid}_jump_mid"),
        "expectedRevision": rev
    })));
    assert_eq!(jump_mid["ok"], true, "jump to middle failed: {jump_mid}");
    assert_eq!(jump_mid["data"]["queue"]["currentEntryId"], "e_192k");

    let rev = jump_mid["data"]["revision"].as_u64().unwrap();
    let play_resp = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk_pcm_192k",
        "commandId": format!("cmd_{cid}_play"),
        "expectedRevision": rev
    })));
    assert_eq!(play_resp["ok"], true, "play failed: {play_resp}");

    let (rs130_uri_192, rs130_state_192, didl_title_192) = {
        let st = rs130.state.lock().unwrap();
        (st.current_uri.clone(), st.transport_state.clone(), st.current_didl_title.clone())
    };
    assert_eq!(rs130_state_192, "PLAYING");
    assert_eq!(didl_title_192, "Adagio 192k");
    assert!(rs130_uri_192.contains("/media/") && rs130_uri_192.ends_with(".flac"));

    // Verify exact locked RAM bytes streamed over HTTP
    let path_192 = format!("/media/{}", rs130_uri_192.rsplit("/media/").next().unwrap());
    let (hdr, body) = send_raw_http(
        rt.media_listen_addr(),
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_192),
    );
    assert!(hdr.starts_with("HTTP/1.1 200 OK"), "unexpected hdr: {hdr}");
    assert_eq!(body, flac_192k);
    rt.reconcile_renderer().unwrap();
    println!(
        "[CORR {cid}] stage=upnp_verified track=trk_pcm_192k uri={} bytes={}",
        redact_media_uri(&rs130_uri_192),
        body.len()
    );

    // Queue next -> transitions to DSD64 (`e_dsd`)
    let rev = rt.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"]
        .as_u64()
        .unwrap();
    let next_resp = rt.request(&wire(json!({
        "operation": "queue.control",
        "action": "next",
        "commandId": format!("cmd_{cid}_next"),
        "expectedRevision": rev
    })));
    assert_eq!(next_resp["ok"], true, "next failed: {next_resp}");
    assert_eq!(next_resp["data"]["queue"]["currentEntryId"], "e_dsd");
    let rs130_uri_dsd = rs130.state.lock().unwrap().current_uri.clone();
    assert!(rs130_uri_dsd.ends_with(".dsf"), "expected .dsf URI, got {rs130_uri_dsd}");
    let path_dsd = format!("/media/{}", rs130_uri_dsd.rsplit("/media/").next().unwrap());
    let (hdr_dsd, body_dsd) = send_raw_http(
        rt.media_listen_addr(),
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_dsd),
    );
    assert!(hdr_dsd.starts_with("HTTP/1.1 200 OK"));
    assert_eq!(body_dsd, dsf_64);

    // Queue jump -> `e_wav` (`16/44.1 WAV`)
    let rev = next_resp["data"]["revision"].as_u64().unwrap();
    let jump_resp = rt.request(&wire(json!({
        "operation": "queue.control",
        "action": "jump",
        "entryId": "e_wav",
        "commandId": format!("cmd_{cid}_jump"),
        "expectedRevision": rev
    })));
    assert_eq!(jump_resp["ok"], true, "jump failed: {jump_resp}");
    assert_eq!(jump_resp["data"]["queue"]["currentEntryId"], "e_wav");
    let rs130_uri_wav = rs130.state.lock().unwrap().current_uri.clone();
    assert!(rs130_uri_wav.ends_with(".wav"), "expected .wav URI, got {rs130_uri_wav}");
    let path_wav = format!("/media/{}", rs130_uri_wav.rsplit("/media/").next().unwrap());
    let (hdr_wav, body_wav) = send_raw_http(
        rt.media_listen_addr(),
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_wav),
    );
    assert!(hdr_wav.starts_with("HTTP/1.1 200 OK"));
    assert_eq!(body_wav, wav_44k);
    rt.reconcile_renderer().unwrap();

    // Pause -> Stop -> verify capability token revoked
    let rev = rt.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"]
        .as_u64()
        .unwrap();
    let pause_resp = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "pause",
        "commandId": format!("cmd_{cid}_pause"),
        "expectedRevision": rev
    })));
    assert_eq!(pause_resp["ok"], true, "pause failed: {pause_resp}");
    assert_eq!(rs130.state.lock().unwrap().transport_state, "PAUSED_PLAYBACK");

    let rev = pause_resp["data"]["revision"].as_u64().unwrap();
    let stop_resp = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "stop",
        "commandId": format!("cmd_{cid}_stop"),
        "expectedRevision": rev
    })));
    assert_eq!(stop_resp["ok"], true);
    assert_eq!(rs130.state.lock().unwrap().transport_state, "STOPPED");

    let (hdr_revoked, _) = send_raw_http(
        rt.media_listen_addr(),
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_wav),
    );
    assert!(hdr_revoked.starts_with("HTTP/1.1 404") || hdr_revoked.starts_with("HTTP/1.1 410"));

    rt.shutdown().unwrap();
}

#[test]
fn layer2_catalog_pagination_225_tracks_and_memory_budget_not_ready() {
    let ws = GateWorkspace::create("pagination_and_not_ready");
    let conn = rusqlite::Connection::open(&ws.db_path).unwrap();
    cadence_core_lib::db::schema::initialize_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES ('m_big', 'Big Pool', ?1, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
         VALUES ('rel_mega_225', 'Mega Box Set', ?1, 'Mega Box Set', 'Composer Collective', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();

    // Create 225 small tracks + 1 oversized track exceeding constrained memory budget
    for idx in 1..=225usize {
        let tid = format!("trk_mega_{:03}", idx);
        let p = ws.music_dir.join(format!("{tid}.flac"));
        std::fs::write(&p, b"fLaC000100020003").unwrap();
        conn.execute(
            "INSERT INTO tracks (
                id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                file_size, mtime, title, artist_credit, album_title, disc_number, track_number,
                duration_secs, format, sample_rate, bit_depth, channels, created_at
            ) VALUES (?1, 'rel_mega_225', 'm_big', ?2, 'Mega Box Set', ?3, ?4,
                      16, 1700000000, ?5, 'Composer Collective', 'Mega Box Set', ?6, ?7,
                      60.0, 'FLAC', 44100, 16, 2, '2026-11-15T00:00:00Z')",
            rusqlite::params![
                tid,
                ws.music_dir.to_string_lossy().as_ref(),
                p.to_string_lossy().as_ref(),
                format!("{tid}.flac"),
                format!("Movement {:03}", idx),
                ((idx - 1) / 50 + 1) as i64,
                ((idx - 1) % 50 + 1) as i64,
            ],
        )
        .unwrap();
    }
    let huge_path = ws.music_dir.join("trk_huge_4mb.flac");
    std::fs::write(&huge_path, vec![0x55u8; 4 * 1024 * 1024]).unwrap();
    conn.execute(
        "INSERT INTO tracks (
            id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
            file_size, mtime, title, artist_credit, album_title, disc_number, track_number,
            duration_secs, format, sample_rate, bit_depth, channels, created_at
        ) VALUES ('trk_huge_4mb', 'rel_mega_225', 'm_big', ?1, 'Mega Box Set', ?2, 'trk_huge_4mb.flac',
                  ?3, 1700000000, 'Oversized Work', 'Composer Collective', 'Mega Box Set', 5, 1,
                  300.0, 'FLAC', 192000, 24, 2, '2026-11-15T00:00:00Z')",
        rusqlite::params![
            ws.music_dir.to_string_lossy().as_ref(),
            huge_path.to_string_lossy().as_ref(),
            (4 * 1024 * 1024) as i64
        ],
    )
    .unwrap();
    drop(conn);

    // 1. Test DragonfishNode catalog pagination (226 tracks total across offset 0 and 200)
    let mut node = DragonfishNode::bootstrap_with_platform(
        ws.dragonfish_config(),
        ConfigurableProbe::generous(),
        TestLocker::new(),
    )
    .expect("boot DragonfishNode");

    let (st0, snap0) = http_post_json(
        &ws.app_data_dir,
        node.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": node.identity().engine_id,
            "libraryId": node.identity().library_id,
            "operation": "session.snapshot"
        }),
    );
    assert_eq!(st0, 200);
    let tracks0 = snap0["data"]["catalog"]["tracks"].as_array().unwrap();
    assert_eq!(tracks0.len(), 200);
    let next_cursor = snap0["data"]["catalog"]["nextCursor"]
        .as_str()
        .expect("expected nextCursor on 226-track catalog")
        .to_string();

    let (st1, page1) = http_post_json(
        &ws.app_data_dir,
        node.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": node.identity().engine_id,
            "libraryId": node.identity().library_id,
            "operation": "catalog.page",
            "cursor": next_cursor,
            "limit": 200
        }),
    );
    assert_eq!(st1, 200, "catalog.page failed: {page1}");
    assert_eq!(page1["ok"], true, "catalog.page not ok: {page1}");
    let tracks1 = page1["data"]["tracks"].as_array().unwrap();
    assert_eq!(tracks1.len(), 26);
    assert!(page1["data"]["nextCursor"].is_null());
    println!(
        "[CORR cid_pagination] page0={} page1={} total_verified={}",
        tracks0.len(),
        tracks1.len(),
        tracks0.len() + tracks1.len()
    );

    node.shutdown().unwrap();

    // 2. Constrained UpnpSessionRuntime proves memory-budget `not_ready` on admission + play, and clean recovery on smaller track
    let rs130 = E2eRs130Simulator::start("uuid:rs130-budget");
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-budget")).unwrap();
    let locker = TestLocker::new();
    let mut rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: ws.db_path.clone(),
            engine_id: "e2e-core".into(),
            library_id: "e2e-library".into(),
            label: "Constrained Core".into(),
            output: Some(Output {
                id: "rs130-budget".into(),
                label: "HiFi ROSE RS130".into(),
                transport: "upnp".into(),
            }),
            headroom_bytes: 2 * 1024 * 1024,
        },
        UpnpSessionConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_advertise: true,
            max_concurrent_streams: 2,
            pacer_config: CorePacerConfig::fast_for_tests(),
            target_device: desc,
        },
        ConfigurableProbe::constrained(3 * 1024 * 1024, 1024 * 1024), // 3 MiB cap - 1 MiB used - 2 MiB headroom = 0 budget!
        locker.clone(),
    )
    .unwrap();

    let admit_err = rt.admit_tracks(&["trk_huge_4mb".into()]);
    assert!(admit_err.is_err(), "oversized track must fail memory admission");
    assert_eq!(locker.current_locked_bytes(), 0);
    let play_not_ready = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk_huge_4mb",
        "commandId": "cid_budget_not_ready",
        "expectedRevision": 0
    })));
    assert_eq!(play_not_ready["ok"], false);
    assert_eq!(play_not_ready["error"]["code"], "not_ready");

    // Verify recovery with a small track (`trk_mega_001`) when budget allows it
    let mut rt_ok = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: ws.db_path.clone(),
            engine_id: "e2e-core".into(),
            library_id: "e2e-library".into(),
            label: "Recovered Core".into(),
            output: Some(Output {
                id: "rs130-budget".into(),
                label: "HiFi ROSE RS130".into(),
                transport: "upnp".into(),
            }),
            headroom_bytes: 1024 * 1024,
        },
        UpnpSessionConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_advertise: true,
            max_concurrent_streams: 2,
            pacer_config: CorePacerConfig::fast_for_tests(),
            target_device: inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-budget")).unwrap(),
        },
        ConfigurableProbe::generous(),
        locker.clone(),
    )
    .unwrap();
    rt_ok.admit_tracks(&["trk_mega_001".into()]).unwrap();
    let rec_play = rt_ok.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk_mega_001",
        "commandId": "cid_budget_recover",
        "expectedRevision": 0
    })));
    assert_eq!(rec_play["ok"], true);
    let soap_actions: Vec<String> = rs130
        .state
        .lock()
        .unwrap()
        .soap_calls
        .iter()
        .map(|s| s.action.clone())
        .collect();
    println!("[CORR cid_budget_recover] not_ready_enforced=true recovery_soap={soap_actions:?}");
    rt_ok.shutdown().unwrap();

    rt.shutdown().unwrap();
}

#[test]
fn layer2_restart_recovery_no_autoplay_or_stale_mutation_replay() {
    let ws = GateWorkspace::create("restart_recovery");
    let song = ws.music_dir.join("song.wav");
    std::fs::write(&song, build_synthetic_wav(32 * 1024, 44_100, 16)).unwrap();

    let mut node1 = DragonfishNode::bootstrap_with_platform(
        ws.dragonfish_config(),
        ConfigurableProbe::generous(),
        TestLocker::new(),
    )
    .expect("boot node1");
    node1
        .seed_track_for_test("trk_restart_1", "Aftermath", &song, 90.0)
        .unwrap();
    let eng_id = node1.identity().engine_id.clone();
    let lib_id = node1.identity().library_id.clone();

    let (_st, q_resp) = http_post_json(
        &ws.app_data_dir,
        node1.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": eng_id,
            "libraryId": lib_id,
            "operation": "queue.replace",
            "entries": [{ "entryId": "e_restart_1", "trackId": "trk_restart_1" }],
            "commandId": "cid_restart_qreplace",
            "expectedRevision": 0
        }),
    );
    assert_eq!(q_resp["ok"], true, "queue.replace failed: {q_resp}");

    node1.shutdown().unwrap();
    drop(node1);

    // Reboot Core: identity preserved, catalog preserved, and session starts stopped/idle (zero auto-play)
    let mut node2 = DragonfishNode::bootstrap_with_platform(
        ws.dragonfish_config(),
        ConfigurableProbe::generous(),
        TestLocker::new(),
    )
    .expect("boot node2");
    assert_eq!(node2.identity().engine_id, eng_id);

    let (_st, snap2) = http_post_json(
        &ws.app_data_dir,
        node2.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": eng_id,
            "libraryId": lib_id,
            "operation": "session.snapshot"
        }),
    );
    assert_eq!(snap2["ok"], true);
    let activity = snap2["data"]["playback"]["activity"].as_str().unwrap();
    assert!(
        activity == "idle" || activity == "stopped",
        "restarted Core must never auto-play; saw activity={activity}"
    );
    assert_eq!(snap2["data"]["catalog"]["tracks"][0]["id"], "trk_restart_1");
    println!("[CORR cid_restart_recovery] activity={activity} catalog_tracks=1");

    node2.shutdown().unwrap();
}

#[test]
fn stage_p1_bug_a_identity_preservation_in_core_catalog_projection() {
    let ws = GateWorkspace::create("repro_bug_a");
    let std_path = ws.music_dir.join("symphony_std.wav");
    let rem_path = ws.music_dir.join("symphony_remaster.wav");
    let comp_a_path = ws.music_dir.join("world_d1_t1.wav");
    let comp_b_path = ws.music_dir.join("world_d2_t1.wav");
    let wav = build_synthetic_wav(16 * 1024, 44_100, 16);
    std::fs::write(&std_path, &wav).unwrap();
    std::fs::write(&rem_path, &wav).unwrap();
    std::fs::write(&comp_a_path, &wav).unwrap();
    std::fs::write(&comp_b_path, &wav).unwrap();

    let mut node = DragonfishNode::bootstrap_with_platform(
        ws.dragonfish_config(),
        ConfigurableProbe::generous(),
        TestLocker::new(),
    )
    .unwrap();
    let conn = rusqlite::Connection::open(&ws.db_path).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES ('m_a', 'Pool', ?1, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();
    // Two distinct releases sharing the same album string ("Symphony No. 5") + one multi-disc compilation
    conn.execute(
        "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, is_compilation, created_at)
         VALUES
           ('rel_std_1988', 'Symphony No. 5', ?1, 'Symphony No. 5 (1988)', 'Berlin Phil', 0, '2026-11-15T00:00:00Z'),
           ('rel_rem_2015', 'Symphony No. 5', ?1, 'Symphony No. 5 (2015 Remaster)', 'Berlin Phil', 0, '2026-11-15T00:00:00Z'),
           ('rel_comp_world', 'A World Of Music', ?1, 'A World Of Music', 'Various Artists', 1, '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();
    let inserts = [
        ("trk_std_1", "rel_std_1988", &std_path, "Allegro (1988)", "Berlin Phil", "Symphony No. 5", 1, 1),
        ("trk_rem_1", "rel_rem_2015", &rem_path, "Allegro (2015)", "Berlin Phil", "Symphony No. 5", 1, 1),
        ("trk_comp_d1", "rel_comp_world", &comp_a_path, "Dawn Raga", "Artist Alpha", "A World Of Music", 1, 1),
        ("trk_comp_d2", "rel_comp_world", &comp_b_path, "Midnight Raga", "Artist Beta", "A World Of Music", 2, 1),
    ];
    for (tid, rid, p, title, artist, album, disc, tnum) in inserts {
        conn.execute(
            "INSERT INTO tracks (
                id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                file_size, mtime, title, artist_credit, album_title, disc_number, track_number,
                duration_secs, format, sample_rate, bit_depth, channels, created_at
            ) VALUES (?1, ?2, 'm_a', ?3, ?4, ?5, ?6, 16428, 1700000000, ?7, ?8, ?9, ?10, ?11,
                      120.0, 'WAV', 44100, 16, 2, '2026-11-15T00:00:00Z')",
            rusqlite::params![
                tid,
                rid,
                ws.music_dir.to_string_lossy().as_ref(),
                album,
                p.to_string_lossy().as_ref(),
                p.file_name().unwrap().to_string_lossy().as_ref(),
                title,
                artist,
                album,
                disc,
                tnum
            ],
        )
        .unwrap();
    }
    drop(conn);
    node.shutdown().unwrap();

    // Reboot so catalog projection loads all 4 seeded tracks
    let mut node2 = DragonfishNode::bootstrap_with_platform(
        ws.dragonfish_config(),
        ConfigurableProbe::generous(),
        TestLocker::new(),
    )
    .unwrap();
    let (_st, snap) = http_post_json(
        &ws.app_data_dir,
        node2.control_listen_addr(),
        "/v1/core",
        &json!({
            "protocolVersion": 1,
            "engineId": node2.identity().engine_id,
            "libraryId": node2.identity().library_id,
            "operation": "session.snapshot"
        }),
    );
    let tracks = snap["data"]["catalog"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 4);

    // Stage P1 assertion: `/v1/core` CatalogTrack carries `releaseId`, `albumArtist`,
    // `isCompilation`, `edition`, and `discNumber`, preserving distinct editions and compilations.
    let first_obj = tracks[0].as_object().unwrap();
    let has_release_id = first_obj.contains_key("releaseId");
    let has_disc_number = first_obj.contains_key("discNumber");
    let has_is_compilation = first_obj.contains_key("isCompilation");
    println!(
        "[CORR cid_stage_p1_bug_a] CatalogTrack_keys={:?} has_releaseId={} has_discNumber={} has_isCompilation={}",
        first_obj.keys().collect::<Vec<_>>(),
        has_release_id,
        has_disc_number,
        has_is_compilation
    );
    assert!(
        has_release_id && has_disc_number && has_is_compilation,
        "CatalogTrack must expose releaseId, discNumber, and isCompilation"
    );
    let find_track = |id: &str| {
        tracks
            .iter()
            .find(|t| t["id"].as_str() == Some(id))
            .expect("seeded track present")
    };
    assert_eq!(find_track("trk_std_1")["releaseId"].as_str(), Some("rel_std_1988"));
    assert_eq!(find_track("trk_rem_1")["releaseId"].as_str(), Some("rel_rem_2015"));
    assert_eq!(find_track("trk_comp_d1")["releaseId"].as_str(), Some("rel_comp_world"));
    assert_eq!(find_track("trk_comp_d1")["isCompilation"].as_bool(), Some(true));
    assert_eq!(find_track("trk_comp_d2")["discNumber"].as_u64(), Some(2));

    node2.shutdown().unwrap();
}

#[test]
fn stage_p1_bug_b_external_hifi_rose_takeover_and_paused_reltime_sync() {
    let ws = GateWorkspace::create("repro_bug_b");
    let f_path = ws.music_dir.join("pcm.flac");
    let pcm_bytes = vec![0x42u8; 64 * 1024];
    std::fs::write(&f_path, &pcm_bytes).unwrap();

    let conn = rusqlite::Connection::open(&ws.db_path).unwrap();
    cadence_core_lib::db::schema::initialize_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES ('m_b', 'Pool', ?1, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
         VALUES ('rel_b', 'Rose Check', ?1, 'Rose Check', 'Artist', '2026-11-15T00:00:00Z')",
        rusqlite::params![ws.music_dir.to_string_lossy().as_ref()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tracks (
            id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
            file_size, mtime, title, artist_credit, album_title, track_number,
            duration_secs, format, sample_rate, bit_depth, channels, created_at
        ) VALUES ('trk_b1', 'rel_b', 'm_b', ?1, 'Rose Check', ?2, 'pcm.flac',
                  ?3, 1700000000, 'Core Track', 'Artist', 'Rose Check', 1,
                  200.0, 'FLAC', 96000, 24, 2, '2026-11-15T00:00:00Z')",
        rusqlite::params![
            ws.music_dir.to_string_lossy().as_ref(),
            f_path.to_string_lossy().as_ref(),
            pcm_bytes.len() as i64
        ],
    )
    .unwrap();
    drop(conn);

    // Pre-seed RS130 as ALREADY PLAYING externally via HiFi ROSE app before Core even connects!
    let rs130 = E2eRs130Simulator::start("uuid:rs130-repro-b");
    {
        let mut st = rs130.state.lock().unwrap();
        st.transport_state = "PLAYING".into();
        st.current_uri = "http://192.168.1.250:9000/hifi-rose/qobuz-stream.flac".into();
        st.rel_time = "00:01:21".into();
    }
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-repro-b")).unwrap();
    let locker = TestLocker::new();
    let mut rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: ws.db_path.clone(),
            engine_id: "e2e-core".into(),
            library_id: "e2e-library".into(),
            label: "E2E Core".into(),
            output: Some(Output {
                id: "rs130-repro-b".into(),
                label: "HiFi ROSE RS130".into(),
                transport: "upnp".into(),
            }),
            headroom_bytes: 16 * 1024 * 1024,
        },
        UpnpSessionConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_advertise: true,
            max_concurrent_streams: 2,
            pacer_config: CorePacerConfig::fast_for_tests(),
            target_device: desc,
        },
        ConfigurableProbe::generous(),
        locker,
    )
    .unwrap();

    // Stage P1 B.1: Idle Core reconcile surfaces pre-existing HiFi ROSE external playback & blocks silent takeover
    let idle_report = rt.reconcile_renderer().unwrap();
    let snap_idle = rt.request(&wire(json!({ "operation": "session.snapshot" })));
    let playback_obj = snap_idle["data"]["playback"].as_object().unwrap();
    let has_external_owner = playback_obj.get("takeoverRequired").and_then(Value::as_bool) == Some(true)
        && playback_obj.get("owner").and_then(Value::as_str) == Some("external")
        && playback_obj["externalPlayback"]["active"].as_bool() == Some(true);
    println!(
        "[CORR cid_stage_p1_bug_b1] idle_reconcile={:?} snapshot_activity={} has_external_owner={}",
        idle_report,
        playback_obj.get("activity").and_then(Value::as_str).unwrap_or(""),
        has_external_owner
    );
    assert!(has_external_owner, "Idle Core must expose external HiFi ROSE owner and takeoverRequired=true");

    // Unconfirmed Play must be rejected with `takeover_required` and must NOT interrupt HiFi ROSE
    rt.admit_tracks(&["trk_b1".into()]).unwrap();
    let unconfirmed_play = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk_b1",
        "commandId": "cid_p1_b_unconfirmed_play",
        "expectedRevision": snap_idle["data"]["revision"].as_u64().unwrap()
    })));
    assert_eq!(unconfirmed_play["ok"], false);
    assert_eq!(unconfirmed_play["error"]["code"], "takeover_required");
    assert_eq!(
        rs130.state.lock().unwrap().current_uri,
        "http://192.168.1.250:9000/hifi-rose/qobuz-stream.flac",
        "Unconfirmed play must leave external HiFi ROSE playback undisturbed"
    );

    // Stage P1 B.2: Confirmed forceTakeover reclaims RS130 and syncs PAUSED_PLAYBACK + RelTime
    let play_resp = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk_b1",
        "forceTakeover": true,
        "commandId": "cid_p1_b_force_play",
        "expectedRevision": snap_idle["data"]["revision"].as_u64().unwrap()
    })));
    assert_eq!(play_resp["ok"], true);
    assert_eq!(play_resp["data"]["playback"]["owner"], "core");
    assert_eq!(play_resp["data"]["playback"]["takeoverRequired"], false);
    rt.reconcile_renderer().unwrap();

    // Pause on RS130 + advance RelTime externally -> Core reconcile must sync activity='paused' & positionSeconds=81
    {
        let mut st = rs130.state.lock().unwrap();
        st.transport_state = "PAUSED_PLAYBACK".into();
        st.rel_time = "00:01:21".into();
    }
    rt.reconcile_renderer().unwrap();
    let snap_paused_sync = rt.request(&wire(json!({ "operation": "session.snapshot" })));
    let sync_activity = snap_paused_sync["data"]["playback"]["activity"].as_str().unwrap();
    let sync_pos = snap_paused_sync["data"]["playback"]["positionSeconds"].as_f64().unwrap();
    println!(
        "[CORR cid_stage_p1_bug_b2] rs130=PAUSED_PLAYBACK@00:01:21 core_activity={} core_pos={}",
        sync_activity, sync_pos
    );
    assert_eq!(sync_activity, "paused");
    assert_eq!(sync_pos, 81.0);

    // Stage P1 B.3: External takeover while Core was playing clears activity='idle', surfaces owner='external',
    // and explicit forceTakeover=true can reclaim control cleanly without requiring Stop first.
    rs130.state.lock().unwrap().current_uri = "http://other:9000/external-takeover.flac".into();
    rs130.state.lock().unwrap().transport_state = "PLAYING".into();
    let takeover_report = rt.reconcile_renderer().unwrap();
    assert_eq!(takeover_report, TransportReport::ExternalTakeover);
    let snap_after_takeover = rt.request(&wire(json!({ "operation": "session.snapshot" })));
    let takeover_activity = snap_after_takeover["data"]["playback"]["activity"].as_str().unwrap();
    println!(
        "[CORR cid_stage_p1_bug_b3] post_takeover_activity={} owner={} takeoverRequired={}",
        takeover_activity,
        snap_after_takeover["data"]["playback"]["owner"],
        snap_after_takeover["data"]["playback"]["takeoverRequired"]
    );
    assert_eq!(takeover_activity, "idle");
    assert_eq!(snap_after_takeover["data"]["playback"]["owner"], "external");
    assert_eq!(snap_after_takeover["data"]["playback"]["takeoverRequired"], true);

    let reclaim_resp = rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk_b1",
        "forceTakeover": true,
        "commandId": "cid_p1_b_reclaim",
        "expectedRevision": snap_after_takeover["data"]["revision"].as_u64().unwrap()
    })));
    assert_eq!(reclaim_resp["ok"], true);
    assert_eq!(reclaim_resp["data"]["playback"]["owner"], "core");
    assert_eq!(reclaim_resp["data"]["playback"]["takeoverRequired"], false);

    rt.shutdown().unwrap();
}
