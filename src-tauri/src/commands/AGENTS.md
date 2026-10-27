# Commands Package (`src-tauri/src/commands`)

## Overview
Houses Tauri IPC command handler modules exposed to the frontend TypeScript layer. Bridges web UI actions to the native audio engine, SQLite database operations, library scanner, maintenance workers, and mobile remote server.

## Interface
- `audio.rs`: Handlers for playback transport (`start_playback`, `pause_playback`, `seek_playback`, `set_output_device`, `toggle_purity_mode`, `get_audio_devices`).
- `library.rs`: Handlers for library queries, track/release fetches, tag read/write staging, and two-phase commit execution.
- `maintenance.rs`: Handlers for running background maintenance tasks, fetching maintenance stats, and artist portrait sync.
- `remote.rs`: Handlers for launching, querying, and stopping the mobile PWA remote HTTP and WebSocket server.
- `scanner.rs`: Handlers for starting directory scans, monitoring file discovery progress, and handling cancellations.

## Invariants
- Commands that perform disk I/O or SQLite batch writes must verify that playback is idle before executing.
- Errors occurring within native threads must be mapped to serializable `Result<T, String>` responses rather than panicking.

## Side Effects
- Mutates application runtime state (`AudioEngine`, SQLite connection pools, background thread handles).
- Emits Tauri event notifications to frontend listeners.

## Verification
- Run: `cargo test`
