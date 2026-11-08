# Curate Priorities, Problem Filtering, and Selected Output Commit

*   **Author:** Mathan
*   **Status:** Approved (EGM Feature Spec & Implementation Readiness Complete)
*   **Date:** 2026-11-08

--------------------------------------------------------------------------------

## Overview

Curate lets users choose which catalog problems to fix first, inspect and edit metadata and artwork in the album workbench, stage albums with **Stage & Next**, and commit changes into the background **Commit Queue**. This design replaces the split Tier 1 (`Auto-Staged`), Tier 2 (`Guided Reconciliation`), and standalone Review Queue with a single priority-ordered album list driven by configurable **Priority Settings** (`P0`–`P3`) and an expandable **Filters** band (**Priority**, **Problem Category**, and **Album** title search), while making provider enrichment strictly human-triggered and surfacing the **Commit Queue** status and drawer in the Curate header above the filters.

## The Problem

Today, curating a music library in Cadence suffers from four workflow and state-management friction points:

1.  **Fragmented Queues and Opaque Ordering**: Albums are split across `Tier 1: Auto-Staged`, `Tier 2: Guided Reconciliation`, and a separate `curateReviews` filter based on five coarse defect buckets in [`curationQueueService.ts`](file:///e:/Mathan/Code/Music%20Agent/src/services/curationQueueService.ts#L15-L30). Users cannot filter by specific metadata defects (such as `CD rip or dump suffix in album title`, `Missing release year`, or `Compilation tracks missing original_album`), nor can they reprioritize which defect categories appear at the top of their work list.
2.  **Unsolicited Auto-Enrichment on Album Selection**: Selecting an album in [`UnifiedCurateCockpit.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L936-L1021) automatically triggers background provider lookups (`resolve2of3ReleaseConsensus` and Gemini compilation inference), overwrites fields in **Selected Output**, and saves a `curation_drafts` record to SQLite ([lines 807–819](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L807-L819)). Merely clicking an album to inspect it creates unapproved draft changes and network traffic.
3.  **Competing Staging and Commit Entry Points**: The global app header shows a green `{N} Albums · {M} Staged` button tied to in-memory graph sidecars ([`App.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L1729-L1743)), while Curate writes to both `graphEngine.updateTrackSidecar(...)` and SQLite drafts (`curation_drafts`). Furthermore, [`App.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L1943-L1945) passes raw unprojected `catalogTracks` into Curate, preventing Curate from immediately recognizing when a queued commit has resolved the active filter's defect while audio playback pauses physical disk writes.
4.  **Cluttered Shell Controls**: The global header exposes the Cadence Music Agent Copilot UI (`⌘J`), and the album workbench displays a **Capture Snapshot** button and a standalone **Saved Apple evidence** banner above the album metadata table that duplicate information already shown inline in the comparison rows.

**Proposed Solution**: Consolidate Curate around a single priority-ordered album rail governed by **Priority Settings** (14 actionable problem categories assigned to `P0`–`P3` that map directly to editable workbench fields, plus 1 read-only `Info · Exempt` row) and an independent **Filters** bar (**Priority**, **Problem Category**, and **Album** search). Replace `computeCurationQueue` and `graphEngine.updateTrackSidecar` staging in Curate with `evaluateCatalogProblems` and SQLite `curation_drafts`. Keep provider enrichment human-triggered with an explicit **Accept Suggestions** action in **Selected Output**, and provide a rescan-safe **Dismiss Problem** exemption for legitimate edge cases such as self-titled albums. Retain **Stage & Next**, **Commit Album**, and album-level **Commit All** for staged albums, always diff **Selected Output** against the raw physical file baseline (`rawTracks`, `rawReleases`) before commit so tracks already in sync on disk are never rewritten, surface the **Commit Queue** status and drawer in the Curate header above the filters, and remove an album from the active filter list upon commit only when the committed changes resolve all problems matching the active filter.

## Goals

*   **Single Priority-Ordered Work List & Unified Badge Count**: Replace Tier 1, Tier 2, `computeCurationQueue`, and `savedCurateReviews` (`Done reviewing`) with one album list beside the editor and one top-bar `curateBadgeCount` driven by `evaluateCatalogProblems`, ranking each matching album once by its highest matching priority (`P0` through `P3`).
*   **Independent Multi-Problem Filtering**: Support 14 actionable problem categories across release-level and track-level defects that are directly resolvable in the Curate workbench. Allow an album to hold multiple problems across `P0`–`P3` simultaneously, match any selected chip within a filter group (`Priority` or `Problem Category`), and require the same problem instance on an album to match both when both groups are selected.
*   **Configurable Priority Settings with Live Counts**: Let users reassign each of the 14 actionable categories to `P0`–`P3`, view current library affected counts (`releases` or `tracks`), inspect the read-only `Info · Exempt` row for releases with a valid album artist and no composer, and apply changes atomically via **Save priorities** while keeping the current album open.
*   **Human-Triggered Enrichment & Explicit Suggestion Adoption**: Ensure clicking an album in the left rail loads local tags into **Selected Output** (or restores a user-saved draft) and displays archived provider evidence in the provider columns without automatically firing external provider queries or mutating **Selected Output**. Provide an explicit **Accept Suggestions** button in the **Selected Output** column header (alongside per-cell clicks) to adopt consensus/learned proposals on demand.
*   **Explicit Staging, False-Positive Dismissal, Atomic Commits, and Commit Queue Drawer**: Retain **Stage & Next** (writing strictly to `curation_drafts` without mutating `graphEngine` sidecars), **Dismiss Problem** (to exempt legitimate self-titled albums or intentional collector tags from a problem category across library rescans), **Commit Album**, and **Commit All** (to preview and batch-commit all staged albums across sessions and filters). Always diff **Selected Output** against the raw physical file baseline (`rawTracks`, `rawReleases`) before commit to skip tracks that are already in sync on disk and to ensure repeated commits on the same album carry the complete cumulative delta against the physical file. Place a clickable **Commit Queue** status drawer in the Curate header above the filters while hiding the duplicate global `CommitStatusPill` when Curate is active.
*   **Filter-Aware Post-Commit Retention**: Evaluate problem resolution against the effective projected catalog (local baseline overlaid with active Commit Queue payloads in ascending commit order, including cascading album-level `genre` and `year` commits down to member tracks). When a user commits changes that resolve the active filter's matching problem(s), remove the album from the filtered list and advance to the next album (showing a filter completion state with **Reset Filters** when the last album in an active filter batch is resolved); when the user commits an unrelated field and the filtered problem remains, keep the album in the filtered list for further edits and subsequent commits.
*   **UI Decluttering and Modular Extraction**: Remove the green staging pill and Copilot UI (`⌘J` and Spotlight command `cmd-cadence-agent`) from the app header (retaining Copilot backend), remove **Capture Snapshot** and the standalone **Saved Apple evidence** banner from the workbench, and extract the new priority, filter, settings, and commit-preview modules out of [`UnifiedCurateCockpit.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx).

## Non-Goals

*   Modifying the native Rust background commit worker's file-writing pipeline, transactional recovery, or audiophile playback isolation gates.
*   Adding new metadata row types (such as `Record Label` or `Catalog Number`) to the 5-column album workbench; `Duplicate releases missing both label and catalog number` is deferred until Label/Catalog # editing is added to the workbench.
*   Redesigning the 4-way provider comparison grid, **Steer Providers**, **Refresh Evidence**, candidate adoption clicks, or inline track and singer editing inside the album workbench.
*   Removing backend Rust commands or services for Cadence Music Agent Copilot or diagnostic snapshot export.
*   Running disk I/O on music library drives or SQLite batch scans during active audio playback.

## Open Questions

*   None — all requirements and edge cases were resolved during the brainstorming and architecture review phases.

## Critical User Journeys (CUJs)

### CUJ 1: Filtering by Priority and Problem Category, Staging, and Batch Committing

*   **Given**: The user opens **Curate** with a library containing albums across `P0`–`P3` problem categories.
*   **When**: The user expands **Filters**, selects `P1` under **Priority** and `Missing release year` under **Problem Category**, selects an album, clicks **Refresh Evidence** and **Accept Suggestions** (or edits `Release Year` in **Selected Output**), clicks **Stage & Next** on two albums, and then clicks **Commit All**.
*   **Then**: Selecting each album does not auto-mutate **Selected Output** until the user clicks **Accept Suggestions**, clicks a provider candidate, or edits a field; **Stage & Next** saves the draft to `curation_drafts`, marks each album `✓ Staged` in the filtered rail, and advances to the next matching album; clicking **Commit All** opens `CurateCommitPreviewModal` listing the staged albums and their diffs against the raw physical file baseline, enqueues only modified tracks into the **Commit Queue** drawer above the filters, clears `staged: false` on their drafts, removes the resolved albums from the `Missing release year` filter list, and loads the next remaining album (or displays the `"All albums matching current filters are resolved"` completion state with a **Reset Filters** button if the last matching album was resolved).

### CUJ 2: Partial Commit While Filtered (Album Remains in Filter Queue)

*   **Given**: The user filters Curate by `P0` and `Missing both album artist and composer`, and opens an album that is missing both `Album Artist` and `Composer` and also has outdated cover art.
*   **When**: The user updates only **Cover Artwork** in **Selected Output** and clicks **Commit Album**, then subsequently fills in **Album Artist** and clicks **Commit Album** a second time.
*   **Then**: After the first commit, the cover artwork write enters the **Commit Queue** above the filters as an atomic save, but because `Album Artist` and `Composer` are still missing, the album remains open in the active filter list. Editing `Album Artist` updates the draft selection so it differs from the first queued commit revision (`matchesCurateConfirmation` returns `false`), re-enabling **Commit Album**. Because **Selected Output** is always diffed against the raw physical file on disk (`rawTracks`, `rawReleases`), clicking **Commit Album** a second time builds the complete cumulative diff (`Cover Artwork` + `Album Artist`) against the physical file and supersedes the pending Commit #1 row in the **Commit Queue**, the `Missing both album artist and composer` defect is resolved in the effective projected metadata, the album leaves the filtered list, and the next album in the filtered list loads.

### CUJ 3: Direct Entry from Listen Outside Active Filters

*   **Given**: The user previously filtered Curate by `P0` (`CD rip or dump suffix in album title`), navigated to **Listen**, and selected **Listen → Album → Curate Album Metadata & Artwork** on an album that has no `P0` problems.
*   **When**: Curate opens for that selected album.
*   **Then**: The selected album opens directly in the album workbench even though it falls outside the remembered `P0` filter, while the remembered `P0` filter and left-rail `filteredAlbums` list remain preserved untouched.

### CUJ 4: Reordering Priority Settings Live

*   **Given**: The user has an album open in Curate and opens **Priority Settings** from the Curate header.
*   **When**: The user changes `Missing cover art and embedded artwork` from `P1` to `P0` and clicks **Save priorities**.
*   **Then**: The priority mapping persists to `localStorage`, the left album rail reorders immediately with `Missing cover art and embedded artwork` albums ranked in `P0`, and the currently open album remains open in the workbench.

### CUJ 5: Dismissing a Legitimate Self-Titled Album Problem

*   **Given**: An album is legitimately self-titled (`Album Title` equals `Album Artist`, e.g., *Ilaiyaraaja*), causing it to appear under `P0 · Composer or artist name used as album title`.
*   **When**: The user opens the album and clicks **Dismiss Problem** for `artist_as_album_title`.
*   **Then**: The exemption is persisted in `localStorage` (`cadence.curate.dismissed-problems.v1`) keyed by `curateReviewKeys(releaseId, tracks)` (so it survives library rescans), the album immediately graduates out of the `artist_as_album_title` problem list without modifying any audio file tags, and selection advances to the next album in the filtered list.

## Technical Plan (Architecture)

### 1. System Architecture & Data Flow

Curate separates **effective catalog problem detection** (which evaluates the Commit-Queue-projected catalog `tracks` and `releases` to determine filter membership, `App.tsx`'s `curateBadgeCount`, and Priority Settings counts) from **workbench draft diffing and commit generation** (which always compares editable **Selected Output** against the **raw physical file baseline** `rawTracks` and `rawReleases` on disk so in-sync tracks are skipped and repeated commits carry the full cumulative delta against disk).

```mermaid
flowchart TD
    subgraph AppState["App.tsx State & Native Queue Projection"]
        RawCatalog["Raw Physical File Baseline\n(rawTracks = catalogTracks, rawReleases = catalogReleases)"]
        CommitRows["Durable Commit Queue Rows\n(commitGetCurateProjection)"]
        ProjectedCatalog["Effective Projected Catalog\nprojectCurateCommits(raw, rows)\n(Folds Rows in Order & Cascades Album Genre/Year)"]
        RawCatalog --> ProjectedCatalog
        CommitRows --> ProjectedCatalog
    end

    subgraph CurateHeader["Curate Shell Header & Band"]
        HeaderActions["Curate Header:\nCommit Queue Drawer | Filters | Priority Settings | Learned Rules"]
        FilterBand["CurateFilterBar:\nPriority Chips (P0-P3) | Problem Category Chips (14) | Album Search | Reset"]
        PriorityModal["CuratePrioritySettingsModal:\n14 Actionable Categories (P0-P3) + 1 Info·Exempt Row\n(Save priorities / Reset to Default / Cancel)"]
    end

    subgraph ProblemEngine["src/core/curatePriorities.ts (In-Memory, Replaces computeCurationQueue)"]
        Classifier["evaluateCatalogProblems()\n14 Actionable Detectors + Info·Exempt - Dismissed Problems"]
        FilterMatcher["filterAndRankCurateAlbums()\nIntra-group OR, Same-problem Cross-group AND,\nHighest Matching Priority Rank"]
        ProjectedCatalog --> Classifier
        PriorityModal -->|Save priorities| Classifier
        Classifier --> FilterMatcher
        FilterBand --> FilterMatcher
    end

    subgraph CurateBody["UnifiedCurateCockpit Split Deck"]
        LeftRail["Filtered Album List Rail\n+ Commit All (Staged)"]
        Workbench["Album Workbench\n(Diffs Selected Output vs. Raw Physical File Baseline,\nRefresh Evidence, Accept Suggestions, Dismiss Problem, Stage & Next, Commit Album)"]
        PreviewModal["CurateCommitPreviewModal\n(Cross-Session Staged Batch Preview vs. Raw Physical File)"]
        FilterMatcher --> LeftRail
        RawCatalog --> Workbench
        LeftRail -->|Select Album (No Auto-Enrich)| Workbench
        Workbench -->|Stage & Next (SQLite curation_drafts only)| LeftRail
        LeftRail -->|Commit All| PreviewModal
        Workbench -->|Commit Album (Only Out-of-Sync Tracks)| CommitRows
        PreviewModal -->|Confirm Batch (Only Out-of-Sync Tracks)| CommitRows
    end
```

### 2. Problem Category Engine (`src/core/curatePriorities.ts`)

`evaluateCatalogProblems` replaces `computeCurationQueue` in [`src/services/curationQueueService.ts`](file:///e:/Mathan/Code/Music%20Agent/src/services/curationQueueService.ts) as the single source of truth for both Curate left-rail membership and `App.tsx`'s `curateBadgeCount`. It reuses normalization and disambiguation helpers from [`src/core/taxonomyUtils.ts`](file:///e:/Mathan/Code/Music%20Agent/src/core/taxonomyUtils.ts) (`cleanRipNoise`, `stripRipNoiseAndTags`, `normalizeCanonicalAlbumTitle`, `isPlaceholderTag`, `isDefectiveArtistTag`, `disambiguateComboTitle`) and [`curateReviewKeys`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L39-L44) from [`src/core/curateCommit.ts`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts), subtracts any per-album dismissed problem pairs (`cadence.curate.dismissed-problems.v1`), and produces `CatalogProblemSummary`:
*   `albumProblems: Map<string, AlbumProblemInstance[]>` where each `AlbumProblemInstance` records `{ categoryId: CurateProblemCategoryId; priority: CuratePriorityTier; affectedTrackIds?: string[] }`.
*   `categoryCounts: Record<CurateProblemCategoryId, { count: number; unit: 'releases' | 'tracks' }>`, counting each release or track once per matching category across the projected catalog.
*   `priorityAlbumCounts: Record<CuratePriorityTier, number>`, counting each album holding at least one non-dismissed problem in that priority tier (`P0`–`P3`) across the projected catalog (so each Priority filter chip count equals the number of albums returned if that single Priority chip is selected).
*   `infoExemptCount: number`, counting releases with a valid non-placeholder `albumArtist` and no `composer`.
*   `totalActionableAlbums: number`, used directly by `App.tsx` for `curateBadgeCount`.

To ensure track-level year and genre defects (`missing_track_year`, `missing_track_genre`) are immediately resolvable from the album workbench, [`Track`](file:///e:/Mathan/Code/Music%20Agent/src/core/types.ts#L249-L303) in `src/core/types.ts` declares `genre?: string`, and [`projectCurateCommits`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L242-L285) folds all applicable `CurateCommitRow` entries per `trackId` in ascending commit order and cascades committed album-level `year` and `genre` payload values onto member `Track` records (`track.canonicalReleaseYear` and `track.genre`).

| Category ID | Default Tier | Problem Category Label | Unit | Exact Detection Rule & Resolution in Workbench |
| :--- | :---: | :--- | :---: | :--- |
| `cd_rip_suffix` | `P0` | CD rip or dump suffix in album title | `releases` | `Boolean(release.title && (cleanRipNoise(release.title).toLowerCase() !== release.title.trim().toLowerCase() \|\| stripRipNoiseAndTags(release.title).toLowerCase() !== release.title.trim().toLowerCase()))`. Resolved by editing **Album Title**. |
| `artist_as_album_title` | `P0` | Composer or artist name used as album title | `releases` | Normalized `release.title` equals normalized `release.artistCredit` or `release.composerName`, or `isDefectiveArtistTag(release.artistCredit, release.title)`. Resolved by editing **Album Title** or clicking **Dismiss Problem** for self-titled releases. |
| `placeholder_track_titles` | `P0` | Placeholder track titles | `tracks` | `isPlaceholderTag(track.title)` or trimmed title matches `track N`, `audio track N`, `untitled`, `unknown`, `unknown title`, or bare digits (`01`, `1`). Resolved by editing track **Title** in **Selected Track & Singers**. |
| `missing_artist_and_composer` | `P0` | Missing both album artist and composer | `releases` | Effective `albumArtist` (`release.artistCredit \|\| tracks.find(t => t.albumArtist)?.albumArtist`) and effective `composer` (`release.composerName \|\| tracks.find(t => t.composerName)?.composerName`) both pass `isPlaceholderTag(...)`. Resolved by editing **Album Artist** or **Composer**. |
| `track_artist_copied_from_album` | `P1` | Track artist copied from album or folder | `tracks` | Normalized `track.artistCredit` equals normalized `release.title` or `track.folderName` / `release.folderName`. Resolved by editing track **Singers** in **Selected Track & Singers**. |
| `featured_artist_missing_from_tag` | `P1` | Featured artists in title missing from artist tag | `tracks` | `track.title` contains a `feat.` / `ft.` / `featuring <name>` token and the featured artist name is absent from `track.artistCredit`. Resolved by updating track **Title** / **Singers**. |
| `missing_release_year` | `P1` | Missing release year | `releases` | `!release.releaseYear \|\| release.releaseYear < 1900`. Resolved by editing **Release Year**. |
| `missing_track_year` | `P1` | Missing track year | `tracks` | Track lacks a valid year (`< 1900`) across `canonicalReleaseYear` / `originalYear` / projected release year. Resolved by editing **Release Year** (cascaded to member tracks) or compilation track `originalYear`. |
| `missing_cover_art` | `P1` | Missing cover art and embedded artwork | `releases` | `!release.coverArtUrl && !release.artwork?.frontCoverUrl` (or `release.artwork?.resolution === 'No Embedded Art'`). Resolved by selecting or uploading **Cover Artwork**. |
| `missing_album_genre` | `P1` | Missing album genre tags | `releases` | `!release.genreTags?.length` or all entries are empty/placeholder (`Unclassified`, `Unknown`, `Library Import`). Resolved by editing **Genre**. |
| `missing_track_genre` | `P1` | Missing track genre | `tracks` | Track lacks a valid genre (`isPlaceholderTag(track.genre)` and projected release has no valid `genreTags`). Resolved by editing Album **Genre** (cascaded to member tracks). |
| `compilation_missing_original_album` | `P2` | Compilation tracks missing `original_album` | `tracks` | Release or track matches the shared compilation predicate (`Boolean(release?.isCompilation \|\| release?.genreTags?.some(g => g.toLowerCase().includes('compilation')) \|\| /\b(hits\s+of\|best\s+of\|golden\s+hits\|anthology\|collection\|classics)\b/i.test(release?.title \|\| '') \|\| tracks.some(t => t.isCompilation \|\| /\(from\s+["'][^"']+["']\)/i.test(t.title)))`) and `!track.originalAlbum?.trim()`. Resolved by editing track `originalAlbum` provenance in **Selected Track & Singers**. |
| `multi_soundtrack_missing_provenance` | `P2` | Multi-soundtrack combos without track provenance | `releases` | `Boolean(release.physicalComboTitle) \|\| (disambiguateComboTitle(release.title, release.folderPath \|\| release.folderName).parts?.length ?? 0) > 1` and `tracks.some(t => !t.originalAlbum?.trim())`. Resolved by populating track `originalAlbum` provenance or editing **Album Title**. |
| `duplicate_editions_missing_note` | `P3` | Duplicate editions missing a distinguishing note | `releases` | Two or more releases share the same `normalizeCanonicalAlbumTitle(release.title)` and normalized artist/composer key while having identical raw `release.title` strings. Resolved by appending a parenthetical edition note to **Album Title** (e.g., `Roja (Original CD)`) or clicking **Dismiss Problem**. |
| `info_exempt_valid_artist_no_composer` | `Info · Exempt` | Valid album artist and no composer | `releases` | Release has a valid non-placeholder `albumArtist` and empty `composer`. Read-only row in **Priority Settings**; never adds albums to the filtered work list. |

### 3. Independent Filter Matching, Ranking, and Auto-Reset (`CurateFilterBar.tsx`)

*   **Filter State Persistence & Global Chip Counts**: Persist `CurateFilterState` (`{ priorities: CuratePriorityTier[]; categories: CurateProblemCategoryId[]; selectedAlbumIdFilter?: string }`) in `localStorage` (`cadence.curate.filters.v1`) alongside Priority Settings (`cadence.curate.priority-settings.v1`) and dismissed problems (`cadence.curate.dismissed-problems.v1`). Chip counts on **Priority** (`priorityAlbumCounts`) and **Problem Category** (`categoryCounts`) always reflect global `CatalogProblemSummary` totals over the projected catalog rather than cross-filtered facet counts.
*   **Matching Rule**:
    *   An album holds zero or more non-dismissed problem instances `{ categoryId, priority }` where `priority = PrioritySettings[categoryId]`.
    *   A problem instance matches the active chip filters when `(priorities.length === 0 || priorities.includes(instance.priority)) && (categories.length === 0 || categories.includes(instance.categoryId))`.
    *   An album matches the active filter bar when it has at least one matching problem instance AND (if an album filter is selected from the **Album** search dropdown) its `release.id` equals `selectedAlbumIdFilter`.
*   **Scoped `Album` Search Dropdown**: The **Album** search dropdown filters albums that already match the active `Priority` and `Problem Category` chips using a case-insensitive substring match on `release.title` (so selecting a suggested album from the dropdown never triggers a zero-match reset).
*   **Ranking**: Each matching album appears once in the left rail, ordered by its highest matching priority (`P0` < `P1` < `P2` < `P3`), with deterministic tie-breaking by album title (`localeCompare`).
*   **Zero-Match Filter Handling (Selection vs. Batch Completion)**:
    *   **Filter Change or Initial Load Yields Zero Albums**: When toggling a filter chip, saving **Priority Settings**, or opening Curate with stored filters yields zero matching albums, Curate immediately clears all filters to `{ priorities: [], categories: [], selectedAlbumIdFilter: undefined }` and displays the status toast `"No albums match. Filters reset."`
    *   **Resolving or Dismissing the Last Album in an Active Filter Batch**: When the user resolves (via **Commit Album** / **Commit All**) or dismisses (**Dismiss Problem**) the final remaining album in an active filter, Curate displays an inline completion state in the left rail (`"All albums matching current filters are resolved"`) with a one-click **Reset Filters** button (which clears the filters and shows `"No albums match. Filters reset."`).
    *   **In-Place Album Search Input**: Typing a text query in the **Album** search input that matches zero dropdown suggestions displays `"No matching albums"` inside the dropdown without clearing active chip filters.
*   **Direct Entry from Listen (`Listen → Album → Curate Album Metadata & Artwork`)**:
    *   When `initialSelectedAlbumId` is supplied from **Listen**, Curate preserves the remembered `CurateFilterState` and `filteredAlbums` rail untouched and opens `initialSelectedAlbumId` directly in the album workbench even if that album falls outside the current filter list or has zero detected problems.

### 4. Human-Triggered Enrichment, Explicit Suggestion Adoption & Workbench Scope

*   **Removal of Automatic Selection Lookups**:
    *   Remove the automatic `useEffect` hooks in [`UnifiedCurateCockpit.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L936-L1021) and [lines 1408–1562](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L1408-L1562) that trigger `resolve2of3ReleaseConsensus` and Gemini compilation provenance inference on `selectedAlbum?.id` change, as well as background `LookaheadQueuePrefetcher` auto-enrichment.
    *   When the user clicks an album in the left rail, Curate restores any existing user-saved SQLite draft (`curationGetDraft` with `userOverridden: true`) and existing saved evidence (`curationListEvidence` / `curationGetEvidence`).
*   **Explicit Suggestion Adoption Handshake in `Selected Output`**:
    *   Opening an album without a restored user-saved draft (`userOverridden: true`) initializes **Selected Output** (`selected`) strictly equal to the raw physical file baseline (`local` from `rawTracks`, `rawReleases`) across all 6 album fields (`albumTitle`, `albumArtist`, `composer`, `year`, `coverArt`, `genre` where `rawGenre = rawRelease?.genreTags?.[0] || rawTrackGenre || ''`) and all 4 track fields (`matchedTitle = localTitle`, `matchedArtists = localArtists`, `originalAlbum`, `originalYear`), displaying `No changes from local tags` in the **Selected Output** header—without pre-applying `behavioralLearningService.applyLearnedRules`, `applySoundtrackConventions`, `getCuratedAlbumArtwork`, or `'Soundtrack'` genre fallbacks into `selected`.
    *   To adopt provider or learned suggestions into **Selected Output**, the user either clicks an individual provider candidate cell, edits a field inline, or clicks the **Accept Suggestions** button in the **Selected Output** column header (`applyAcceptedSuggestionsToDraft`), which copies the consensus/learned proposal (from `resolve2of3ReleaseConsensus` + `behavioralLearningService` conventions, or `savedAppleEvidence` when no fresh consensus has been fetched) into every album and track field where `userOverridden !== true`, and marks the updated fields and draft `userOverridden: true` (`staged: true`). **Accept Suggestions** is disabled when no provider evidence or learned convention differs from `selected`.
    *   External provider queries (**Refresh Evidence** / **Steer Providers**) run only when explicitly clicked by the user; when results return, they populate the provider columns (`Apple Music Master`, `MusicBrainz Archive`, `Gemini AI Master`) and update available proposals without overwriting `selected` unless the user clicks a candidate cell or **Accept Suggestions**.
*   **Workbench UI Cleanup**:
    *   Remove the **Capture Snapshot** button and handler (`captureDiagnosticSnapshot`, `diagnosticSnapshot` state at [`UnifiedCurateCockpit.tsx:468, 847, 865-898, 2432-2461`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L2432-L2461)).
    *   Remove the standalone `saved-apple-evidence` banner above the album metadata table ([`UnifiedCurateCockpit.tsx:2463-2477`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L2463-L2477)), while retaining the `savedAppleEvidence` state hook ([lines 845–863](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L845-L863)) so saved Apple candidates continue to appear inline beside their mapped local tracks and album fields.
    *   Remove the global app header's green staging indicator ([`App.tsx:1729-1743`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L1729-L1743)), hide the global `CommitStatusPill` when `topMode === 'curate'` ([`App.tsx:1758`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L1758)), and hide the Cadence Music Agent Copilot button, `⌘J` shortcut, Spotlight Command Palette item `cmd-cadence-agent`, and `<EmbeddedAgentDrawer />` mount ([`App.tsx:48, 1141-1150, 1499-1506, 1802-1817, 2465-2476`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L1499-L1506)).

### 5. Staging, Raw-Physical-File Diffing Before Commit, Commit Preview, Commit Queue Drawer & Post-Commit Filter Resolution

*   **Stage & Next (Single Source of Staging Truth)**:
    *   Saves the current album's **Selected Output** draft to SQLite (`curation_drafts`) with `staged: true` (`userOverridden: true`) and a draft `revision` UUID.
    *   Does **not** call `graphEngine.updateTrackSidecar(...)`, eliminating dual in-memory sidecar staging state from Curate.
    *   Displays the `✓ Staged` badge on the album card in the filtered left rail and advances `selectedAlbumId` to the next album in `filteredAlbums`.
*   **Dismiss Problem (Rescan-Safe False-Positive Exemption)**:
    *   In the workbench header, provide a **Dismiss Problem** action listing the current album's detected problem categories (with an option to dismiss a specific category or all current problems on that album).
    *   Persists `{ [key]: CurateProblemCategoryId[] }` to `localStorage` (`cadence.curate.dismissed-problems.v1`) across all keys returned by [`curateReviewKeys(releaseId, tracks)`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L39-L44) (both `release.id` and normalized sorted `track.filePath` JSON) and surfaces a `"Dismissed Problem Exemptions"` list with a `Restore` button (`removeDismissedProblem`) inside the existing **Learned Rules** modal ([`UnifiedCurateCockpit.tsx:2993-3092`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/UnifiedCurateCockpit.tsx#L2993-L3092)).
*   **Always Diff Selected Output Against the Raw Physical File Before Commit (`makeCurateCommitItems`)**:
    *   Before enqueuing any commit (via **Commit Album** or **Commit All**), `makeCurateCommitItems(draft, rawTracks, rawRelease)` always diffs each track's **Selected Output** (`selectedTags(draft, selection)`) against that track's **raw physical file baseline** (`rawTrack` + `rawRelease` on disk)—never the Commit-Queue-projected catalog.
    *   **Skip Unchanged Tracks (`Zero Redundant Disk Writes`)**: Any track whose **Selected Output** tags and `coverArtUrl` are already 100% in sync with its raw physical file on disk (`hasTrackPhysicalDelta(draft, selection, rawTrack, rawRelease) === false`) is omitted from the returned `NewCommitItemPayload[]`, and `curateTrackCount` is set to the count of actually modified tracks (`items.length`). If all tracks on an album are already in sync with the raw physical files (`items.length === 0`), **Commit Album** is disabled and **Commit All** excludes the album.
    *   **Seamless Superseding Partial Commits (CUJ 2)**: Because **Selected Output** is always diffed against the raw physical file on disk, when a user commits **Cover Artwork** first while playback pauses disk writes and then edits **Album Artist** and clicks **Commit Album** a second time, the raw-physical-file diff automatically includes **both** the un-written **Cover Artwork** delta and the new **Album Artist** delta. In [`src-tauri/src/db/operations.rs:2555-2571`](file:///e:/Mathan/Code/Music%20Agent/src-tauri/src/db/operations.rs#L2555-L2571), `DbOperations::insert_commit_with_curate_drafts` blocks only when a track has an `in_flight` or `failed` item (`status IN ('in_flight', 'failed')`), allowing Commit #2 to cleanly supersede the `pending` Commit #1 row in place with the complete cumulative diff against the physical file.
*   **Commit Album & Commit All (`CurateCommitPreviewModal.tsx`)**:
    *   **Commit Album** in the workbench header captures `commitDraft = captureAlbumDraft(album, ...)` with `fields[k].userOverridden` intact, builds `items = makeCurateCommitItems(commitDraft, rawTracks, rawRelease)`, constructs `persistedDraft = { ...commitDraft, staged: false }`, enqueues `items` + `persistedDraft` via `commitEnqueueBatch`, persists `saveAlbumDraft(persistedDraft)`, and sets `userOverridden: false` on the in-memory `AlbumWorkItem`.
    *   **Commit All (N)** in the left rail header loads all staged drafts (`staged: true`) across sessions and outside current filters (via `tauriBridge.curationListDrafts()` plus mounted `albumItems`), filters to drafts that have at least one raw-physical-file diff (`makeCurateCommitItems(draft, rawAlbumTracks, rawRelease).length > 0`) and are not already reconciled with an active `CurateCommitRow` via [`matchesCurateConfirmation(draft, commitsByTrack, false)`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L163-L188), and opens `CurateCommitPreviewModal`. Upon confirming **Commit All**, each enqueued album's persisted `curation_drafts` record is updated to `staged: false` (`userOverridden: false`).
    *   `CurateCommitPreviewModal` lists each staged album, its modified track count, field-level and track-level diffs (`rawPhysical -> selected`), and the current transport state banner. If an album's underlying local tags changed since its draft was saved (`draft.baseline !== currentBaseline` as captured by [`captureCurateDraft`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateDraft.ts#L42-L61), or [`CurateCommitRow.lineageChanged`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L29)), the preview flags that album as needing review, excludes it from the batch enqueue, and retains its draft in **Selected Output** for manual inspection.
*   **Commit Queue Control & Drawer Above Filters**:
    *   In the Curate header (above the expandable filter band), render the **Commit Queue** status button and clickable drawer/popover (extending [`CommitStatusPill.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/CommandBar/CommitStatusPill.tsx) with `alwaysVisible?: boolean` and `commitRows?: CurateCommitRow[]`).
    *   The drawer derives its per-album and per-track status rows (`Queued — waiting for playback`, `Writing`, `Completed`, `Failed`) directly from `commitRows` (`commitGetCurateProjection`) combined with `CommitTelemetryPayload` (`commit_get_telemetry`) without adding redundant polling IPC calls.
*   **Post-Commit Filter Retention & Advance Logic**:
    *   [`App.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/App.tsx#L1943-L1945) passes both the Commit-Queue-projected catalog (`tracks`, `releases` from [`projectCurateCommits`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L242-L285)) and the raw physical file baseline (`rawTracks={catalogTracks}`, `rawReleases={catalogReleases}`) into `UnifiedCurateCockpit`, and removes the legacy `curateReviews` filter on `curateReleases`.
    *   When a commit is confirmed (via **Commit Album** or **Commit All**), `onCommitQueued()` refreshes the Commit Queue projection immediately.
    *   `evaluateCatalogProblems` re-runs against the updated projected catalog:
        *   **Problem resolved**: If the committed album no longer has any problem matching the active filter bar, it leaves `filteredAlbums` and `selectedAlbumId` advances to the next album in `filteredAlbums` (or displays the `"All albums matching current filters are resolved"` completion state with **Reset Filters** if `filteredAlbums` becomes empty).
        *   **Problem unresolved**: If the user committed a field that did not resolve the active filter's matching problem (for example, committing Cover Art while filtering by `Missing both album artist and composer`), the album enters the Commit Queue for that atomic save while remaining in `filteredAlbums` and staying open; when the user subsequently edits `Album Artist`, `matchesCurateConfirmation` detects the new field delta against the queued commit row and re-enables **Commit Album** for the second commit.

### 6. [AUDIOPHILE IMPACT ASSESSMENT]

Per `.agents/rules/audiophile.md`, this design adheres to all six transport purity invariants:

*   **Disk I/O Impact during active/paused playback**: **Zero music-drive I/O during playback, and fewer physical file writes when idle.** All 14 actionable problem category detectors, `Info · Exempt` calculation, Priority Settings changes, and filter evaluations execute 100% in-memory over the already-loaded `tracks` and `releases` arrays. Furthermore, diffing **Selected Output** against the raw physical file baseline before commit skips any track that is already in sync on disk, eliminating redundant physical file rewrites when `commit_worker.rs` drains the queue during idle transport.
*   **Network/NIC Burst Impact on Wi-Fi/Ethernet**: **Reduced to zero automatic traffic.** Removing automatic `resolve2of3ReleaseConsensus`, automatic Gemini provenance inference on album selection, and background `LookaheadQueuePrefetcher` calls eliminates unsolicited network bursts when clicking through albums during playback. Network calls occur only when the user explicitly clicks **Refresh Evidence** / **Steer Providers**.
*   **Thread/CPU Scheduling Impact on Core 0/1 and the pinned streaming core**: **Zero impact.** No background threads are spawned and no changes are made to `cadence-paced-stream`, MMCSS priority, or CPU core affinity masks.
*   **Memory Allocation Impact on `VirtualLock` and heap churn**: **Zero impact.** `stream_tuning.rs` and `VirtualLock` working-set management remain untouched.

## Alternatives Considered

### Alternative A: Two-Tab Left Rail (Tab 1: Filtered Albums to Edit, Tab 2: Commit Queue)

*   **Pros**: Keeps a two-tab switcher in the left rail similar to the legacy Tier 1 / Tier 2 layout while separating active editing from committed albums.
*   **Cons**: The active filter bar applies to Tab 1 but has no meaning for Tab 2; Tab 2 remains empty unless the user commits a large batch while audio playback is active; and once an album is in the Commit Queue, the user has no editing action to perform in Tab 2.
*   **Reason for Rejection**: Mixing an editable filtered work list (Tab 1) and a read-only background write queue (Tab 2) beneath the same filter bar makes the interface incoherent. Placing the **Commit Queue** as a status control and clickable drawer in the Curate header above the filters keeps the left rail dedicated to the filtered work list.

### Alternative B: Automatic Provider Enrichment on Album Selection with Heuristic Batch Filtering

*   **Pros**: Prefills provider suggestions into **Selected Output** as soon as the user clicks an album in the left rail.
*   **Cons**: Fires background network calls and writes auto-generated `curation_drafts` rows to SQLite whenever a user clicks an album just to inspect it. At batch-commit time, Curate would have to rely on heuristics to separate unreviewed auto-saves from intentional user edits.
*   **Reason for Rejection**: Violates user control and creates accidental draft pollution and network chatter. Making provider enrichment (**Refresh Evidence** / **Steer Providers**) and candidate adoption (**Accept Suggestions** or cell click) strictly human-triggered guarantees that every staged draft reflects deliberate user action.

### Alternative C: Replacing `Stage & Next` and `Commit Album` with Only `Next` and One Global `Commit` Button

*   **Pros**: Reduces the number of action buttons in the workbench header.
*   **Cons**: Removes the explicit distinction between skipping an album (`Next` / clicking another album) and staging an album for batch commit (`Stage & Next`), and forces a user fixing a single album from **Listen** to step through a multi-album batch preview.
*   **Reason for Rejection**: Retaining **Stage & Next**, **Commit Album**, and **Commit All** for staged albums keeps staging explicit and supports both immediate single-album atomic commits and multi-album staged batch commits.

--------------------------------------------------------------------------------

## Risks & Mitigations

*   **Dismissed Problem Key Stability Across Rescans**: Library rescans after physical tag writes can regenerate `release.id`. To prevent false-positive exemptions (such as self-titled albums) from being lost after a rescan, `saveDismissedProblem`, `removeDismissedProblem`, and `evaluateAlbumProblems` index exemptions across all keys returned by [`curateReviewKeys(releaseId, tracks)`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L39-L44) (both `release.id` and the sorted normalized `track.filePath` list).
*   **Stale Baseline & Concurrent Draft Conflicts During `Commit All`**: Staged drafts can persist across sessions while underlying files are edited externally or by earlier commits. `CurateCommitPreviewModal` compares each staged draft's `baseline` snapshot ([`captureCurateDraft`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateDraft.ts#L42-L61)) against the current raw physical baseline and checks `CurateCommitRow.lineageChanged`, excluding any conflicting album from batch enqueue so external edits are never silently overwritten.
*   **Bounded SQLite Read Scope (`curation_list_drafts`)**: `CurationStorage::list_drafts` queries only user-created rows in the application SQLite table `curation_drafts` (`AppDb`) when initializing staged badges or opening `CurateCommitPreviewModal`, logs and skips any row with malformed JSON without panicking, and never touches music library drives.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Performance & Latency**: Computing the 14 actionable problem category predicates, `Info · Exempt` count, and filtered album ranking across 2,000+ tracks and 300+ releases must execute in `< 10 ms` in memory without blocking UI rendering. Loading all saved drafts for **Commit All** preview uses a single SQLite query (`curation_list_drafts`) rather than N sequential IPC round-trips.
*   **Audiophile Transport Quietness**: Zero music-drive disk reads/writes and zero automatic network fetches during album selection or playback; zero redundant file writes for tracks already in sync with **Selected Output**.
*   **Persistence & Rollback Safety**: Priority Settings (`cadence.curate.priority-settings.v1`), active filter state (`cadence.curate.filters.v1`), and dismissed problem exemptions (`cadence.curate.dismissed-problems.v1`) are stored in `localStorage`, validate stored keys on load, and fall back to default P0–P3 assignments if corrupted. Existing `curation_drafts` and `commit_queue` SQLite schemas require no destructive migration.

--------------------------------------------------------------------------------

### Additional Resources

*   [CurateArchitecture.md](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CurateArchitecture.md)
*   [ASYNCHRONOUS_BACKGROUND_COMMIT_QUEUE_ARCHITECTURE.md](file:///e:/Mathan/Code/Music%20Agent/docs/designs/ASYNCHRONOUS_BACKGROUND_COMMIT_QUEUE_ARCHITECTURE.md)

--------------------------------------------------------------------------------

## Detailed Implementation Plan

All implementation work follows strict **Test-Driven Development (TDD)**: for each target module below, write the failing automated tests first (**Red**), implement the minimal production code to pass (**Green**), and clean up (**Refactor**). Pure view-model builders and state-transition helpers are exported from UI components and rendered via `react-dom/server` (`renderToStaticMarkup`) in Node/TSX tests so component logic is verified automatically via CLI. Cases that require human interaction in the live Tauri window are explicitly called out under **Human Input Required**.

### Execution Phases & Checkpoints

*   **Phase 1 — Core Types, Raw-Physical-File Commit Diffing, Native Draft/Queue IPC & Priority Engine (Targets #9, #8, #1)**:
    *   Implement Target #9 (`src/core/types.ts`, `src/core/curateCommit.ts`), Target #8 (`src-tauri/src/curation/storage.rs`, `src-tauri/src/commands/curation.rs`, `src-tauri/src/db/operations.rs`, `src-tauri/src/lib.rs`, `src/services/tauriBridge.ts`), and Target #1 (`src/core/curatePriorities.ts`).
    *   *Phase 1 Checkpoint*: `cargo test --manifest-path src-tauri/Cargo.toml curation::storage`, `npx tsx --test src/test/testCurateCommit.ts`, and `npx tsx --test src/test/testCuratePriorities.ts`.
*   **Phase 2 — Presentational Filter, Priority Modal, Commit Preview & Commit Queue Drawer Components (Targets #2, #3, #4, #5)**:
    *   **Status: Completed (2026-11-08).** User verified the Curate Commit Queue after it was limited to queued and writing tracks and the duplicate album status panel was removed. Filter Bar and Commit Preview passed component and isolated browser checks. Workbench wiring for both belongs to Phase 3.
    *   Implement Target #2 (`CurateFilterBar.tsx`), Target #3 (`CuratePrioritySettingsModal.tsx`), Target #4 (`CurateCommitPreviewModal.tsx`), and Target #5 (`CommitStatusPill.tsx`).
    *   *Phase 2 Checkpoint*: `npx tsx --test src/test/testCurateFilterBar.ts`, `npx tsx --test src/test/testCuratePrioritySettingsModal.ts`, `npx tsx --test src/test/testCurateCommitPreviewModal.ts`, and `npx tsx --test src/test/testCommitStatusPill.ts`.
*   **Phase 3 — Workbench & App Shell Integration (Targets #6, #7)**:
    *   Implement Target #6 (`UnifiedCurateCockpit.tsx`) and Target #7 (`src/App.tsx`), cleaning up any newly unused state variables or imports so `tsc -b` compiles cleanly.
    *   *Phase 3 Checkpoint*: `npx tsx --test src/test/testUnifiedCurateWorkflow.ts`, `npx tsx --test src/test/testAppCurateIntegration.ts`, `npm run lint`, `npm run build`, and `cargo check --manifest-path src-tauri/Cargo.toml`.

### Target Files to Create/Modify

#### 1. `src/core/curatePriorities.ts` (Create)

*   **Type / Scope**: TypeScript Domain Module (Replaces `computeCurationQueue` in `src/services/curationQueueService.ts`)
*   **Proposed Changes**:
    *   Define `CuratePriorityTier` (`'P0' | 'P1' | 'P2' | 'P3'`), `CurateProblemCategoryId` (14 actionable category identifiers), `PrioritySettings` (`Record<CurateProblemCategoryId, CuratePriorityTier>`), `DEFAULT_PRIORITY_SETTINGS`, `DismissedProblemsMap` (`Record<string, CurateProblemCategoryId[]>`), `CurateAlbumSummary` (`{ id: string; title: string }`), and `CurateFilterState` (`{ priorities: CuratePriorityTier[]; categories: CurateProblemCategoryId[]; selectedAlbumIdFilter?: string }`).
    *   Implement `evaluateAlbumProblems(albumId: string, tracks: Track[], release: Release | undefined, allReleases: Release[], settings: PrioritySettings, dismissed?: DismissedProblemsMap): AlbumProblemInstance[]` and `evaluateCatalogProblems(tracks: Track[], releases: Release[], settings: PrioritySettings, dismissed?: DismissedProblemsMap): CatalogProblemSummary` covering all 14 actionable problem category predicates, `priorityAlbumCounts`, `info_exempt_valid_artist_no_composer` (`Info · Exempt`), and `totalActionableAlbums` (used for `App.tsx`'s `curateBadgeCount`), reusing `cleanRipNoise`, `stripRipNoiseAndTags`, `normalizeCanonicalAlbumTitle`, `isPlaceholderTag`, `isDefectiveArtistTag`, and `disambiguateComboTitle` from [`src/core/taxonomyUtils.ts`](file:///e:/Mathan/Code/Music%20Agent/src/core/taxonomyUtils.ts) and [`curateReviewKeys`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts#L39-L44) from [`src/core/curateCommit.ts`](file:///e:/Mathan/Code/Music%20Agent/src/core/curateCommit.ts).
    *   Implement generic `filterAndRankCurateAlbums<T extends CurateAlbumSummary>(albums: T[], summary: CatalogProblemSummary, filter: CurateFilterState): T[]` and `resolveFilterTransition<T extends CurateAlbumSummary>(albums: T[], summary: CatalogProblemSummary, nextFilter: CurateFilterState, reason: 'filter_change' | 'batch_resolved')` enforcing:
        *   Intra-group OR (`priorities.includes(instance.priority)`, `categories.includes(instance.categoryId)`) and same-problem-instance cross-group AND (`(priorities.length === 0 || priorities.includes(instance.priority)) && (categories.length === 0 || categories.includes(instance.categoryId))`).
        *   Deduplication and ranking by highest matching priority (`P0` < `P1` < `P2` < `P3`), then album title ascending (`localeCompare`).
        *   Zero-match auto-reset (`{ filter: { priorities: [], categories: [] }, toastMessage: 'No albums match. Filters reset.' }`) when `reason === 'filter_change'`, vs. inline filter-completion state (`{ filterCompleted: true }`) when `reason === 'batch_resolved'`.
    *   Implement `loadPrioritySettings(storage?)`, `savePrioritySettings(settings, storage?)`, `resetPrioritySettings(storage?)`, `loadCurateFilterState(storage?)`, `saveCurateFilterState(filter, storage?)`, `loadDismissedProblems(storage?)`, `saveDismissedProblem(albumId, categoryId, tracks?, storage?)`, and `removeDismissedProblem(albumId, categoryId, tracks?, storage?)` backed by `localStorage` keys `cadence.curate.priority-settings.v1`, `cadence.curate.filters.v1`, and `cadence.curate.dismissed-problems.v1` (storing and removing keys across `curateReviewKeys(albumId, tracks)`).
*   **Detailed Test Plan (TDD — `src/test/testCuratePriorities.ts`)**:
    *   **Command**: `npx tsx --test src/test/testCuratePriorities.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **14 Actionable Problem Category Predicates**: Write 14 positive/negative fixture test pairs verifying each category (`cd_rip_suffix`, `artist_as_album_title`, `placeholder_track_titles`, `missing_artist_and_composer`, `track_artist_copied_from_album`, `featured_artist_missing_from_tag`, `missing_release_year`, `missing_track_year`, `missing_cover_art`, `missing_album_genre`, `missing_track_genre`, `compilation_missing_original_album`, `multi_soundtrack_missing_provenance`, `duplicate_editions_missing_note`).
        2.  **Exempt Album Artist without Composer (`Info · Exempt`), Rescan-Safe Self-Titled Dismissal & Restoration**: Assert that a release with a valid non-placeholder `albumArtist` and empty `composer` is counted in `infoExemptCount` without adding the album to the filtered work list; that calling `saveDismissedProblem(albumId, 'artist_as_album_title', tracks)` exempts the album even if `release.id` changes on rescan while track `filePath`s remain identical; and that `removeDismissedProblem` restores the problem category.
        3.  **Independent Multi-Problem Filter Matching**: Given Album X with both a `P0` (`placeholder_track_titles`) and a `P2` (`compilation_missing_original_album`) problem:
            *   Filtering by `priorities: ['P2'], categories: []` returns Album X.
            *   Filtering by `priorities: ['P0'], categories: ['compilation_missing_original_album']` (mismatched pair on the same album) excludes Album X.
            *   Filtering by `priorities: ['P2'], categories: ['compilation_missing_original_album']` returns Album X.
        4.  **Priority Remapping & Persistence**: Assert that remapping `missing_cover_art` from `P1` to `P0` via `savePrioritySettings` persists to mock `localStorage`, re-ranks Album X as `P0`, and `resetPrioritySettings` restores `DEFAULT_PRIORITY_SETTINGS`.
        5.  **Zero-Match Auto-Reset vs. Batch Completion**: Assert that `resolveFilterTransition` with 0 matching albums resets filters with `'No albums match. Filters reset.'` when `reason === 'filter_change'`, and returns `{ filterCompleted: true }` when `reason === 'batch_resolved'`.
    *   **Human Input Required**: **None** (100% automated via CLI).

#### 2. `src/components/Curate/CurateFilterBar.tsx` (Create)

*   **Type / Scope**: React UI Component
*   **Proposed Changes**:
    *   Export pure view-model builder `buildCurateFilterBarModel(summary: CatalogProblemSummary, settings: PrioritySettings, activeFilter: CurateFilterState, albumSearchQuery: string)` alongside `<CurateFilterBar />`.
    *   Render the expandable horizontal filter band directly below the Curate header with:
        *   Multi-select **Priority** chips (`P0`, `P1`, `P2`, `P3`) with global `priorityAlbumCounts` from `CatalogProblemSummary`.
        *   Multi-select **Problem Category** chips/options (the 14 actionable categories grouped by their current `P0`–`P3` assignment) with global `categoryCounts` (`releases` or `tracks`) from `CatalogProblemSummary`.
        *   In-place **Album** search input and suggestion dropdown scoped to albums matching the active `Priority` and `Problem Category` chips via case-insensitive substring match on `release.title` (`"No matching albums"` when a typed query matches 0 dropdown suggestions, without resetting active chip filters).
        *   **Reset Filters** button rendered when any priority chip, category chip, or album filter is active.
*   **Detailed Test Plan (TDD — `src/test/testCurateFilterBar.ts`)**:
    *   **Command**: `npx tsx --test src/test/testCurateFilterBar.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **Global Live Counts, Regrouping & Scoped Search Dropdown**: Assert `buildCurateFilterBarModel` computes exact per-priority (`priorityAlbumCounts`) and per-category (`categoryCounts`) totals from `CatalogProblemSummary`, regroups categories when `PrioritySettings` changes, scopes dropdown candidates to albums matching active chip filters via case-insensitive substring on `release.title`, and returns `"No matching albums"` for a non-matching search query without clearing `activeFilter.priorities` or `activeFilter.categories`.
        2.  **Static Markup Rendering (`renderToStaticMarkup`)**: Render `<CurateFilterBar />` with default and active chip filters; assert **Reset Filters** is absent when no filters are active and present when any chip or album filter is selected.
    *   **Human Input Required**: **Minimal visual check** — verify chip wrapping and Album search dropdown positioning across narrow window widths.

#### 3. `src/components/Curate/CuratePrioritySettingsModal.tsx` (Create)

*   **Type / Scope**: React Modal Component
*   **Proposed Changes**:
    *   Export pure draft reducer `updatePrioritySettingsDraft(draft: PrioritySettings, category: CurateProblemCategoryId, nextTier: CuratePriorityTier)` alongside `<CuratePrioritySettingsModal />`.
    *   Render a modal dialog triggered from **Priority Settings** in the Curate header listing all 14 actionable problem categories with `P0` / `P1` / `P2` / `P3` selector controls, live affected counts (`releases` or `tracks`), and the read-only `Info · Exempt` (`Valid album artist and no composer`) row at the bottom.
    *   Provide **Save priorities** (commits the modal draft to `localStorage` and recomputes `evaluateCatalogProblems` while keeping the current album open), **Reset to Default**, and **Cancel** actions.
*   **Detailed Test Plan (TDD — `src/test/testCuratePrioritySettingsModal.ts`)**:
    *   **Command**: `npx tsx --test src/test/testCuratePrioritySettingsModal.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **14 Actionable Rows + 1 Read-Only Exempt Row**: Render `<CuratePrioritySettingsModal isOpen={true} ... />` via `renderToStaticMarkup` and assert all 14 actionable category labels render with tier controls while `Info · Exempt` (`Valid album artist and no composer`) renders as read-only (`disabled` / no tier selector).
        2.  **Atomic Save vs. Cancel**: Assert that editing a tier in the modal draft does not mutate persisted settings until **Save priorities** is invoked, and **Reset to Default** restores `DEFAULT_PRIORITY_SETTINGS`.
    *   **Human Input Required**: **Minimal interactive check** — open **Priority Settings** in the desktop UI, change a category's priority, click **Save priorities**, and confirm the left rail reorders while the open album stays open.

#### 4. `src/components/Curate/CurateCommitPreviewModal.tsx` (Create)

*   **Type / Scope**: React Modal Component
*   **Proposed Changes**:
    *   Export pure diff-builder `buildCommitPreviewSummary(albumsToCommit: CommitPreviewAlbumInput[], isTransportBusy: boolean)` alongside `<CurateCommitPreviewModal />`.
    *   Render the confirmation preview modal for **Commit All** across all staged albums (`staged: true`) from the current and prior sessions.
    *   Display each staged album title, modified track count (only tracks that differ from their raw physical file on disk), field-level and track-level diffs (`rawPhysical -> selected`), any baseline-conflict warning (`draft.baseline !== currentBaseline` or `lineageChanged` excluded from batch enqueue and kept for manual review), and the transport state banner (`Engine Idle — writes will begin immediately` vs. `Playback Active — writes will queue in Commit Queue until playback stops + 30s cooldown`).
*   **Detailed Test Plan (TDD — `src/test/testCurateCommitPreviewModal.ts`)**:
    *   **Command**: `npx tsx --test src/test/testCurateCommitPreviewModal.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **Cross-Session Staged Diffs vs. Raw Physical Baseline & Conflict Exclusion**: Assert `buildCommitPreviewSummary` produces exact `rawPhysical -> selected` diffs for valid staged albums, omits tracks that are already in sync with the raw physical file, and flags/excludes any staged album whose `draft.baseline !== currentBaseline` or `lineageChanged === true`.
        2.  **Transport Gate Banner**: Render `<CurateCommitPreviewModal />` via `renderToStaticMarkup` with `isTransportBusy={false}` and `isTransportBusy={true}`; assert the idle vs. active-playback Commit Queue banner text renders accurately.
    *   **Human Input Required**: **None** for diff calculation and banner rendering; covered by end-to-end user verification gate on batch commit confirmation.

#### 5. `src/components/CommandBar/CommitStatusPill.tsx` (Modify)

*   **Type / Scope**: React UI Component
*   **Proposed Changes**:
    *   Export `CommitQueueDrawerModel` interface and pure drawer-model helper `buildCommitQueueDrawerModel(commitRows: CurateCommitRow[], telemetry: CommitTelemetryPayload | null): CommitQueueDrawerModel` alongside `<CommitStatusPill />`.
    *   Add `alwaysVisible?: boolean` and `commitRows?: CurateCommitRow[]` props so that when rendered in the Curate header above the filter bar, the control remains visible even when the Commit Queue is idle (`Commit Queue (0)`).
    *   Add a clickable **Commit Queue Drawer** displaying queued and writing tracks grouped by album, with playback-paused status from telemetry. Show an empty state when idle. Failed writes can be retried from the affected album.
*   **Detailed Test Plan (TDD — `src/test/testCommitStatusPill.ts`)**:
    *   **Command**: `npx tsx --test src/test/testCommitStatusPill.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **Idle Visibility (`alwaysVisible`)**: Render `<CommitStatusPill />` via `renderToStaticMarkup` with 0 active items and `alwaysVisible={false}` (returns empty string) vs. `alwaysVisible={true}` (renders `Commit Queue (0)` button).
        2.  **Drawer Item Grouping & Status Labels**: Pass `commitRows` containing queued, writing, completed, and failed items into `buildCommitQueueDrawerModel` and assert that only queued and writing tracks are grouped by album, with the correct playback-paused label. Verify the idle drawer hides the previous batch.
    *   **Human Input Required**: **Minimal interactive check** — click the **Commit Queue** button in the Curate header to verify drawer open/close positioning above the filter bar.

#### 6. `src/components/Curate/UnifiedCurateCockpit.tsx` (Modify)

*   **Type / Scope**: React Workbench Component & Pure Workflow Controller Helpers
*   **Proposed Changes**:
    *   Extract and export pure workflow helpers (`resolveAlbumSelectionDraftState`, `applyAcceptedSuggestionsToDraft`, `resolvePostCommitNavigation`, `resolveStagedAlbumIds`, `stepFilteredAlbumSelection`) so every state transition in `UnifiedCurateCockpit` is unit-tested before wiring JSX.
    *   Accept Commit-Queue-projected catalog props (`tracks`, `releases` — used for `evaluateCatalogProblems` and filter matching) alongside optional raw physical file baseline props (`rawTracks?: Track[]`, `rawReleases?: Release[]`, defaulting to `tracks` and `releases` — used to initialize `local` baselines on `AlbumWorkItem`, `localCoverArt`, and `makeCurateCommitItems` so **Selected Output** is always diffed against the raw physical file on disk).
    *   Remove Tier 1 / Tier 2 header tab switcher, Tier 1 auto-staged card list, `Done reviewing` toggle button, **Capture Snapshot** button and state (`captureDiagnosticSnapshot`, `diagnosticSnapshot` at `lines 468, 847, 865-898, 2432-2461`), and the standalone `data-testid="saved-apple-evidence"` banner while retaining the `savedAppleEvidence` state hook used by album field rows and track rows. Clean up any newly unused state variables or imports so `tsc -b` compiles with zero `TS6133` errors.
    *   Remove automatic external provider enrichment (`resolve2of3ReleaseConsensus` and Gemini compilation inference `useEffect`s) on album selection, remove automatic learned/soundtrack/artwork pre-mutation of `selected` on initial album construction (`selected = local` from `rawTracks`/`rawReleases` unless a user-saved draft with `userOverridden: true` is restored), and remove `graphEngine.updateTrackSidecar(...)` calls from staging.
    *   Add **Accept Suggestions** (`applyAcceptedSuggestionsToDraft`) in the **Selected Output** column header (adopting consensus/learned proposals or `savedAppleEvidence` into fields where `userOverridden !== true` and marking the draft `userOverridden: true`) and **Dismiss Problem** in the workbench header (with a `"Dismissed Problem Exemptions"` restoration list inside the existing **Learned Rules** modal).
    *   Retain **Stage & Next**, **Commit Album**, and **Commit All (N)**:
        *   **Stage & Next** marks the active album `staged: true` in `curation_drafts`, shows `✓ Staged` in the rail, and advances `selectedAlbumId` to the next album in `filteredAlbums`.
        *   **Commit Album** and **Commit All** follow the 3-step commit sequence: (1) capture `commitDraft = captureAlbumDraft(album, ...)` with `fields[k].userOverridden` intact and generate `items = makeCurateCommitItems(commitDraft, rawAlbumTracks, rawRelease)` (diffing **Selected Output** strictly against the raw physical file baseline and skipping any track already in sync on disk); (2) construct `persistedDraft = { ...commitDraft, staged: false }` (keeping `fields` intact while setting top-level `staged: false`); and (3) pass `persistedDraft` to both `commitEnqueueBatch` and `saveAlbumDraft(persistedDraft)`, set `userOverridden: false` on the in-memory `AlbumWorkItem`, and evaluate `evaluateCatalogProblems` against projected `tracks`/`releases` to either remove the album from `filteredAlbums` and advance selection (when all problems matching the active filter are resolved) or keep the album open in `filteredAlbums` (when the filter problem remains unresolved).
    *   Update `⌘[` / `⌘]` keyboard navigation to step through `filteredAlbums`.
*   **Detailed Test Plan (TDD — `src/test/testUnifiedCurateWorkflow.ts`)**:
    *   **Command**: `npx tsx --test src/test/testUnifiedCurateWorkflow.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **No Auto-Enrichment or Unapproved Green Diffs on Album Selection**: Assert `resolveAlbumSelectionDraftState` initializes `Selected Output` strictly from raw physical file tags (or an existing user-saved draft with `userOverridden: true`) showing `No changes from local tags`, and only populates provider/learned proposals into `Selected Output` when `applyAcceptedSuggestionsToDraft` or a field selection is explicitly invoked (preserving any already manually overridden fields).
        2.  **Saved Apple Evidence Cell Retention without Standalone Banner**: Assert that saved Apple evidence populates field-level candidate props while the removed `data-testid="saved-apple-evidence"` banner is absent.
        3.  **Stage & Next Without Sidecar Mutation & Post-Commit `staged: false` Reset**: Assert `Stage & Next` marks the active album `staged: true` in draft state, advances `selectedAlbumId` to the next album in `filteredAlbums`, and makes zero calls to `graphEngine.updateTrackSidecar`; and assert that committing keeps `fields[k].userOverridden` for `makeCurateCommitItems`, persists `staged: false`, and excludes already-confirmed commit rows via `matchesCurateConfirmation`.
        4.  **Post-Commit Filter Resolution vs. Partial Commit Retention**:
            *   *Case A (Filter Problem Fixed)*: Active filter is `missing_artist_and_composer`. User edits `Album Artist` and clicks **Commit Album**. Projected catalog now has `Album Artist`. Assert `resolvePostCommitNavigation` removes the album from `filteredAlbums` and advances `selectedAlbumId` to the next album.
            *   *Case B (Filter Problem Unresolved / Partial Commit)*: Active filter is `missing_artist_and_composer`. User edits `Cover Artwork` only and clicks **Commit Album**. Batch is enqueued to Commit Queue, but projected catalog still lacks `Album Artist` and `Composer`. Assert `resolvePostCommitNavigation` keeps the album in `filteredAlbums` and keeps `selectedAlbumId` on that album so the user can make further changes and commit again.
        5.  **Keyboard Navigation (`⌘[` / `⌘]`)**: Assert `stepFilteredAlbumSelection` steps backward/forward strictly within `filteredAlbums`.
    *   **Human Input Required**: **End-to-End User Verification Gate** in the running app — click an album, verify no automatic provider call fires, click **Refresh Evidence** and **Accept Suggestions**, test **Stage & Next**, test **Dismiss Problem** (and restore in **Learned Rules**), and test **Commit Album** both when fixing the filtered problem and when committing an unrelated field.

#### 7. `src/App.tsx` (Modify)

*   **Type / Scope**: React Application Root
*   **Proposed Changes**:
    *   Export pure prop-projection helper `buildCurateCockpitCatalogProps(catalogTracks, catalogReleases, curateCommits, prioritySettings, dismissedProblems)` so `App.tsx`'s Curate data flow is unit-testable.
    *   Remove the top-bar green `N Albums · M Staged` indicator button (`lines 1729-1743`), retire `savedCurateReviews` (`cadence.curate.review-status.v1`), and replace `computeCurationQueue` badge calculation with `evaluateCatalogProblems(...).totalActionableAlbums` for `curateBadgeCount`.
    *   Hide the global `CommitStatusPill` when `topMode === 'curate'` so only the Curate header's Commit Queue control and drawer are shown in Curate.
    *   Hide the right-side Copilot toggle button (`lines 1802-1817`), `⌘J` keyboard shortcut handler (`lines 1141-1150`), Spotlight Command Palette entry `cmd-cadence-agent` (`lines 1499-1506`), and `<EmbeddedAgentDrawer />` mount (`lines 48, 2465-2476`) without deleting [`src/components/Agent/EmbeddedAgentDrawer.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Agent/EmbeddedAgentDrawer.tsx), and clean up any newly unused state variables or imports so `tsc -b` compiles with zero `TS6133` errors.
    *   Pass both Commit-Queue-projected (`tracks`, `releases` from `projectCurateCommits`) and raw physical file baseline (`rawTracks={catalogTracks}`, `rawReleases={catalogReleases}`) props to `<UnifiedCurateCockpit />`.
    *   When jumping from `Listen -> Album -> Curate` (`handleInspectRelease` / `onCustomizeRelease` setting `focusedReleaseId` at `lines 1230-1238, 2160-2171`), preserve the user's active Curate filter state and `filteredAlbums` list untouched while opening `focusedReleaseId` directly in the workbench.
*   **Detailed Test Plan (TDD — `src/test/testAppCurateIntegration.ts`)**:
    *   **Command**: `npx tsx --test src/test/testAppCurateIntegration.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **Raw vs. Projected Catalog Props & Unified Badge Count**: Given a pending Commit Queue item that sets `albumArtist: 'A. R. Rahman'` on Album 1, assert `buildCurateCockpitCatalogProps` preserves the empty `albumArtist` in `rawTracks` (for physical file diff comparison), projects `albumArtist: 'A. R. Rahman'` in `tracks`, and decrements `curateBadgeCount` to match `evaluateCatalogProblems`.
        2.  **`Listen -> Album -> Curate` Direct Workbench Open (`handleInspectRelease`)**: Given active filter `priorities: ['P0']` and a user clicking `Curate` from Listen on Album Z (which has no `P0` problems), assert the active filter remains `priorities: ['P0']`, `filteredAlbums` is unmodified, and `focusedReleaseId` opens Album Z in the workbench.
    *   **Human Input Required**: **Minimal visual check** — confirm the green `N Albums · M Staged` button, duplicate global `CommitStatusPill` (while in Curate), right-hand Copilot button, and Spotlight `Open Cadence AI Copilot` command are absent and pressing `⌘J` does not open `<EmbeddedAgentDrawer />`.

#### 8. `src/services/tauriBridge.ts`, `src-tauri/src/commands/curation.rs`, `src-tauri/src/curation/storage.rs`, `src-tauri/src/db/operations.rs`, and `src-tauri/src/lib.rs` (Modify)

*   **Type / Scope**: TypeScript IPC Bridge & Rust Native Backend Commands / SQLite Queue Operations
*   **Proposed Changes**:
    *   Add `CurationStorage::list_drafts(db: &AppDb) -> Result<HashMap<String, serde_json::Value>, String>` in `src-tauri/src/curation/storage.rs` to read all rows from `curation_drafts` in a single SQLite read transaction, logging and skipping any row with malformed JSON so a corrupt row never blocks **Commit All**.
    *   Expose `#[tauri::command] pub fn curation_list_drafts(db: State<AppDb>)` in `src-tauri/src/commands/curation.rs`, register it in `src-tauri/src/lib.rs`, and add `tauriBridge.curationListDrafts()` (with alias `listCurationDrafts()` and a non-Tauri `localStorage` fallback scanning `cadence:curate-draft:*` keys) in `src/services/tauriBridge.ts`.
    *   In [`src-tauri/src/db/operations.rs:2555-2578`](file:///e:/Mathan/Code/Music%20Agent/src-tauri/src/db/operations.rs#L2555-L2578), update `DbOperations::insert_commit_with_curate_drafts` so: (1) `preserve_existing_intents` only blocks when a track has an `in_flight` or `failed` item (`status IN ('in_flight', 'failed')`), allowing a newer Curate commit on the same album to supersede a `pending` item in place while playback is active, and (2) `curation_drafts` uses `ON CONFLICT(album_id) DO UPDATE SET draft_json = excluded.draft_json, updated_at = CURRENT_TIMESTAMP` so `staged: false` is persisted atomically.
*   **Detailed Test Plan (TDD — Rust Unit Tests in `src-tauri/src/curation/storage.rs` & `src-tauri/src/db/operations.rs`)**:
    *   **Command**: `cargo test --manifest-path src-tauri/Cargo.toml curation::storage`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **Empty & Populated `list_drafts` Query**: In a `#[cfg(test)]` module inside `src-tauri/src/curation/storage.rs` using an in-memory `AppDb`, assert `CurationStorage::list_drafts` returns an empty map initially, returns all saved album drafts after calling `CurationStorage::save_draft` for 3 albums, and returns the latest overwritten payload when an album draft is updated.
        2.  **Corrupt JSON Resilience**: Assert that if a row in `curation_drafts` contains invalid JSON, `list_drafts` logs/skips the malformed row and returns all remaining valid draft rows in the `HashMap` without panicking.
        3.  **Superseding `pending` Curate Commit & `curation_drafts` Upsert**: Assert that calling `insert_commit_with_curate_drafts` a second time for a track whose prior item is `pending` succeeds, supersedes the `pending` item with the new cumulative payload, and updates `curation_drafts` to `staged: false`.
    *   **Human Input Required**: **None** (100% automated via `cargo test`).

#### 9. `src/core/types.ts`, `src/core/curateCommit.ts` & `src/test/testCurateCommit.ts` (Modify)

*   **Type / Scope**: TypeScript Core Types, Raw-Physical-File Commit Diffing & Projection Module, and Node/TSX Unit Test Suite
*   **Proposed Changes**:
    *   Add `genre?: string` to `Track` in `src/core/types.ts`.
    *   Export `hasTrackPhysicalDelta(draft: CurateDraft, selection: CurateDraft['tracks'][number], rawTrack: Track, rawRelease?: Release): boolean` and update `makeCurateCommitItems(draft: CurateDraft, rawTracks: Track[], rawRelease?: Release)` in `src/core/curateCommit.ts` to always diff each track's **Selected Output** (`selectedTags(draft, selection)`) against its raw physical file values (`rawTrack` and `rawRelease` on disk) before commit:
        *   Compare `title` vs. `rawTrack.title`, `artist` vs. `rawTrack.artistCredit`, `album` vs. `rawRelease?.title`, `albumArtist` vs. `(rawTrack.albumArtist || rawRelease?.artistCredit)`, `composer` vs. `(rawTrack.composerName || rawRelease?.composerName)`, `year` vs. `(rawTrack.canonicalReleaseYear || rawRelease?.releaseYear)`, `originalAlbum` vs. `rawTrack.originalAlbum`, `originalYear` vs. `rawTrack.originalYear`, `genre` vs. `(rawTrack.genre || rawRelease?.genreTags?.[0])`, and `coverArtUrl` vs. `(rawRelease?.coverArtUrl || rawRelease?.artwork?.frontCoverUrl)`.
        *   Omit any track where `hasTrackPhysicalDelta` is `false` so local files that are already in sync with **Selected Output** are never queued for physical disk writes, and set `curateTrackCount` to `items.length`.
        *   Update `matchesCurateConfirmation`, `isReconciledCurateDraft`, and `updateCurateReviewState` to check confirmation across the tracks that have a physical delta (`hasTrackPhysicalDelta === true`).
    *   Update `projectCurateCommits` in `src/core/curateCommit.ts` to fold/merge all applicable `CurateCommitRow` entries per `trackId` in ascending commit order and cascade committed album-level `year` and `genre` values onto member `Track` objects (`canonicalReleaseYear` and `genre`) when track-level overrides are absent, enabling `missing_track_year` and `missing_track_genre` to resolve immediately upon committing Album `Release Year` or `Genre`.
*   **Detailed Test Plan (TDD — `src/test/testCurateCommit.ts`)**:
    *   **Command**: `npx tsx --test src/test/testCurateCommit.ts`
    *   **Red Phase (Write Failing Tests First)**:
        1.  **Raw-Physical-File Diffing Skips In-Sync Tracks (`makeCurateCommitItems`)**: Given a 5-track album where 4 tracks are already in sync with their raw physical files on disk and only Track 2 has an edited `title`, assert `makeCurateCommitItems(draft, rawTracks, rawRelease)` returns exactly 1 `NewCommitItemPayload` (for Track 2, with `curateTrackCount: 1`), and returns `[]` when all 5 tracks match the raw physical file baseline.
        2.  **Album-to-Track Year & Genre Cascade in `projectCurateCommits`**: Assert that a pending commit setting `{ year: 1995, genre: 'Tamil Film Soundtrack' }` on a track's release updates both `release.releaseYear` / `release.genreTags` and the projected track's `canonicalReleaseYear` (`1995`) and `genre` (`'Tamil Film Soundtrack'`).
        3.  **Batch Commit Eligibility & Duplicate Prevention**: Assert that only drafts explicitly marked `staged: true` (`userOverridden: true`) with at least one raw-physical-file diff (`makeCurateCommitItems(draft, rawTracks, rawRelease).length > 0`) and not already matching an active `CurateCommitRow` (`matchesCurateConfirmation(draft, rows, false) === false`) are included in **Commit All** batch payload generation.
        4.  **Repeated Partial Commits on Same Album Against Raw Physical Baseline**: Assert that when Album A commits `coverArt` in Commit #1 (while raw physical files on disk remain unchanged) and then edits `albumArtist` in Commit #2, diffing Commit #2's `Selected Output` against `rawTracks`/`rawRelease` produces items containing **both** `coverArtUrl` and `albumArtist`, and `projectCurateCommits` reflects both fixes in the projected catalog.
    *   **Human Input Required**: **None** (100% automated via CLI).

### Verification Plan

*   **Automated TDD Test Suites (Run Before & After Each Module)**:
    *   `npx tsx --test src/test/testCuratePriorities.ts`
    *   `npx tsx --test src/test/testCurateFilterBar.ts`
    *   `npx tsx --test src/test/testCuratePrioritySettingsModal.ts`
    *   `npx tsx --test src/test/testCurateCommitPreviewModal.ts`
    *   `npx tsx --test src/test/testCommitStatusPill.ts`
    *   `npx tsx --test src/test/testUnifiedCurateWorkflow.ts`
    *   `npx tsx --test src/test/testAppCurateIntegration.ts`
    *   `npx tsx --test src/test/testCurateCommit.ts`
    *   `npm run test:commit`
    *   `npm run test:trace`
    *   `cargo test --manifest-path src-tauri/Cargo.toml curation::storage`
*   **Static Analysis & Linting**:
    *   `npm run lint`
*   **Compilation/Build**:
    *   `npm run build`
    *   `cargo check --manifest-path src-tauri/Cargo.toml`
*   **Human Verification Gate (Live Tauri App — Mandatory Stop per `.agents/rules/Git.md`)**:
    *   Verify modal/drawer dismissal for **Priority Settings** and **Commit Queue Drawer**.
    *   Verify clicking an album in the left rail does not trigger automatic provider calls, clicking **Refresh Evidence** and **Accept Suggestions** adopts candidates on demand, **Dismiss Problem** exempts self-titled albums, **Stage & Next** stages and advances, and **Commit Album** diffs **Selected Output** against the raw physical file (skipping in-sync tracks) and either removes the album from the filtered list (when the active filter's problem is fixed) or keeps it in the filtered list while adding the atomic save to the **Commit Queue** (when the active filter's problem is not yet fixed).

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
