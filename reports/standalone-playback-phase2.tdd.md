# Standalone Playback Engine — Phase 2 Technical Design & Verification Report

## Scope Implemented (Engine-Required, Zero-DB Thin Frontend)
- **Zero-DB Thin Desktop Shell (`src-tauri`):**
  - Stripped local SQLite (`AppDb::new`), `ScannerController`, `MaintenanceWorker`, `CommitQueueWorker`, `RemoteState`, and local `AudioEngine` initialization from desktop `run()` in [lib.rs](file:///e:/Mathan/Code/Music%20Agent/src-tauri/src/lib.rs) and [mod.rs](file:///e:/Mathan/Code/Music%20Agent/src-tauri/src/commands/mod.rs).
  - Added TLS SHA-256 certificate pinning (`PinnedServerCertVerifier` via `rustls` `ring`) and authenticated Core IPC helpers (`core_probe_endpoint`, `core_control_request`, `core_fetch_artwork`, `core_connect_events`, `core_disconnect_events`, `discover_core_nodes`) in [remote.rs](file:///e:/Mathan/Code/Music%20Agent/src-tauri/src/commands/remote.rs).
  - Fixed Windows non-`openat2` directory opening inside [library.rs](file:///e:/Mathan/Code/Music%20Agent/src-tauri/src/core_runtime/library.rs) (`open_authorized`) by validating relative components beneath the deepest matching root and using `FILE_FLAG_BACKUP_SEMANTICS` for Windows directories.
- **Core Protocol v2 Client, Artwork Cache & In-Memory Projection (`src/` + `pwa/`):**
  - Added `CORE_PROTOCOL_VERSION_V2 = 2`, `parseCoreV2Descriptor`, v2 `CoreCatalogTrack` optional fields, v2 error codes, and typed v2 operation interfaces in [coreProtocol.ts](file:///e:/Mathan/Code/Music%20Agent/src/core/coreProtocol.ts).
  - Added [engineClient.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/engineClient.ts) (`createEngineClient` for `fs.browse`, `folders.*`, `playlists.*`, `releases.split.*`, `curate.*`, `engine.events`, `catalog.page`; `EngineArtworkCache` bounded to `<= 2` concurrent requests and 256 LRU ObjectURLs without caching `503 deferred_until_idle`).
  - Added pure in-memory artist & playlist helpers in [libraryProjection.ts](file:///e:/Mathan/Code/Music%20Agent/src/core/libraryProjection.ts), shared Engine playlist adapter in [enginePlaylistService.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/enginePlaylistService.ts), and Curate Core bridge in [engineCurateBridge.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/engineCurateBridge.ts).
  - Updated [EngineControllerContext.tsx](file:///e:/Mathan/Code/Music%20Agent/src/context/EngineControllerContext.tsx), [coreControllerTransport.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/coreControllerTransport.ts), [tauriBridge.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/tauriBridge.ts), [AudioPlayerContext.tsx](file:///e:/Mathan/Code/Music%20Agent/src/context/AudioPlayerContext.tsx), and [coreRemoteClient.ts](file:///e:/Mathan/Code/Music%20Agent/pwa/src/services/coreRemoteClient.ts) (sending single `x-cadence-token` auth header compatible with Dragonfish).
- **Zero-DB Frontend UI (`src/components/` & `src/App.tsx`):**
  - Added [EngineConnectionGate.tsx](file:///e:/Mathan/Code/Music%20Agent/src/components/Engine/EngineConnectionGate.tsx), [EngineFolderBrowser.tsx](file:///e:/Mathan/Code/Music%20Agent/src/components/Engine/EngineFolderBrowser.tsx), and [EngineArtworkImg.tsx](file:///e:/Mathan/Code/Music%20Agent/src/components/common/EngineArtworkImg.tsx).
  - Migrated Library Browse, Storage Manager, Import Library, Playlists, Queue/Right Sidebar, Now Playing Bar, Sanctuary Lounge, and Curate workflows away from local SQLite / `This PC` fallback, and guarded stripped local-engine Tauri IPC helpers via `tauriBridge.hasLocalEngine() === false`.

## Audiophile Impact & Validation Summary
- **Tier 1 & Tier 2 Validation:**
  - Zero local `cadence.db`, local audio playback polling, or background maintenance workers run in the desktop frontend.
  - Core `/v1/artwork/` fetches cap concurrency at `2`, honor `ETag` `304`, and do not cache `503 deferred_until_idle` during active playback/30s cooldown.
  - Circular dependency check (`npm run test:startup` Test 7) passed with zero circular dependencies in `src/`.

## Verification Results Observed After Final Code Edits
- **Headless Chrome CDP E2E Gate (`npm run test:core-e2e -- --skip-build`):** `16 / 16` scenarios `PASS`, `0` Desktop console errors, `0` PWA console errors (including `S1` `EngineConnectionGate` with no `Use This PC`, `S2` Core connection & 227-track / 6-album load, `S10` `fs.browse` + `folders.add` + `/v1/artwork/rel_goldberg` `200` + `blob:` cover art rendering in DOM + `curate.draft.save` + `curate.dry_run` read-only guard, `BUG-A`, `S3`, `BUG-C`, `S5`, `S11`, `PWA-CORS`, `PWA-PAIR`, `S9`, `ISSUE-40`, `S8`, `S6`, `S7`, `S12` Core restart & `503` paused artwork deferral).
- **Rust Library Tests (`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`):** `73 passed; 0 failed`.
- **Headless Compilation (`cargo check --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite`):** exited `0`.
- **Lint (`npm run lint`):** `0 errors` (`1718` warnings).
- **Frontend & PWA Build (`npm run build`):** exited `0` (`pwa` + `tsc -b` + `vite build`).
- **Node Unit & Integration Tests:**
  - `npm run test:core-services`: `32 / 32` passed.
  - `npm run test:engine-session`: `17 / 17` passed.
  - `npm run test:core-session-protocol`: `2 / 2` passed.
  - `node --import tsx --test src/test/testCoreControllerUx.ts src/test/testRemoteCurate.ts src/test/testPwaCoreController.ts src/test/testStandalonePhase2.ts`: `27 / 27` passed (including 5 new Phase 2 tests in [testStandalonePhase2.ts](file:///e:/Mathan/Code/Music%20Agent/src/test/testStandalonePhase2.ts)).
  - `npm run test:startup`: `4 / 7` passed (Tests 1, 6, 7 passed; Tests 3–5 fail under Node `tsx` because Node lacks a `.css` loader for `CadenceArtworkFallback.css`).
- **Tauri Release + NSIS Installer (`npm run tauri:build -- --bundles nsis`):** exited `0`, built `src-tauri/target/release/cadence-core.exe` and `src-tauri/target/release/bundle/nsis/Cadence Core_0.1.0-2_x64-setup.exe`.

## Unverified Against Live Physical Hardware
- Connecting over HTTPS with live mDNS / TLS fingerprint pinning from the installed Windows Tauri binary to a live remote TrueNAS / Dragonfish Core node (`192.168.1.6:4040`) and physical HiFi ROSE RS130 renderer was **not** executed in this sandboxed verification pass and remains to be verified by the user.
