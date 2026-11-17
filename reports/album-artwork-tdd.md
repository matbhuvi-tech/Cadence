# Album artwork TDD: initial Windows Engine fixes

Issue #43. Journeys derived from the catalogue findings and source audit. The current-engine JSON reports remain the before-state; the live catalogue was not modified.

## Evidence

- `cargo test --manifest-path src-tauri/Cargo.toml --lib artwork_regression_tests -- --nocapture`: RED, two tests ran and failed because quick scan left a newly added cover absent and an invalid first image hid a valid later image. After the change both passed; the later added changed-cover case also passed (3/3).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib fresh_legacy_migration_preserves_cached_release_artwork -- --nocapture`: RED because `engine_artwork` did not exist on the fresh migration target; GREEN after creating it and propagating insert errors. The test also checks the migrated track advertises the cached art.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 85 passed before the additional changed-cover regression was added. Targeted artwork tests afterward: 3 passed. Existing unrelated dead-code warning only.
- TDD checkpoints on this branch: `32f07f3` / `9454aa3` and `c7a6ef8` / `6e2d5a8` for RED/GREEN respectively.

## Scope and limitations

The fixes cover the current Windows/Core scan path and fresh legacy Windows migration. Quick scan revisits tracks with folder artwork or missing cached artwork; invalid candidate images no longer prevent trying the next folder image. Migration now creates the artwork table before copying and marks copied art as available. Scan I/O remains under the existing engine idle permit; no playback thread or network transport was changed.

Quick scans can now do substantially more metadata/image reads for releases with folder art or absent cached art. No representative NAS benchmark was available, so scan duration and playback-resource behavior on real hardware are unverified. No live before/after catalogue comparison or UI verification was run. Other audited cases remain, including picture-type preference, stale artwork removal, disc-parent covers, generic snapshot import, and the older desktop scanner. The diagnostic comparator's parent-folder heuristic can produce false positives. Coverage percentage was not measured.
