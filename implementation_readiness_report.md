# Stage 9: Implementation Readiness Test Report

**Status:** resolved
*   **Target Document:** `docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md`
*   **Target Scope:** `DetailedRange` (Lines 330–511)
*   **Reviewers:** 
    *   Implementation Readiness Lead (`egm-implementation-readiness`)
    *   Codebase Details Compliance Auditor (`egm-codebase-details`)
    *   Style Copy Editor (`egm-style`)
*   **Evaluation Standards:** `resources/document_standards/implementation-readiness-standard.md`
*   **Date:** 2026-10-27

---

## Executive Assessment

The implementation plan provides an exhaustive, 20-file inventory spanning the native Rust backend, domain hooks, shell layout, and detail reconciliation views. File rationales and proposed changes are actionable and accurately reflect observed codebase defects (e.g. `VirtualDataTable.tsx` duration float and `FocusedWorkbench.tsx` candidate selection).

To satisfy the Zero-Decision Rule and ensure ground-truth alignment with the native Rust codebase, the file mapping for the database layer must be updated to target `src-tauri/src/db/schema.rs`, `src-tauri/src/db/operations.rs`, and `src-tauri/src/commands/library.rs` instead of the non-existent `src-tauri/src/db.rs`, and exact IPC method signatures must be declared.

---

## Findings

### Finding 1: File Drift on Native Rust SQLite Database Architecture
*   **Reviewer:** `egm-codebase-details`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Implementation Plan File 5 (`src-tauri/src/db.rs`, lines 357–363)
*   **Discrepancy Description:** 
    The implementation plan lists `src-tauri/src/db.rs` as the target for DDL migration and database operations. In the actual codebase, `src-tauri/src/db/` is a multi-file module:
    *   `src-tauri/src/db/schema.rs` houses database initialization and table migrations (`init_db_schema`).
    *   `src-tauri/src/db/operations.rs` houses concrete SQLite CRUD operations.
    *   `src-tauri/src/commands/library.rs` houses Tauri IPC command handlers.
*   **Actionable Recommendation:** 
    Split File 5 into:
    *   `src-tauri/src/db/schema.rs`: Add DDL for `user_split_releases (release_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`.
    *   `src-tauri/src/db/operations.rs`: Add `insert_split_release`, `delete_split_release`, and `get_all_split_releases`.
    *   `src-tauri/src/commands/library.rs`: Add Tauri command wrappers `db_set_release_split`, `db_remove_release_split`, and `db_get_split_releases`.

---

### Finding 2: Zero-Decision Gap for Tauri IPC and Grouping Service Signatures
*   **Reviewer:** `egm-implementation-readiness`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Files 4 & 7 (`src/services/albumGroupingService.ts` and `src/services/tauriBridge.ts`, lines 350–356 and 371–377)
*   **Discrepancy Description:** 
    The plan describes creating `albumGroupingService.ts` and updating `tauriBridge.ts`, but omits the exact TypeScript method signatures. An implementer must guess parameter types and return contracts.
*   **Actionable Recommendation:** 
    Document the explicit method signatures in the plan:
    ```typescript
    // src/services/tauriBridge.ts
    export async function dbSetReleaseSplit(releaseId: string): Promise<void>
    export async function dbRemoveReleaseSplit(releaseId: string): Promise<void>
    export async function dbGetSplitReleases(): Promise<string[]>

    // src/services/albumGroupingService.ts
    export interface GroupedReleaseCard {
      masterRelease: Release
      constituentReleases: Release[]
      discCount: number
      isSplit: boolean
    }
    export function groupAlbumReleases(
      releases: Release[],
      splitReleaseIds: Set<string>
    ): GroupedReleaseCard[]
    ```

---

### Finding 3: Exact State Binding in FocusedWorkbench Artwork Selection
*   **Reviewer:** `egm-style` & `egm-implementation-readiness`
*   **Severity:** 🟢 Nit
*   **Affected Scope:** File 13 (`src/components/CenterStage/FocusedWorkbench.tsx`, lines 415–424)
*   **Discrepancy Description:** 
    The plan states candidate selection binds to `selectedArtworkId === art.id`, but does not declare the state variable initialization.
*   **Actionable Recommendation:** 
    Explicitly specify:
    ```typescript
    const [selectedArtworkId, setSelectedArtworkId] = useState<string>('local')
    ```
    and bind `onClick={() => setSelectedArtworkId(art.id)}` with candidate `id` strings `'local' | 'apple' | 'musicbrainz'`.
