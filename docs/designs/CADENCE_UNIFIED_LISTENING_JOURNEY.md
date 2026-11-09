# Cadence Unified Listening Journey: Cross-Device Session Architecture, Versions Model, and Listening Shell

*   **Author:** Mathan
*   **Status:** Revised Specification (Post-EGM Review & Journey Hardening)
*   **Date:** 2026-11-09

--------------------------------------------------------------------------------

## Overview

Cadence is a bit-perfect audiophile music player and catalog curation system for Windows Desktop, paired with a companion Progressive Web App (PWA) remote running on local Wi-Fi handsets. This specification establishes a unified, bi-directionally synchronized listening session across desktop and mobile controllers. It resolves active cross-device queue desynchronization defects, aligns mobile artwork caching with desktop idle background workers to preserve strict storage bus silence during playback, introduces a desktop-first 1:N "Versions" model to link multi-edition albums under a single canonical parent without mastering bias, and introduces a compact mobile listening shell that preserves screen real estate on 375pt mobile viewports without compromising audiophile playback invariants.

## The Problem

Operating Cadence across desktop and mobile reveals six concrete synchronization and architectural limitations:

1.  **Unilateral Desktop-to-Remote Queue Desynchronization & Circular Echo**: While desktop pushes queue mutations to the native backend via `sync_desktop_queue_to_remote`, desktop's React frontend (`src/context/AudioPlayerContext.tsx`) does not subscribe to the `cadence:remote-queue-changed` event emitted by `src-tauri/src/remote/state.rs`. Queue modifications made from a mobile handset (enqueuing, removing, or reordering tracks) are invisible to desktop, and the next desktop re-render or transport tick pushes desktop's stale queue back down, overwriting remote modifications. Furthermore, naive event subscriptions that use speculative microtasks to reset re-entrancy flags fail under React 18/19 rendering batching, causing circular IPC and network echo loops. Additionally, uncoordinated asynchronous database hydration can allow older query results to clobber newer revisions.
2.  **Queue vs. Now Playing State Mismatch & Duplicate Track Collisions (Hypothesis H2)**: In `pwa/src/components/Queue/QueueView.tsx`, the active row styling and animated volume pulse are evaluated strictly as `isCurrent = idx === queue.currentIndex`, ignoring `status.isPlaying`, `status.isPaused`, and `status.currentFile`. Because desktop initializes `queueIndex` to `0` even when playback is stopped and no track is loaded into the native engine, opening the mobile Queue displays track 1 highlighted with amber styling and an animated volume icon, while opening Now Playing displays `"No Track Loaded"`. Furthermore, when a queue contains multiple instances of the same track, matching strictly on `item.filePath === status.currentFile` causes every duplicate occurrence to light up simultaneously.
3.  **Mobile Artwork Starvation During Playback (Hypothesis H3)**: To enforce Audiophile Rule 1 (Zero disk reads on music library drives during playback), `src-tauri/src/remote/artwork_cache.rs` blocks on-demand extraction of embedded artwork or folder JPEGs from audio storage drives while `is_playing && !is_paused`. Because thumbnail generation in `MaintenanceWorker` previously starved release artwork behind artist portraits, uncached album artwork requests from mobile return `HTTP 204 No Content` during playback, causing album cards in the mobile catalog to render as broken image placeholders. Furthermore, missing cache-invalidation events cause mobile clients to retain placeholders indefinitely.
4.  **Format-Driven Catalog Duplication vs. Missing "Versions" Relationship**: Audiophile libraries frequently contain multiple releases and processed masters of the same album (e.g., Original CD rip, 24-bit/192 kHz FLAC release, DSD SACD transfer, and PGGB-upsampled files). Currently, Cadence treats each distinct directory as a separate `release_id`, generating duplicate catalog entries and obscuring the master release. Crucially, automated systems often falsely assume the highest sample rate represents the best mastering, whereas audiophile listeners frequently prefer earlier, uncompressed dynamic masters (e.g. DR14 CD) over brickwalled high-res reissues.
5.  **Screen Real Estate Depletion on Compact Mobile Viewports**: On a compact 375×667pt mobile screen (e.g., iPhone SE), persistent application chrome (48pt Header + 56pt TabBar + 34pt Home Indicator) consumes 138pt (~21% of vertical height). Adding a ~48–56pt mini-player raises persistent chrome to 186–194pt (~28% of total vertical height), leaving ~473–481pt for browsing albums or managing queues. If a mini-player lacks a zero-height collapse when stopped, it reduces browsing space during playback stopped states. Furthermore, maintaining a 3-tab navigation bar (`Playing`, `Catalog`, `Queue`) alongside a persistent mini-player creates redundant navigation targets for the same view.
6.  **Unranked Telemetry Badges vs. Signal Path Opacity**: The mobile interface currently displays unranked badges ("CONNECTED", "READY", "HI-RES", and "Purity") that fail to clearly differentiate host network connection health, transport engine state, source container metadata, physical bit-perfect DAC delivery, and hardware output device routing.

## Proposed Solution

Consolidate Cadence's listening experience around an authoritative cross-device state contract, unambiguous user interaction feedback, session preservation, and a compact mobile listening shell:

1.  **Intent-Based Transactional Queue Contract with Monotonic Revisioning**: Establish the native backend (`src-tauri` `RemoteQueue`) as the authoritative Single Source of Truth (SSOT). Replace whole-array snapshot dumps with discrete intent-based commands (`EnqueueTrack`, `EnqueueRelease`, `ReorderQueue`, `RemoveFromQueue`, `ClearQueue`) validated against a monotonic `revision: u64`. Desktop `AudioPlayerContext.tsx` subscribes to `cadence:remote-queue-changed`, anchors state on `appliedServerRevisionRef`, guards async database hydration against revision drift, and rehydrates complete `Track` domain entities from the local database before committing to React state.
2.  **Explicit Queue Operations, Session Preservation & Feedback Semantics**:
    *   **Play Album / Play Now (Session Preservation)**: Starts immediate playback of the selected album/track, but **preserves the listener's existing queue directly behind the new album** rather than deleting it. Displays a transient, non-blocking toast with a clear **[Undo]** action to restore the exact previous queue state and position.
    *   **Play Next (Stable Next-Up FIFO Segment)**: Inserts tracks immediately after the active track into an explicit **Next-Up segment**. Successive *Play Next* requests (e.g., Album B then Album C) preserve chronological queuing order (`A → [B] → [C] → [Remaining queue]`), avoiding LIFO stack inversion while active playback continues completely uninterrupted.
    *   **Track Tap vs. Details**: Tapping a track in `AlbumModal` plays it immediately; tapping a track in `QueueView` invokes `JumpToQueueIndex(index)`. Full acoustic details and DR metrics are accessed via secondary trailing affordances (`...`).
    *   **Unique Queue Entry Identity**: Every queued item is assigned a unique `queue_entry_id: String` (UUID) upon insertion, ensuring multiple occurrences of the same track in a playlist are tracked independently without duplicate highlighting collisions.
    *   **Intent Protection on Disconnection Conflicts**: If a mobile handset disconnects during a queue operation and encounters a conflict upon reconnecting, the UI presents an explicit explanation: `Queue changed while you were disconnected. Your reorder wasn't applied.` and provides an entity-anchored **[Retry Reorder]** action.
    *   **Anti-Resolution Bias & Preference Retention**: Mastering quality is explicitly distinguished from container resolution. When a preferred master edition's drive is unplugged, Cadence retains that preference as `Unavailable (Drive Offline)` in SQLite rather than nullifying or overwriting it, and allows the user to explicitly select an available alternative or designate a new preference.
3.  **Playback-Conditioned Queue Highlighting**: Update `QueueView.tsx` to evaluate active styling strictly against active transport state and unique queue entry ID (`item.queueEntryId === status.currentQueueEntryId || (idx === queue.currentIndex && isPlaybackActive)`), eliminating false playing indications when the transport is idle and duplicate highlighting bugs.
4.  **Hardware Routing & Stopped-State Accessibility**: When playback is stopped and the MiniPlayer is collapsed, the user accesses output device routing and playback resumption via:
    *   An interactive Output Device Chip in the persistent Global Header (`[ 🔈 DAC USB ▾ ]`).
    *   A persistent Transport Action Deck at the top of the `QueueView` tab featuring a primary **[ ▶ Resume Playback ]** button and output routing controls.
5.  **Idle-Only Artwork Serving via `MaintenanceWorker`**: Shift mobile thumbnail pre-caching strictly into the existing `MaintenanceWorker`, interleaving release artwork with artist portraits during transport idle periods (`!is_playing && !is_paused && cooldown >= 30s`). Restrict idle worker I/O to lightweight folder images (`cover.jpg`/`folder.jpg`) or previously indexed thumbnails to prevent synchronous I/O lockups on audio drives. Uncached artwork returns `HTTP 204 No Content` immediately during playback, which the mobile client renders as a local placeholder with client-side deduplication to prevent polling cascades.
6.  **Desktop-First 1:N Versions Architecture**: Add `master_album_id TEXT REFERENCES master_albums(id)` directly to `releases` in SQLite, creating a clean 1-to-many relationship without an intermediate junction table. Derive edition summaries dynamically via SQL aggregation over `tracks`. Grouping is governed by MusicBrainz Release Group IDs (`release_group_mbid`) or explicit user curation in Desktop Curate. Project this relationship to mobile via an in-modal Segmented Version Carousel in `AlbumModal.tsx`.
7.  **Mobile Listening Shell with 2-Tab Navigation**: Streamline `TabBar.tsx` to 2 primary tabs (`Catalog` and `Queue`), eliminating the redundant `Playing` tab. Mount a ~48–52pt floating Mini-Player 8pt above the tab bar in `App.tsx` that collapses to zero height (`height: 0; opacity: 0; margin: 0`) when playback stops. Scrolling views maintain static `pb-28` padding so layout geometry never jumps. Expansion relies on tap-to-open and a visible chevron affordance adhering to Apple HIG, integrating `window.history.pushState` so the Android back button dismisses the sheet instead of exiting the PWA.
8.  **Three-Tier Signal Path Telemetry**: Establish a clear three-tier visual hierarchy separating Host Desktop WLAN telemetry, a three-node hardware signal chain (Source container, DSP direct mode, Output driver), and acoustic track details with an audiophile volume guard backed by native backend enforcement.

## Goals

*   **Bidirectional Cross-Device Queue Parity**: Eliminate queue desynchronization between desktop and mobile by establishing the native backend as the authoritative SSOT, implementing desktop listeners for `cadence:remote-queue-changed`, and enforcing monotonic revision IDs (`revision: u64`) on discrete mutation commands.
*   **Safe Queue Operations & Session Protection**: Prevent accidental destruction of user listening queues by preserving existing queue tracks behind newly played albums, providing one-tap [Undo], and establishing a stable FIFO insertion policy for successive *Play Next* requests.
*   **Deterministic Transport & Queue State Representation**: Ensure mobile queue row highlighting strictly matches active engine state and unique queue-entry identity, avoiding false idle highlights and duplicate track collisions.
*   **Stopped-State Output & Resumption Accessibility**: Provide direct routes to output device selection and playback resumption from the Global Header and Queue tab even when the MiniPlayer is collapsed.
*   **Zero Music-Drive I/O During Mobile Browsing**: Guarantee zero disk reads on music storage drives while audio is playing by serving 100% of mobile artwork requests from the local NVMe `%APPDATA%` thumbnail cache, pre-generated by desktop background workers during transport idle periods.
*   **Unified 1:N Album Versions Model without Resolution Bias**: Model multiple editions of an album under a single canonical parent `master_albums` record on Desktop first, allowing users to select and retain preferred masterings (even if lower resolution) without catalog clutter or compilation corruption.
*   **Persistent Mobile Listening Shell with 2-Tab Navigation**: Provide continuous playback context across Catalog and Queue views via a ~48–52pt floating mini-player with primary tap-to-open, a visible expand chevron, zero-height collapse when stopped, and a 2-tab bottom navigation bar (`Catalog` and `Queue`).
*   **Audiophile Signal Path Transparency**: Replace unranked status chips with a 3-tier visual hierarchy that clearly distinguishes Host Desktop Wi-Fi health, a 3-node bit-perfect hardware path, and track acoustic properties.

## Non-Goals

*   **On-Demand Artwork Extraction During Active Playback**: Cadence will not extract uncached artwork or parse embedded file tags on demand from library drives while audio is actively streaming or paused.
*   **Mobile Audio Streaming**: The mobile PWA will not receive or decode raw PCM/DSD audio streams; all audio decoding, clock pacing, and DAC output remain strictly on the host desktop.
*   **Mobile Tag or Metadata Editing**: The mobile remote remains a dedicated control plane; two-phase metadata curation, tag writes, and decision trace commits remain exclusive to the Desktop Curate workbench.
*   **Cloud Streaming Services & Multi-Room Grouping**: Integrating third-party cloud streaming subscriptions (Tidal, Qobuz) or multi-room zone grouping is explicitly out of scope.
*   **Arbitrary Framework Migrations**: Retain the existing React 19 / Vite / Tailwind stack in `pwa` and Tauri v2 / Rust backend without adopting new framework runtimes.

## Open Questions

*   **Usability Thresholds for Mini-Player Height**: Usability testing on 375pt viewports (e.g., iPhone SE) will validate whether 48pt, 50pt, or 52pt dimensions best balance touch target compliance (Apple HIG 44–48pt) with catalog card visibility.

--------------------------------------------------------------------------------

## Critical User Journeys (CUJs)

### CUJ 1: Mobile Queue Modification & Authoritative Desktop Reconciliation
*   **Given**: The user has Cadence Desktop open with 10 tracks loaded in the queue and playback active to a USB DAC. A mobile handset is connected to the Cadence Remote PWA over local Wi-Fi.
*   **When**: The user opens the mobile Queue view, reorders track 8 to play next, and enqueues an additional album from the Catalog with *Play Next*.
*   **Then**: The mobile client transmits `ReorderQueue` and `EnqueueRelease` commands with `expected_revision`; the native backend validates the revision, executes the mutation on `RemoteQueue`, increments `revision`, and broadcasts `RemoteEvent::QueueUpdated` to mobile and emits `cadence:remote-queue-changed` to desktop; desktop `AudioPlayerContext.tsx` receives the event, rehydrates `Track` domain entities from SQLite while verifying revision freshness, updates React state using `appliedServerRevisionRef` to prevent echo loops, and both screens reflect the identical queue order.

### CUJ 2: Catalog Browsing & Artwork Display During Active Playback
*   **Given**: DSD audio is actively streaming to the DAC with bit-perfect transport purity. The user browses the mobile Catalog.
*   **When**: The mobile Catalog renders 50 album cards and requests artwork thumbnails via `/api/remote/artwork/:id?v=:mtime`.
*   **Then**: The requests are served strictly from the high-speed NVMe `%APPDATA%/cadence/cache/artwork/` directory pre-warmed by `MaintenanceWorker` during idle periods; for albums lacking a pre-prepared thumbnail, the server returns `HTTP 204 No Content` immediately without reading music storage drives; the mobile client renders a local SVG placeholder and records the missing ID in a local set to prevent polling cascades, preserving zero disk I/O on library drives.

### CUJ 3: Inspecting & Selecting Album Versions (Desktop-First Model)
*   **Given**: The user's library contains three editions of *Kind of Blue* (1959 Columbia Mono FLAC 24/96, 1986 Japan Black Triangle CD, and 2013 Analogue Productions SACD DSD64) linked under a single `master_albums` record.
*   **When**: The user searches for *Kind of Blue* on mobile.
*   **Then**: The Catalog surfaces a single canonical *Kind of Blue* card with a `DSD • HI-RES (3 Versions)` badge; tapping the card opens `AlbumModal` featuring a Segmented Version Carousel; tapping **Play Album** immediately plays the designated master edition, while tapping the *1986 CD* pill dynamically updates the modal's tracklist and technical badges to that specific release.

### CUJ 4: Tap-to-Open Mini-Player & Signal Path Inspection
*   **Given**: Playback is active and the user is browsing the mobile Catalog or Queue view.
*   **When**: The user observes the compact floating mini-player positioned 8pt above the bottom tab bar and taps the card body or the visible expand chevron.
*   **Then**: The mini-player expands into the full `NowPlayingView` modal sheet; the user inspects the three-node hardware signal chain (`[ Source: DSF DSD128 5.6MHz ] ➔ [ DSP: BIT-PERFECT DIRECT ] ➔ [ Output: WASAPI Exclusive ]`), confirms unity-gain volume lock, and taps the dismiss chevron, swipes down, or presses the Android hardware back button (via `history.pushState`) to return to browsing with scroll position preserved.

### CUJ 5: Transport Stop & Zero-Height Mini-Player Collapse
*   **Given**: Playback reaches the end of the queue or the user taps Stop.
*   **When**: The engine transitions to stopped state (`is_playing: false`, `current_file: null`).
*   **Then**: The mobile mini-player animates to `height: 0; opacity: 0; margin: 0;` over 200ms, returning vertical real estate to browsing while static `pb-28` padding prevents content jumping; `QueueView` removes active playback highlights and volume icons, displaying static track numerals; Now Playing displays `"Ready for Playback"` without false active transport indicators.

### CUJ 6: Discover Album → Select Edition → Play Now (Session Preserved)
*   **Given**: The user has a 50-track listening queue active. They browse the catalog on mobile, find *Abbey Road*, and select the *2019 Super Deluxe (24/96 FLAC)* edition.
*   **When**: The user taps **Play Now** (or **Play Album**).
*   **Then**: Track 1 of *Abbey Road* begins playback immediately on the host DAC and the MiniPlayer updates with live metadata; the remaining 49 tracks from the user's previous queue are **not deleted**—they are preserved directly behind *Abbey Road* in the queue; a transient bottom toast confirms: `▶ Playing Abbey Road (2019 Remaster) • Previous queue preserved [Undo]`; tapping **Undo** instantly restores the prior track and queue position.

### CUJ 7: Continue Listening → Discover Albums → Successive Play Next (Stable FIFO)
*   **Given**: The user is listening to Track 4 of *Kind of Blue* (Album A).
*   **When**: The user selects **Play Next** on *Time Out* (Album B), and then selects **Play Next** on *A Love Supreme* (Album C).
*   **Then**: Track 4 continues playing completely uninterrupted (zero audio glitch, zero DAC clock switching); the upcoming queue maintains a stable FIFO order within the Next-Up segment: `Album A (current) → [Time Out (B)] → [A Love Supreme (C)] → [Remaining previous queue]`; toast confirmations provide immediate reassurance without navigating away from the catalog.

### CUJ 8: Desktop Versions Grouping & Preference Management (Anti-Resolution Bias)
*   **Given**: A library contains an uncompressed 1983 CD release (DR14) and a 2015 24/192 FLAC release (brickwalled DR7) of the same album, plus a multi-disc box set compilation containing selected tracks.
*   **When**: In Desktop Curate, the user groups the two standalone releases under a Master Album and designates the 1983 CD (DR14) as the preferred master edition; later, the external drive hosting the CD is unplugged.
*   **Then**: Cadence retains the 1983 CD as the preferred edition marked `Unavailable (Drive Offline)` without overwriting the preference; if the user taps **Play Album**, Cadence presents an explicit choice: *"Preferred edition (1983 CD) is offline. Play 2015 24/192 FLAC edition?"* without assuming the higher-resolution file is superior; the multi-disc compilation remains completely isolated and intact.

### CUJ 9: Queue Contains Tracks, Playback Stopped → Resume Playback
*   **Given**: The queue contains 9 tracks, playback is stopped, and the MiniPlayer has collapsed to zero height.
*   **When**: The user opens the mobile remote, navigates to the **Queue** tab, and taps the primary **[ ▶ Resume Playback ]** button in the Queue Header Deck.
*   **Then**: Playback immediately resumes at the current queue track without clearing the queue; the MiniPlayer animates into view over 200ms; the active track row in `QueueView` highlights in amber with the animated volume pulse; tapping the MiniPlayer expands `NowPlayingView` with full hardware telemetry accurately reflecting the resumed stream.

### CUJ 10: Mobile Disconnects During Queue Operation → Reconnect & Intent Protection
*   **Given**: The mobile handset is on local Wi-Fi with the Queue open. The user reorders Track 8 to Track 2 while walking into an area with weak Wi-Fi coverage.
*   **When**: The local Wi-Fi connection drops as the command is dispatched. In the interim, desktop advances playback to Track 3. When mobile reconnects and transmits `ReorderQueue` with `expected_revision`, the backend detects a revision conflict.
*   **Then**: The backend rejects the stale command and sends the updated queue; the mobile PWA updates its local queue and presents an explicit explanatory banner: `⚠️ Queue changed while you were disconnected. Your reorder wasn't applied.` with a **[Retry Reorder]** action; tapping Retry presents an entity-anchored confirmation (*"Move [Track 8 Title] before [Track 2 Title]?"*), protecting user intent without blind numerical index replays.

### CUJ 11: Output Device Becomes Unavailable or Changes
*   **Given**: High-resolution 192kHz/24-bit audio is actively playing in WASAPI Exclusive mode to an external USB DAC.
*   **When**: The USB cable is unplugged or the DAC is turned off.
*   **Then**: The Windows audio endpoint disappears; `AudioEngine` traps the hardware disconnect within 10ms, halts transport safely, and sets engine state to `Stopped`; the native backend broadcasts `RemoteEvent::DeviceUnavailable { device_name, available_devices }`; the mobile remote immediately pauses, collapses the mini-player, and displays an alert sheet: `⚠️ Output Device Disconnected: DAC USB`; the sheet provides deliberate options: **[ Switch to System Default ]**, **[ Reconnect & Retry ]**, or **[ Stop & Dismiss ]**; bit-perfect integrity is preserved without rogue software fallbacks.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. System Architecture & Cross-Device Data Flow

Cadence enforces a hub-and-spoke session architecture where the native desktop process (`src-tauri`) is the authoritative Single Source of Truth (SSOT). Desktop React and Mobile Remote PWA are symmetric presentation consumers connected via local IPC and WebSockets, respectively.

```mermaid
flowchart TD
    subgraph DesktopSeat["Cadence Desktop Seat (Tauri Host)"]
        DeskUI["Desktop React Frontend\n(AudioPlayerContext.tsx)"]
        TauriBridge["Tauri IPC Bridge\n(tauriBridge.ts)"]
        DeskUI <-->|Tauri Commands & Events\n(cadence:remote-queue-changed)| TauriBridge
    end

    subgraph NativeBackend["Native Core (src-tauri)"]
        AudioEng["AudioEngine Core\n(MMCSS Pro Audio Thread\nVirtualLock Pinned Buffer)"]
        RemoteSt["RemoteState & WebSocket Engine\n(src-tauri/src/remote)"]
        RemoteQ["RemoteQueue Mutex (SSOT)\n{ items, currentIndex, nextUpEndIndex, revision: u64 }"]
        AppDb["AppDb (SQLite %APPDATA%/cadence.db)\n(master_albums, releases.master_album_id)"]
        MaintWorker["MaintenanceWorker\n(worker.rs: Interleaved Artwork\n!is_playing && cooldown >= 30s)"]
        DiskCache["NVMe Thumbnail Cache\n(%APPDATA%/cadence/cache/artwork)"]

        TauriBridge <--> RemoteSt
        RemoteSt <--> RemoteQ
        RemoteSt <--> AudioEng
        RemoteSt <--> AppDb
        MaintWorker -->|Writes 300x300 Thumbnails| DiskCache
        DiskCache -->|HTTP 200 get_cached_only| RemoteSt
    end

    subgraph MobileRemote["Mobile Remote PWA (Wi-Fi Companion)"]
        PwaSocket["useRemoteSocket.ts\n(WebSocket Event Stream + 5s Heartbeat)"]
        MiniPlayerComp["Floating Mini-Player (~48-52pt)\n(Tap-to-Open / Visible Expand)"]
        NowPlayingSheet["NowPlayingView Sheet\n(3-Tier Signal Path / VolumeGuard)"]
        QueueComp["QueueView\n(Conditioned Active Track Highlight)"]
        CatalogComp["CatalogView & AlbumModal\n(Segmented Version Carousel)"]
        TabBarComp["2-Tab Navigation Deck\n(Catalog, Queue)"]

        PwaSocket <--> MiniPlayerComp
        PwaSocket <--> NowPlayingSheet
        PwaSocket <--> QueueComp
        PwaSocket <--> CatalogComp
    end

    RemoteSt <-->|WebSocket TLS / Local LAN\n(Event-Driven + 5s Heartbeat)| PwaSocket
    RemoteSt -->|HTTP 204 if missing / HTTP 200 if cached| CatalogComp
```

---

### 2. Interaction & Feedback Standards: Queue Operations, Navigation & Availability

To ensure human-centric craft and adherence to Apple HIG (Purpose, Agency, Familiarity), all playback and queue actions conform to strict interaction, feedback, and error handling rules:

#### A. Queue Operation Semantics
*   **Play Album / Play Now (Session Preserved)**:
    *   *Semantics*: Non-destructive immediate playback. Clears previous queue tracks that already played, inserts all tracks of the chosen edition at `currentIndex = 0`, starts immediate playback, and **places the remaining upcoming tracks from the previous queue directly behind the new album**.
    *   *Feedback*: User remains in current view. A transient toast appears: `▶ Playing: [Album Name] • Previous queue preserved [Undo]`. Tapping **Undo** restores the exact previous queue and transport index. MiniPlayer surfaces displaying live track metadata.
*   **Play Next (Stable Next-Up FIFO Segment)**:
    *   *Semantics*: Inserts target tracks into an internal **Next-Up segment** immediately after the active track. Successive *Play Next* requests append to the end of the Next-Up segment, preserving chronological user intent (`A → B → C`) rather than a LIFO inversion (`A → C → B`). Currently playing audio continues completely uninterrupted with zero buffer or DAC clock reset.
    *   *Feedback*: Bottom toast appears: `✓ Playing Next: [Track/Album Name]`. The Queue tab badge increments by the count of added tracks.
*   **Add to End (Queue)**:
    *   *Semantics*: Queue tail append. Adds target tracks to the end of the queue. Current and upcoming queue order is completely preserved.
    *   *Feedback*: Bottom toast: `✓ Added to End of Queue`. Queue tab badge increments.
*   **Track Tap in Album View vs. Queue View**:
    *   *In AlbumModal / Album View*: Tapping an individual track initiates immediate playback of that track, populating the queue with the album tracks from that point forward.
    *   *In QueueView*: Tapping an individual track dispatches `JumpToQueueIndex(index)` to transition playback immediately to that queue position.
    *   *Track Details & DR Scores*: Accessed via a dedicated secondary trailing `...` icon button or long-press contextual sheet. Basic tap is strictly reserved for playback.
*   **Unique Queue Entry Identity**:
    *   Every item in `RemoteQueue` carries a unique `queue_entry_id: String` (UUID generated on insertion) alongside `id: String` (track ID).
    *   Active track evaluation matches `item.queueEntryId === currentQueueEntryId`, guaranteeing that duplicate tracks in a playlist are tracked independently without multi-row highlighting bugs.

#### B. Anti-Resolution Bias & Offline Version Handling
*   **Axiom: Mastering Quality $\ne$ Container Resolution**: In audiophile curation, early flat masters (e.g., 1980s CD release with DR14) are frequently superior to modern brickwalled high-resolution remasters (e.g., 24/192 FLAC with DR7). The system must never automatically prioritize highest resolution as the "best" edition.
*   **Drive Unmounted / Storage Missing**:
    *   If a release is on an external drive that is unplugged, the release card and version pill display an amber badge: `⚠️ Offline (Drive Unmounted)`.
    *   The user's preference in `master_albums.default_release_id` is **strictly retained** in SQLite; it is never automatically overwritten or nullified when a drive is unplugged.
    *   If the user taps **Play Album** while the designated Master Edition is offline:
        *   Cadence displays an action sheet allowing the user to explicitly choose an available local edition:
            *"Preferred edition ([Edition Name]) is currently on an offline drive. Choose an alternative local edition to play:"* with pills for available local releases and **[ Cancel ]**.
        *   The sheet includes an explicit checkbox: `Set as new default preference`.

#### C. Stopped-State Output Device & Playback Access (Solving the Collapsed Mini-Player)
When playback is stopped and the MiniPlayer is collapsed to zero height, the user has two clear routes to inspect output routing and resume playback:
1.  **Global Header Device Chip (Tier 1)**: The persistent header at the top of the app displays the active output device: `[ 🔈 DAC USB (WASAPI Exclusive) ▾ ]`. Tapping this chip anywhere in the app opens the **Audio Device & Hardware Sheet** to select an alternate output endpoint, inspect DAC clock rates, or view hardware status.
2.  **Queue Tab Persistent Action Deck**: Navigating to the `Queue` tab displays a sticky header deck above queue tracks:
    *   Displays: `Playback Stopped • 9 Tracks (42:15)`
    *   Primary Action Button: **[ ▶ Resume Playback ]** (resumes playback at current track, smoothly surfacing the MiniPlayer over 200ms).
    *   Output endpoint indicator and device selector pill.

---

### 3. Subsystem 1: Bidirectional Intent-Based Queue Engine

To eliminate unilateral queue overwrites, race conditions, and infinite IPC echo loops, queue management transitions to an intent-based transactional model anchored in the native backend.

#### Authoritative State Schema (`src-tauri/src/remote/state.rs`)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrackItem {
    pub queue_entry_id: String, // Unique UUID per queue occurrence
    pub id: String,             // Track ID in database
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
    pub file_path: String,
    pub format: String,
    pub sample_rate: u32,
    pub bit_depth: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteQueue {
    pub items: Vec<RemoteTrackItem>,
    pub current_index: isize,
    pub current_queue_entry_id: Option<String>,
    pub next_up_end_index: Option<usize>, // Tracks boundary of Next-Up FIFO segment
    pub repeat_mode: String,              // "off" | "all" | "one"
    pub is_shuffle: bool,
    pub revision: u64,                    // Monotonically increasing revision counter
}
```

#### Transactional Mutation Commands (`src-tauri/src/remote/ws.rs`)
Replace full-array snapshot synchronization with discrete client commands ingesting `expected_revision: Option<u64>`:
1. `EnqueueTrack { track: RemoteTrackItem, play_next: bool, expected_revision: Option<u64> }`
2. `EnqueueRelease { release_id: String, play_next: bool, play_now: bool, expected_revision: Option<u64> }`
3. `RemoveFromQueue { queue_entry_id: String, expected_revision: Option<u64> }`
4. `ReorderQueue { queue_entry_id: String, target_queue_entry_id: String, expected_revision: Option<u64> }`
5. `ClearQueue { expected_revision: Option<u64> }`
6. `JumpToQueueIndex { index: isize }`

**Validation Logic**:
* If `expected_revision` does not match `state.queue.lock().revision`, reject the mutation with `RemoteEvent::QueueConflict { current_revision, items, current_index }`.
* When valid, execute the atomic mutation in-memory:
  * For `EnqueueRelease(play_next: true)`: Insert tracks at `next_up_end_index.unwrap_or(current_index + 1)`. Advance `next_up_end_index` by the number of inserted tracks, guaranteeing strict FIFO order for consecutive requests.
  * For `EnqueueRelease(play_now: true)`: Preserve upcoming queue tracks behind the newly inserted release.
  * Increment `queue.revision += 1`, and broadcast `RemoteEvent::QueueUpdated { items, current_index, revision }` to mobile and emit `cadence:remote-queue-changed` to desktop.

#### Desktop Frontend Revision Anchor & Async Hydration Guard (`src/context/AudioPlayerContext.tsx`)
1. **Eliminate Full Snapshot Dumping**: Desktop React must not execute an unconditioned `useEffect` dumping whole queues down to Tauri on every render. Outbound sync calls occur strictly from explicit user actions (`enqueue`, `reorder`, `remove`).
2. **Revision-Anchored Event Subscription with Async Race Protection**:
   ```typescript
   const appliedServerRevisionRef = useRef<number>(0);
   const latestHydrationRevisionRef = useRef<number>(0);

   listen<RemoteQueuePayload>('cadence:remote-queue-changed', async (event) => {
     const { items, currentIndex, revision } = event.payload;
     if (revision <= appliedServerRevisionRef.current) return;
     appliedServerRevisionRef.current = revision;
     latestHydrationRevisionRef.current = revision;

     // Rehydrate full Track domain entities from local SQLite by IDs
     const trackIds = items.map(i => i.id);
     const hydratedTracks = await sqliteLibraryService.getTracksByIds(trackIds);

     // Discard stale hydration result if a newer revision arrived while awaiting DB
     if (latestHydrationRevisionRef.current !== revision) return;

     const orderedTracks = items.map(item => 
       hydratedTracks.find(t => t.id === item.id) || mapRemoteItemToCatalogTrack(item)
     );

     setQueue(orderedTracks);
     setQueueIndex(currentIndex);
   });
   ```
3. **Hardware Settling & Advancement Authority**:
   * Hardware clock settling delays (`computeSampleRateTransition`) are moved directly into native `AudioEngine::play_track`, ensuring that remote `JumpToQueueIndex` commands never bypass DAC relay settling.
   * End-of-track progression is governed authoritatively by the native `AudioEngine`, eliminating races between desktop React timers and backend completion monitors.

---

### 4. Subsystem 2: Deterministic Queue State Evaluation

To eliminate false active-track indications on mobile (Hypothesis H2) and duplicate track highlighting bugs:

#### Contract Update (`pwa/src/components/Queue/QueueView.tsx`)
Extend `QueueViewProps` to accept `status: PlaybackStatus`. Replace file-path matching with unique queue-entry ID validation:

```typescript
const isPlaybackActive = (status.isPlaying || status.isPaused) && Boolean(status.currentFile);
const isCurrent = isPlaybackActive && (
  (status.currentQueueEntryId && item.queueEntryId === status.currentQueueEntryId) ||
  (!status.currentQueueEntryId && idx === queue.currentIndex)
);
const isActivelyPlaying = isCurrent && status.isPlaying && !status.isPaused;
```

#### Visual Row States
*   **Actively Playing (`isActivelyPlaying === true`)**: Amber track title, glowing border, animated `<Volume2 className="animate-pulse text-[#D4AF37]" />` icon.
*   **Paused (`isCurrent === true && status.isPaused === true`)**: Amber track title, static `<Pause className="w-4 h-4 text-[#D4AF37]" />` icon.
*   **Stopped / Idle (`isPlaybackActive === false`)**: Neutral track title, no active border, static track index numeral (`idx + 1`).

---

### 5. Subsystem 3: Desktop-First 1:N Versions Architecture

To eliminate format-driven catalog clutter (e.g., separate entries for CD, 24/96 FLAC, DSD64, PGGB) while preserving exact edition integrity:

#### Schema Simplification (`src-tauri/src/db/schema.rs`)
Model the relationship as a clean 1-to-many relationship without an intermediate junction table:
```sql
CREATE TABLE IF NOT EXISTS master_albums (
    id TEXT PRIMARY KEY,
    canonical_title TEXT NOT NULL,
    canonical_artist TEXT NOT NULL,
    default_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
);

-- Add foreign key directly to releases table
ALTER TABLE releases ADD COLUMN master_album_id TEXT REFERENCES master_albums(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_releases_master_album ON releases(master_album_id);
```

#### Dynamic Technical Summaries
Edition technical details (`sample_rate`, `bit_depth`, `format_summary`) are derived dynamically via SQL aggregation over `tracks` (identical to facet queries in `server.rs`), eliminating redundant columns and schema drift.

#### Clustering & Curation Governance
* Releases are grouped under `master_albums` via matching MusicBrainz Release Group IDs (`release_group_mbid`) or explicit manual curation in Desktop Curate.
* Automated heuristics do not cluster solely on title and artist, preventing collisions on self-titled, eponymous live, or distinct classical recordings.
* When a designated master release is offline or deleted, `master_albums.default_release_id` is retained as offline or updated via explicit user action.
* Compilations and multi-disc box sets with distinct release IDs remain completely unaffected by versions grouping.

#### Desktop & Mobile Presentation
* **Desktop (`VariantStackCard.tsx` / `FocusedWorkbench.tsx`)**: Renders canonical album cards displaying an edition count badge (`3 Editions`). Opening the card displays the version stack with format pills and master designation controls.
* **Mobile (`pwa/src/components/Catalog/AlbumModal.tsx`)**: Renders a **Segmented Version Carousel** below the artwork header. Selecting a pill dynamically swaps the tracklist, DR score, and technical badges. Tapping **Play Album** plays the currently selected version.

---

### 6. Subsystem 4: Idle Artwork Serving via `MaintenanceWorker`

To guarantee zero disk I/O on music storage drives during playback while eliminating blank artwork cards (Hypothesis H3):

#### Maintenance Worker Interleaving (`src-tauri/src/maintenance/worker.rs`)
1. **Reuse Existing Worker**: Do not spawn a new worker thread. Extend `MaintenanceWorker::run_loop()`, which already runs with `THREAD_PRIORITY_BELOW_NORMAL`, `THREAD_MODE_BACKGROUND_BEGIN`, Core 0/1 affinity isolation, and strict 30-second post-playback cooldown gating (`is_audio_idle()`).
2. **Task Interleaving**: Interleave release artwork thumbnail caching with artist portrait downloads so artwork tasks are never starved behind large portrait backlogs.
3. **Zero Audio Drive I/O (Rule 1)**: In the idle loop, thumbnail pre-caching strictly processes adjacent folder art (`cover.jpg`/`folder.jpg`) or previously indexed artwork records. Parsing embedded ID3v2/DSF tags from multi-gigabyte audio files on library storage drives is restricted to explicit Desktop Library Scans, preventing unabortable synchronous disk reads if playback initiates.

#### Mobile HTTP Serving Policy (`src-tauri/src/remote/server.rs`)
* **Cached Art**: If thumbnail exists in `%APPDATA%/cadence/cache/artwork/{id}.jpg`, return `HTTP 200` with image bytes and `Cache-Control: public, max-age=604800, immutable`. Image URLs include version hashes (`/api/remote/artwork/:id?v=:mtime`) for cache busting.
* **Uncached Art**: Return `HTTP 204 No Content` with `Cache-Control: no-cache` immediately. **Zero disk reads or seeks are initiated on the audio storage drives during playback.**
* **Concurrency Limit**: Clamped to 3 concurrent requests via `ConcurrencyLimitLayer::new(3)` to preserve network quietness (Rule 4).
* **Client Handling**: Mobile PWA renders a local SVG placeholder on 204 and records failed IDs in a memory `Set` to prevent redundant polling cascades.

---

### 7. Subsystem 5: Mobile Listening Shell & 2-Tab Navigation

To provide continuous listening context without depriving compact mobile screens of browsing space:

#### 2-Tab Navigation Model (`pwa/src/components/Navigation/TabBar.tsx`)
Streamline `TabBar` to **2 primary tabs: `Catalog` and `Queue`**. Remove the redundant `Playing` tab, establishing the Mini-Player as the single entry point for active playback context.

#### Floating Mini-Player (`pwa/src/components/Navigation/MiniPlayer.tsx`)
1. **Mounting & Elevation**: Mounted in root `App.tsx` floating 8pt above `TabBar` within its own elevation layer.
2. **Geometry & Padding**: ~48–52pt height. Scrolling views (`CatalogView`, `QueueView`) maintain static `pb-28` bottom padding, ensuring content is never hidden behind the floating player and layout geometry never shifts.
3. **Primary Affordances**:
   * **Tap-to-Open (Primary)**: Tapping anywhere on the mini-player body expands `NowPlayingView`.
   * **Visible Expand Affordance**: Features a visible chevron icon (`<ChevronUp className="w-4 h-4 text-zinc-400" />`) on the trailing edge.
   * **Direct Transport Control**: 44pt touch target play/pause toggle.
   * **No Gesture Traps**: Custom vertical swipe-up listeners are omitted to prevent gesture collisions with iOS Safari address-bar scrolling and Android system bars.
4. **Zero-Height Collapse**:
   When `!status.isPlaying && !status.isPaused && !status.currentFile`, the container transitions via CSS:
   ```css
   height: 0;
   opacity: 0;
   margin-bottom: 0;
   overflow: hidden;
   transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1);
   ```

#### Modal Sheet Presentation (`pwa/src/components/NowPlaying/NowPlayingView.tsx`)
* Presented as a full bottom sheet modal overlaying the active tab.
* **History API Integration**: Upon opening, executes `window.history.pushState({ modal: 'now-playing' }, '')`. Listens to `popstate` so that pressing the Android hardware back button or executing an iOS edge swipe dismisses the sheet instead of exiting the PWA.

---

### 8. Subsystem 6: Three-Tier Signal Path Telemetry & Hardware Device Routing

Replaces unranked badges with an intuitive visual hierarchy and interactive device routing:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 1: HOST SESSION & LINK (App Header)                               │
│ CADENCE • CONNECTED (Host Wi-Fi: 5GHz • 0.8ms)                         │
│ [ 🔈 DAC USB (WASAPI Exclusive) ▾ ]  <-- Interactive Device Selector   │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 2: 3-NODE HARDWARE SIGNAL CHAIN (Now Playing Sub-Header)          │
│ [ Source: DSF DSD128 5.6MHz ] ➔ [ DSP: BIT-PERFECT DIRECT ] ➔         │
│                                  [ Output: WASAPI Exclusive ]          │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 3: TRACK ACOUSTICS & CONTROLS (Track Surface)                     │
│ Artwork (300x300) • Title • Artist • Album                             │
│ Dynamic Range Badge: [ DR 14 ]                                         │
│ Micro-Scrubber • Transport Buttons                                     │
│ VolumeGuard: [ 🔒 BIT-PERFECT UNITY GAIN (0.0 dB Locked) ]             │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Tier 1 (Link State & Output Endpoint)**: Header telemetry queries Desktop Host WLAN status (via Windows Native WLAN API), displaying host connection band, remote ping latency, and an interactive Output Device Chip. Tapping the chip opens the **Audio Device & Hardware Sheet** from any screen.
2. **Tier 2 (Hardware Signal Path)**: Three distinct pill nodes representing:
   * **Node 1 (Source)**: Verified container format, sample rate, and DSD clock rate in MHz (`FLAC 192kHz/24bit`, `DSF DSD256 11.2MHz`).
   * **Node 2 (Signal Integrity)**: `BIT-PERFECT DIRECT` in Purity Mode; indicates resampling mode if OS mixer is active.
   * **Node 3 (Output Device)**: Hardware endpoint name and driver mode (`WASAPI Exclusive`, `ASIO`).
3. **Tier 3 (Track Surface & Controls)**: Track title, artist, album, album-average Dynamic Range score (`DR 14`), and `VolumeGuard` (locked slider displaying unity gain protection).
4. **Backend Volume Protection**: Enforced at the protocol boundary in `src-tauri/src/audio/player.rs`: `AudioEngine::set_volume` rejects attenuation or clamps to 1.0 whenever `purity_mode == true`.

---

### 9. Audiophile Transport Purity & Impact Assessment

Pursuant to `.agents/rules/audiophile.md`, this design complies with all six transport purity invariants:

*   **Disk I/O Impact during active/paused playback**: **Zero disk reads/writes on music library drives.** On-demand thumbnail extraction remains strictly blocked during playback. Artwork serving reads exclusively from `%APPDATA%` on the local NVMe drive. `MaintenanceWorker` runs strictly during idle periods (`!is_playing && cooldown >= 30s`) and only accesses library drives for lightweight folder images, never initiating unabortable embedded tag reads on audio files.
*   **Network/NIC Burst Impact on Wi-Fi/Ethernet**: **Clamped and deterministic.** WebSocket broadcasts remain event-driven + slow 5s heartbeat. Mobile artwork requests are concurrency-capped at 3 simultaneous HTTP connections. Mobile queue mutations use compact JSON payloads.
*   **Thread/CPU Scheduling Impact on Core 0/1 and pinned streaming core**: **Zero impact.** The audio streaming thread (`cadence-paced-stream`) runs uninterrupted with MMCSS Pro Audio priority and CPU affinity away from Core 0/1. Background maintenance runs with `THREAD_PRIORITY_BELOW_NORMAL` and `THREAD_MODE_BACKGROUND_BEGIN`.
*   **Memory Allocation Impact on `VirtualLock` and heap churn**: **Zero impact.** Native streaming buffer lifecycle and Win32 `VirtualLock` memory pinning remain untouched. No heap allocations are added to the active packet transmission loop.
*   **Bit-Perfect Signal Integrity**: **Preserved.** Purity Mode bypasses OS mixing and software attenuation. `VolumeGuard` locks mobile software sliders at unity gain (1.0), and the native backend clamps volume adjustments while Purity Mode is active.
*   **Format & Container Ground-Truth Parsing**: **Maintained.** Format labels and bitrates originate directly from native container header probing (`Probe::open`) and hardware driver telemetry.

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Comparative Evaluation of Mini-Player Layout Architectures

Three layout candidates were evaluated for vertical space efficiency and touch accessibility:
1.  **Option 1: Static, collapsible mini-player**: Predictable layout and scrolling; reduces available content height while active.
2.  **Option 2: Floating, collapsible mini-player**: Visually elevated; requires static bottom padding on scrolling views to avoid obscuring items.
3.  **Option 3: Player integrated directly into bottom navigation**: Maximum space efficiency; insufficient room for audiophile metadata, format badges, and touch targets.

*   **Decision**: Adopt **Option 2 (Floating, collapsible mini-player)** paired with a **2-Tab Navigation Model (`Catalog`, `Queue`)** and static `pb-28` bottom padding. Streamlining the tab bar to 2 tabs recovers 33% of bottom navigation density, providing ample clearance for the floating player without crowding compact 375pt viewports.

### Alternative B: Frontend-Only Fuzzy Version Grouping in Mobile Client
*   **Reason for Rejection**: Violates Invariant 4 (Edition integrity) and Cadence's core design principle of Desktop authority. Modeling multi-edition relationships as an explicit 1:N schema in SQLite on Desktop first guarantees deterministic attribution and consistency across all controllers.

### Alternative C: On-Demand Artwork Extraction with Throttled Concurrency During Playback
*   **Reason for Rejection**: Directly violates Audiophile Rule 1 (Storage Bus Silence). Host disk reads on audio drives cause bus wakeups, power-state transients, and DPC latency spikes that compromise bit-perfect playback integrity. Shifting thumbnail extraction to an idle background worker and serving clean placeholders for un-cached items strictly guarantees zero storage I/O during playback.

### Alternative D: Gesture-Only (Swipe-Up) Sheet Expansion
*   **Reason for Rejection**: Violates Apple HIG and user control guidelines. Tap-to-open is established as the primary, unambiguous interaction with an explicit expand chevron; custom swipe-up touch listeners are omitted to prevent navigation traps.

--------------------------------------------------------------------------------

## Non-Functional Requirements

### 1. Storage Bus Silence & Playback Hygiene (Audiophile Rule 1)
* Zero disk I/O on music library drives while `AudioEngine` is in `Playing`, `Paused`, or `Loading` states (or within 30 seconds of stopping).
* Artwork thumbnail generation runs strictly during transport idle cooldown (`cooldown >= 30s`) and aborts within 10ms upon playback startup.

### 2. Network PHY Quietness & Control-Plane Budget (Audiophile Rule 4)
* WebSocket telemetry broadcasts are strictly event-driven; steady-state heartbeat is clamped to $\ge$ 5.0 seconds.
* Mobile HTTP image requests are capped at 3 concurrent connections to prevent Wi-Fi radio buffer bloat and burst EMI/RFI near audio hardware.

### 3. Bit-Perfect Signal Integrity & Volume Protection (Audiophile Rule 5)
* In Purity Mode, volume attenuation is blocked at the backend protocol boundary, and mobile software volume sliders are hardware-guarded at unity gain (1.0 / 0.0 dB) via `VolumeGuard`.

### 4. Responsiveness & Latency
* Queue mutations round-trip to backend and reflect across both mobile and desktop within $< 50\text{ ms}$ over local Wi-Fi.
* Mini-player zero-height transition completes in $200\text{ ms}$ using standard cubic-bezier easing (`cubic-bezier(0.16, 1, 0.3, 1)`).

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Phased Implementation Rollout
*   **Phase 1: SQLite Schema & Native IPC Core**: Add `master_albums` table and `releases.master_album_id` in SQLite. Implement query routines in `operations.rs` and Tauri IPC commands for version management.
*   **Phase 2: Intent-Based Queue & Maintenance Interleaving**: Extend `RemoteQueue` with unique `queue_entry_id` and `next_up_end_index`. Implement discrete queue commands in `ws.rs`, interleave artwork pre-caching in `worker.rs`, and enforce backend purity mode volume clamping in `player.rs`.
*   **Phase 3: Desktop Frontend Reconciliation**: Integrate `appliedServerRevisionRef` and async hydration revision guards in `AudioPlayerContext.tsx`, rehydrate full `Track` domain entities from SQLite, and expose version stack cards in `VariantStackCard.tsx` / `FocusedWorkbench.tsx`.
*   **Phase 4: Mobile Remote Shell, Navigation & Feedback**: Transition `TabBar.tsx` to 2 tabs, mount `MiniPlayer.tsx` with static `pb-28` padding, implement `NowPlayingView.tsx` with `history.pushState` integration, render the version carousel in `AlbumModal.tsx`, and add non-blocking toast feedback with [Undo] and [Retry Reorder] support.

---

### Target Files to Create/Modify

#### 1. `src-tauri/src/remote/state.rs` (Modify)
*   **Type / Scope**: Native Rust State Module
*   **Proposed Changes**:
    *   Add `pub queue_entry_id: String` to `RemoteTrackItem`.
    *   Add `pub revision: u64`, `pub current_queue_entry_id: Option<String>`, and `pub next_up_end_index: Option<usize>` to `RemoteQueue`.
    *   Update `broadcast_queue_update(&self)` to emit `cadence:remote-queue-changed` and send `RemoteEvent::QueueUpdated { items, current_index, revision }`.

#### 2. `src-tauri/src/remote/ws.rs` (Modify)
*   **Type / Scope**: Native Rust WebSocket Handler
*   **Proposed Changes**:
    *   Add intent-based command variants to `ClientCommand`: `EnqueueTrack`, `EnqueueRelease`, `RemoveFromQueue`, `ReorderQueue`, `ClearQueue`, `JumpToQueueIndex` with `expected_revision: Option<u64>`.
    *   Implement Next-Up segment insertion logic preserving FIFO order for consecutive `play_next` additions.
    *   Validate `expected_revision` against `state.queue.lock().revision`. Emit `RemoteEvent::QueueConflict` on mismatch.
    *   Increment `queue.revision += 1` on success and broadcast updates.

#### 3. `src/context/AudioPlayerContext.tsx` (Modify)
*   **Type / Scope**: Desktop React State Context
*   **Proposed Changes**:
    *   Add `appliedServerRevisionRef = useRef<number>(0)` and `latestHydrationRevisionRef = useRef<number>(0)`.
    *   Subscribe to `cadence:remote-queue-changed`. Rehydrate complete `Track` entities via `sqliteLibraryService.getTracksByIds()`, verifying revision freshness before calling `setQueue`.
    *   Eliminate indiscriminate full-queue sync from general `useEffect`. Outbound sync dispatches only from explicit user interaction handlers.

#### 4. `src/services/tauriBridge.ts` (Modify)
*   **Type / Scope**: Desktop IPC Bridge Service
*   **Proposed Changes**:
    *   Add methods for intent-based queue mutations: `reorderQueue`, `enqueueTrack`, `removeFromQueue`.
    *   Add IPC calls for Master Album queries: `getMasterAlbums`, `getAlbumVersions`, `setDefaultReleaseVersion`.

#### 5. `src-tauri/src/commands/remote.rs` & `src-tauri/src/commands/library.rs` (Modify)
*   **Type / Scope**: Tauri Command Handlers
*   **Proposed Changes**:
    *   Expose Tauri commands `get_master_albums`, `get_album_versions`, `set_default_release_version`.
    *   Update queue command signatures to ingest revision anchors.

#### 6. `pwa/src/types/remote.ts` (Modify)
*   **Type / Scope**: Mobile TypeScript Types
*   **Proposed Changes**:
    *   Add `queueEntryId: string` to `RemoteTrackItem`.
    *   Add `revision: number`, `currentQueueEntryId?: string`, and `nextUpEndIndex?: number` to `RemoteQueue`.
    *   Add `QUEUE_CONFLICT` and `DEVICE_UNAVAILABLE` to `RemoteEvent` union.
    *   Add `AlbumVersionSummary` interface and update `DbRelease` with `versions?: AlbumVersionSummary[]`.
    *   Update `PlaybackStatus` and `AudioStreamInfo` to carry Tier 2 telemetry (`driverMode`, DSD clock rate MHz, `dspMode`).

#### 7. `pwa/src/hooks/useRemoteSocket.ts` (Modify)
*   **Type / Scope**: Mobile React Hook
*   **Proposed Changes**:
    *   Track `queue.revision` and supply `expected_revision` in `reorderQueue`, `queueTrack`, `removeFromQueue`, and `clearQueue`.
    *   Handle `QUEUE_CONFLICT` by notifying the UI with `conflictEvent` so that `QueueView` can surface `Queue changed while you were disconnected` and offer an entity-anchored `[Retry Reorder]` action.
    *   Implement client-side `Set<string>` for failed 204 artwork requests to prevent polling loops.

#### 8. `pwa/src/components/Queue/QueueView.tsx` (Modify)
*   **Type / Scope**: Mobile Queue Component
*   **Proposed Changes**:
    *   Add `status: PlaybackStatus` to `QueueViewProps`.
    *   Evaluate `isPlaybackActive = (status.isPlaying || status.isPaused) && Boolean(status.currentFile)`.
    *   Evaluate active item using `item.queueEntryId === status.currentQueueEntryId || (idx === queue.currentIndex && isPlaybackActive)`.
    *   Render active styling and volume pulse strictly when active; render static numerals when stopped.
    *   Render persistent Transport Action Deck in header with **[ ▶ Resume Playback ]** and device routing when stopped.
    *   Display conflict reconciliation banner with **[Retry Reorder]** when a mutation collision occurs.

#### 9. `src-tauri/src/maintenance/worker.rs` (Modify)
*   **Type / Scope**: Native Rust Background Maintenance Worker
*   **Proposed Changes**:
    *   Interleave release artwork thumbnail caching with artist portrait tasks in `run_loop()`.
    *   Enforce Rule 1 idle gating: only process folder art (`cover.jpg`/`folder.jpg`) or cached records during idle cooldown (`!is_playing && cooldown >= 30s`). Never read audio files for embedded tags in the background worker.

#### 10. `src-tauri/src/remote/server.rs` (Modify)
*   **Type / Scope**: Native Rust HTTP API Routes
*   **Proposed Changes**:
    *   Configure `ConcurrencyLimitLayer::new(3)` to clamp parallel image requests.
    *   In `/api/remote/artwork/:id`: Check `artwork_cache.get_cached_only(&id)`. Return `HTTP 200` with version hash if cached; return `HTTP 204 No Content` immediately if uncached.
    *   In `/api/remote/releases`: Return clustered master albums with dynamically aggregated version summaries.

#### 11. `src-tauri/src/db/schema.rs` (Modify)
*   **Type / Scope**: SQLite Schema Definition
*   **Proposed Changes**:
    *   Add table migration for `master_albums (id, canonical_title, canonical_artist, default_release_id, created_at)`.
    *   Add column migration: `ALTER TABLE releases ADD COLUMN master_album_id TEXT REFERENCES master_albums(id) ON DELETE SET NULL;`.

#### 12. `src-tauri/src/db/operations.rs` (Modify)
*   **Type / Scope**: SQLite Database Operations
*   **Proposed Changes**:
    *   Implement `DbOperations::get_master_albums`, `get_album_versions`, and `set_default_release_version`.
    *   Retain user preferences when drives are offline; provide explicit fallback queries without automatic resolution bias.

#### 13. `src/components/CenterStage/VariantStackCard.tsx` & `FocusedWorkbench.tsx` (Modify)
*   **Type / Scope**: Desktop Catalog & Curation Views
*   **Proposed Changes**:
    *   Render unified Master Album cards with edition count badges.
    *   Expose version stack picker pills and designate master release controls without assuming high-res is superior mastering.

#### 14. `pwa/src/components/Catalog/AlbumModal.tsx` (Modify)
*   **Type / Scope**: Mobile Catalog Modal View
*   **Proposed Changes**:
    *   Render horizontal scrolling Segmented Version Carousel below the artwork header.
    *   Selecting a version updates tracklist, DR scores, and format badges; **Play Album** plays the selected version with queue preservation and [Undo].
    *   Display offline drive indicators (`⚠️ Drive Offline`) and local version fallback prompts.

#### 15. `pwa/src/components/Navigation/MiniPlayer.tsx` (Create)
*   **Type / Scope**: Mobile Navigation Component
*   **Proposed Changes**:
    *   Floating island card positioned 8pt above the bottom tab bar (~48–52pt height).
    *   Includes track title, artist, 44pt touch target play/pause toggle, and visible expand chevron.
    *   Tapping the card expands `NowPlayingView`.
    *   Collapses to `height: 0; opacity: 0; margin: 0;` when stopped.

#### 16. `pwa/src/components/Navigation/TabBar.tsx` (Modify)
*   **Type / Scope**: Mobile Bottom Navigation Bar
*   **Proposed Changes**:
    *   Streamline to 2 tabs: `Catalog` and `Queue`. Remove `now_playing` tab.
    *   Preserve safe-area insets (`env(safe-area-inset-bottom)`).

#### 17. `pwa/src/components/NowPlaying/NowPlayingView.tsx` (Modify)
*   **Type / Scope**: Mobile Now Playing View
*   **Proposed Changes**:
    *   Implement 3-tier signal path visual hierarchy.
    *   Integrate with Browser History API: push history state on open, listen to `popstate` to dismiss on Android back button or iOS edge swipe.
    *   Embed existing `VolumeGuard.tsx` for locked bit-perfect unity gain.

#### 18. `pwa/src/App.tsx` (Modify)
*   **Type / Scope**: Mobile PWA Root Application
*   **Proposed Changes**:
    *   Mount `MiniPlayer` floating above `TabBar`.
    *   Apply static `pb-28` bottom padding to `CatalogView` and `QueueView` scrolling containers.
    *   Manage modal sheet state for `NowPlayingView` and Audio Device Routing Sheet.

#### 19. `src-tauri/src/audio/player.rs` (Modify)
*   **Type / Scope**: Native Audio Engine Core
*   **Proposed Changes**:
    *   Move hardware relay settling delay (`computeSampleRateTransition`) into `AudioEngine::play_track`.
    *   Enforce purity mode volume protection: clamp volume to 1.0 or reject attenuation in `set_volume` when `purity_mode == true`.
    *   Trap hardware endpoint disconnects within 10ms and emit `RemoteEvent::DeviceUnavailable`.

---

## Verification Plan

### Compilation & Build Verification
*   **Frontend Type Check & Build**:
    ```bash
    npm run build
    ```
    Must compile cleanly with zero TypeScript errors (`tsc -b`).
*   **Mobile Remote PWA Build**:
    ```bash
    npm run --prefix pwa build
    ```
    Must bundle production assets cleanly into `src-tauri/src/remote/dist`.
*   **Native Backend Build & Test**:
    ```bash
    cargo test --manifest-path src-tauri/Cargo.toml
    ```
    Must pass all native unit and integration tests.

### Automated Unit & Concurrency Testing
*   **Artwork Cache Idle Gating Test (`src-tauri/src/remote/artwork_cache.rs`)**:
    *   Assert `get_cached_only` returns `None` immediately when a thumbnail is not cached.
    *   Assert `MaintenanceWorker` yields when `is_audio_idle()` evaluates to false.
*   **Queue Revision Conflict Test (`src-tauri/tests/remote_queue_test.rs`)**:
    *   Simulate two WebSocket clients sending conflicting mutations with mismatched `expected_revision`.
    *   Assert second mutation is rejected with `RemoteEvent::QueueConflict` and queue state remains consistent.
*   **Duplicate Track Unique Identity Test (`src-tauri/tests/remote_queue_test.rs`)**:
    *   Add identical track file path to queue twice; verify each receives a distinct `queue_entry_id`.
*   **Purity Mode Volume Clamping Test (`src-tauri/src/audio/player.rs`)**:
    *   Enable purity mode; assert `set_volume(0.8)` returns an error or clamps to `1.0`.

### Functional Verification Across Critical User Journeys (CUJ 1–11)
*   **CUJ 6 (Play Now & Session Preservation)**: Verify tapping *Play Now* in `AlbumModal` begins playing track 1 immediately, preserves the previous queue behind the album, and presents an [Undo] toast that restores prior queue state.
*   **CUJ 7 (Play Next Stable FIFO Segment)**: Verify consecutive *Play Next* commands on Album B then Album C insert in stable chronological order (`A → B → C`) within the Next-Up segment without interrupting active audio.
*   **CUJ 8 (Versions Grouping & Anti-Resolution Bias)**: Verify grouping multi-edition releases on desktop updates `releases.master_album_id` without corrupting compilations; verify an unplugged master edition is retained as offline and does not automatically default to high-res.
*   **CUJ 9 (Stopped Queue Playback Resumption)**: Verify that when playback is stopped and MiniPlayer is collapsed, tapping **[ ▶ Resume Playback ]** in the Queue Header deck immediately resumes playback and animates the MiniPlayer into view.
*   **CUJ 10 (Conflict Explanation & Intent Protection)**: Verify that when a mobile client reconnects with a stale revision, the user sees an explicit explanation with an entity-anchored **[Retry Reorder]** action.
*   **CUJ 11 (Hardware Device Disconnection)**: Simulate USB DAC unplugging during 192kHz streaming; verify `AudioEngine` traps disconnect within 10ms, halts transport, and mobile surfaces the deliberate recovery sheet.

### Audiophile Invariant Telemetry Verification
*   **Zero Storage I/O During Active Playback (Rule 1)**:
    1. Launch Windows Sysinternals Process Monitor (`procmon.exe`).
    2. Filter by process `cadence.exe` and path matching the music library drive (e.g., `D:\Music`).
    3. Start bit-perfect DSD/FLAC playback.
    4. Browse the Mobile Catalog across 200+ albums and open multiple album detail sheets.
    5. Verify zero `ReadFile`, `CreateFile`, or `QueryDirectory` events occur on the music library storage bus during active playback.
*   **Network PHY Quietness (Rule 4)**:
    1. Inspect WebSocket frame telemetry in browser developer tools while music is playing.
    2. Verify steady-state heartbeats occur at $\ge 5.0\text{ s}$ intervals with zero continuous millisecond position polling.
*   **Bit-Perfect Signal Path (Rule 5)**:
    1. Enable Purity Mode.
    2. Verify `VolumeGuard` displays the locked badge in `NowPlayingView` and blocks software volume slider adjustments.
