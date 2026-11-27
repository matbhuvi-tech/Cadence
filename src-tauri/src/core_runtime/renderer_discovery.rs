//! Portable Core renderer discovery (Slice 1).
//!
//! Explicit, bounded, read-only discovery of UPnP MediaRenderers.
//!
//! Safety properties (all covered by tests):
//! - Discovery runs only when a controller requests it; there is no background scan.
//! - SSDP datagrams and device descriptions are untrusted. Every size, count and
//!   duration is bounded; redirects are never followed; DOCTYPE/ENTITY is rejected.
//! - Network destinations are bounded: the `LOCATION` host must be a literal IPv4
//!   address equal to the UDP source of the announcement and must be private or
//!   link-local (loopback only when explicitly allowed for hermetic tests). Control
//!   URLs must stay on the same `ip:port`. The authenticated API accepts no URLs.
//! - The only request ever sent to a renderer besides the description GET is the
//!   read-only ConnectionManager `GetProtocolInfo` action. This module deliberately
//!   contains no builder for any AVTransport action, so it cannot stop, start or
//!   retarget playback.
//! - Capability is three-state. Absence of evidence is `unknown`, never `supported`.
//!
//! The module holds no threads, timers, locked memory or Windows-specific scheduling;
//! it runs on the caller's control-plane thread.

use super::upnp_session::{dsd_capability_from_sink_protocol_info, DsdCapability};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::str::FromStr;
use std::time::{Duration, Instant};

pub const MAX_SSDP_DATAGRAM_BYTES: usize = 2048;
pub const MAX_SSDP_DATAGRAMS: usize = 64;
pub const MAX_HTTP_RESPONSE_BYTES: usize = 128 * 1024;
pub const MAX_LOCATION_BYTES: usize = 256;
pub const MAX_CONTROL_URL_BYTES: usize = 256;
pub const MAX_UDN_BYTES: usize = 128;
pub const MAX_LABEL_CHARS: usize = 64;
pub const MAX_SINK_BYTES: usize = 64 * 1024;
/// Minimum spacing between two discovery runs enforced by the Core runtime.
pub const MIN_DISCOVERY_INTERVAL: Duration = Duration::from_secs(5);

const AVTRANSPORT_PREFIX: &str = "urn:schemas-upnp-org:service:AVTransport:";
const RENDERINGCONTROL_PREFIX: &str = "urn:schemas-upnp-org:service:RenderingControl:";
const CONNECTIONMANAGER_PREFIX: &str = "urn:schemas-upnp-org:service:ConnectionManager:";
const MEDIARENDERER_PREFIX: &str = "urn:schemas-upnp-org:device:MediaRenderer:";

#[derive(Clone, Debug)]
pub struct DiscoveryLimits {
    pub ssdp_window: Duration,
    pub io_timeout: Duration,
    pub total_deadline: Duration,
    pub max_candidates: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            ssdp_window: Duration::from_millis(1200),
            io_timeout: Duration::from_millis(1500),
            total_deadline: Duration::from_secs(4),
            max_candidates: 16,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DestinationPolicy {
    /// Hermetic tests only. Production Core nodes never set this.
    pub allow_loopback: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Reject {
    BadLocation,
    Destination,
    Unreachable,
    Timeout,
    Io,
    Redirect,
    HttpStatus,
    TooLarge,
    MalformedDescription,
    NotMediaRenderer,
    BadUdn,
    MissingAvTransport,
}

impl Reject {
    pub fn code(self) -> &'static str {
        match self {
            Reject::BadLocation => "bad_location",
            Reject::Destination => "destination_not_allowed",
            Reject::Unreachable => "unreachable",
            Reject::Timeout => "timeout",
            Reject::Io => "io_error",
            Reject::Redirect => "redirect_refused",
            Reject::HttpStatus => "http_status",
            Reject::TooLarge => "response_too_large",
            Reject::MalformedDescription => "malformed_description",
            Reject::NotMediaRenderer => "not_media_renderer",
            Reject::BadUdn => "bad_udn",
            Reject::MissingAvTransport => "missing_av_transport",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

impl Support {
    pub fn as_str(self) -> &'static str {
        match self {
            Support::Supported => "supported",
            Support::Unsupported => "unsupported",
            Support::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityEvidence {
    pub pcm: Support,
    pub dsd: Support,
    /// `true` only when a ConnectionManager `Sink` list was actually obtained.
    pub from_sink_protocol_info: bool,
}

impl CapabilityEvidence {
    pub const NONE: Self = Self {
        pcm: Support::Unknown,
        dsd: Support::Unknown,
        from_sink_protocol_info: false,
    };

    pub fn from_sink(sink: Option<&str>) -> Self {
        let sink = sink.filter(|s| !s.trim().is_empty());
        let Some(sink) = sink else {
            return Self::NONE;
        };
        Self {
            pcm: pcm_support_from_sink(sink),
            dsd: match dsd_capability_from_sink_protocol_info(Some(sink)) {
                DsdCapability::Supported => Support::Supported,
                DsdCapability::Unsupported => Support::Unsupported,
                DsdCapability::Unknown => Support::Unknown,
            },
            from_sink_protocol_info: true,
        }
    }
}

fn pcm_support_from_sink(sink: &str) -> Support {
    let mut unknown = false;
    for entry in sink.split(',').take(512) {
        let fields: Vec<_> = entry.trim().split(':').collect();
        if fields.len() != 4 || fields[2].trim().is_empty() {
            unknown = true;
            continue;
        }
        let mime = fields[2].trim().to_ascii_lowercase();
        if matches!(
            mime.as_str(),
            "audio/flac"
                | "audio/x-flac"
                | "audio/wav"
                | "audio/x-wav"
                | "audio/wave"
                | "audio/l16"
                | "audio/l24"
                | "audio/aiff"
                | "audio/x-aiff"
        ) {
            return Support::Supported;
        }
        if mime.contains('*') {
            unknown = true;
        }
    }
    if unknown {
        Support::Unknown
    } else {
        Support::Unsupported
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredRenderer {
    pub udn: String,
    pub label: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub rendering_control: bool,
    pub connection_manager: bool,
    pub capability: CapabilityEvidence,
}

impl DiscoveredRenderer {
    pub fn to_json(&self) -> Value {
        json!({
            "udn": self.udn,
            "label": self.label,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "availability": "available",
            "services": {
                "avTransport": true,
                "renderingControl": self.rendering_control,
                "connectionManager": self.connection_manager,
            },
            "capability": {
                "evidence": if self.capability.from_sink_protocol_info { "sink_protocol_info" } else { "none" },
                "pcm": self.capability.pcm.as_str(),
                "dsd": self.capability.dsd.as_str(),
            },
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiscoveryReport {
    pub renderers: Vec<DiscoveredRenderer>,
    pub rejected: BTreeMap<Reject, usize>,
    pub duplicates_ignored: usize,
    pub truncated: bool,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

impl DiscoveryReport {
    pub fn rejected_total(&self) -> usize {
        self.rejected.values().sum()
    }

    fn reject(&mut self, reason: Reject) {
        *self.rejected.entry(reason).or_insert(0) += 1;
    }

    pub fn to_json(&self) -> Value {
        let mut reasons = Map::new();
        for (reason, count) in &self.rejected {
            reasons.insert(reason.code().to_string(), json!(count));
        }
        json!({
            "renderers": self.renderers.iter().map(DiscoveredRenderer::to_json).collect::<Vec<_>>(),
            "rejected": self.rejected_total(),
            "rejectedReasons": Value::Object(reasons),
            "duplicatesIgnored": self.duplicates_ignored,
            "truncated": self.truncated,
            "timedOut": self.timed_out,
            "elapsedMs": self.elapsed_ms,
        })
    }
}

/// Backend used by the Core runtime to discover renderers on request.
pub trait RendererDiscovery: Send {
    fn discover(&mut self) -> DiscoveryReport;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SsdpAnnouncement {
    pub source: IpAddr,
    pub location: String,
}

/// Source of SSDP announcements. Production uses UDP multicast; tests inject fixtures.
pub trait SsdpSource: Send {
    fn search(&mut self, window: Duration) -> Vec<SsdpAnnouncement>;
}

/// Production SSDP source: one `M-SEARCH` for MediaRenderer:1 and a bounded listen window.
pub struct UdpSsdpSource {
    enabled: bool,
}

impl UdpSsdpSource {
    /// `enabled == false` never emits multicast (hermetic tests).
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
}

impl SsdpSource for UdpSsdpSource {
    fn search(&mut self, window: Duration) -> Vec<SsdpAnnouncement> {
        if !self.enabled {
            return Vec::new();
        }
        let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
            return Vec::new();
        };
        let _ = socket.set_multicast_ttl_v4(2);
        let msearch = b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
        if socket
            .send_to(msearch, (Ipv4Addr::new(239, 255, 255, 250), 1900))
            .is_err()
        {
            return Vec::new();
        }
        let deadline = Instant::now() + window;
        let mut out = Vec::new();
        let mut buf = [0u8; MAX_SSDP_DATAGRAM_BYTES];
        let mut datagrams = 0usize;
        while datagrams < MAX_SSDP_DATAGRAMS {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            if remaining.is_zero() {
                break;
            }
            let _ = socket.set_read_timeout(Some(remaining.min(Duration::from_millis(250))));
            match socket.recv_from(&mut buf) {
                Ok((n, SocketAddr::V4(src))) => {
                    datagrams += 1;
                    // A datagram that fills the buffer may be truncated: drop it.
                    if n < buf.len() {
                        if let Some(a) = parse_ssdp_response(&buf[..n], IpAddr::V4(*src.ip())) {
                            out.push(a);
                        }
                    }
                }
                Ok(_) => datagrams += 1,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
        out
    }
}

/// Parses one SSDP search response. Returns `None` for anything that is not a
/// `200 OK` MediaRenderer response carrying a `LOCATION`.
pub fn parse_ssdp_response(datagram: &[u8], source: IpAddr) -> Option<SsdpAnnouncement> {
    let text = std::str::from_utf8(datagram).ok()?;
    let mut lines = text.split("\r\n");
    let status = lines.next()?;
    if !status.to_ascii_uppercase().starts_with("HTTP/1.1 200") {
        return None;
    }
    let mut location = None;
    let mut st_ok = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("location") && location.is_none() {
            location = Some(value.to_string());
        } else if name.eq_ignore_ascii_case("st")
            && value.to_ascii_lowercase().starts_with(&MEDIARENDERER_PREFIX.to_ascii_lowercase())
        {
            st_ok = true;
        }
    }
    if !st_ok {
        return None;
    }
    Some(SsdpAnnouncement { source, location: location? })
}

fn parse_authority(authority: &str) -> Option<(Ipv4Addr, u16)> {
    if authority.is_empty() || authority.contains('@') || authority.contains('[') {
        return None;
    }
    let mut parts = authority.split(':');
    let host = parts.next()?;
    let port = match parts.next() {
        Some(p) => p.parse::<u16>().ok()?,
        None => 80,
    };
    if parts.next().is_some() || port == 0 {
        return None;
    }
    Some((Ipv4Addr::from_str(host).ok()?, port))
}

fn is_clean_url_text(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.is_ascii()
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn ip_allowed(ip: Ipv4Addr, policy: DestinationPolicy) -> bool {
    if ip.is_loopback() {
        return policy.allow_loopback;
    }
    ip.is_private() || ip.is_link_local()
}

/// Validates an SSDP `LOCATION` against the destination policy.
pub fn validate_location(
    announcement: &SsdpAnnouncement,
    policy: DestinationPolicy,
) -> Result<(Ipv4Addr, u16, String), Reject> {
    let location = announcement.location.as_str();
    if !is_clean_url_text(location, MAX_LOCATION_BYTES) || location.contains('#') {
        return Err(Reject::BadLocation);
    }
    let rest = location
        .get(..7)
        .filter(|p| p.eq_ignore_ascii_case("http://"))
        .map(|_| &location[7..])
        .ok_or(Reject::BadLocation)?;
    let slash = rest.find('/').ok_or(Reject::BadLocation)?;
    let (authority, path) = rest.split_at(slash);
    let (ip, port) = parse_authority(authority).ok_or(Reject::BadLocation)?;
    if IpAddr::V4(ip) != announcement.source || !ip_allowed(ip, policy) {
        return Err(Reject::Destination);
    }
    Ok((ip, port, path.to_string()))
}

struct HttpReply {
    status: u16,
    body: Vec<u8>,
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

fn decode_chunked(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if body.len() < size + 2 || out.len() + size > MAX_HTTP_RESPONSE_BYTES {
            return None;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

fn http_exchange(
    addr: SocketAddr,
    request: &[u8],
    limits: &DiscoveryLimits,
    deadline: Instant,
) -> Result<HttpReply, Reject> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or(Reject::Timeout)?;
    let timeout = limits.io_timeout.min(remaining);
    if timeout.is_zero() {
        return Err(Reject::Timeout);
    }
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            Reject::Timeout
        } else {
            Reject::Unreachable
        }
    })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream.write_all(request).map_err(|_| Reject::Io)?;

    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if Instant::now() >= deadline {
            return Err(Reject::Timeout);
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > MAX_HTTP_RESPONSE_BYTES {
                    return Err(Reject::TooLarge);
                }
                // Stop early for devices that ignore `Connection: close`.
                if let Some(end) = find_header_end(&raw) {
                    let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
                    if let Some(len) = head.lines().find_map(|l| {
                        l.strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    }) {
                        if len > MAX_HTTP_RESPONSE_BYTES {
                            return Err(Reject::TooLarge);
                        }
                        if raw.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(Reject::Timeout)
            }
            Err(_) => return Err(Reject::Io),
        }
    }

    let end = find_header_end(&raw).ok_or(Reject::MalformedDescription)?;
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(Reject::MalformedDescription)?;
    let chunked = head
        .to_ascii_lowercase()
        .lines()
        .any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked"));
    let body_raw = &raw[end + 4..];
    let body = if chunked {
        decode_chunked(body_raw).ok_or(Reject::MalformedDescription)?
    } else {
        body_raw.to_vec()
    };
    Ok(HttpReply { status, body })
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn sanitize_label(raw: &str) -> String {
    xml_unescape(raw)
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_LABEL_CHARS)
        .collect()
}

fn tag_text<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

fn valid_udn(udn: &str) -> bool {
    let Some(id) = udn.strip_prefix("uuid:") else {
        return false;
    };
    !id.is_empty()
        && udn.len() <= MAX_UDN_BYTES
        && udn
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

fn valid_service_type(service_type: &str, prefix: &str) -> bool {
    service_type.len() <= 128
        && service_type.starts_with(prefix)
        && service_type
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// Resolves a service `controlURL` to a path on the same `ip:port` as the description.
fn resolve_control_path(raw: &str, ip: Ipv4Addr, port: u16) -> Option<String> {
    let raw = raw.trim();
    if !is_clean_url_text(raw, MAX_CONTROL_URL_BYTES) || raw.contains("..") || raw.contains('#') {
        return None;
    }
    if raw.len() >= 7 && raw[..7].eq_ignore_ascii_case("http://") {
        let rest = &raw[7..];
        let (authority, path) = match rest.find('/') {
            Some(i) => rest.split_at(i),
            None => (rest, "/"),
        };
        let (h, p) = parse_authority(authority)?;
        return (h == ip && p == port).then(|| path.to_string());
    }
    if raw.contains("://") {
        return None;
    }
    Some(if raw.starts_with('/') { raw.to_string() } else { format!("/{raw}") })
}

#[derive(Debug)]
struct ParsedDevice {
    udn: String,
    label: String,
    manufacturer: Option<String>,
    model: Option<String>,
    rendering_control: bool,
    connection_manager: Option<(String, String)>,
}

fn parse_device_description(body: &[u8], ip: Ipv4Addr, port: u16) -> Result<ParsedDevice, Reject> {
    let xml = std::str::from_utf8(body).map_err(|_| Reject::MalformedDescription)?;
    let upper = xml.to_ascii_uppercase();
    if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return Err(Reject::MalformedDescription);
    }
    let device_start = xml
        .find("<device>")
        .ok_or(Reject::MalformedDescription)?
        + "<device>".len();
    let after = &xml[device_start..];
    // Root device only: embedded devices follow `<deviceList>` per the UPnP schema.
    let root = after.split("<deviceList>").next().unwrap_or(after);

    let device_type = tag_text(root, "deviceType").ok_or(Reject::MalformedDescription)?;
    if !device_type.starts_with(MEDIARENDERER_PREFIX) {
        return Err(Reject::NotMediaRenderer);
    }
    let udn = tag_text(root, "UDN").ok_or(Reject::BadUdn)?;
    if !valid_udn(udn) {
        return Err(Reject::BadUdn);
    }

    let mut av_transport = false;
    let mut rendering_control = false;
    let mut connection_manager = None;
    let mut cursor = root;
    while let Some(i) = cursor.find("<service>") {
        let block_start = i + "<service>".len();
        let Some(len) = cursor[block_start..].find("</service>") else {
            break;
        };
        let block = &cursor[block_start..block_start + len];
        cursor = &cursor[block_start + len + "</service>".len()..];
        let (Some(service_type), Some(control)) =
            (tag_text(block, "serviceType"), tag_text(block, "controlURL"))
        else {
            continue;
        };
        if valid_service_type(service_type, AVTRANSPORT_PREFIX) {
            av_transport |= resolve_control_path(control, ip, port).is_some();
        } else if valid_service_type(service_type, RENDERINGCONTROL_PREFIX) {
            rendering_control = true;
        } else if valid_service_type(service_type, CONNECTIONMANAGER_PREFIX) {
            if connection_manager.is_none() {
                if let Some(path) = resolve_control_path(control, ip, port) {
                    connection_manager = Some((service_type.to_string(), path));
                }
            }
        }
    }
    if !av_transport {
        return Err(Reject::MissingAvTransport);
    }

    let label = tag_text(root, "friendlyName")
        .map(sanitize_label)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "UPnP MediaRenderer".to_string());
    let opt = |name: &str| {
        tag_text(root, name)
            .map(sanitize_label)
            .filter(|v| !v.is_empty())
    };
    Ok(ParsedDevice {
        udn: udn.to_string(),
        label,
        manufacturer: opt("manufacturer"),
        model: opt("modelName"),
        rendering_control,
        connection_manager,
    })
}

/// Read-only ConnectionManager `GetProtocolInfo`. This is the only SOAP action this
/// module can build; failure yields `None` (capability stays `unknown`).
fn fetch_sink_protocol_info(
    addr: SocketAddr,
    service_type: &str,
    control_path: &str,
    limits: &DiscoveryLimits,
    deadline: Instant,
) -> Option<String> {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:GetProtocolInfo xmlns:u=\"{service_type}\"/></s:Body></s:Envelope>"
    );
    let request = format!(
        "POST {control_path} HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: Cadence-Core/1\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPACTION: \"{service_type}#GetProtocolInfo\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let reply = http_exchange(addr, request.as_bytes(), limits, deadline).ok()?;
    if reply.status != 200 {
        return None;
    }
    let text = std::str::from_utf8(&reply.body).ok()?;
    let sink = xml_unescape(tag_text(text, "Sink")?);
    (sink.len() <= MAX_SINK_BYTES).then_some(sink)
}

fn probe_candidate(
    announcement: &SsdpAnnouncement,
    policy: DestinationPolicy,
    limits: &DiscoveryLimits,
    deadline: Instant,
) -> Result<DiscoveredRenderer, Reject> {
    let (ip, port, path) = validate_location(announcement, policy)?;
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: Cadence-Core/1\r\nAccept: text/xml\r\nConnection: close\r\n\r\n"
    );
    let reply = http_exchange(addr, request.as_bytes(), limits, deadline)?;
    match reply.status {
        200 => {}
        300..=399 => return Err(Reject::Redirect),
        _ => return Err(Reject::HttpStatus),
    }
    let device = parse_device_description(&reply.body, ip, port)?;
    let capability = match &device.connection_manager {
        Some((service_type, control)) => CapabilityEvidence::from_sink(
            fetch_sink_protocol_info(addr, service_type, control, limits, deadline).as_deref(),
        ),
        None => CapabilityEvidence::NONE,
    };
    Ok(DiscoveredRenderer {
        udn: device.udn,
        label: device.label,
        manufacturer: device.manufacturer,
        model: device.model,
        rendering_control: device.rendering_control,
        connection_manager: device.connection_manager.is_some(),
        capability,
    })
}

/// Runs one bounded discovery pass.
pub fn discover_with<S: SsdpSource + ?Sized>(
    source: &mut S,
    policy: DestinationPolicy,
    limits: &DiscoveryLimits,
) -> DiscoveryReport {
    let started = Instant::now();
    let deadline = started + limits.total_deadline;
    let announcements = source.search(limits.ssdp_window);
    let mut report = DiscoveryReport::default();
    let mut seen_locations = HashSet::new();
    let mut seen_udns = HashSet::new();
    let mut considered = 0usize;
    for announcement in announcements {
        if !seen_locations.insert(announcement.location.clone()) {
            continue;
        }
        if considered >= limits.max_candidates {
            report.truncated = true;
            break;
        }
        if Instant::now() >= deadline {
            report.timed_out = true;
            break;
        }
        considered += 1;
        match probe_candidate(&announcement, policy, limits, deadline) {
            Ok(renderer) => {
                if seen_udns.insert(renderer.udn.to_ascii_lowercase()) {
                    report.renderers.push(renderer);
                } else {
                    report.duplicates_ignored += 1;
                }
            }
            Err(reason) => {
                if reason == Reject::Timeout {
                    report.timed_out = true;
                }
                report.reject(reason);
            }
        }
    }
    report
        .renderers
        .sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.udn.cmp(&b.udn)));
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    crate::diag_log!(
        crate::diagnostics::DiagCategory::DeviceDiscovery,
        0,
        0,
        report.elapsed_ms * 1000,
        "core_renderer_discover",
        "found={} rejected={} timed_out={} truncated={}",
        report.renderers.len(),
        report.rejected_total(),
        report.timed_out,
        report.truncated
    );
    report
}

/// Production discovery backend: SSDP announcements validated and probed read-only.
pub struct SsdpRendererDiscovery<S: SsdpSource = UdpSsdpSource> {
    source: S,
    policy: DestinationPolicy,
    limits: DiscoveryLimits,
}

impl SsdpRendererDiscovery<UdpSsdpSource> {
    /// `hermetic == true` (loopback test mode) never emits LAN multicast.
    pub fn system(hermetic: bool) -> Self {
        Self::new(
            UdpSsdpSource::new(!hermetic),
            DestinationPolicy { allow_loopback: hermetic },
            DiscoveryLimits::default(),
        )
    }
}

impl<S: SsdpSource> SsdpRendererDiscovery<S> {
    pub fn new(source: S, policy: DestinationPolicy, limits: DiscoveryLimits) -> Self {
        Self { source, policy, limits }
    }
}

impl<S: SsdpSource> RendererDiscovery for SsdpRendererDiscovery<S> {
    fn discover(&mut self) -> DiscoveryReport {
        discover_with(&mut self.source, self.policy, &self.limits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(source: &str, location: &str) -> SsdpAnnouncement {
        SsdpAnnouncement { source: source.parse().unwrap(), location: location.into() }
    }
    const PROD: DestinationPolicy = DestinationPolicy { allow_loopback: false };
    const LOOP: DestinationPolicy = DestinationPolicy { allow_loopback: true };

    #[test]
    fn location_accepts_private_and_link_local_matching_source() {
        let (ip, port, path) =
            validate_location(&ann("192.168.1.50", "http://192.168.1.50:49152/desc.xml"), PROD).unwrap();
        assert_eq!((ip, port, path.as_str()), (Ipv4Addr::new(192, 168, 1, 50), 49152, "/desc.xml"));
        assert!(validate_location(&ann("10.1.2.3", "http://10.1.2.3/d.xml"), PROD).is_ok());
        assert!(validate_location(&ann("169.254.9.9", "http://169.254.9.9:80/d"), PROD).is_ok());
    }

    #[test]
    fn location_rejects_untrusted_destinations_and_shapes() {
        let cases: &[(&str, &str, DestinationPolicy, Reject)] = &[
            ("8.8.8.8", "http://8.8.8.8/d.xml", PROD, Reject::Destination),
            ("192.168.1.50", "http://192.168.1.99/d.xml", PROD, Reject::Destination),
            ("127.0.0.1", "http://127.0.0.1:80/d.xml", PROD, Reject::Destination),
            ("239.255.255.250", "http://239.255.255.250/d.xml", PROD, Reject::Destination),
            ("192.168.1.50", "https://192.168.1.50/d.xml", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://renderer.local/d.xml", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://user@192.168.1.50/d.xml", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://192.168.1.50:0/d.xml", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://192.168.1.50:99999/d.xml", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://192.168.1.50", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://192.168.1.50/a b", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://192.168.1.50/a\r\nX: y", PROD, Reject::BadLocation),
            ("192.168.1.50", "http://[::1]/d.xml", PROD, Reject::BadLocation),
        ];
        for (src, loc, policy, expected) in cases {
            assert_eq!(validate_location(&ann(src, loc), *policy), Err(*expected), "{loc}");
        }
        let long = format!("http://192.168.1.50/{}", "a".repeat(MAX_LOCATION_BYTES));
        assert_eq!(validate_location(&ann("192.168.1.50", &long), PROD), Err(Reject::BadLocation));
        assert!(validate_location(&ann("127.0.0.1", "http://127.0.0.1:80/d.xml"), LOOP).is_ok());
    }

    #[test]
    fn ssdp_response_parsing_requires_mediarenderer_ok_response() {
        let src: IpAddr = "192.168.1.5".parse().unwrap();
        let ok = b"HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nLOCATION: http://192.168.1.5:80/d.xml\r\nUSN: uuid:a::urn:x\r\n\r\n";
        assert_eq!(parse_ssdp_response(ok, src).unwrap().location, "http://192.168.1.5:80/d.xml");
        let notify = b"NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nLOCATION: http://192.168.1.5/d.xml\r\n\r\n";
        let wrong_st = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\nLOCATION: http://192.168.1.5/d.xml\r\n\r\n";
        let no_loc = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
        for bad in [&notify[..], &wrong_st[..], &no_loc[..], b"\xff\xfe garbage"] {
            assert!(parse_ssdp_response(bad, src).is_none());
        }
    }

    fn description(extra_services: &str, device_type: &str, udn: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>{device_type}</deviceType><friendlyName>Living &amp; Room</friendlyName><manufacturer>ACME</manufacturer><modelName>R1</modelName><UDN>{udn}</UDN><serviceList>{extra_services}</serviceList><deviceList><device><friendlyName>Embedded</friendlyName><UDN>uuid:embedded</UDN></device></deviceList></device></root>"
        )
    }
    fn svc(kind: &str, control: &str) -> String {
        format!("<service><serviceType>urn:schemas-upnp-org:service:{kind}:1</serviceType><controlURL>{control}</controlURL></service>")
    }
    const IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 5);

    #[test]
    fn description_parsing_validates_identity_services_and_control_urls() {
        let mr = "urn:schemas-upnp-org:device:MediaRenderer:1";
        let good = description(&(svc("AVTransport", "/av") + &svc("ConnectionManager", "/cm") + &svc("RenderingControl", "/rc")), mr, "uuid:abc-123");
        let parsed = parse_device_description(good.as_bytes(), IP, 80).unwrap();
        assert_eq!(parsed.udn, "uuid:abc-123");
        assert_eq!(parsed.label, "Living & Room");
        assert!(parsed.rendering_control);
        assert_eq!(parsed.connection_manager.unwrap().1, "/cm");

        let reject = |xml: String| parse_device_description(xml.as_bytes(), IP, 80).unwrap_err();
        assert_eq!(reject(description(&svc("AVTransport", "/av"), "urn:schemas-upnp-org:device:MediaServer:1", "uuid:a")), Reject::NotMediaRenderer);
        assert_eq!(reject(description(&svc("AVTransport", "/av"), mr, "not-a-uuid")), Reject::BadUdn);
        assert_eq!(reject(description(&svc("AVTransport", "/av"), mr, "uuid:bad udn<")), Reject::BadUdn);
        assert_eq!(reject(description(&svc("ConnectionManager", "/cm"), mr, "uuid:a")), Reject::MissingAvTransport);
        // AVTransport pointing at another host is not usable.
        assert_eq!(reject(description(&svc("AVTransport", "http://192.168.1.99/av"), mr, "uuid:a")), Reject::MissingAvTransport);
        assert_eq!(reject(format!("<!DOCTYPE x [<!ENTITY a \"b\">]>{}", description(&svc("AVTransport", "/av"), mr, "uuid:a"))), Reject::MalformedDescription);
        assert_eq!(reject("<root>not a device</root>".into()), Reject::MalformedDescription);
        assert!(parse_device_description(b"\xff\xfe", IP, 80).is_err());
    }

    #[test]
    fn control_urls_stay_on_the_description_host() {
        assert_eq!(resolve_control_path("/x", IP, 80).as_deref(), Some("/x"));
        assert_eq!(resolve_control_path("x/y", IP, 80).as_deref(), Some("/x/y"));
        assert_eq!(resolve_control_path("http://192.168.1.5:80/x", IP, 80).as_deref(), Some("/x"));
        for bad in ["http://192.168.1.6/x", "http://192.168.1.5:81/x", "https://192.168.1.5/x", "ftp://a/b", "/a/../b", "/a b", ""] {
            assert!(resolve_control_path(bad, IP, 80).is_none(), "{bad}");
        }
    }

    #[test]
    fn capability_is_three_state_and_absence_is_unknown() {
        let none = CapabilityEvidence::from_sink(None);
        assert_eq!((none.pcm, none.dsd, none.from_sink_protocol_info), (Support::Unknown, Support::Unknown, false));
        assert_eq!(CapabilityEvidence::from_sink(Some("  ")), CapabilityEvidence::NONE);
        let both = CapabilityEvidence::from_sink(Some("http-get:*:audio/flac:*,http-get:*:audio/x-dsd:*"));
        assert_eq!((both.pcm, both.dsd), (Support::Supported, Support::Supported));
        let pcm_only = CapabilityEvidence::from_sink(Some("http-get:*:audio/flac:*,http-get:*:audio/mpeg:*"));
        assert_eq!((pcm_only.pcm, pcm_only.dsd), (Support::Supported, Support::Unsupported));
        let wildcard = CapabilityEvidence::from_sink(Some("http-get:*:*:*"));
        assert_eq!((wildcard.pcm, wildcard.dsd), (Support::Unknown, Support::Unknown));
        let malformed = CapabilityEvidence::from_sink(Some("garbage,http-get:*:audio/mpeg:*"));
        assert_eq!((malformed.pcm, malformed.dsd), (Support::Unknown, Support::Unknown));
    }

    #[test]
    fn chunked_decoding_is_bounded() {
        assert_eq!(decode_chunked(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap(), b"abcde");
        assert!(decode_chunked(b"zz\r\nabc\r\n").is_none());
        assert!(decode_chunked(b"10\r\nabc\r\n").is_none());
    }
}
