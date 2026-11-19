use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::core_session::MAX_MESSAGE_BYTES;

const MAX_ARTWORK_BYTES: usize = 4 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreEndpointBridgeTarget {
    pub base_url: String,
    pub pairing_token: Option<String>,
    pub cert_fingerprint: Option<String>,
    pub trust_insecure: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCoreEndpoint {
    pub engine_id: String,
    pub library_id: String,
    pub label: String,
    pub base_url: String,
    pub cert_fingerprint: Option<String>,
    pub pinned_rs130_udn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreArtworkResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub content_type: String,
    pub base64: Option<String>,
}

#[derive(Default)]
pub struct CoreEventStreamState {
    handle: AsyncMutex<Option<(u64, JoinHandle<()>)>>,
    generation: std::sync::atomic::AtomicU64,
}

#[derive(Debug)]
struct PinnedServerCertVerifier {
    expected_sha256: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl PinnedServerCertVerifier {
    fn new(expected_sha256: [u8; 32]) -> Self {
        Self {
            expected_sha256,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        }
    }
}

impl ServerCertVerifier for PinnedServerCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        let diff = digest
            .iter()
            .zip(self.expected_sha256.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b));
        if diff != 0 {
            return Err(rustls::Error::General(
                "pinned certificate SHA-256 mismatch".to_string(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(crate) fn parse_sha256_fingerprint(raw: &str) -> Result<[u8; 32], String> {
    let clean: String = raw
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-' | '\t' | '\n' | '\r'))
        .collect();
    if clean.len() != 64 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("untrusted_peer".to_string());
    }
    let mut bytes = [0u8; 32];
    for (idx, chunk) in clean.as_bytes().chunks_exact(2).enumerate() {
        let hex_pair = std::str::from_utf8(chunk).map_err(|_| "untrusted_peer".to_string())?;
        bytes[idx] = u8::from_str_radix(hex_pair, 16).map_err(|_| "untrusted_peer".to_string())?;
    }
    Ok(bytes)
}

fn validate_core_base_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "invalid_payload".to_string())?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("invalid_payload".to_string());
    }
    if url.host_str().is_none() {
        return Err("invalid_payload".to_string());
    }
    Ok(url)
}

fn build_core_http_client(
    cert_fingerprint: Option<&str>,
    allow_unpinned_insecure: bool,
    timeout: Option<Duration>,
    connect_timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(connect_timeout);
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }

    if let Some(fp_raw) = cert_fingerprint.map(str::trim).filter(|s| !s.is_empty()) {
        let fp = parse_sha256_fingerprint(fp_raw)?;
        let verifier = Arc::new(PinnedServerCertVerifier::new(fp));
        let tls_config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| "untrusted_peer".to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
        builder = builder.tls_backend_preconfigured(tls_config);
    } else if allow_unpinned_insecure {
        builder = builder.tls_danger_accept_invalid_certs(true);
    }

    builder.build().map_err(|_| "unavailable".to_string())
}

fn attach_token(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    if let Some(tok) = token.map(str::trim).filter(|t| !t.is_empty()) {
        req.header("x-cadence-token", tok)
    } else {
        req
    }
}

async fn read_bounded_json_response(mut res: reqwest::Response) -> Result<Value, String> {
    if res.status().as_u16() == 401 || res.status().as_u16() == 403 {
        return Err("unauthorized".to_string());
    }
    if res.status().is_redirection() {
        return Err("untrusted_peer".to_string());
    }
    if !res.status().is_success() {
        return Err("unavailable".to_string());
    }
    if let Some(len) = res.content_length() {
        if len as usize > MAX_MESSAGE_BYTES {
            return Err("invalid_payload".to_string());
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "unavailable".to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_MESSAGE_BYTES {
            return Err("invalid_payload".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_payload".to_string())
}

#[tauri::command]
pub async fn core_probe_endpoint(target: CoreEndpointBridgeTarget) -> Result<Value, String> {
    let base = validate_core_base_url(&target.base_url)?;
    let url = base.join("healthz").map_err(|_| "invalid_payload".to_string())?;
    let client = build_core_http_client(
        target.cert_fingerprint.as_deref(),
        target.trust_insecure.unwrap_or(false),
        Some(Duration::from_millis(4000)),
        Duration::from_millis(3000),
    )?;
    let req = attach_token(client.get(url), target.pairing_token.as_deref());
    let res = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "unavailable".to_string()
        } else {
            "untrusted_peer".to_string()
        }
    })?;
    read_bounded_json_response(res).await
}

#[tauri::command]
pub async fn core_control_request(
    target: CoreEndpointBridgeTarget,
    payload: Value,
) -> Result<Value, String> {
    let base = validate_core_base_url(&target.base_url)?;
    let body_bytes = serde_json::to_vec(&payload).map_err(|_| "invalid_payload".to_string())?;
    if body_bytes.len() > MAX_MESSAGE_BYTES {
        return Err("invalid_payload".to_string());
    }
    let url = base.join("v1/core").map_err(|_| "invalid_payload".to_string())?;
    let client = build_core_http_client(
        target.cert_fingerprint.as_deref(),
        target.trust_insecure.unwrap_or(false),
        Some(Duration::from_millis(15000)),
        Duration::from_millis(4000),
    )?;
    let req = attach_token(
        client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_bytes),
        target.pairing_token.as_deref(),
    );
    let res = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "unavailable".to_string()
        } else {
            "untrusted_peer".to_string()
        }
    })?;
    read_bounded_json_response(res).await
}

#[tauri::command]
pub async fn core_fetch_artwork(
    target: CoreEndpointBridgeTarget,
    release_id: String,
    if_none_match: Option<String>,
) -> Result<CoreArtworkResponse, String> {
    let clean_id = release_id.trim();
    if clean_id.is_empty()
        || clean_id.len() > 128
        || !clean_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("invalid_payload".to_string());
    }
    let base = validate_core_base_url(&target.base_url)?;
    let url = base
        .join(&format!("v1/artwork/{clean_id}"))
        .map_err(|_| "invalid_payload".to_string())?;
    let client = build_core_http_client(
        target.cert_fingerprint.as_deref(),
        target.trust_insecure.unwrap_or(false),
        Some(Duration::from_millis(8000)),
        Duration::from_millis(3000),
    )?;
    let mut req = attach_token(client.get(url), target.pairing_token.as_deref());
    if let Some(etag) = if_none_match.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let mut res = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "unavailable".to_string()
        } else {
            "untrusted_peer".to_string()
        }
    })?;

    let status = res.status().as_u16();
    if status == 401 || status == 403 {
        return Err("unauthorized".to_string());
    }
    if res.status().is_redirection() {
        return Err("untrusted_peer".to_string());
    }
    let etag = res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    if matches!(status, 304 | 404 | 503) {
        return Ok(CoreArtworkResponse {
            status,
            etag,
            content_type,
            base64: None,
        });
    }
    if !res.status().is_success() {
        return Err("unavailable".to_string());
    }
    if let Some(len) = res.content_length() {
        if len as usize > MAX_ARTWORK_BYTES {
            return Err("invalid_payload".to_string());
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "unavailable".to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_ARTWORK_BYTES {
            return Err("invalid_payload".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(CoreArtworkResponse {
        status,
        etag,
        content_type,
        base64: Some(BASE64_STANDARD.encode(&bytes)),
    })
}

fn dispatch_sse_block(app: &AppHandle, engine_id: &str, block: &str) {
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for line in block.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event_name = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    if data_lines.is_empty() {
        return;
    }
    let joined = data_lines.join("\n");
    let parsed_data: Value =
        serde_json::from_str(&joined).unwrap_or_else(|_| Value::String(joined.clone()));
    let _ = app.emit(
        "cadence:core-event",
        json!({
            "engineId": engine_id,
            "sseEvent": event_name.unwrap_or_else(|| "message".to_string()),
            "payload": parsed_data,
        }),
    );
}

#[tauri::command]
pub async fn core_connect_events(
    app: AppHandle,
    stream_state: State<'_, CoreEventStreamState>,
    target: CoreEndpointBridgeTarget,
    engine_id: String,
) -> Result<(), String> {
    let base = validate_core_base_url(&target.base_url)?;
    let url = base.join("v1/events").map_err(|_| "invalid_payload".to_string())?;
    let client = build_core_http_client(
        target.cert_fingerprint.as_deref(),
        target.trust_insecure.unwrap_or(false),
        None,
        Duration::from_millis(4000),
    )?;
    let req = attach_token(
        client.get(url).header(reqwest::header::ACCEPT, "text/event-stream"),
        target.pairing_token.as_deref(),
    );
    let mut res = req.send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            "unavailable".to_string()
        } else {
            "untrusted_peer".to_string()
        }
    })?;
    if res.status().as_u16() == 401 || res.status().as_u16() == 403 {
        return Err("unauthorized".to_string());
    }
    if res.status().is_redirection() {
        return Err("untrusted_peer".to_string());
    }
    if !res.status().is_success() {
        return Err("unavailable".to_string());
    }

    let gen = stream_state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let mut guard = stream_state.handle.lock().await;
    if let Some((_, prev)) = guard.take() {
        prev.abort();
    }

    let app_clone = app.clone();
    let engine_id_clone = engine_id.clone();
    let handle = tokio::spawn(async move {
        let mut buffer = String::new();
        loop {
            match res.chunk().await {
                Ok(Some(chunk)) => {
                    let text = String::from_utf8_lossy(&chunk);
                    buffer.push_str(&text);
                    if buffer.len() > MAX_SSE_EVENT_BYTES {
                        buffer.clear();
                        continue;
                    }
                    loop {
                        let sep = buffer.find("\n\n").map(|i| (i, 2)).or_else(|| {
                            buffer.find("\r\n\r\n").map(|i| (i, 4))
                        });
                        let Some((idx, sep_len)) = sep else {
                            break;
                        };
                        let block = buffer[..idx].to_string();
                        buffer.drain(..idx + sep_len);
                        dispatch_sse_block(&app_clone, &engine_id_clone, &block);
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = app_clone.emit(
                        "cadence:core-event",
                        json!({
                            "engineId": engine_id_clone,
                            "sseEvent": "stream.disconnected",
                            "payload": { "event": "stream.disconnected" }
                        }),
                    );
                    break;
                }
            }
        }
    });
    *guard = Some((gen, handle));
    Ok(())
}

#[tauri::command]
pub async fn core_disconnect_events(
    stream_state: State<'_, CoreEventStreamState>,
) -> Result<(), String> {
    stream_state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut guard = stream_state.handle.lock().await;
    if let Some((_, handle)) = guard.take() {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn discover_core_nodes() -> Result<Vec<DiscoveredCoreEndpoint>, String> {
    let mut results = tokio::task::spawn_blocking(|| {
        let daemon = match mdns_sd::ServiceDaemon::new() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let mut receivers = Vec::new();
        for service_type in ["_cadence._tcp.local.", "_cadence-core._tcp.local."] {
            if let Ok(rx) = daemon.browse(service_type) {
                receivers.push(rx);
            }
        }
        if receivers.is_empty() {
            let _ = daemon.shutdown();
            return Vec::new();
        }
        let deadline = Instant::now() + Duration::from_millis(1200);
        let mut results = Vec::new();
        while Instant::now() < deadline {
            let mut progressed = false;
            for receiver in &receivers {
                while let Ok(event) = receiver.try_recv() {
                    progressed = true;
                    if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                        let props = info.get_properties();
                        let role = props.get_property_val_str("role").unwrap_or("");
                        let engine_id = props.get_property_val_str("engineId").unwrap_or("");
                        let library_id = props.get_property_val_str("libraryId").unwrap_or("");
                        if role != "core" && engine_id.is_empty() {
                            continue;
                        }
                        let ip = info
                            .get_addresses()
                            .iter()
                            .find(|addr| addr.is_ipv4())
                            .map(|addr| addr.to_string());
                        let Some(ip) = ip else {
                            continue;
                        };
                        let port = info.get_port();
                        let scheme = props.get_property_val_str("protocol").unwrap_or("https");
                        let base_url = format!("{}://{}:{}", scheme, ip, port);
                        if results
                            .iter()
                            .any(|r: &DiscoveredCoreEndpoint| r.base_url == base_url)
                        {
                            continue;
                        }
                        results.push(DiscoveredCoreEndpoint {
                            engine_id: engine_id.to_string(),
                            library_id: library_id.to_string(),
                            label: props
                                .get_property_val_str("label")
                                .unwrap_or_else(|| info.get_fullname())
                                .to_string(),
                            base_url,
                            cert_fingerprint: props
                                .get_property_val_str("fp")
                                .map(|s| s.to_string()),
                            pinned_rs130_udn: props
                                .get_property_val_str("rs130Udn")
                                .map(|s| s.to_string()),
                            pairing_token: None,
                        });
                    }
                }
            }
            if !progressed {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = daemon.shutdown();
        results
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(local) = probe_localhost_windows_engine().await {
        results.retain(|node| node.engine_id != local.engine_id && node.base_url != local.base_url);
        results.insert(0, local);
    }
    Ok(results)
}

async fn read_localhost_windows_engine() -> Option<DiscoveredCoreEndpoint> {
    let data_dir = if let Ok(explicit) = std::env::var("CADENCE_DATA_DIR") {
        let trimmed = explicit.trim();
        if trimmed.is_empty() {
            return None;
        }
        std::path::PathBuf::from(trimmed)
    } else if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        std::path::PathBuf::from(local_app_data).join("CadenceEngine")
    } else {
        return None;
    };
    let pairing_path = data_dir.join("localhost-pairing.json");
    let raw = tokio::fs::read_to_string(pairing_path).await.ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let base_url = parsed.get("baseUrl")?.as_str()?.to_string();
    let addr: std::net::SocketAddr = base_url.strip_prefix("https://")?.parse().ok()?;
    if !addr.ip().is_loopback() {
        return None;
    }
    Some(DiscoveredCoreEndpoint {
        engine_id: parsed.get("engineId")?.as_str()?.to_string(),
        library_id: parsed.get("libraryId")?.as_str()?.to_string(),
        label: parsed.get("label")?.as_str()?.to_string(),
        base_url,
        cert_fingerprint: parsed
            .get("tlsFingerprintSha256")
            .and_then(Value::as_str)
            .map(str::to_string),
        pinned_rs130_udn: None,
        pairing_token: parsed
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[tauri::command]
pub async fn local_core_pairing_endpoint() -> Option<DiscoveredCoreEndpoint> {
    let mut local = read_localhost_windows_engine().await?;
    local.pairing_token = None;
    Some(local)
}

async fn probe_localhost_windows_engine() -> Option<DiscoveredCoreEndpoint> {
    let local = read_localhost_windows_engine().await?;
    let client = build_core_http_client(
        Some(local.cert_fingerprint.as_deref()?),
        false,
        Some(Duration::from_millis(750)),
        Duration::from_millis(500),
    )
    .ok()?;
    let response = client
        .get(format!("{}/healthz", local.base_url))
        .send()
        .await
        .ok()?;
    let health = read_bounded_json_response(response).await.ok()?;
    if health.get("ready").and_then(Value::as_bool) == Some(true)
        && health.get("engineId")?.as_str()? == local.engine_id.as_str()
        && health.get("libraryId")?.as_str()? == local.library_id.as_str()
    {
        Some(local)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_formatted_sha256_fingerprints() {
        let hex = "0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567 89ab cdef";
        let parsed = parse_sha256_fingerprint(hex).expect("valid sha256");
        assert_eq!(parsed[0], 0x01);
        assert_eq!(parsed[1], 0x23);
        assert_eq!(parsed[31], 0xef);
        assert!(parse_sha256_fingerprint("deadbeef").is_err());
    }

    #[test]
    fn pinned_verifier_accepts_matching_cert_and_rejects_mismatch() {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let der = cert.cert.der().as_ref();
        let digest: [u8; 32] = Sha256::digest(der).into();
        let verifier = PinnedServerCertVerifier::new(digest);
        let cert_der = CertificateDer::from(der.to_vec());
        let server_name = ServerName::try_from("localhost").unwrap();

        assert!(verifier
            .verify_server_cert(&cert_der, &[], &server_name, &[], UnixTime::now())
            .is_ok());

        let mut wrong = digest;
        wrong[0] ^= 0xff;
        let bad_verifier = PinnedServerCertVerifier::new(wrong);
        assert!(bad_verifier
            .verify_server_cert(&cert_der, &[], &server_name, &[], UnixTime::now())
            .is_err());
    }
}
