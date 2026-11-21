# Cadence Developer Guide

This document contains repository architecture and development guidance. It is for contributors; end users can install Cadence from a published Windows release without using these tools.

## System Overview

Cadence is a Windows desktop music player and catalog curation engine. It combines a Tauri v2 Rust native audio core (WASAPI Exclusive, memory-pinned buffers via `VirtualLock`, MMCSS Pro Audio pacing, and UPnP streaming) with a React/TypeScript user interface for catalog navigation, diagnostics, and two-phase metadata commits, plus a companion mobile remote PWA.

## Repository Entry Points

- `package.json`: NPM dependencies and scripts (`dev`, `build`, `lint`, `test:*`).
- `vite.config.ts`: React plugin, Tailwind CSS v4, path aliases, and development proxy settings.
- `index.html`: Web application entry point.
- `src/AGENTS.md`: Frontend components, contexts, domain core, hooks, services, onboarding, and contracts.
- `src-tauri/AGENTS.md`: Native Rust backend, including the audio engine, SQLite database, scanner, curation storage, maintenance workers, and remote server.
- `pwa/AGENTS.md`: Mobile Remote Progressive Web App (React 19 / Vite / Tailwind) served to local Wi-Fi handsets.
- `website/`: VitePress GitHub Pages documentation site (`npm --prefix website run dev` / `npm --prefix website run build`).

## Build Invariants

- Frontend builds must validate TypeScript cleanly with `tsc -b`.
- Preserve the global audio, storage, network, parsing, and metadata safety invariants below when changing behavior.

## Global Invariants

1. **Storage bus silence during playback:** Do not start music-library file writes while playback is active or paused. The native commit queue can accept intent in the local database during playback and resumes file writes when playback stops. Other subsystems may still have legacy cooldown gates until their playback policy is migrated.
2. **Audio thread isolation:** Synchronous audio and pacing loops use MMCSS `Pro Audio` priority and CPU affinity isolated away from Core 0 and Core 1.
3. **Memory-pinned buffers:** Active audio streams are preloaded into RAM and pinned with Win32 `VirtualLock`, with zero heap allocation in playback loops.
4. **Network PHY quietness:** UPnP and WebSocket communication use event-driven updates, clamped socket buffers, and heartbeats of at least five seconds.
5. **Bit-perfect signal integrity:** In Purity Mode, audio bypasses OS mixing, resampling, and software digital attenuation.
6. **Ground-truth container parsing:** DSD (`.dsf`/`.dff`) and PCM sample rates and bit depths come directly from native container headers.
7. **Two-phase commit safety:** Destructive tag and metadata writes are staged as dry-run diffs for explicit user approval before disk writes.

## Global Side Effects

- Playback Engines manage local SQLite databases at `%LOCALAPPDATA%\CadenceEngine\cadence.db` (Windows Playback Engine, shared by both Tray and installer-configured Windows Service modes, auto-migrating legacy `%APPDATA%\cadence.db` on first run) or `/var/lib/cadence/cadence.db` (Linux/TrueNAS, or `--data-dir`/`CADENCE_DATA_DIR`), including `compilation_provenance_cache` (parameter-hashed compilation soundtrack resolutions).
- Modifies audio-file metadata tags (ID3v2 `TOAL`/`TORY`, FLAC Vorbis `ORIGINALALBUM`/`ORIGINALYEAR`, MP4 atoms) only through user-confirmed two-phase commit execution.
- Binds local TCP ports for mobile remote control and UPnP streaming.

## Subsystems

### Optional Core service foundation

- `src/core/engineSession.ts` defines the pure selection policy; `coreProtocol.ts`
  defines version 1 requests, bounded path-free projections and runtime validation.
- `src/services/engineService.ts` provides local in-process and remote authenticated-
  channel adapters. `engineServiceController.ts` stages one catalog/queue/output view
  and rejects stale activation/refresh responses. Neither module is wired to startup.
- `src-tauri/src/core_session/` implements the native v1 session and queue authority
  (`SessionOwner<R: Renderer>`). `src-tauri/src/core_runtime/` and
  `src-tauri/src/bin/cadence_headless.rs` provide the Tauri-independent headless
  executable, SQLite WAL catalog projection, 30-second post-playback cooldown guard,
  TrueNAS/Linux cgroup v2 + `CAP_IPC_LOCK` + `RLIMIT_MEMLOCK` strict locked-RAM
  admission (`LockedBytesArena`), and the Phase 5 paced UPnP HTTP media server and
  RS130 session coordinator (`upnp_session.rs`).
- Plan and phase evidence: `docs/designs/OPTIONAL_LINUX_CORE.md`.

### Curation Workbench & Decision Trace Engine
- Unifies defect triage queues, automated federated candidate resolution (MusicBrainz, Apple Music, Gemini AI), artwork inspection, and inline sidecar review in `UnifiedCurateCockpit.tsx`.
- Playback-guarded decision traces buffer in RAM (`MEMORY_BUFFER`) while audio plays, flushing to SQLite only when transport is idle.
- Multi-Soundtrack Compilation Clusters (`isCaseB`) isolate film/album provenance while reconciling shared attributes across candidate records.

### Compilation Soundtrack Provenance Engine
- Automatically identifies original film/motion picture score and release year for tracks on multi-source compilation albums via single-pass Gemini inference (`src/services/geminiClient.ts`).
- Results are cached in SQLite via `provenanceCacheService.ts`, keyed by SHA-256 parameter hash computed over normalized album title, artist, composer, and track signatures (`cleanConsensusTitle`).
- Provenance tags (`ORIGINALALBUM`, `ORIGINALYEAR`) are staged in memory sidecars via `UnifiedCurateCockpit.tsx` and serialized into `payloadJson` via `transactionEngine.ts`.
- Gated strictly by Invariant 1 (Storage bus silence) and Invariant 4 (Network quietness): all inference calls are deferred if audio playback transport is active or within cooldown.

## Verification

- Frontend: `npm run build`
- Optional Core contracts/adapters: `npm run test:core-services`
- Native backend: `cargo test --manifest-path src-tauri/Cargo.toml`
- Windows Desktop installer: `npm run tauri:build -- --bundles nsis`
- Windows Playback Engine binary (`src-tauri/target/release/cadence-engine.exe`): `cargo build --manifest-path src-tauri/Cargo.toml --release --no-default-features --features engine-audio --bin cadence-engine`
- Windows Playback Engine NSIS installer (`src-tauri/target/release/bundle/nsis/cadence-engine-setup.exe`): `.\deploy\windows-engine\build-windows-engine.ps1 -RequireInstaller` (pass `-SkipCargoBuild` if `cadence-engine.exe` is already built; optional `-Version <semver>`)
- Windows Unified Suite NSIS installer (`src-tauri/target/release/bundle/nsis/Cadence_<ver>_x64-setup.exe`, wrapping Desktop + Local Playback Engine): `.\deploy\windows-suite\build-windows-suite.ps1 -RequireInstaller` (after building both sub-installers)
- Documentation website (GitHub Pages preview / static build): `npm --prefix website run dev` / `npm --prefix website run build`
