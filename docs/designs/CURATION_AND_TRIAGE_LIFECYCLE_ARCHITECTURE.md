# Cadence Curation, Auto-Suggestion & Review Lifecycle

*   **Author:** Mathan
*   **Status:** Proposed
*   **Date:** 2026-10-27

--------------------------------------------------------------------------------

## Overview

Cadence is a bit-perfect audiophile music player and catalog curation engine for Windows Desktop. The application currently fragments the curation workflow across disjointed, contradictory surfaces: clicking "Curate 126" in the top navigation locks onto an arbitrary track (`tracks[0]`, "Dil Se") with zero queue context; the 4-way provider reconciliation table displays simulated template strings rather than real metadata; Copilot recommendations blindly trigger in-memory mutations across hundreds of tracks without preview barriers; and reviewing staged changes suffers from conflicting counters, inconsistent artwork detection, and misaligned batch write modes.

This project unifies auto-suggesting, manual editing, and batch review into an end-to-end 3-stage lifecycle:
1. **Discover & Triage (Audit & Hygiene ⌘3 + Copilot):** Surfaces categorized queues of catalog defects; clicking an issue routes to Curate scoped strictly to affected items with zero silent mutations.
2. **Inspect & Reconcile (Curate ⌘2):** A dedicated Master-Detail Workbench with an Album-Hierarchical queue on the left (280px) and a real metadata reconciliation table + artwork inspector on the right, backed by a `Stage & Next → (⌘↵)` stepper.
3. **Verify & Commit (Review & Commit Modal):** A strict, read-only pre-flight diff inspector with synchronized counters, consistent artwork detection, global target selection (`Embed Headers` vs `Sidecar JSON`), and unified execution logging.

## The Problem

1. **The "Mystery Selection" and Zero Queue Visibility**: The top navigation button displays `Curate 126` (implying a queue of 126 items waiting for curation). Clicking Curate triggers `resolveCurateTargetTrack()` which, in the absence of an active track selection or playback, arbitrarily defaults to `tracks[0]` ("Dil Se (Dil Se)"). Inside the view, there is no queue list, no item counter (e.g., `1 of 126`), no triage reason indicator, and no `Next` button—only `← Return (Esc)`.
2. **Simulated Metadata and Broken State Binding in Curate**: In `FocusedWorkbench.tsx`, the `APPLE MUSIC`, `MUSICBRAINZ`, and `GEMINI AI` columns do not query real APIs; they append hardcoded template strings onto the local compilation name (e.g., `A World Of Music (Original Motion Picture Soundtrack)`), while simultaneously displaying the *Dil Se..* movie poster in the artwork inspector. Furthermore, `handleSave` mutates `track.title` and `track.artistCredit` directly in memory without writing them to `track.pendingSidecarEdits`, causing the green `STAGED OUTPUT` column to disagree with the proposed diffs in the `Review & Commit Changes` modal.
3. **Contradictory Artwork State Between Surfaces**: For the exact same track, `FocusedWorkbench` detects and renders an embedded 500x500 JPEG, while `TwoPhaseCommitModal` evaluates `release.artwork.frontCoverUrl`, reports `No Embedded Artwork · None detected`, and proposes overwriting the entire compilation's artwork with a single track's soundtrack cover.
4. **Misplaced Structural Actions on Single-Track Screens**: A yellow `Split Multi-Disc` button is mounted in the header of `FocusedWorkbench` next to `Cancel` and `Stage to Sidecar`. Disc splitting is an album-level structural operation that does not belong inside a track-level tag reconciliation view.
5. **Blind "One-Click" Batch Mutations in Copilot**: In `EmbeddedAgentDrawer.tsx`, recommendation action buttons (e.g., `Sync Album from Folder`, `Normalize Genres`, `Fetch Online Art`) execute catalog-wide operations that silently stage mutations across hundreds of tracks without a pre-flight staging preview.
6. **Telemetric Discrepancies and Row Badge Desynchronization in Commit Modal**: In `TwoPhaseCommitModal.tsx`, top summary badges (`2 Tag Edits, 4 Cover Art Updates`) disagree with the filter tabs immediately below (`Tag Edits (1), With Artwork Updates (648)`). Toggling between `Embed Headers` and `Sidecar JSON` updates the row badge for the first expanded album (`Header Write Staged`), while sibling rows remain stuck on `Sidecar Staged`.

## Goals

*   **G1: Master-Detail Curation Workbench**: Transform `Curate (⌘2)` into a dedicated Master-Detail Workbench featuring a 280px Album-Hierarchical queue on the left and a 4-way metadata reconciliation table + artwork inspector on the right.
*   **G2: Elimination of Arbitrary Fallbacks**: Remove `tracks[0]` fallback in `resolveCurateTargetTrack()`. When Curate is opened without active context, default to the first album in the Curation Queue; if the queue is empty, display an explicit "All catalog items conform to catalog hygiene standards" empty state.
*   **G3: Album-Hierarchical Queue with Stepper**: Group curation items by Album with defect reason tags (e.g., `A World Of Music · 1 Compilation Conflict`). Provide an active stepper (`Item 1 of 15 Albums · Reason: Soundtrack Provenance`) and a primary `Stage & Next → (⌘↵)` action.
*   **G4: Contextual Approval Branching**:
    *   *Uniform Album Defects* (e.g. missing year or low-res artwork across all tracks): Apply approved metadata album-wide by default, with per-track checkbox opt-out.
    *   *Multi-Film Compilation Box Sets* (e.g. *A World Of Music* containing tracks from both *Dil Se..* and *Guru*): Cluster tracks inside the album accordion by resolved canonical soundtrack. Accepting a match for *Dil Se..* applies strictly to its matching tracks without overwriting sibling tracks belonging to *Guru*.
*   **G5: Real Metadata Provenance & Lazy Lookups**: Replace simulated template strings with real provenance queries (integrating `compilationCanonicalizerService` for soundtrack resolution and `federatedResolversService` for MusicBrainz/Apple Music release data), executed strictly on-demand for the active item with a 300ms debounce to prevent network PHY noise and rate-limit violations during playback.
*   **G6: Strict Pending Sidecar State Binding**: Ensure all staged edits write exclusively to `track.pendingSidecarEdits` and `track.sidecarStatus = 'uncommitted_sidecar'`, leaving in-memory track objects pristine until disk commit. Guarantee identical diff representations between Curate's `STAGED OUTPUT` and `TwoPhaseCommitModal`.
*   **G7: UI Cleanliness & Scope Isolation**: Remove the `Split Multi-Disc` action from `FocusedWorkbench`. Collapse the global left navigation rail to icon-only mode (64px) in Curate to secure 1576px+ of workbench canvas. Scope Copilot recommendations to the active screen context, and introduce a Dry-Run Proposal Sheet for bulk actions before mutations enter the staged pool.
*   **G8: Synchronized Commit Telemetry & Unified Units**: Bind all surface counters to unified units: the Curate navigation button displays queued **Albums** (`Curate 15 ⌘2`), while the Top Header Staged pill displays both dimensions (`● 15 Albums · 82 Staged`). Unify summary counters and filter tabs in `TwoPhaseCommitModal` to read from the centralized `useStagedChanges` hook. Ensure embedded file artwork is accurately reflected in the `Current` artwork box, and synchronize row badges with the active write target (`Embed Headers` vs `Sidecar JSON`).

## Non-Goals

*   **NG1: Modifying Native WASAPI Core**: No modifications to native audio transport, memory pinning (`VirtualLock`), MMCSS thread pacing, or ASIO streaming.
*   **NG2: Overhauling TagLib / Lofty Native File Writers**: No modifications to the underlying C++/Rust file-writing binaries; the refactor targets UI staging, state binding, and review coordination.
*   **NG3: Automatic Mass Web Scraping**: No automated background web-scraping across the entire library at once; all external metadata lookups remain demand-driven and on-demand for the active item.

## Key Architectural Decisions

*   **Decision 1 (Curate Navigation Rail Mode)**: The global left rail collapses to icon-only mode (64px) rather than hiding completely. This preserves spatial orientation and instant access to other containers while freeing up 176px of horizontal space (leaving 1576px for the Master-Detail workbench on a 1920x1080 display).
*   **Decision 2 (Approval Granularity Branching)**:
    *   *Case A (Single-Release Defect)*: Stage album-wide changes to all tracks with individual track opt-out checkboxes.
    *   *Case B (Disaggregated Compilations)*: Group tracks by resolved target soundtrack inside the album card; staging one soundtrack match (e.g. *Dil Se..*) mutates only its constituent tracks, leaving distinct sibling tracks (e.g. *Guru*) intact.
*   **Decision 3 (Telemetry Unit Alignment)**:
    *   Mode Switcher badge: Displays queued **Album count** (`Curate 15`).
    *   Top Header Staged pill: Displays **Albums and Tracks** (`● 15 Albums · 82 Staged`).
    *   Review & Commit Modal tabs: Display synchronized track and artwork counts derived from `useStagedChanges`.

## Critical User Journeys (CUJs)

### CUJ 1: Navigating to Curate from the Top Bar
*   **Given**: The user has 15 albums flagged with compilation conflicts or missing artwork in their library. The top bar displays `Curate 15 (⌘2)`.
*   **When**: The user clicks `Curate` with no track or album selected.
*   **Then**: The view opens to the Master-Detail Curation Workbench. The left queue lists all 15 albums with their defect badges, the first album is selected, the center-right canvas displays its multi-provider reconciliation table and artwork inspector, and the global left rail collapses to icon-only mode (64px).

### CUJ 2: Stepping Through the Curation Queue
*   **Given**: Album `A World Of Music` is selected in Curate. Its tracks are grouped under resolved soundtrack clusters: *Dil Se..* (1998) and *Guru* (2007).
*   **When**: The user accepts the *Dil Se..* soundtrack metadata and presses `Stage & Next → (⌘↵)`.
*   **Then**: Only the tracks matching *Dil Se..* are staged into `pendingSidecarEdits`; sibling tracks belonging to *Guru* remain untouched. The queue advances to the next un-staged item.

### CUJ 3: Inspecting Bulk Copilot Suggestions Before Staging
*   **Given**: The user opens Cadence Copilot and clicks `Disentangle 1 Compilation Boxset Conflicts`.
*   **When**: The action is triggered.
*   **Then**: Rather than immediately mutating tracks in memory, a Dry-Run Proposal Sheet opens showing the proposed before/after diffs with two actions: `Stage All Changes` or `Inspect in Curate`. Clicking `Inspect in Curate` routes directly to the Curate workbench pre-filtered to those affected tracks.

### CUJ 4: Verifying and Committing Staged Changes
*   **Given**: 15 albums and 82 tracks have staged edits.
*   **When**: The user clicks the top header staged pill (`● 15 Albums · 82 Staged`) and toggles the footer commit mode between `Sidecar JSON` and `Embed Headers`.
*   **Then**: The modal displays unified counts (`82 Tag Edits`, `15 Cover Art Updates`), the `Current` artwork box displays the real embedded cover art, all album row badges dynamically update to `Header Write Staged`, and clicking `Update 82 Audio Files` safely executes the two-phase commit.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. End-to-End System Architecture

```mermaid
graph TD
    subgraph UI_Shell [Application Navigation Shell]
        TopSwitcher[Top Mode Switcher\nListen · Curate [15 Albums] · Audit]
        TopHeader[Top Header Pill\n● 15 Albums · 82 Staged]
        LeftRail[Left Container Rail\nCollapses to 64px Icon-Only in Curate]
        CopilotDrawer[Cadence Copilot Drawer\nContextual Scope + Smart Hygiene]
    end

    subgraph Curate_Stage [Curate ⌘2: Master-Detail Workbench]
        QueueRail[CurationQueueRail 280px\nAlbum Cards · Triage Badges · Stepper]
        ReconcileStage[CurationReconciliationStage\n4-Way Metadata Table · Archival Artwork]
        SoundtrackClusters[Soundtrack Provenance Clusters\ne.g., Dil Se.. [1998] vs Guru [2007]]
    end

    subgraph Proposal_System [Batch Safety Layer]
        ProposalSheet[BatchProposalSheet\nDry-Run Diff Preview · Stage All vs Inspect]
    end

    subgraph State_Domain [Authoritative Domain State Engine]
        QueueService[curationQueueService\nDefect Aggregation & Prioritization]
        FederationService[federatedResolversService\nOn-Demand Active Item Lookups]
        StagedHook[useStagedChanges\nUnified Staged Mutators & Counters]
        SidecarStore[(In-Memory Staged Sidecars\ntrack.pendingSidecarEdits)]
    end

    subgraph Commit_Modal [Two-Phase Commit Verification]
        CommitModal[TwoPhaseCommitModal\nRead-Only Diff Table · Global Mode Switcher]
    end

    TopSwitcher -->|⌘2 Open Curate| QueueService
    QueueService --> QueueRail
    QueueRail -->|Select Item| ReconcileStage
    ReconcileStage --> FederationService
    ReconcileStage --> SoundtrackClusters
    ReconcileStage -->|Stage & Next ⌘↵| SidecarStore
    CopilotDrawer -->|Trigger Action| ProposalSheet
    ProposalSheet -->|Stage All| SidecarStore
    ProposalSheet -->|Inspect in Curate| QueueRail
    SidecarStore --> StagedHook
    StagedHook --> TopHeader
    StagedHook --> CommitModal
    TopHeader -->|Click Pill| CommitModal
```

---

### 2. Curation Queue & Master-Detail Topology (`Curate ⌘2`)

#### A. Spatial Layout & Responsive Grid
*   **Viewport Dimensions**: When `topMode === 'curate'`, `LeftRail` compresses from standard 240px to icon-only mode (`w-16` / 64px). The right details inspector remains collapsed by default.
*   **Canvas Allocation**: On a standard 1920x1080 display:
    *   Left Container Rail: 64px (icon-only).
    *   Curation Queue Rail: 280px (fixed-width, vertically scrollable).
    *   Center-Right Reconciliation Canvas: 1576px (dedicated to the 4-way alignment table and artwork inspector).

#### B. `CurationQueueRail.tsx` (Left Pane)
*   **Queue Discovery Engine** (`curationQueueService.ts`):
    *   Scans catalog for actionable defects: compilation conflicts, missing artist/composer tags, missing/low-res artwork (<1000px), fragmented genre tags, and uncommitted staged edits.
    *   Groups defects into lightweight **Album Curation Cards**.
*   **Queue Item Schema**:
    ```typescript
    export interface AlbumCurationQueueItem {
      albumId: string
      albumTitle: string
      artistCredit: string
      coverArtUrl?: string
      primaryIssueType: 'compilation_conflict' | 'missing_artwork' | 'untagged' | 'genre_fragment' | 'staged_uncommitted'
      issueBadgeLabel: string
      defectSeverity: 'critical' | 'high' | 'medium' | 'info'
      affectedTrackCount: number
      totalTracks: number
      isStaged: boolean
    }
    ```
    *Note: Compilation soundtrack clusters are computed lazily on-demand when an album is selected for reconciliation, keeping initial queue scanning fast (<10ms).*
*   **Header Stepper & Filters**:
    *   Top stepper: `Item 1 of 15 Albums · Reason: Soundtrack Provenance`.
    *   Filter pills: `All (15)` | `Soundtracks (1)` | `Artwork (12)` | `Staged (2)`.
    *   Keyboard navigation: `⌘[` for previous album, `⌘]` for next album.

#### C. `CurationReconciliationStage.tsx` (Center-Right Pane)
*   **Action Header**:
    *   Breadcrumb: `Curate & 3-Way Reconciliation: <Album Title>`.
    *   Actions: `← Prev (⌘[)`, `Next (⌘])`, and primary `✓ Stage & Next (⌘↵)`.
    *   *Removal*: The yellow `Split Multi-Disc` button is permanently removed from this header.
*   **Case A: Uniform Album Defect Workflow**:
    *   For albums with uniform defects (e.g. low-resolution artwork or missing year):
    *   Reconciliation table displays album-level candidates for Title, Artist, Composer, Release Year, and Artwork.
    *   Tracks are listed below with individual toggle checkboxes (all checked by default). Clicking `✓ Stage & Next` applies the selected values to all checked tracks in `pendingSidecarEdits`.
*   **Case B: Multi-Film Compilation Box Set Workflow**:
    *   When an album is identified as a compilation box set (e.g., *A World Of Music*):
    *   Tracks are grouped into visual accordion clusters based on their resolved canonical movie soundtrack:
        *   Cluster 1: *Dil Se..* (1998) → Track 1: "Dil Se (Dil Se)".
        *   Cluster 2: *Guru* (2007) → Track 2: "Barso Re".
    *   Selecting or accepting the metadata for Cluster 1 snaps canonical fields (*Dil Se..*, 1998, A. R. Rahman) strictly to Track 1, preserving Track 2's distinct metadata.
*   **Queue Completion & Error States**:
    *   Stepping past the final queue item (Item 15 of 15) displays a dedicated "Queue Cleared: 15 Albums Staged" completion card with a primary action button `[Review & Commit Changes (⌘4)]`.
    *   If an external provider lookup times out or encounters HTTP 429 rate-limiting, that provider column renders an inline `Unavailable / Retry` action rather than stalling the UI.

---

### 3. Data Integrity & Lazy Demand-Driven Federation Engine

#### A. Demand-Driven Metadata Federation (`federatedResolvers.ts`)
*   Extends `src/services/federatedResolvers.ts` (`federatedResolversService`) with on-demand active item resolution: `resolveActiveItemCandidate(albumId: string, trackId?: string)`.
*   **Operational SLA & Rate Limiting**: External network requests are **NEVER** executed in batch across the 15 queue albums. A 300ms debounce is enforced on queue item selection before triggering remote queries. An `AbortController.signal` is wired to all active lookups so that navigating to another queue item immediately cancels in-flight network requests.
*   **Candidate Provider Sources**:
    1.  *Local Tag*: Ground-truth metadata read from audio file container headers.
    2.  *Apple Music Master*: Query Apple Music API / iTunes Search API for master high-resolution artwork (up to 3000x3000px uncompressed) and canonical release dates.
    3.  *MusicBrainz Archive*: Query MusicBrainz by AcoustID or release/track title for standardized discography credits and Cover Art Archive scans, respecting the 1 request/second rate limit.
    4.  *AI Provenance*: Leverages `compilationCanonicalizerService.ts` (`resolveCompilationSoundtracks(release, tracks)`) for disaggregating Indian / world soundtrack compilations into their original canonical motion pictures.
*   **Playback Quietness Guard**: In accordance with Audiophile Invariant 4, if `audioEngine.isPlaying()` is true, background remote fetching delays until playback enters idle or until the user explicitly clicks `Fetch Online Candidates`.

#### B. Strict `pendingSidecarEdits` Immutability
*   Staged edits write exclusively to `track.pendingSidecarEdits` and set `track.sidecarStatus = 'uncommitted_sidecar'`, leaving base in-memory track fields immutable until two-phase disk commit.
*   The green `STAGED OUTPUT` column binds directly to `track.pendingSidecarEdits`, guaranteeing identical diff representations with `TwoPhaseCommitModal`.

---

### 4. Copilot Batch Proposal System (`BatchProposalSheet.tsx`)

#### A. Safety Barrier against Blind In-Memory Mutations
*   Clicking recommendation action pills in `EmbeddedAgentDrawer.tsx` (e.g. `Sync Album from Folder`, `Normalize Genres`, `Fetch Online Art`) will no longer execute silent mutations across hundreds of tracks.
*   Instead, the dispatcher invokes `openBatchProposal(proposalData)`.

#### B. Proposal Sheet Schema & Interface
```typescript
export interface BatchProposalDiffRow {
  trackId: string
  trackTitle: string
  albumTitle: string
  fieldName: 'title' | 'artistCredit' | 'composerName' | 'albumTitle' | 'releaseYear' | 'genre'
  currentValue: string | number | undefined
  proposedValue: string | number | undefined
}

export interface BatchProposalData {
  proposalId: string
  title: string
  description: string
  scopeLabel: string
  affectedAlbumsCount: number
  affectedTracksCount: number
  diffs: BatchProposalDiffRow[]
  onStageAll: () => Promise<void>
  onInspectInCurate: (affectedAlbumIds: string[]) => void
}
```
*   **Diff Preview Grid**:
    *   Displays a clean before-and-after table (`Album / Track`, `Field`, `Current Tag`, `Proposed Tag`).
    *   Virtualizes rows via `@tanstack/react-virtual` to ensure 60fps rendering even when handling catalog-wide proposals (1,000+ tracks).
*   **Action Dual-Path**:
    *   `[Stage All as Draft]`: Commits the diffs into `pendingSidecarEdits` in bulk, updating the Top Header Staged pill and marking items as staged in Curate.
    *   `[Inspect in Curate (⌘2)]`: Dismisses the sheet and routes the user into `Curate (⌘2)` with the Curation Queue pre-filtered strictly to the affected items.

---

### 5. Unified Telemetry & Commit State Synchronization

#### A. Centralized Reactive State (`useStagedChanges.ts`)
*   Extracts all staging calculations into an authoritative singleton hook:
    *   `stagedAlbumsCount`: Unique releases with at least one track edit or artwork update.
    *   `stagedTracksCount`: Total track files with `pendingSidecarEdits`.
    *   `stagedTagEditsCount`: Total field-level modifications across all tracks.
    *   `stagedArtworkCount`: Total artwork replacements.
    *   `triageAlbumsCount`: Number of releases requiring curation, computed by querying hygiene issue IDs and uncommitted sidecar status from `graphEngine` (preventing circular dependencies with `curationQueueService`).
*   **Surface Bindings**:
    *   Top Segmented Control: `Curate {triageAlbumsCount} (⌘2)`.
    *   Top Header Utility Bar: `● {stagedAlbumsCount} Albums · {stagedTracksCount} Staged`.
    *   `TwoPhaseCommitModal` Summary Badges: Displays `stagedTagEditsCount` and `stagedArtworkCount`.
    *   `TwoPhaseCommitModal` Filter Tabs: `All Changes ({stagedTracksCount})`, `Tag Edits ({stagedTagEditsCount})`, `With Artwork Updates ({stagedArtworkCount})`.

#### B. `TwoPhaseCommitModal.tsx` Fixes
*   **Global Target Synchronization**: When toggling between `Embed Headers` and `Sidecar JSON` in the modal footer:
    *   The active `writeMode: 'headers' | 'sidecar'` is maintained in the modal parent state and passed down as a prop to each child `TwoPhaseCommitModalRow`.
    *   This ensures all rendered album rows update their badges dynamically (`Header Write Staged` vs `Sidecar Staged`), eliminating the defect where only the first expanded row updated.
*   **Accurate Embedded Artwork Detection**:
    *   The `Current` artwork inspector resolves embedded cover artwork directly from the audio file binary via `tauriBridge.getEmbeddedArtwork(trackPath)` or `track.artworkUrl`.
    *   If embedded artwork exists (e.g. 500x500 JPEG), it renders in the `Current` preview box with its true resolution, rather than displaying `No Embedded Artwork · None detected`.

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Complete Elimination of the Curate Top-Level Mode
*   **Description**: Remove `Curate` from the top navigation switcher (`Listen | Audit`) and relegate all metadata editing to an in-place inspector modal triggered exclusively from Album Detail or Audit & Hygiene issues.
*   **Pros**: Simplifies top navigation to two core modes (Playback vs Maintenance); eliminates ambiguity over what Curate does from a cold start.
*   **Cons**: Destroys high-throughput curation workflows. Users with 15–20 albums needing metadata review would have to repeatedly drill in and out of Album Detail pages without an active queue or stepper, adding significant interaction friction.
*   **Reason for Rejection**: Dedicated curation requires a focused Master-Detail workbench with queue stepping. Retaining `Curate (⌘2)` as an explicit triage queue aligns with audiophile catalog grooming needs.

### Alternative B: Flat 126-Track Curation Queue
*   **Description**: Display all 126 individual defect tracks as a flat list in the left curation queue rail.
*   **Pros**: 1-to-1 parity with raw defect counts and track-level metadata rows.
*   **Cons**: Triggers severe cognitive fatigue. Users would have to click `Stage & Next` 126 times across 15 albums, redundantly approving identical album-level fields (Album Title, Year, Cover Art, Primary Artist) for each track of an album.
*   **Reason for Rejection**: Music catalog curation is fundamentally album-hierarchical. Grouping items by album reduces queue length from 126 to 15, while our two-case branching (Case A uniform vs Case B compilation clusters) handles multi-soundtrack nuances without repetitive manual stepping.

### Alternative C: Unthrottled Pre-Fetching of External Metadata Across the Entire Queue
*   **Description**: Asynchronously fetch MusicBrainz, Apple Music, and Gemini AI metadata for all 15 queue albums in parallel immediately upon entering Curate mode.
*   **Pros**: Pre-populates all candidate pills with zero loading spinners as the user steps through items.
*   **Cons**: Flouts rate limits (MusicBrainz 1 request/sec limit) and directly violates Audiophile Invariant 4 (NIC PHY packet bursts and electrical EMI/RFI noise during audio playback).
*   **Reason for Rejection**: Bit-perfect audiophile transport mandates transport quietness. Remote API lookups must be strictly lazy, demand-driven, and evaluated only for the active album upon selection.

### Alternative D: Mandatory 1-by-1 Curate Routing for All Copilot Actions
*   **Description**: Strip bulk execution from Copilot entirely; clicking any recommendation in Copilot always redirects the user to Curate to approve items one by one.
*   **Pros**: Guarantees that every single tag modification is visually inspected by the user.
*   **Cons**: Imposes excessive interaction friction for trivial catalog-wide operations (e.g. normalizing 40 genre strings from "Tamil Film" to "Tamil Film Soundtrack").
*   **Reason for Rejection**: The Dry-Run `BatchProposalSheet` provides the ideal compromise: users review the aggregate before/after diff summary and can choose `[Stage All as Draft]` for bulk operations or `[Inspect in Curate]` for granular item-by-item stepping.

--------------------------------------------------------------------------------

## Non-Functional Requirements

### 1. Storage Bus Silence & Playback Integrity (Audiophile Invariant 1)
*   Zero disk reads/writes may occur on music library storage drives while audio playback is active or within the 30-second cooldown window.
*   All Curation Queue discovery, filtering, and state staging operate strictly against in-memory React state and cached SQLite rows without triggering filesystem stat calls or metadata re-reading.

### 2. Network PHY Quietness & Lazy Federation (Audiophile Invariant 4)
*   Metadata candidate lookups to external providers (Apple Music, MusicBrainz, Gemini AI) are strictly demand-driven: lookups execute solely for the single actively selected queue item.
*   If `AudioEngine` is currently in `Playing`, `Paused`, or `Loading` states, remote network lookups are queued or gated behind an explicit `Fetch Online Candidates` user button to prevent NIC packet bursts during audio streaming.
*   All remote queries are gated behind a 300ms debounce and wire `AbortController.signal` to immediately abort upon selecting another queue item.

### 3. UI Thread Performance & Queue Virtualization
*   The 280px `CurationQueueRail` and `BatchProposalSheet` must support virtualized scrolling (`@tanstack/react-virtual` or CSS virtualization) to render hundreds of queue items or thousands of diff rows at 60fps without DOM reflow lag.
*   Queue filter toggles (`All`, `Soundtracks`, `Artwork`, `Staged`) must compute in `< 8ms` in-memory.

### 4. Two-Phase Commit Safety & State Immutability
*   Staging metadata changes must never mutate raw track objects in memory.
*   All staged mutations reside strictly inside `track.pendingSidecarEdits` and can be reverted cleanly with zero side effects. Physical disk mutations remain deferred to explicit confirmation in `TwoPhaseCommitModal`.

--------------------------------------------------------------------------------

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **External API Rate Limiting (MusicBrainz 1 req/sec)** | User IP banned; provider columns return HTTP 429/503 errors. | Medium | Enforce 300ms debounce on queue navigation; attach `AbortController` to cancel in-flight queries immediately when stepping to a new album; show inline `Retry` button on rate-limit response. |
| **UI Thread Freeze on Large Copilot Proposals (1,000+ tracks)** | DOM reflow lockup inside `BatchProposalSheet` modal. | Medium | Use `@tanstack/react-virtual` to window table rendering so only visible diff rows are mounted in the DOM. |
| **Air-Gapped / Offline Audio Workstations** | Infinite spinners or error popups when network is unavailable. | Low | Detect offline state; immediately mark remote provider columns as `Offline · Not Queried` and enable local tag editing and sidecar staging without blocking. |
| **Circular Hook Dependencies** | React render loop between `useStagedChanges` and `curationQueueService`. | Low | `useStagedChanges` derives `triageAlbumsCount` directly from `graphEngine` uncommitted sidecars and issue IDs rather than importing `curationQueueService`. |

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Phase 1: Domain State & Service Layer

#### 1. `src/core/scopeUtils.ts` ([Modify])
*   **Type / Scope**: TypeScript Scope Resolution Utility
*   **Proposed Changes**:
    *   Refactors `resolveCurateTargetTrack()`: removes line 148 (`return tracks[0] || null`).
    *   Returns `null` if no active track/album is in scope, allowing `App.tsx` to initialize Curate via `curationQueueService.resolveCurateInitialAlbum()`.
*   **Rationale**: Eliminates the "Dil Se" arbitrary track lock bug.

#### 2. `src/services/curationQueueService.ts` ([Create])
*   **Type / Scope**: TypeScript Domain Curation Service
*   **Proposed Changes**:
    *   Exposes `computeCurationQueue(tracks: Track[], releases: Release[], existingIssues?: AuditIssue[]): AlbumCurationQueueItem[]`.
    *   Groups defects (compilation conflicts, missing cover art, untagged tracks) into lightweight `AlbumCurationQueueItem` records without eager soundtrack clustering.
    *   Exposes `resolveCurateInitialAlbum(queue: AlbumCurationQueueItem[], activeAlbumId?: string): AlbumCurationQueueItem | null`.
*   **Rationale**: Provides authoritative, fast (<10ms) defect grouping for the Curation Queue rail.

#### 3. `src/services/federatedResolvers.ts` ([Modify])
*   **Type / Scope**: Metadata Federation Engine
*   **Proposed Changes**:
    *   Extends `federatedResolversService` with `resolveActiveItemCandidate(albumId: string, trackId?: string, signal?: AbortSignal): Promise<CoverArtCandidate[]>`.
    *   Integrates `compilationCanonicalizerService.ts` for disaggregating compilation soundtracks into their canonical motion picture releases.
    *   Respects the active playback guard (`isPlaybackActive()`) to defer remote network lookups during audio streaming.
*   **Rationale**: Reuses the existing 1,046-line resolver architecture rather than creating redundant service boilerplate.

#### 4. `src/hooks/useStagedChanges.ts` ([Modify])
*   **Type / Scope**: TypeScript Reactive Hook
*   **Proposed Changes**:
    *   Exposes `triageAlbumsCount`: derived directly from `graphEngine` defect releases and uncommitted sidecar items.
    *   Ensures `stagedAlbumsCount`, `stagedTracksCount`, `stagedTagEditsCount`, and `stagedArtworkCount` use synchronized domain calculation logic.
*   **Rationale**: Unifies telemetry across top navigation badges, top utility header pills, and commit modal tabs without circular dependencies.

*Phase 1 Checkpoint: `npm run build` cleanly compiles domain services and hooks.*

---

### Phase 2: Master-Detail Curation Workbench UI

#### 5. `src/components/LeftRail/LeftRail.tsx` ([Modify])
*   **Type / Scope**: Navigation Sidebar Component
*   **Proposed Changes**:
    *   Supports `isIconOnly?: boolean` prop.
    *   When `isIconOnly` is true, sets width to `w-16` (64px), collapses labels, and displays native tooltips for container icons.
    *   Restores the user's prior manual width setting upon navigating back to `Listen` or `Audit`.
*   **Rationale**: Frees up 176px of horizontal space for the curation workbench while preserving spatial orientation.

#### 6. `src/components/Curate/CurationQueueRail.tsx` ([Create])
*   **Type / Scope**: React Component (Left Pane of Curate Workbench)
*   **Proposed Changes**:
    *   Fixed-width 280px container hosting a virtualized list of `AlbumCurationQueueItem` cards.
    *   Renders album thumbnail, title, artist, defect category badge, affected track count, and staged status checkmark.
    *   Header bar with filter pills (`All`, `Soundtracks`, `Artwork`, `Staged`) and active item indicator (`Item 1 of 15`).
    *   Handles keyboard shortcuts (`⌘[`, `⌘]`) with a 300ms debounce on selection changes.
*   **Rationale**: Solves zero-queue visibility in Curate, giving users clear orientation of what needs attention.

#### 7. `src/components/Curate/CurationReconciliationStage.tsx` ([Create])
*   **Type / Scope**: React Component (Center-Right Canvas of Curate Workbench)
*   **Proposed Changes**:
    *   Top action header with breadcrumbs, previous/next buttons, and `✓ Stage & Next → (⌘↵)`.
    *   Renders Case A (Uniform Album Defect with track checklist) or Case B (Multi-Soundtrack Compilation with film accordions).
    *   Hosts the 4-way provider reconciliation table (Local Tag, MusicBrainz, Apple Music, AI Provenance) with inline `Retry` on rate limits and offline indicators.
    *   Hosts the High-Resolution Artwork Inspector with real embedded image byte decoding.
    *   Displays a "Queue Cleared" completion card when stepping past the last item, with a direct call-to-action to review and commit.
*   **Rationale**: Provides a dedicated, high-throughput reconciliation canvas tailored to both single-film and compilation releases.

#### 8. `src/components/Curate/CurationWorkbench.tsx` ([Create])
*   **Type / Scope**: React Container Component
*   **Proposed Changes**:
    *   Mounts in center stage when `topMode === 'curate'`, combining `CurationQueueRail` and `CurationReconciliationStage`.
    *   Manages active queue index, abort signals for in-flight requests, and keyboard shortcuts (`⌘↵`, `Esc`, `⌘[`, `⌘]`).
    *   Renders an explicit empty state ("All catalog items conform to catalog hygiene standards") when the queue is clear.
*   **Rationale**: Replaces the isolated single-track `FocusedWorkbench` as the primary workspace for `Curate (⌘2)`.

#### 9. `src/App.tsx` ([Modify])
*   **Type / Scope**: Root Application Component
*   **Proposed Changes**:
    *   Updates `handleOpenCurate`: mounts `CurationWorkbench` when `topMode === 'curate'`.
    *   Passes `isIconOnly={topMode === 'curate'}` to `LeftRail`.
    *   Updates Curate mode button badge to render `{triageAlbumsCount}` (`Curate 15 ⌘2`).
*   **Rationale**: Implements the Master-Detail workbench route and rail compression.

*Phase 2 Checkpoint: Navigating to `Curate (⌘2)` renders the Master-Detail workbench with 64px rail.*

---

### Phase 3: Copilot Batch Proposal Safety Layer

#### 10. `src/components/Agent/BatchProposalSheet.tsx` ([Create])
*   **Type / Scope**: React Modal / Drawer Component
*   **Proposed Changes**:
    *   Renders dry-run before-and-after diff tables based on `BatchProposalData`.
    *   Virtualizes diff rows via `@tanstack/react-virtual` to support large proposals without DOM reflow lag.
    *   Exposes `[Stage All as Draft]` (bulk write to `pendingSidecarEdits`) and `[Inspect in Curate (⌘2)]` (routes to Curate pre-filtered).
*   **Rationale**: Eliminates blind, silent in-memory mutations across hundreds of tracks.

#### 11. `src/services/agentActionDispatcher.ts` ([Modify])
*   **Type / Scope**: Agent Action Dispatcher Service
*   **Proposed Changes**:
    *   Extends `AgentDispatcherContext` with `openBatchProposal: (data: BatchProposalData) => void`.
    *   Refactors `remediate_issue` and bulk handlers to compute dry-run preview diffs before executing staging.
    *   Removes direct in-memory mutations `t.title = cleanTitle` and `t.artistCredit = performers` in `resolve_work_hierarchy`, routing exclusively to `t.pendingSidecarEdits`.
*   **Rationale**: Decouples recommendation evaluation from immediate state mutation and enforces track object immutability.

#### 12. `src/components/Agent/EmbeddedAgentDrawer.tsx` ([Modify])
*   **Type / Scope**: Copilot Drawer Component
*   **Proposed Changes**:
    *   Wires recommendation action buttons to invoke `dispatcherContext.openBatchProposal` with structured diff data.
    *   Displays scoped badges when recommendations apply to an active album vs catalog-wide.
*   **Rationale**: Connects Copilot to the dry-run proposal safety barrier.

*Phase 3 Checkpoint: Copilot recommendations open the dry-run proposal sheet without silent track mutation.*

---

### Phase 4: Commit Modal Alignment & Automated Tests

#### 13. `src/components/CenterStage/TwoPhaseCommitModal.tsx` ([Modify])
*   **Type / Scope**: Two-Phase Commit Modal Component
*   **Proposed Changes**:
    *   Binds summary counters and filter tabs directly to `useStagedChanges`.
    *   Elevates `writeMode: 'headers' | 'sidecar'` to parent modal state and passes down as a prop to `TwoPhaseCommitModalRow` to update all album badges uniformly.
    *   Updates `Current` artwork box to decode and display embedded image binaries from audio files rather than falsely reporting "No Embedded Artwork".
*   **Rationale**: Eliminates telemetric drift and resolves contradictory artwork states.

#### 14. `src/components/CenterStage/FocusedWorkbench.tsx` ([Modify])
*   **Type / Scope**: Focused Track Reconciliation Component
*   **Proposed Changes**:
    *   Removes the yellow `Split Multi-Disc` button from the header.
    *   Deprecates standalone 4-way reconciliation in favor of `CurationReconciliationStage`.
    *   Updates `handleSave` to write strictly to `track.pendingSidecarEdits` and `track.sidecarStatus = 'uncommitted_sidecar'`.
*   **Rationale**: Restores data integrity and consolidates duplicate reconciliation logic.

#### 15. `src/test/testCurationLifecycle.ts` ([Create])
*   **Type / Scope**: TypeScript Automated Test Driver
*   **Proposed Changes**:
    *   Unit test 1 (Queue Discovery): Mock catalog with 15 defect albums; assert `computeCurationQueue()` groups tracks into 15 items in <10ms.
    *   Unit test 2 (Compilation Disaggregation): Mock *A World Of Music* (5 tracks: 2 *Dil Se..*, 3 *Guru*); assert staging *Dil Se..* mutates only Track 1 & 2 sidecars.
    *   Unit test 3 (Strict Immutability): Assert `track.title` and `track.artistCredit` base properties are pristine after staging.
    *   Unit test 4 (Zero Arbitrary Fallback): Assert `resolveCurateTargetTrack()` returns `null` on cold start and selects queue index 0.
    *   Unit test 5 (Telemetry Synchronization): Assert `stagedAlbumsCount`, `stagedTracksCount`, and `stagedTagEditsCount` in `useStagedChanges` match the commit modal badges.
*   **Rationale**: Guarantees automated regression testing for the entire 3-stage curation lifecycle.

*Phase 4 Checkpoint: `npx tsx src/test/testCurationLifecycle.ts` passes 100% of test assertions.*

---

### Verification Plan

*   **Compilation & Static Type Checks**:
    *   `npm run build`: Validate that all TypeScript compilation (`tsc -b`) and Vite production bundling succeed with zero errors.
*   **Automated Regression Suite**:
    *   `npx tsx src/test/testCurationLifecycle.ts`: Execute automated test suite validating queue discovery, soundtrack clustering, and state immutability.
*   **Manual End-to-End Verification**:
    1.  *Cold-Start Curate Navigation*: Open Cadence with no track selected, click `Curate (⌘2)`. Verify the Curation Queue opens with 15 albums, no "Dil Se" track lock occurs, and the left rail collapses to 64px icon-only mode.
    2.  *Compilation Disaggregation*: Select *A World Of Music* in the queue. Verify tracks are grouped under *Dil Se..* (1998) and *Guru* (2007). Click `Stage & Next` on *Dil Se..*; verify only Track 1 is staged, leaving Track 2 unmutated.
    3.  *Copilot Dry-Run Proposal*: Open Copilot, click `Disentangle 1 Compilation Boxset Conflicts`. Verify `BatchProposalSheet` opens showing the diff preview. Test both `[Stage All as Draft]` and `[Inspect in Curate]`.
    4.  *Two-Phase Commit Verification*: Click `● 15 Albums · 82 Staged`. Verify summary badges match filter tabs, `Current` artwork box displays the true embedded image, and toggling write modes updates all album row badges dynamically.

--------------------------------------------------------------------------------

*Drafted and Resolved with EGM*
