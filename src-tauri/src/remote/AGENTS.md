# Remote Server Package (`src-tauri/src/remote`)

## Overview
Houses the embedded HTTP and WebSocket server enabling mobile device remote control for Cadence. Serves a progressive web app (PWA) client to smartphones on the local Wi-Fi network and streams low-latency bidirectional playback commands and track telemetry.

## Interface
- `start_remote_server`: Binds HTTP/WebSocket listener on local network interfaces and serves the mobile web client.
- `discover_lan_interfaces`: Enumerates active local IPv4 adapters for QR code pairing generation.
- `RemoteState` & `RemoteEvent`: Event contracts broadcast to connected mobile remote clients (play/pause, now playing, seek, queue changes).
- `artwork_cache.rs`: Serves down-sampled cover art images to mobile remote clients with HTTP cache headers.
- `pwa_assets.rs`: Embedded web assets (HTML, manifest, icons) for zero-dependency remote client serving.
- `ws.rs`: WebSocket connection manager broadcasting state updates with slow heartbeats (>=5s) and event-driven delivery.

## Invariants
- WebSocket broadcasts must remain event-driven with >=5s heartbeat to prevent network PHY EMI/RFI bursts during playback.
- Pairing tokens must be verified before allowing remote clients to execute playback commands or browse libraries.

## Side Effects
- Binds a local TCP port for HTTP and WebSocket traffic.
- Reads cached artwork from disk and serves image byte streams over HTTP.

## Verification
- Run: `cargo test`
