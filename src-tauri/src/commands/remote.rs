use std::sync::Arc;
use serde::Serialize;
use tauri::State;

use crate::remote::{
    discover_lan_interfaces, get_connected_client_count, LanInterfaceInfo, RemoteState,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub enabled: bool,
    pub port: u16,
    pub primary_ip: String,
    pub computer_name: String,
    pub m_dns_host: String,
    pub pairing_token: String,
    pub interfaces: Vec<LanInterfaceInfo>,
    pub connected_clients: usize,
    pub qr_url: String,
}

#[tauri::command]
pub fn get_remote_server_info(
    remote_state: State<'_, Arc<RemoteState>>,
) -> RemoteServerStatus {
    let token = remote_state.token.lock().clone();
    let port = 4040; // Default or configured port
    let discovery = discover_lan_interfaces(port, &token);
    let connected = get_connected_client_count();
    let qr_url = format!("http://{}:{}/?token={}", discovery.primary_ip, port, token);

    RemoteServerStatus {
        enabled: true,
        port,
        primary_ip: discovery.primary_ip,
        computer_name: discovery.computer_name,
        m_dns_host: discovery.m_dns_host,
        pairing_token: token,
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
    items: Vec<crate::remote::RemoteTrackItem>,
    current_index: isize,
) {
    {
        let mut q = remote_state.queue.lock();
        q.items = items;
        q.current_index = current_index;
    }
    remote_state.broadcast_queue_update();
}
