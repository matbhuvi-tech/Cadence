# Comprehension Test Report

*   **Target File:** `docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md`
*   **Standard:** [Re-Implementation Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/re-implementation-standard.md)
*   **Reviewer Persona:** Naive Reader (`egm-comprehension`)
*   **Mode:** Review (Stage 6)

---

## Executive Summary

The document establishes a coherent narrative and clear motivations for the 3-stage curation lifecycle. However, when evaluated under the **Zero-Assumption Rule**, a fresh engineer attempting to implement the plan without prior knowledge would encounter critical omissions:
1. It references a non-existent service name (`geminiCompilationSoundtrackService`) when the actual codebase service is `compilationCanonicalizerService.ts`.
2. It mandates passing `BatchProposalData` into `openBatchProposal` without defining the interface or schema.
3. It omits queue boundary behavior (e.g. actions upon completing Item 15 of 15) and error state handling for failed provider queries.

---

## Detailed Findings

### 1. Phantom Service Identifier: `geminiCompilationSoundtrackService`
*   **Severity:** 🔴 Blocker
*   **Affected Scope:** Lines 35, 197, 324
*   **Discrepancy Description & Rationale:** The document repeatedly directs the implementer to integrate with `geminiCompilationSoundtrackService.ts` for disaggregating Indian / world soundtrack compilations. In reality, no file with that name exists in the codebase. The actual service implemented in Cadence is [compilationCanonicalizerService.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/compilationCanonicalizerService.ts), which exports `compilationCanonicalizerService` and `resolveCompilationSoundtracks(release, tracks, allReleases)`. A fresh implementer would fail to compile on the first attempt due to an invalid import.
*   **Remediation:** Replace all references to `geminiCompilationSoundtrackService` with `compilationCanonicalizerService` and document the exact method signature: `compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks)`.

### 2. Missing Interface Definition: `BatchProposalData`
*   **Severity:** 🔴 Blocker
*   **Affected Scope:** Lines 223, 358–361, 411–413 (`Technical Plan § 4` and `Detailed Implementation Plan § 6, 13`)
*   **Discrepancy Description & Rationale:** The document states that the dispatcher invokes `openBatchProposal(proposalData)` and extends `AgentDispatcherContext` with `openBatchProposal: (data: BatchProposalData) => void`. However, nowhere in the document is `BatchProposalData` defined. The implementer must guess what fields `BatchProposalSheet` expects (e.g., action ID, title, diff arrays, track IDs, rollback callbacks).
*   **Remediation:** Explicitly define the `BatchProposalData` TypeScript contract inline in the specification:
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

### 3. Ambiguous Dependency Contract in `curationQueueService.ts`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 314–318 (`Detailed Implementation Plan § 1`)
*   **Discrepancy Description & Rationale:** The plan states: `computeCurationQueue(tracks: Track[], releases: Release[]): AlbumCurationQueueItem[]` and notes that it "scans `AuditIssue` items". It does not specify whether `auditIssues: AuditIssue[]` should be passed as a third parameter or whether `curationQueueService` should call `auditService.computeCatalogAudit(tracks, releases)` internally. If `AuditContext` already has active `issues` in memory, recomputing catalog audits inside the queue service duplicates CPU cycles.
*   **Remediation:** Define the exact signature: `computeCurationQueue(tracks: Track[], releases: Release[], existingIssues?: AuditIssue[]): AlbumCurationQueueItem[]`. If `existingIssues` is provided, reuse them; otherwise fall back to `auditService.computeCatalogAudit`.

### 4. Undefined Queue Completion & Provider Error States
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 171–178, 351–352
*   **Discrepancy Description & Rationale:** 
    *   What happens when the user clicks `Stage & Next → (⌘↵)` on the final queue item (Item 15 of 15)? Does the stepper wrap around to Item 1, transition to a "All Queued Items Addressed" completion card, or trigger a modal prompting the user to commit staged changes?
    *   What is the behavior in the 4-way reconciliation table if an external provider query (e.g., MusicBrainz) returns HTTP 429 (rate-limited) or fails due to network outage? Does the column render an empty state, a retry action, or a fallback badge?
*   **Remediation:** Specify terminal queue behavior (e.g., display a "Queue Cleared: 15 Albums Staged" completion screen with a direct button to `[Review & Commit Changes]`) and define failure states in the provider columns (`Error / Retry` button).

### 5. Unspecified Navigation Rail Restoration Behavior
*   **Severity:** 🟢 Nit
*   **Affected Scope:** Lines 381, 389–391
*   **Discrepancy Description & Rationale:** The plan specifies passing `isIconOnly={topMode === 'curate'}` to `LeftRail`. It does not clarify whether a user's manual expand/collapse preference in `Listen` or `Audit` mode is preserved when switching into and out of `Curate`.
*   **Remediation:** Note that `isIconOnly` is an override active only while `topMode === 'curate'`, restoring the user's prior sidebar state upon returning to `Listen` or `Audit`.
