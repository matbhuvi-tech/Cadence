# Consolidated Multi-Stage Goldfish Review Report (`Stages 5–9`)

* **Target Document:** [`docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md) (`1..325`)
* **Feature Range:** `1..227`
* **Detailed Range:** `228..325`
* **Stage Reports Generated:**
  * Stage 5 (Initial Zoom Out): [`zoom_out_report.md`](file:///e:/Mathan/Code/Music%20Agent/zoom_out_report.md)
  * Stage 6 (Comprehension Test): [`comprehension_report.md`](file:///e:/Mathan/Code/Music%20Agent/comprehension_report.md)
  * Stage 7 (Critic Review): [`critic_report.md`](file:///e:/Mathan/Code/Music%20Agent/critic_report.md)
  * Stage 8 (Intermediate Zoom Out): [`intermediate_zoom_out_report.md`](file:///e:/Mathan/Code/Music%20Agent/intermediate_zoom_out_report.md)
  * Stage 9 (Implementation Readiness): [`implementation_readiness_report.md`](file:///e:/Mathan/Code/Music%20Agent/implementation_readiness_report.md)

---

## 1. Consolidated Action Items by Priority

### 🔴 Blockers (2)

1. **[F-01] Fix Clipped `Staged` Filter Pill in `CurationQueueRail.tsx` & Broken `<img alt="Local">` Image Fallback (Originated in Stage 5 [`ZO-01`]):**
   * **Evidence from `media_1793350151559_4f517bd9.png`:**
     * Inside the `280px` left rail ([`CurationQueueRail.tsx:108-129`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationQueueRail.tsx#L108-L129)), the 4 filter pills (`All (280)`, `Soundtracks (41)`, `Artwork (22)`, `Staged (...)`) overflow horizontally and clip `"Sta..."` at the right edge.
     * When `coverArtUrl` is a non-empty string that fails to load at runtime, `<img src={albumItem.coverArtUrl} alt="Local" />` ([`CurationReconciliationStage.tsx:1023`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1023)) and `<img src={item.coverArtUrl} alt={item.albumTitle} />` ([`CurationQueueRail.tsx:159`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationQueueRail.tsx#L159)) render Chromium's broken-image icon and raw alt text instead of falling back to the `<Disc />` vector icon.
   * **Action Required:**
     * Update `CurationQueueRail.tsx` filter pills to `flex-wrap gap-1` (or compact `px-2 py-0.5 text-[10px]` labels) so all 4 filter tabs fit cleanly inside `280px` without horizontal clipping.
     * Add `onError` broken-image state tracking (`failedArtUrls` / `localArtError`) in both `CurationQueueRail.tsx` and `CurationReconciliationStage.tsx` so failed cover art URLs fall back cleanly to `<Disc />`.

2. **[F-02] Remove Nested `max-h-64` Scrollbar from Track Table & Synchronize `selectedTrackIds` / `⌘↵` Closure Across Case A and Case B (Originated in Stage 6 [`COMP-01`] & Stage 8 [`IZO-01`]):**
   * **Issue:** [`CurationReconciliationStage.tsx:1580`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1580) currently restricts the track list to `max-h-64 overflow-y-auto` (`256px`), creating a nested scrollbar inside the stage. Additionally, the top `Stage & Next` button is gated on `disabled={selectedTrackIds.size === 0}`, and the `⌘↵` `useEffect` ([line 774](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L774)) must include `handleStageAllClusters`.
   * **Action Required:**
     * Explicitly remove `max-h-64 overflow-y-auto` so the unified track table expands naturally within the main `pb-24` stage scroll container.
     * Support `selectedTrackIds` row checkboxes across both Case A and Case B in `renderTrackTable` (filtering `buildClusterTrackEdits` by `selectedTrackIds.has(trk.id)`), and include `handleStageAllClusters` in the `⌘↵` `useEffect` dependency array.

---

### 🟡 Majors (4)

3. **[F-03] Artwork Inspector 2x2 Grid Loading/Empty State Col-Span Mismatch (Originated in Stage 7 [`CRIT-01`]):**
   * **Issue:** In [`CurationReconciliationStage.tsx:1079-1084`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1079-L1084), the loading and empty-state divs use `col-span-2 sm:col-span-3`, which forces an implicit 3rd column inside the new `grid-cols-2` Artwork Inspector grid.
   * **Action Required:** Change `col-span-2 sm:col-span-3` to `col-span-1` (sitting in the cell beside `Local File`) with compact padding.

4. **[F-04] Bulk "Reset All Tracks" Header Button Parity (Originated in Stage 7 [`CRIT-02`]):**
   * **Issue:** The track list header's `Reset Track Artists` button ([line 1559](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1559)) only resets `trackArtists`.
   * **Action Required:** Update the header button to `Reset All Tracks` so it resets both `trackTitles` and `trackArtists` across all tracks.

5. **[F-05] `handleStageCaseA` Album Title Comparison & `handleStripRipFlags` Track Title Cleaning (Originated in Stage 9 [`IR-01`]):**
   * **Issue:** `handleStageCaseA` ([line 622](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L622)) only checks `selectedFields.title !== release?.title`, missing cases where `albumItem.albumTitle` or `trk.albumTitle` still holds `"Anbin Mugavari CD RIP"`. Similarly, `handleStripRipFlags` ([line 120](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L120)) only cleans the album title and not `trackTitles`.
   * **Action Required:** Compare `selectedFields.title.trim()` against `(trk.albumTitle || release?.title || albumItem.albumTitle)` in `handleStageCaseA`, and update `handleStripRipFlags` to also strip rip flags from `trackTitles`.

---

### 🟢 Nits (2)

6. **[F-06] Uniform 2-Line Field Cells in Column 1 & Input `title` Tooltips (Originated in Stage 7 [`CRIT-03`]):**
   * **Issue:** Row 2 (`Album Artist`) in Column 1 has a redundant `ALBUMARTIST` subtitle ([line 1293](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1293)), and `<input>` elements lack `title={value}` hover tooltips.
   * **Action Required:** Remove the redundant `ALBUMARTIST` subtitle in Row 2 so all 4 rows in Column 1 stack `Field Name` + `Provenance Badge` uniformly, and bind `title` on all text `<input>` elements.

---

## 2. Traceability Matrix

| Consolidated ID | Raw Stage Finding ID | Stage | Reviewer Lens | Severity | Target File / Section | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **F-01** | `ZO-01` | Stage 5 | `egm-zoom-out` | 🔴 Blocker | `CurationQueueRail.tsx`, `CurationReconciliationStage.tsx` | Open |
| **F-02** | `COMP-01`, `IZO-01` | Stage 6 & 8 | `egm-comprehension`, `egm-zoom-out` | 🔴 Blocker | `CurationReconciliationStage.tsx` (`max-h-64`, `selectedTrackIds`, `⌘↵`) | Open |
| **F-03** | `CRIT-01` | Stage 7 | `egm-design` | 🟡 Major | `CurationReconciliationStage.tsx` (Artwork Inspector `col-span-1`) | Open |
| **F-04** | `CRIT-02` | Stage 7 | `egm-design` | 🟡 Major | `CurationReconciliationStage.tsx` (`Reset All Tracks`) | Open |
| **F-05** | `IR-01` | Stage 9 | `egm-codebase-details`, `egm-implementation-readiness` | 🟡 Major | `CurationReconciliationStage.tsx` (`handleStageCaseA`, `handleStripRipFlags`) | Open |
| **F-06** | `CRIT-03` | Stage 7 | `egm-design`, `egm-style` | 🟢 Nit | `CurationReconciliationStage.tsx` (Column 1 subtitle & `<input title>`) | Open |
