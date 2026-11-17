# Mobile Remote after the standalone Engine split

Date: 2026-11-16. Scope: current working tree, including in-progress Windows Engine changes. Analysis only; no application code changed or live playback commands issued.

The standalone design supersedes the old optional-Core ownership model. Mobile must connect directly to either Windows or Linux Playback Engine. The thin desktop is another controller, not a mobile gateway. Selecting an Engine on desktop must not silently redirect a phone already controlling another Engine.

**Finding: mobile migration is incomplete.** Basic direct-Core playback exists, but the entry point and much of the old mobile feature surface still depend on the removed desktop server. This is several contract gaps, not a single URL change.

## Evidence and required repairs

### P0: QR pairing cannot complete the browser journey

Evidence: `src/components/Modals/MobileRemoteModal.tsx:21` constructs `https://<engine>/?token=...&fp=...`. It omits `kind=core`, `engineId`, `libraryId`, and label. `pwa/src/services/serverProfiles.ts` uses `kind` to select the Core adapter; absent kind follows the legacy desktop path. The shared Windows/Linux listener in `src-tauri/src/core_runtime/dragonfish.rs:1198-1310` exposes health, Core RPC, events and artwork, but no `/`, HTML, JS, icons or manifest routes. That QR destination therefore returns 404 even before the adapter mismatch matters. `src-tauri/src/lib.rs:137` no longer initializes the legacy remote server. Its PWA assets remain in `remote/dist`, behind the desktop module boundary.

Repair:

- Package PWA assets independently of the legacy Tauri remote module and serve them from both Engines, with correct MIME types, SPA routing, manifest/icon paths and bounded static delivery. Keep API authorization separate from public shell assets.
- Centralize a versioned pairing payload containing Engine LAN URL, protocol kind, stable Engine/library identities, display label and certificate fingerprint. Use it for browser QR, Android import and manual paste; test round trips.
- Resolve the LAN endpoint from authenticated Engine metadata. A desktop connection to `127.0.0.1` does not mean its Engine is loopback-bound: the current Windows default binds `0.0.0.0`, while localhost pairing metadata intentionally uses `127.0.0.1`. Do not require changing the desktop profile just to pair a phone. Reject all loopback forms, including IPv6, in phone links.
- Publish a QR only when required credentials and a usable LAN endpoint exist; distinguish LAN-disabled from firewall/reachability failures.
- Establish a browser-supported HTTPS trust journey. A fingerprint in a QR enables native pinning; browser JavaScript cannot install trust or bypass a self-signed certificate. CORS alone cannot solve TLS or installability.

### P0: Android discovery and native transport remain desktop-specific

Evidence: `pwa/android/app/src/main/java/com/cadence/remote/CadenceRemotePlugin.java:58,439` discovers `_cadence._tcp.`. Windows Engine advertises `_cadence-core._tcp.local.` in `windows_engine.rs:560`; Core discovery uses that namespace. The Android resolved-service projection does not carry the complete Engine profile. `PairingView.tsx` defaults to `local` and requires the user to select Core manually.

Further, `useRemoteSocket.ts:534` deliberately skips `syncNativeServerProfile` for Core. `createPwaCoreClient` delegates Android HTTP to `nativeOrFetchHttp`, whose generic native request uses the active pinned client. Thus Core requests are not guaranteed to use the selected Core's configured trust state; an old desktop native profile may remain active.

Repair: discover Engine service types, parse identity/TLS TXT metadata into the typed profile, and choose the Engine adapter from verified hello/capabilities. Configure the selected Engine's pinned native client before every Engine activation. Keep browser trust handling separate. Preserve legacy discovery only as an explicit compatibility adapter. Test two Engines with different certificates and switching from a legacy desktop profile.

### P1: Engine catalog bypasses the real mobile browse experience

Evidence: `pwa/src/App.tsx:226` renders a flat list for Core. Only non-Core profiles reach `CatalogView` at line 273. Album grid, album details, language/format facets and search in that component are consequently unavailable in Engine mode. `CatalogView` and `AlbumModal` fetch legacy `/api/remote/library/*` endpoints. There is no mobile playlist component or client operation despite `playlists.*` existing in Engine v2.

Repair: make the catalog UI consume an Engine-backed catalog service instead of fetching desktop REST internally. Preserve authoritative release identities, edition/compilation grouping, ordered tracks, DSD metadata and language facets. Reuse pure grouping/filter functions where their contracts match. Add playlist list/detail/play/queue journeys via v2 `playlists.*`; agree whether mobile editing is required before exposing edit controls. Scope caches by Engine + library + catalog revision. Keep Storage and Curate outside the mobile UI.

### P1: many visible queue actions silently do nothing

Evidence: Core translation in `useRemoteSocket.ts:1202-1275` handles pause/resume/stop, single-track play, seek, next/previous, jump and track append. It returns `false` for every other action. Public callbacks still emit `play_release`, `play_track_in_release`, `queue_release`, `remove_from_queue`, `clear_queue`, `reorder_queue`, `set_volume` and `toggle_purity`. Queue remove/clear remain visible in `App.tsx`; album actions would also fail if the catalog UI were simply switched over. `queueTrack(..., playNext)` ignores `play_next` in the Core branch and always appends. The client type defines queue modes, but this dispatcher does not translate them.

Repair: inventory every visible callback and implement typed Engine operations for its semantics. Prefer server-serialized enqueue/remove/reorder/clear/play-release operations using stable entry IDs, command IDs and expected revisions. If using existing `queue.replace` temporarily, preserve entry identities and current playback selection, reject stale state, and make album play atomic rather than independently replacing a queue and starting a track. A rejected action must show actionable feedback. Do not replay stale mutations automatically.

### P1: output selection and signal-path status are incorrect

Evidence: `useRemoteSocket.ts:478-505` always calls legacy `/api/remote/devices`, even for Core. `applyCoreSnapshot` substitutes the current output label as a one-item device list. Windows Engine has `outputs.list`, `output.select`, `player.volume`, and `player.purity` handlers, but the mobile Core client cannot call them. `coreRemoteClient.ts:460` hard-codes volume=1, purityMode=true and isBitPerfect=true. Its output transport validator accepts only `system_default`, `wasapi`, and `upnp`, which also needs alignment with Windows Engine endpoint transport values.

Repair: define a shared cross-platform output contract with stable IDs, supported operations, playback restrictions and actual signal-path telemetry. Linux can advertise its supported/pinned UPnP route without pretending Windows outputs are available. Wire the mobile picker to these operations. Hide or disable unsupported volume/purity actions with an explanation. Report bit-perfect only from verified Engine telemetry; represent unknown explicitly. Preserve server-side unity-gain enforcement.

### P1: artwork uses the wrong endpoint, identity and authentication mechanism

Evidence: `pwa/src/services/api.ts:61` builds `/api/remote/library/artwork/:id?token=...`; Now Playing and `useMediaSession` both use it with the current track ID. Engine serves `/v1/artwork/:releaseId`. The Engine deliberately rejects query-string credentials and requires an authorization header, which an ordinary `<img src>` or MediaSession artwork URL cannot attach. Replacing only the URL prefix will still fail.

Repair: resolve track to its release/artwork identity and implement authenticated bounded binary fetch with reusable Blob URLs for in-app images, including native pinning support. Verify Blob artwork on supported lock-screen platforms; where it fails, use a narrowly scoped, short-lived artwork URL or another explicit browser-compatible authorization mechanism. Do not embed a broad Engine token in image URLs. Revoke Blob URLs on scope changes, honor ETags, and use cached covers/placeholders when extraction is deferred during playback.

### P1: multi-controller updates rely on polling, not Engine events

Evidence: `useRemoteSocket.ts:1027` fetches `session.snapshot` every five seconds, plus up to eight loading-settle requests 700 ms apart. There is no Core event subscription. Engine exposes `/v1/events` as SSE, not the WSS described in the designs; its current event drain is `take_library_events()` with a 10-second keepalive. It does not constitute a complete playback/queue event feed. The existing five-second foreground polling is not itself a sub-five-second heartbeat violation, but repeats catalog-bearing snapshots and does not meet the target push design.

Repair: choose and document one supported event transport. Extending existing authenticated SSE is a smaller change than introducing WSS, provided native streaming/pinning is supported. Publish bounded session/queue/output/catalog invalidations from Engine authority after changes, including natural transitions and external renderer changes. Subscribe with authenticated fetch streaming or a native equivalent; browser EventSource cannot attach the required custom header. Coalesce invalidations, fetch only affected projections, interpolate progress locally, and disconnect/suspend subscriptions on sleep. Reconnect with a fresh authoritative snapshot and no command replay. Preserve the separate paced audio listener.

### P1: lock-screen controls still target the old desktop API

Evidence: `CadenceMediaService.java` dispatches legacy action JSON. `CadenceRemoteStateHolder.java:275-320` sends it over the old socket or `/api/remote/command`, then refreshes `/api/remote/status`; native artwork also uses the old endpoint. The Core branch in `useRemoteSocket` never establishes that native socket/profile and returns early on background transition before legacy media-service handling. Browser MediaSession routes through JS callbacks, so it must be tested separately from Android's native service.

Repair: give the native media service an Engine-aware adapter with selected identity, pinned connection, authoritative state, command IDs and revision handling. Feed native metadata from validated Engine snapshots/events. A wake/lock-screen command may perform the bounded required request and state refresh; do not add continuous background polling. Explicitly terminate or rebind the old native session when selecting another Engine so a notification cannot control a previously selected host.

### P1: takeover, late responses and stale snapshots need controller-level handling

Evidence: the client supports `forceTakeover`, but `playTrack` never passes it and no mobile takeover confirmation is wired. A `takeover_required` response only sets an error. Passive refresh checks profile scope, but command completion calls `applyCoreSnapshot(updated, profile)` without checking whether a different Engine became active while awaiting the response. A stale-revision error parses the embedded snapshot directly without catalog hydration before applying it, risking loss of metadata beyond the first page.

Repair: stage takeover as an explicit user-confirmed intent and retry only that confirmed intent with fresh revision/identity. Add activation epochs/request generations to every asynchronous completion, including errors and commands, not just refresh. Keep old UI context until a candidate is validated. On conflict, retain or hydrate the complete revision-matched catalog while applying authoritative session state; preserve the no-auto-fallback policy and leave-playing behavior.

### P2: version negotiation and large-catalog boundaries need completion

Evidence: `coreRemoteClient.ts` always sends protocolVersion=1; `parseCoreDescriptor` accepts 2 but returns the constant 1. Engine v2 adds enriched catalog fields and playlist capabilities only through its v2 dispatch. Hydration stops after 100 continuation pages and then sets `nextCursor=null`, even if more pages exist; malformed/missing page tracks can also terminate as apparent success. Snapshot change detection focuses on transport/queue fields and catalog revision, so metadata correctness depends on reliable revision propagation.

Repair: negotiate a supported version, retain the negotiated version, and gate capabilities per feature. Share pure protocol types/validators between desktop and PWA without Tauri dependencies. Treat partial catalogs as partial; use lazy pagination or explicit bounded continuation rather than silently truncating. Validate page identity/revision/cursors and restart hydration on revision change. Separate session and catalog retrieval so a position update does not resend the first catalog page.

## Recommended delivery order

1. **Make connection real:** shared Engine-hosted PWA, complete QR payload/LAN resolution, HTTPS trust, Android discovery and native pin initialization. Exit: fresh browser and APK pair directly to Windows and Linux Engines with desktop closed.
2. **Restore the listening surface:** v2 client/capabilities, album/search/filter/playlist projections, authenticated artwork, complete queue semantics, truthful output telemetry and controls. Exit: every visible mobile control either performs its supported action or clearly explains why unavailable.
3. **Make multiple controllers reliable:** Engine session events, native lock-screen adapter, takeover UI, activation epochs, conflict hydration and pagination boundaries. Exit: desktop and two phones converge without polling or stale replay; closing any controller leaves playback running.
4. **Qualify and update docs:** replace the outdated desktop-server assumptions in `DEVELOPER.md`, PWA/native AGENTS guidance and deployment packaging notes; record supported protocol/event/trust behavior and remaining hardware limits.

No desktop DB, desktop playback authority or desktop proxy is needed to restore mobile. Optional-Core's independent per-controller Engine selection and explicit leave/takeover semantics remain useful; its old embedded This PC implementation is superseded.

## Required verification

Current check: `node --import tsx --test src/test/testPwaCoreController.ts` — **6/6 passed** on this working tree. These cover profile parsing, mocked client handshakes/commands, static connection UI, pagination, format/takeover protocol handling, and snapshot-change detection. They do not establish QR-to-browser hosting, real certificates, Android discovery/service controls, or full mobile feature parity.

Add focused regression coverage for:

- Desktop QR -> actual served PWA -> correctly scoped Engine handshake; install/launch on Android Chrome and iOS Safari. Include localhost desktop profile with a LAN-enabled Engine, LAN-disabled Engine, invalid token and changed cert.
- Android Engine discovery/TXT parsing and pin switching between two Engines; native background play/pause/next and metadata/artwork against Engine RPC.
- Album/search/facets, version/compilation grouping, DSD labels, playlist play/queue, and every visible queue/output/volume/purity callback.
- Concurrent edits from two phones, duplicate tracks with distinct entry IDs, stale revision after a later catalog page, Engine restart, and delayed old-Engine responses after switching.
- Catalog past the current 100-page boundary, partial/invalid pagination and a catalog revision change during hydration.
- Desktop-driven track/output changes reaching phones, natural track completion, external RS130 ownership/takeover, Wi-Fi loss, screen sleep/wake and controller closure without stopping playback.
- Tier 2 measurements for bounded HTTP/artwork/event work and rendering; Tier 3 PCM/DSD qualification for any changes to Engine session/output/audio behavior. Hardware-dependent checks remain unverified in this audit.

Use type checks and builds without overwriting existing embedded assets during diagnosis; the standard root build runs the PWA build into `remote/dist`.

## Audiophile impact assessment for proposed implementation

- **Disk:** catalog snapshots must use RAM projections; artwork extraction and scan/curation remain idle/cooldown-gated. Mobile browsing must not reintroduce library file reads during playback.
- **Network:** bounded static/artwork fetches, event invalidations and >=5-second keepalive; eliminate repeated full snapshots and rapid loading polling. Screen sleep suspends nonessential communication. No handset audio streaming.
- **Scheduling:** control/UI work stays outside isolated audio threads; preserve below-normal/background worker policy. Keep control traffic separate from audio pacing.
- **Memory:** cache bounded projections/covers and release old scope state; preserve locked-RAM ownership and zero-allocation paced loops.
- **Signal path:** show verified output/purity state and enforce bit-perfect volume rules on the Engine.

Implementation of these resource-sensitive changes requires the planning approval specified in `.agents/rules/audiophile.md`; this report does not authorize or execute those changes.

## Self-evaluation

Overall 4.2/5. Accuracy 4: source-backed findings and 6 passing tests; real phone/TLS/hardware behavior remains unverified. Completeness 4: covers entry, catalog, controls, events and native service; deployment-specific behavior requires live checks. Clarity 4: prioritized repairs with source anchors; the report is necessarily longer than a summary. Actionability 5: ordered delivery exits and concrete regression journeys. Conciseness 4: overlapping client/native failures are retained because they require different fixes.

Highest-impact improvements: validate the entry journey on real browser/APK builds, then qualify native background controls and cross-controller events on both Engines. Self-check: the assessment should be useful for implementation planning, provided its static-analysis scope is retained. Verdict: deliver as analysis; do not claim runtime qualification.
