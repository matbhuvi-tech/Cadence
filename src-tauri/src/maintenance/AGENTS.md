# Maintenance Package (`src-tauri/src/maintenance`)

## Overview
Houses background catalog maintenance and enrichment routines. Runs asynchronous worker threads for acoustic fingerprint generation (Chromaprint/AcoustID), missing artist portrait synchronization, and background cover art caching.

## Interface
- `MaintenanceWorker`: Background worker coordinator managing work queues, rate limiting, and cancellation tokens.
- `MaintenanceStats`: Snapshot statistics reporting total fingerprints generated, pending portraits, and cached assets.
- `PortraitSyncProgressEvent`: Event payload emitted over Tauri event channel informing the UI of portrait sync progress.
- `generate_fingerprint_for_file`: Calculates Chromaprint acoustic fingerprints from raw audio file decoded PCM chunks.

## Invariants
- Background maintenance worker threads must run with `THREAD_PRIORITY_BELOW_NORMAL` and `THREAD_MODE_BACKGROUND_BEGIN`.
- Worker must immediately pause processing when `AudioEngine` transitions to `Playing`, `Paused`, or `Loading`.

## Side Effects
- Spawns background OS threads performing CPU-intensive audio decoding and FFT computations.
- Writes downloaded artist portraits and cached assets to local application cache directories.

## Verification
- Run: `cargo test`
