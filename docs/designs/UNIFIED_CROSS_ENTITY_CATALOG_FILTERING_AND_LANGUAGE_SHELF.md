# Unified Cross-Entity Catalog Filtering & Dynamic Language Shelf

*   **Author:** Mathan
*   **Status:** Approved
*   **Date:** 2026-10-30

--------------------------------------------------------------------------------

## Overview

Cadence provides four primary catalog views in the center stage: `Albums`, `Artists`, `Composers`, and `Tracks`. Users filter their music collection using the inline text filter (`⌘F`) in the sub-toolbar and the slide-down Filter Shelf (`Era`, `Format`, `Language`, and `Review` status).

Today, applying a filter scopes only the `Tracks` table and the rendered cards inside the `Albums` and `Composers` grids. The top-level entity tab badges (`Albums (N)`, `Artists (N)`, `Composers (N)`), the entire `Artists` tab grid, and several Filter Shelf controls either display global unfiltered library totals or fail to filter tracks at all.

This design unifies catalog filtering so that every active filter scopes the tab badges, grid cards, detail views, and card sub-counts (`X Albums · Y Tracks`) across all four views (`Albums`, `Artists`, `Composers`, and `Tracks`) without triggering SQLite queries or disk I/O during playback. It also replaces the unused `DYNAMICS:` filter shelf row and `Dynamic Range (Avg DR)` sort option with a dynamically detected `LANGUAGE:` filter row, moves `24-bit Hi-Res` into the `FORMAT:` row, fixes decade matching for `ERA:` pills, and consolidates text filtering into the single sub-toolbar `⌘F` input.

## The Problem

1.  **Unscoped Releases & Tab Badge Drift (`src/App.tsx`, `src/components/CenterStage/DataCanvas.tsx`)**:
    *   In `App.tsx`, `filteredTracks` applies `searchQuery`, `facets`, `selectedMountId`, and `selectedFolderFilter`, but `displayedReleases` only filters `releases` when `facets.reviewStatus === 'staged'`. For all other active filters, `App.tsx` passes the full, unfiltered `releases` array to `DataCanvas`.
    *   Because `DataCanvas` calculates `Albums (releases.length)`, `artistCount`, and `composerCount` from both `releases` and `tracks`, the tab badges remain stuck at global library totals even when `filteredTracks` narrows to a small subset.
    *   In addition, `DataCanvas` counts raw `releases.length` for `Albums (N)` rather than grouped multi-disc releases (`groupAlbumReleases`), and counts `artistCount` and `composerCount` with inline loops that differ from the canonical grouping logic in `ArtistsView` and `AlbumCoverGrid`.

2.  **Artists Tab Ignores Active Filters via Direct SQLite Query (`src/services/sqliteLibraryService.ts`, `src/components/CenterStage/ArtistsView.tsx`)**:
    *   In Tauri desktop mode, `sqliteLibraryService.getCanonicalArtists(releases, tracks)` calls `tauriBridge.dbGetCanonicalArtists()` directly from SQLite and ignores the `releases` and `tracks` props passed down from `DataCanvas`. Toggling `Language: Tamil` or `Format: FLAC` has zero effect on the `Artists` tab, which continues to render all 336 global artists with their global album and track counts.
    *   `ArtistsView.tsx` also renders a second local `Search artists...` input box disconnected from the sub-toolbar `Filter in-place (⌘F)` input, forcing the user to manage two competing search boxes on the same screen.

3.  **Broken Era Decade Matching (`src/components/CenterStage/DataCanvas.tsx`, `src/core/taxonomyUtils.ts`)**:
    *   The Filter Shelf in `DataCanvas.tsx` emits decade strings (`'1960s'`, `'1970s'`, `'1980s'`, `'1990s'`, `'2000s'`, `'2010s'`, `'2020s'`), whereas `matchesEra()` in `taxonomyUtils.ts` only checks range keys (`'earlier-1970'`, `'1971-1980'`, etc.) and defaults to `return true` for unrecognized strings. Clicking any Era pill in the Filter Shelf is currently a no-op.

4.  **Missing Language Shelf Row & Orphaned Dynamics Controls (`src/components/CenterStage/DataCanvas.tsx`, `src/components/CenterStage/AlbumCoverGrid.tsx`)**:
    *   Although `FEATURES.DYNAMIC_RANGE` is `false` in `src/config/features.ts`, the Filter Shelf still renders a hardcoded `DYNAMICS:` row (`DR14+`, `DR12+`, `DR10+`, `24-bit Hi-Res`) and the Sort dropdowns in `DataCanvas.tsx` and `AlbumCoverGrid.tsx` still include `Dynamic Range (Avg DR)` (`dr_desc`).
    *   Meanwhile, the Filter Shelf has no `LANGUAGE:` row even though `facets.language` and `detectLanguage()` are already implemented in `graphEngine.ts` and `taxonomyUtils.ts`.

## Goals

*   **Cross-Entity Filter Scope**: Ensure `Filter in-place (⌘F)`, `Era`, `Format` (including `24-bit Hi-Res`), `Language`, `Review` status, storage mount, and folder filters uniformly scope `Albums`, `Artists`, `Composers`, and `Tracks`.
*   **1:1 Badge & Sub-Count Parity**: Compute `Albums (N)`, `Artists (N)`, `Composers (N)`, and `Tracks (N)` tab badges and card sub-counts (`X Albums · Y Tracks`) using the exact same grouped master releases (`groupAlbumReleases(releases, splitReleaseIds)`) and canonical entity derivation (`deriveCanonicalArtistsFromState`) as the underlying grids.
*   **Zero-I/O In-Memory Artist Filtering**: Derive filtered artist cards, sub-counts, and detail discographies in memory from the filtered `(releases, tracks)` props while merging cached SQLite artist portraits and editorial metadata, preserving Global Invariant 1 (zero disk/SQLite I/O during playback).
*   **Mount/Folder-Scoped Dynamic `LANGUAGE:` Row**: Replace the `DYNAMICS:` shelf row with a `LANGUAGE:` row that dynamically lists only the languages detected across the active storage mount/folder scope (`mountAndFolderScopedTracks`), sorted by track count descending and omitting zero-track languages.
*   **Relocate `24-bit Hi-Res` & Prune `DR` Controls**: Move `24-bit Hi-Res` into the `FORMAT:` shelf row, remove `DYNAMICS:` from the Filter Shelf, remove `Dynamic Range (Avg DR)` (`dr_desc`) from Sort dropdowns, and defensively sanitize any legacy DR sort or facet state.
*   **Fix Era Decade Matching**: Support `'1960s'` through `'2020s'` decade strings in `matchesEra()`.
*   **Single Top-Level Text Filter**: Remove the duplicate `Search artists...` input inside `ArtistsView.tsx` so `Filter in-place (⌘F)` controls all four tabs.
*   **Zero-Match Detail Guard**: When a user has an Artist or Composer detail view open and toggles a filter that reduces that entity's matching tracks to `0`, automatically collapse back to the parent grid (or present a clean empty-filter state with a one-click return action).

## Non-Goals

*   Implementing offline TT-DR dynamic range audio signal analysis or modifying `FEATURES.DYNAMIC_RANGE`.
*   Altering the SQLite database schema (`canonical_artists`, `tracks`, `releases`) or introducing SQLite queries on filter changes.
*   Modifying the Rust native audio engine, WASAPI transport, or background scanner threads.

## Open Questions

*   None. All scope, UI, and state boundaries were resolved during the brainstorming phase.

## Critical User Journeys (CUJs)

### CUJ 1: Filtering by Language Across All Four Entity Tabs

*   **Given**: A user has a multi-language library loaded (e.g., Tamil, Hindi, English) and opens the Filter Shelf (`⌘F` / `Filter` button).
*   **When**: The user clicks `Tamil` in the `LANGUAGE:` row and switches across the `Albums`, `Artists`, `Composers`, and `Tracks` tabs.
*   **Then**:
    *   The `LANGUAGE:` row continues to display all languages present in the current mount/folder scope (`Tamil`, `Hindi`, `English`) with `Tamil` highlighted.
    *   The tab badges (`Albums (N)`, `Artists (N)`, `Composers (N)`, `Tracks (N)`) immediately update to show only the counts of Tamil albums, artists with Tamil tracks, composers of Tamil tracks, and Tamil tracks.
    *   Each artist card in `Artists` and composer card in `Composers` displays `X Albums · Y Tracks` reflecting only their Tamil albums (grouped by multi-disc master release) and Tamil tracks.

### CUJ 2: Filtering In-Place (`⌘F`) and Drilling into an Artist

*   **Given**: The user is on the `Artists` tab.
*   **When**: The user types `"Rahman"` into the sub-toolbar `Filter in-place (⌘F)` input (with no duplicate search bar inside the `Artists` view) and clicks on an artist card.
*   **Then**:
    *   Only artists whose name, album, composer, or track matches `"Rahman"` appear in the `Artists` grid, and the `Artists (N)` tab badge matches the number of rendered artist cards.
    *   Clicking an artist card opens the Artist Detail view scoped to the matching albums and tracks, preserving the artist's cached portrait and bio without issuing disk I/O during playback.
    *   If the user then clicks a Filter Shelf pill (e.g., `Format: Native DSD`) for which the open artist has `0` matching tracks, the view cleanly exits the empty detail drill-down back to the `Artists` grid.

### CUJ 3: Isolating 24-bit Hi-Res Masters & Decade Eras

*   **Given**: The user opens the Filter Shelf in `DataCanvas`.
*   **When**: The user selects `1980s` under `ERA:` and `24-bit Hi-Res` under `FORMAT:`.
*   **Then**:
    *   No `DYNAMICS:` row is present on the Filter Shelf, and `Dynamic Range (Avg DR)` is absent from the Sort dropdown.
    *   `matchesEra` filters tracks whose release year (`pendingSidecarEdits.year ?? releaseYear ?? originalYear`) is between `1980` and `1989`.
    *   `matchesFormat` filters tracks with 24-bit or 32-bit PCM depth or Hi-Res sample rates, updating all four entity tabs in unison.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### Architectural Data Flow

The updated filter and state propagation pipeline eliminates out-of-band SQLite fetches and maintains strict in-memory synchronization across all views:

```
                                    +-----------------------------------+
                                    |         User Interaction          |
                                    | (⌘F Search, Filter Shelf, Mounts) |
                                    +-----------------+-----------------+
                                                      |
                                                      v
                                        +----------------------------+
                                        |          App.tsx           |
                                        +--------------+-------------+
                                                       |
                    +----------------------------------+----------------------------------+
                    |                                  |                                  |
                    v                                  v                                  v
      +-----------------------------+    +-----------------------------+    +-----------------------------+
      | mountAndFolderScopedTracks  |    |        filteredTracks       |    |      displayedReleases      |
      | (Filtered only by active    |    | (Filtered by Mount, Folder, |    | (Filtered by active release |
      |  MountId & FolderFilter)    |    |  SearchQuery, and Facets)   |    |  IDs from filteredTracks)   |
      +--------------+--------------+    +--------------+--------------+    +--------------+--------------+
                     |                                  |                                  |
                     +----------------------------------+----------------------------------+
                                                        |
                                                        v
                                          +----------------------------+
                                          |       DataCanvas.tsx       |
                                          +--------------+-------------+
                                                         |
         +-----------------------------------------------+-----------------------------------------------+
         |                                               |                                               |
         v                                               v                                               v
+-------------------------------+               +-------------------------------+               +-------------------------------+
|       Top Tab Bar Badges      |               |      AlbumCoverGrid.tsx       |               |        ArtistsView.tsx        |
| - Albums (Grouped Master N)   |               | - Grouped Master Cards        |               | - deriveCanonicalArtists      |
| - Artists (Canonical State N) |               | - Composer Aggregation        |               |   from (releases, tracks)     |
| - Composers (Normalized N)    |               | - Auto-collapse if 0 matches  |               | - Enriched with SQLite cache  |
| - Tracks (filteredTracks.len) |               | - Removed 'dr_desc' from Sort |               | - No internal duplicate search|
+-------------------------------+               +-------------------------------+               +-------------------------------+
```

### Core Architectural Mechanisms

1.  **Dual Track Slicing in `App.tsx`**:
    *   `mountAndFolderScopedTracks`: Evaluates only `selectedMountId` and `selectedFolderFilter`. This stable slice is passed down to `DataCanvas.tsx` to populate the `LANGUAGE:` row dynamically, preventing language pills from vanishing when facet pills are selected.
    *   `filteredTracks`: Applies all criteria (`mountAndFolderScopedTracks` + `searchQuery` + all `facets`).
    *   `displayedReleases`: When any filter is active (`isGridFilterActive || Boolean(activeTriageFilter)`), derives the visible releases by intersecting `releases` with the `releaseId`s, `masterReleaseId`s, and `folderName`s referenced by `filteredTracks`. When no filter is active, passes all `releases`.

2.  **Canonical Grouped Entity Calculation in `DataCanvas.tsx`**:
    *   `Albums (N)`: Computed as `groupAlbumReleases(displayedReleases, splitReleaseIds).length`.
    *   `Artists (N)`: Computed directly via `sqliteLibraryService.deriveCanonicalArtistsFromState(displayedReleases, filteredTracks, splitReleaseIds).length`.
    *   `Composers (N)`: Extracted from `filteredTracks` and `displayedReleases` using `.trim().toLowerCase()` case-insensitive normalization matching `AlbumCoverGrid.tsx`'s `composerGroups`.
    *   `Tracks (N)`: Computed as `filteredTracks.length`.

3.  **Zero-I/O Hybrid Artist Resolution in `SqliteLibraryService`**:
    *   An in-memory cache `canonicalArtistsMetadataCache: Map<string, ArtistMetadata>` holds portrait URLs, MBID, bio summaries, and active eras populated on initial startup.
    *   `getCanonicalArtists(releases, tracks, splitReleaseIds)` executes `deriveCanonicalArtistsFromState(releases, tracks, splitReleaseIds)` in memory. For each derived artist, it attaches cached portrait and bio metadata without querying SQLite or reading the disk.
    *   `getCanonicalArtistDetail(artistId, releases, tracks, splitReleaseIds)` scopes `discography` (grouped master releases) and `appearingTracks` exclusively to the passed `(releases, tracks)` slice.

4.  **Zero-Match Drill-down Guard**:
    *   In `ArtistsView.tsx`: If `selectedArtistId` is active but `artistDetail.appearingTracks.length === 0` under the active filter, automatically deselect `selectedArtistId = null` to return to the filtered artists grid.
    *   In `AlbumCoverGrid.tsx`: If `selectedArtist` or `selectedComposer` is active but `artistFilteredAlbums.length === 0` or `composerFilteredAlbums.length === 0`, reset the drill-down selection to null.

5.  **Taxonomy & Format Mapping**:
    *   `matchesEra(year, eraBucket)`: Extended to match decade strings (`'1960s'`, `'1970s'`, `'1980s'`, `'1990s'`, `'2000s'`, `'2010s'`, `'2020s'`) using bounds:
        *   `1960s`: `year <= 1969` (or `1960 <= year <= 1969`)
        *   `1970s`: `1970 <= year <= 1979`
        *   `1980s`: `1980 <= year <= 1989`
        *   `1990s`: `1990 <= year <= 1999`
        *   `2000s`: `2000 <= year <= 2009`
        *   `2010s`: `2010 <= year <= 2019`
        *   `2020s`: `year >= 2020`
    *   `matchesFormat(track, formatSelection)`: Extended to handle `'24-bit Hi-Res'` and `'high_res_24bit'` via `(track.bitDepth != null && track.bitDepth >= 24) || track.sampleRateStr?.includes('24/') || track.sampleRateStr?.includes('32/') || Boolean(track.isHighRes)`.

6.  **Filter Shelf & Sort Sanitization**:
    *   `DataCanvas.tsx`: Remove `DYNAMICS:` row. Add `LANGUAGE:` row dynamically rendered from `mountAndFolderScopedTracks` via `detectLanguage`. Relocate `24-bit Hi-Res` to `FORMAT:`.
    *   Remove `'dr_desc'` from the `SortBy` type definition and sort dropdowns in `DataCanvas.tsx` and `AlbumCoverGrid.tsx`.
    *   Defensive fallback: If `sortBy === 'dr_desc'`, fallback to `'year_desc'`.

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Execute Dynamic SQLite `WHERE` Queries for Filtered Artists and Albums

*   **Description**: Modify `sqliteLibraryService.ts` to construct dynamic SQL queries with `WHERE genre = ? AND format = ? AND language = ?` on every filter pill click or `⌘F` keystroke to retrieve pre-filtered artist rows and release rows directly from the native SQLite database.
*   **Pros**:
    *   Reuses SQLite index structures for joins across `tracks` and `canonical_artists`.
    *   Avoids in-memory array filtering in JavaScript.
*   **Cons**:
    *   **Direct Violation of Global Invariant 1 (Storage Bus Silence During Playback)**: Running SQLite disk queries while audio playback is active or during the 30-second cooldown period violates the repository's core audiophile transport invariant.
    *   **Latency & IPC Churn**: Typing in the `⌘F` filter input would flood Tauri IPC and SQLite connections with rapid transient queries, increasing thread wakeups and electrical noise.
*   **Reason for Rejection**: The in-memory graph in `graphEngine` and React state already contains all active tracks and releases. Performing the filtering in memory takes $< 2\text{ms}$ for thousands of tracks with zero disk I/O, guaranteeing bit-perfect transport silence.

### Alternative B: Keep Static Language List on the Filter Shelf

*   **Description**: Hardcode a static list of popular languages (`Tamil`, `Hindi`, `English`, `Malayalam`, `Telugu`, `Kannada`, `Japanese`, `German`) directly in `DataCanvas.tsx`.
*   **Pros**:
    *   Simpler implementation with no need to pass `mountAndFolderScopedTracks`.
*   **Cons**:
    *   Renders useless, zero-result buttons for languages not present in the user's specific collection.
    *   Fails to show niche or regional languages dynamically identified by directory paths or ID3 tags.
*   **Reason for Rejection**: Clutters the Filter Shelf with dead controls and contradicts Apple HIG principles of contextual relevance and minimalism.

### Alternative C: Keep the Local Search Input in `ArtistsView.tsx`

*   **Description**: Retain the `Search artists...` input box inside `ArtistsView.tsx` alongside the sub-toolbar `Filter in-place (⌘F)` input.
*   **Pros**:
    *   Allows text filtering of artists without affecting the other three tabs.
*   **Cons**:
    *   Creates a confusing user experience with two search boxes visible simultaneously in the same viewport.
    *   Breaks spatial hierarchy and mental models: users type in one search bar and wonder why the other does not react.
*   **Reason for Rejection**: Consolidating on `Filter in-place (⌘F)` provides a single, predictable filter bar that consistently filters `Albums`, `Artists`, `Composers`, and `Tracks`.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `src/core/taxonomyUtils.ts` (Modify)
*   **Type / Scope**: Domain Taxonomy & Audio Format Normalization Helper
*   **Proposed Changes**:
    *   Update `matchesEra(year, eraBucket)` to add decade range support (`'1960s'` through `'2020s'`) alongside existing `'earlier-1970'`, `'1971-1980'`, etc.
    *   Update `matchesFormat(track, formatSelection)` to detect `'24-bit Hi-Res'` and `'high_res_24bit'` via `(track.bitDepth != null && track.bitDepth >= 24) || track.sampleRateStr?.includes('24/') || track.sampleRateStr?.includes('32/') || Boolean(track.isHighRes)`.

#### 2. `src/core/graphEngine.ts` (Modify)
*   **Type / Scope**: Relational Graph Query & Filter Engine
*   **Proposed Changes**:
    *   In `filterTracks()`, ensure `eraFilter` evaluates `track.pendingSidecarEdits?.year || rel?.releaseYear || rel?.originalYear`.
    *   Ensure `searchQuery` checks `rel?.artistCredit` and `rel?.composerName` in addition to track-level metadata.
    *   Defensively map `masteringFilter === 'high_res_24bit'` to evaluate using the updated `matchesFormat` helper.

#### 3. `src/services/sqliteLibraryService.ts` (Modify)
*   **Type / Scope**: Native SQLite Data Layer & Canonical Artist Normalizer
*   **Proposed Changes**:
    *   Introduce an in-memory cache for artist editorial metadata (`canonicalArtistsMetadataCache`).
    *   Update `getCanonicalArtists(fallbackReleases, fallbackTracks, splitReleaseIds)`: When `fallbackReleases` and `fallbackTracks` are provided, always call `deriveCanonicalArtistsFromState` in-memory with multi-disc release grouping (`groupAlbumReleases`) and merge cached SQLite portrait/editorial data, bypassing direct SQLite queries during filtering.
    *   Update `getCanonicalArtistDetail(artistId, fallbackReleases, fallbackTracks, splitReleaseIds)`: Derive `discography` (grouped by master release) and `appearingTracks` strictly from the passed `fallbackReleases` and `fallbackTracks`.
    *   Update `deriveCanonicalArtistsFromState` to accept optional `splitReleaseIds: Set<string>` and resolve multi-disc constituent releases to their canonical grouped master release ID when incrementing `albumsCount`.

#### 4. `src/App.tsx` (Modify)
*   **Type / Scope**: Root Application Container & Filter Coordinator
*   **Proposed Changes**:
    *   Compute `mountAndFolderScopedTracks` (tracks filtered only by `selectedMountId` and `selectedFolderFilter`) and pass to `DataCanvas`.
    *   Update `displayedReleases` `useMemo`: When `isGridFilterActive || Boolean(activeTriageFilter)` is true, return only releases referenced by `filteredTracks` (`t.releaseId`, `t.masterReleaseId`, or `t.folderName`).
    *   Update `isGridFilterActive` to ignore legacy DR facet keys.
    *   Pass `mountAndFolderScopedTracks` to `DataCanvas`.

#### 5. `src/components/CenterStage/DataCanvas.tsx` (Modify)
*   **Type / Scope**: Central Sub-Toolbar, Filter Shelf & View Orchestrator
*   **Proposed Changes**:
    *   Accept `mountAndFolderScopedTracks: Track[]` prop.
    *   Derive `availableLanguages` dynamically from `mountAndFolderScopedTracks` using `detectLanguage()`, sorted descending by track count, omitting zero-count languages.
    *   Replace the `DYNAMICS:` filter shelf row with the dynamic `LANGUAGE:` row.
    *   Relocate `24-bit Hi-Res` pill into the `FORMAT:` row.
    *   Remove `Dynamic Range (Avg DR)` (`dr_desc`) from the Sort dropdown and add fallback for `sortBy === 'dr_desc'` -> `'year_desc'`.
    *   Compute `Albums (N)` tab badge as `groupAlbumReleases(releases, splitReleaseIds).length`.
    *   Compute `Artists (N)` tab badge using `sqliteLibraryService.deriveCanonicalArtistsFromState(releases, tracks, splitReleaseIds).length`.
    *   Compute `Composers (N)` tab badge using case-insensitive normalized composer grouping matching `AlbumCoverGrid.tsx`.

#### 6. `src/components/CenterStage/AlbumCoverGrid.tsx` (Modify)
*   **Type / Scope**: Albums & Composers Responsive Grid View
*   **Proposed Changes**:
    *   Remove `'dr_desc'` from the `SortBy` type definition and sort dropdown.
    *   Add defensive fallback in sorting logic: if `sortBy === 'dr_desc'`, treat as `'year_desc'`.
    *   In composer grouping (`composerGroups`), ensure album counts group multi-disc constituent releases to avoid multi-disc duplicate counts.
    *   Add zero-match drill-down guard: if `selectedComposer` or `selectedArtist` has `0` matching albums in the filtered cards, auto-reset drill-down to `null`.

#### 7. `src/components/CenterStage/ArtistsView.tsx` (Modify)
*   **Type / Scope**: Canonical Relational Artists Grid & Editorial Detail
*   **Proposed Changes**:
    *   Remove local `searchQuery` state, local search input box, and internal search filter logic.
    *   Pass `splitReleaseIds` into `getCanonicalArtists` and `getCanonicalArtistDetail`.
    *   Add zero-match drill-down guard: if `selectedArtistId` has `0` appearing tracks under the active filter, auto-reset `selectedArtistId = null` to return to the filtered artists grid.

### Verification Plan

*   **Compilation & Type Integrity**:
    *   Run `npm run build` (`tsc -b && vite build`) to ensure zero TypeScript errors with the modified `SortBy` union and new props.
*   **Manual Verification Across All 4 CUJs**:
    *   *Language Filter Verification*: Select `Language: Tamil` on the Filter Shelf. Verify `Albums (N)`, `Artists (N)`, `Composers (N)`, and `Tracks (N)` badges update in unison to show matching counts. Verify artist cards and composer cards show sub-counts (`X Albums · Y Tracks`) scoped strictly to Tamil tracks. Verify non-Tamil language pills remain visible on the Filter Shelf.
    *   *Single Search Bar (`⌘F`)*: Type a query in the sub-toolbar `Filter in-place (⌘F)`. Verify the `Artists` grid filters to matching artists and `Artists (N)` badge matches the card count. Verify there is no duplicate search input in the `Artists` tab header.
    *   *24-bit Hi-Res & Decade Eras*: Select `24-bit Hi-Res` under `FORMAT:` and `1980s` under `ERA:`. Verify tracks and albums are correctly isolated. Verify the `DYNAMICS:` row is gone and `Dynamic Range (Avg DR)` does not appear in the Sort dropdown.
    *   *Zero-Match Drill-down Guard*: Open an artist or composer detail view, then select a format/language facet where that artist has 0 tracks. Verify the UI cleanly collapses back to the grid view.
    *   *Multi-Disc Box Set Parity*: Ensure a 2-CD release counts as `1 Album` in the `Albums` tab badge, Artist cards, and Composer cards.

--------------------------------------------------------------------------------

*Drafted with EGM*

