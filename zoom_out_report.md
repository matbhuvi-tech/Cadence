# Stage 5: Initial Zoom Out Review Report (`zoom_out_report.md`)

* **Target:** [`docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md) (`1..325`)
* **Reviewer Lens:** `egm-zoom-out` (High-Altitude Simplicity, Root-Cause Alignment & Codebase Reuse)

## 1. Executive Summary
The design directly solves the root layout and state-machine defects of the Curate workbench: replacing the vertically stacked top section with a 33%/67% split deck (`xl:col-span-4` / `xl:col-span-8`), unifying the track list into a single-column editable table (`48px | 42% | 44% | 112px`), separating `hasCompilationSignals` from `isCaseB = hasCompilationSignals && compilationClusters.length > 1`, and adding `pb-24` clearance plus `NowPlayingBar` idle auto-hide.

However, cross-referencing the design against the uploaded full-screen Curate screenshot (`media_1793350151559_4f517bd9.png`) exposes **1 Blocker** where two visual defects visible in the screenshot were omitted from the design scope.

## 2. Findings

### [ZO-01] 🔴 Blocker: Unaddressed Visual Defects from Full-Screen Curate Screenshot (`CurationQueueRail` Clipped `Staged` Pill & Broken `<img alt="Local">` Fallback)
* **Location:** `The Problem` (lines 15–24), `Technical Plan §1 & §4`, [`CurationQueueRail.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationQueueRail.tsx#L108-L169), [`CurationReconciliationStage.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1021-L1044)
* **Observation:**
  In `media_1793350151559_4f517bd9.png` (`Anbin Mugavari CD RIP`):
  1. In [`CurationQueueRail.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationQueueRail.tsx#L108-L129), the 4 filter tabs (`All (280)`, `Soundtracks (41)`, `Artwork (22)`, `Staged (...)`) overflow the `256px` inner width of the `280px` rail, clipping the 4th tab to `"Sta"` at the right edge with no scrollbar.
  2. When `albumItem.coverArtUrl` is a non-empty string whose image fails to load at runtime, `<img src={albumItem.coverArtUrl} alt="Local" />` in [`CurationReconciliationStage.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L1023) and `<img src={item.coverArtUrl} alt={item.albumTitle} />` in [`CurationQueueRail.tsx`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationQueueRail.tsx#L159) display broken-image icons and raw alt text instead of falling back to the `<Disc />` vector placeholder.
* **Recommendation:**
  Include `CurationQueueRail` filter pill fitting (`flex-wrap` or compact `grid-cols-4` pills) and `onError` broken-image fallback state in both `CurationQueueRail.tsx` and `CurationReconciliationStage.tsx`.
