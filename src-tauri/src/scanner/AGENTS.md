# Scanner Package (`src-tauri/src/scanner`)

## Overview
Houses the native music library filesystem scanner and metadata extraction engine. Discovers audio files across configured library mount paths, extracts native tag headers (FLAC Vorbis comments, ID3v2, MP4/M4A atoms, DSF chunks), computes true audio bitrates, and streams discovery progress to SQLite.

## Interface
- `ScannerController`: Orchestrator managing scanner threads, pause/resume state, cancellation tokens, and batch database ingestion.
- `PlaybackScanMode`: Guard mode ensuring scanner pauses or drops I/O priority during active audio playback.
- `ScanProgressPayload` & `ScanCompletePayload`: Event structures streaming file counts, processed tracks, and errors to the UI.
- `engine.rs`: Multi-threaded directory walker and ground-truth container parser for PCM and DSD audio formats.

## Invariants
- DSF and DFF bitrates, channel counts, sample rates, and trailing metadata offsets must be resolved from native container headers rather than FFmpeg byte-clock guesses.
- Scanner must yield or pause whenever the playback engine transitions to active playback.

## Side Effects
- Recursively traverses filesystem directory trees and reads audio file headers.
- Performs batch inserts and updates into the SQLite `tracks` and `releases` tables.

## Verification
- Run: `cargo test`
