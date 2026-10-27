# Goldfish Annotated Review Report

**Target:** `docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md` (`full file`)
**Status:** Resolved (13/13 fixes accepted)

---

## Prioritized Findings & AI Suggestions

### [Issue 1] [`egm-comprehension`] - Severity: Blocker
*   **Affected Scope:** [Lines 35, 197, 324](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L35-L324) (Goals, Technical Plan § 3.A, Implementation Plan § 2)
*   **Discrepancy Description:** The document references a non-existent service `geminiCompilationSoundtrackService.ts` for disaggregating compilation soundtracks.
*   **Rationale:** The actual service implemented in Cadence is `src/services/compilationCanonicalizerService.ts`, which exports `compilationCanonicalizerService` and `resolveCompilationSoundtracks(release, tracks)`. A fresh engineer importing the phantom service would encounter build errors.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Replaces the phantom service name with the real, tested service already present in the codebase.
*   **Proposed Edit:**
    *   Location: Lines 35, 197, 324
    *   Change: Replace `geminiCompilationSoundtrackService` with `compilationCanonicalizerService`, specifying its method `compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks)`.

---

### [Issue 2] [`egm-comprehension`] - Severity: Blocker
*   **Affected Scope:** [Lines 223, 358–361, 411–413](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L223-L413) (Technical Plan § 4, Implementation Plan § 6, 13)
*   **Discrepancy Description:** The document specifies passing `BatchProposalData` into `openBatchProposal` without defining the TypeScript interface.
*   **Rationale:** The implementer must guess what fields `BatchProposalSheet` expects (action ID, title, diff arrays, track IDs, rollback callbacks).
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Defining the interface explicitly eliminates guesswork and guarantees type safety between `agentActionDispatcher.ts` and `BatchProposalSheet.tsx`.
*   **Proposed Edit:**
    *   Location: Insert under `Technical Plan § 4.B` (after line 234):
    *   Change:
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

---

### [Issue 3] [`egm-zoom-out`, `egm-codebase-details`] - Severity: Blocker
*   **Affected Scope:** [Lines 190–199, 320–328](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L190-L328) (Technical Plan § 3.A, Implementation Plan § 2)
*   **Discrepancy Description:** Proposes creating `src/services/metadataFederationService.ts` from scratch, ignoring existing `src/services/federatedResolvers.ts`.
*   **Rationale:** `src/services/federatedResolvers.ts` (1,046 lines) already implements `federatedResolversService` with typed schemas (`CoverArtCandidate`, `ProviderResult`, `BatchDiffTrackResult`) and lookups for Apple Music, MusicBrainz, and AI candidates. Creating a parallel service is redundant.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Eliminates code duplication and leverages the existing, mature resolver architecture in Cadence.
*   **Proposed Edit:**
    *   Location: Update `Technical Plan § 3.A` and replace Target File #2 in Detailed Implementation Plan:
    *   Change: Change `src/services/metadataFederationService.ts` ([Create]) to `src/services/federatedResolvers.ts` ([Modify]), adding `resolveActiveItemCandidate(albumId: string, trackId?: string): Promise<CoverArtCandidate[]>`.

---

### [Issue 4] [`egm-implementation-readiness`] - Severity: Major
*   **Affected Scope:** [Lines 307–433](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L307-L433) (Detailed Implementation Plan)
*   **Discrepancy Description:** The 15 target files are listed as an unsequenced flat list without dependency phases or compilation checkpoints.
*   **Rationale:** The Phasing Standard mandates partitioning work into sequential, buildable phases leaving the codebase stable at each milestone.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Prevents mid-implementation build breaks and establishes clear verification checkpoints.
*   **Proposed Edit:**
    *   Location: Section `Detailed Implementation Plan`
    *   Change: Partition into 4 sequential phases:
        *   **Phase 1: Domain State & Service Layer**: `scopeUtils.ts`, `curationQueueService.ts`, `federatedResolvers.ts`, `useStagedChanges.ts`. (Checkpoint: `npm run build` succeeds).
        *   **Phase 2: Master-Detail Curation Workbench UI**: `LeftRail.tsx`, `CurationQueueRail.tsx`, `CurationReconciliationStage.tsx`, `CurationWorkbench.tsx`, `App.tsx`. (Checkpoint: `⌘2` renders workbench with 64px rail).
        *   **Phase 3: Copilot Batch Proposal Safety Layer**: `BatchProposalSheet.tsx`, `agentActionDispatcher.ts`, `EmbeddedAgentDrawer.tsx`. (Checkpoint: Copilot recommendations open proposal sheet).
        *   **Phase 4: Commit Modal Alignment & Automated Tests**: `TwoPhaseCommitModal.tsx`, `FocusedWorkbench.tsx`, `testCurationLifecycle.ts`. (Checkpoint: Automated test suite passes; counters sync).

---

### [Issue 5] [`egm-design`] - Severity: Major
*   **Affected Scope:** [Lines 168, 190–199](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L168-L199) (Technical Plan § 2.B, § 3.A)
*   **Discrepancy Description:** Rapid queue stepping via keyboard shortcuts (`⌘]`/`⌘[`) fires unthrottled external API requests, risking MusicBrainz HTTP 429 rate-limit blocks (1 req/sec).
*   **Rationale:** Stepping through 10 albums in 5 seconds will trigger 10 concurrent requests and rate-limit IP bans.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Protects network integrity and user experience with standard debounce and cancellation patterns.
*   **Proposed Edit:**
    *   Location: Lines 198–199 (`Technical Plan § 3.A`) and `NFR § 2`
    *   Change: Mandate a 300ms debounce on active queue selection before dispatching network lookups, and wire an `AbortController.signal` to abort in-flight requests when a new queue item is selected.

---

### [Issue 6] [`egm-structural`, `egm-design`] - Severity: Major
*   **Affected Scope:** [Lines 287–306](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L287-L306) (Following NFRs)
*   **Discrepancy Description:** Omission of the mandatory `## Risks & Mitigations` section required by the Feature Specification Standard.
*   **Rationale:** Operational failure modes (API rate limits, DOM freeze on large batch diffs, offline air-gapped catalog operation) must be consolidated into a clear risk matrix.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Satisfies standard compliance and provides explicit mitigations for real-world operational challenges.
*   **Proposed Edit:**
    *   Location: Insert new H2 section `## Risks & Mitigations` before `Detailed Implementation Plan`:
    *   Change:
        *   *Risk 1: External API Rate Limiting (MusicBrainz 1 req/sec)* $\rightarrow$ *Mitigation:* 300ms debounce on queue navigation + `AbortController` request cancellation.
        *   *Risk 2: UI Thread Freeze on Large Copilot Diffs (1,000+ tracks)* $\rightarrow$ *Mitigation:* Virtualized table rendering in `BatchProposalSheet.tsx`.
        *   *Risk 3: Air-Gapped / Offline Workstations* $\rightarrow$ *Mitigation:* Passive fallback displaying `Offline · Not Queried` for remote columns, allowing local tag and sidecar workflows without blocking.

---

### [Issue 7] [`egm-zoom-out`] - Severity: Major
*   **Affected Scope:** [Lines 146–164](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L146-L164) (Technical Plan § 2.B)
*   **Discrepancy Description:** `AlbumCurationQueueItem` eagerly includes `soundtrackClusters`, forcing compilation clustering across all queue albums during initial queue discovery.
*   **Rationale:** Initial queue computation should be lightweight (<10ms). Compilation clustering heuristics should be evaluated lazily only when an album is selected for editing.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Keeps queue discovery fast and responsive without premature computation.
*   **Proposed Edit:**
    *   Location: Lines 158–162 (`AlbumCurationQueueItem` interface)
    *   Change: Remove `soundtrackClusters` from `AlbumCurationQueueItem`. Document that compilation soundtrack clusters are resolved on-demand by `CurationReconciliationStage` when the album is loaded.

---

### [Issue 8] [`egm-zoom-out`] - Severity: Major
*   **Affected Scope:** [Lines 170–185, 338–353, 393–400](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L170-L400)
*   **Discrepancy Description:** Coexistence ambiguity between `FocusedWorkbench.tsx` and `CurationReconciliationStage.tsx`.
*   **Rationale:** Maintaining two separate 4-way reconciliation components creates maintenance drift.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Establishes single-responsibility component ownership.
*   **Proposed Edit:**
    *   Location: `Technical Plan § 2.C` and Implementation Plan § 11
    *   Change: Specify that `CurationReconciliationStage` acts as the definitive reconciliation canvas inside `CurationWorkbench`. Refactor or deprecate `FocusedWorkbench` to reuse `CurationReconciliationStage` for single-track edits.

---

### [Issue 9] [`egm-implementation-readiness`, `egm-codebase-details`] - Severity: Major
*   **Affected Scope:** [Lines 370–376, 408–422](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L370-L422) (Implementation Plan § 8, 13, 14)
*   **Discrepancy Description:** Missing concrete state derivations for `useStagedChanges`, modal row badge toggle mechanisms, and cleanup of in-memory mutations in `resolve_work_hierarchy`.
*   **Rationale:** Leaves key state management choices to the implementer and misses in-memory direct mutations in `agentActionDispatcher.ts`.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Closes implementation ambiguity and enforces strict immutability across all dispatcher actions.
*   **Proposed Edit:**
    *   Location: Implementation Plan § 8, 13, 14
    *   Change:
        *   In `useStagedChanges.ts`: Derive `triageAlbumsCount` directly from `graphEngine` to avoid circular dependencies with `curationQueueService`.
        *   In `TwoPhaseCommitModal.tsx`: Elevate `writeMode` (`'headers' | 'sidecar'`) to modal parent state and pass down as a prop to `TwoPhaseCommitModalRow`.
        *   In `agentActionDispatcher.ts`: Remove direct mutations `t.title = cleanTitle` and `t.artistCredit = performers` in `resolve_work_hierarchy`, routing exclusively to `t.pendingSidecarEdits`.

---

### [Issue 10] [`egm-comprehension`] - Severity: Major
*   **Affected Scope:** [Lines 171–178, 351–352](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L171-L352)
*   **Discrepancy Description:** Undefined queue completion (stepping past Item 15) and external provider error states.
*   **Rationale:** The UI must have explicit screens when all queue items are addressed or when an external API fails.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Eliminates UI dead-ends.
*   **Proposed Edit:**
    *   Location: Lines 173–178, 351–352
    *   Change: Specify a "Queue Cleared: 15 Albums Staged" completion card with a primary action button `[Review & Commit Changes (⌘4)]`. For provider failures (timeout/429), specify an `Unavailable / Retry` button in the provider header.

---

### [Issue 11] [`egm-zoom-out`] - Severity: Nit
*   **Affected Scope:** [Lines 201–216](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L201-L216) (Technical Plan § 3.B)
*   **Discrepancy Description:** Concrete TypeScript object spread code syntax in the high-level architecture section.
*   **Rationale:** High-level sections should focus on invariants and state models rather than concrete syntax snippets.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Maintains clean architectural altitude.
*   **Proposed Edit:**
    *   Location: Lines 202–213
    *   Change: Replace raw code snippet with a concise state transition specification: "Staged edits write exclusively to `track.pendingSidecarEdits` and set `track.sidecarStatus = 'uncommitted_sidecar'` while keeping base track fields in memory immutable."

---

### [Issue 12] [`egm-comprehension`] - Severity: Nit
*   **Affected Scope:** [Lines 381, 389–391](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L381-L391) (Implementation Plan § 9, 10)
*   **Discrepancy Description:** Unstated sidebar state restoration behavior upon exiting Curate mode.
*   **Rationale:** A user's manual expand/collapse setting in `Listen` or `Audit` must not be permanently lost.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Clarifies UX state behavior.
*   **Proposed Edit:**
    *   Location: Implementation Plan § 10
    *   Change: Note that `isIconOnly` is an active override only while `topMode === 'curate'`; on mode switch to `Listen` or `Audit`, `LeftRail` restores the user's prior manual width setting.

---

### [Issue 13] [`egm-style`] - Severity: Nit
*   **Affected Scope:** [Lines 215, 282, 352](docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md#L215-L352)
*   **Discrepancy Description:** Promotional phrasing, misapplied audio transport terminology to metadata tags, and emotional adjectives in alternatives.
*   **Rationale:** "Bit-perfect" applies to WASAPI exclusive streaming, not ID3 tags.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Aligns document tone with rigorous engineering standards.
*   **Proposed Edit:**
    *   Location: Lines 215, 282, 352
    *   Change: Replace "100% diff symmetry" with "identical diff representations"; replace "excruciatingly tedious and frustrating" with "imposes excessive interaction friction"; replace "bit-perfect standards" for metadata with "catalog hygiene standards".
