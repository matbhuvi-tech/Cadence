# Consolidated Goldfish Review Report

**Target Document:** `docs/designs/ASYNCHRONOUS_BACKGROUND_COMMIT_QUEUE_ARCHITECTURE.md`
**Semantic Scope:** FeatureRange (lines 1..305), DetailedRange (lines 306..431)
**Execution Mode:** `CONSOLIDATED_FULL_FLOW` / `REVIEW`
**Lenses Executed:** `egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-structural`, `egm-style`, `egm-implementation-readiness`, `egm-codebase-details`

---

## Executive Summary & Severity Breakdown

The multi-stage review audit evaluated the technical design against codebase reality, audiophile transport invariants, systems architecture, and Apple HIG ergonomics.

* 🔴 **Blockers (3)**: Critical defects violating global invariants, referencing non-existent UI placement, or inducing scanner corruption loops.
* 🟡 **Majors (5)**: Subsystem gaps including missing schema columns, dual-core CPU crashes, and incomplete sidecar paths.
* 🟢 **Nits (3)**: Semantic naming precision and micro-visual adjustments.

---

## Prioritized Findings (Blockers -> Major -> Nits)

### 🔴 Blockers

#### 1. [CQ-01] Playback Paused Transport Invariant Gap
* **Reviewer Lens:** `egm-zoom-out`, `egm-implementation-readiness`
* **Affected Scope:** Lines 27-29, 173-184, 333-334
* **Discrepancy Description:** The worker loop checks only `AudioEngine::is_playing() == true`. In `src-tauri/src/audio/player.rs` (line 527), when audio is paused via `AudioWorkerMsg::Pause`, `is_playing_atomic` is set to `false`. If the user pauses audio, the worker will evaluate `is_playing() == false`, wait for 30 seconds of "silence", and begin writing to audio files that remain open in WASAPI Exclusive or rodio. This directly breaches **Cadence Global Invariant 1** (*Storage Bus Silence During Playback*) and triggers Win32 `ERROR_SHARING_VIOLATION`.
* **Rationale & Recommendation:** The guard condition must strictly verify `(!is_playing && !is_paused && cooldown_elapsed)`. The 30-second silent cooldown must only start after audio playback has stopped completely.

#### 2. [CQ-02] Status Pill Embedded in Modal Command Palette
* **Reviewer Lens:** `egm-codebase-details`, `egm-design`
* **Affected Scope:** Lines 80, 248, 395-397
* **Discrepancy Description:** The design targets `OmniCommandBar.tsx` for `CommitStatusPill.tsx`. In the Cadence codebase, `OmniCommandBar.tsx` is an on-demand modal palette (`isOpen: boolean`) triggered by `⌘K`, not the persistent top header. Embedding the pill there hides it from user view during normal catalog playback.
* **Rationale & Recommendation:** Retarget Target File 13 from `OmniCommandBar.tsx` to `src/App.tsx` (lines 1665-1670), mounting `CommitStatusPill` directly inside the global top header beside `ActivityPill`.

#### 3. [CQ-03] Temporary Files Trigger Scanner Storms & False Corruptions
* **Reviewer Lens:** `egm-codebase-details`, `egm-zoom-out`
* **Affected Scope:** Lines 188-192, 335, 354
* **Discrepancy Description:** Streaming tag payloads into `[filePath].cadence-tmp-[uuid]` inside music directories triggers directory change notifications. `ScannerController` in `src-tauri/src/scanner/engine.rs` monitors library folders and will trigger a scan on these temporary files, causing bus contention, read collisions, and false CRC corruption alerts.
* **Rationale & Recommendation:** Update `ScannerController` and `watched_folders.ignore_patterns` to explicitly ignore `*.cadence-tmp-*` patterns before starting background writes.

---

### 🟡 Majors

#### 4. [CQ-04] Upsert Re-edits Overwrite Prior Unwritten Tags & Corrupt Batch Counters
* **Reviewer Lens:** `egm-structural`, `egm-comprehension`
* **Affected Scope:** Lines 147-156, 321-322
* **Discrepancy Description:** The upsert clause `DO UPDATE SET payload_json = excluded.payload_json, batch_id = excluded.batch_id` replaces the payload entirely. If a re-edit modifies only a single tag (e.g., Year), previous unwritten staged edits (e.g., Track Title) are discarded. Furthermore, moving `batch_id` to a new batch corrupts the original batch's `total_tracks` count.
* **Rationale & Recommendation:** Implement JSON merge patching in SQLite/Rust for `payload_json`, and decrement `total_tracks` in the vacated batch envelope.

#### 5. [CQ-05] Missing `expected_crc` / Stream Hash in SQLite Schema
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-comprehension`
* **Affected Scope:** Lines 119-133, 190, 312
* **Discrepancy Description:** Step 7 requires verifying that the audio stream CRC matches the pre-commit hash before performing atomic replacement. However, `commit_queue_items` (lines 119-133) has no `expected_crc` or `stream_hash` column.
* **Rationale & Recommendation:** Add `expected_crc TEXT` to `commit_queue_items` in `src-tauri/src/db/schema.rs`.

#### 6. [CQ-06] CPU Affinity Mask Hard Fails on Dual-Core Hardware ($\le 2$ Cores)
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Lines 96, 302, 332
* **Discrepancy Description:** Setting a thread affinity mask away from Core 0 and Core 1 on dual-core CPUs produces an empty bitmask (`0x0`), causing `SetThreadAffinityMask` to fail and crashing the worker thread on initialization.
* **Rationale & Recommendation:** Add an adaptive core guard: only mask away Core 0 and Core 1 if `num_cpus::get() > 2`.

#### 7. [CQ-07] Sidecar Destination Pipeline Unspecified in Native Worker Loop
* **Reviewer Lens:** `egm-comprehension`, `egm-structural`
* **Affected Scope:** Lines 111, 163-194, 329
* **Discrepancy Description:** The technical loop exclusively details streaming audio file headers and Win32 file renaming. The mechanics of reading, merging, and writing `cadence-album.sidecar.json` in native Rust are completely undefined.
* **Rationale & Recommendation:** Document the sidecar writing branch in Section 3 and Section 14 (File 3).

#### 8. [CQ-08] Win32 `WM_DEVICECHANGE` UI-to-Worker Bridge Gap
* **Reviewer Lens:** `egm-zoom-out`, `egm-codebase-details`
* **Affected Scope:** Lines 41, 336
* **Discrepancy Description:** Win32 `WM_DEVICECHANGE` messages are received by the window message procedure on the main UI thread, not by worker threads. The design lacks a bridge connecting window events to the worker loop.
* **Rationale & Recommendation:** Add a window message listener in `src-tauri/src/lib.rs` that forwards volume arrival/removal events to the worker thread via a crossbeam/mpsc channel.

---

### 🟢 Nits

#### 9. [CQ-09] Zustand Store Misnomer for `useStagedChanges`
* **Reviewer Lens:** `egm-codebase-details`, `egm-style`
* **Affected Scope:** Lines 78, 381-387
* **Discrepancy Description:** `useStagedChanges` is described as a Zustand store, but is actually a React hook using `useMemo`.
* **Rationale & Recommendation:** Correct technical terminology in Section 1 and File 11.

#### 10. [CQ-10] Cyan Indicator Conflicts with Search Result Highlighting
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** Line 244
* **Discrepancy Description:** Using a static cyan dot for `Saving Pending` clashes with Electric Cyan (`#00F5FF`) used across Cadence for search keyword matches.
* **Rationale & Recommendation:** Use a distinct micro-icon (e.g. clock/arrow glyph) or muted indigo tint to avoid color collision.

#### 11. [CQ-11] Redundant Window Close Confirmation on Durable WAL
* **Reviewer Lens:** `egm-design`, `egm-zoom-out`
* **Affected Scope:** Lines 259-263
* **Discrepancy Description:** Presenting a 3-choice modal on window close adds unnecessary friction when WAL durability already guarantees safe resumption.
* **Rationale & Recommendation:** Default to immediate clean close; display a brief toast notification on next application launch.

---

## Traceability Matrix

| Finding ID | Title | Severity | Reviewer Lens | Stage | Affected Lines | Status / Action |
|---|---|---|---|---|---|---|
| **CQ-01** | Playback Paused Transport Invariant Gap | 🔴 Blocker | `egm-zoom-out`, `egm-implementation-readiness` | 5, 8, 9 | 173-184, 27-29 | Guard must check `(!is_playing && !is_paused && cooldown_elapsed)` |
| **CQ-02** | Status Pill Embedded in Modal Command Palette | 🔴 Blocker | `egm-codebase-details`, `egm-design` | 7, 9 | 80, 248, 395-397 | Retarget target file from `OmniCommandBar.tsx` to `App.tsx` header |
| **CQ-03** | Temp Audio Files Trigger Scanner Storms | 🔴 Blocker | `egm-codebase-details`, `egm-zoom-out` | 5, 9 | 188-192, 335, 354 | Add `*.cadence-tmp-*` to global scanner ignore pattern |
| **CQ-04** | Upsert Re-edits Overwrite Prior Edits & Orphan Counts | 🟡 Major | `egm-structural`, `egm-comprehension` | 6, 7 | 147-156, 321-322 | Implement JSON deep merge and dynamic batch count decrement |
| **CQ-05** | Missing `stream_hash` / CRC in SQLite Schema | 🟡 Major | `egm-implementation-readiness`, `egm-comprehension` | 6, 9 | 119-133, 190, 312 | Add `expected_crc TEXT` column to `commit_queue_items` |
| **CQ-06** | CPU Affinity Mask Hard Failure on $\le 2$ Core CPUs | 🟡 Major | `egm-implementation-readiness`, `egm-codebase-details` | 9 | 96, 302, 332 | Add adaptive logical core check (`num_cpus > 2`) |
| **CQ-07** | Sidecar Destination Pipeline Unspecified in Loop | 🟡 Major | `egm-comprehension`, `egm-structural` | 6, 7 | 111, 163-194, 329 | Specify JSON sidecar writing branch in `commit_worker.rs` |
| **CQ-08** | Win32 `WM_DEVICECHANGE` UI-to-Worker Bridge Gap | 🟡 Major | `egm-zoom-out`, `egm-codebase-details` | 5, 8, 9 | 41, 336 | Bridge window message hook in `lib.rs` to worker mpsc channel |
| **CQ-09** | Zustand Store Misnomer for `useStagedChanges` | 🟢 Nit | `egm-codebase-details`, `egm-style` | 7, 9 | 78, 381-387 | Update spec terminology: hook is React `useMemo`, not Zustand |
| **CQ-10** | Cyan Indicator Conflicts with Search Highlighting | 🟢 Nit | `egm-design`, `egm-style` | 7 | 244 | Use distinct icon/badge state to avoid search color clash |
| **CQ-11** | Redundant Window Close Interception on Durable WAL | 🟢 Nit | `egm-design`, `egm-zoom-out` | 5, 7 | 259-263 | Simplify window exit flow per Apple HIG |
