# Cadence UX & UI Architecture Refactor

* **Author:** Mathan
* **Date:** 2026-10-27

## Overview

Cadence's user interface is undergoing a structural refactor to eliminate navigation duplication, telemetry discrepancies, leaked backend microcopy, and layout density issues. This refactor establishes a container-based navigation rail with contextual sub-header lenses, dual-layer search scoping (`⌘K` direct navigation spotlight and `⌘F` in-memory tree pruning), deterministic multi-disc grouping with persistent SQLite split overrides, mode-aware inspector persistence via local storage, and a unified top-header counter for staged mutations, alongside fixes for several high-density view bugs.

## Analysis

### 1. Global Shell & Navigation Topology
* **Container Rail vs. Sub-Header Lenses:** The left sidebar is strictly reserved for high-level operational containers: `Library Browse`, `Playlists`, `Physical Folder Tree`, `Audit & Hygiene`, and a shortcut to Staged Changes. Within `Library Browse`, the canvas sub-header provides dimensional lens tabs (`Albums | Artists | Composers | Tracks`) alongside local sorting, filtering, and view density controls.
* **Contextual Toolbar Suppression:** The grid-specific filter and sort toolbar is dynamically hidden whenever an Album Detail route is active, preventing control clutter above breadcrumbs.
* **Unimplemented Route Scoping:** Placeholder routes (`Classical Works`, `Pressing Stacks`) are removed from active navigation until backend capabilities exist.

### 2. Search & Discovery Scoping
* **Decoupled Dual-Layer Search Architecture:**
  * `⌘K` (Global Spotlight): Indexes tracks, albums, artists, composers, and storage directory paths. Selecting a search result navigates directly to that album or track view without initiating cross-component folder tree expansion.
  * `⌘F` (Local In-Place Filter): Operates contextually within the active view. In `Physical Folder Tree`, it dynamically prunes and auto-expands matching child branches in-memory (`FolderTreeExplorer.tsx`) while dimming non-matching parents, avoiding any remote filesystem I/O across SMB/NAS mounts. In list/grid views, it filters the active dataset in-memory.

### 3. Multi-Disc Grouping & Deterministic Data Integrity
* **Strict Deterministic Grouping Hierarchy:**
  1. *Primary (Deterministic):* Exact match on embedded MusicBrainz Release Group ID (`MBID`).
  2. *Secondary (Strict Structural):* Normalized matching `album` tags combined with non-empty, sequential `disc_number` / `total_discs` metadata.
  3. *Elimination of Heuristic Fallbacks:* Speculative regex stripping (`(Disc \d+)`, `CD\d+`, `[Vol. \d+]`) across matching folders/years is explicitly dropped to prevent false-positive grouping across multi-volume releases.
* **User Split Overrides:** The Album Detail header provides an explicit overflow action (`Split Multi-Disc Release`) that unpacks the release into discrete single-disc cards and writes an override flag to the local SQLite database (`%APPDATA%/cadence.db`) to prevent automated re-merging across app restarts.

### 4. Inspector State & Viewport Spatial Polish
* **Mode-Aware Inspector Persistence:** Navigating into `Curate (⌘2)` checks viewport width and automatically collapses the right-hand `Details` inspector on initial entry to provide full width for the 5-column reconciliation table. Subsequent user manual toggles within `Curate` are stored in `localStorage` (`cadence_curate_inspector_collapsed`), mirroring the existing `cadence_album_grid_density` pattern.
* **Viewport Padding & Signals:** All scroll containers enforce bottom padding (`pb-28`) to prevent floating transport bar occlusion. Audio path indicators (`PCM · WASAPI`) and transport controls dim when no track is selected. Provenance pills in tracklists are softened to muted slate badges that illuminate on hover.

### 5. Telemetry, State & Formatting Integrity
* **Unified Telemetry Service:** Catalog health calculations across `MaintainCockpit` and `CatalogPulseCard` are centralized into a single shared reactive hook (`useCatalogHealth`). This resolves contradictory health percentages (80% vs 93%) and ensures dynamic subtext updates accurately reflect whether anomalies exist.
* **Canonical Staged Changes Counter:** Pinned permanently in the Top Utility Header next to the Catalog Health / Purity pill (`● 125 Albums · 811 Staged`). Clicking triggers the `Review & Commit Changes` modal overlay directly.
* **Formatting & State Fixes:**
  * Track durations format floating-point seconds with `Math.floor(secs % 60)` in `VirtualDataTable.tsx`, eliminating raw decimals like `4:21.21333333333333`.
  * Artwork candidate radios in `FocusedWorkbench.tsx` bind selection state to candidate IDs (`art.id`) rather than URLs, preventing simultaneous active states.
  * Staged diff counts in `TwoPhaseCommitModal.tsx` include release-level artwork updates alongside track-level edits, and row badges accurately reflect the active execution target (`Sidecar Staged` vs `Header Write`).
  * Cyan folder badge in `TwoPhaseCommitModal.tsx` is hidden when the folder name matches the album title.
* **Microcopy Sanitization:** Internal protocol names ("Two-Phase Commit"), worker thread IDs (`AUDIO-IDLE WORKER: Album Covers (300x300)`), and AI model badges (`Gemini 3.7 AI`) are replaced with plain English task descriptions (`"Review and apply staged changes to disk"`, `"Background Tasks: Indexing Artwork"`). Raw `&rarr;` entities are replaced with Unicode `→`, and pluralization logic is added for single-track references.
* **Track Table Action Cleanup:** In `All Tracks`, secondary buttons (`Enrich Album`, `Format Backdrop`) in album group banners are collapsed into an overflow `•••` menu, leaving `Playlist` and `Edit Album` as primary actions.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Reorganize left rail and sub-header routing to separate high-level functional containers from metadata lenses.
  * Centralize library health and staged mutation calculations into shared hooks (`useCatalogHealth`, `useStagedChanges`).
  * Scope `⌘F` strictly to in-memory pruning/filtering and `⌘K` to global direct-navigation spotlight search.
  * Implement deterministic multi-disc grouping (MBID or identical title + sequential discs) with persistent SQLite split overrides.
  * Auto-collapse the right inspector on initial entry to `Curate (⌘2)` while respecting manual toggles via `localStorage`.
  * Anchor the canonical staged changes counter in the top utility header with instant modal invocation.
  * Fix formatting bugs: float durations, artwork candidate radio IDs, audit tab defaults, and commit modal badge/tab synchronization.
  * Sanitize all microcopy, replace HTML entities, and fix pluralization strings.
* **Out-of-Scope Non-Goals:**
  * Modifying native WASAPI audio transport, memory pinning (`VirtualLock`), or packet pacing loops.
  * Modifying physical file tagging engines or SQLite schema beyond the disc grouping override flag.
  * Implementing full backend scanning or curation engines for `Classical Works` or `Pressing Stacks`.

## Key Decisions & Staging for Next Steps

* **Decision 1 (Navigation Hierarchy):** Left rail represents high-level operational containers (`Library Browse`, `Playlists`, `Physical Folder Tree`, `Audit & Hygiene`); sub-header provides dimensional lenses (`Albums`, `Artists`, `Composers`, `Tracks`).
* **Decision 2 (Telemetry Hooks):** Centralize health scoring and staged count calculations into shared hooks to eliminate cross-view contradictions.
* **Decision 3 (Grouping Determinism):** Restrict automatic multi-disc grouping to deterministic metadata (MBID or identical title + sequential discs); reject speculative title regex guessing. Persist manual splits in SQLite.
* **Decision 4 (Search Scoping):** `⌘F` handles local in-memory view/tree filtering; `⌘K` handles global navigation.
* **Decision 5 (Panel State):** Initial default collapse in Curate with `localStorage` persistence.
