# Implementation Readiness Test Report

*   **Target File:** `docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md`
*   **Standard:** [Implementation Readiness Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/implementation-readiness-standard.md)
*   **Reviewers:** Pragmatic Tech Lead (`egm-implementation-readiness`), Codebase Auditor (`egm-codebase-details`), Style Editor (`egm-style`)
*   **Target Scope:** `DetailedRange` (Lines 307–450)
*   **Mode:** Review (Stage 9)

---

## Executive Summary

The Detailed Implementation Plan identifies the correct target files across the repository and accurately isolates key defects (e.g. `scopeUtils.ts` line 148 fallback, `TwoPhaseCommitModal` badge desynchronization).

However, the plan fails the **Zero-Decision Rule** and **Phasing Standard** in three critical areas:
1. **Unpartitioned Work Breakdown**: The 15 file tasks are presented as a flat, unsequenced list without phased checkpoints or buildability milestones.
2. **Codebase Target Drift**: File #2 specifies creating `metadataFederationService.ts` from scratch, failing to target the existing 1,046-line `src/services/federatedResolvers.ts`.
3. **Missing Data Flow & State Bindings**: Key state mechanisms (such as how `useStagedChanges` derives `triageAlbumsCount` without circular dependencies, and how `TwoPhaseCommitModal` binds global `commitTarget` to row badges) are described vaguely.

---

## Detailed Findings

### 1. Missing Phased Execution & Checkpoint Architecture
*   **Reviewer:** `egm-implementation-readiness`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 307–433 (`Detailed Implementation Plan`)
*   **Finding & Guidance:** 
    *   *Defect:* The implementation plan presents a flat list of 15 file modifications without phased dependencies. Attempting to build the UI components (e.g. `CurationQueueRail.tsx` or `CurationWorkbench.tsx`) before the underlying domain services and hooks are compile-ready will result in a broken build state.
    *   *Remediation:* Partition the implementation into four strictly ordered, buildable phases:
        *   **Phase 1: Domain State & Service Layer**: `scopeUtils.ts`, `curationQueueService.ts`, `federatedResolvers.ts`, `useStagedChanges.ts`. (Checkpoint: `npm run build` cleanly validates domain services).
        *   **Phase 2: Master-Detail Curation Workbench**: `LeftRail.tsx`, `CurationQueueRail.tsx`, `CurationReconciliationStage.tsx`, `CurationWorkbench.tsx`, `App.tsx`. (Checkpoint: `⌘2` navigates cleanly to Curate workbench with 64px rail).
        *   **Phase 3: Copilot Batch Proposal Safety Layer**: `BatchProposalSheet.tsx`, `agentActionDispatcher.ts`, `EmbeddedAgentDrawer.tsx`. (Checkpoint: Copilot recommendations trigger proposal sheet instead of direct mutations).
        *   **Phase 4: Commit Modal Alignment & Verification Suite**: `TwoPhaseCommitModal.tsx`, `FocusedWorkbench.tsx`, `testCurationLifecycle.ts`. (Checkpoint: Automated test suite passes; commit modal counters synchronize).

### 2. File Target Correction: Modify `federatedResolvers.ts` instead of Creating `metadataFederationService.ts`
*   **Reviewer:** `egm-codebase-details`
*   **Severity:** 🔴 Blocker
*   **Affected Scope:** Lines 320–328 (`Detailed Implementation Plan § 2`)
*   **Discrepancy Description & Rationale:**
    *   *Defect:* The plan instructs creating a new file `src/services/metadataFederationService.ts`. In Cadence, metadata federation across Apple Music/iTunes, MusicBrainz, and AI is already consolidated in [src/services/federatedResolvers.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/federatedResolvers.ts) (`federatedResolversService`). Creating a duplicate service fragments provider configurations and cache lifecycles.
    *   *Remediation:* Change Target File #2 to `src/services/federatedResolvers.ts` ([Modify]). Specify extending `federatedResolversService` with an on-demand active item resolution method: `resolveActiveItemCandidate(albumId: string, trackId?: string): Promise<CoverArtCandidate[]>`.

### 3. Missing State Binding Specification for `useStagedChanges.ts` and `TwoPhaseCommitModal.tsx`
*   **Reviewer:** `egm-implementation-readiness`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 370–376, 415–422 (`Detailed Implementation Plan § 8, 14`)
*   **Finding & Guidance:**
    *   *Defect:* Line 373 states that `useStagedChanges` exposes `triageAlbumsCount`, but does not specify how this value is computed or whether it imports `curationQueueService`. If `useStagedChanges` imports `curationQueueService` while `curationQueueService` imports staging status from `useStagedChanges`, a circular dependency loop occurs.
    *   *Defect:* Line 419 states: "Fixes row-level badge toggle loop so switching write modes in the footer updates badges across all album rows". It omits the concrete mechanism.
    *   *Remediation:*
        *   In `useStagedChanges.ts`: Specify that `triageAlbumsCount` is computed by querying uncommitted sidecar status and catalog hygiene defect IDs directly from `graphEngine`, preventing circular dependencies with `curationQueueService`.
        *   In `TwoPhaseCommitModal.tsx`: Elevate `writeMode` (`'headers' | 'sidecar'`) to parent modal state, and pass it as a prop to each child `TwoPhaseCommitModalRow` component rather than having rows maintain independent local state.

### 4. Vague Automated Test Specification in `testCurationLifecycle.ts`
*   **Reviewer:** `egm-implementation-readiness`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 423–433 (`Detailed Implementation Plan § 15`)
*   **Finding & Guidance:**
    *   *Defect:* Section 15 lists high-level test objectives (e.g. "Unit test: Case A uniform staging vs Case B compilation soundtrack clustering") without specifying test fixtures, mock data, or assertion criteria.
    *   *Remediation:* Define explicit test fixtures and assertion thresholds:
        1. *Fixture*: Mock Release *A World Of Music* (5 tracks: 2 from *Dil Se..*, 3 from *Guru*). Assert that accepting *Dil Se..* updates `track[0].pendingSidecarEdits` while `track[2].pendingSidecarEdits` remains undefined.
        2. *Fixture*: Empty track array and cold start. Assert `resolveCurateTargetTrack()` returns `null` and `curationQueueService.resolveCurateInitialAlbum()` returns the first defect album.
        3. *Fixture*: Staging 3 tag edits on 1 album. Assert `stagedAlbumsCount === 1`, `stagedTracksCount === 1`, `stagedTagEditsCount === 3`.

### 5. In-Memory Direct Mutation Cleanup in `agentActionDispatcher.ts`
*   **Reviewer:** `egm-codebase-details`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 408–414 (`Detailed Implementation Plan § 13`)
*   **Discrepancy Description & Rationale:**
    *   *Defect:* In `agentActionDispatcher.ts` lines 240–242, `resolve_work_hierarchy` directly mutates `t.title = cleanTitle` and `t.artistCredit = performers` on base in-memory tracks. The plan mentions refactoring `remediate_issue`, but fails to target `resolve_work_hierarchy` to enforce strict `pendingSidecarEdits` immutability.
    *   *Remediation:* Explicitly instruct removing direct assignments `t.title = ...` and `t.artistCredit = ...` in `resolve_work_hierarchy`, routing changes strictly into `t.pendingSidecarEdits`.
