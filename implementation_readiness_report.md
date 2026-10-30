# Stage 9: Implementation Readiness Report (`implementation_readiness_report.md`)

* **Target:** [`docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md) (`DetailedRange: 228..325`)
* **Reviewer Lenses:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`

## 1. Findings

### [IR-01] 🟡 Major: `handleStageCaseA` Album Title Comparison & `handleStripRipFlags` Track Title Cleaning
* **Location:** `Detailed Implementation Plan §1.5` (lines 258–266), [`CurationReconciliationStage.tsx:120-128`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L120-L128), [`CurationReconciliationStage.tsx:622-660`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L622-L660)
* **Observation:**
  1. In `handleStageCaseA` ([line 622](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L622)), `if (selectedFields.title && selectedFields.title !== release?.title)` only compares `selectedFields.title` against `release?.title`. When `release.title` was already inferred cleanly from a folder name or consensus but `trk.album` / `albumItem.albumTitle` has `"Anbin Mugavari CD RIP"`, `edits.album` is skipped! Comparing `selectedFields.title.trim()` against `(trk.album || trk.albumTitle || release?.title || albumItem.albumTitle)` guarantees defective track album tags are staged.
  2. In `handleStripRipFlags` ([lines 120–128](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L120-L128)), clicking `Strip Rip Flags` in the Unified Control Bar currently only strips rip noise from the album title, leaving `[CD RIP]` / `(From "...")` flags on individual `trackTitles`. Updating `handleStripRipFlags` to also run `cleanRipNoise` across `trackTitles` makes the button clean both album and track titles in one click.
* **Recommendation:**
  Specify in `Detailed Implementation Plan §1` that `handleStageCaseA` compares `selectedFields.title` against `trk.album || trk.albumTitle || release?.title || albumItem.albumTitle`, and that `handleStripRipFlags` also cleans `trackTitles`.
