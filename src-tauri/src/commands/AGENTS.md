# Commands Package (`src-tauri/src/commands`)

## Overview
Houses Tauri IPC command handler modules exposed to the frontend TypeScript layer. Bridges web UI actions to the native audio engine, SQLite database operations, library scanner, curation engine, Gemini AI assistance, maintenance workers, and mobile remote server.

## Interface
- `audio.rs`: Handlers for playback transport (`play_track`, `pause_playback`, `resume_playback`, `stop_playback`, `seek_playback`, `set_volume`, `set_audio_device`, `get_audio_devices`, `set_purity_mode`, `get_playback_status`, `prepare_next_track`, `invalidate_next_track`, `set_settling_delay_ms`).
- `artist_portrait.rs`: Handlers for searching artist portraits via MusicBrainz and Wikidata/Wikimedia Commons archives (`search_artist_portraits`).
- `curation.rs`: Handlers for album curation snapshots, evidence runs, drafts, and traces (`curation_export_snapshot`, `curation_get_identity`, `curation_save_evidence`, `curation_list_evidence`, `curation_get_evidence`, `curation_save_draft`, `curation_get_draft`, `curation_save_trace`, `curation_get_trace`, `curation_clear_trace`).
- `gemini_config.rs`: Handlers for DPAPI secure key storage and AI musicologist queries (`get_gemini_config`, `save_gemini_api_key`, `gemini_resolve`).
- `library.rs`: Handlers for library queries, track/release/artist fetches, canonical artist editorial updates (`db_update_canonical_artist_editorial`), and commit queue inspection.
- `maintenance.rs`: Handlers for running background maintenance tasks, fetching stats, and artist portrait sync.
- `metadata_providers.rs`: Native HTTP handlers for Apple iTunes and MusicBrainz metadata searches (`search_itunes_metadata`, `search_musicbrainz_metadata`, `cancel_provider_request`) used in packaged desktop builds.
- `remote.rs`: Handlers for launching, querying, and stopping the mobile PWA remote HTTP and WebSocket server (`get_remote_server_info`, `get_remote_pairing_token`, `regenerate_remote_token`).
- `scanner.rs`: Handlers for starting directory scans, monitoring progress, and handling cancellations.

## Invariants
- Commands that perform disk I/O or SQLite batch writes must verify that playback is idle before executing.
- Errors occurring within native threads must be mapped to serializable `Result<T, String>` responses rather than panicking.

## Side Effects
- Mutates application runtime state (`AudioEngine`, SQLite connection pools, background thread handles).
- Emits Tauri event notifications to frontend listeners.

## Verification
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
