# Goldfish Annotated Review Report

**Status:** resolved
**Target:** `docs/designs/ASYNCHRONOUS_BACKGROUND_COMMIT_QUEUE_ARCHITECTURE.md` (`full file`)
**Applied Fixes:** 11 accepted, 0 contested, 0 remaining

## Prioritized Findings & Applied Resolutions

### 1. [CQ-01] Playback Paused Transport Invariant Gap - Severity: High (RESOLVED)
*   **Resolution:** Updated Section 3 preemption loop and Goal G2 to check `AudioEngine::is_playing() || AudioEngine::is_paused()`. The 30-second silent cooldown is strictly measured after audio has fully stopped.

### 2. [CQ-02] Status Pill Embedded in Modal Command Palette - Severity: High (RESOLVED)
*   **Resolution:** Retargeted File 13 from `OmniCommandBar.tsx` to `src/App.tsx` (lines 1665-1670), mounting `CommitStatusPill` in the persistent top header beside `ActivityPill`.

### 3. [CQ-03] Temp Audio Files Trigger Scanner Storms - Severity: High (RESOLVED)
*   **Resolution:** Added `*.cadence-tmp-*` to the global scanner ignore filter in `src-tauri/src/scanner/engine.rs`.

### 4. [CQ-04] Upsert Re-edits Overwrite Prior Unwritten Tags - Severity: Medium (RESOLVED)
*   **Resolution:** Implemented `json_patch(commit_queue_items.payload_json, excluded.payload_json)` in SQLite DDL/upsert and decremented `total_tracks` in the vacated batch envelope.

### 5. [CQ-05] Missing `expected_crc` in SQLite Schema - Severity: Medium (RESOLVED)
*   **Resolution:** Added `expected_crc TEXT` column to `commit_queue_items` table in `src-tauri/src/db/schema.rs`.

### 6. [CQ-06] CPU Affinity Mask Hard Failure on $\le 2$ Core CPUs - Severity: Medium (RESOLVED)
*   **Resolution:** Added adaptive check `if num_cpus::get() > 2` before masking Core 0/1; on $\le 2$ core hardware, runs with default affinity under low thread priority.

### 7. [CQ-07] Sidecar Destination Pipeline Unspecified in Worker Loop - Severity: Medium (RESOLVED)
*   **Resolution:** Added explicit sidecar write branch in Section 3 and File 3: loads `cadence-album.sidecar.json`, deep-merges payload, streams to temp file, and performs atomic rename.

### 8. [CQ-08] Win32 `WM_DEVICECHANGE` UI-to-Worker Bridge Gap - Severity: Medium (RESOLVED)
*   **Resolution:** Added Win32 window message hook in `src-tauri/src/lib.rs` that dispatches volume change signals to the worker loop over a channel.

### 9. [CQ-09] Zustand Store Misnomer for `useStagedChanges` - Severity: Low (RESOLVED)
*   **Resolution:** Corrected terminology in Section 1 and File 11 to React Hook / State Coordinator (`useMemo`).

### 10. [CQ-10] Cyan Indicator Conflicts with Search Result Highlighting - Severity: Low (RESOLVED)
*   **Resolution:** Updated `Saving Pending` indicator from solid cyan dot to a clock glyph badge with subtle slate/cyan border.

### 11. [CQ-11] Redundant Window Close Confirmation on Durable WAL - Severity: Low (RESOLVED)
*   **Resolution:** Streamlined window exit flow to allow immediate close backed by SQLite WAL persistence, showing a toast on next launch.
