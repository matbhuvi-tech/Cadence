# Initial Zoom Out Review Report

**Target:** `docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md` (Lines 1–511)
**Reviewer Lens:** `egm-zoom-out`
**Standard:** `resources/document_standards/zoom-out-standard.md`

## Executive Summary
The design document directly targets the root problems identified by the user: fragmented editing workflows, inverted Indian music credit attribution, pressing edition splitting, uncoordinated cover art automation, and inaccurate dynamic range metrics. The architecture achieves strong simplification by decommissioning `CustomizeAlbumModal.tsx` (~1,000 lines) and stripping non-playback inspection tools from `UnifiedRightSidebar.tsx`. However, several implementation details introduce abstraction leaks or reference non-existent services that must be grounded in the active codebase.

---

## Prioritized Findings

### Issue 1: Phantom File Reference for Catalog Search - Severity: Major
* **Reviewer Lens:** `egm-zoom-out` / `egm-codebase-details`
* **Affected Scope:** Lines 433, 487–489
* **Discrepancy Description:** The design specifies creating/modifying `src/services/searchEngine.ts` to index composer and track artists. In the actual Cadence codebase, `src/services/searchEngine.ts` does not exist. Catalog search is divided between client-side in-memory filtering in `src/components/CenterStage/AlbumCoverGrid.tsx` (`filtered = cards.filter(...)`) and SQLite FTS queries in `src/services/sqliteLibraryService.ts` / `tauriBridge.ts` (`db_search_catalog`).
* **Rationale & Recommendation:** Eliminate the speculative `searchEngine.ts` entry. Explicitly target `AlbumCoverGrid.tsx` (to include `album.tracks.some(t => t.artistCredit.includes(q))` in the filter loop) and `sqliteLibraryService.ts` (`searchCatalog`).

### Issue 2: Algorithmic Incongruity in `computeGroupingKey` - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 272–285, 432, 491–495
* **Discrepancy Description:** The plan states that `computeGroupingKey(release: Release)` will compute Jaro-Winkler similarity ($\ge 0.88$) against candidate titles. However, `computeGroupingKey` is a unary, pure hashing function ($Release \to string$). A unary function cannot calculate pairwise similarity between two releases in isolation unless it generates a canonical stem or operates within the grouping reduction loop in `groupAlbumReleases`.
* **Rationale & Recommendation:** Update the architecture: `computeGroupingKey` should generate a sanitized base stem (stripping rip flags, disc markers, and punctuation). The fuzzy Jaro-Winkler clustering loop ($\ge 0.88$) with track count and duration guards must execute inside `groupAlbumReleases(releases: Release[])` as an agglomerative clustering pass across candidate groups.

### Issue 3: Dangling Inspector Triggers Across the Shell - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 144–151, 426, 453–458
* **Discrepancy Description:** Stripping the `inspector` tab from `UnifiedRightSidebar` leaves orphaned triggers in `App.tsx` (e.g., keyboard shortcut `⌘I` and `handleInspectRelease`) and `AlbumCoverGrid.tsx` line 575 (`onInspectRelease`).
* **Rationale & Recommendation:** Specify in Step 2 of the implementation plan that `⌘I` and `onInspectRelease` are either repurposed to trigger Curate navigation (`navigateToCurate`) or cleanly unmounted to prevent dead keybindings.
