# Stage 7: Critic Review Report (`critic_report.md`)

* **Target:** [`docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md) (`FeatureRange: 1..227`)
* **Reviewer Lenses:** `egm-design`, `egm-structural`, `egm-style`

## 1. Findings

### [CRIT-01] 🟡 Major: Artwork Inspector 2x2 Grid Loading/Empty State Col-Span Mismatch (`col-span-2 sm:col-span-3` inside `grid-cols-2`)
* **Location:** `Technical Plan §1` (lines 112–115), [`CurationReconciliationStage.tsx:1000-1094`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1000-L1094)
* **Observation:**
  Changing the Artwork Inspector grid from `grid-cols-2 sm:grid-cols-4` to `grid-cols-2 gap-2.5` inside `xl:col-span-4` leaves the `isLoadingCandidates` and empty-candidate fallback divs at lines 1079 and 1084 with `col-span-2 sm:col-span-3`. In a 2-column CSS grid, `sm:col-span-3` forces an implicit 3rd column track, breaking the 2x2 geometry inside the 33% left pane.
* **Recommendation:**
  Specify changing the loading and empty-state divs inside the Artwork Inspector's `grid-cols-2` container from `col-span-2 sm:col-span-3` to `col-span-1` (occupying the cell adjacent to `Local File`).

### [CRIT-02] 🟡 Major: Bulk "Reset All Tracks" Header Action Parity
* **Location:** `Technical Plan §2` (lines 138–151), [`CurationReconciliationStage.tsx:1557-1570`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1557-L1570)
* **Observation:**
  The existing Case A header has a `Reset Track Artists` button that only resets `trackArtists`. Now that both `trackTitles` and `trackArtists` are inline-editable, the header button should be `Reset All Tracks` and reset both `trackTitles` and `trackArtists`.
* **Recommendation:**
  Update the header reset action to reset both `trackTitles` and `trackArtists` across all tracks.

### [CRIT-03] 🟢 Nit: Redundant `ALBUMARTIST` Subtitle in Row 2 of Column 1 (`Field`) & Input `title` Tooltips
* **Location:** `Technical Plan §1 & §2` (lines 124–150)
* **Observation:**
  Row 2 (`Album Artist`) in Column 1 currently has a secondary `ALBUMARTIST` subtitle ([line 1293](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1293)). Replacing that redundant subtitle with the relocated provenance badge keeps all 4 rows in Column 1 at an identical 2-line height (`Field Name` + `Provenance Pill`). Additionally, binding `title={value}` on `Staged Output`, `Track Title`, and `Track Vocalists` `<input>` elements ensures full-text hover inspection.
* **Recommendation:**
  Remove the `ALBUMARTIST` subtitle in Row 2 so all 4 rows in Column 1 stack `Field Name` + `Provenance Badge` uniformly, and add `title` tooltips to all `<input>` fields.
