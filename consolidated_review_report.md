# EGM Consolidated Review Report

*   **Target Document:** `docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md`
*   **Protocol:** Elephant-Goldfish Model (EGM) Goldfish Review
*   **Execution Subflow:** Uninterrupted Full Flow (Stages 5, 6, 7, 8, 9)
*   **Date:** 2026-10-27

---

## Executive Summary

A comprehensive 5-stage architectural, comprehension, design critic, and implementation readiness audit was conducted on [CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md).

The design's high-level direction is strongly validated: it accurately diagnoses the root causes of Cadence's curation incoherence (the arbitrary `tracks[0]` fallback in `scopeUtils.ts`, fake template strings in `FocusedWorkbench.tsx`, silent Copilot batch mutations, and telemetric drift in `TwoPhaseCommitModal.tsx`).

However, the review surfaced critical implementation blockers, architectural reuse opportunities, and specification omissions that must be resolved prior to code implementation:
1. **Codebase Reuse over Duplication**: The proposal called for authoring a new `metadataFederationService.ts` and referenced a non-existent `geminiCompilationSoundtrackService.ts`. In reality, Cadence already possesses [src/services/federatedResolvers.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/federatedResolvers.ts) (1,046 lines) and [src/services/compilationCanonicalizerService.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/compilationCanonicalizerService.ts). Reusing these services saves ~500 lines of boilerplate and prevents cache/provider fragmentation.
2. **Missing Interface & Type Contracts**: The document mandates passing `BatchProposalData` without defining the interface, leaves queue completion states undefined, and omits the signature for `curationQueueService`.
3. **Operational Hardening**: Fast keyboard stepping (`⌘]`) across the queue risks triggering MusicBrainz HTTP 429 rate-limit blocks (1 req/sec limit); a 300ms debounce and `AbortController` cancellation must be specified.
4. **Phased Execution**: The 15 file tasks must be partitioned into 4 buildable phases with verification checkpoints.

---

## Prioritized Action Items

### 🔴 Blockers (Must Fix Before Code Execution)

*   **[B1] Eliminate Phantom Service `geminiCompilationSoundtrackService`**
    *   *Issue:* The design repeatedly refers to `geminiCompilationSoundtrackService.ts` for disaggregating Indian/world soundtrack compilations. This file does not exist.
    *   *Remediation:* Update all references to use the actual codebase service [src/services/compilationCanonicalizerService.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/compilationCanonicalizerService.ts) and its method `resolveCompilationSoundtracks(release, tracks)`.
*   **[B2] Define Missing `BatchProposalData` and Diff Schemas**
    *   *Issue:* `BatchProposalSheet.tsx` and `agentActionDispatcher.ts` rely on `BatchProposalData`, but the interface was never defined in the document.
    *   *Remediation:* Add explicit TypeScript interface definitions for `BatchProposalData` and `BatchProposalDiffRow` to the Technical Plan and Implementation Plan.
*   **[B3] Reuse `federatedResolvers.ts` instead of Creating `metadataFederationService.ts`**
    *   *Issue:* Creating `metadataFederationService.ts` duplicates existing provider resolution logic and candidate types from `federatedResolversService`.
    *   *Remediation:* Repurpose Target File #2 to modify [src/services/federatedResolvers.ts](file:///e:/Mathan/Code/Music%20Agent/src/services/federatedResolvers.ts), adding `resolveActiveItemCandidate(albumId: string, trackId?: string)`.

---

### 🟡 Majors (High Priority Architecture & Readiness Gaps)

*   **[M1] Partition Implementation into 4 Buildable Phases**
    *   *Issue:* The 15 file modifications are listed as a flat, unsequenced list, violating the Phasing standard.
    *   *Remediation:* Restructure Section 7 into 4 sequential phases:
        *   *Phase 1: Domain State & Service Layer* (`scopeUtils.ts`, `curationQueueService.ts`, `federatedResolvers.ts`, `useStagedChanges.ts`).
        *   *Phase 2: Master-Detail Curation Workbench* (`LeftRail.tsx`, `CurationQueueRail.tsx`, `CurationReconciliationStage.tsx`, `CurationWorkbench.tsx`, `App.tsx`).
        *   *Phase 3: Copilot Batch Proposal Safety Layer* (`BatchProposalSheet.tsx`, `agentActionDispatcher.ts`, `EmbeddedAgentDrawer.tsx`).
        *   *Phase 4: Commit Modal Alignment & Verification Suite* (`TwoPhaseCommitModal.tsx`, `FocusedWorkbench.tsx`, `testCurationLifecycle.ts`).
*   **[M2] External API Rate-Limiting & Request Cancellation**
    *   *Issue:* Rapid keyboard navigation (`⌘]`) will trigger concurrent external API calls, violating MusicBrainz's 1 req/sec limit.
    *   *Remediation:* Mandate a 300ms debounce on active queue selection and wire `AbortController.signal` to abort in-flight queries upon selecting a new album.
*   **[M3] Add Mandatory `## Risks & Mitigations` Section**
    *   *Issue:* The document omits the formal `## Risks & Mitigations` section required by the Feature Specification Standard.
    *   *Remediation:* Add a dedicated section covering API rate limits (debounce/abort), UI thread jank on large batch diffs (virtualized modal table), and offline catalog operation (graceful degradation to local tags).
*   **[M4] Enforce Lazy Compilation Clustering in Queue Engine**
    *   *Issue:* The `AlbumCurationQueueItem` schema eagerly includes `soundtrackClusters`, risking heavy computation during initial queue scans.
    *   *Remediation:* Remove `soundtrackClusters` from the queue item schema. Keep the queue item lightweight (IDs, title, artist, defect category) and resolve clusters on-demand when an album is active in the reconciliation stage.
*   **[M5] Resolve `FocusedWorkbench` vs `CurationReconciliationStage` Duplication**
    *   *Issue:* The plan modifies `FocusedWorkbench.tsx` while creating `CurationReconciliationStage.tsx` for the same 4-way reconciliation canvas.
    *   *Remediation:* Explicitly clarify that `CurationReconciliationStage` replaces `FocusedWorkbench` in Curate mode, or refactor `FocusedWorkbench` directly into the right-hand stage.
*   **[M6] Specify Concrete State Bindings for Hooks and Modals**
    *   *Issue:* Missing concrete state mechanisms for `useStagedChanges` (deriving `triageAlbumsCount` without circular dependencies) and `TwoPhaseCommitModal` (elevating `writeMode` to parent modal state).
    *   *Remediation:* Document exact hook query methods and specify that `writeMode` is passed as a prop from the modal parent to each child row.
*   **[M7] Define Queue Completion & Provider Error States**
    *   *Issue:* Stepping past Item 15 of 15 and external network outages are not visually defined.
    *   *Remediation:* Specify a "Queue Cleared" completion state with a `[Review & Commit]` call-to-action, and define an `Error / Retry` state for provider columns.

---

### 🟢 Nits (Editorial & Minor Code Adjustments)

*   **[N1] Move Code Syntax Weeds to Implementation Section**
    *   *Issue:* Technical Plan contains raw TypeScript object spread syntax (`track.pendingSidecarEdits = { ... }`).
    *   *Remediation:* Move raw code snippets to the Implementation Plan, stating the invariant concisely in the Technical Plan.
*   **[N2] Clarify Navigation Rail State Restoration**
    *   *Issue:* Unclear whether manual sidebar toggle state is preserved when returning from `Curate` to `Listen` or `Audit`.
    *   *Remediation:* Document that `isIconOnly` is a mode-specific override that restores the user's prior rail width on mode exit.
*   **[N3] Standardize Terminology & Strip Subjective Phrasing**
    *   *Issue:* "Bit-perfect" is incorrectly applied to metadata tags; alternatives contain emotional language ("excruciatingly tedious").
    *   *Remediation:* Replace "bit-perfect standards" with "catalog hygiene standards", "100% diff symmetry" with "identical diff representations", and adopt neutral phrasing in alternatives.

---

## Traceability Matrix

| Stage | Originating Persona & Standard | Raw Finding | Consolidated Action Item |
| :--- | :--- | :--- | :--- |
| **Stage 5** | `egm-zoom-out` ([Zoom Out Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/zoom-out-standard.md)) | Redundant `metadataFederationService.ts` ignoring `federatedResolvers.ts` | **[B3]** Reuse `federatedResolvers.ts` |
| **Stage 5** | `egm-zoom-out` ([Zoom Out Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/zoom-out-standard.md)) | Coexistence ambiguity between `FocusedWorkbench` & `CurationReconciliationStage` | **[M5]** Resolve Component Duplication |
| **Stage 5** | `egm-zoom-out` ([Zoom Out Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/zoom-out-standard.md)) | Eager compilation clustering in `AlbumCurationQueueItem` | **[M4]** Lazy Compilation Clustering |
| **Stage 5** | `egm-zoom-out` ([Zoom Out Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/zoom-out-standard.md)) | TypeScript object spread assignment in high-level plan | **[N1]** Move Code Weeds |
| **Stage 6** | `egm-comprehension` ([Re-Implementation Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/re-implementation-standard.md)) | Phantom service `geminiCompilationSoundtrackService` | **[B1]** Eliminate Phantom Service |
| **Stage 6** | `egm-comprehension` ([Re-Implementation Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/re-implementation-standard.md)) | Undefined `BatchProposalData` interface | **[B2]** Define `BatchProposalData` Schema |
| **Stage 6** | `egm-comprehension` ([Re-Implementation Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/re-implementation-standard.md)) | Ambiguous signature for `curationQueueService` | **[M6]** Specify State Bindings |
| **Stage 6** | `egm-comprehension` ([Re-Implementation Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/re-implementation-standard.md)) | Undefined queue completion (Item 15) & provider failure states | **[M7]** Define Queue Completion States |
| **Stage 6** | `egm-comprehension` ([Re-Implementation Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/re-implementation-standard.md)) | Unstated sidebar state restoration upon leaving Curate | **[N2]** Navigation Rail Restoration |
| **Stage 7** | `egm-design` ([Feature Spec Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/feature-spec-standard.md)) | Rapid keyboard stepping rate-limit blocks (MusicBrainz 1 req/sec) | **[M2]** External API Rate-Limiting |
| **Stage 7** | `egm-design` ([Feature Spec Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/feature-spec-standard.md)) | Missing offline & air-gapped catalog degradation mode | **[M3]** Add `## Risks & Mitigations` |
| **Stage 7** | `egm-design` ([Feature Spec Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/feature-spec-standard.md)) | DOM reflow lag with large unvirtualized Copilot diff tables | **[M3]** Add `## Risks & Mitigations` |
| **Stage 7** | `egm-structural` ([Feature Spec Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/feature-spec-standard.md)) | Missing mandatory `## Risks & Mitigations` heading | **[M3]** Add `## Risks & Mitigations` |
| **Stage 7** | `egm-style` ([Feature Spec Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/feature-spec-standard.md)) | Promotional claims ("100% diff symmetry") & emotional phrasing | **[N3]** Standardize Terminology |
| **Stage 8** | `egm-zoom-out` ([Zoom Out Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/zoom-out-standard.md)) | Re-evaluation confirmed reuse of `federatedResolvers` simplifies system | **[B3]** Reuse `federatedResolvers.ts` |
| **Stage 9** | `egm-implementation-readiness` ([Implementation Readiness Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/implementation-readiness-standard.md)) | Unpartitioned work breakdown violating Phasing standard | **[M1]** Partition into 4 Phases |
| **Stage 9** | `egm-implementation-readiness` ([Implementation Readiness Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/implementation-readiness-standard.md)) | Missing state binding for `useStagedChanges` & `TwoPhaseCommitModal` | **[M6]** Specify State Bindings |
| **Stage 9** | `egm-implementation-readiness` ([Implementation Readiness Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/implementation-readiness-standard.md)) | High-level test descriptions lacking fixtures & assertions | **[M1]** / Phase 4 Test Suite |
| **Stage 9** | `egm-codebase-details` ([Implementation Readiness Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/implementation-readiness-standard.md)) | In-memory direct mutations in `resolve_work_hierarchy` omitted | **[M6]** Specify State Bindings |

---

## Next Steps

To apply these findings to the design document:
1. **Interactive Resolution (`/egm-resolve`)**: Automatically evaluate each finding against [docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md) and execute targeted edits.
2. **Proceed to Implementation**: Once updated, create the feature branch (`feat/curation-triage-lifecycle`) following the workspace git rules.
