# Unified Cross-Entity Catalog Filtering & Dynamic Language Shelf

* **Author:** Mathan
* **Date:** 2026-10-30

## Overview

Cadence users curate and browse multi-format, multi-language audiophile catalogs across four primary entity tabs: `Albums`, `Artists`, `Composers`, and `Tracks`. Currently, applying a filter from the top sub-toolbar or the slide-down Filter Shelf only scopes the `Tracks` list and the `Albums` grid cards, leaving the `Albums (N)`, `Artists (N)`, and `Composers (N)` tab badges, the `Artists` grid, and several Filter Shelf controls out of sync or non-functional.

This feature unifies catalog filtering so that every active filter (inline `⌘F` text filter, `Era`, `Format` including `24-bit Hi-Res`, dynamic `Language`, and `Review` status) strictly scopes the displayed items, tab badges, and card sub-counts (`X Albums · Y Tracks`) across `Albums`, `Artists`, `Composers`, and `Tracks`. It also replaces the unused `DYNAMICS:` filter row and `Dynamic Range (Avg DR)` sort option with a dynamically detected `LANGUAGE:` filter row, moves `24-bit Hi-Res` into the `FORMAT:` row, fixes decade matching for `ERA:` pills, and removes the duplicate search bar inside the `Artists` tab.

## Analysis

### 1. Scoped `displayedReleases`, Multi-Disc Grouping Parity, and Tab Badge Alignment
* **Codebase Finding**: In [`src/App.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L983-L990), `filteredTracks` applies `searchQuery`, `facets`, `selectedMountId`, and `selectedFolderFilter`, but `displayedReleases` only filters `releases` when `facets.reviewStatus === 'staged'`. For all other filters, `App.tsx` passes the full, unfiltered `releases` array into [`DataCanvas`](file:///e:/Mathan/Code/Music%20Agent/src/components/CenterStage/DataCanvas.tsx#L152-L174).
* **Multi-Disc & Entity Count Drift**:
  * `DataCanvas.tsx` displays `Albums (releases.length)` on the tab badge, whereas [`AlbumCoverGrid.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/CenterStage/AlbumCoverGrid.tsx#L181-L184) groups multi-disc albums via `groupAlbumReleases(releases, splitReleaseIds)`. If a 2-CD box set is in the filtered set, counting raw `releaseId`s causes the `Albums` tab to show `1` while the artist/composer card sub-count shows `2 Albums`.
  * `DataCanvas.tsx` computes `artistCount` using an inline `Set` loop that can drift by 1–2 counts from [`sqliteLibraryService.deriveCanonicalArtistsFromState(releases, tracks)`](file:///e:/Mathan/Code/Music%20Agent/src/services/sqliteLibraryService.ts#L1430), and computes `composerCount` without `.trim().toLowerCase()` normalization or track-level composer fallback.
* **Resolution**:
  * **Scoped `displayedReleases`**: In `App.tsx`, whenever `isGridFilterActive || Boolean(activeTriageFilter)` is true, filter `displayedReleases` to only those releases that have at least one matching track in `filteredTracks`.
  * **Grouped Master Release Count Everywhere**: Map constituent multi-disc `releaseId`s to their canonical grouped master release ID (via `groupAlbumReleases(releases, splitReleaseIds)`) inside `DataCanvas` (`Albums (N)` badge), `sqliteLibraryService.deriveCanonicalArtistsFromState(releases, tracks, splitReleaseIds)`, and `AlbumCoverGrid` (`composerGroups`), ensuring a 2-CD album counts as `1 Album` across the `Albums` tab badge, Artist cards, and Composer cards.
  * **Single Source of Truth for Tab Badges**: Compute `artistCount` in `DataCanvas.tsx` directly via `sqliteLibraryService.deriveCanonicalArtistsFromState(releases, tracks, splitReleaseIds).length` (filtered by active role if applicable) and compute `composerCount` using the exact case-insensitive composer grouping logic used by `AlbumCoverGrid.tsx`.

### 2. Zero-I/O Hybrid Artist Scoping & Active Detail Guard
* **Codebase Finding**: [`ArtistsView.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/CenterStage/ArtistsView.tsx#L157-L169) calls [`sqliteLibraryService.getCanonicalArtists(releases, tracks)`](file:///e:/Mathan/Code/Music%20Agent/src/services/sqliteLibraryService.ts#L1207-L1249). In Tauri desktop mode, `getCanonicalArtists` queries `tauriBridge.dbGetCanonicalArtists()` directly from SQLite and ignores the `releases` and `tracks` props passed from `DataCanvas`.
* **Audiophile Invariant 1 Compliance**: Running SQLite queries on every filter toggle or keystroke in `⌘F` would violate Global Invariant 1 (Storage Bus Silence During Playback).
* **Resolution**:
  * **In-Memory Hybrid Merge**: Cache the SQLite `canonical_artists` metadata map (`name.toLowerCase() -> { id, portraitUrl, portraitStatus, bioSummary, eraActive, mbid, appleArtistId, primaryRole }`) in `SqliteLibraryService`. Always compute artist membership and `albumsCount` / `tracksCount` in-memory from the passed `(releases, tracks, splitReleaseIds)` props via `deriveCanonicalArtistsFromState`, and merge cached SQLite portrait and editorial fields onto each derived artist summary.
  * **Scoped Artist Detail & Zero-Match Guard**: Scope `getCanonicalArtistDetail` to filter `discography` (grouped by master release) and `appearingTracks` against the passed `releases` and `tracks` props. If a user is viewing an Artist Detail page (or Composer/Artist drill-down in `AlbumCoverGrid.tsx`) and toggles a Filter Shelf pill (e.g., switching `Language: Tamil` to `Language: Malayalam`) such that the selected artist/composer has `0` matching tracks in the active filter intersection, automatically collapse the detail drill-down back to the parent `Artists` or `Composers` grid (or render a clean *"No tracks for [Artist] match the current filter"* state with a 1-click button to return to the grid).
  * **Single Top-Level Search Bar**: Remove the duplicate `Search artists...` input box and local `searchQuery` state inside [`ArtistsView.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/CenterStage/ArtistsView.tsx#L850-L859) so the sub-toolbar `Filter in-place (⌘F)` is the sole text filter across all four tabs.

### 3. Mount/Folder-Scoped Dynamic `LANGUAGE:` Row
* **Codebase Finding**: If `DataCanvas` computes available languages from `filteredTracks`, clicking `Tamil` hides the `Hindi` and `English` pills. Conversely, if the user selects a specific physical storage mount (`selectedMountId`) or folder (`selectedFolderFilter`) in the Left Rail, showing languages from unrelated mounts/folders creates zero-result pills for that storage scope.
* **Resolution**:
  * Compute a `mountAndFolderScopedTracks` slice in `App.tsx` (tracks filtered only by `selectedMountId` and `selectedFolderFilter`, before applying `searchQuery` or shelf `facets`) and pass it to `DataCanvas.tsx`.
  * Populate the `LANGUAGE:` row in `DataCanvas.tsx` dynamically from `mountAndFolderScopedTracks` via `t.language || detectLanguage(...)`, ordered by track count descending and omitting `0`-track languages. This keeps the language pills stable when toggling shelf facets (`Language`, `Format`, `Era`, `Review`, `⌘F`) while accurately reflecting the selected storage mount or folder.

### 4. Relocating `24-bit Hi-Res`, Removing `DYNAMICS:` / `dr_desc`, and Legacy State Cleanup
* **Codebase Finding**: `FEATURES.DYNAMIC_RANGE` is `false` in [`src/config/features.ts`](file:///e:/Mathan/Code/Music%20Agent/src/config/features.ts#L1-L3), yet `DataCanvas.tsx` renders the `DYNAMICS:` shelf row (`DR14+`, `DR12+`, `DR10+`, `24-bit Hi-Res`) and both `DataCanvas.tsx` and `AlbumCoverGrid.tsx` offer `Dynamic Range (Avg DR)` (`dr_desc`) in their Sort dropdowns. Additionally, [`matchesEra()`](file:///e:/Mathan/Code/Music%20Agent/src/core/taxonomyUtils.ts#L892-L914) ignores the decade strings (`'1960s'`–`'2020s'`) emitted by `DataCanvas.tsx`.
* **Resolution**:
  * **Remove `DYNAMICS:` Row & Relocate `24-bit Hi-Res`**: Remove the `DYNAMICS:` row from `DataCanvas.tsx`. Move `24-bit Hi-Res` into the `FORMAT:` row as a format/resolution pill (`val: '24-bit Hi-Res'`) and support `'24-BIT HI-RES'` / `'HIGH_RES_24BIT'` in `matchesFormat()` in `src/core/taxonomyUtils.ts`.
  * **Defensive State & `dr_desc` Cleanup**: Remove `dr_desc` from the `SortBy` union type and Sort dropdowns in `DataCanvas.tsx` and `AlbumCoverGrid.tsx`. Add a defensive guard so any persisted or external `sortBy === 'dr_desc'` falls back to `'year_desc'` (or `'title_asc'`), and strip any legacy DR values (`audiophile_dr14`, `audiophile_dr12`, `standard_dr10`, `high_dr10_13`, `compressed_dr_low`) from `facets.mastering` and `isGridFilterActive` so stale state never traps the user in an empty view.
  * **Fix Era Decade Matching**: Extend `matchesEra(year, eraBucket)` in `src/core/taxonomyUtils.ts` to handle `'1960s'`, `'1970s'`, `'1980s'`, `'1990s'`, `'2000s'`, `'2010s'`, and `'2020s'` alongside legacy range keys, and check `t.pendingSidecarEdits?.year || rel?.releaseYear || rel?.originalYear` in `graphEngine.ts`.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Make `Filter in-place (⌘F)`, `Era`, `Format` (including `24-bit Hi-Res`), `Language`, and `Review` filters work uniformly across `Albums`, `Artists`, `Composers`, and `Tracks`.
  * Ensure 1:1 count parity across top-level tab badges (`Albums (N)`, `Artists (N)`, `Composers (N)`, `Tracks (N)`), visible cards, and card sub-counts (`X Albums · Y Tracks`) using grouped multi-disc master releases and canonical entity extraction.
  * Add a dynamic `LANGUAGE:` row to the Filter Shelf in `DataCanvas.tsx` derived from the active storage mount/folder scope (`mountAndFolderScopedTracks`), invariant to shelf facet toggles.
  * Remove the `DYNAMICS:` row from the Filter Shelf, relocate `24-bit Hi-Res` into the `FORMAT:` row, remove `Dynamic Range (Avg DR)` (`dr_desc`) from Sort dropdowns, and sanitize any legacy DR filter/sort state.
  * Auto-collapse or display a clean empty state if an open Artist/Composer detail view drops to `0` matching tracks when a filter pill is toggled.
  * Fix `matchesEra()` in `src/core/taxonomyUtils.ts` so decade pills (`1960s`–`2020s`) filter tracks and albums accurately.
  * Remove the duplicate local `Search artists...` input box inside `ArtistsView.tsx`.
* **Out-of-Scope Non-Goals:**
  * Modifying native Rust audio decoding, WASAPI transport, or offline TT-DR metering algorithms.
  * Altering SQLite database schema or triggering disk writes during filtering.

## Key Decisions & Staging for Next Steps

| Area | Decision | Target Files |
| :--- | :--- | :--- |
| **1. Scoped Releases & Grouped Album Parity** | Filter `displayedReleases` in `App.tsx` using `filteredTracks`; count grouped master releases via `groupAlbumReleases(releases, splitReleaseIds)` across `DataCanvas` badges, `deriveCanonicalArtistsFromState`, and `AlbumCoverGrid` composer cards. | `src/App.tsx`, `src/components/CenterStage/DataCanvas.tsx`, `src/components/CenterStage/AlbumCoverGrid.tsx`, `src/services/sqliteLibraryService.ts` |
| **2. Single Source of Truth for `Artists (N)` & Detail Guard** | Use `deriveCanonicalArtistsFromState(releases, tracks, splitReleaseIds)` for both the `Artists (N)` badge in `DataCanvas.tsx` and the cards in `ArtistsView.tsx`; auto-collapse or show a filtered empty state when an open Artist/Composer detail view has 0 matching tracks; remove the inner `Search artists...` input. | `src/components/CenterStage/DataCanvas.tsx`, `src/components/CenterStage/ArtistsView.tsx`, `src/components/CenterStage/AlbumCoverGrid.tsx`, `src/services/sqliteLibraryService.ts` |
| **3. Mount/Folder-Scoped Dynamic `LANGUAGE:` Row** | Pass `mountAndFolderScopedTracks` from `App.tsx` to `DataCanvas.tsx` to populate `LANGUAGE:` pills via `detectLanguage` sorted by track count descending, invariant to shelf facet toggles. | `src/App.tsx`, `src/components/CenterStage/DataCanvas.tsx` |
| **4. Format & Era Fixes, DR Removal & Legacy Fallback** | Move `24-bit Hi-Res` to `FORMAT:`, remove `DYNAMICS:` row and `dr_desc` sort option (with fallback to `'year_desc'`), ignore legacy DR mastering facets in `isGridFilterActive`, and support `1960s`–`2020s` in `matchesEra`. | `src/core/taxonomyUtils.ts`, `src/core/graphEngine.ts`, `src/App.tsx`, `src/components/CenterStage/DataCanvas.tsx`, `src/components/CenterStage/AlbumCoverGrid.tsx` |
