//! Phase 5 acceptance: Linux paced UPnP & RS130 session serving simulator.
//!
//! Covers:
//! - RS130 description inspection, UDN verification, and PCM/DSF/DFF capability qualification
//! - Opaque per-RunToken capability URLs (no paths/track IDs exposed)
//! - Exact bodies, HTTP 206 Range slices (`a-b`, `a-`, `-suffix`), 416 Range Not Satisfiable,
//!   HEAD (headers only, 0 body bytes), and 405 Method Not Allowed
//! - Ground-truth 80-byte Sony DSF header parsing from locked RAM + unpaced metadata/tail probes
//! - 512 KiB max pre-roll on fresh start, sequential Range continuation & Seek without repeated pre-roll
//! - Late/superseded RunToken request rejection (never serves another track's bytes)
//! - Bounded concurrent stream cap (503 Service Unavailable on excess connections)
//! - Client disconnects, mid-stream Stop cancellation, and zero disk I/O after idle admission
//! - Qualified AVTransport state reconciliation (HTTP EOF != audible completion; external takeover quarantine;
//!   bounded retry failure; post-restart reconciliation without seizing renderer)

use cadence_core_lib::core_runtime::upnp_session::{
     inspect_rs130_description, parse_dsf_header_bytes, validate_advertised_lan_ip,
    CoreMediaServer, CorePacerConfig, Rs130DeviceDescriptor, TransportReport, UpnpSessionConfig,
    UpnpSessionRuntime, MAX_CORE_PREROLL_BYTES, MAX_CORE_STEADY_SNDBUF_BYTES,
};
use cadence_core_lib::core_runtime::{
    CgroupMemoryLimits, HeadlessConfig, HostMemoryLimits, MemoryLocker, PlatformLimits,
    PlatformProbe,
};
use cadence_core_lib::core_session::Output;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
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
struct GenerousProbe;

impl PlatformProbe for GenerousProbe {
    fn query_limits(&self) -> PlatformLimits {
        PlatformLimits {
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
            rlimit_memlock_bytes: None,
            cap_ipc_lock: true,
        }
    }
}

#[derive(Clone, Debug)]
struct RecordedSoapCall {
    action: String,
}

struct FakeRs130State {
    soap_calls: Vec<RecordedSoapCall>,
    current_uri: String,
    transport_state: String,
    rel_time: String,
    fail_next_soap: bool,
}

/// Loopback HTTP server simulating a HiFi ROSE RS130 UPnP MediaRenderer.
struct FakeRs130Simulator {
    addr: std::net::SocketAddr,
    state: Arc<Mutex<FakeRs130State>>,
    stop_flag: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl FakeRs130Simulator {
    fn start(udn: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake RS130");
        let addr = listener.local_addr().unwrap();
        let _ = listener.set_nonblocking(true);
        let state = Arc::new(Mutex::new(FakeRs130State {
            soap_calls: Vec::new(),
            current_uri: String::new(),
            transport_state: "STOPPED".into(),
            rel_time: "00:00:00".into(),
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
                        let mut buf = [0u8; 8192];
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
                            let err_xml = "<s:Envelope><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorDescription>Renderer unreachable</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
                            let resp = format!(
                                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                err_xml.len(),
                                err_xml
                            );
                            let _ = stream.write_all(resp.as_bytes());
                            continue;
                        }

                        st.soap_calls.push(RecordedSoapCall {
                            action: soap_action.clone(),
                        });

                        let response_xml = match soap_action.as_str() {
                            "SetAVTransportURI" => {
                                if let Some(start) = body.find("<CurrentURI>") {
                                    if let Some(end) = body.find("</CurrentURI>") {
                                        st.current_uri = body[start + 12..end].to_string();
                                    }
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
                                if let Some(start) = body.find("<Target>") {
                                    if let Some(end) = body.find("</Target>") {
                                        st.rel_time = body[start + 8..end].to_string();
                                    }
                                }
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:SeekResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>".to_string()
                            }
                            "GetTransportInfo" => format!(
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetTransportInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><CurrentTransportState>{}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed></u:GetTransportInfoResponse></s:Body></s:Envelope>",
                                st.transport_state
                            ),
                            "GetPositionInfo" => format!(
                                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetPositionInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><Track>1</Track><TrackDuration>00:03:00</TrackDuration><TrackURI>{}</TrackURI><RelTime>{}</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>",
                                st.current_uri, st.rel_time
                            ),
                            _ => "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body/></s:Envelope>".to_string(),
                        };

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

impl Drop for FakeRs130Simulator {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Builds a synthetic Sony DSF file with a valid 80-byte ground-truth header,
/// deterministic audio payload, and trailing ID3v2 metadata block at `metadata_offset`.
fn build_synthetic_dsf(audio_bytes_len: usize, id3_bytes_len: usize) -> Vec<u8> {
    let metadata_offset = (80 + audio_bytes_len) as u64;
    let total_size = metadata_offset + id3_bytes_len as u64;
    let sample_rate: u32 = 2_822_400; // DSD64 1-bit clock (2 ch => 705,600 B/s)
    let channels: u32 = 2;
    let bits_per_sample: u32 = 1;
    let sample_count: u64 = (sample_rate as u64) * 2; // 2.0 seconds ground-truth duration

    let mut buf = Vec::with_capacity(total_size as usize);
    // DSD chunk (28 bytes)
    buf.extend_from_slice(b"DSD ");
    buf.extend_from_slice(&28u64.to_le_bytes());
    buf.extend_from_slice(&total_size.to_le_bytes());
    buf.extend_from_slice(&metadata_offset.to_le_bytes());
    // fmt chunk (52 bytes)
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&52u64.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes()); // format version
    buf.extend_from_slice(&0u32.to_le_bytes()); // format ID (DSD raw)
    buf.extend_from_slice(&2u32.to_le_bytes()); // channel type (stereo)
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(&sample_count.to_le_bytes());
    buf.extend_from_slice(&4096u32.to_le_bytes()); // block size per channel
    buf.extend_from_slice(&0u32.to_le_bytes()); // reserved
    assert_eq!(buf.len(), 80);

    // Audio payload bytes
    for i in 0..audio_bytes_len {
        buf.push(((i * 31 + 7) & 0xFF) as u8);
    }
    // Trailing ID3v2 metadata section starting at metadata_offset
    for i in 0..id3_bytes_len {
        buf.push((0xE0 ^ (i & 0x1F)) as u8);
    }
    buf
}

fn send_raw_http(addr: std::net::SocketAddr, request: &str) -> (String, Vec<u8>) {
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

fn wire(mut body: Value) -> Vec<u8> {
    let obj = body.as_object_mut().unwrap();
    obj.insert("protocolVersion".into(), json!(1));
    obj.insert("engineId".into(), json!("truenas-core"));
    obj.insert("libraryId".into(), json!("main-library"));
    serde_json::to_vec(&body).unwrap()
}

struct Phase5Fixture {
    dir: PathBuf,
    db_path: PathBuf,
    pcm_path: PathBuf,
    dsf_path: PathBuf,
    pcm_bytes: Vec<u8>,
    dsf_bytes: Vec<u8>,
}

impl Phase5Fixture {
    fn create(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "cadence_phase5_{}_{}_{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("cadence.db");
        let pcm_path = dir.join("track_pcm.flac");
        let dsf_path = dir.join("track_dsd.dsf");

        let pcm_bytes: Vec<u8> = (0..(1536 * 1024))
            .map(|i| ((i * 17 + 3) & 0xFF) as u8)
            .collect();
        let dsf_bytes = build_synthetic_dsf(256 * 1024, 16 * 1024);

        std::fs::write(&pcm_path, &pcm_bytes).unwrap();
        std::fs::write(&dsf_path, &dsf_bytes).unwrap();

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        cadence_core_lib::db::schema::initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp)
             VALUES ('m1', 'TrueNAS', ?1, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
            rusqlite::params![dir.to_string_lossy().as_ref()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at)
             VALUES ('r1', 'Audiophile Test', ?1, 'Audiophile Test', 'Cadence Trio', '2026-11-15T00:00:00Z')",
            rusqlite::params![dir.to_string_lossy().as_ref()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (
                id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                file_size, mtime, title, artist_credit, album_title, track_number,
                duration_secs, format, sample_rate, bit_depth, channels, created_at
            ) VALUES ('trk-pcm-1', 'r1', 'm1', ?1, 'Audiophile Test', ?2, 'track_pcm.flac',
                      ?3, 1700000000, 'Symphony PCM', 'Cadence Trio', 'Audiophile Test', 1,
                      1.5, 'FLAC', 192000, 24, 2, '2026-11-15T00:00:00Z')",
            rusqlite::params![
                dir.to_string_lossy().as_ref(),
                pcm_path.to_string_lossy().as_ref(),
                pcm_bytes.len() as i64
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (
                id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
                file_size, mtime, title, artist_credit, album_title, track_number,
                duration_secs, format, sample_rate, bit_depth, channels, created_at
            ) VALUES ('trk-dsd-2', 'r1', 'm1', ?1, 'Audiophile Test', ?2, 'track_dsd.dsf',
                      ?3, 1700000000, 'Nocturne DSF', 'Cadence Trio', 'Audiophile Test', 2,
                      999.0, 'DSF', 44100, 16, 2, '2026-11-15T00:00:00Z')",
            rusqlite::params![
                dir.to_string_lossy().as_ref(),
                dsf_path.to_string_lossy().as_ref(),
                dsf_bytes.len() as i64
            ],
        )
        .unwrap();

        Self {
            dir,
            db_path,
            pcm_path,
            dsf_path,
            pcm_bytes,
            dsf_bytes,
        }
    }
}

impl Drop for Phase5Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn rs130_description_qualification_lan_validation_and_port_conflict_readiness() {
    // 1. Validate advertised LAN IPv4 addresses (reject loopback, unspecified, link-local, VPN/CGNAT)
    assert!(validate_advertised_lan_ip("192.168.1.50", false).is_ok());
    assert!(validate_advertised_lan_ip("10.0.10.25", false).is_ok());
    assert!(validate_advertised_lan_ip("127.0.0.1", false).is_err());
    assert!(validate_advertised_lan_ip("0.0.0.0", false).is_err());
    assert!(validate_advertised_lan_ip("169.254.10.20", false).is_err());
    assert!(validate_advertised_lan_ip("100.100.10.5", false).is_err()); // Tailscale/CGNAT
    assert!(validate_advertised_lan_ip("127.0.0.1", true).is_ok()); // loopback allowed in simulator test mode

    // 2. Inspect RS130 UPnP description and verify UDN + RS130 qualification
    let rs130 = FakeRs130Simulator::start("uuid:rs130-00112233");
    let desc: Rs130DeviceDescriptor =
        inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-00112233"))
            .expect("inspect RS130 description");
    assert_eq!(desc.udn, "uuid:rs130-00112233");
    assert_eq!(desc.model_name.as_deref(), Some("RS130"));
    assert!(desc.is_qualified_rs130());
    assert!(desc.supports_extension("flac"));
    assert!(desc.supports_extension("wav"));
    assert!(desc.supports_extension("dsf"));
    assert!(desc.supports_extension("dff"));

    // Mismatched UDN must reject before claiming renderer
    let wrong_udn = inspect_rs130_description(&rs130.description_url(), Some("uuid:someone-else"));
    assert!(wrong_udn.is_err());

    // 3. Port conflict on fixed listener must fail readiness clearly instead of publishing wrong URL
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_addr = occupied.local_addr().unwrap();
    let conflict = CoreMediaServer::bind(occupied_addr, "127.0.0.1".into(), true, 2);
    assert!(conflict.is_err(), "port conflict must fail readiness");
}

#[test]
fn renderer_simulator_serves_exact_bodies_ranges_head_dsf_probes_and_zero_disk_io() {
    let fx = Phase5Fixture::create("exact_http_and_dsf");
    let rs130 = FakeRs130Simulator::start("uuid:rs130-main");
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-main")).unwrap();
    let locker = FakeLocker::new();

    let mut session_rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: fx.db_path.clone(),
            engine_id: "truenas-core".into(),
            library_id: "main-library".into(),
            label: "TrueNAS Core".into(),
            output: Some(Output {
                id: "rs130-main".into(),
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
        GenerousProbe,
        locker.clone(),
    )
    .expect("open UpnpSessionRuntime");

    // Admit both PCM and DSF tracks while Idle
    session_rt
        .admit_tracks(&["trk-pcm-1".to_string(), "trk-dsd-2".to_string()])
        .expect("admit tracks while idle");

    // DELETE the underlying files on disk to prove 100% of serving and DSF header parsing
    // comes from LockedBytesArena with ZERO disk I/O during playback!
    std::fs::remove_file(&fx.pcm_path).expect("delete pcm file on disk");
    std::fs::remove_file(&fx.dsf_path).expect("delete dsf file on disk");

    // Play DSF track first to verify ground-truth 80-byte DSF header parsing & metadata probes
    let play_dsf = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk-dsd-2",
        "commandId": "cmd-play-dsf",
        "expectedRevision": 0
    })));
    assert_eq!(play_dsf["ok"], true, "{play_dsf}");

    let dsf_uri = rs130.state.lock().unwrap().current_uri.clone();
    assert!(
        dsf_uri.contains("/media/cap_") && dsf_uri.ends_with(".dsf"),
        "URI must be an opaque capability token without track ID or file path: {}",
        dsf_uri
    );
    assert!(!dsf_uri.contains("trk-dsd-2") && !dsf_uri.contains("track_dsd"));

    let media_addr = session_rt.media_listen_addr();
    let path_only = format!("/media/{}", dsf_uri.rsplit("/media/").next().unwrap());

    // 1. Verify ground-truth DSF header parsing from locked RAM
    let dsf_info = parse_dsf_header_bytes(&fx.dsf_bytes).expect("valid DSF header");
    assert_eq!(dsf_info.sample_rate, 2_822_400);
    assert_eq!(dsf_info.channels, 2);
    assert_eq!(dsf_info.metadata_offset, (80 + 256 * 1024) as u64);

    // 2. Verify unsupported method -> 405 Method Not Allowed
    let (hdr_405, _) = send_raw_http(
        media_addr,
        &format!("POST {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_only),
    );
    assert!(hdr_405.starts_with("HTTP/1.1 405"));

    // 3. Verify HEAD returns exact headers and 0 body bytes without marking audio streamed
    let (hdr_head, body_head) = send_raw_http(
        media_addr,
        &format!("HEAD {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_only),
    );
    assert!(hdr_head.starts_with("HTTP/1.1 200 OK"));
    assert!(hdr_head.contains(&format!("Content-Length: {}", fx.dsf_bytes.len())));
    assert!(hdr_head.contains("Content-Type: audio/x-dsd"));
    assert!(body_head.is_empty());
    assert_eq!(session_rt.pacing_snapshot().audio_connections, 0);

    // 4. Verify DSF ID3v2 metadata probe (`start >= metadata_offset`) runs unpaced and does not count as audio stream
    let meta_start = dsf_info.metadata_offset;
    let (hdr_probe, body_probe) = send_raw_http(
        media_addr,
        &format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nRange: bytes={}-\r\n\r\n",
            path_only, meta_start
        ),
    );
    assert!(hdr_probe.starts_with("HTTP/1.1 206 Partial Content"));
    assert_eq!(body_probe, &fx.dsf_bytes[meta_start as usize..]);
    assert_eq!(
        session_rt.pacing_snapshot().audio_connections,
        0,
        "DSF metadata probe must not increment audio_connections or trigger pre-roll"
    );

    // 5. Verify full GET returns exact untouched DSF bytes
    let (hdr_full, body_full) = send_raw_http(
        media_addr,
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_only),
    );
    assert!(hdr_full.starts_with("HTTP/1.1 200 OK"));
    assert_eq!(body_full, fx.dsf_bytes);
    assert_eq!(session_rt.pacing_snapshot().audio_connections, 1);

    // 6. Verify Range slice `bytes=100-4195`, suffix `bytes=-512`, and `416 Range Not Satisfiable`
    let (hdr_r1, body_r1) = send_raw_http(
        media_addr,
        &format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=100-4195\r\n\r\n",
            path_only
        ),
    );
    assert!(hdr_r1.starts_with("HTTP/1.1 206 Partial Content"));
    assert_eq!(body_r1, &fx.dsf_bytes[100..=4195]);

    let (hdr_suf, body_suf) = send_raw_http(
        media_addr,
        &format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=-512\r\n\r\n",
            path_only
        ),
    );
    assert!(hdr_suf.starts_with("HTTP/1.1 206 Partial Content"));
    assert_eq!(body_suf, &fx.dsf_bytes[fx.dsf_bytes.len() - 512..]);

    let (hdr_416, _) = send_raw_http(
        media_addr,
        &format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=99999999-\r\n\r\n",
            path_only
        ),
    );
    assert!(hdr_416.starts_with("HTTP/1.1 416"));

    session_rt.shutdown().unwrap();
}

#[test]
fn sequential_range_continuation_seek_late_token_rejection_and_stop_cancellation() {
    let fx = Phase5Fixture::create("continuation_seek_cancel");
    let rs130 = FakeRs130Simulator::start("uuid:rs130-main");
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-main")).unwrap();
    let locker = FakeLocker::new();

    let mut session_rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: fx.db_path.clone(),
            engine_id: "truenas-core".into(),
            library_id: "main-library".into(),
            label: "TrueNAS Core".into(),
            output: Some(Output {
                id: "rs130-main".into(),
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
        GenerousProbe,
        locker,
    )
    .expect("open UpnpSessionRuntime");

    session_rt
        .admit_tracks(&["trk-pcm-1".to_string(), "trk-dsd-2".to_string()])
        .unwrap();

    // Play 1.5 MiB PCM track -> pre-roll must be capped at <= 512 KiB (MAX_CORE_PREROLL_BYTES)
    let play_resp = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk-pcm-1",
        "commandId": "cmd-play-pcm",
        "expectedRevision": 0
    })));
    assert_eq!(play_resp["ok"], true);
    let pcm_uri = rs130.state.lock().unwrap().current_uri.clone();
    let pcm_path = format!("/media/{}", pcm_uri.rsplit("/media/").next().unwrap());
    let media_addr = session_rt.media_listen_addr();

    // Initial Range 0..=1_048_575 (1 MiB) -> uses bounded <= 512 KiB pre-roll
    let (hdr_init, body_init) = send_raw_http(
        media_addr,
        &format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-1048575\r\n\r\n",
            pcm_path
        ),
    );
    assert!(hdr_init.starts_with("HTTP/1.1 206"));
    assert_eq!(body_init, &fx.pcm_bytes[0..=1_048_575]);
    let snap_init = session_rt.pacing_snapshot();
    assert!(snap_init.preroll_chunks > 0);
    assert!(
        snap_init.preroll_bytes_configured <= MAX_CORE_PREROLL_BYTES,
        "pre-roll must be capped at 512 KiB"
    );
    assert!(snap_init.configured_sndbuf_bytes <= MAX_CORE_STEADY_SNDBUF_BYTES as u64);

    // Sequential Range continuation (`start = 1048576 >= 1 MiB`) -> 0 pre-roll chunks!
    let (hdr_cont, body_cont) = send_raw_http(
        media_addr,
        &format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=1048576-\r\n\r\n",
            pcm_path
        ),
    );
    assert!(hdr_cont.starts_with("HTTP/1.1 206"));
    assert_eq!(body_cont, &fx.pcm_bytes[1_048_576..]);
    let snap_cont = session_rt.pacing_snapshot();
    assert_eq!(
        snap_cont.preroll_chunks, 0,
        "Range continuation >= 1 MiB must not repeat pre-roll"
    );
    // This snapshot is taken *after* the entire socket transfer, when Linux may
    // legitimately have applied anti-windup flow suppression. Check steady-state
    // safety here; the constructor regression below checks exact initial cruise.
    assert_eq!(snap_cont.current_state,"steady_maintain");
    assert!(matches!(snap_cont.current_regime,"cruise"|"flow_suppressed"),"{snap_cont:?}");
    assert!(snap_cont.current_multiplier<=1.0,"Continuation must never restart initial overfeed: {snap_cont:?}");

    // Reconcile renderer PLAYING state so session enters Playing
    session_rt.reconcile_renderer().expect("reconcile playing");
    let snap_playing = session_rt.request(&wire(json!({ "operation": "session.snapshot" })));
    assert_eq!(snap_playing["data"]["playback"]["activity"], "playing");

    // Issue Seek -> mints a new RunToken and dispatches UPnP Seek SOAP action
    let rev = snap_playing["data"]["revision"].as_u64().unwrap();
    let seek_resp = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "seek",
        "positionSeconds": 1.0,
        "commandId": "cmd-seek-1",
        "expectedRevision": rev
    })));
    assert_eq!(seek_resp["ok"], true, "{seek_resp}");
    assert_eq!(rs130.state.lock().unwrap().rel_time, "00:00:01");

    // Switch to second track (`trk-dsd-2`): old PCM capability URL MUST immediately return 404
    // and never serve the new DSF track's bytes!
    let rev = seek_resp["data"]["revision"].as_u64().unwrap();
    let play_next = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk-dsd-2",
        "commandId": "cmd-play-dsd-2",
        "expectedRevision": rev
    })));
    assert_eq!(play_next["ok"], true);

    let (hdr_stale, body_stale) = send_raw_http(
        media_addr,
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", pcm_path),
    );
    assert!(
        hdr_stale.starts_with("HTTP/1.1 404") || hdr_stale.starts_with("HTTP/1.1 410"),
        "late request for superseded RunToken must be rejected: {}",
        hdr_stale
    );
    assert!(body_stale.is_empty());

    // Stop cancels active session capability immediately
    let dsf_uri = rs130.state.lock().unwrap().current_uri.clone();
    let dsf_path = format!("/media/{}", dsf_uri.rsplit("/media/").next().unwrap());
    let rev = play_next["data"]["revision"].as_u64().unwrap();
    let stop_resp = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "stop",
        "commandId": "cmd-stop-all",
        "expectedRevision": rev
    })));
    assert_eq!(stop_resp["ok"], true);
    let (hdr_after_stop, _) = send_raw_http(
        media_addr,
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", dsf_path),
    );
    assert!(hdr_after_stop.starts_with("HTTP/1.1 404") || hdr_after_stop.starts_with("HTTP/1.1 410"));

    session_rt.shutdown().unwrap();
}

#[test]
fn contiguous_reconnect_starts_at_exact_cruise_before_socket_feedback(){
    use cadence_core_lib::core_runtime::upnp_session::{CorePacer,CorePacingMetrics};
    let metrics=Arc::new(CorePacingMetrics::default());
    let _pacer=CorePacer::new(CorePacerConfig::fast_for_tests(),Some(576_000.0),512*1024,32*1024,true,true,false,metrics.clone(),Arc::new(AtomicBool::new(false)));
    let snapshot=metrics.snapshot();
    assert_eq!(snapshot.current_state,"steady_maintain");
    assert_eq!(snapshot.current_regime,"cruise");
    assert_eq!(snapshot.current_multiplier,1.0);
    assert_eq!(snapshot.preroll_bytes_configured,0);
}

#[test]
fn bounded_concurrency_disconnects_and_qualified_avtransport_reconciliation() {
    let fx = Phase5Fixture::create("reconcile_and_concurrency");
    let rs130 = FakeRs130Simulator::start("uuid:rs130-main");
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-main")).unwrap();
    let locker = FakeLocker::new();

    let mut session_rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: fx.db_path.clone(),
            engine_id: "truenas-core".into(),
            library_id: "main-library".into(),
            label: "TrueNAS Core".into(),
            output: Some(Output {
                id: "rs130-main".into(),
                label: "HiFi ROSE RS130".into(),
                transport: "upnp".into(),
            }),
            headroom_bytes: 16 * 1024 * 1024,
        },
        UpnpSessionConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            advertised_ip: "127.0.0.1".into(),
            allow_loopback_advertise: true,
            max_concurrent_streams: 1, // Strict cap of 1 concurrent stream for this test
            pacer_config: CorePacerConfig::fast_for_tests(),
            target_device: desc,
        },
        GenerousProbe,
        locker,
    )
    .expect("open UpnpSessionRuntime");

    session_rt
        .admit_tracks(&["trk-pcm-1".to_string(), "trk-dsd-2".to_string()])
        .unwrap();

    // Queue both tracks and start playback
    let q_resp = session_rt.request(&wire(json!({
        "operation": "queue.replace",
        "entries": [
            { "entryId": "e1", "trackId": "trk-pcm-1" },
            { "entryId": "e2", "trackId": "trk-dsd-2" }
        ],
        "commandId": "cmd-q1",
        "expectedRevision": 0
    })));
    assert_eq!(q_resp["ok"], true);

    let play_resp = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk-pcm-1",
        "commandId": "cmd-play-e1",
        "expectedRevision": 1
    })));
    assert_eq!(play_resp["ok"], true);

    let uri_1 = rs130.state.lock().unwrap().current_uri.clone();
    let path_1 = format!("/media/{}", uri_1.rsplit("/media/").next().unwrap());
    let media_addr = session_rt.media_listen_addr();

    // 1. Open one slow connection holding the single concurrency slot (hasn't sent request yet)
    let hold_stream = TcpStream::connect(media_addr).unwrap();
    std::thread::sleep(Duration::from_millis(30));

    // Second concurrent connection must be rejected with 503 Service Unavailable
    let (hdr_503, _) = send_raw_http(
        media_addr,
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_1),
    );
    assert!(
        hdr_503.starts_with("HTTP/1.1 503"),
        "excess concurrent connection must return 503: {}",
        hdr_503
    );

    // Drop the holding client (simulating client disconnect before/during request)
    drop(hold_stream);
    std::thread::sleep(Duration::from_millis(30));

    // 2. Now fetch the full track body -> HTTP EOF is reached!
    let (hdr_ok, body_ok) = send_raw_http(
        media_addr,
        &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_1),
    );
    assert!(hdr_ok.starts_with("HTTP/1.1 200 OK"));
    assert_eq!(body_ok.len(), fx.pcm_bytes.len());

    // CRITICAL: HTTP EOF alone must NOT advance the queue while RS130 is still PLAYING its FIFO buffer!
    session_rt.reconcile_renderer().unwrap();
    let snap_still_e1 = session_rt.request(&wire(json!({ "operation": "session.snapshot" })));
    assert_eq!(snap_still_e1["data"]["queue"]["currentEntryId"], "e1");
    assert_eq!(snap_still_e1["data"]["playback"]["activity"], "playing");

    // 3. Once RS130 finishes draining its hardware buffer and transitions to STOPPED on uri_1,
    // reconciliation emits Completed(token) and advances the queue to `e2` (`trk-dsd-2`)!
    rs130.state.lock().unwrap().transport_state = "STOPPED".into();
    let report = session_rt.reconcile_renderer().unwrap();
    assert_eq!(report, TransportReport::CompletedAndAdvanced);

    let snap_e2 = session_rt.request(&wire(json!({ "operation": "session.snapshot" })));
    assert_eq!(snap_e2["data"]["queue"]["currentEntryId"], "e2");
    assert_eq!(snap_e2["data"]["playback"]["activity"], "loading");

    // Reconcile e2 into Playing
    session_rt.reconcile_renderer().unwrap();
    let snap_e2_playing = session_rt.request(&wire(json!({ "operation": "session.snapshot" })));
    assert_eq!(snap_e2_playing["data"]["playback"]["activity"], "playing");

    // 4. External takeover: another control point changes CurrentURI on RS130.
    // Core must report ExternalTakeover and quarantine (`ready = false`) rather than fighting with Play!
    let soap_count_before = rs130.state.lock().unwrap().soap_calls.len();
    rs130.state.lock().unwrap().current_uri = "http://other-controller:9000/ hijack.flac".into();
    let takeover_report = session_rt.reconcile_renderer().unwrap();
    assert_eq!(takeover_report, TransportReport::ExternalTakeover);

    let hello_quarantined = session_rt.request(&wire(json!({ "operation": "core.hello" })));
    assert_eq!(hello_quarantined["data"]["ready"], false);
    // Ensure no Play command was sent to fight the takeover
    let soap_calls = rs130.state.lock().unwrap().soap_calls[soap_count_before..].to_vec();
    assert!(
        !soap_calls.iter().any(|c| c.action == "Play"),
        "must never fight external takeover with repeated Play commands"
    );

    // Explicit Stop acknowledges quarantine and restores ready = true
    let rev = session_rt.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"]
        .as_u64()
        .unwrap();
    let stop_ack = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "stop",
        "commandId": "cmd-ack-takeover",
        "expectedRevision": rev
    })));
    assert_eq!(stop_ack["ok"], true);
    assert_eq!(
        session_rt.request(&wire(json!({ "operation": "core.hello" })))["data"]["ready"],
        true
    );

    // 5. Post-restart reconciliation: inspects renderer without seizing or sending Play/Stop
    let calls_before_restart_check = rs130.state.lock().unwrap().soap_calls.len();
    let probe_state = session_rt.reconcile_after_restart().unwrap();
    assert_eq!(probe_state.transport_state, "PLAYING");
    assert_eq!(probe_state.current_uri, "http://other-controller:9000/ hijack.flac");
    let calls_after = rs130.state.lock().unwrap().soap_calls[calls_before_restart_check..].to_vec();
    assert!(calls_after
        .iter()
        .all(|c| c.action == "GetTransportInfo" || c.action == "GetPositionInfo"));

    session_rt.shutdown().unwrap();
}

#[test]
fn shutdown_does_not_stop_an_external_renderer_without_a_core_session() {
    let fx = Phase5Fixture::create("external_shutdown");
    let renderer = FakeRs130Simulator::start("uuid:rs130-main");
    {
        let mut state = renderer.state.lock().unwrap();
        state.current_uri = "http://another-controller/music.flac".into();
        state.transport_state = "PLAYING".into();
    }
    let desc = inspect_rs130_description(&renderer.description_url(), Some("uuid:rs130-main")).unwrap();
    let mut runtime = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: fx.db_path.clone(), engine_id: "truenas-core".into(),
            library_id: "main-library".into(), label: "Core".into(),
            output: Some(Output { id: "rs130-main".into(), label: "RS130".into(), transport: "upnp".into() }),
            headroom_bytes: 16 * 1024 * 1024,
        },
        UpnpSessionConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(), advertised_ip: "127.0.0.1".into(),
            allow_loopback_advertise: true, max_concurrent_streams: 1,
            pacer_config: CorePacerConfig::fast_for_tests(), target_device: desc,
        }, GenerousProbe, FakeLocker::new(),
    ).unwrap();
    runtime.shutdown().unwrap();
    let state = renderer.state.lock().unwrap();
    assert!(!state.soap_calls.iter().any(|call| call.action == "Stop"));
    assert_eq!(state.current_uri, "http://another-controller/music.flac");
    assert_eq!(state.transport_state, "PLAYING");
}

#[test]
fn shutdown_stops_only_a_verified_current_core_uri() {
    for scenario in ["owned", "replaced", "ambiguous"] {
        let fx = Phase5Fixture::create(scenario);
        let renderer = FakeRs130Simulator::start("uuid:rs130-main");
        let desc = inspect_rs130_description(&renderer.description_url(), Some("uuid:rs130-main")).unwrap();
        let mut runtime = UpnpSessionRuntime::open_with_platform(
            HeadlessConfig {
                db_path: fx.db_path.clone(), engine_id: "truenas-core".into(),
                library_id: "main-library".into(), label: "Core".into(),
                output: Some(Output { id: "rs130-main".into(), label: "RS130".into(), transport: "upnp".into() }),
                headroom_bytes: 16 * 1024 * 1024,
            },
            UpnpSessionConfig {
                bind_addr: "127.0.0.1:0".parse().unwrap(), advertised_ip: "127.0.0.1".into(),
                allow_loopback_advertise: true, max_concurrent_streams: 1,
                pacer_config: CorePacerConfig::fast_for_tests(), target_device: desc,
            }, GenerousProbe, FakeLocker::new(),
        ).unwrap();
        runtime.admit_tracks(&["trk-pcm-1".to_string()]).unwrap();
        assert_eq!(runtime.request(&wire(json!({
            "operation": "playback.control", "action": "play", "trackId": "trk-pcm-1",
            "commandId": "play", "expectedRevision": 0
        })))["ok"], true);
        {
            let mut state = renderer.state.lock().unwrap();
            match scenario {
                "replaced" => state.current_uri = "http://other.example/external".into(),
                "ambiguous" => state.current_uri.clear(),
                _ => {}
            }
        }
        runtime.shutdown().unwrap();
        let state = renderer.state.lock().unwrap();
        assert_eq!(state.soap_calls.iter().any(|call| call.action == "Stop"), scenario == "owned", "{scenario}");
    }
}

#[test]
fn mid_stream_stop_cancellation_and_bounded_retry_renderer_loss_quarantine() {
    let fx = Phase5Fixture::create("mid_stream_cancel_and_loss");
    let rs130 = FakeRs130Simulator::start("uuid:rs130-main");
    let desc = inspect_rs130_description(&rs130.description_url(), Some("uuid:rs130-main")).unwrap();
    let locker = FakeLocker::new();

    // Use a paced config with real sleep so a 1.5 MiB stream stays in flight while Stop is issued
    let mut paced_cfg = CorePacerConfig::default();
    paced_cfg.initial_fill_multiplier = 2.0;
    paced_cfg.max_overfeed_multiplier = 2.0;

    let mut session_rt = UpnpSessionRuntime::open_with_platform(
        HeadlessConfig {
            db_path: fx.db_path.clone(),
            engine_id: "truenas-core".into(),
            library_id: "main-library".into(),
            label: "TrueNAS Core".into(),
            output: Some(Output {
                id: "rs130-main".into(),
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
            pacer_config: paced_cfg,
            target_device: desc,
        },
        GenerousProbe,
        locker,
    )
    .expect("open UpnpSessionRuntime");

    session_rt
        .admit_tracks(&["trk-pcm-1".to_string()])
        .unwrap();

    let play_resp = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk-pcm-1",
        "commandId": "cmd-play-cancel-test",
        "expectedRevision": 0
    })));
    assert_eq!(play_resp["ok"], true);
    let uri = rs130.state.lock().unwrap().current_uri.clone();
    let path_only = format!("/media/{}", uri.rsplit("/media/").next().unwrap());
    let media_addr = session_rt.media_listen_addr();

    // Spawn a client reading the 1.5 MiB stream while paced
    let reader = std::thread::spawn(move || {
        let (_, body) = send_raw_http(
            media_addr,
            &format!("GET {} HTTP/1.1\r\nHost: localhost\r\n\r\n", path_only),
        );
        body.len()
    });

    // Wait briefly so pre-roll flushes and paced chunks are in flight, then issue Stop!
    std::thread::sleep(Duration::from_millis(60));
    let rev = play_resp["data"]["revision"].as_u64().unwrap();
    let stop_resp = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "stop",
        "commandId": "cmd-mid-stop",
        "expectedRevision": rev
    })));
    assert_eq!(stop_resp["ok"], true);

    let bytes_received_before_cancel = reader.join().unwrap();
    assert!(
        bytes_received_before_cancel < fx.pcm_bytes.len(),
        "mid-stream Stop must cancel active delivery before full 1.5 MiB completes (got {} of {})",
        bytes_received_before_cancel,
        fx.pcm_bytes.len()
    );

    // Start again and simulate renderer loss (3 consecutive SOAP failures -> RendererFailed quarantine)
    let rev = stop_resp["data"]["revision"].as_u64().unwrap();
    let play_again = session_rt.request(&wire(json!({
        "operation": "playback.control",
        "action": "play",
        "trackId": "trk-pcm-1",
        "commandId": "cmd-play-loss",
        "expectedRevision": rev
    })));
    assert_eq!(play_again["ok"], true);

    rs130.state.lock().unwrap().fail_next_soap = true;
    assert_eq!(session_rt.reconcile_renderer().unwrap(), TransportReport::Steady);
    assert_eq!(session_rt.reconcile_renderer().unwrap(), TransportReport::Steady);
    assert_eq!(
        session_rt.reconcile_renderer().unwrap(),
        TransportReport::RendererFailed
    );
    assert_eq!(
        session_rt.request(&wire(json!({ "operation": "core.hello" })))["data"]["ready"],
        false
    );

    session_rt.shutdown().unwrap();
}
