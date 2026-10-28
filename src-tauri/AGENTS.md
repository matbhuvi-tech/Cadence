# Native Tauri Application Blueprint (`src-tauri`)

## Overview
Houses the native Rust application project configured with Tauri v2. Provides the system-level foundation for bit-perfect audio playback, hardware device communication, SQLite persistence, and local network remote services.

## Local Interface & Invariants
- `Cargo.toml`: Package manifest defining native dependencies (rusqlite, rodio/cpal, windows, tauri, tokio, parking_lot).
- `build.rs`: Build script invoking `tauri_build::build()`.
- `tauri.conf.json`: Tauri application configuration specifying window dimensions, bundle identifiers, security capabilities, and permissions.

## Subdirectories & System Boundaries
- [src](./src/AGENTS.md): Native application source tree (Audio Engine, Commands including `db_update_canonical_artist_editorial`, DB Operations, Maintenance, Remote, Scanner).

## Global Invariants
- Must compile cleanly against Windows 10/11 x86_64 target with MSVC toolchain.
- Native capabilities must adhere strictly to principle of least privilege in `capabilities/default.json`.

## System Verification
- Run: `cargo test`
