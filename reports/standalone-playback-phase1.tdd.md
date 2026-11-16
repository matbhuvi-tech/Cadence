# Standalone Playback Engine — Phase 1 Verification

Scope: Phase 1 (*Engine Capability Parity*) from [STANDALONE_PLAYBACK_ENGINE.md](../docs/designs/STANDALONE_PLAYBACK_ENGINE.md).

## Implemented Capabilities & API Contract

1. **Decoupled Scanner & Curation (`src-tauri/src/scanner/`, `src-tauri/src/curation/`):**
   - Replaced Tauri `AppHandle` coupling with `EngineProgressSink` (`src-tauri/src/scanner/mod.rs`) and `PlaybackProtection` (`src-tauri/src/curation/mod.rs`).
   - Headless builds (`--no-default-features --features bundled-sqlite`) share native DSD probing (`scanner/dsd.rs`), shared PCM/DSD metadata inspection (`scanner/media.rs`), and real `lofty` tag writing (`curation/tag_writer.rs`).
2. **Protocol v2 & Headless Library Authority (`src-tauri/src/core_runtime/library.rs`, `mod.rs`):**
   - Operations: `fs.browse`, `folders.list`, `folders.add`, `folders.remove`, `folders.scan`, `folders.scan.status`, `playlists.list`, `playlists.create`, `playlists.get`, `playlists.update`, `playlists.delete`, `playlists.setTracks`, `releases.split.list`, `releases.split.toggle`, `curate.draft.list`, `curate.draft.save`, `curate.dry_run`, `curate.approve`, `curate.job.status`, and `engine.events`.
   - Enriched `CatalogTrack` projection (`composerName`, `genreTags`, `folderName`, `language`, `dynamicRange`, `hasCoverArt`, `provenanceStatus`, `lyrics`, `fingerprintStatus` with `UNSUPPORTED_DSD` for DSF/DFF/DSDIFF).
   - Bounded path authorization (`CADENCE_BROWSE_ROOTS` defaulting to `CADENCE_MUSIC_DIR`, `openat2` on Linux with `RESOLVE_NO_SYMLINKS` / `RESOLVE_BENEATH`, non-overlapping data/music root checks).
3. **Authenticated HTTPS, SSE Events & Artwork (`src-tauri/src/core_runtime/dragonfish.rs`):**
   - Real self-signed TLS via `rcgen` + `rustls` persisted as `tls-cert.pem`, `tls-key.pem`, and `tls-cert.json` (`sha256Fingerprint` computed over DER).
   - All `/v1/*` routes (`/v1/core`, `GET /v1/events`, `GET /v1/artwork/:releaseId`) require `x-cadence-token` or `Authorization: Bearer ...` header authentication (query-string tokens return `401`).
   - `/v1/artwork/:releaseId` supports `ETag` / `If-None-Match` (`304`) and serves from bounded RAM cache during active playback/cooldown, returning `503` (`deferred_until_idle`) on cache miss while protected.
4. **Real Tag Writer & Crash-Safe Journal (`src-tauri/src/curation/tag_writer.rs`, `curate.rs`):**
   - Supports `FLAC`, `WAV`, `MP3` (`MPEG`), `MP4`/`M4A`, and `AIFF` (`title`, `artist`/`artistCredit`, `album`/`albumTitle`, `albumArtist`, `composer`/`composerName`, `genre`, `originalAlbum`, `originalYear`, `lyrics`), including FLAC Vorbis `ORIGINALALBUM` and MP4 freeform `----:com.apple.iTunes:ORIGINALALBUM`/`ORIGINALYEAR`.
   - Prepares edits in RAM, verifies audio payload hashes (`payload_digest`) and container properties before atomic rename, journals original/result bytes in `remote_curate_journal` for interrupted-commit recovery, and restores the original file if SQLite projection fails.
   - Fails closed (`applyAvailable: false`) on `.dsf`/`.dff` and unsupported containers so DSD payloads remain untouched.

## Verification Evidence

| Check | Result |
| --- | --- |
| `docker build -f deploy/engine-regression/Dockerfile -t cadence-engine-regression:phase1 .` | Passed (zero warnings on `--no-default-features --features bundled-sqlite`) |
| `docker run --rm --network none --cap-add SYS_PTRACE cadence-engine-regression:phase1` (`tests/engine/run.py`) | Passed: 83 Rust headless tests across 11 suites + 14 Python HTTP/TLS/`strace` acceptance tests |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` (Windows) | Passed: 72 passed, 0 failed |
| `npm run test:core-services` | Passed: 32 passed, 0 failed |
| `npm run build` | Passed (`pwa` + `tsc -b` + `vite build`) |

## Audiophile Impact Assessment

- **Disk I/O Impact (Invariant 1):** `folders.scan`, uncached `fs.browse`, uncached `/v1/artwork/:releaseId`, `curate.dry_run`, `curate.approve`, and pending Curate job execution are gated by `ensure_storage_idle_at` (idle transport + 30-second post-stop cooldown, persisted across restarts in `engine_transport_guard`). Linux `strace` verification (`test_loading_and_full_cooldown_have_zero_library_syscalls`) observed zero library-root file syscalls during `loading` and through the 30-second cooldown while serving cached `fs.browse` and `/v1/artwork/:releaseId` from RAM.
- **Network / NIC Burst Impact (Invariant 4):** Control SSE (`/v1/events`) uses event-driven progress emissions plus a 10-second keepalive heartbeat; `catalog.page` and `session.snapshot` remain bounded by `MAX_MESSAGE_BYTES`; media delivery (`18890`) and `CorePacer` are unchanged.
- **Thread / CPU Scheduling & Memory Impact (Invariants 2 & 3):** Scanning (`library.step`) and Curate execution run one bounded step per idle dispatcher turn without spawning background polling threads or altering `LockedBytesArena` / `upnp_session.rs` pacing loops (`core_upnp_zero_alloc_test` passed).
- **Format & Container Integrity (Invariants 5 & 6):** Headless scanning uses `scanner/dsd.rs` for `.dsf`/`.dff` rates and trailing ID3v2 offsets; `tag_writer.rs` verifies exact pre/post audio payload SHA-256 digests before replacing any file and blocks `.dsf`/`.dff` writes.

## Unverified Targets (Requires User/Hardware Verification)

- Live deployment on TrueNAS SCALE Dragonfish (`192.168.1.6:4040`), physical HiFi ROSE RS130 UPnP playback, and Tier 3 hardware benchmarks were not executed in the local Docker/Windows harness.
