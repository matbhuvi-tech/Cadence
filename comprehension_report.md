# Comprehension Review Report

**Target:** `docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md` (Lines 1–511)
**Reviewer Lens:** `egm-comprehension`
**Perspective:** Naive Reader with Zero Assumed Institutional Knowledge

## Executive Summary
The document is well-structured and explains the user pain points and domain-specific terminology (such as Indian cinema soundtrack attribution and dynamic range heuristics) with commendable clarity. However, several interaction states and cognitive boundaries require more explicit definitions so an outside developer or user understands the UI feedback loops.

---

## Prioritized Findings

### Issue 1: State Lifecycle of Staged Edits Across View Transitions - Severity: Major
* **Reviewer Lens:** `egm-comprehension`
* **Affected Scope:** Lines 80–84, 153–175, 464–475
* **Discrepancy Description:** The design introduces `NavigationAnchor` and the breadcrumb `← Return to Album in Listen`. However, it does not explicitly state what happens to uncommitted staged edits when the user clicks the return breadcrumb without committing. A reader might wonder if returning discards the sidecar edits or if they remain staged in the buffer.
* **Rationale & Recommendation:** Explicitly clarify in Section 1.2: Staged edits remain safely buffered in `track.pendingSidecarEdits` and `release.pendingSidecarEdits`. Returning to Listen preserves the amber "Staged" badge on the album card, allowing the user to resume or commit later via the global Two-Phase Commit modal.

### Issue 2: Microcopy & Visual Framing for Authority Toggles - Severity: Nit
* **Reviewer Lens:** `egm-comprehension`
* **Affected Scope:** Lines 252–256, 434, 480–482
* **Discrepancy Description:** The design describes an authority toggle in Curate but alternates between terminology: `[Composer Authority]`, `[Soundtrack / Composer Authority]`, and `metadata_authority_override`. A user seeing raw database terms will experience cognitive friction.
* **Rationale & Recommendation:** Standardize user-facing microcopy in the Curate workbench header: display a clean two-segment segmented control labeled `[Soundtrack (Composer Credit)]` and `[Album Artist (Performer Credit)]`, accompanied by a short helper tooltip explaining the impact on album card display.

### Issue 3: Distinction Between Box Sets and Pressing Variant Stacks - Severity: Nit
* **Reviewer Lens:** `egm-comprehension`
* **Affected Scope:** Lines 272–291, 382–390
* **Discrepancy Description:** The document refers to variant editions (different pressings of *Captain Prabhakaran*) and multi-disc box sets. A naive reader may be confused about whether "stacking" means combining discs into a multi-CD release or grouping alternate audio master pressings.
* **Rationale & Recommendation:** Add a one-sentence clarification in Subsystem 3: Multi-disc sets are grouped by disc number indicators (`Disc 1`, `CD 2`), whereas pressing variant stacks represent alternate physical master editions of the identical album (e.g., 1991 First Pressing CD vs 2018 Remaster). Both utilize `masterReleaseId` clustering.
