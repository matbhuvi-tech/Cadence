# Critic Review Report

*   **Target File:** `docs/designs/CURATION_AND_TRIAGE_LIFECYCLE_ARCHITECTURE.md`
*   **Standard:** [Feature Specification Standard](file:///C:/Users/Mathan/.gemini/config/plugins/elephant-goldfish-model/resources/document_standards/feature-spec-standard.md)
*   **Reviewers:** Design Critic (`egm-design`), Structural Validator (`egm-structural`), Style Editor (`egm-style`)
*   **Target Scope:** `FeatureRange` (Lines 1–306)
*   **Mode:** Review (Stage 7)

---

## Executive Summary

The feature specification establishes a solid foundation for unifying curation, auto-suggestion, and commit verification. The alternatives analysis is rigorous, and the separation of concerns between triage, reconciliation, and commit is clear. 

However, the specification exhibits three notable gaps:
1. **Architectural & Operational Risks (`egm-design`)**: It lacks request debouncing and cancellation for rapid queue stepping, risking HTTP 429/503 rate-limit bans from external providers (MusicBrainz 1 req/sec), and omits offline/air-gapped degradation behavior.
2. **Structural Standard Compliance (`egm-structural`)**: It lacks an explicit, dedicated `## Risks & Mitigations` section required by the Feature Specification Standard, leaving failure modes scattered across NFRs and Alternatives.
3. **Terminology Precision (`egm-style`)**: It misapplies audio transport terminology to metadata tags (e.g. "conforming to bit-perfect standards" for tags) and contains subjective emotional language in rejected alternatives ("excruciatingly tedious").

---

## Detailed Findings

### 1. Rapid Queue Stepping Rate-Limiting & Cancellation Defect
*   **Reviewer:** `egm-design`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 168, 190–199 (`Technical Plan § 2.B` and `§ 3.A`)
*   **Finding & Recommendation:** 
    *   *Flaw:* MusicBrainz enforces a strict rate limit of 1 request per second per IP address. If a user rapidly navigates through the curation queue using keyboard shortcuts (`⌘]` / `⌘[`), 10–15 lookups will be dispatched concurrently, triggering 429 / 503 rate-limit blocks and IP bans.
    *   *Recommendation:* Mandate a 300ms debounce on queue item selection before triggering network lookups. Require all external fetch calls to pass an `AbortController.signal` so that selecting a new queue item immediately aborts any in-flight lookups for the previous item.

### 2. Missing Offline / Air-Gapped Catalog Operation Mode
*   **Reviewer:** `egm-design`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 190–199 (`Technical Plan § 3.A`)
*   **Finding & Recommendation:**
    *   *Flaw:* High-end audiophile workstations are frequently disconnected from the Internet (or placed in air-gapped network configurations) to minimize network PHY noise. The specification does not define how the 4-way reconciliation stage behaves when the system has no active Internet connection.
    *   *Recommendation:* Explicitly document offline fallback behavior: when network calls fail or are offline, external provider columns render as `Offline · Not Queried`, allowing users to perform local tag editing and manual sidecar staging without UI blocking or infinite loading spinners.

### 3. Missing Mandatory `## Risks & Mitigations` Section
*   **Reviewer:** `egm-structural`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 287–306 (Following `Non-Functional Requirements`)
*   **Discrepancy Description & Rationale:**
    *   *Flaw:* The Feature Specification Standard explicitly mandates a dedicated `## Risks & Mitigations` section. While some risks are touched upon in NFRs (e.g. playback quietness), operational risks such as rate-limit lockouts, DOM performance with large Copilot diffs, and concurrent SQLite writes are not consolidated into a dedicated risk matrix.
    *   *Recommendation:* Add a formal `## Risks & Mitigations` section addressing:
        1. Rate limiting on external APIs (Mitigation: 300ms debounce + `AbortController`).
        2. UI thread freeze on large batch proposals (Mitigation: virtualized diff list in `BatchProposalSheet`).
        3. Offline network state (Mitigation: immediate passive fallback to local tags).

### 4. DOM Virtualization in `BatchProposalSheet`
*   **Reviewer:** `egm-design`
*   **Severity:** 🟡 Major
*   **Affected Scope:** Lines 228–234 (`Technical Plan § 4.B`)
*   **Finding & Recommendation:**
    *   *Flaw:* A catalog-wide operation triggered from Copilot (such as normalizing genres or folder synchronization) can produce diffs across 1,000+ tracks. Rendering an unvirtualized HTML table with 1,000+ rows inside a modal drawer will cause substantial DOM reflow lag and jank.
    *   *Recommendation:* Explicitly mandate windowing/virtualization (e.g. `@tanstack/react-virtual` or CSS-contained fixed windowing) for the diff table in `BatchProposalSheet.tsx`.

### 5. Imprecise Terminology & Subjective Phrasing
*   **Reviewer:** `egm-style`
*   **Severity:** 🟢 Nit
*   **Affected Scope:** Lines 215, 282, 352
*   **Style Rationale:**
    *   *Line 215:* "guaranteeing 100% diff symmetry" is promotional phrasing. Replace with "ensuring identical diff representations".
    *   *Line 282:* "excruciatingly tedious and frustrating" is emotional hyperbole. Replace with "imposes excessive interaction friction".
    *   *Line 352:* "All catalog items conform to bit-perfect standards". The term "bit-perfect" refers strictly to unadulterated audio transport (WASAPI Exclusive, sample rate preservation). Metadata tags cannot be "bit-perfect"; they conform to "catalog hygiene standards". Replace "bit-perfect" with "hygiene".
