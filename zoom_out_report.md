# Stage 5: Initial Zoom Out Review Report

*   **Target Document:** `docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md`
*   **Evaluator:** Skeptical Architect (`egm-zoom-out`)
*   **Evaluation Standard:** `resources/document_standards/zoom-out-standard.md`
*   **Date:** 2026-10-27

---

## Executive Assessment

The design document demonstrates strong alignment with Cadence's core objectives: eliminating UI navigation redundancy, preventing storage bus stalls over SMB network shares, and restoring deterministic data presentation without compromising audiophile transport purity. 

The architecture successfully avoids touching native audio playback threads, memory pinning (`VirtualLock`), or packet pacing. However, there are opportunities to reduce architectural fragmentation and avoid premature modularization in state persistence and database schemas.

---

## Findings

### Finding 1: Standalone Hook Over-Abstraction for Single-Component State
*   **Severity:** 🟡 Major
*   **Affected Scope:** Section 5.C (`useInspectorPersistence`) & Implementation File 3 (`src/hooks/useInspectorPersistence.ts`)
*   **Simplicity Rationale:** 
    The proposed `useInspectorPersistence` hook is designed solely to persist the collapsed state of the right-hand details inspector in `FocusedWorkbench.tsx`. Creating a standalone domain hook file (`src/hooks/useInspectorPersistence.ts`) for reading and writing a single `localStorage` key (`cadence_curate_inspector_collapsed`) introduces unnecessary file sprawl and module boundaries. 
*   **Recommended Simplification:** 
    Inline the viewport width check and `localStorage` synchronization directly within `FocusedWorkbench.tsx` (or expand the existing view layout state if multiple components need inspector persistence).

---

### Finding 2: Asynchronous SQLite Split Query in Synchronous Album Grid Pipeline
*   **Severity:** 🟡 Major
*   **Affected Scope:** Section 4.B (`User Split Overrides via SQLite`) & Implementation File 4 (`src/services/albumGroupingService.ts`)
*   **Simplicity Rationale:** 
    The design specifies querying SQLite (`tauriBridge.dbGetSplitReleases()`) to determine whether a multi-disc release should be grouped or unpacked. In `AlbumCoverGrid.tsx`, album card rendering and sorting operate synchronously in memory. Executing an asynchronous database call inside the grouping function introduces layout flashes, async state management overhead, or unnecessary memoization churn.
*   **Recommended Simplification:** 
    Pre-load the set of `splitReleaseIds: Set<string>` into the top-level `LibraryContext` or store state alongside the initial catalog load, and pass it as a pure in-memory set to the grouping function. Furthermore, evaluate whether a dedicated SQLite table (`user_split_releases`) is truly simpler than storing a `is_split` flag in the existing release metadata or sidecar structure.

---

### Finding 3: Tree Compaction Data Structure Complexity
*   **Severity:** 🟢 Nit
*   **Affected Scope:** Section 3.B (`In-Place Folder Tree Filtering`) & Implementation File 12 (`src/components/CenterStage/FolderTreeExplorer.tsx`)
*   **Simplicity Rationale:** 
    Compacting single-child linear directory chains (e.g., `NAS / Music / Lossless / Master` -> `NAS: Master`) must not mutate or re-index the underlying recursive virtual tree nodes, as that risks breaking node path resolution and SMB mounting references.
*   **Recommended Simplification:** 
    Enforce that path compaction operates strictly as a presentation-layer display label calculation during tree node rendering, leaving the underlying `TreeNode` identity and parent-child hierarchy untouched.

---

## Verdict & Next Steps

The overall high-level architecture is solid, solves real user friction, and preserves transport boundaries. Proceeding with the noted simplifications will prevent unnecessary file proliferation and keep the render loop synchronous.
