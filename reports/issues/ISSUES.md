# Issue Log

## Issue #3: Missing File Name in Curate Local File Column
- **ID:** #3
- **Title:** fix(curate): display filename under local track artist and preserve filepath in consensus
- **Description:** In Curate -> Tier 2: Guided Reconciliation, the file name was missing under the local track name and local track artist in the `#Local File` column because `federatedResolvers.ts` dropped `filePath` from `trackStates`, causing the file name to disappear once consensus arrived. Additionally, the folder name was unnecessarily repeated even though it was already presented in the header.
- **Resolution:**
  - Added `fileName` to `TrackCandidateState` in `types.ts`.
  - Updated `federatedResolvers.ts` to propagate `filePath`, `fileName`, and format details in consensus results.
  - Implemented `mergeConsensusTrackStates` in `UnifiedCurateCockpit.tsx` to prevent consensus resolution from overwriting local file paths.
  - Rendered `effectiveFileName` with `FileText` icon under the local artist credit in the `#Local File` column.
- **Status:** Verified and Fixed.

