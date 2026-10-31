# Cadence Developer Guide

This document contains repository architecture and development guidance. It is for contributors; end users can install Cadence from a published Windows release without using these tools.

## System Overview

Cadence is a Windows desktop music player and catalog curation engine. It combines a Tauri v2 Rust native audio core (WASAPI Exclusive, memory-pinned buffers via `VirtualLock`, MMCSS Pro Audio pacing, and UPnP streaming) with a React/TypeScript user interface for catalog navigation, diagnostics, and two-phase metadata commits.

## Repository Entry Points

- `package.json`: NPM dependencies and scripts (`dev`, `build`, `lint`, `test:*`).
- `vite.config.ts`: React plugin, Tailwind CSS v4, path aliases, and development proxy settings.
- `index.html`: Web application entry point.
- `src/AGENTS.md`: Frontend components, contexts, domain core, hooks, services, onboarding, and contracts.
- `src-tauri/AGENTS.md`: Native Rust backend, including the audio engine, SQLite database, scanner, maintenance workers, and remote PWA server.

## Build Invariants

- Frontend builds must validate TypeScript cleanly with `tsc -b`.
- Preserve the global audio, storage, network, parsing, and metadata safety invariants below when changing behavior.

## Global Invariants

1. **Storage bus silence during playback:** No disk I/O occurs on music-library storage while playback is active or within a 30-second cooldown period.
2. **Audio thread isolation:** Synchronous audio and pacing loops use MMCSS `Pro Audio` priority and CPU affinity isolated away from Core 0 and Core 1.
3. **Memory-pinned buffers:** Active audio streams are preloaded into RAM and pinned with Win32 `VirtualLock`, with zero heap allocation in playback loops.
4. **Network PHY quietness:** UPnP and WebSocket communication use event-driven updates, clamped socket buffers, and heartbeats of at least five seconds.
5. **Bit-perfect signal integrity:** In Purity Mode, audio bypasses OS mixing, resampling, and software digital attenuation.
6. **Ground-truth container parsing:** DSD (`.dsf`/`.dff`) and PCM sample rates and bit depths come directly from native container headers.
7. **Two-phase commit safety:** Destructive tag and metadata writes are staged as dry-run diffs for explicit user approval before disk writes.

## Global Side Effects

- Manages a local SQLite database at `%APPDATA%/cadence.db`.
- Modifies audio-file metadata tags (ID3v2, FLAC Vorbis, MP4 atoms) only through user-confirmed two-phase commit execution.
- Binds local TCP ports for mobile remote control and UPnP streaming.

## Verification

- Frontend: `npm run build`
- Native backend: `cargo test --manifest-path src-tauri/Cargo.toml`
