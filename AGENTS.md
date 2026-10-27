# Cadence Repository Blueprint

## System Overview
Cadence is an uncompromising, bit-perfect audiophile music player and catalog curation engine for Windows Desktop. It combines a high-performance Tauri v2 Rust native audio core (WASAPI Exclusive, memory-pinned buffers via `VirtualLock`, MMCSS Pro Audio pacing, UPnP streaming) with a modern React/TypeScript user interface featuring multi-view catalog navigation, AI-assisted diagnostics, and an atomic two-phase commit architecture for tag management.

## Local Interface & Invariants
- `package.json`: NPM package manifest configuring dependencies, scripts (`dev`, `build`, `lint`, `test:*`), and build tools.
- `vite.config.ts`: Vite bundler configuration setting up React plugin, Tailwind CSS v4, path aliases, and development proxy settings.
- `index.html`: Web application HTML entry point mounting the root viewport.
- Invariant: Build scripts must validate TypeScript compilation cleanly without type errors (`tsc -b`).

## Subdirectories & System Boundaries
- [src](./src/AGENTS.md): Frontend React application layer (Components, Contexts, Domain Core, Hooks, Services, Onboarding, and Contracts).
- [src-tauri](./src-tauri/AGENTS.md): Native Rust backend layer (WASAPI Audio Engine, SQLite DB, Scanner, Maintenance Workers, and Remote PWA Server).

## Global Invariants
1. **Storage Bus Silence During Playback**: Zero disk I/O occurs on music library storage while audio playback is active or within a 30-second cooldown period.
2. **Audio Thread Isolation**: Synchronous audio and pacing loops run with MMCSS `"Pro Audio"` priority and isolated CPU core affinity away from Core 0 and Core 1.
3. **Memory Pinned Buffers**: Active audio streams are pre-loaded into RAM and pinned via Win32 `VirtualLock` with zero heap allocation during playback loops.
4. **Network PHY Quietness**: UPnP and WebSocket communication use event-driven updates, clamped socket buffers, and >=5s slow heartbeats to minimize electrical noise.
5. **Bit-Perfect Signal Integrity**: Audio payloads bypass OS mixers, resampling, and software digital attenuation when Purity Mode is active.
6. **Ground-Truth Container Parsing**: DSD (`.dsf`/`.dff`) and PCM sample rates and bit depths are derived directly from native container headers.
7. **Two-Phase Commit Safety**: Destructive tag and metadata writes must stage changes as dry-run diffs for explicit user approval before disk writes.

## Global Side Effects
- Manages local SQLite database at `%APPDATA%/cadence.db`.
- Modifies audio file metadata tags (ID3v2, FLAC Vorbis, MP4 atoms) upon user-confirmed two-phase commit execution.
- Binds local network TCP ports for mobile remote control and UPnP streaming.

## System Verification
- Frontend: `npm run build`
- Native Backend: `cargo test --manifest-path src-tauri/Cargo.toml`
