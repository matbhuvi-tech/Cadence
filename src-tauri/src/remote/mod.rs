pub mod artwork_cache;
pub mod net_discovery;
pub mod pwa_assets;
pub mod server;
pub mod state;
pub mod ws;

pub use net_discovery::{
    build_enriched_qr_url, discover_lan_interfaces, generate_pairing_token,
    load_or_create_pairing_token, register_mdns_service, save_pairing_token, LanInterfaceInfo,
    RemoteDiscoveryInfo,
};
pub use server::start_remote_server;
pub use state::{RemoteEvent, RemoteQueue, RemoteState, RemoteTrackItem};
pub use ws::{get_connected_client_count, replace_queue_preserving_upcoming};
