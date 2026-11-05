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

## Issue #4: Curation Decision Trace Persistence, Spotify Direct Grounding, and Telemetry Links
- **ID:** #4
- **Title:** feat(curate): Curation decision trace feedback, Spotify direct embed parser, and diagnostic telemetry links
- **Description:**
  1. Steer provider fetches had up to 10 seconds of black-box latency without user progress indication.
  2. Navigating between albums in Curate lost the curation rationale and decision trace state because TypeScript model field names did not align with Serde Rust struct attributes.
  3. Pasting Spotify grounding URLs (e.g. `https://open.spotify.com/album/4q3WAYKvVyEYo4P5gOV10m`) failed to populate the AI Master column because standard SPA scraping was blocked without auth.
  4. MusicBrainz release links in the Diagnostic Telemetry table returned HTTP 400 because non-UUID title strings were being passed to `/release/<id>` endpoints.
- **Resolution:**
  - Added `SteerProgressBar` and slide-over `CurationDecisionTraceDrawer` with progressive disclosure.
  - Aligned Rust and TypeScript models (`headline_summary`, `field_traces`, `candidate_telemetry`, `duration_ms`) and enabled atomic SQLite UPSERT persistence with RAM buffering (`MEMORY_BUFFER`) during playback.
  - Implemented `resolveDirectSpotifyCandidate` to extract 100% ground-truth tracklists and artwork from Spotify embed `<script id="__NEXT_DATA__">` with 0 API quota.
  - Fixed provider link routing in `CurationDecisionTraceDrawer` using UUID validation and fallback search endpoints.
  - Updated master architecture specification in `docs/designs/CurateArchitecture.md`.
- **Status:** Verified and Fixed.


