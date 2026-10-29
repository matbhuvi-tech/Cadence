# Goldfish Annotated Review Report

**Target:** [`docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md) (`full file`)
**Status:** resolved

## Prioritized Findings & AI Suggestions

### ACT-1: Replace Phantom Search Engine File with Real Codebase Targets [`egm-zoom-out` / `egm-codebase-details`] - Severity: High (Blocker)
*   **Affected Scope:** [Table 4.1, Subsystem 2.4, Step 4](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L273-L281)
*   **Discrepancy Description:** The impact ledger targets `src/services/searchEngine.ts`, which does not exist in the codebase.
*   **Rationale:** Search in Cadence is split between in-memory filtering in `AlbumCoverGrid.tsx` and database queries in `sqliteLibraryService.ts`.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Replaced phantom file with real codebase targets: `AlbumCoverGrid.tsx` lines 326–335 (expanding in-memory performer search loop) and `sqliteLibraryService.ts` (`searchCatalog`).

---

### ACT-2: Add TypeScript Nullability Type Updates for Bypassed DR [`egm-implementation-readiness`] - Severity: High (Blocker)
*   **Affected Scope:** [Subsystem 5.2, Table 4.1, Step 1](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L356-L370)
*   **Discrepancy Description:** Returning `{ drScore: null }` from `calculateDynamicRangeScore` violates strict types where `drScore` is typed as `number`.
*   **Rationale:** `tsc -b` compilation must remain clean per repository invariants.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Updated design document to explicitly require updating `IntegrityScanResult.drScore` in `src/services/integrityScanner.ts` and `Track.drScore?: number | null` in `src/core/types.ts` to `number | null`.

---

### ACT-3: Clarify Agglomerative Grouping in `albumGroupingService.ts` [`egm-codebase-details`] - Severity: Medium (Major)
*   **Affected Scope:** [Subsystem 3.1, Step 5](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L289-L305)
*   **Discrepancy Description:** `computeGroupingKey(release)` takes a single release and cannot execute pairwise similarity checks in isolation.
*   **Rationale:** Agglomerative clustering requires comparing candidate groups pairwise.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Clarified two-stage process: `computeGroupingKey` sanitizes rip noise to form clean base grouping keys, followed by an agglomerative clustering pass in `groupAlbumReleases` running pairwise Jaro-Winkler comparisons ($\ge 0.88$).

---

### ACT-4: Apply Composer Name Normalization in Scoring Uniformity Check [`egm-design`] - Severity: Medium (Major)
*   **Affected Scope:** [Subsystem 2.1, Step 4](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L226-L235)
*   **Discrepancy Description:** Spelling differences like `Ilaiyaraaja` vs `Ilayaraja` across tracks break `uniqueComposers.size === 1`.
*   **Rationale:** Tag discrepancies in real-world albums cause false negatives in soundtrack detection.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Normalized composer names with `normalizeArtistForGrouping` before checking uniformity.

---

### ACT-5: Add Zero-Duration Guard to Duration Invariant [`egm-design`] - Severity: Medium (Major)
*   **Affected Scope:** [Subsystem 3.1, Step 5](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L297-L301)
*   **Discrepancy Description:** In unindexed files with 0 duration, `0 / 0 = NaN <= 0.05` evaluates to `false`, breaking grouping.
*   **Rationale:** Edge cases with unparsed audio track durations must not corrupt stacking logic.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Added `maxDur > 0 ? (Math.abs(durationA - durationB) / maxDur <= 0.05) : true` guard.

---

### ACT-6: Clarify Staged Edits Persistence Across Navigation Transitions [`egm-comprehension`] - Severity: Medium (Major)
*   **Affected Scope:** [CUJ 1, Subsystem 1.2](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L80-L84)
*   **Discrepancy Description:** The lifecycle of uncommitted metadata changes when returning to Listen was ambiguous.
*   **Rationale:** Users must have total confidence that navigating away does not discard pending sidecar edits.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Explicitly documented that uncommitted edits persist in `pendingSidecarEdits` and the amber "Staged" badge remains visible on album cards in Listen.

---

### ACT-7: Rewire Orphaned Inspector Shortcuts in `App.tsx` [`egm-codebase-details`] - Severity: Low (Nit)
*   **Affected Scope:** [Subsystem 1.1, Step 2](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L151)
*   **Discrepancy Description:** Retiring the sidebar inspector tab left the `⌘I` shortcut and `handleInspectRelease` orphaned.
*   **Rationale:** Keyboard shortcuts should not lead to dead ends.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Rewired `⌘I` shortcut and `handleInspectRelease` to call `navigateToCurate(activeReleaseId, anchor)`.

---

### ACT-8: Standardize Authority Toggle Microcopy [`egm-comprehension`] - Severity: Low (Nit)
*   **Affected Scope:** [Subsystem 2.2](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L254)
*   **Discrepancy Description:** Inconsistent toggle button labels in design doc.
*   **Rationale:** Consistent UI microcopy reduces cognitive load.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Standardized labels to `[Soundtrack (Composer Credit)]` vs `[Album Artist (Performer Credit)]`.

---

### ACT-9: Distinguish Box Sets from Pressing Stacks [`egm-comprehension`] - Severity: Low (Nit)
*   **Affected Scope:** [Subsystem 3](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L286-L288)
*   **Discrepancy Description:** Subsystem 3 did not clearly distinguish multi-disc releases from version stacks.
*   **Rationale:** Clear mental models prevent domain confusion between disc containers and edition variants.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Added explicit one-sentence clarification distinguishing multi-disc releases from pressing variant stacks.

---

### ACT-10: Strip Prohibited Promotional Adjective ("seamless") [`egm-style`] - Severity: Low (Nit)
*   **Affected Scope:** [Alternative 1](docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md#L390)
*   **Discrepancy Description:** Use of prohibited marketing buzzword "seamless".
*   **Rationale:** Adherence to strict plain-English technical writing standards.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Resolution Status:*** Applied
*   ***Justification:*** Replaced "seamless experience" with "single-surface continuity".
