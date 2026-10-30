# Verified Wi-Fi QR Gating & Modular React Mobile PWA Remote

*   **Author:** Mathan & Cadence Core Engineering Swarm
*   **Status:** Approved
*   **Date:** 2026-10-30

--------------------------------------------------------------------------------

## Overview

Cadence provides an embedded Axum HTTP and WebSocket daemon within its native Tauri v2 architecture to deliver local network remote control to smartphones. This design document establishes two foundational architectural upgrades:
1. **Deterministic Gated QR Pairing:** Eliminates the unroutable `127.0.0.1` fallback by strictly gating desktop QR code rendering on a verified physical Wi-Fi or Ethernet IPv4 address, accompanied by diagnostic fallback states and manual interface selection.
2. **Dedicated Modular React 19 PWA:** Replaces the legacy 1,948-line monolithic HTML file (`remote_pwa.html`) with an Apple HIG-compliant, responsive React 19 / Tailwind CSS v4 Progressive Web App. The PWA is embedded directly into the native Rust binary via `rust-embed` and served by Axum, focused strictly on high-fidelity playback control, catalog browsing, queue and playlist management, and real-time bit-perfect stream diagnostics.

## The Problem

### 1. Loopback Address Fallback Race Condition
In `MobileRemoteModal.tsx`, the QR canvas renders synchronously upon component mounting. Before the asynchronous Tauri IPC command `get_remote_server_info` resolves active network adapters, the component's state defaults to an empty IP. The modal falls back to `http://127.0.0.1:4040/?token=...`. When scanned with an Android or iOS handset, the phone attempts to connect to its own local loopback interface, resulting in an immediate connection failure (`ERR_CONNECTION_REFUSED` / "Site can't be reached").

### 2. Monolithic Legacy Client Architecture
The existing remote client (`src-tauri/src/remote/remote_pwa.html`) is an unmaintainable 70 KB single file combining inline CSS, manual DOM string concatenation, and brittle vanilla JavaScript. It lacks component modularity, state management, and visual parity with the desktop application's editorial catalog layout, while attempting to manage albums, tracks, volume, and telemetry.

### 3. Audiophile Transport Purity Risk
Mobile remote interactions must never degrade the primary listening experience on the desktop host. Unthrottled background reconnects, aggressive telemetry polling, or unbounded image queries could induce host network PHY jitter, CPU power-state transients, or violate **Global Invariant 1 (Storage Bus Silence During Playback)** and **Global Invariant 4 (Network PHY Quietness & Packet Pacing)**.

## Goals

*   **Zero-Loopback QR Guarantee:** Guarantee that the desktop QR code generator never encodes `127.0.0.1`. Gate canvas rendering exclusively on a verified, non-virtual physical LAN IPv4 interface.
*   **Honest Diagnostic Fallbacks:** Provide clear, non-blocking UI states when no routable LAN interface is detected, including adapter selection, manual IP/PIN input, and Windows Network Profile troubleshooting hints.
*   **Modular React 19 PWA:** Build a lightweight, responsive React 19 / TypeScript / Tailwind CSS v4 PWA in `pwa/` (bundle < 150 KB gzipped) embedded into `cadence-core` via `rust-embed`.
*   **Strict Scope Boundary (Zero Curation):** Limit the mobile remote strictly to listening workflows: album browsing, facet filtering, queue management, playlists, and bit-perfect playback telemetry. Explicitly exclude metadata editing, sidecar commits, and AI audits.
*   **Guaranteed Network Silence:** Implement visibility-gated connection management: suspend all WebSocket reconnection timers when the mobile device is asleep or locked (`visibilityState === 'hidden'`), eliminating background TCP chatter and host interrupt churn.
*   **Bit-Perfect Volume Transparency:** Visually lock the mobile volume slider with a `Direct Hardware Transport` indicator when Bit-Perfect / WASAPI Exclusive mode is active, preventing phantom software attenuation.

## Non-Goals

*   **No Mobile Metadata Management:** Two-phase commit staging, ID3/Vorbis tag writes, sidecar generation, and AI curation audits remain strictly desktop-exclusive.
*   **No Cloud or Relay Infrastructure:** Operates exclusively peer-to-peer over local Wi-Fi without external servers, telemetry collectors, or cloud authentication.
*   **No Native App Store Distribution:** Maintained as an installable Progressive Web App (PWA) served directly by Axum; no iOS App Store or Google Play Store builds.
*   **No Multi-Zone Audio Streaming to Handset:** The mobile device functions strictly as a controller and visual display; audio decoding and playback transport remain strictly on the desktop DAC / WASAPI engine.

## Resolved Architectural Decisions

*   **Decision 1 (Build Orchestration & Dev Velocity)**: Root build chains `"build": "npm run build:pwa && tsc -b && vite build"`. Running `npm run tauri:dev` runs an upfront build of `pwa/` so `rust-embed` resolves compiled assets; for rapid mobile frontend iteration, engineers run `"dev:pwa": "npm run --prefix pwa dev"` on port 5174, which proxies API requests to the desktop daemon at `:4040`.
*   **Decision 2 (Compression & In-Memory Footprint)**: Static assets in `src-tauri/src/remote/dist/` are embedded uncompressed in executable memory via `rust-embed` (< 2 MB footprint). Content-hashed assets (`/assets/*`) are served with `Cache-Control: public, max-age=31536000, immutable`, while runtime response compression is handled transparently by Axum's `tower-http` compression layer.
*   **Decision 3 (Lock-Screen MediaSession Reliability)**: Handset lock-screen transport triggers (`play`, `pause`, `next`, `previous`) execute via on-demand HTTP REST requests (`POST /api/remote/playback/:action`), ensuring instant command delivery even when the WebSocket connection is intentionally closed during screen sleep.

## Critical User Journeys (CUJs)

### CUJ 1: First-Time Pairing via Verified LAN QR Code
*   **Given**: The user has Cadence running on Windows with an active Wi-Fi connection (`192.168.1.120`).
*   **When**: The user clicks the Mobile Remote icon in the top header.
*   **Then**: The modal displays a verified badge `Wi-Fi (192.168.1.120)`, renders a high-contrast QR code encoding `http://192.168.1.120:4040/?token=XXXX`, and scanning with Android Chrome instantly loads the mobile PWA without "Site can't be reached" errors.

### CUJ 2: Desktop Offline / Virtual Adapter Safeguard
*   **Given**: The desktop PC has Wi-Fi disconnected and only possesses virtual adapters (e.g., WSL, vEthernet).
*   **When**: The user opens the Mobile Remote Modal.
*   **Then**: The modal suppresses QR canvas generation, displays a prominent `WifiOff` diagnostic card (*"No Local Wi-Fi Connection Found"*), and provides a "Refresh Network Interfaces" button alongside troubleshooting hints (e.g., setting Windows Network Profile to Private).

### CUJ 3: Seamless Mobile Listening, Queue Control & Lock-Screen Sync
*   **Given**: The user has paired their Android Chrome browser with Cadence.
*   **When**: The user browses albums, applies a `Hi-Res PCM` filter, adds an album to the queue, and locks their phone.
*   **Then**: Playback triggers instantly on the desktop DAC; the mobile PWA updates the active track via event-driven WebSocket; when the screen locks, the PWA suspends all TCP polling while mirroring metadata and transport buttons to the phone's lock screen via `navigator.mediaSession`; pressing "Pause" on the lock screen dispatches an on-demand REST command without requiring an active socket.

### CUJ 4: Audiophile Bit-Perfect Mode Volume Guard
*   **Given**: The desktop AudioEngine is actively streaming DSD64 or 192kHz/24-bit PCM in WASAPI Exclusive Bit-Perfect mode.
*   **When**: The user opens the Now Playing drawer on their mobile device.
*   **Then**: The mobile UI displays gold `Direct Hardware Transport` and `Bit-Perfect` badges, locks the volume slider to 100%, and informs the user to adjust volume via their analog amplifier.


--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. Architectural Overview & Component Boundaries

The updated mobile remote architecture decouples pairing discovery, static asset delivery, and runtime telemetry while preserving strict isolation from the native audio transport thread (`cadence-paced-stream`).

```mermaid
graph TD
    subgraph DesktopHost ["Cadence Desktop Host (Tauri v2 + Rust)"]
        subgraph NativeAudio ["Audio Core & DB"]
            Engine[AudioEngine\nWASAPI Exclusive / ASIO]
            DB[(SQLite Library DB\n%APPDATA%/cadence.db)]
        end

        subgraph RemoteDaemon ["Embedded Axum Daemon (:4040)"]
            NetDisc[net_discovery.rs\nPhysical LAN Validator]
            AssetRouter[pwa_assets.rs\nrust-embed PWA Assets]
            RestAPI[REST API Router\n/api/remote/*]
            WS[ws.rs\nClamped WebSocket & Pacing]
        end

        subgraph DesktopUI ["Desktop Presentation"]
            Modal[MobileRemoteModal.tsx\nGated QR & Interface Switcher]
        end
    end

    subgraph MobileDevice ["Mobile Handset (Android Chrome / iOS Safari)"]
        subgraph ReactPWA ["Modular React 19 PWA (pwa/)"]
            SocketHook[useRemoteSocket.ts\nVisibility-Gated Connection]
            NowPlayingView[Now Playing Drawer\nBit-Perfect Badges & Locked Volume]
            CatalogView[Catalog View\nAlbums, Facet Filters & Languages]
            QueueView[Queue & Playlists\nReordering & Track Management]
            MediaSess[Media Session API\nLock Screen Metadata & Controls]
        end
    end

    Modal <-->|IPC: get_remote_server_info| NetDisc
    NetDisc -->|Verified Physical IPv4| Modal
    AssetRouter -->|HTTP GET /assets/*| ReactPWA
    RestAPI <-->|Read-Only Queries| DB
    Engine -->|State Events| WS
    WS <==|Clamped Event WS /api/remote/ws| SocketHook
    SocketHook --> NowPlayingView
    SocketHook --> QueueView
    SocketHook --> MediaSess
    MediaSess -.->|On-Demand REST Actions| RestAPI
```

### 2. Subsystem 1: Verified Physical LAN QR Gating (`net_discovery.rs` & `MobileRemoteModal.tsx`)

#### A. Backend Interface Hardening (`src-tauri/src/remote/net_discovery.rs`)
The network discovery module is refactored from an unverified fallback to a strict, typed validator:
* **Contract Refactoring**:
  ```rust
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
  ```
* **Strict Physical Adapter Filter**:
  * Reject loopback (`127.0.0.0/8`).
  * Reject link-local autoconfiguration (`169.254.0.0/16`).
  * Filter out virtual/container adapters by name: `vethernet`, `wsl`, `docker`, `tailscale`, `vmware`, `virtualbox`, `hyper-v`.
  * For Class B private subnet (`172.16.0.0/12`), only reject if the adapter name matches container/virtual keywords; allow physical network cards on `172.16.x.x` to pass.
  * Validate against active physical IPv4 subnets (`192.168.0.0/16`, `10.0.0.0/8`, and unmasked `172.16.0.0/12`).
  * If no physical interfaces remain, `primary_ip` evaluates to `None` and `has_verified_lan` is set to `false` (never defaulting to `"127.0.0.1"`).

#### B. Desktop Modal State Machine (`src/components/Modals/MobileRemoteModal.tsx`)
The desktop pairing modal adopts a robust 3-state lifecycle:
1. `Discovering`: Renders an animated pulse skeleton while asynchronous network enumeration completes. Suppresses canvas creation.
2. `Verified LAN`: Triggered when `has_verified_lan === true` and `selectedIp` is a non-empty string. Renders high-contrast QR code (`QRCode.toCanvas`) with an interface picker dropdown allowing the user to select between alternate physical adapters if multiple exist (e.g., Wi-Fi vs. Gigabit Ethernet).
3. `No LAN / Diagnostic Fallback`: Triggered when `has_verified_lan === false` or `primary_ip === null`. Replaces QR canvas with an Apple HIG diagnostic card:
   * Prominent `WifiOff` icon and copy: *"No Local Wi-Fi Connection Found"*.
   * Explicit "Refresh Network Interfaces" button to re-trigger discovery immediately.
   * Troubleshooting checklist: verify PC is connected to home Wi-Fi; ensure Windows Defender Firewall network profile is set to **Private**; provide a direct numeric PIN entry guide.

### 3. Subsystem 2: Embedded Static Asset Serving via `rust-embed` (`pwa_assets.rs` & `server.rs`)

#### A. Embedding the Compiled React Application
* Replace raw string constants in `src-tauri/src/remote/pwa_assets.rs` with `rust-embed`:
  ```rust
  use rust_embed::RustEmbed;

  #[derive(RustEmbed)]
  #[folder = "src/remote/dist/"]
  pub struct PwaAssets;
  ```
* To support clean checkouts and CI environments, check in `src-tauri/src/remote/dist/.gitkeep` with an initial fallback `index.html` shell so `cargo test` and `cargo check` compile cleanly without requiring prior node execution.

#### B. Axum Asset Routing & Caching Pipeline (`src-tauri/src/remote/server.rs`)
* **Route Precedence**: Mount `/api/remote/*` REST endpoints and `/api/remote/ws` WebSocket handler first. Mount embedded asset routes second, with `fallback(serve_embedded_pwa)` mounted at the root router level to guarantee API routes are never hijacked by SPA fallback.
* **Static Route Handler**:
  * Content-hashed bundles (`/assets/*`): `Cache-Control: public, max-age=31536000, immutable`.
  * App shell (`/`, `/index.html`, `/manifest.json`): `Cache-Control: no-cache, must-revalidate`.
  * Return `StatusCode::NOT_FOUND` for missing `/assets/*` files to prevent infinite recursive fallback.
* **Legacy Codebase Removal**: `src-tauri/src/remote/remote_pwa.html` (1,948 lines) is completely deleted.

### 4. Subsystem 3: Modular React 19 Mobile PWA (`pwa/`)

#### A. Directory Layout & Bundling
```text
pwa/
├── index.html                   # HTML entry point with viewport-fit=cover & apple meta tags
├── package.json                 # React 19, Lucide, Tailwind CSS v4, Vite
├── tsconfig.json                # React TypeScript compilation config
├── tsconfig.node.json           # Vite Node tooling config
├── vite.config.ts               # Outputs hashed assets to ../src-tauri/src/remote/dist/
├── src/
│   ├── vite-env.d.ts           # Vite client type definitions
│   ├── main.tsx                # Mounts root with safe-area and touch layout
│   ├── App.tsx                 # Shell, tab router, and global playback state
│   ├── hooks/
│   │   ├── useRemoteSocket.ts  # Visibility-gated WebSocket client
│   │   ├── useCatalog.ts       # Debounced, paged SQLite album & artist loader
│   │   └── useMediaSession.ts  # Phone lock-screen metadata and action bridge
│   ├── components/
│   │   ├── Navigation/
│   │   │   ├── TopHeader.tsx   # Concentric logo, connection status pill, safe-area top padding
│   │   │   └── TabBar.tsx      # Bottom thumb-zone navigation with safe-area bottom padding
│   │   ├── NowPlaying/
│   │   │   ├── ArtworkCard.tsx # High-res album art with smooth touch gestures
│   │   │   ├── Scrubber.tsx    # Optimistic scrub slider with throttled commit
│   │   │   ├── Transport.tsx   # 48px touch targets: Play/Pause, Next, Prev, Shuffle, Repeat
│   │   │   └── VolumeGuard.tsx # Locked hardware volume slider with gold Purity badge
│   │   ├── Catalog/
│   │   │   ├── AlbumGrid.tsx   # Two-column infinite scroll with lazy-loaded thumbnails
│   │   │   ├── FacetShelf.tsx  # Horizontal chip filters (Hi-Res, DSD, PCM, Language, Genre)
│   │   │   └── SearchBar.tsx   # In-place search for albums, artists, and composers
│   │   └── Queue/
│   │       ├── QueueList.tsx   # Tactile track list with drag handles and remove triggers
│   │       └── PlaylistBar.tsx # Quick-trigger playlist switcher
│   └── styles/
│       └── globals.css         # Tailwind v4 theme aligned with desktop dark-mode palette
```

#### B. Guaranteed Network Silence Protocol (`useRemoteSocket.ts`)
To enforce **Audiophile Invariant 4 (Network PHY Quietness)**:
* **Visibility Gating**:
  ```typescript
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // Handset locked or tab hidden: pause reconnect timers and stop polling completely
        socketRef.current?.close();
        clearTimeout(reconnectTimerRef.current);
      } else if (document.visibilityState === 'visible') {
        // Handset unlocked: perform exactly one gentle reconnect handshake
        connectSocket();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);
  ```
* **Lock-Screen Transport Bridge**: While the handset screen is off and the WebSocket is dormant, user interactions on `navigator.mediaSession` dispatch on-demand HTTP POST requests (`POST /api/remote/playback/:action`), ensuring instant response without ongoing TCP chatter.
* **Backoff Strategy**: Reconnections use a bounded exponential backoff (min 3.0s, max 15.0s, 1.5x multiplier) with 10% jitter to eliminate network bus contention and SYN flooding.


--------------------------------------------------------------------------------

## Audiophile Impact Assessment

### 1. Storage Bus Silence (Global Invariant 1)
* **Risk**: Dynamic catalog browsing or cover art loading on mobile could trigger disk reads on archival music storage mounts during active playback.
* **Protection Mechanism**: All `/api/remote/library/releases` and `/api/remote/library/tracks` endpoints execute strictly against the local SQLite database (`%APPDATA%/cadence.db`). `/api/remote/library/artwork/:id` serves thumbnail images exclusively from cached SQLite blobs or `%LOCALAPPDATA%/Cadence/cache/artwork/`. On-the-fly extraction from raw audio file tags is strictly gated by idle conditions (`!is_playing && !is_paused && cooldown_elapsed`). Zero disk reads occur on music drives during playback or within the 30-second cooldown period.

### 2. Network PHY Quietness & Packet Pacing (Global Invariant 4)
* **Risk**: High-frequency mobile polling or background reconnect storms creating RF/EMI bursts that disrupt DAC packet pacing.
* **Protection Mechanism**:
  * WebSocket telemetry is event-driven; periodic sync uses a slow 5-second heartbeat only during active playback.
  * When the handset screen is locked, the WebSocket is suspended, emitting zero TCP packets.
  * Remote HTTP and WebSocket listeners use clamped 32 KB socket buffers with `TCP_NODELAY`.
  * Artwork delivery is concurrency-capped at 4 parallel requests via `ConcurrencyLimitLayer`.

### 3. Thread & CPU Core Isolation (Global Invariant 2)
* **Risk**: Axum request processing contending with audio streaming pacing loops.
* **Protection Mechanism**: The remote Axum daemon executes entirely on the shared Tokio async threadpool. The native audio streaming thread (`cadence-paced-stream`) runs synchronously with Windows MMCSS `"Pro Audio"` priority, `timeBeginPeriod(1)`, and is affinity-pinned to isolated CPU cores away from Cores 0 and 1. Remote mobile requests cannot interrupt or preempt audio transport loops.

### 4. Zero-Allocation & Memory Headroom (Global Invariant 3)
* **Risk**: Embedded PWA assets increasing heap churn or compromising `VirtualLock` pinned buffers.
* **Protection Mechanism**: `rust-embed` bundles static assets into executable memory during compilation. Total PWA asset footprint is < 2 MB, residing in process text/rodata sections with zero heap allocations during runtime playback loops.

### 5. Bit-Perfect Signal Path Integrity (Global Invariant 5)
* **Risk**: Mobile volume slider introducing software digital attenuation in bit-perfect mode.
* **Protection Mechanism**: When Bit-Perfect / WASAPI Exclusive mode is active, the mobile UI completely locks the volume slider to 100% and displays a gold `Direct Hardware Transport` badge, ensuring bit-perfect PCM/DSD streams remain untouched.


--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Refactoring the Legacy Single-File HTML Client (`remote_pwa.html`)

*   **Pros**: Requires no additional frontend build configuration, keeps Rust embedding simple via string literals, and maintains zero NPM dependencies for mobile.
*   **Cons**: Maintaining 1,948 lines of untyped JavaScript, inline styles, and manual DOM string concatenations makes implementing dynamic facet filtering, drag-and-drop queue management, and robust state synchronization brittle and error-prone.
*   **Reason for Rejection**: Directly violates the primary user requirement of elevating the mobile experience to be on par with or superior to desktop. It retains immense technical debt and lacks component modularity.

### Alternative B: Serving the Desktop React App to Mobile with Responsive Media Queries

*   **Pros**: Single frontend codebase to build and maintain; guarantees 100% design token alignment.
*   **Cons**:
    *   The desktop client bundle is large (~1.5 MB+) and imports desktop-heavy dependencies (e.g., Lucide icon full sets, complex modal managers, and desktop curation views).
    *   The desktop app relies fundamentally on Tauri IPC (`window.__TAURI_INTERNALS__`), requiring a complex, brittle HTTP proxy layer to mock desktop IPC commands for browser execution.
    *   Violates the strict **Zero-Curation Boundary** by downloading curation, sidecar, and tag-editing code to mobile handsets, increasing memory footprint and violating **Audiophile Invariant 4 (Network PHY Quietness)**.
*   **Reason for Rejection**: Extreme bundle bloat, excessive initial Wi-Fi payload transfer on audio host startup, and unnecessary architectural complexity mocking desktop-only Tauri APIs.

### Alternative C: Native Mobile Applications (iOS / Android Swift/Kotlin or React Native)

*   **Pros**: Native background audio service integration, persistent socket connections, and access to platform-specific haptic engines.
*   **Cons**: Requires maintaining separate native codebases, developer program enrollments, app store review delays, and imposes friction on users who simply want to control their local music player immediately from any phone on their Wi-Fi.
*   **Reason for Rejection**: Unnecessary maintenance overhead and friction. A well-engineered local PWA served directly by Axum delivers 98% of native performance with zero installation barriers.

### Alternative D: Enforcing HTTPS with Self-Signed Certificates on Local LAN

*   **Pros**: Unlocks HTTPS-restricted browser APIs (e.g., persistent background service workers, Web Locks API).
*   **Cons**: Modern mobile browsers (iOS Safari and Android Chrome) display aggressive full-screen security warnings (*"Your connection is not private" / ERR_CERT_AUTHORITY_INVALID*) when connecting to raw LAN IPs with self-signed TLS certificates. Forcing users to manually install root CA certificates destroys instant QR code pairing.
*   **Reason for Rejection**: Unacceptable onboarding friction. Local HTTP combined with `visibilitychange` lifecycle management achieves reliable, quiet networking without certificate trust roadblocks.


--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create, Modify, or Delete

#### 1. `src-tauri/src/remote/net_discovery.rs` (Modify)
*   **Type / Scope**: Rust Native Network Discovery Module
*   **Proposed Changes**:
    *   Update `RemoteDiscoveryInfo` struct to change `primary_ip: String` to `primary_ip: Option<String>` and add `pub has_verified_lan: bool`.
    *   Refactor `discover_lan_interfaces()`:
        *   Filter out loopback (`127.0.0.0/8`) and link-local (`169.254.0.0/16`).
        *   Filter out virtual adapters (`vethernet`, `wsl`, `docker`, `tailscale`, `vmware`, `virtualbox`, `hyper-v`).
        *   For `172.16.0.0/12`, only filter if the adapter name matches container/virtual patterns; allow valid physical adapters to pass.
        *   Set `has_verified_lan = true` and `primary_ip = Some(ip)` only if a physical adapter passes validation.
        *   If no physical adapters exist, return `primary_ip = None` and `has_verified_lan = false` (never fallback to `"127.0.0.1"`).
*   **Rationale**: Fixes the root-cause bug where desktop QR codes encode an unroutable loopback IP when network enumeration is delayed or disconnected.

#### 2. `src-tauri/src/commands/remote.rs` (Modify)
*   **Type / Scope**: Tauri IPC Command Bridge
*   **Proposed Changes**:
    *   Update `RemoteServerStatus` struct:
        ```rust
        pub struct RemoteServerStatus {
            pub enabled: bool,
            pub port: u16,
            pub primary_ip: Option<String>,
            pub has_verified_lan: bool,
            pub computer_name: String,
            pub m_dns_host: String,
            pub pairing_token: String,
            pub interfaces: Vec<LanInterfaceInfo>,
            pub connected_clients: usize,
            pub qr_url: Option<String>,
        }
        ```
    *   Construct `qr_url = discovery.primary_ip.as_ref().map(|ip| format!("http://{}:{}/?token={}", ip, port, token))` to prevent runtime errors when offline.
*   **Rationale**: Guarantees type safety and prevents null pointer formatting bugs in the IPC layer.

#### 3. `src/services/tauriBridge.ts` (Modify)
*   **Type / Scope**: Frontend Tauri IPC Client & Mock Service
*   **Proposed Changes**:
    *   Update `RemoteServerStatus` TypeScript interface:
        ```typescript
        export interface RemoteServerStatus {
          enabled: boolean
          port: number
          primaryIp: string | null
          hasVerifiedLan: boolean
          computerName: string
          mDnsHost: string
          pairingToken: string
          interfaces: LanInterfaceInfo[]
          connectedClients: number
          qrUrl: string | null
        }
        ```
    *   Update mock response in `getRemoteServerInfo()` to return a realistic verified IP (`192.168.1.100`, `hasVerifiedLan: true`, `qrUrl: 'http://192.168.1.100:4040/?token=4242'`) by default, with an exported state toggle to simulate the `no_lan` diagnostic card.
*   **Rationale**: Guarantees compile-time type safety across frontend and native boundaries while enabling full UI verification in browser dev mode.

#### 4. `src/components/Modals/MobileRemoteModal.tsx` (Modify)
*   **Type / Scope**: React Desktop Pairing Modal Component
*   **Proposed Changes**:
    *   Implement 3-stage lifecycle state machine: `'discovering' | 'verified' | 'no_lan'`.
    *   Gate QR canvas generation: strictly suppress `QRCode.toCanvas()` unless `status?.hasVerifiedLan === true` and `selectedIp` is a non-empty string not equal to `127.0.0.1`.
    *   Render animated skeleton pulse during `'discovering'`.
    *   Render Apple HIG diagnostic card with `WifiOff` icon, guidance copy, Windows Network Profile tips, and an explicit "Refresh Network Interfaces" button during `'no_lan'`.
    *   Add dropdown selector for switching between verified physical network adapters when multiple exist.
*   **Rationale**: Prevents users from scanning unroutable QR codes and provides actionable troubleshooting feedback.

#### 5. `src-tauri/Cargo.toml` (Modify)
*   **Type / Scope**: Rust Package Manifest
*   **Proposed Changes**:
    *   Add `rust-embed = { version = "8.5", features = ["interpolate-folder-path", "compression"] }`.
    *   Add `mime_guess = "2.0"`.
*   **Rationale**: Required to compile the production PWA static assets directly into the `cadence-core` binary and resolve content types.

#### 6. `src-tauri/src/remote/pwa_assets.rs` (Modify)
*   **Type / Scope**: Rust Embedded Asset Declarations
*   **Proposed Changes**:
    *   Replace raw string constants (`MOBILE_PWA_HTML`, `MANIFEST_JSON`, icons) with `rust-embed`:
        ```rust
        use rust_embed::RustEmbed;

        #[derive(RustEmbed)]
        #[folder = "src/remote/dist/"]
        pub struct PwaAssets;
        ```
*   **Rationale**: Eliminates manual maintenance of raw string assets and integrates automated frontend bundle embedding.

#### 7. `src-tauri/src/remote/dist/.gitkeep` (Create)
*   **Type / Scope**: Build Placeholder Asset Directory
*   **Proposed Changes**: Create placeholder `.gitkeep` with an initial lightweight `index.html` shell.
*   **Rationale**: Prevents `cargo check` and `cargo test` from failing on fresh checkouts prior to running `npm run build:pwa`.

#### 8. `src-tauri/src/remote/server.rs` (Modify)
*   **Type / Scope**: Axum HTTP & Static Asset Router
*   **Proposed Changes**:
    *   Mount API routes (`/api/remote/*` and `/api/remote/ws`) first.
    *   Mount static asset handler second with fallback:
        ```rust
        async fn serve_embedded_pwa(uri: Uri) -> impl IntoResponse {
            let path = uri.path().trim_start_matches('/');
            if let Some(file) = PwaAssets::get(path) {
                let mime = mime_guess::from_path(path).first_or_octet_stream();
                let cache = if path.starts_with("assets/") {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache, must-revalidate"
                };
                ([(header::CONTENT_TYPE, mime.as_ref()), (header::CACHE_CONTROL, cache)], file.data).into_response()
            } else if !path.starts_with("api/") && !path.starts_with("assets/") {
                let index = PwaAssets::get("index.html").expect("index.html must exist");
                ([(header::CONTENT_TYPE, "text/html"), (header::CACHE_CONTROL, "no-cache, must-revalidate")], index.data).into_response()
            } else {
                StatusCode::NOT_FOUND.into_response()
            }
        }
        ```
*   **Rationale**: Delivers high-performance, cached static asset serving with proper SPA fallback semantics without hijacking API endpoints.

#### 9. `src-tauri/src/remote/remote_pwa.html` (Delete)
*   **Type / Scope**: Legacy Monolithic HTML Client
*   **Proposed Changes**: Delete file completely.
*   **Rationale**: Removes 1,948 lines of technical debt and prevents dual-maintenance confusion.

#### 10. `package.json` (Modify)
*   **Type / Scope**: Root NPM Package Manifest
*   **Proposed Changes**:
    *   Add `"build:pwa": "npm run --prefix pwa build"`.
    *   Update `"build"` script: `"npm run build:pwa && tsc -b && vite build"`.
    *   Add `"dev:pwa": "npm run --prefix pwa dev"`.
*   **Rationale**: Ensures automated build orchestration so compiled mobile assets are always synchronized with desktop releases.

#### 11. `pwa/package.json` (Create)
*   **Type / Scope**: Mobile PWA NPM Package Manifest
*   **Proposed Changes**:
    *   Configure dependencies: `react` (v19), `react-dom` (v19), `lucide-react`, `clsx`, `tailwind-merge`.
    *   Configure dev dependencies: `typescript`, `vite`, `@vitejs/plugin-react`, `tailwindcss` (v4), `@tailwindcss/vite`.
*   **Rationale**: Establishes lightweight, modular dependency tree for the mobile client.

#### 12. `pwa/tsconfig.json` & `pwa/tsconfig.node.json` (Create)
*   **Type / Scope**: Mobile PWA TypeScript Configuration
*   **Proposed Changes**: Configure React JSX transform, strict mode, DOM types, and Node build scripts.
*   **Rationale**: Required for `tsc -b` and Vite TypeScript compilation in `pwa/`.

#### 13. `pwa/vite.config.ts` (Create)
*   **Type / Scope**: Mobile PWA Bundler Configuration
*   **Proposed Changes**:
    *   Set `outDir` to `../src-tauri/src/remote/dist`.
    *   Set `base: './'` for relative asset references.
    *   Enable `@tailwindcss/vite` plugin.
    *   Configure server proxy to `http://localhost:4040` for local dev.
*   **Rationale**: Compiles hashed static assets directly into the directory embedded by Rust and facilitates fast mobile dev.

#### 14. `pwa/index.html` (Create)
*   **Type / Scope**: Mobile PWA HTML Document Entry
*   **Proposed Changes**:
    *   Include viewport meta: `viewport-fit=cover, width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no`.
    *   Include mobile meta tags: `apple-mobile-web-app-capable`, `theme-color: #0D0E11`.
    *   Link to `/manifest.json`.
*   **Rationale**: Guarantees correct mobile layout and safe-area rendering on notched displays.

#### 15. `pwa/src/vite-env.d.ts` (Create)
*   **Type / Scope**: TypeScript Client Types
*   **Proposed Changes**: Add `/// <reference types="vite/client" />`.
*   **Rationale**: Unlocks Vite environment types.

#### 16. `pwa/src/hooks/useRemoteSocket.ts` (Create)
*   **Type / Scope**: Visibility-Gated WebSocket Client Hook
*   **Proposed Changes**:
    *   Manage WebSocket lifecycle with visibility gating: terminate connection and pause reconnection timers while `document.visibilityState === 'hidden'`.
    *   Implement bounded exponential backoff on reconnection (3s initial, 15s max, 10% jitter).
    *   Parse incoming `RemoteEvent` variants (`StateChange`, `Heartbeat`, `QueueUpdated`).
    *   Dispatch `ClientCommand` messages (`Play`, `Pause`, `SkipNext`, `SkipPrev`, `Seek`, `SetVolume`).
*   **Rationale**: Enforces **Audiophile Invariant 4 (Network PHY Quietness)** by ensuring zero background TCP chatter when handset is asleep.

#### 17. `pwa/src/hooks/useCatalog.ts` (Create)
*   **Type / Scope**: Mobile Catalog Data Fetching Hook
*   **Proposed Changes**:
    *   Fetch releases from `/api/remote/library/releases` with limit/offset pagination.
    *   Apply in-memory facet filtering: Format (Hi-Res, DSD, PCM), Language, and Genre.
    *   Implement debounced search query state.
*   **Rationale**: Enables fast, fluid catalog exploration without hammering host SQLite or music storage.

#### 18. `pwa/src/hooks/useMediaSession.ts` (Create)
*   **Type / Scope**: Mobile Lock Screen Media Session Bridge
*   **Proposed Changes**:
    *   Synchronize active track title, artist, album, and artwork to `navigator.mediaSession.metadata`.
    *   Bind action handlers (`play`, `pause`, `previoustrack`, `nexttrack`, `seekto`) to dispatch on-demand REST requests (`POST /api/remote/playback/:action`), ensuring instant response when WebSocket is dormant.
*   **Rationale**: Delivers platform-native mobile lock screen controls while audio is streaming on the desktop without violating network quietness.

#### 19. `pwa/src/components/Navigation/TopHeader.tsx` & `TabBar.tsx` (Create)
*   **Type / Scope**: Mobile Navigation Components
*   **Proposed Changes**:
    *   `TopHeader`: Concentric-C Cadence logo, live connection status pill, bit-perfect DAC indicator, and `pt-[env(safe-area-inset-top,12px)]`.
    *   `TabBar`: 3-destination bottom thumb-zone navigation (`Now Playing`, `Catalog`, `Queue`) with `pb-[env(safe-area-inset-bottom,16px)]`.
*   **Rationale**: Follows Apple HIG thumb-zone navigation conventions and safe-area guidelines for single-handed mobile operation.

#### 20. `pwa/src/components/NowPlaying/NowPlayingView.tsx` & `VolumeGuard.tsx` (Create)
*   **Type / Scope**: Immersive Mobile Playback Controller
*   **Proposed Changes**:
    *   Full-bleed artwork display with aspect-ratio preservation.
    *   Tactile progress scrubber with optimistic drag position and debounced seek dispatch.
    *   48px touch targets for transport buttons.
    *   `VolumeGuard`: When `isBitPerfect || isPurityMode` is true, lock volume slider, render gold `Direct Hardware Transport` badge, and show guidance tooltip.
*   **Rationale**: Provides high-fidelity listening control while honoring Bit-Perfect Signal Path Integrity.

#### 21. `pwa/src/components/Catalog/CatalogView.tsx` & `FacetShelf.tsx` (Create)
*   **Type / Scope**: Mobile Catalog Exploration Components
*   **Proposed Changes**:
    *   Two-column album cover grid with lazy-loaded image thumbnails via `/api/remote/library/artwork/:id`.
    *   Horizontal scrollable facet chip shelf for Format, Language, and Genre filtering.
    *   Sticky in-place search input.
*   **Rationale**: Mirrors desktop catalog filtering capabilities on mobile touch screens.

#### 22. `pwa/src/components/Queue/QueueView.tsx` (Create)
*   **Type / Scope**: Mobile Queue & Playlist Manager
*   **Proposed Changes**:
    *   Reorderable track list showing format badges, track numbers, and durations.
    *   Tap-to-play track selection and swipe/button track removal.
    *   Playlist switcher toolbar.
*   **Rationale**: Allows tactile queue management from the couch without walking to the desktop PC.

#### 23. `src-tauri/src/remote/AGENTS.md` (Modify)
*   **Type / Scope**: Subsystem Architecture Documentation
*   **Proposed Changes**:
    *   Document the new `pwa/` build pipeline, `rust-embed` static router, and visibility-gated network silence invariants.
*   **Rationale**: Maintains documentation integrity and contract transparency for future agent invocations.

---

### Verification Plan

*   **Compilation & Build Integrity**:
    *   Run `npm run build:pwa`: Must compile TypeScript and Tailwind CSS v4 to `src-tauri/src/remote/dist/` with zero errors.
    *   Run `npm run build`: Must typecheck desktop frontend (`tsc -b`) and bundle Vite assets.
    *   Run `cargo check --manifest-path src-tauri/Cargo.toml`: Must resolve `rust-embed` and compile Axum static handlers cleanly on fresh clone.
*   **Native Backend Unit Tests**:
    *   Execute `cargo test --manifest-path src-tauri/Cargo.toml`:
        *   Verify `net_discovery::tests`: Confirms loopback (`127.0.0.1`), link-local (`169.254.x.x`), and virtual adapters are filtered out.
        *   Verify `has_verified_lan` is false when no physical interfaces exist.
*   **Audiophile Network Quietness Test**:
    *   Connect Android Chrome client to desktop server over Wi-Fi.
    *   Start high-resolution playback on desktop.
    *   Lock phone / turn screen off.
    *   Run Wireshark packet capture filtering on `tcp.port == 4040`: Verify ZERO TCP packets, keep-alives, or reconnection attempts occur while handset is asleep.
    *   Press "Pause" on handset lock screen: Verify exactly one clean HTTP POST request dispatches and pauses playback.
    *   Unlock phone: Verify exactly one clean reconnect handshake and initial state snapshot occurs.
*   **Pairing QR Code Verification**:
    *   Disconnect Wi-Fi on desktop: Confirm desktop modal immediately suppresses QR canvas and displays `WifiOff` diagnostic card.
    *   Reconnect Wi-Fi: Confirm modal displays verified LAN IP (e.g. `192.168.1.120`) and renders high-contrast QR code.
    *   Scan QR code with Android Chrome: Confirm instant PWA loading without "Site can't be reached" error.

--------------------------------------------------------------------------------

*Drafted with EGM*
