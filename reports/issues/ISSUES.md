# Issue Log

## Support & Self-Diagnostics UX Redesign (`feat/support-troubleshooting-ux-redesign`)

- **Reported behavior:** Support & Self-Diagnostics exposed developer jargon (`Webhook Ready`, `Redact OS username`, `Zero-allocation lock-free ring buffer`), presented all three stages simultaneously without visual hierarchy, ignored `doctorReports` / detailed `databaseLineage` metrics in the UI, returned a misleading `NO_OBVIOUS_LOCAL_FAULT` for runtime audio issues, and only allowed fixed dropdown selection.
- **Changes:**
  1. `src-tauri/src/support_bundle.rs`: Rewrote all 16 scenario labels/descriptions into listener-friendly language, added `resolve_scenario_from_input()` keyword matching for custom typed problem descriptions while preserving the user's exact text as `scenario_label`, added `CAPTURE_RECOMMENDED_FOR_ISSUE` hint for runtime capture scenarios, and updated `AUDIO_HYGIENE_GUARD_ACTIVE` copy.
  2. `src/components/CommandBar/DebugDiagnosticsPanel.tsx` & `src/components/Modals/CadenceSettingsModal.tsx`: Redesigned into a progressive 3-stage **Help & Troubleshooting** flow (`01 · Identify the problem` with hybrid Type-or-Select input + Guided Playback Capture, `02 · Diagnostic results` with 5-state System Health Checklist including explicit `Not checked` when unreachable + visual Library Consistency cards, `03 · Still need help? Contact Cadence Support` with redacted preview & consent gating) and moved ring-buffer/webhook controls into **Advanced Diagnostics**.
  3. `pwa/src/components/Connection/DiagnosticsSheet.tsx` & `pwa/src/services/mobileDiagnostics.ts`: Added Type-or-Select custom problem input and plain-language copy parity on Mobile Remote.
- **Status:** Implemented on `feat/support-troubleshooting-ux-redesign`; awaiting user verification.

## GitHub #62 — Mobile playback and queue feedback

- **Issue** [Mobile Remote reports misleading output, connection, and queue errors during playback](https://github.com/matbhuvi-tech/Cadence/issues/62)
- **Branch** `fix/62-mobile-remote-playback-feedback`
- **Output** Core engines without the output-list operation can reject it with `invalid_payload`. The remote keeps the confirmed output visible in read-only mode. Malformed replies still produce a refresh prompt.
- **Track transitions** The remote keeps the previous snapshot through one failed background refresh. A second consecutive failure surfaces reconnect. During engine-reported loading, the queue and mini-player show that the track is starting.
- **Rapid selections** The remote sends one queue jump at a time, skips superseded taps, and retries the latest tap once after a conflict if that queue entry still exists. An entry removed by another controller produces a track-specific message.
- **Verification** Five regressions failed on the original implementation. The targeted Vitest run passed 22 tests after the fix, including the removed-entry case. The existing Playwright suite passed three scenarios, including read-only output and confirmed queue selection at a mobile viewport. Targeted line coverage for the full hook and client was 43.73%. Physical Android and ROSE playback are pending user verification.

## GitHub #58 — Release Rust tests cannot compile the UPnP capture stop test

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/58
- **Branch:** `fix/58-upnp-capture-stop-api`
- **Reported behavior:** The headless release test gate fails with E0599 because `tests/upnp_delivery.rs` calls `DeliveryHistory::stop`.
- **Fix:** Restore `stop` as a wrapper around `stop_at` with the current time. The inspector still uses one timestamp for both freezing and reading its final capture.

## GitHub #54 — Core Engine mode: missing Left Rail artwork dock, Sanctuary Now Playing state, Queue badge count, and Up Next thumbnails

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/54
- **Branch:** `fix/54-core-now-playing-queue-ui`
- **Reported behavior:**
  1. Left Rail artwork dock above the playback controls does not appear during Core Playback Engine playback.
  2. Dedicated Now Playing screen (`SanctuaryListeningLounge`) displays `"No Track Selected"`, `"Unknown Artist"`, `00:00`, and `"Lossless · Output Unavailable"`.
  3. Bottom `NowPlayingBar` Queue button is missing the green upcoming count badge even when tracks are queued.
  4. Right sidebar "UP NEXT" queue rows render broken image icons instead of album cover thumbnails.
- **Root causes:**
  1. `LeftRailArtworkCard`, `SanctuaryListeningLounge`, and the `NowPlayingBar` Queue badge read local-only `AudioPlayerContext` state instead of `EngineControllerContext` (`useEffectiveQueueControl` / `useOptionalEngineController`).
  2. `LeftRailArtworkCard`, `SanctuaryListeningLounge`, and `UnifiedRightSidebar` Up Next rows passed raw `cadence-art://` URLs directly to `<img>` instead of resolving them via `useResolvedMediaUrl` / `EngineArtworkImg`.
- **Fix:**
  1. Wired `LeftRailArtworkCard` (`src/components/LeftRail/LeftRail.tsx`) to `useEffectiveQueueControl()` and `useResolvedMediaUrl()` / `extractEngineArtworkReleaseId()` so the bottom-left artwork dock renders and resolves Core Engine cover art.
  2. Wired `SanctuaryListeningLounge` (`src/components/AudioPlayer/SanctuaryListeningLounge.tsx`) to `useEffectiveQueueControl()`, `useOptionalEngineController()`, `CoreSanctuaryScrubber` (`useCorePlaybackClock`), and `useResolvedMediaUrl()`, displaying Core track/release metadata, connected output status, live elapsed time, and working transport controls.
  3. Updated `NowPlayingBar` (`src/components/AudioPlayer/NowPlayingBar.tsx`) to derive the Queue button badge count and tooltip from `engine.coreUpcomingEntries.length` when `isCoreActive` is true.
  4. Updated `UnifiedRightSidebar` (`src/components/RightPanel/UnifiedRightSidebar.tsx`) Up Next rows to render `<EngineArtworkImg>` (with pending-play cached fallback) instead of raw `<img>` tags.
- **Status:** Implemented on `fix/54-core-now-playing-queue-ui`; unit tests and `npm run build` passed; pending user verification.

## GitHub #50 — Advertise human-readable build identity and prevent silent v2-to-v1 compatibility downgrade

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/50
- **Branch:** `fix/50-build-identity-and-v2-compat`
- **Reported behavior:** Running a newer `cadence-engine` (`8dfc87c`) alongside an older installed `Cadence Core` (`66aace7`) caused all album cover art to disappear in the UI with no error or version mismatch warning, while `/healthz` continued reporting static `"0.1.0"` cached in `node-identity.json`.
- **Root causes:**
  1. `parseCoreCatalogPage()` rejected all 2,787 Protocol v2 tracks containing the newly added `folderPath` / `fileName` keys, and `hydrateCatalogTracks()` silently caught the validation failure and downgraded to Protocol v1 (which omits `hasCoverArt`).
  2. Neither `cadence-engine` / `cadence-headless` nor `Cadence Core` embedded or advertised a live human-readable build identity (`v0.1.0-rc.2 +38 · Nov 20`) or protocol revision, and `PlaybackEnginePanel` / `EngineConnectionGate` had no version comparison or mismatch banner.
- **Fix:**
  1. Embedded compile-time human-readable build identity (`tag +commits · Mon D` + cleaned commit summary) and `CORE_PROTOCOL_V2_REVISION` in both Rust (`build.rs`, `build_info.rs`) and Vite (`vite.config.ts`, `src/core/buildInfo.ts`), advertised from live `/healthz`, `/readyz`, v2 `core.hello`, and mDNS TXT.
  2. Added forward-compatible Protocol v2 descriptor/catalog validation (`parseCoreV2Descriptor`, `parseCoreV2CatalogPage`) that strips/ignores unknown additive fields while preserving strict Protocol v1 contracts and security-forbidden key rejection (`filePath`, `sql`, `password`, `token`).
  3. Replaced silent v2-to-v1 downgrades with `evaluateEngineCompatibility()` surfacing non-blocking compatibility warnings in `App.tsx`, `PlaybackEnginePanel.tsx`, and `EngineConnectionGate.tsx` alongside Core vs Engine build labels.

## GitHub #49 — Commit Album fails with Access Denied on Windows/SMB and disconnects Windows & Linux Playback Engines

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/49
- **Branch:** `feat/automated-metadata-enrichment`
- **Reported behavior:** Clicking **Commit Album** on SMB-backed WAV tracks left the Windows Playback Engine disconnected in the UI and failed to write tags (same control-loop blocking and permission behavior affects writable Linux Playback Engines over CIFS/NFS).
- **Root causes:**
  1. `curate.rs` kept `target.source` / `_parent` handles open across `atomic_replace()` (`fs::rename`), triggering Windows/SMB `Access is denied (os error 5)`, and required strict permission cloning on remote filesystems.
  2. `dragonfish.rs` executed `execute_pending_curate_jobs_at()` synchronously inside the single-threaded HTTP control dispatcher under `runtime.lock()` while inserting 2× full-track BLOBs per file into `remote_curate_journal`, starving localhost HTTPS requests past `remote.rs`'s 15s timeout and leaving ~590 MB of orphaned BLOBs when `atomic_replace()` failed.
  3. Even with `CurateJobWorker` backgrounded, `curate.dry_run` and `curate.approve` still ran synchronously inside `run_control_listener_loop` under `runtime.lock()`, and each operation read the full audio file over Wi-Fi SMB twice while `CurateJobWorker` concurrently began writing earlier tracks — blocking TLS/HTTPS control requests (`session.snapshot` / `/healthz`) past `remote.rs`'s 4s connect timeout mid-album and disconnecting the Engine.
- **Fix:**
  1. Dropped open file/dir handles before `atomic_replace()`, made SMB/CIFS/NFS permission copy best-effort, and added bounded Windows rename retries.
  2. Replaced 2× full-file SQLite BLOB journaling with lightweight `result_file_sha256` crash-recovery tracking plus automatic pruning/WAL checkpoint of orphaned `remote_curate_journal` rows.
  3. Extracted idle/cooldown-gated `CurateJobWorker` (`cadence-curate-writer`) and non-blocking `cadence-curate-prep` (`curate.dry_run` / `curate.approve`) background workers off `run_control_listener_loop` for both Windows (`WindowsEngineNode`) and Linux (`DragonfishNode`) engines so `/v1/core`, `/healthz`, `/v1/events`, and playback controls remain responsive (`curate.*` HTTP timeout raised to 90s; live `Queuing X/Y…` progress added in Desktop Curate).
  4. Added verified `(size, mtime_ns)` dry-run stat caching on `remote_curate_drafts` (`>= 1 MiB`) so `approve_draft` skips redundant second SMB full-file reads, plus a 1.5s `CuratePrepGuard` settle yield so `CurateJobWorker` waits until multi-track queuing finishes before starting SMB writes.

## GitHub #48 — Album Art Pipeline: Import competence, playback browse throttling, 100K+ scale, PWA parity, and auto-migration

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/48
- **Branch:** `fix/48-album-art-pipeline`
- **Reported behavior:**
  1. Album art differs between installed Windows app and `npm run tauri:dev`.
  2. Many albums fail to display cover art after import/scan.
  3. Migration from V1 Desktop DB (`%APPDATA%`) to V2 External Playback Engine (`%LOCALAPPDATA%\CadenceEngine`) loses cover art or requires manual CLI flags.
  4. Users browsing their collection (genres, composers, albums) while music is playing hit `503 deferred_until_idle` blank covers that never retry, while Mobile Remote PWA shows a flat text track list without album art in Core mode.
- **Root causes:**
  1. `core_runtime/library.rs` only matches 5 lowercase filenames (`cover.jpg`, `cover.png`, `folder.jpg`, `folder.png`, `front.jpg`), ignores `PictureType::CoverFront`, caps source images at 4 MB, and re-encodes artwork on every track of an album.
  2. `enriched_tracks()` derives `hasCoverArt` only from `tracks.has_embedded_art` instead of `engine_artwork` presence.
  3. `Library::artwork()` blocks read-only SQLite `engine_artwork` lookups during playback/cooldown on RAM cache misses, wipes the entire 32 MB cache on overflow or revision change, and `EngineArtworkImg.tsx` never retries after `503`.
  4. `self.pending` uses breadth-first traversal with a 100,000 hard limit, and `EngineArtworkImg` lacks viewport `IntersectionObserver` lazy loading.
  5. Mobile PWA uses legacy `/api/remote/library/artwork/{id}?token=...` and flat track rows in Core mode, while `dragonfish.rs` `/v1/artwork/{id}` does not strip query strings or resolve track IDs.
  6. `WindowsEngineNode::bootstrap()` does not auto-run `migrate_legacy_desktop_db()` when `cadence.db` is absent/empty, and `migration.rs` drops `releases.front_cover_url` and `backdrop_url`.

## GitHub #47 — Windows Desktop intermittently misses Playback Engine at startup

- Reported behavior. Cadence Desktop and the Windows Playback Engine require repeated restarts before connecting. Expected behavior is for Desktop to connect to the previously paired engine once it is ready, regardless of launch order.
- Source findings. Desktop tries saved profiles once, then lists discovery results. The engine publishes localhost pairing metadata after TCP bind and before its HTTPS control loop starts. LAN discovery can retain the LAN URL for a same-machine engine, and the startup gate's discovered-engine selection drops the available certificate fingerprint and pairing token.
- Live observation. The already-running installed engine responded to loopback `/healthz` with an engine ID matching the local pairing file. The failing startup sequence was not reproduced. No processes were restarted.
- Fix. Saved, fingerprint-pinned loopback profiles receive up to four HTTPS readiness probes. Discovery verifies localhost over HTTPS before adding the endpoint. Desktop offers Retry, Switch Engine, and Connection Details, and removes the persistent catalog banner.
- Startup splash. Keep the existing logo and floating embers visible while connecting, display the engine and attempt number below the logo, and share the initial connection promise across Strict Mode effect replays.

## GitHub #29 — Windows RS130 DSD256 stuttering over Wi-Fi

- Branch: `fix/29-windows-rs130-pacing`. Windows now selects a built-in RS130 profile from the renderer description. It caps RS130 pre-roll at 512 KiB, targets a 1.2-second initial lead and cruises at 1.000×. Set `CADENCE_UPNP_PACING=generic` before launching the engine to compare with the prior policy on the same network. Profile selection requires no JSON file.
- Regression evidence. The profile-selection test failed to compile before the helper existed (`7f4e928)), then all 14 UPnP tests and all 75 optimized Windows engine library tests passed with the implementation (`3aac430`). The Windows Engine NSIS installer built successfully. Coverage percentage was not measured.
- Hardware evidence. The existing QA client reached the installed engine and found a paused session. The queue and process were preserved. Physical Wi-Fi DSD256 and PCM listening, track transitions, and resource and network measurements remain pending. The QA client verifies playback start but cannot detect audible stutter.
- Follow-up Wi-Fi test failed audibly. A filtered Windows-side TCP capture from the installed candidate recorded 43.28 seconds of media and 1.832 MB/s of ACK advancement against the 2.822 MB/s stereo DSD256 payload rate. The repeated 1448/1448/1200-byte TCP payload pattern corresponds to 4 KiB writes. The largest sender gaps occurred with roughly 34–37 KB outstanding and the peer's raw advertised window near its observed maximum. The capture showed 157 flagged retransmissions, no zero-window advertisements, and an ACK RTT p95 of 45.6 ms. The trace started mid-connection, so absolute window scaling is unknown. This establishes a sustained delivery deficit and supports testing the small in-flight data limit under Wi-Fi ACK delays. Chunk size has not been isolated. The original session was returned to pause after capture.
- History comparison. Commit `2ad1b13` already used 4 KiB DSD256 writes and a 32 KiB steady send buffer, with a documented 60-second RS130 Wi-Fi run and zero write or scheduling stalls. It used 1 MiB pre-roll, 1.18× fill and 1.08–1.12× adaptive overfeed. Commit `3aac430` changed the RS130 pre-roll and pacing policy while retaining the Windows chunk size and socket configuration. Linux Core also selects 4 KiB for DSD256 but uses its own socket accounting, timing and TCP feedback. The existing generic switch is the first comparison to run on the current binary. It isolates the profile collectively, including its startup changes, from the engine and chunk size.
- Rollback. The Windows UPnP pacer from `2ad1b13` is the baseline previously tested over Wi-Fi. Reverted the experimental 1× RS130 profile and its selection test, restoring the pre-experiment engine source at `de2e328` including locked-track admission. All 74 optimized Windows engine library tests passed and the NSIS engine installer built. The installed engine still has a paused session, so installation and a fresh RS130 Wi-Fi listening test are pending.
- Resolution & 9-Capture Experiment (`feat/dsd-wifi-sndbuf-headroom`, documented in [WINDOWS_UPNP_PACER_WIFI_DSD256_EXPERIMENT.md](../../docs/designs/WINDOWS_UPNP_PACER_WIFI_DSD256_EXPERIMENT.md)):
  1. Raised `MAX_SOCKET_SNDBUF_BYTES` to `512 KB` (`288–304 KB` steady `SO_SNDBUF` for DSD256 while keeping Redbook CD at `32 KB`) and restored `16 KB` chunk framing (`calculate_pacing_chunk_bytes`) in `src-tauri/src/audio/stream_tuning.rs`, while capping `low_wnd_floor` (`<= 64 KB`) and `sndbuf_margin` (`<= 32 KB`) in `src-tauri/src/audio/upnp_pacer.rs`.
  2. Fixed multi-strike soft-ceiling lockout in `src-tauri/src/audio/upnp_pacer.rs` (`rwin_reopened_since_strike` gating so a single 6-second full-buffer RWIN episode counts as 1 strike rather than 5 cascading strikes that crush `soft_ceiling_mult` to `1.010×` for 11 minutes) and unlocked immediate `1.08×–1.12×` refill whenever a Wi-Fi stall (`LinkCongestion` / `AmbiguousWriteStall`) or `> 400 ms` cushion drop from `peak_lead_ms` (`>= 500 ms`) occurs with an open receiver window (`snd_wnd > 128 KB`).
  3. Wired Windows `%LOCALAPPDATA%\CadenceEngine\renderer-profiles.json` startup loading (`UpnpManager::load_windows_renderer_profiles`) and cross-process `/v1/core` `player.upnp_pacer` toggle (`windows_engine.rs`, `commands/audio.rs`, `CadenceSettingsModal.tsx`), and verified in `try8.pcapng` (`209.5s`, `653.0 MB` `12.288 MHz` DSD256 to `FIN`) with `+2,155 .. +2,793 ms` sustained RS130 cushion, `0` TCP Zero-Windows, and `0` audible stutters.

## GitHub #42: Linux Core DSD256 stuttering caused by `tcpi_rcv_space` substituted for `tcpi_snd_wnd` in `CorePacer`

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/42
- **Branch:** `fix/42-linux-dsd-stutter-tcp-info`
- **Reported:** While playing DSD256 through TrueNAS `Music Room Core` → HiFi ROSE RS130 → T+A DAC 200, playback suffers frequent audible stutters, whereas Windows UPnP playback was stutter-free.
- **Cause:**
  1. In `src-tauri/src/core_runtime/upnp_session.rs`, `query_socket_tcp_info` defined a truncated `KernelTcpInfoPrefix` ending at `tcpi_total_retrans` and passed `info.tcpi_rcv_space.max(65_536)` as `tcpi_snd_wnd`.
  2. Live `ss -tin` telemetry on TrueNAS (`192.168.1.6:18890 -> 192.168.1.106:52896`) showed RS130's real `snd_wnd = 1,476,992` bytes while the server socket's `rcv_space = 14,480` bytes (clamped to `65_536`).
  3. Because `steady_sndbuf * 2 = 65_536` for bitrates `> 160 KB/s`, `sample.snd_wnd <= low_wnd_floor` (`65_536 <= 65_536`) evaluated `true` on every `200 ms` `TCP_INFO` probe, immediately aborting `InitialFill` (`1.180x`) and trapping steady-state streaming in `FlowSuppressed` (`0.995x`), draining the `512 KiB` (`185.7 ms` DSD256) pre-roll.
- **Fix:**
  1. Updated `query_socket_tcp_info` in `src-tauri/src/core_runtime/upnp_session.rs` to read `libc::tcp_info` up to the kernel-returned `len` (guarded by `core::mem::offset_of!`), extracting the real `tcpi_snd_wnd`, `tcpi_min_rtt`, and `tcpi_bytes_retrans`.
  2. Added regression tests for Linux `tcp_info` length handling, genuine `snd_wnd == 0` preservation, live loopback `query_socket_tcp_info`, and open-window DSD256 `CorePacer` behavior.
- **Status:** Implemented locally; awaiting TrueNAS release-build verification.

## Feature: Optional Linux Cadence Core

- Requested: 2026-11-15. Preserve standalone Windows Cadence while optionally using a headless Linux UPnP engine on TrueNAS, controlled by Windows and Android.
- Design and phase ledger: [Optional Linux Cadence Core](../../docs/designs/OPTIONAL_LINUX_CORE.md).
- Branch: `feat/linux-core-phase-10-release-qualification` (current fix branch: `fix/38-core-format-and-play-connection`).
- Status: Phases 1–10 implemented; `#37` verified on TrueNAS (1,886 tracks imported); [#38](https://github.com/matbhuvi-tech/Cadence/issues/38) and [#39](https://github.com/matbhuvi-tech/Cadence/issues/39) fixed and awaiting user verification.

## GitHub #38 & #39: Core tracks shown as FLAC Core Stream & clicking Play on multi-track album triggers 'Connection lost'

- **Links:** https://github.com/matbhuvi-tech/Cadence/issues/38, https://github.com/matbhuvi-tech/Cadence/issues/39
- **Reported:** While testing live TrueNAS Dragonfish Core (`192.168.1.6:4040`), all 1,886 NAS tracks rendered as `FLAC · Core Stream` with global catalog index numbers (`199`, `200`, `201`) instead of `WAV 16-bit / 44.1 kHz` and album track numbers, and clicking Play on `Delhi - 6` immediately showed `Music Room Core: Connection lost. Playback may still be continuing.` while Core stayed running at `revision: 0`.
- **Causes:**
  1. `CatalogTrack` / `load_catalog_projection` omitted `format`, `sample_rate`, `bit_depth`, `track_number`, `disc_number`, and `release_year`, and `mapCoreCatalogToUi` hardcoded `format: 'FLAC'`, `sampleRateStr: 'Core Stream'`, and `trackNumber: index + 1`.
  2. `dragonfish.rs` (`admit_requested_tracks_for_v1_command`) admitted only `entries[0..2]` on `queue.replace` (and skipped `queue.control` `next`/`previous`/`jump`), whereas `core_runtime/mod.rs` (`rejects_unadmitted_target`) rejected any `queue.replace` containing unadmitted entries `>= 2` with `not_ready`, and `coreControllerTransport.ts` mapped `not_ready` into `Connection lost`. Control timeouts (`5000 ms`) were also tight for larger ZFS `mlock` reads.
- **Fix:**
  1. Extended `CatalogTrack` and `CoreCatalogTrack` (Desktop + PWA) with optional metadata fields (`format`, `sampleRate`, `bitDepth`, `trackNumber`, `discNumber`, `releaseYear`) projected at startup/idle in `load_catalog_projection` and formatted in `mapCoreCatalogToUi` and `mapCoreSnapshotToPwa`.
  2. Scoped `rejects_unadmitted_target` `queue.replace` idle admission checks to the initial playback entry (matching bounded `LockedBytesArena` lookahead), added `queue.control` target admission and single-track lookahead fallback in `dragonfish.rs`, preserved connected state on Core operational errors (`not_ready` / `invalid_payload` / `unsupported_capability`), and raised `/v1/core` command timeouts to `15s` (`10s` socket I/O in `dragonfish.rs`).
- **Verification:** Passed `core_dragonfish_packaging_test` (9/9), `core_headless_test` (7/7), `core_session_test` (24/24), `core_snapshot_import_test` (5/5), `core_upnp_session_test` (5/5), `core_remote_curate_test` (5/5), `lib` unit tests (6/6), TypeScript Core suites (47/47), `npm run build`, and `npx oxlint`.
- **Status:** Awaiting TrueNAS container rebuild + Windows installer live verification.

## GitHub #37: Snapshot import fails with 'no such column: id' on legacy playlist_tracks schema

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/37
- **Reported:** Running `cadence-headless --import-snapshot` on TrueNAS against an exported Windows `cadence.db` failed with `no such column: id in SELECT playlist_id, track_id, position, added_at FROM playlist_tracks ORDER BY id ASC`.
- **Cause:** Real long-lived Windows `cadence.db` instances created before `playlist_tracks` gained an `id` column use `PRIMARY KEY (playlist_id, position)` without an `id` column, whereas `src-tauri/src/core_runtime/migration.rs` sorted `playlist_tracks` by `id`.
- **Fix:** Ordered the query by `playlist_id ASC, position ASC` in `src-tauri/src/core_runtime/migration.rs` and added a legacy-schema regression test in `src-tauri/tests/core_snapshot_import_test.rs`.
- **Status:** In progress on `fix/37-snapshot-import-playlist-tracks-order`; pending live TrueNAS import verification.

## GitHub #35: Enriched artist editorial profile (bioSummary, etc.) not persistent across navigation & bio text truncation

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/35
- **Reported:** When clicking "Enrich Profile" on an artist detail page (e.g., Ilaiyaraaja), the biography and era appear, but navigating away and returning causes the bio to disappear. Additionally, the biography text in the artist hero is hard-truncated to 3 lines (`line-clamp-3`) with no way to read or expand the full biographical details.
- **Cause:**
  1. `canonicalArtistsMetadataCache` in `src/services/sqliteLibraryService.ts` only stored `portraitUrl`, `portraitStatus`, and `eraActive`, omitting `bioSummary`, `primaryRole`, `mbid`, and `appleArtistId`.
  2. `sqliteLibraryService.getCanonicalArtistDetail(...)` reconstructed the artist object from in-memory releases/tracks and only picked up `portraitUrl` and `eraActive` from the cache, leaving `bioSummary` undefined.
  3. `sqliteLibraryService.updateArtistEditorialProfile(...)` forwarded to Tauri IPC but never updated `canonicalArtistsMetadataCache`.
  4. In `src/components/CenterStage/ArtistsView.tsx`, if audio was playing during enrichment, the write was completely skipped without an idle queue mechanism.
  5. The hero bio paragraph had a fixed `line-clamp-3` constraint without an expandable toggle (e.g., "Read more" / "Show less").
- **Fix:**
  1. Expand `canonicalArtistsMetadataCache` in `sqliteLibraryService.ts` to cache the full editorial payload (`bioSummary`, `eraActive`, `primaryRole`, `portraitUrl`, `mbid`, `appleArtistId`, etc.).
  2. Update `getCanonicalArtistDetail` to merge all cached editorial properties (including `bioSummary`) onto the artist entity.
  3. Ensure `updateArtistEditorialProfile` immediately updates the cache in addition to persisting to SQLite.
  4. In `ArtistsView.tsx`, handle playback-active states cleanly by queuing/scheduling the editorial write for idle transport or persisting asynchronously without blocking audio streaming.
  5. Add an interactive expandable bio toggle ("Read more" / "Show less") with clean Apple HIG typography so users can expand truncated artist biographies.
- **Status:** In progress on `fix/35-persist-enriched-artist-profile`.

## GitHub #34: Clicking album cover art in Listen workspace navigates to Curate instead of album drill-down

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/34
- **Reported:** Clicking in the middle of an album cover art card in the Listen workspace (`Albums` Cover Grid) navigates to the Curate workspace instead of opening the Listen workspace album drill-down view.
- **Cause:** `handleSelectAlbumCard` in `src/components/CenterStage/AlbumCoverGrid.tsx` called `setSelectedAlbumId(album.id)` and also called `onInspectRelease(album.release.id)`, which invokes `handleInspectRelease` in `src/App.tsx` and switches `topMode` to `'curate'`.
- **Fix:** Removed the `onInspectRelease(album.release.id)` call from `handleSelectAlbumCard` so clicking an album card opens the in-place Listen workspace album drill-down, while the dedicated Curate hover button (`SlidersHorizontal`) and drill-down "Edit Metadata" button continue to route to Curate.
- **Status:** Implemented on `fix/34-album-cover-click-listen-drilldown`; pending user verification.

## GitHub #31: Apple & MusicBrainz return parse_error in packaged desktop builds and discard successful Gemini AI results

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/31
- **Reported:** Curate Steer Providers refresh shows `Apple · parse error (3 ms · HTTP 200)` and `MusicBrainz · parse error (3 ms · HTTP 200)`, marks the run `failed`, and leaves `Gemini AI Master` at `—` despite `Gemini AI · success`.
- **Cause:**
  1. `fetchItunesAlbumCandidate` and `fetchMusicBrainzReleaseCandidate` called `/api/itunes-search` and `/api/musicbrainz-search`, which exist only as Vite dev-server middleware; in packaged Tauri builds, the app origin returns `index.html` (HTTP 200) in ~3 ms, causing `response.json()` to throw `SyntaxError`.
  2. `resolve2of3ReleaseConsensus(..., refresh = true)` passed `requireResponse: true` on Apple and re-threw `apple.reason` unconditionally, discarding `aiMasterResult` before `setAlbumItems` could apply it.
- **Fix:**
  1. Added native Tauri commands `search_itunes_metadata`, `search_musicbrainz_metadata`, and `cancel_provider_request` in `src-tauri/src/commands/metadata_providers.rs`, routed via `fetchProviderEndpoint` when `tauriBridge.isTauri()` is true.
  2. Updated `resolve2of3ReleaseConsensus` and `UnifiedCurateCockpit.tsx` to preserve available Gemini AI / peer-provider results when one provider fails, while still failing when all remote sources fail.
  3. Recorded `errorMessage` on failed provider attempts in `fetchCurateCandidate`.
- **Status:** Implemented on `fix/31-curate-desktop-providers`; pending user verification.

- **Reproduction:** In the main desktop window, the Left Rail sidebar under "STORAGE MOUNTS" renders a button with the arbitrary first mount name ("Drive E: [4]"). Clicking it unexpectedly opens a global modal titled "Library & Storage Management" which controls all mounts and watched folders. In that modal, the telemetry bar displays internal SQLite details ("Native SQLite WAL Active"), the body has a static educational banner ("Non-Destructive Library Integrity Guarantee"), and the footer shows the raw file path "Database location: %APPDATA%/com.cadence.core/cadence.db".
- **Resolution:**
  1. In `LeftRail.tsx`, rename the section header to `STORAGE` and label the button clearly as `Storage & Folders`, providing a predictable management target.
  2. In `StorageManagerModal.tsx`, update modal title to `Storage & Library Folders` and subtitle to describe managing storage roots, watched folders, and disk health.
  3. Remove the internal "Native SQLite WAL Active" pill from the top telemetry bar.
  4. Remove the static "Non-Destructive Library Integrity Guarantee" instructional callout.
  5. Remove the raw database path from the footer, providing a clean Apple HIG-aligned modal.
- **Status:** Resolved and verified by user. [GitHub issue #20](https://github.com/matbhuvi-tech/Cadence/issues/20)

## Issue #19 — Unfreeze artwork indexing worker and retire redundant Audit first-class navigation

- **Reproduction:** Ingest a music library containing both un-cached artist portraits and embedded album covers. Once artist portraits finish syncing, background artwork indexing stalls permanently at partial progress (e.g. 130/381 scanned) reporting "Idle: All artist portraits synchronized" while remaining marked "Active". In the UI, "Audit & Hygiene" exists as an over-promoted ⌘3 mode and Left Rail entry with conflicting defect numbers (130) compared to Curate & Metadata Cockpit (222 P0 / 922 total defects), creating contradictory stories and fractured mental models.
- **Diagnosis:** In `src-tauri/src/maintenance/worker.rs`, when `pending_count == 0` for artist portraits, an early `continue;` statement short-circuits the maintenance loop before reaching `process_next_artwork_item()` or `process_next_fingerprint_item()`. Meanwhile, `MaintainCockpit.tsx` operates on a legacy audit service detached from Curate's authoritative P0–P3 priority engine, duplicating triage, commit, and storage hubs.
- **Resolution:**
  1. Fix the maintenance worker loop in `src-tauri/src/maintenance/worker.rs` so artist portrait completion transitions cleanly to artwork indexing and acoustic fingerprinting without short-circuiting, while strictly preserving audio-idle playback guards and thread pacing.
  2. Simplify primary navigation in `App.tsx` and `LeftRail.tsx` around Listen (⌘1) and Curate (⌘2), retiring Audit as an over-elevated first-class mode and cleaning up the Left Rail.
  3. Ensure the top bar `ActivityPill` remains interactive and visible whenever background indexing or maintenance tasks are running.
- **Status:** Resolved and verified by user. [GitHub issue #19](https://github.com/matbhuvi-tech/Cadence/issues/19)

## Issue #18 — Refactor Activity Center popover: remove obsolete jargon, contextualize Gemini AI, and refine scan trigger UX

- **Reproduction:** Add a new library mount or trigger a scan on a folder. The full 440px Activity Center popover immediately forces itself open over the UI. It displays developer-centric labels ("Lofty Tags", "SQLite FTS") across pipeline stages that don't match the modern streaming architecture, and it prominently renders a Gemini AI Cloud Pipeline bento even when Gemini is completely idle during local file ingestion, causing confusion about local audio privacy.
- **Resolution:**
  1. Do not aggressively force the full popover open when starting a library scan in `App.tsx`; instead, notify via toast and allow the user to view progress via the existing top bar `ActivityPill`.
  2. Modernize the stage pills in `ActivityCenterPopover` with user-centric, clean labels ("Discovery", "Tags & Metadata", "Database Index", "Audio & Art") that accurately map to scanner and maintenance states.
  3. Contextualize the Gemini AI section so it only displays when AI requests are active, cooling down, rate-limited, or when specifically monitoring AI operations, keeping local scans clean and focused.
- **Status:** Resolved and verified in commit `b19e1d5`. [GitHub issue #18](https://github.com/matbhuvi-tech/Cadence/issues/18)

## Issue #15 — Gemini API calls always return 429 when Google Search grounding quota is exhausted

- **Reproduction:** Open Curate and refresh/resolve an album using a Gemini API key whose Google Search Grounding (`google_search`) quota is 0 or exhausted while standard `generateContent` quota is healthy. Every call fails with `Gemini request failed (429)`.
- **Diagnosis:** `resolve_operation` in `src-tauri/src/commands/gemini_config.rs` sets `use_grounding = true` whenever `userSearchQuery` or `referenceUrl` is present. `generate` only attempted grounded requests (`tools: [{"google_search": {}}]`) across candidate models and never fell back to ungrounded JSON inference. Additionally, upstream `429` responses for `google_search` omit `QuotaFailure` details (`violations` is empty), so `record_block` did not record the project-level `grounding` cooldown.
- **Resolution:** Record `state.grounding` when a grounded request returns `429` without model/project-spend `QuotaFailure` violations, and iterate over `&[true, false]` in `generate` when `use_grounding` is requested so blocked or rate-limited grounding automatically falls back to ungrounded JSON inference (`responseMimeType: "application/json"`).
- **Status:** Pending user verification. [GitHub issue #15](https://github.com/matbhuvi-tech/Cadence/issues/15)

## Issue #14 — Saved Apple track candidates disappear after reopening Curate

- **Reproduction:** Refresh Apple evidence, save the draft, and reopen the album. Evidence History lists returned tracks while the Apple Music Track column is blank.
- **Resolution:** Display archived candidates using the saved track mappings. New evidence records Apple track IDs. Older records use a unique saved Apple track position within the recorded release. Conflicts are labelled for review, and archived rows are read-only.
- **Verification:** The restore regression passed with all 41 Curate checks and the production build. The affected album's saved evidence contains seven inferred and two conflicted mappings that can be restored. The evidence service had 96% line coverage. Live desktop verification remains pending.
- **Status:** Pending user verification. [GitHub issue #14](https://github.com/matbhuvi-tech/Cadence/issues/14)

## Issue #13 — Malformed WAV timestamps leave Curate commits waiting

- **Reproduction:** Queue Curate writes for WAV tracks with a malformed embedded date, then stop playback. The first three attempts report an invalid timestamp and later items stay pending.
- **Diagnosis:** The timestamp error occurs while Lofty reads the staged copy. The worker counts file-level tag errors toward mount isolation.
- **Resolution:** Repair supported malformed WAV date frames on the staged copy when the confirmed payload contains a replacement year. Verify the replacement before the atomic swap. Count storage connection and device availability errors toward mount isolation.
- **Verification:** The native WAV regression reproduced three tag failures leaving two items waiting. It now verifies the replacement dates, preserved artist credit, intact originals for files without replacement dates, and continued processing on the same mount. All 32 focused native checks passed. Rust line coverage and live desktop QA were unavailable.
- **Status:** Pending desktop verification. [GitHub issue #13](https://github.com/matbhuvi-tech/Cadence/issues/13)

## Gemini quota monitoring and model fallback

- **Reproduction:** Return a 429 from the preferred Gemini model, then submit another request. The previous implementation tried the same model again and the Activity Center only showed fixed local pacing.
- **Change:** Both backends now share quota cooldowns across requests, respect Google retry hints, and route to eligible Flash-Lite models. The Activity Center shows the in-flight or last successful model and any active cooldowns. Interactive Curate evidence can use two upstream attempts, while automatic provenance retains a one-attempt budget.
- **Verification:** The mocked provider budget test reproduced the reuse of a throttled model and now covers fallback, actual model telemetry, concurrent project throttling, and queued cancellation. Rust tests cover Pacific midnight across daylight saving, alias quota scope, and grounding quota isolation.
- **Status:** Pending desktop verification.

## Issue #12 — Missing Gemini errors and provenance details

- **Reproduction:** Refresh an album when Gemini fails. Evidence History includes Apple and MusicBrainz but omits the AI attempt and error.
- **Resolution:** Record Gemini attempts before the compilation resolver handles errors. Store measured timing, available HTTP status and model metadata, safe error text, and the returned track proposals. Evidence History expands successful AI results and selects the newly saved run after refresh.
- **Verification:** The failure regression first recorded zero attempts. Five focused cases now cover HTTP errors, native rejection strings, timeouts, network failures, cancellation, malformed/empty responses, and successful proposal details. Browser fixtures verified a visible 429 error and expandable successful results. The SQLite fixture verified that both failure details and successful proposals survive reopening the database.
- **Status:** Pending user verification. [GitHub issue #12](https://github.com/matbhuvi-tech/Cadence/issues/12)

## Issue #11 — Edit Metadata opens the wrong completed album

- **Reproduction:** Open a previously completed album in Listen and click **Edit Metadata** in its detail view. Curate can open another album from the queue.
- **Cause:** The detail action did not opt into reopening a completed review, so Curate excluded its target.
- **Resolution:** Reopen completed reviews in the shared metadata-edit handler, using the requested release ID and the existing mechanism for superseding prior commit rows.
- **Browser regression:** Serve `tests/fixtures/curate/edit-metadata-navigation.html` with Vite. Open Dil Se, return to Listen, then click **Edit Metadata**. Before the fix, Curate selected Delhi-6. After the fix, Selected Output showed Dil Se and its tracks.
- **Status:** Browser fixture verified. Desktop verification pending. [GitHub issue #11](https://github.com/matbhuvi-tech/Cadence/issues/11)

## Issue #10 — Curate refresh skips Apple track lookup

- **Reproduction:** Refresh evidence for an Apple match while the refresh allocates one Apple call. The saved result shows the album with zero tracks.
- **Resolution:** Use a 12-call budget for explicit refresh, reserve the Apple track lookup after a match, and make Apple rate-limit waits cancellable. Leaving the album cancels its refresh.
- **Status:** Pending desktop verification. [GitHub issue #10](https://github.com/matbhuvi-tech/Cadence/issues/10)

## Issue #9: Curate evaluation fails on the early identity schema
- **Reproduction:** Open an existing database created by an early Identity foundation build, select Sivaa, and refresh evidence. Identity lookup fails before provider retrieval.
- **Fix:** Migrate the missing identity column at startup while preserving existing identity rows. Show which step failed in the evaluation badge tooltip.
- **Status:** Verified by the user on 2026-11-06. [GitHub issue #9](https://github.com/matbhuvi-tech/Cadence/issues/9)

## Curate identity foundation
- **Scope:** Persist release edition, disc, local track lineage, source-group candidates, provider mappings, and independent revisions.
- **Status:** Implemented and user-verified on 2026-11-06. See the [Milestone A checkpoint](../../docs/designs/CurateArchitecture.md#milestone-a-implementation-checkpoint).

## Curate queue includes albums after a human commit
- **Expected:** A successfully committed album stays out of both Curate queues and the badge count. Explicit metadata edits in Listen reopen the selected review.
- **Status:** Implementation pending verification.

## Issue #3: Missing File Name in Curate Local File Column
- **ID:** #3
- **Title:** fix(curate): display filename under local track artist and preserve filepath in consensus
- **Description:** In Curate -> Tier 2: Guided Reconciliation, the file name was missing under the local track name and local track artist in the `#Local File` column because `federatedResolvers.ts` dropped `filePath` from `trackStates`, causing the file name to disappear once consensus arrived. Additionally, the folder name was unnecessarily repeated even though it was already presented in the header.
- **Resolution:**
  - Added `fileName` to `TrackCandidateState` in `types.ts`.
  - Updated `federatedResolvers.ts` to propagate `filePath`, `fileName`, and format details in consensus results.
  - Implemented `mergeConsensusTrackStates` in `UnifiedCurateCockpit.tsx` to prevent consensus resolution from overwriting local file paths.
  - Rendered `effectiveFileName` with `FileText` icon under the local artist credit in the `#Local File` column.
- **Status:** Verified and Fixed.

## Issue #4: Curation Decision Trace Persistence, Spotify Direct Grounding, and Telemetry Links
- **ID:** #4
- **Title:** feat(curate): Curation decision trace feedback, Spotify direct embed parser, and diagnostic telemetry links
- **Description:**
  1. Steer provider fetches had up to 10 seconds of black-box latency without user progress indication.
  2. Navigating between albums in Curate lost the curation rationale and decision trace state because TypeScript model field names did not align with Serde Rust struct attributes.
  3. Pasting Spotify grounding URLs (e.g. `https://open.spotify.com/album/4q3WAYKvVyEYo4P5gOV10m`) failed to populate the AI Master column because standard SPA scraping was blocked without auth.
  4. MusicBrainz release links in the Diagnostic Telemetry table returned HTTP 400 because non-UUID title strings were being passed to `/release/<id>` endpoints.
- **Resolution:**
  - Added `SteerProgressBar` and slide-over `CurationDecisionTraceDrawer` with progressive disclosure.
  - Aligned Rust and TypeScript models (`headline_summary`, `field_traces`, `candidate_telemetry`, `duration_ms`) and enabled atomic SQLite UPSERT persistence with RAM buffering (`MEMORY_BUFFER`) during playback.
  - Implemented `resolveDirectSpotifyCandidate` to extract 100% ground-truth tracklists and artwork from Spotify embed `<script id="__NEXT_DATA__">` with 0 API quota.
  - Fixed provider link routing in `CurationDecisionTraceDrawer` using UUID validation and fallback search endpoints.
  - Updated master architecture specification in `docs/designs/CurateArchitecture.md`.
- **Status:** Verified and Fixed.


## GitHub #4: Curate badge remains unchanged after album commits

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/4
- **Reported:** Curate badge stays at 130 while albums are committed.
- **Cause:** Header adds legacy defect and audit counts instead of using the cockpit's remaining review queues.
- **Change:** Publish the combined Tier 1 and Tier 2 review count to the header, using the existing completed-commit reconciliation logic. Retain the last reported count when navigating away; before the first cockpit visit, retain the existing estimate.
- **Status:** Verified by the user. Frontend/PWA build, 15 curation tests (using tsconfig.app.json), and NSIS installer build passed on 2026-11-06.


## GitHub #5: Pending credits trigger a false local-metadata conflict

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/5
- **Cause:** Library loading overlaid pending artist, composer, and album-artist selections onto the catalog fields used as the Curate Local baseline.
- **Fix:** Load those three fields from the catalog and retain all proposals in `pendingSidecarEdits`. Draft comparison and genuine-change protection remain unchanged.
- **Regression coverage:** `src/test/testLibraryLocalMetadata.ts` exercises the actual library loader with mocked native reads, draft serialization/reopening, retained proposals, genuine credit changes, and missing local credits. No music-drive access is performed by these tests.
- **RED:** Before the fix, 3 of 6 new tests failed on pending-credit overlays.
- **GREEN:** All 23 tests across the new loader suite and existing draft/commit/outcome suites passed. `npm run build` passed, including PWA build and TypeScript checks; Vite reported chunk-size and mixed-import warnings.
- **Verification command:** `npx tsx --tsconfig tsconfig.app.json --test src/test/testLibraryLocalMetadata.ts src/test/testCurateDraft.ts src/test/testCurateCommit.ts src/test/testCurateCommitOutcomes.ts`
- **Desktop QA:** Existing Curate QA automation checks provider/selection oracles but does not recreate a saved draft across library reloads. The new loader/draft regression provides deterministic coverage; live desktop verification remains pending.
- **User check:** Restart the development app with this branch, open En Bommukutti Amavuku CD RIP, and confirm the false warning is gone while Selected retains the saved choices and Local shows catalog credits. Navigate away and reopen. No commit is needed for this check.
- **Limitations:** Drafts previously saved against overlaid values may legitimately require a one-time baseline review after the correction. No saved drafts or music tags are rewritten by this change.
- **CodeScene:** Unavailable; user explicitly approved proceeding without it.
- **Release verification:** Windows NSIS installer build passed on 2026-11-06. User authorized pushing to main after the verification handoff; no separate live-desktop test result was reported.
- **Status:** Ready for the user-authorized merge and push to main.

## GitHub #7: Broken artwork fallback in UnifiedCurateCockpit

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/7
- **Reported:** When an album has missing or broken artwork, the Curate rail hides the image with inline `display: none` without rendering an icon fallback, and detail table artwork cells render broken image placeholders.
- **Cause:** `UnifiedCurateCockpit` lacked dedicated broken-image error handling and icon fallback components; `onError` in the queue rail hid the image element entirely, and the detail table cells lacked `onError` handlers.
- **Fix:** Implement `CurateArtworkThumbnail` with graceful `<Disc />` fallback on missing or failed images, and integrate it into both the queue rail cards and all detail table artwork candidate cells (Local, Apple, MusicBrainz, AI, Selected).
- **Scope:** Frontend presentation only; no changes to disk I/O, network transport, or audio engine invariants.
- **RED:** Automated test suite `src/test/testCurateArtworkFallback.ts` failed initially on missing `CurateArtworkThumbnail` module (checkpoint before implementation).
- **GREEN:** All 28 tests across `testCurateArtworkFallback.ts`, `testLibraryLocalMetadata.ts`, `testCurateDraft.ts`, `testCurateCommit.ts`, and `testCurateCommitOutcomes.ts` passed.
- **Verification command:** `npx tsx --tsconfig tsconfig.app.json --test src/test/testCurateArtworkFallback.ts src/test/testLibraryLocalMetadata.ts src/test/testCurateDraft.ts src/test/testCurateCommit.ts src/test/testCurateCommitOutcomes.ts`
- **Build:** `npm run build` passed cleanly (including PWA build, TypeScript check `tsc -b`, and Vite production bundle). `npx oxlint` passed with 0 errors.
- **Status:** Verified and Fixed. Merged into main in e4afefa, NSIS installer build passed on 2026-11-06.

## Portable Playback Engine distribution

- Request: portable Linux daemon, AMD64/ARM64 images, Compose, GHCR automation, modern TrueNAS guidance, and persistence, upgrades and rollback documentation.
- Status: implementation ready for user verification; live TrueNAS and physical renderer validation pending.

## Guided Playback Engine installation

- Request: an interactive installer with suggested network address and release, prerequisite setup, and automatic engine installation on Linux and TrueNAS.
- Status: automated checks in progress; live NAS and first-release publication remain to be verified.

## Feature: UPnP renderer pacing calibration

- Requested: standalone privileged capture workflow producing a renderer-specific pacing JSON for playback engine platforms.
- Branch: `feat/renderer-pacer-calibration`.
- Status: experimental manual-capture CLI and candidate profile; hardware validation, automatic playback control, privilege orchestration and packaged multi-platform releases remain open. See `tools/renderer-calibration/README.md`.

## GitHub #44: Windows engine selected output and playback readiness

- Link: https://github.com/matbhuvi-tech/Cadence/issues/44
- Branch: `fix/44-windows-engine-output-state`.
- Observed: RS130 is discovered and output selection returns success, but session snapshot continues to report the startup output; Windows playback attempts returned `not_ready`.
- Progress: session-owner output projection now updates with the selected output and advances the revision. Focused regression and headless/session tests pass. Desktop remote-output selection and the separate playback admission failure remain unresolved; installed engine has not been updated or validated.
- Admission investigation: the Windows control listener passes `admit_to_arena = false`, while `HeadlessCoreRuntime::rejects_unadmitted_target` and `SharedRenderer` require admission for catalog tracks. This source-level mismatch explains the observed `not_ready` response if the installed binary has the same code. Merely enabling Core admission duplicates the Windows renderer's file loading; bypassing admission leaves the Windows UPnP loader's pageable and windowed fallbacks in place, which can violate the workspace's strict memory and storage invariants. A shared, strictly locked buffer handoff needs design and testing before either change is safe.
- Follow-up: desktop picker now requests the active engine's outputs when opened and allows an idle user to select an available output. The Windows engine rejects unavailable outputs and selection during active playback. `node --import tsx --test src/test/testEngineOutputs.ts`, `npm run build`, targeted Core tests and the `engine-audio` cargo check pass. The installed application and live RS130 UI have not been updated or tested. Track admission remains unresolved.
- Live follow-up: the installed engine accepted ROSE-67 but reported `system_default` in its next snapshot. A temporary run of the rebuilt release engine selected a local WASAPI device and returned that device with revision 1; the installed process was restored. RS130 was not discovered during the bounded startup window, so the rebuilt engine's RS130 selection remains unverified. Picker now detects a mismatch and reports an explicit failure instead of silently showing the previous output. Python-free TS tests and `npm run build` pass. Windows engine release binary and NSIS installer were built; the `not_ready` track-admission issue is still unresolved.
- Renderer discovery follow-up: fixed SSDP collection to wait through the 2-second response window, and added idle/cooldown-guarded `outputs.scan` plus a desktop scan button. A delayed-response regression test passes. Against the physical RS130, the temporary release engine scanned ROSE-67, selected its exact UDN, and reported ROSE-67 in the next snapshot. The installed engine was restored after testing; the new installer must still be installed by the user. Playback admission remains unresolved.

## #46 — Renderer idle sleep and Windows engine playback
- Windows engine: live QA on the installed engine with Dorothy track trk-45900611ec07 reproduced queue.replace returning not_ready while idle and leaving the queue empty.
- Rose-67: Core reconciliation queries the renderer every five seconds when no session is active; physical sleep impact remains unverified.
- Status: open; safe locked-memory admission and idle takeover detection need implementation and integrated validation.

- Windows track admission is implemented on `fix/46-windows-track-admission`. The engine admits whole tracks to locked RAM while idle and shares those bytes with WASAPI and UPnP. Failed admission leaves the queue intact. New uncached tracks require an idle engine and the existing 30-second cooldown. The desktop allows up to three minutes for commands that may admit tracks from NAS.
- Release QA passed with a 44.1 kHz WAV on WASAPI and the 806 MiB Dorothy DSF on the physical ROSE-67. The DSF queued and started in approximately 42 seconds with an advancing session position. The WASAPI transition check played the cached next track and rejected an uncached transition during playback and cooldown. The installed engine was restored after testing.
- The Windows HTTP admission, lock lifetime, and targeted Core and desktop tests passed. Both NSIS installers built. Full audio-path resource profiling and user verification are pending. Renderer idle sleep remains open under #46.
