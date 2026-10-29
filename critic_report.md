# Design Critic Review Report

**Target:** `docs/designs/UNIFIED_METADATA_MANAGEMENT_AND_CATALOG_COHERENCE.md` (Lines 1–413, Feature Specification)
**Reviewer Lenses:** `egm-design`, `egm-structural`, `egm-style`
**Standards:** `feature-spec-standard.md`, `heilmeier-standard.md`

## Executive Summary
The feature specification delivers a coherent architecture that directly eliminates user cognitive friction. The separation of concerns between playback context (Queue/Playlists) and catalog editing (Curate) is architecturally sound. However, the critic lens identified two algorithmic edge cases in the inference and grouping formulas, and one stylistic violation of the plain-English standard.

---

## Prioritized Findings

### Issue 1: Missing Normalization in Composer Uniformity Check - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Lines 223–235 (Subsystem 2.1)
* **Discrepancy Description:** In `inferReleaseAuthority`, Signal 3 checks if `uniqueComposers.size === 1`. In real-world audio collections, physical CD rips often have slight typographical or spacing variances across tracks (e.g., `"Ilaiyaraaja"` on tracks 1–3 and `"Ilayaraja"` or `"Ilaiyaraja"` on tracks 4–6). Raw string equality will calculate `uniqueComposers.size = 2`, causing Signal 3 to award 0 points despite being the identical composer.
* **Rationale & Recommendation:** Apply `normalizeArtistForGrouping` or a phonetic alias resolver (e.g., stripping dots, spaces, and normalizing vowels) to composer strings before populating the `uniqueComposers` set.

### Issue 2: Zero-Duration Guard in Fuzzy Grouping Guard - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Lines 280–283, 388–390
* **Discrepancy Description:** The invariant `|durationA - durationB| / max(durationA, durationB) <= 0.05` produces `0 / 0 = NaN` if either release contains tracks whose durations have not yet been extracted (total duration = 0). A `NaN` result causes the comparison to evaluate to `false`, silently breaking variant stacking for unmeasured or corrupted audio files.
* **Rationale & Recommendation:** Add an explicit fallback guard: `max(durationA, durationB) > 0 ? (|durationA - durationB| / max(durationA, durationB) <= 0.05) : true`.

### Issue 3: Plain-English Style Violation ("seamless") - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Line 368 (Alternative 1)
* **Discrepancy Description:** Line 368 uses the prohibited promotional adjective `"seamless"`: *"gives a seamless experience without cognitive fragmentation"*. The EGM plain-English standard strictly bans ungrounded buzzwords and promotional adjectives (*seamless*, *robust*, *blazingly fast*).
* **Rationale & Recommendation:** Replace `"gives a seamless experience"` with `"provides single-surface continuity"`.
