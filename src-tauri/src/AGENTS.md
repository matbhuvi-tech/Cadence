# Native Backend Core Blueprint (`src-tauri/src`)

## Overview
Rust backend source root for Cadence. Configures the Tauri application lifecycle, initializes state management (`AudioEngine`, `ScannerController`, `AppDb`, `RemoteState`, `MaintenanceWorker`), registers plugin integrations (shell, dialog, fs), and maps Tauri command routes.

## Local Interface & Invariants
- `run()`: Master startup function bootstrapping the Tauri runtime, setting up SQLite paths, spawning the remote server, and launching background workers.
- `main.rs`: Desktop process entry point calling `cadence_lib::run()`.
- Invariant: All background workers and servers must receive shared references to `AudioEngine` to coordinate playback state and respect transport silence.

## Subdirectories & System Boundaries
- [audio](./audio/AGENTS.md): WASAPI Exclusive, MMCSS Pro Audio pacing, UPnP streaming, and memory pinning.
- [commands](./commands/AGENTS.md): Tauri IPC handlers exposed to the TypeScript frontend.
- [db](./db/AGENTS.md): SQLite database connections, schema migrations, and batch operations.
- [maintenance](./maintenance/AGENTS.md): AcoustID fingerprinting and background artist portrait caching.
- [remote](./remote/AGENTS.md): Embedded HTTP/WebSocket mobile remote server and PWA assets.
- [scanner](./scanner/AGENTS.md): Filesystem library scanner and container tag parser.

## Global Invariants
- Thread isolation: The audio thread must never be blocked by database queries, scanning, or remote network activity.
- Zero disk I/O on library drives while the audio engine is playing or paused.

## System Verification
- Run: `cargo test`
