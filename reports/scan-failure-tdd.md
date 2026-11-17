# Windows Engine scan failure TDD evidence

Issue: [#43](https://github.com/matbhuvi-tech/Cadence/issues/43)
Branch: `fix/43-album-artwork-scans`

## User journey

As a library owner, I want a full scan to keep indexing when optional WAV RIFF INFO metadata is malformed, so one damaged tag does not fail the whole folder scan or replace metadata already in the catalogue.

## RED and GREEN evidence

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| A WAV with invalid UTF-8 in a RIFF INFO value still provides technical properties. | `cargo test --manifest-path src-tauri/Cargo.toml --lib scanner::media::tests::malformed_riff_info_does_not_prevent_wav_technical_metadata_import -- --exact` failed with `Wav: Failed to read RIFF INFO item value`. | Same test passed after WAV-only retry with tag parsing disabled. The returned error is retained on `MediaMetadata`. |
| Existing indexed metadata survives a re-scan of that WAV, and the file is marked seen. | Regression added for the scanner's tag-fallback path. | `cargo test --manifest-path src-tauri/Cargo.toml --lib artwork_regression_tests` passed: 4 tests, including metadata preservation and seen-state. |
| Scan progress distinguishes processed queue items from the total error count and supports capped detail records. | `node --import tsx --test src/test/testEngineScanStatus.ts` failed because the formatter did not yet exist. | Same command passed: 4 tests, including 137 total errors with 100 retained details. |
| Existing artwork recovery behavior remains intact. | Existing regression cases. | Same native artwork group passed: 4/4 tests. |

## Implementation

- WAV parsing retries with `read_tags(false)` only when the normal tag parse fails and the audio properties can still be read.
- The headless Windows Engine preserves an existing row's metadata and marks that file as seen when the retry indicates tags were unavailable. New files can still be indexed from technical properties and path-derived defaults.
- The legacy desktop scanner classifies this condition as a metadata parse skip instead of replacing catalogue metadata with filename defaults.
- Scan state stores `errorCount` independently of the bounded 100-path `errors` list. The Storage modal labels processed items and errors and exposes retained paths/messages in a collapsed detail list.

## Validation and limits

- Native targeted regressions: WAV media parser 1/1; Engine artwork/scan group 4/4.
- Frontend status tests: 4/4.
- `npm run build`: passed (PWA TypeScript/Vite and desktop TypeScript/Vite). Existing Vite warnings remain about ineffective dynamic imports and the large desktop bundle.
- Native compiler emitted the existing `try_curate_draft_read` dead-code warning.
- No NAS runtime re-scan or playback-time resource benchmark was run. The regression uses a generated RIFF fixture; affected physical WAV files were not reread as part of this fix. Windows installer build was not run.
- Audiophile impact assessment: scan/parser I/O remains under the existing idle/cooldown gate; no audio transport, scheduling, network pacing, or playback-memory code changed. UI status rendering changes only when the storage modal receives scan status; no timers or polling were added.
