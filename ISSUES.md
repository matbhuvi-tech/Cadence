# Issues

- [#48](https://github.com/matbhuvi-tech/Cadence/issues/48): Album Art Pipeline: Missing covers on import, dev vs release disparity, playback browse lockouts, PWA parity, and V1-to-V2 engine migration.
- [#43](https://github.com/matbhuvi-tech/Cadence/issues/43): Album artwork missing or stale after import and scans. Initial Windows Engine fixes and remaining cases are tracked in `reports/album-artwork-tdd.md`.

- Album artwork missing, stale, or incorrect after catalogue import and quick/full scans: source audit recorded in [reports/album-art-import-scan-audit.md](reports/album-art-import-scan-audit.md). Initial Windows Engine fixes and TDD evidence are tracked in GitHub issue #43.
- Windows Engine full scan failed after 422 items because nine WAV files contain malformed RIFF INFO metadata. Reproduction, tolerant WAV fallback, metadata preservation, and clearer error reporting are tracked in GitHub issue #43 and `reports/scan-failure-tdd.md`.
- Before/after catalogue diagnostics: three read-only entry points and usage instructions in [tools/README.md](tools/README.md), with temporary-fixture regression tests in `scripts/qa/test_catalogue_diagnostics.py`. Does not change Cadence import/scan behavior.

- [#8](https://github.com/matbhuvi-tech/Cadence/issues/8): Completed Curate album reopens with an obsolete draft; saved Apple evidence is absent from the reconciliation view. Includes a selected-album memory snapshot for diagnosis.
- [#17](https://github.com/matbhuvi-tech/Cadence/issues/17): Fix Queue drawer layout truncation, hover overflow and align with Cadence Golden Yellow theme.
- [#21](https://github.com/matbhuvi-tech/Cadence/issues/21): Desktop Now Playing stuck on initial track and desynchronized from audio engine and mobile remote.
- [#22](https://github.com/matbhuvi-tech/Cadence/issues/22): Desktop Now Playing card flickers and bottom player controls stall when playing track from mobile.
- [#23](https://github.com/matbhuvi-tech/Cadence/issues/23): Desktop playback queue is not synchronized to mobile remote queue.
- [#24](https://github.com/matbhuvi-tech/Cadence/issues/24): Remove past played tracks from playback queue on both desktop and mobile.
- [#26](https://github.com/matbhuvi-tech/Cadence/issues/26): Crash / AppHangB1 during playback and when selecting WASAPI output device.
- [#27](https://github.com/matbhuvi-tech/Cadence/issues/27): WASAPI-to-UPnP endpoint routing override and signal-path telemetry mismatch.
- [#29](https://github.com/matbhuvi-tech/Cadence/issues/29): Sustained idle/paused CPU, WebView2 GPU/React overhead, and RS130 DSD256 playback stuttering (phased remediation; Phase 1 targets idle/background CPU, commit telemetry/projection, React re-renders, and GPU compositing animations).
- [#30](https://github.com/matbhuvi-tech/Cadence/issues/30): Mobile playback control fails with `ws.rs` empty-queue integer overflow panic, dropped/stale WebSocket state (`CONNECTED` dot with null socket), missing full REST command fallback, and unguarded idle `Resume`.
- [#31](https://github.com/matbhuvi-tech/Cadence/issues/31): Packaged desktop Curate refresh fails Apple & MusicBrainz with `parse_error` (HTTP 200 HTML fallback) and discards successful Gemini AI results.
- [#32](https://github.com/matbhuvi-tech/Cadence/issues/32): Curate: clicking a provider track cell only copies artist, not track title, to Selected Track & Singers.
- [#33](https://github.com/matbhuvi-tech/Cadence/issues/33): Album overflow menu ('Edit Metadata in Curate') disappears when moving mouse to click due to hover gap.
- [#34](https://github.com/matbhuvi-tech/Cadence/issues/34): Clicking album cover art in Listen workspace navigates to Curate instead of album drill-down.
- [#35](https://github.com/matbhuvi-tech/Cadence/issues/35): Enriched artist editorial profile (bioSummary, etc.) not persistent across navigation & bio text truncation.
- [#37](https://github.com/matbhuvi-tech/Cadence/issues/37): Snapshot import fails with `no such column: id` on legacy `playlist_tracks` schema.
- [#38](https://github.com/matbhuvi-tech/Cadence/issues/38): Core mode displays all remote tracks as `FLAC Core Stream` with sequential index numbers.
- [#39](https://github.com/matbhuvi-tech/Cadence/issues/39): Clicking Play on TrueNAS Core multi-track album immediately triggers `Connection lost`.
- [#40](https://github.com/matbhuvi-tech/Cadence/issues/40): Core mode playback timer stays stuck at `00:00` while audio plays on RS130 (and Mobile Remote lacks passive Core sync).
- [#41](https://github.com/matbhuvi-tech/Cadence/issues/41): DSD (`.dsf`/`.dff`) albums missing ID3v2 metadata in catalogue and fail Symphonia fingerprinting.

- Pre-built Linux binaries and native packages: `nfpm.yaml` was already tracked despite a matching local exclude. Declare the Debian 12 glibc >= 2.36 baseline and runtime dependencies; validate Debian/RPM installation on both native CI architectures. Successful CI package generation remains to be verified.
- UPnP pacing visibility: quiet active-output pill and opt-in sender delivery inspector implemented on `feat/upnp-delivery-inspector`. Validation and remaining hardware playback checks: [reports/upnp-delivery-inspector-tdd.md](reports/upnp-delivery-inspector-tdd.md).
- [#51](https://github.com/matbhuvi-tech/Cadence/issues/51): Missing UPnP pacer pill after installing a stale unified suite. Installed desktop/engine were from 05:06–05:07 while a newer desktop installer existed. `npm run build:windows` now rebuilds both components and the suite; packaging rejects stale components and records artifact hashes. Recovery and payload verification: [reports/issue-51-windows-suite-rebuild.md](reports/issue-51-windows-suite-rebuild.md).

- [#52](https://github.com/matbhuvi-tech/Cadence/issues/52): Separate healthy pacing from normal receiver regulation and TCP-only warnings; clarify graph legends without changing telemetry collection.

- [#53](https://github.com/matbhuvi-tech/Cadence/issues/53): Engine remains paused after desktop restart; output dialog now provides an explicit Stop playback control and confirms idle state before unlocking controls. Discovery cooldown remains enforced.
- [#55](https://github.com/matbhuvi-tech/Cadence/issues/55): rc3 Linux CI rejected a valid 65536-byte loopback TCP window. Keep deterministic large/zero-window parsing checks and accept any nonzero window in the live smoke test.
- [#56](https://github.com/matbhuvi-tech/Cadence/issues/56): Linux curation invalidates its /proc/self/fd directory anchor before replacement. rc3 run 45308571189 reproduced six failing curation tests; retain the Linux parent handle through replacement and verification.
