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
    pub primary_ip: Option<String>,
    pub has_verified_lan: bool,
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

fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// Builds the pairing URL encoded in the desktop QR code.
/// Keeps `https://<ip>:<port>/?token=<pin>` as the primary browser-compatible URL
/// while appending mDNS host, SPKI SHA-256 fingerprint, and fallback LAN IPs for
/// the native Android companion app.
pub fn build_enriched_qr_url(
    ip: &str,
    port: u16,
    token: &str,
    m_dns_host: &str,
    cert_fingerprint: &str,
    interfaces: &[LanInterfaceInfo],
) -> String {
    let mut url = format!(
        "https://{}:{}/?token={}",
        ip,
        port,
        percent_encode_component(token)
    );
    if !m_dns_host.trim().is_empty() {
        url.push_str("&mdns=");
        url.push_str(&percent_encode_component(m_dns_host.trim()));
    }
    if !cert_fingerprint.trim().is_empty() {
        url.push_str("&fp=");
        url.push_str(&percent_encode_component(cert_fingerprint.trim()));
    }
    let extra_ips: Vec<&str> = interfaces
        .iter()
        .map(|i| i.ip.as_str())
        .filter(|candidate| *candidate != ip)
        .collect();
    if !extra_ips.is_empty() {
        url.push_str("&ips=");
        url.push_str(&percent_encode_component(&extra_ips.join(",")));
    }
    url
}

fn sanitized_mdns_host(computer_name: &str) -> String {
    let label: String = computer_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let final_label = if label.is_empty() {
        "cadence-core".to_string()
    } else {
        label
    };
    format!("{}.local", final_label)
}

/// Registers `_cadence._tcp.local.` via mDNS/DNS-SD for zero-config mobile discovery.
/// Failures are logged and ignored so the HTTPS/WebSocket remote still starts cleanly.
pub fn register_mdns_service(
    discovery: &RemoteDiscoveryInfo,
    port: u16,
    cert_fingerprint: &str,
) -> Option<mdns_sd::ServiceDaemon> {
    let ips: Vec<IpAddr> = discovery
        .interfaces
        .iter()
        .filter_map(|iface| iface.ip.parse::<IpAddr>().ok())
        .collect();
    if ips.is_empty() {
        return None;
    }

    let daemon = match mdns_sd::ServiceDaemon::new() {
        Ok(d) => d,
        Err(err) => {
            eprintln!("[Cadence Remote] mDNS daemon unavailable: {}", err);
            return None;
        }
    };

    let host_fqdn = format!("{}.", discovery.m_dns_host.trim_end_matches('.'));
    let instance_name = format!("Cadence ({})", discovery.computer_name);

    let props = [
        ("path", "/"),
        ("proto", "https"),
        ("fp", cert_fingerprint),
        ("host", discovery.computer_name.as_str()),
        ("mdns", discovery.m_dns_host.as_str()),
    ];

    match mdns_sd::ServiceInfo::new(
        "_cadence._tcp.local.",
        &instance_name,
        &host_fqdn,
        ips.as_slice(),
        port,
        &props[..],
    ) {
        Ok(service_info) => {
            if let Err(err) = daemon.register(service_info) {
                eprintln!("[Cadence Remote] mDNS service registration failed: {}", err);
                let _ = daemon.shutdown();
                return None;
            }
            eprintln!(
                "[Cadence Remote] mDNS registered _cadence._tcp.local. on {}:{} ({:?})",
                host_fqdn, port, ips
            );
            Some(daemon)
        }
        Err(err) => {
            eprintln!("[Cadence Remote] mDNS ServiceInfo build failed: {}", err);
            let _ = daemon.shutdown();
            None
        }
    }
}

pub fn is_valid_physical_lan_interface(name: &str, ipv4: std::net::Ipv4Addr) -> Option<LanInterfaceInfo> {
    // 1. Filter out loopback (127.x.x.x)
    if ipv4.is_loopback() {
        return None;
    }

    // 2. Filter out link-local autoconfiguration (169.254.x.x)
    if ipv4.is_link_local() {
        return None;
    }

    // 3. Filter out virtual adapters by adapter name
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
        return None;
    }

    let octets = ipv4.octets();

    // 4. For RFC 1918 Class B (172.16.0.0/12), reject if name matches virtual/container keywords
    if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        if name_lower.contains("vethernet")
            || name_lower.contains("docker")
            || name_lower.contains("wsl")
            || name_lower.contains("hyper-v")
        {
            return None;
        }
    }

    // 5. Score recommendation: standard home/office subnets (192.168.x.x, 10.x.x.x, 172.16.x.x)
    let is_recommended = (octets[0] == 192 && octets[1] == 168)
        || octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]));

    Some(LanInterfaceInfo {
        name: name.to_string(),
        ip: ipv4.to_string(),
        is_recommended,
    })
}

pub fn discover_lan_interfaces(target_port: u16, pairing_token: &str) -> RemoteDiscoveryInfo {
    let computer_name = get_computer_name();
    let m_dns_host = sanitized_mdns_host(&computer_name);

    let mut valid_interfaces: Vec<LanInterfaceInfo> = Vec::new();

    if let Ok(netifas) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in netifas {
            if let IpAddr::V4(ipv4) = ip {
                if let Some(info) = is_valid_physical_lan_interface(&name, ipv4) {
                    valid_interfaces.push(info);
                }
            }
        }
    }

    // Sort so recommended physical adapters appear first
    valid_interfaces.sort_by(|a, b| {
        b.is_recommended
            .cmp(&a.is_recommended)
            .then_with(|| a.ip.cmp(&b.ip))
    });

    let primary_ip = valid_interfaces.first().map(|i| i.ip.clone());
    let has_verified_lan = primary_ip.is_some();

    RemoteDiscoveryInfo {
        interfaces: valid_interfaces,
        primary_ip,
        has_verified_lan,
        computer_name,
        m_dns_host,
        port: target_port,
        pairing_token: pairing_token.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn test_filter_loopback() {
        let ip = Ipv4Addr::new(127, 0, 0, 1);
        assert!(is_valid_physical_lan_interface("Loopback", ip).is_none());
        assert!(is_valid_physical_lan_interface("Wi-Fi", ip).is_none());
    }

    #[test]
    fn test_filter_link_local() {
        let ip = Ipv4Addr::new(169, 254, 39, 234);
        assert!(is_valid_physical_lan_interface("Ethernet", ip).is_none());
    }

    #[test]
    fn test_filter_virtual_adapters() {
        let ip = Ipv4Addr::new(192, 168, 1, 50);
        assert!(is_valid_physical_lan_interface("vEthernet (WSL)", ip).is_none());
        assert!(is_valid_physical_lan_interface("docker0", ip).is_none());
        assert!(is_valid_physical_lan_interface("tailscale0", ip).is_none());
        assert!(is_valid_physical_lan_interface("Hyper-V Virtual Adapter", ip).is_none());
    }

    #[test]
    fn test_accept_physical_lan() {
        let ip = Ipv4Addr::new(192, 168, 1, 120);
        let res = is_valid_physical_lan_interface("Wi-Fi", ip);
        assert!(res.is_some());
        let info = res.unwrap();
        assert_eq!(info.ip, "192.168.1.120");
        assert!(info.is_recommended);
    }

    #[test]
    fn test_class_b_handling() {
        let ip = Ipv4Addr::new(172, 20, 10, 5);
        // Physical interface on Class B should be accepted
        assert!(is_valid_physical_lan_interface("Ethernet 2", ip).is_some());
        // Virtual interface on Class B should be filtered
        assert!(is_valid_physical_lan_interface("docker0", ip).is_none());
    }

    #[test]
    fn test_build_enriched_qr_url() {
        let interfaces = vec![
            LanInterfaceInfo {
                name: "Wi-Fi".to_string(),
                ip: "192.168.1.42".to_string(),
                is_recommended: true,
            },
            LanInterfaceInfo {
                name: "Ethernet".to_string(),
                ip: "10.0.0.15".to_string(),
                is_recommended: true,
            },
        ];
        let url = build_enriched_qr_url(
            "192.168.1.42",
            4041,
            "9182",
            "studio-pc.local",
            "abcdef1234",
            &interfaces,
        );
        assert_eq!(
            url,
            "https://192.168.1.42:4041/?token=9182&mdns=studio-pc.local&fp=abcdef1234&ips=10.0.0.15"
        );
    }
}
