use std::sync::Arc;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::core_session::MAX_MESSAGE_BYTES;
use crate::diag_log;
use crate::diagnostics::DiagCategory;
use crate::remote::{
    build_enriched_qr_url, discover_lan_interfaces, get_connected_client_count, LanInterfaceInfo,
    RemoteState,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub enabled: bool,
    pub port: u16,
    pub primary_ip: Option<String>,
    pub has_verified_lan: bool,
    pub computer_name: String,
    pub m_dns_host: String,
    pub pairing_token: String,
    pub cert_fingerprint: String,
    pub interfaces: Vec<LanInterfaceInfo>,
    pub connected_clients: usize,
    pub qr_url: Option<String>,
}

#[tauri::command]
pub fn get_remote_server_info(
    remote_state: State<'_, Arc<RemoteState>>,
) -> RemoteServerStatus {
    let token = remote_state.token.lock().clone();
    let port = remote_state.get_bound_port();
    let cert_fingerprint = remote_state.get_tls_fingerprint();
    let discovery = discover_lan_interfaces(port, &token);
    let connected = get_connected_client_count();
    let qr_url = discovery.primary_ip.as_ref().map(|ip| {
        build_enriched_qr_url(
            ip,
            port,
            &token,
            &discovery.m_dns_host,
            &cert_fingerprint,
            &discovery.interfaces,
        )
    });

    RemoteServerStatus {
        enabled: true,
        port,
        primary_ip: discovery.primary_ip,
        has_verified_lan: discovery.has_verified_lan,
        computer_name: discovery.computer_name,
        m_dns_host: discovery.m_dns_host,
        pairing_token: token,
        cert_fingerprint,
        interfaces: discovery.interfaces,
        connected_clients: connected,
        qr_url,
    }
}

#[tauri::command]
pub fn regenerate_pairing_token(
    remote_state: State<'_, Arc<RemoteState>>,
) -> String {
    remote_state.reset_token()
}

#[tauri::command]
pub fn sync_desktop_queue_to_remote(
    remote_state: State<'_, Arc<RemoteState>>,
    mut items: Vec<crate::remote::RemoteTrackItem>,
    mut current_index: isize,
    _expected_revision: Option<u64>,
) -> Result<u64, String> {
    let mut q = remote_state.queue.lock();
    for item in &mut items {
        if item.queue_entry_id.is_empty() {
            item.queue_entry_id = uuid::Uuid::new_v4().to_string();
        }
    }
    // Prune past tracks so queue only contains active track (index 0) and upcoming tracks
    if current_index > 0 && (current_index as usize) < items.len() {
        items = items.split_off(current_index as usize);
        current_index = 0;
    }
    let cur_entry_id = if current_index >= 0 && (current_index as usize) < items.len() {
        Some(items[current_index as usize].queue_entry_id.clone())
    } else {
        None
    };
    q.items = items;
    q.current_index = current_index;
    q.current_queue_entry_id = cur_entry_id;
    q.revision += 1;
    let rev = q.revision;
    let count = q.items.len();
    let active_eid = q.current_queue_entry_id.clone();
    drop(q);
    diag_log!(
        DiagCategory::QueueCoordination,
        rev,
        0,
        0,
        "desktop_queue_sync",
        "owner=desktop rev={} items={} idx={} entry={:?}",
        rev,
        count,
        current_index,
        active_eid
    );
    remote_state.broadcast_queue_update();
    Ok(rev)
}

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

fn build_core_http_client(trust_insecure: bool, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    if trust_insecure {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().map_err(|_| "unavailable".to_string())
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
        target.trust_insecure.unwrap_or(false),
        Duration::from_millis(4000),
    )?;
    let mut req = client.get(url);
    if let Some(token) = target.pairing_token.as_deref().filter(|t| !t.trim().is_empty()) {
        req = req.header("x-cadence-token", token.trim());
    }
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
        target.trust_insecure.unwrap_or(false),
        Duration::from_millis(5000),
    )?;
    let mut req = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body_bytes);
    if let Some(token) = target.pairing_token.as_deref().filter(|t| !t.trim().is_empty()) {
        req = req.header("x-cadence-token", token.trim());
    }
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
pub async fn discover_core_nodes() -> Result<Vec<DiscoveredCoreEndpoint>, String> {
    tokio::task::spawn_blocking(|| {
        let daemon = match mdns_sd::ServiceDaemon::new() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let receiver = match daemon.browse("_cadence._tcp.local.") {
            Ok(r) => r,
            Err(_) => {
                let _ = daemon.shutdown();
                return Vec::new();
            }
        };
        let deadline = Instant::now() + Duration::from_millis(1200);
        let mut results = Vec::new();
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
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
                    if results.iter().any(|r: &DiscoveredCoreEndpoint| r.base_url == base_url) {
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
                        cert_fingerprint: props.get_property_val_str("fp").map(|s| s.to_string()),
                        pinned_rs130_udn: props.get_property_val_str("rs130Udn").map(|s| s.to_string()),
                    });
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = daemon.shutdown();
        results
    })
    .await
    .map_err(|e| e.to_string())
}
