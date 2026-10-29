# Asynchronous Background Commit Queue with Playback Preemption

* **Author:** EGM Swarm Synthesizer & Elephant Partner
* **Date:** 2026-10-29
* **Target System:** Cadence Audio Engine & Desktop Core Architecture

## Overview

Cadence currently locks all application interactions behind a blocking full-screen modal (`TwoPhaseCommitModal.tsx`) while writing metadata changes to storage. In large batch curation sessions (such as 489 tracks across multiple boxed sets), this lock lasts up to an hour. During this window, the user cannot browse the library, edit other albums, or listen to music without aborting the pending transaction.

This feature decouples the review process from the physical disk write. When the user approves staged edits in the commit screen, preflight checks complete in under one second, the modal dismisses immediately, and the transaction is handed off to an asynchronous native Rust background worker backed by SQLite persistence. Disk operations execute only when audio playback has been silent for at least 30 seconds (satisfying the Global Storage Bus Silence invariant). If playback begins, writes yield at the current track boundary. Progress, throughput, and transport diagnostics surface via an Apple HIG-compliant status pill in the top header.

## Analysis

### 1. Audiophile Transport & Invariant Conflicts (ISSUE-01: Blocker)
* **The Conflict:** Global Invariant 1 dictates zero disk I/O on library drives while playback is active or within a 30-second cooldown window. Offering an unconstrained user toggle to "force commit during playback" introduces storage controller and bus contention, DPC latency jitter, and cache eviction risks while WASAPI Exclusive streaming is active.
* **The Resolution (Purity Mode Interlock):** 
  * In **Purity Mode** (WASAPI Exclusive, memory-pinned buffers): Force-commit is strictly locked. The background worker halts writes whenever audio is playing and enforces the 30-second cooldown without exception.
  * In **Shared/Standard Mode**: The user may manually override the queue to write during playback, but must first accept an explicit warning modal detailing possible audio dropouts.

### 2. Execution Ownership & Process Durability (ISSUE-02: Blocker)
* **The Risk:** Running a 56-minute background batch inside the React renderer layer (`transactionEngine.ts`) is structurally unsound. If the user navigates views, triggers a webview reload, or minimizes the client, the JavaScript promise chain can terminate abruptly mid-write, creating orphaned sidecars or corrupt file headers.
* **The Resolution:** All queue orchestration, file locks, atomic renames, and tag encoders are moved to native Rust (`src-tauri/src/maintenance/commit_worker.rs`). The queue is persisted in SQLite with WAL logging (`commit_queue_batches` and `commit_queue_items`). Telemetry updates emit to the frontend at 4 Hz to avoid React re-render thrashing.

### 3. Concurrent Storage Operations (ISSUE-03: Major)
* **The Risk:** If the background library scanner (`ScannerController`) runs a folder rescan while the commit worker is rewriting audio files on the same drive, race conditions occur: files are scanned with partial headers, `mtime` clocks desynchronize, and false corruption alerts are triggered.
* **The Resolution:** Establish an inter-thread mutual exclusion lock. The library scanner pauses directory sweeps on any mount currently being modified by the commit worker.

### 4. Application Exit & Crash Recovery (ISSUE-04: Major)
* **The Risk:** If the application terminates while writes are in flight or pending, files could be corrupted and queued work lost.
* **The Resolution:**
  * Intercept window close (`CloseRequested` in Tauri). If items remain in the queue, present an Apple HIG confirmation sheet offering to *Quit & Resume Later* (preserving SQLite queue state) or *Wait for Queue to Finish*.
  * Employ an atomic file replace pattern: write to `.cadence-tmp-[uuid]`, verify stream CRC, and replace the destination via Win32 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`. On launch, any orphaned temporary files are cleaned up and `in_flight` items reset to `pending`.

### 5. Catalog Truth & Apple HIG Presentation (ISSUE-05 & ISSUE-06: Major / Nit)
* **The Risk:** Showing queued edits as "Staged" creates user confusion over whether edits were actually approved. Conversely, displaying unmodified disk tags makes the save appear to have failed.
* **The Resolution:**
  * Adopt a 4-state lifecycle: `Staged` (draft/mutable) -> `Queued` (approved, persisted in SQLite, awaiting silence) -> `In-Flight` (writing) -> `Committed` (finalized on disk).
  * CenterStage and virtual table rows reflect newly approved metadata optimistically, decorated with a discrete "Queued for Storage" status badge.
  * A persistent status pill in the top header indicates queue state (active, paused for playback, or completed) and expands on hover to display throughput, in-flight track details, and manual controls.
  * Re-editing a queued item updates the queued payload in-place if pending, or stages a follow-up item if the track is actively in-flight.

## Goals vs. Non-Goals

### In-Scope Goals
* **G1: Native SQLite-Persisted Queue:** Complete persistence for batch metadata jobs surviving application restarts, window closures, and crashes.
* **G2: Deterministic Preemption with 30s Cooldown:** Zero disk I/O on music storage while playback is active plus 30 seconds of cooldown, pausing cleanly at atomic track boundaries.
* **G3: Purity-Aware Force Commit Interlock:** Enforced lock preventing disk writes during WASAPI Exclusive playback, with an optional override restricted to shared audio mode.
* **G4: Optimistic Catalog Presentation:** Immediate reflection of approved metadata across the catalog with clear "Queued for Storage" indicators.
* **G5: Apple HIG Status Pill & Diagnostics:** Compact top bar status pill displaying throughput, countdown timers, hover diagnostics, and safe window exit prompts.

### Out-of-Scope Non-Goals
* **NG1: Loading Full Audio Streams into RAM:** Metadata writes stream directly through temp files on the target storage mount; files are not pinned into RAM.
* **NG2: Read-Only Storage Queueing:** Storage mounts marked read-only fail fast in preflight checks and cannot be queued.
* **NG3: Parallel Concurrent Writers per Mount:** Disk writes execute sequentially per physical mount to prevent storage head thrashing and acoustic drive chatter.

## Key Decisions & Staging for Next Steps

1. **Move Execution from Frontend to Native Rust:** Deprecate the in-renderer batch write loop in `transactionEngine.ts`. Implement `CommitQueueWorker` in `src-tauri` running on a dedicated thread with `THREAD_PRIORITY_BELOW_NORMAL` and `THREAD_MODE_BACKGROUND_BEGIN`.
2. **Purity Mode Enforcement:** Prohibit force-commit overrides when Purity Mode is active to preserve the storage bus silence invariant.
3. **Database Schema:** Add `commit_queue_batches` and `commit_queue_items` tables with state tracking for crash recovery.
4. **Header Status Integration:** Build `CommitStatusPill.tsx` for the top navigation bar to replace modal-bound execution monitoring.
