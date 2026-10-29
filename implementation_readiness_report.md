# Implementation Readiness Review Report

**Target:** `docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md` (Lines 414–511, Detailed Implementation Plan)
**Reviewer Lenses:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
**Standard:** `resources/document_standards/implementation-readiness-standard.md`

## Executive Summary
The implementation plan is structured sequentially with explicit file ledgers and verification cases. To ensure zero-friction execution by an autonomous implementation agent, four concrete adjustments are required: correcting the search file path, updating the TypeScript type definition for bypassed DR scores, detailing the agglomerative grouping pass in `albumGroupingService.ts`, and unmounting orphaned inspector references.

---

## Prioritized Findings

### Issue 1: Phantom File Path in Impact Ledger - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details` / `egm-implementation-readiness`
* **Affected Scope:** Lines 420, 433, 487–489
* **Discrepancy Description:** The file ledger lists `src/services/searchEngine.ts`. This file does not exist in the repository. An autonomous implementer attempting to edit this path will encounter a file-not-found error.
* **Rationale & Recommendation:** Replace `src/services/searchEngine.ts` with `src/components/CenterStage/AlbumCoverGrid.tsx` (modifying the in-memory `filtered = cards.filter(...)` loop to evaluate `album.tracks.some(t => t.artistCredit?.toLowerCase().includes(q))`) and `src/services/sqliteLibraryService.ts` (`searchCatalog`).

### Issue 2: TypeScript Nullability Type Invariant for Bypassed DR - Severity: Blocker
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Lines 429, 444–446
* **Discrepancy Description:** The plan returns `{ drScore: null, source: 'bypassed' }` from `calculateDynamicRangeScore`. However, in `src/services/integrityScanner.ts` line 4 and `src/core/types.ts`, `drScore` is typed strictly as `number` (or `number | undefined`). Returning `null` without updating the interface will cause `tsc -b` compilation to fail during `npm run build`.
* **Rationale & Recommendation:** Explicitly add updating `IntegrityScanResult.drScore: number | null` in `integrityScanner.ts` and `Track.drScore?: number | null` in `src/core/types.ts` to Step 1 of the implementation sequence.

### Issue 3: Disconnected Grouping Signature in `albumGroupingService.ts` - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Lines 432, 491–495
* **Discrepancy Description:** Step 5 specifies updating `computeGroupingKey` to compute Jaro-Winkler similarity across candidate releases. Because `computeGroupingKey` accepts only a single `Release`, it cannot perform pairwise comparison.
* **Rationale & Recommendation:** Clarify in Step 5: `computeGroupingKey` strips rip tags and generates a base stem. The Jaro-Winkler comparison ($\ge 0.88$) and duration/count bounds are applied inside `groupAlbumReleases` during the map reduction loop across candidate group keys.

### Issue 4: Cleanup of Orphaned Inspector Callbacks in `App.tsx` - Severity: Nit
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Lines 426, 435, 453–463
* **Discrepancy Description:** `App.tsx` contains handlers for `handleInspectRelease` and keyboard shortcut `⌘I` that toggle `rightSidebarTab === 'inspector'`. When the inspector tab is removed from `UnifiedRightSidebar`, these triggers will result in dead state mutations.
* **Rationale & Recommendation:** Add an explicit instruction in Step 2: In `App.tsx`, remove the `'inspector'` branch from `rightSidebarTab` state and rewire `⌘I` to invoke `navigateToCurate` for the active release.
