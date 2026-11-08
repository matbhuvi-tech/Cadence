# Maintenance Package (`src-tauri/src/maintenance`)

## Overview
Houses background catalog maintenance, acoustic fingerprinting, artist portrait synchronization, and audio file tag commit worker routines. Coordinates non-destructive library hygiene, cover art caching, and background tag writing respecting playback transport purity.

## Interface
- `CommitQueueWorker`: Dedicated background worker executing tag and embedded cover art file writes with zero-disk-I/O playback gating and 30s cooldown.
- `CommitTelemetryPayload`: Telemetry struct reporting commit queue state, progress percent, throughput, and mount offline status.
- `MaintenanceWorker`: Background worker coordinator managing work queues, portrait synchronization, rate limiting, and cancellation tokens.
- `MaintenanceStats`: Snapshot statistics reporting total fingerprints generated, pending portraits, and cached assets.
- `PortraitSyncProgressEvent`: Event payload emitted over Tauri event channel informing the UI of portrait sync progress.
- `generate_fingerprint_for_file`: Calculates Chromaprint acoustic fingerprints from raw audio file decoded PCM chunks.

## Invariants
- Background maintenance worker threads must run with `THREAD_PRIORITY_BELOW_NORMAL` and `THREAD_MODE_BACKGROUND_BEGIN`.
- `CommitQueueWorker` and `MaintenanceWorker` must immediately pause processing when `AudioEngine` is `Playing`, `Paused`, or `Loading`, and observe a 30-second post-playback cooldown before resuming disk I/O.

## Side Effects
- Writes modified ID3v2, Vorbis, and MP4 tags and embedded artwork directly to audio files on disk during commit execution.
- Spawns background OS threads performing CPU-intensive audio decoding and FFT computations.
- Writes downloaded artist portraits and cached assets to local application cache directories.

## Verification
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
