# Stage 8: Intermediate Zoom Out Report (`intermediate_zoom_out_report.md`)

* **Target:** [`docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/CURATE_EXPERIENCE_AND_LAYOUT_OVERHAUL.md) (`1..325`)
* **Reviewer Lens:** `egm-zoom-out`

## 1. Findings

### [IZO-01] 🔴 Blocker: Top `Stage & Next (⌘↵)` Disabled State & Closure Dependencies Across Case A and Case B
* **Location:** `Technical Plan §3` (lines 173–189), `Detailed Implementation Plan §1.5` (lines 258–266), [`CurationReconciliationStage.tsx:761-775`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L761-L775), [`CurationReconciliationStage.tsx:874`](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L874)
* **Observation:**
  1. The top `✓ Stage & Next →` button has `disabled={selectedTrackIds.size === 0}`. When `renderTrackTable` is unified across Case A and Case B, `buildClusterTrackEdits` must filter by `selectedTrackIds.has(trk.id)` so unchecking a track in a compilation cluster excludes it consistently.
  2. The `⌘↵` `keydown` `useEffect` ([line 761](file:///e:/Mathan/Code/Music%20Agent/src/components/Curate/CurationReconciliationStage.tsx#L761)) must include `handleStageAllClusters` and `handleStageCaseA` in its dependencies so keyboard staging never fires with stale `selectedFields`, `trackTitles`, or `trackArtists` closures.
* **Recommendation:**
  Filter `buildClusterTrackEdits` by `selectedTrackIds.has(trk.id)` and include `handleStageAllClusters` in the `⌘↵` `useEffect` dependency array.
