use std::net::IpAddr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanInterfaceInfo {
    pub name: String,
    pub ip: String,
    pub is_recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiscoveryInfo {
    pub interfaces: Vec<LanInterfaceInfo>,
    pub primary_ip: String,
    pub computer_name: String,
    pub m_dns_host: String,
    pub port: u16,
    pub pairing_token: String,
}

pub fn generate_pairing_token() -> String {
    // Generate a secure 4-digit numeric pairing token (1000 - 9999)
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(4242);
    format!("{:04}", (nanos % 9000) + 1000)
}

pub fn load_or_create_pairing_token(token_file: &std::path::Path) -> String {
    if token_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(token_file) {
            let trimmed = content.trim();
            if trimmed.len() == 4 && trimmed.chars().all(|c| c.is_ascii_digit()) {
                return trimmed.to_string();
            }
        }
    }
    let new_token = generate_pairing_token();
    let _ = std::fs::write(token_file, &new_token);
    new_token
}

pub fn save_pairing_token(token_file: &std::path::Path, token: &str) {
    let _ = std::fs::write(token_file, token);
}

pub fn get_computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "cadence-core".to_string())
}

pub fn discover_lan_interfaces(target_port: u16, pairing_token: &str) -> RemoteDiscoveryInfo {
    let computer_name = get_computer_name();
    let m_dns_host = format!("{}.local", computer_name.to_lowercase());

    let mut valid_interfaces: Vec<LanInterfaceInfo> = Vec::new();

    if let Ok(netifas) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in netifas {
            if let IpAddr::V4(ipv4) = ip {
                let ip_str = ipv4.to_string();
                let octets = ipv4.octets();

                // 1. Filter out loopback (127.x.x.x)
                if ipv4.is_loopback() {
                    continue;
                }

                // 2. Filter out link-local (169.254.x.x)
                if ipv4.is_link_local() {
                    continue;
                }

                // 3. Filter out virtual adapters by name
                let name_lower = name.to_lowercase();
                if name_lower.contains("vethernet")
                    || name_lower.contains("wsl")
                    || name_lower.contains("docker")
                    || name_lower.contains("tailscale")
                    || name_lower.contains("vmware")
                    || name_lower.contains("virtualbox")
                    || name_lower.contains("hyper-v")
                    || name_lower.contains("loopback")
                {
                    continue;
                }

                // 4. Filter out typical Docker/WSL2 default subnets (172.16.x.x - 172.31.x.x)
                if octets[0] == 172 && (16..=31).contains(&octets[1]) {
                    continue;
                }

                // 5. Score recommendation: standard home/office subnets (192.168.x.x or 10.x.x.x)
                let is_recommended = (octets[0] == 192 && octets[1] == 168)
                    || octets[0] == 10;

                valid_interfaces.push(LanInterfaceInfo {
                    name,
                    ip: ip_str,
                    is_recommended,
                });
            }
        }
    }

    // Sort so recommended physical adapters appear first
    valid_interfaces.sort_by(|a, b| {
        b.is_recommended
            .cmp(&a.is_recommended)
            .then_with(|| a.ip.cmp(&b.ip))
    });

    let primary_ip = valid_interfaces
        .first()
        .map(|i| i.ip.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());

    RemoteDiscoveryInfo {
        interfaces: valid_interfaces,
        primary_ip,
        computer_name,
        m_dns_host,
        port: target_port,
        pairing_token: pairing_token.to_string(),
    }
}
