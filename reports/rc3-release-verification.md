# rc3 release verification

## Approved Linux curation fix (#56)

Journey: an approved metadata change writes successfully on Linux while preserving audio payload, crash recovery, and playback/cooldown deferral.

- RED: run 45308571189, `cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite`: core_remote_curate_test had 4 passing and 6 failing tests.
- Fix: keep the Linux parent directory handle alive while its /proc/self/fd path is used for replacement, verification, and rollback. Release the source handle and preserve non-Linux parent cleanup.
- GREEN: run 45310025279, same command: all 10 core_remote_curate_test tests passed; the entire Linux verification job passed (170 Rust tests, no failures).
- Coverage percentage was not measured. Existing integration tests exercise approved writes, payload preservation, external-change rejection, crash recovery, workers, and playback/cooldown deferral. Real DAC/hardware playback was not requalified for this idle-write change.

## Packaging corrections

Run 45310025279 exposed Docker fetching before library source existed, and Android setup requesting the removed SDK tools package. Copy the source before Cargo fetch and request platform-tools explicitly. Runtime audio configuration is unchanged.
