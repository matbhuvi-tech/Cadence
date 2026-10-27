# Database Package (`src-tauri/src/db`)

## Overview
Houses the persistent SQLite storage engine and schema migrations for Cadence. Stores indexed audio tracks, albums, artist biographies, credit roles, custom playlists, health hygiene triage reports, and audit logs.

## Interface
- `AppDb`: Thread-safe database handle wrapping a parking_lot Mutex-protected `rusqlite::Connection`.
- `schema.rs`: DDL definitions and migration routines creating tables for `tracks`, `releases`, `artists`, `playlists`, `credits`, and `quarantine`.
- `operations.rs`: High-performance query and batch update functions: track inserts, release aggregations, search indexes, and two-phase commit transaction commits.

## Invariants
- SQLite batch queries and writes must never execute on music library drives while audio playback is active, preventing storage bus wakeups.
- WAL mode (`PRAGMA journal_mode=WAL`) and proper foreign key constraints must be enforced on connection initialization.

## Side Effects
- Creates, migrates, and writes data to `cadence.db` SQLite database file on local disk.
- Acquires synchronization locks on database connection handles.

## Verification
- Run: `cargo test`
