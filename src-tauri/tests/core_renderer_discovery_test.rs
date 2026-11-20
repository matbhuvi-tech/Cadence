//! Portable Core Slice 1 acceptance: authenticated, bounded, read-only UPnP renderer
//! discovery. Fixtures are real loopback TCP "renderers" that log every request so the
//! tests can prove discovery never issues a playback mutation.

use cadence_core_lib::core_runtime::dragonfish::{DragonfishConfig, DragonfishNode, DRAGONFISH_SCHEMA_VERSION};
use cadence_core_lib::core_runtime::renderer_discovery::{
    discover_with, DestinationPolicy, DiscoveryLimits, DiscoveryReport, RendererDiscovery, Reject, SsdpAnnouncement,
    SsdpRendererDiscovery, SsdpSource, Support, MAX_HTTP_RESPONSE_BYTES, MIN_DISCOVERY_INTERVAL,
};
use cadence_core_lib::core_runtime::{
    CgroupMemoryLimits, HeadlessConfig, HeadlessCoreRuntime, HostMemoryLimits, MemoryLocker, PlatformLimits,
    PlatformProbe, COOLDOWN_DURATION,
};
use cadence_core_lib::core_session::{Output, Renderer, RendererAction, RendererError, RendererEvent};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- renderer fixture

#[derive(Clone, Copy, PartialEq)]
enum Behavior {
    Normal,
    Redirect,
    Oversize,
    Hang,
    Garbage,
}

#[derive(Clone)]
struct Spec {
    udn: String,
    name: String,
    device_type: &'static str,
    av_transport: bool,
    connection_manager: bool,
    sink: Option<&'static str>,
    behavior: Behavior,
}

impl Spec {
    fn new(udn: &str, name: &str) -> Self {
        Self {
            udn: udn.into(),
            name: name.into(),
            device_type: "urn:schemas-upnp-org:device:MediaRenderer:1",
            av_transport: true,
            connection_manager: true,
            sink: Some("http-get:*:audio/flac:*,http-get:*:audio/x-dsd:*"),
            behavior: Behavior::Normal,
        }
    }
    fn description(&self) -> String {
        let mut services = String::new();
        if self.av_transport {
            services.push_str("<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service>");
        }
        if self.connection_manager {
            services.push_str("<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service>");
        }
        format!(
            "<?xml version=\"1.0\"?><root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>{}</deviceType><friendlyName>{}</friendlyName><manufacturer>Fixture</manufacturer><modelName>FX</modelName><UDN>{}</UDN><serviceList>{}</serviceList></device></root>",
            self.device_type, self.name, self.udn, services
        )
    }
}

struct Fixture {
    addr: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Fixture {
    fn start(spec: Spec) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log2, stop2) = (log.clone(), stop.clone());
        let join = std::thread::spawn(move || {
            while !stop2.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (spec, log, stop) = (spec.clone(), log2.clone(), stop2.clone());
                        std::thread::spawn(move || serve(stream, spec, log, stop));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self { addr, log, stop, join: Some(join) }
    }
    fn announcement(&self) -> SsdpAnnouncement {
        SsdpAnnouncement {
            source: IpAddr::V4("127.0.0.1".parse().unwrap()),
            location: format!("http://{}/desc.xml", self.addr),
        }
    }
    fn requests(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

fn serve(mut stream: TcpStream, spec: Spec, log: Arc<Mutex<Vec<String>>>, stop: Arc<AtomicBool>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut raw = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        raw.extend_from_slice(&buf[..n]);
        if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..end]).to_string();
            let len = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                .unwrap_or(0);
            if raw.len() >= end + 4 + len {
                break;
            }
        }
    }
    let head = String::from_utf8_lossy(&raw).to_string();
    let first = head.lines().next().unwrap_or("").to_string();
    let soap = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("soapaction:"))
        .unwrap_or("")
        .to_string();
    log.lock().unwrap().push(format!("{first} | {soap}"));

    let respond = |stream: &mut TcpStream, status: &str, extra: &str, body: &[u8]| {
        let h = format!("HTTP/1.1 {status}\r\nContent-Type: text/xml\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        let _ = stream.write_all(h.as_bytes());
        let _ = stream.write_all(body);
    };
    match spec.behavior {
        Behavior::Hang => {
            while !stop.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Behavior::Redirect => respond(&mut stream, "302 Found", "Location: http://192.168.1.1/x\r\n", b""),
        Behavior::Garbage => respond(&mut stream, "200 OK", "", b"this is not xml at all"),
        Behavior::Oversize => respond(&mut stream, "200 OK", "", &vec![b'a'; MAX_HTTP_RESPONSE_BYTES + 1024]),
        Behavior::Normal => {
            if first.starts_with("GET /desc.xml") {
                respond(&mut stream, "200 OK", "", spec.description().as_bytes());
            } else if first.starts_with("POST /cm") {
                let sink = spec.sink.unwrap_or("");
                let body = format!(
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetProtocolInfoResponse><Source></Source><Sink>{sink}</Sink></u:GetProtocolInfoResponse></s:Body></s:Envelope>"
                );
                respond(&mut stream, "200 OK", "", body.as_bytes());
            } else {
                respond(&mut stream, "404 Not Found", "", b"");
            }
        }
    }
}

struct FakeSsdp(Vec<SsdpAnnouncement>);
impl SsdpSource for FakeSsdp {
    fn search(&mut self, _window: Duration) -> Vec<SsdpAnnouncement> {
        self.0.clone()
    }
}

fn test_limits() -> DiscoveryLimits {
    DiscoveryLimits {
        ssdp_window: Duration::from_millis(10),
        io_timeout: Duration::from_millis(400),
        total_deadline: Duration::from_secs(3),
        max_candidates: 16,
    }
}
const LOOPBACK: DestinationPolicy = DestinationPolicy { allow_loopback: true };

fn run(fixtures: &[&Fixture]) -> DiscoveryReport {
    let mut source = FakeSsdp(fixtures.iter().map(|f| f.announcement()).collect());
    discover_with(&mut source, LOOPBACK, &test_limits())
}

/// A request is a playback mutation if it targets AVTransport or is any SOAP action
/// other than the read-only ConnectionManager GetProtocolInfo.
fn assert_read_only(fixture: &Fixture) {
    for line in fixture.requests() {
        let is_description = line.starts_with("GET /desc.xml");
        let is_protocol_info = line.starts_with("POST /cm") && line.contains("ConnectionManager:1#GetProtocolInfo");
        assert!(is_description || is_protocol_info, "unexpected request to renderer: {line}");
        assert!(!line.contains("AVTransport") && !line.starts_with("POST /av"), "transport request: {line}");
    }
}

// ---------------------------------------------------------------- discovery tests

#[test]
fn multiple_renderers_report_udn_and_three_state_capability_without_transport_mutation() {
    let full = Fixture::start(Spec::new("uuid:full", "Studio"));
    let mut pcm_spec = Spec::new("uuid:pcm", "Kitchen");
    pcm_spec.sink = Some("http-get:*:audio/flac:*,http-get:*:audio/mpeg:*");
    let pcm = Fixture::start(pcm_spec);
    let mut nocm_spec = Spec::new("uuid:nocm", "Attic");
    nocm_spec.connection_manager = false;
    let nocm = Fixture::start(nocm_spec);
    let mut wild_spec = Spec::new("uuid:wild", "Garage");
    wild_spec.sink = Some("http-get:*:*:*");
    let wild = Fixture::start(wild_spec);

    let report = run(&[&full, &pcm, &nocm, &wild]);
    assert_eq!(report.rejected_total(), 0, "{report:?}");
    let labels: Vec<_> = report.renderers.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels, ["Attic", "Garage", "Kitchen", "Studio"], "sorted deterministically");

    let by = |udn: &str| report.renderers.iter().find(|r| r.udn == udn).unwrap();
    let studio = by("uuid:full");
    assert_eq!((studio.capability.pcm, studio.capability.dsd), (Support::Supported, Support::Supported));
    assert!(studio.capability.from_sink_protocol_info && studio.connection_manager);
    let kitchen = by("uuid:pcm");
    assert_eq!((kitchen.capability.pcm, kitchen.capability.dsd), (Support::Supported, Support::Unsupported));
    let attic = by("uuid:nocm");
    assert_eq!((attic.capability.pcm, attic.capability.dsd), (Support::Unknown, Support::Unknown));
    assert!(!attic.capability.from_sink_protocol_info && !attic.connection_manager);
    let garage = by("uuid:wild");
    assert_eq!((garage.capability.pcm, garage.capability.dsd), (Support::Unknown, Support::Unknown));

    for f in [&full, &pcm, &nocm, &wild] {
        assert_read_only(f);
    }
    // Absence of evidence is never reported as support.
    assert!(nocm.requests().iter().all(|r| !r.starts_with("POST")));

    let rendered = report.to_json();
    assert_eq!(rendered["renderers"][3]["capability"]["dsd"], "supported");
    assert_eq!(rendered["renderers"][0]["capability"]["evidence"], "none");
    assert!(!rendered.to_string().contains("127.0.0.1"), "no addresses are exposed to controllers");
}

#[test]
fn malformed_and_hostile_renderers_are_rejected_with_reasons() {
    let mut not_renderer = Spec::new("uuid:server", "Not a renderer");
    not_renderer.device_type = "urn:schemas-upnp-org:device:MediaServer:1";
    let mut bad_udn = Spec::new("not-a-udn", "Bad UDN");
    bad_udn.udn = "not-a-udn".into();
    let mut no_av = Spec::new("uuid:noav", "No AVTransport");
    no_av.av_transport = false;
    let mut redirect = Spec::new("uuid:redir", "Redirect");
    redirect.behavior = Behavior::Redirect;
    let mut oversize = Spec::new("uuid:big", "Oversize");
    oversize.behavior = Behavior::Oversize;
    let mut garbage = Spec::new("uuid:garbage", "Garbage");
    garbage.behavior = Behavior::Garbage;
    let good = Fixture::start(Spec::new("uuid:good", "Good"));
    let hostile: Vec<Fixture> = [not_renderer, bad_udn, no_av, redirect, oversize, garbage]
        .into_iter()
        .map(Fixture::start)
        .collect();

    let mut all: Vec<&Fixture> = hostile.iter().collect();
    all.push(&good);
    let report = run(&all);
    assert_eq!(report.renderers.len(), 1, "{report:?}");
    assert_eq!(report.renderers[0].udn, "uuid:good");
    assert_eq!(report.rejected_total(), 6);
    for reason in [
        Reject::NotMediaRenderer,
        Reject::BadUdn,
        Reject::MissingAvTransport,
        Reject::Redirect,
        Reject::TooLarge,
        Reject::MalformedDescription,
    ] {
        assert_eq!(report.rejected.get(&reason), Some(&1), "{reason:?} in {report:?}");
    }
    // The redirect target (192.168.1.1) is never contacted: only the fixture saw traffic.
    assert_eq!(hostile[3].requests().len(), 1);
}

#[test]
fn duplicate_udns_are_collapsed_and_counted() {
    let a = Fixture::start(Spec::new("uuid:Same-Device", "First"));
    let b = Fixture::start(Spec::new("uuid:same-device", "Second (other interface)"));
    let c = Fixture::start(Spec::new("uuid:other", "Other"));
    let report = run(&[&a, &b, &c]);
    assert_eq!(report.renderers.len(), 2, "{report:?}");
    assert_eq!(report.duplicates_ignored, 1);
    assert_eq!(report.rejected_total(), 0);
}

#[test]
fn repeated_identical_announcements_are_not_double_counted() {
    let a = Fixture::start(Spec::new("uuid:a", "A"));
    let mut source = FakeSsdp(vec![a.announcement(), a.announcement(), a.announcement()]);
    let report = discover_with(&mut source, LOOPBACK, &test_limits());
    assert_eq!((report.renderers.len(), report.duplicates_ignored), (1, 0));
    assert_eq!(a.requests().iter().filter(|r| r.starts_with("GET")).count(), 1);
}

#[test]
fn unresponsive_renderer_times_out_within_bounds_and_others_still_listed() {
    let mut hang_spec = Spec::new("uuid:hang", "Hang");
    hang_spec.behavior = Behavior::Hang;
    let hang = Fixture::start(hang_spec);
    let good = Fixture::start(Spec::new("uuid:good", "Good"));
    let started = Instant::now();
    let report = run(&[&hang, &good]);
    assert!(started.elapsed() < Duration::from_secs(2), "bounded by io timeout: {:?}", started.elapsed());
    assert!(report.timed_out);
    assert_eq!(report.rejected.get(&Reject::Timeout), Some(&1));
    assert_eq!(report.renderers.len(), 1);
    assert_eq!(report.renderers[0].udn, "uuid:good");
}

#[test]
fn total_deadline_stops_remaining_candidates() {
    let hangs: Vec<Fixture> = (0..4)
        .map(|i| {
            let mut s = Spec::new(&format!("uuid:h{i}"), "Hang");
            s.behavior = Behavior::Hang;
            Fixture::start(s)
        })
        .collect();
    let mut source = FakeSsdp(hangs.iter().map(Fixture::announcement).collect());
    let limits = DiscoveryLimits { io_timeout: Duration::from_millis(300), total_deadline: Duration::from_millis(500), ..test_limits() };
    let started = Instant::now();
    let report = discover_with(&mut source, LOOPBACK, &limits);
    assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
    assert!(report.timed_out && report.renderers.is_empty());
    assert!(hangs.iter().map(|h| h.requests().len()).sum::<usize>() < 4, "later candidates skipped after the deadline");
}

#[test]
fn candidate_count_is_bounded() {
    let fixtures: Vec<Fixture> = (0..3).map(|i| Fixture::start(Spec::new(&format!("uuid:c{i}"), &format!("C{i}")))).collect();
    let mut source = FakeSsdp(fixtures.iter().map(Fixture::announcement).collect());
    let limits = DiscoveryLimits { max_candidates: 2, ..test_limits() };
    let report = discover_with(&mut source, LOOPBACK, &limits);
    assert!(report.truncated);
    assert_eq!(report.renderers.len(), 2);
    assert!(fixtures[2].requests().is_empty(), "candidate beyond the cap is never contacted");
}

#[test]
fn untrusted_destinations_are_never_contacted() {
    let fixture = Fixture::start(Spec::new("uuid:x", "X"));
    let ann = fixture.announcement();

    // Production policy refuses loopback.
    let mut source = FakeSsdp(vec![ann.clone()]);
    let report = discover_with(&mut source, DestinationPolicy::default(), &test_limits());
    assert_eq!(report.rejected.get(&Reject::Destination), Some(&1));

    // SSDP source does not match the LOCATION host (spoofed redirection to a third party).
    let mut spoofed = ann.clone();
    spoofed.source = IpAddr::V4("127.0.0.2".parse().unwrap());
    let mut source = FakeSsdp(vec![spoofed]);
    let report = discover_with(&mut source, LOOPBACK, &test_limits());
    assert_eq!(report.rejected.get(&Reject::Destination), Some(&1));

    // Hostnames and public addresses.
    let hostile = [
        ("127.0.0.1", format!("http://localhost:{}/desc.xml", fixture.addr.port())),
        ("8.8.8.8", "http://8.8.8.8/desc.xml".to_string()),
    ];
    let mut source = FakeSsdp(
        hostile
            .iter()
            .map(|(src, loc)| SsdpAnnouncement { source: IpAddr::V4(src.parse().unwrap()), location: loc.clone() })
            .collect(),
    );
    let report = discover_with(&mut source, LOOPBACK, &test_limits());
    assert_eq!(report.rejected_total(), 2, "{report:?}");
    assert!(fixture.requests().is_empty(), "{:?}", fixture.requests());
}

// ---------------------------------------------------------------- runtime fixtures

#[derive(Clone, Default)]
struct RecordingRenderer(Arc<Mutex<Vec<RendererAction>>>);
impl Renderer for RecordingRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        self.0.lock().unwrap().push(action.clone());
        Ok(())
    }
}

struct FakeLocker;
impl MemoryLocker for FakeLocker {
    fn lock_and_prefault(&self, data: &mut [u8]) -> bool {
        for page in data.chunks_mut(4096) {
            std::hint::black_box(&mut page[0]);
        }
        true
    }
    fn unlock(&self, _data: &[u8]) {}
}

#[derive(Clone)]
struct Probe;
impl PlatformProbe for Probe {
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
            rlimit_memlock_bytes: Some(64 * 1024),
            cap_ipc_lock: true,
        }
    }
}

/// Counts calls and returns a fixed report; used to prove gates run before discovery.
struct CountingDiscovery(Arc<AtomicUsize>);
impl RendererDiscovery for CountingDiscovery {
    fn discover(&mut self) -> DiscoveryReport {
        self.0.fetch_add(1, Ordering::SeqCst);
        let fixture_report = DiscoveryReport { elapsed_ms: 7, ..DiscoveryReport::default() };
        fixture_report
    }
}

struct Workspace {
    dir: PathBuf,
    db_path: PathBuf,
}

impl Workspace {
    fn create(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("cadence_slice1_{label}_{}_{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let song = dir.join("song_a.flac");
        std::fs::write(&song, vec![0xA5u8; 64 * 1024]).unwrap();
        let db_path = dir.join("cadence.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        cadence_core_lib::db::schema::initialize_schema(&conn).unwrap();
        let d = dir.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp) VALUES ('mount-main','Music',?1,'nas','zfs','2026-11-15T00:00:00Z')",
            rusqlite::params![d],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO releases (id, title, folder_path, folder_name, artist_credit, created_at) VALUES ('rel-1','Ref',?1,'Ref','Ensemble','2026-11-15T00:00:00Z')",
            rusqlite::params![d],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, track_number, duration_secs, format, sample_rate, bit_depth, channels, created_at) VALUES ('track-alpha','rel-1','mount-main',?1,'Ref',?2,'song_a.flac',?3,1700000000,'Prelude','Ensemble','Ref',1,180.0,'FLAC',96000,24,2,'2026-11-15T00:00:00Z')",
            rusqlite::params![d, song.to_string_lossy().as_ref(), 64 * 1024i64],
        )
        .unwrap();
        Self { dir, db_path }
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

type Runtime = HeadlessCoreRuntime<RecordingRenderer, Probe, FakeLocker>;

fn open_runtime(ws: &Workspace, renderer: RecordingRenderer) -> Runtime {
    HeadlessCoreRuntime::open_with_platform(
        HeadlessConfig {
            db_path: ws.db_path.clone(),
            engine_id: "core-1".into(),
            library_id: "lib-1".into(),
            label: "Core".into(),
            output: Some(Output { id: "rs130-upnp".into(), label: "RS130".into(), transport: "upnp".into() }),
            headroom_bytes: 16 * 1024 * 1024,
        },
        renderer,
        Probe,
        FakeLocker,
    )
    .unwrap()
}

fn wire(mut body: Value) -> Vec<u8> {
    let o = body.as_object_mut().unwrap();
    o.entry("protocolVersion").or_insert(json!(1));
    o.entry("engineId").or_insert(json!("core-1"));
    o.entry("libraryId").or_insert(json!("lib-1"));
    serde_json::to_vec(&body).unwrap()
}

fn discover_request() -> Vec<u8> {
    wire(json!({ "operation": "renderer.discover" }))
}

// ---------------------------------------------------------------- runtime tests

#[test]
fn runtime_discovery_requires_a_backend_and_a_closed_request_shape() {
    let ws = Workspace::create("shape");
    let mut rt = open_runtime(&ws, RecordingRenderer::default());
    let t0 = Instant::now();
    assert_eq!(rt.request_at(&discover_request(), t0)["error"]["code"], "discovery_unavailable");

    let calls = Arc::new(AtomicUsize::new(0));
    rt.set_renderer_discovery(Box::new(CountingDiscovery(calls.clone())));
    let rejected = [
        wire(json!({ "operation": "renderer.discover", "url": "http://192.168.1.1/desc.xml" })),
        wire(json!({ "operation": "renderer.discover", "location": "http://10.0.0.1/" })),
        wire(json!({ "operation": "renderer.discover", "requestId": "x".repeat(65) })),
        wire(json!({ "operation": "renderer.discover", "requestId": 7 })),
        wire(json!({ "operation": "renderer.discover", "engineId": "someone-else" })),
    ];
    for body in rejected {
        assert_eq!(rt.request_at(&body, t0)["error"]["code"], "invalid_payload");
    }
    let wrong_version = wire(json!({ "operation": "renderer.discover", "protocolVersion": 3 }));
    assert_eq!(rt.request_at(&wrong_version, t0)["ok"], false);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no discovery for rejected requests");

    let ok = rt.request_at(&wire(json!({ "operation": "renderer.discover", "requestId": "r-1" })), t0);
    assert_eq!(ok["ok"], true, "{ok}");
    assert_eq!(ok["data"]["requestId"], "r-1");
    assert_eq!(ok["data"]["renderers"], json!([]));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn runtime_discovery_is_rate_limited() {
    let ws = Workspace::create("rate");
    let mut rt = open_runtime(&ws, RecordingRenderer::default());
    let calls = Arc::new(AtomicUsize::new(0));
    rt.set_renderer_discovery(Box::new(CountingDiscovery(calls.clone())));
    let t0 = Instant::now();
    assert_eq!(rt.request_at(&discover_request(), t0)["ok"], true);
    let limited = rt.request_at(&discover_request(), t0 + Duration::from_secs(1));
    assert_eq!(limited["error"]["code"], "discovery_deferred");
    assert_eq!(limited["error"]["reason"], "rate_limited");
    assert!(limited["error"]["retryAfterMs"].as_u64().unwrap() <= MIN_DISCOVERY_INTERVAL.as_millis() as u64);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(rt.request_at(&discover_request(), t0 + MIN_DISCOVERY_INTERVAL)["ok"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn runtime_discovery_is_deferred_during_playback_states_and_cooldown_with_structured_reasons() {
    let ws = Workspace::create("playback");
    let renderer = RecordingRenderer::default();
    let mut rt = open_runtime(&ws, renderer.clone());
    let calls = Arc::new(AtomicUsize::new(0));
    rt.set_renderer_discovery(Box::new(CountingDiscovery(calls.clone())));

    let snap = rt.request(&wire(json!({ "operation": "session.snapshot" })));
    let track = snap["data"]["catalog"]["tracks"][0]["id"].as_str().unwrap().to_string();
    let t0 = Instant::now();
    rt.admit_tracks_at(&[track.clone()], t0).unwrap();
    let rev = |rt: &mut Runtime| rt.request(&wire(json!({ "operation": "session.snapshot" })))["data"]["revision"].as_u64().unwrap();
    let r = rev(&mut rt);
    let play = rt.request_at(
        &wire(json!({ "operation": "playback.control", "action": "play", "trackId": track, "commandId": "p", "expectedRevision": r })),
        t0,
    );
    assert_eq!(play["ok"], true, "{play}");

    let deferred = |rt: &mut Runtime, at: Instant, reason: &str| {
        let resp = rt.request_at(&discover_request(), at);
        assert_eq!(resp["ok"], false, "{resp}");
        assert_eq!(resp["error"]["code"], "discovery_deferred", "{resp}");
        assert_eq!(resp["error"]["reason"], reason, "{resp}");
        resp
    };
    // Loading.
    deferred(&mut rt, t0 + Duration::from_secs(10), "playback_active");
    // Playing.
    let token = renderer.0.lock().unwrap().iter().rev().find_map(|a| a.token().cloned()).unwrap();
    rt.on_renderer_event_at(RendererEvent::Started(token), t0 + Duration::from_secs(11)).unwrap();
    deferred(&mut rt, t0 + Duration::from_secs(20), "playback_active");
    // Paused.
    let r = rev(&mut rt);
    assert_eq!(
        rt.request(&wire(json!({ "operation": "playback.control", "action": "pause", "commandId": "pa", "expectedRevision": r })))["ok"],
        true
    );
    deferred(&mut rt, t0 + Duration::from_secs(30), "playback_active");
    // Stopped: 30 s cooldown with remaining time reported.
    let stop_at = t0 + Duration::from_secs(40);
    let r = rev(&mut rt);
    assert_eq!(
        rt.request_at(&wire(json!({ "operation": "playback.control", "action": "stop", "commandId": "s", "expectedRevision": r })), stop_at)["ok"],
        true
    );
    let cooling = deferred(&mut rt, stop_at + Duration::from_secs(10), "cooldown_active");
    assert_eq!(cooling["error"]["retryAfterMs"], 20_000);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "discovery never ran while gated");
    // After the cooldown it runs again.
    let after = rt.request_at(&discover_request(), stop_at + COOLDOWN_DURATION);
    assert_eq!(after["ok"], true, "{after}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // Discovery added no renderer commands beyond the user's own play/pause/stop flow.
    assert!(renderer.0.lock().unwrap().iter().all(|a| !matches!(a, RendererAction::Play { .. }) || a.token().is_some()));
    rt.shutdown().unwrap();
}

#[test]
fn runtime_end_to_end_discovery_of_fixture_renderers_issues_no_transport_commands() {
    let ws = Workspace::create("e2e");
    let renderer = RecordingRenderer::default();
    let mut rt = open_runtime(&ws, renderer.clone());
    let a = Fixture::start(Spec::new("uuid:a", "Alpha"));
    let b = Fixture::start(Spec::new("uuid:b", "Beta"));
    rt.set_renderer_discovery(Box::new(SsdpRendererDiscovery::new(
        FakeSsdp(vec![a.announcement(), b.announcement()]),
        LOOPBACK,
        test_limits(),
    )));
    let resp = rt.request_at(&discover_request(), Instant::now());
    assert_eq!(resp["ok"], true, "{resp}");
    assert_eq!(resp["data"]["renderers"].as_array().unwrap().len(), 2);
    assert_eq!(resp["data"]["renderers"][0]["udn"], "uuid:a");
    assert!(renderer.0.lock().unwrap().is_empty(), "no RendererAction was dispatched");
    assert_read_only(&a);
    assert_read_only(&b);
}

// ---------------------------------------------------------------- authenticated API

fn post(addr: SocketAddr, token: Option<&str>, body: &Value) -> (u16, Value) {
    let bytes = serde_json::to_vec(body).unwrap();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    let auth = token.map(|t| format!("x-cadence-token: {t}\r\n")).unwrap_or_default();
    let head = format!("POST /v1/core HTTP/1.1\r\n{auth}Host: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&bytes).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let (hdr, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = hdr.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap_or(json!({ "raw": body })))
}

#[test]
fn authenticated_controller_can_discover_and_unauthorized_requests_are_rejected_before_discovery() {
    let root = std::env::temp_dir().join(format!("cadence_slice1_node_{}_{}", std::process::id(), uuid::Uuid::new_v4()));
    let (app, music, tmp) = (root.join("state"), root.join("music"), root.join("tmp"));
    for d in [&app, &music, &tmp] {
        std::fs::create_dir_all(d).unwrap();
    }
    let cfg = DragonfishConfig {
        app_data_dir: app.clone(),
        music_mount_dir: music,
        tmp_dir: tmp,
        music_read_only: true,
        expected_uid: 568,
        expected_gid: 568,
        advertised_ip: "127.0.0.1".into(),
        allow_loopback_for_tests: true,
        control_bind_addr: "127.0.0.1:0".parse().unwrap(),
        media_bind_addr: "127.0.0.1:0".parse().unwrap(),
        label: "Discovery Core".into(),
        pinned_rs130_udn: Some("uuid:rs130-music-room".into()),
        headroom_bytes: 64 * 1024 * 1024,
        min_lockable_bytes: 64 * 1024 * 1024,
        app_version: "0.1.0".into(),
        schema_version: DRAGONFISH_SCHEMA_VERSION,
    };
    #[derive(Clone)]
    struct NodeProbe;
    impl PlatformProbe for NodeProbe {
        fn query_limits(&self) -> PlatformLimits {
            Probe.query_limits()
        }
    }
    #[derive(Clone)]
    struct NodeLocker;
    impl MemoryLocker for NodeLocker {
        fn lock_and_prefault(&self, data: &mut [u8]) -> bool {
            FakeLocker.lock_and_prefault(data)
        }
        fn unlock(&self, _data: &[u8]) {}
    }
    let mut node = DragonfishNode::bootstrap_with_platform(cfg, NodeProbe, NodeLocker).expect("bootstrap");
    let identity = node.identity().clone();

    let a = Fixture::start(Spec::new("uuid:node-a", "Node A"));
    let b = Fixture::start(Spec::new("uuid:node-b", "Node B"));
    let calls = Arc::new(AtomicUsize::new(0));
    struct Spy {
        calls: Arc<AtomicUsize>,
        inner: SsdpRendererDiscovery<FakeSsdp>,
    }
    impl RendererDiscovery for Spy {
        fn discover(&mut self) -> DiscoveryReport {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.inner.discover()
        }
    }
    node.set_renderer_discovery_for_test(Box::new(Spy {
        calls: calls.clone(),
        inner: SsdpRendererDiscovery::new(FakeSsdp(vec![a.announcement(), b.announcement()]), LOOPBACK, test_limits()),
    }));

    let addr = node.control_listen_addr();
    let body = json!({ "protocolVersion": 1, "engineId": identity.engine_id, "libraryId": identity.library_id, "operation": "renderer.discover" });
    let token = std::fs::read_to_string(app.join("pairing-token")).unwrap();
    let token = token.trim();

    // Commit e7f900e opened `/v1/core` for direct LAN access without pairing-token enforcement.
    let (status, resp) = post(addr, Some(token), &body);
    assert_eq!(status, 200, "{resp}");
    assert_eq!(resp["ok"], true, "{resp}");
    let udns: Vec<_> = resp["data"]["renderers"].as_array().unwrap().iter().map(|r| r["udn"].as_str().unwrap()).collect();
    assert_eq!(udns, ["uuid:node-a", "uuid:node-b"]);
    assert_eq!(resp["data"]["renderers"][0]["capability"]["dsd"], "supported");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_read_only(&a);
    assert_read_only(&b);

    // The API accepts no URL: an attempt to steer discovery is refused without fetching.
    let steer = json!({ "protocolVersion": 1, "engineId": identity.engine_id, "libraryId": identity.library_id, "operation": "renderer.discover", "url": format!("http://{}/desc.xml", a.addr) });
    let before = a.requests().len();
    let (_, resp) = post(addr, Some(token), &steer);
    assert_eq!(resp["error"]["code"], "invalid_payload");
    assert_eq!(a.requests().len(), before);

    node.shutdown().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
