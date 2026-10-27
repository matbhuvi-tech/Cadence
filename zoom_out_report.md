# Initial Zoom Out Review Report

*   **Target File:** `docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md`
*   **Standard:** [Zoom Out Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/zoom-out-standard.md)
*   **Reviewer Persona:** Skeptical Architect (`egm-zoom-out`)
*   **Mode:** Review (Stage 5)

---

## Executive Summary

The proposed architecture correctly isolates the root causes of Cadence's curation incoherence: the arbitrary fallback to `tracks[0]` in `scopeUtils.ts`, fake template strings in `FocusedWorkbench.tsx`, silent Copilot batch mutations, and telemetric drift in `TwoPhaseCommitModal.tsx`. 

However, from a high-altitude architectural perspective, the proposal suffers from two major reuse and boundary flaws:
1. It proposes a new service (`metadataFederationService.ts`) to query Apple Music, MusicBrainz, and Gemini AI, ignoring the existing 1,046-line `src/services/federatedResolvers.ts` which already implements these exact provider queries and candidate schemas.
2. It introduces three new components (`CurationWorkbench`, `CurationQueueRail`, `CurationReconciliationStage`) while simultaneously retaining and modifying `FocusedWorkbench.tsx`, resulting in component duplication and ambiguous ownership over 4-way reconciliation.

---

## Detailed Findings

### 1. Reinventing the Wheel: Redundant `metadataFederationService.ts`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 190–199, 320–328 (`Technical Plan § 3.A` and `Detailed Implementation Plan § 2`)
*   **Simplicity Rationale:** The document calls for creating `src/services/metadataFederationService.ts` to query Apple Music, MusicBrainz, and Gemini AI on-demand. However, `src/services/federatedResolvers.ts` already contains an established `federatedResolversService` with typed provider schemas (`CoverArtCandidate`, `ProviderResult`, `BatchDiffTrackResult`) and provider lookups. Introducing a second federation service creates duplicate types, divergent rate limiters, and split maintenance.
*   **Recommendation:** Eliminate `metadataFederationService.ts`. Instead, extend or wrap the existing `federatedResolversService` to add the required on-demand single-item method and active playback guard (`isPlaybackActive()`).

### 2. Component Duplication: `CurationReconciliationStage` vs. `FocusedWorkbench`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 170–185, 338–353, 393–400 (`Technical Plan § 2.C` and `Detailed Implementation Plan § 4, 5, 11`)
*   **Simplicity Rationale:** The plan creates `CurationWorkbench.tsx` and `CurationReconciliationStage.tsx` to host the 4-way metadata table and artwork inspector, but also specifies modifications to `FocusedWorkbench.tsx` for the same purpose. Having two separate components rendering identical 4-way metadata comparison tables creates long-term UI maintenance drift.
*   **Recommendation:** Clarify component boundaries. Either refactor `FocusedWorkbench.tsx` to act as the reconciliation stage inside `CurationWorkbench`, or explicitly deprecate `FocusedWorkbench.tsx` and consolidate all track/album curation into the new workbench.

### 3. Premature Computation: Eager Compilation Clustering in Queue Engine
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 146–164 (`Technical Plan § 2.B CurationQueueRail.tsx`)
*   **Simplicity Rationale:** The `AlbumCurationQueueItem` interface includes `soundtrackClusters?: { canonicalTitle: string; releaseYear: string; trackIds: string[] }[]`. Computing compilation soundtrack disaggregation eagerly across all 15+ queue albums during the initial queue scan (`computeCurationQueue`) is unnecessary work. Compilation clustering heuristics should be evaluated lazily only when the specific compilation album is selected for editing in the right-hand canvas.
*   **Recommendation:** Remove `soundtrackClusters` from the queue item schema. Keep `AlbumCurationQueueItem` lightweight (ID, Title, Artist, Defect Category, Affected Count). Resolve soundtrack clusters on-demand when the album is loaded into the reconciliation stage.

### 4. Code-Level Weeds in High-Level Architecture
*   **Severity:** 🟢 Nit
*   **Affected Scope:** Lines 201–216 (`Technical Plan § 3.B Strict pendingSidecarEdits Immutability`)
*   **Simplicity Rationale:** Lines 204–213 display concrete TypeScript object spread assignment syntax (`track.pendingSidecarEdits = { ...(track.pendingSidecarEdits || {}), ... }`). High-level architecture sections should define invariants, lifecycle states, and immutability guarantees rather than syntax-level assignments.
*   **Recommendation:** Move the specific TypeScript snippet to the Detailed Implementation Plan or a test case, and summarize the state invariant concisely in the Technical Plan.
