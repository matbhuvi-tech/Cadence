# Curation Package (`src-tauri/src/curation`)

## Overview
Houses the album metadata curation storage, identity snapshotting, and decision trace models for Cadence. Manages diagnostic snapshots, evidence runs, draft versions, and bit-perfect playback-guarded curation traces.

## Interface
- `CurationStorage`: Engine providing storage, retrieval, and SQLite persistence for curation evidence runs, drafts, and decision traces.
  - `get_identity`: Fetches snapshot identities for local tracks.
  - `save_evidence`: Persists diagnostic evidence runs, mapping candidates, and source candidates to SQLite.
  - `list_evidence`: Lists historical evidence runs for an album.
  - `get_evidence`: Fetches a specific evidence run payload.
  - `save_draft`: Records draft edits and stores active album curation drafts.
  - `get_draft`: Retrieves active staged or unstaged draft for an album.
  - `save_trace`: Saves curation decision trace with audiophile idle-guarding and field-level merge semantics.
  - `get_trace`: Retrieves latest trace, checking the in-memory RAM buffer first, then falling back to SQLite.
  - `clear_trace`: Deletes trace from both RAM buffer and SQLite.
- `CurationDecisionTrace`: Struct representing decision outcome status, headline summary, field traces, candidate telemetry, and album matching metadata.
- `FieldDecision`: Struct tracking action, chosen value, consensus ratio, explanation, and confidence score per metadata field.
- `CandidateTelemetry`: Provider resolution latency, status, candidate track counts, and rejection reasons.

## Invariants
- Zero Disk I/O during playback: If `AudioEngine` is `Playing` or `Paused`, `save_trace` MUST buffer traces in `MEMORY_BUFFER` (RAM) without performing SQLite queries or disk I/O.
- RAM buffer is flushed to SQLite only when the audio engine transitions to idle.
- Field-level merge semantics: incoming field decisions merge into existing traces rather than wiping untouched fields.
- Evidence runs enforce chronological ordering; only the latest completed decision is marked current.

## Side Effects
- Holds buffered traces in memory via static `MEMORY_BUFFER: LazyLock<Mutex<HashMap<String, CurationDecisionTrace>>>`.
- Mutates `curation_evidence_runs`, `curation_current_evidence`, `curation_drafts`, `curate_identity_mappings`, and `curation_decision_traces` SQLite tables.

## Verification
- Run: `cargo test --manifest-path src-tauri/Cargo.toml`

