# rc3 release verification

## Approved Linux curation fix (#56)

Journey: an approved metadata change writes successfully on Linux while preserving audio payload, crash recovery, and playback/cooldown deferral.

- RED: run 45308571189, `cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite`: core_remote_curate_test had 4 passing and 6 failing tests.
- Fix: keep the Linux parent directory handle alive while its /proc/self/fd path is used for replacement, verification, and rollback. Release the source handle and preserve non-Linux parent cleanup.
- GREEN: run 45310025279, same command: all 10 core_remote_curate_test tests passed; the entire Linux verification job passed (155 Rust tests, no failures).
- Coverage percentage was not measured. Existing integration tests exercise approved writes, payload preservation, external-change rejection, crash recovery, workers, and playback/cooldown deferral. Real DAC/hardware playback was not requalified for this idle-write change.

## Packaging corrections

Run 45310025279 exposed Docker fetching before library source existed, and Android setup requesting the removed SDK tools package. Copy the source before Cargo fetch and request platform-tools explicitly. Runtime audio configuration is unchanged.

Windows local library verification: cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --nocapture --test-threads=1 passed all 127 tests. CI uses serial Windows test execution with visible panic output. The fast zero-allocation fixture waits 1 ms after allocation counting ends so its millisecond capture has a visible partial bin; allocation assertions remain unchanged.

## Published rc3 result

- Release: https://github.com/matbhuvi-tech/Cadence/releases/tag/v0.1.0-rc.3 (prerelease).
- Tagged source: d7ed7eb842288868d86a148e7267b9ad6a4358ad.
- Run 45312337631 passed Linux verification, AMD64/ARM64 package installation checks, both container smoke tests, multi-architecture image publication/attestation, and Android compilation.
- GitHub-hosted Windows tests remain unresolved: artwork fixtures report paths outside authorized roots and engine bootstrap exits with an access violation. Serial execution did not resolve those runner failures.
- Built Windows from an isolated tagged checkout with rc.3 versions using npm run build:windows (Desktop, Engine, unified suite). Engine --version reported v0.1.0-rc.3; offline --doctor exited 0 with expected uninitialized-data warnings.
- Local full native suite: cargo test --locked --manifest-path src-tauri/Cargo.toml -- --nocapture --test-threads=1 passed 239 tests on rerun. Initial run had an intermittent telemetry-counter assertion (126 passed, 1 failed in the library suite); unchanged rerun passed all targets. Local earlier library and curation checks also passed 127 and 10 tests respectively.
- Published 17 assets. Compared every uploaded GitHub SHA-256 digest with the local file; all matched. Checksums cover all 16 other assets, including Windows build provenance.
- Android APK is debug-signed; no release signing secrets were configured. Hardware playback was not requalified. These limitations are in the release notes.
- No branches were merged to main and no issues were closed.
