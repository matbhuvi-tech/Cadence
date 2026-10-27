# Goldfish Annotated Review Report

**Status:** resolved
**Target:** `docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md` (`FeatureRange: lines 1–312`)

## Prioritized Findings & AI Suggestions

### Finding 1 [egm-design] - Severity: Major
*   **Affected Scope:** [Lines 171-184](docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md#L171-L184) (`Section 5.A: Shared Catalog Health Hook`)
*   **Discrepancy Description:** `useCatalogHealth` computes authoritative health scores via full catalog traversal (`auditService.computeCatalogAudit(tracks, releases)`). On large libraries (50,000+ tracks over SMB), running this during component re-renders or active audio playback induces CPU spikes, violating transport quietness.
*   **Rationale:** Audiophile Invariant 1 dictates zero unnecessary disk/CPU bus churn during playback or within 30 seconds of stopping. Unthrottled audit computations during playback or track transitions pose latency and jitter risks.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Debounce catalog audit computations, memoize against a catalog mutation version stamp, and explicitly suspend calculations during active playback or paused states (`!is_playing && !is_paused && cooldown_elapsed`).
*   ***Proposed Edit:***
    *   Location: Section 5.A (`Shared Catalog Health Hook`)
    *   Change: Append explicit playback-idle guard and memoization contract to Section 5.A:
        ```markdown
        *   **Audiophile Idle-Guard & Memoization**:
            *   Audit calculations are debounced (500ms) and memoized against catalog mutation version counters (`tracksVersion`).
            *   Audit re-computations are strictly suspended while `AudioEngine` is in `Playing` or `Paused` states, or within 30 seconds of stopping, ensuring zero CPU power-state transients during active playback.
        ```

---

### Finding 2 [egm-design] - Severity: Major
*   **Affected Scope:** [Lines 155-166](docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md#L155-L166) (`Section 4.B: User Split Overrides via SQLite`)
*   **Discrepancy Description:** The design does not specify how the background library scanner interacts with `user_split_releases`. When a folder rescan or tag refresh occurs, a naive scanner might re-derive releases and re-merge albums, clobbering user manual split preferences.
*   **Rationale:** User manual curation must be durable and survive automated library rescans.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Specify the scanner reconciliation contract: the background scanner and library hydration service must read `user_split_releases` upon startup/scan, and honor split keys when building the in-memory release catalog.
*   ***Proposed Edit:***
    *   Location: Section 4.B (`User Split Overrides via SQLite`)
    *   Change: Add scanner persistence and ID contract specification:
        ```markdown
        *   **Key Contract & Scanner Reconciliation**:
            *   `release_id` stores either the MusicBrainz Release Group ID (`mbid:<id>`) for Tier 1 groupings or a normalized composite key (`group:<artist>::<title>`) for Tier 2 groupings.
            *   The background scanner and catalog hydration pipelines read `user_split_releases` into an in-memory `Set<string>` at startup. During rescans, the grouping pass bypasses any candidate matching a key in this set, ensuring manual splits persist across library rescans without SQLite roundtrips during grid layout.
        ```

---

### Finding 3 [egm-structural] - Severity: Major
*   **Affected Scope:** Section Structure between lines 298 and 313
*   **Discrepancy Description:** The Feature Specification Standard (`feature-spec-standard.md`) requires an explicit evaluation of risks, constraints, failure modes, and mitigations. The document currently lacks a dedicated `## Risks & Mitigations` section.
*   **Rationale:** Structural conformity and risk visibility are mandatory before detailed implementation can begin.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Add an explicit `## Risks & Mitigations` section addressing catalog audit CPU load, SMB network disconnection during tree filtering, and SQLite lock contention.
*   ***Proposed Edit:***
    *   Location: Insert between `## Alternatives Considered` and `## Non-Functional Requirements`
    *   Change: Add the following section:
        ```markdown
        ## Risks & Mitigations

        | Risk | Severity | Impact | Mitigation Strategy |
        | :--- | :--- | :--- | :--- |
        | **Catalog Health CPU Spikes** | High | UI stutter and CPU power-state transients during playback on large catalogs (50k+ tracks). | Debounce calculations by 500ms, memoize against `tracksVersion`, and suspend execution entirely during active or paused playback. |
        | **Scanner Overriding Manual Splits** | Medium | User manual album splits clobbered after catalog rescan or tag commit. | Scanner and hydration pipeline pre-load `user_split_releases` into memory and enforce split exclusions during grouping. |
        | **SMB Tree Latency / Disconnects** | Medium | Tree stalls or uncaught promises if remote NAS drops connection during traversal. | `⌘F` filter operates strictly on loaded in-memory nodes with zero disk I/O; collapsed nodes display clear indicators. |
        | **SQLite Split Table Migration Lock** | Low | Database schema locked if migration runs during active database operations. | Standard SQLite `PRAGMA busy_timeout = 5000` with idempotent `CREATE TABLE IF NOT EXISTS` migration on app boot. |
        ```

---

### Finding 4 [egm-style] - Severity: Nit
*   **Affected Scope:** [Line 257](docs/designs/UX_AND_UI_ARCHITECTURE_REFACTOR.md#L257) (`Section 6.E: Microcopy Sanitization & Polish`)
*   **Discrepancy Description:** Phrases like *"Purges internal engineering jargon..."* use informal and subjective framing.
*   **Rationale:** Technical documentation should use dry, factual, professional language.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Replace subjective terms with direct, objective descriptions.
*   ***Proposed Edit:***
    *   Location: Section 6.E (line 257)
    *   Change: Replace *"Purges internal engineering jargon..."* with *"Replaces internal protocol terminology and worker thread identifiers with plain-language, user-facing descriptions."*
