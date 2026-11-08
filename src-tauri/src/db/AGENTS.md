# Database Package (`src-tauri/src/db`)

## Overview
Houses the persistent SQLite storage engine and schema migrations for Cadence. Stores indexed audio tracks, albums, artist biographies, credit roles, custom playlists, health hygiene triage reports, curation records, and commit queue state.

## Interface
- `AppDb`: Thread-safe database handle wrapping a parking_lot Mutex-protected `rusqlite::Connection` with `new()` and `open_dedicated()`.
- `schema.rs`: DDL definitions and migration routines creating tables for `tracks`, `releases`, `artists`, `playlists`, `credits`, `quarantine`, `curation_decision_traces`, `curation_evidence_runs`, `curation_current_evidence`, `curation_drafts`, `curate_identity_*`, and `commit_queue`.
- `operations.rs`: Query and batch update functions: track inserts, release aggregations, search indexes, two-phase commit queue transactions, and canonical editorial updates.
- `curate_identity.rs`: Internal identity snapshotting, mapping candidate persistence, and draft edit tracking.

## Invariants
- SQLite batch queries and writes must never execute on music library drives while audio playback is active, preventing storage bus wakeups.
- WAL mode (`PRAGMA journal_mode=WAL`), `synchronous=NORMAL`, and proper foreign key constraints must be enforced on connection initialization.
- Dedicated background worker connections must configure `busy_timeout = 5000` to prevent mutex contention with the UI thread.

## Side Effects
- Creates, migrates, and writes data to `cadence.db` SQLite database file on local disk.
- Acquires synchronization locks on database connection handles.

## Verification
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`
