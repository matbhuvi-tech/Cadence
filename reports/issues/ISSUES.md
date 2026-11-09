# Issue Log

## Issue #18 — Refactor Activity Center popover: remove obsolete jargon, contextualize Gemini AI, and refine scan trigger UX

- **Reproduction:** Add a new library mount or trigger a scan on a folder. The full 440px Activity Center popover immediately forces itself open over the UI. It displays developer-centric labels ("Lofty Tags", "SQLite FTS") across pipeline stages that don't match the modern streaming architecture, and it prominently renders a Gemini AI Cloud Pipeline bento even when Gemini is completely idle during local file ingestion, causing confusion about local audio privacy.
- **Resolution:**
  1. Do not aggressively force the full popover open when starting a library scan in `App.tsx`; instead, notify via toast and allow the user to view progress via the existing top bar `ActivityPill`.
  2. Modernize the stage pills in `ActivityCenterPopover` with user-centric, clean labels ("Discovery", "Tags & Metadata", "Database Index", "Audio & Art") that accurately map to scanner and maintenance states.
  3. Contextualize the Gemini AI section so it only displays when AI requests are active, cooling down, rate-limited, or when specifically monitoring AI operations, keeping local scans clean and focused.
- **Status:** Resolved and verified in commit `b19e1d5`. [GitHub issue #18](https://github.com/matbhuvi-tech/Cadence/issues/18)

## Issue #15 — Gemini API calls always return 429 when Google Search grounding quota is exhausted

- **Reproduction:** Open Curate and refresh/resolve an album using a Gemini API key whose Google Search Grounding (`google_search`) quota is 0 or exhausted while standard `generateContent` quota is healthy. Every call fails with `Gemini request failed (429)`.
- **Diagnosis:** `resolve_operation` in `src-tauri/src/commands/gemini_config.rs` sets `use_grounding = true` whenever `userSearchQuery` or `referenceUrl` is present. `generate` only attempted grounded requests (`tools: [{"google_search": {}}]`) across candidate models and never fell back to ungrounded JSON inference. Additionally, upstream `429` responses for `google_search` omit `QuotaFailure` details (`violations` is empty), so `record_block` did not record the project-level `grounding` cooldown.
- **Resolution:** Record `state.grounding` when a grounded request returns `429` without model/project-spend `QuotaFailure` violations, and iterate over `&[true, false]` in `generate` when `use_grounding` is requested so blocked or rate-limited grounding automatically falls back to ungrounded JSON inference (`responseMimeType: "application/json"`).
- **Status:** Pending user verification. [GitHub issue #15](https://github.com/matbhuvi-tech/Cadence/issues/15)

## Issue #14 — Saved Apple track candidates disappear after reopening Curate

- **Reproduction:** Refresh Apple evidence, save the draft, and reopen the album. Evidence History lists returned tracks while the Apple Music Track column is blank.
- **Resolution:** Display archived candidates using the saved track mappings. New evidence records Apple track IDs. Older records use a unique saved Apple track position within the recorded release. Conflicts are labelled for review, and archived rows are read-only.
- **Verification:** The restore regression passed with all 41 Curate checks and the production build. The affected album's saved evidence contains seven inferred and two conflicted mappings that can be restored. The evidence service had 96% line coverage. Live desktop verification remains pending.
- **Status:** Pending user verification. [GitHub issue #14](https://github.com/matbhuvi-tech/Cadence/issues/14)

## Issue #13 — Malformed WAV timestamps leave Curate commits waiting

- **Reproduction:** Queue Curate writes for WAV tracks with a malformed embedded date, then stop playback. The first three attempts report an invalid timestamp and later items stay pending.
- **Diagnosis:** The timestamp error occurs while Lofty reads the staged copy. The worker counts file-level tag errors toward mount isolation.
- **Resolution:** Repair supported malformed WAV date frames on the staged copy when the confirmed payload contains a replacement year. Verify the replacement before the atomic swap. Count storage connection and device availability errors toward mount isolation.
- **Verification:** The native WAV regression reproduced three tag failures leaving two items waiting. It now verifies the replacement dates, preserved artist credit, intact originals for files without replacement dates, and continued processing on the same mount. All 32 focused native checks passed. Rust line coverage and live desktop QA were unavailable.
- **Status:** Pending desktop verification. [GitHub issue #13](https://github.com/matbhuvi-tech/Cadence/issues/13)

## Gemini quota monitoring and model fallback

- **Reproduction:** Return a 429 from the preferred Gemini model, then submit another request. The previous implementation tried the same model again and the Activity Center only showed fixed local pacing.
- **Change:** Both backends now share quota cooldowns across requests, respect Google retry hints, and route to eligible Flash-Lite models. The Activity Center shows the in-flight or last successful model and any active cooldowns. Interactive Curate evidence can use two upstream attempts, while automatic provenance retains a one-attempt budget.
- **Verification:** The mocked provider budget test reproduced the reuse of a throttled model and now covers fallback, actual model telemetry, concurrent project throttling, and queued cancellation. Rust tests cover Pacific midnight across daylight saving, alias quota scope, and grounding quota isolation.
- **Status:** Pending desktop verification.

## Issue #12 — Missing Gemini errors and provenance details

- **Reproduction:** Refresh an album when Gemini fails. Evidence History includes Apple and MusicBrainz but omits the AI attempt and error.
- **Resolution:** Record Gemini attempts before the compilation resolver handles errors. Store measured timing, available HTTP status and model metadata, safe error text, and the returned track proposals. Evidence History expands successful AI results and selects the newly saved run after refresh.
- **Verification:** The failure regression first recorded zero attempts. Five focused cases now cover HTTP errors, native rejection strings, timeouts, network failures, cancellation, malformed/empty responses, and successful proposal details. Browser fixtures verified a visible 429 error and expandable successful results. The SQLite fixture verified that both failure details and successful proposals survive reopening the database.
- **Status:** Pending user verification. [GitHub issue #12](https://github.com/matbhuvi-tech/Cadence/issues/12)

## Issue #11 — Edit Metadata opens the wrong completed album

- **Reproduction:** Open a previously completed album in Listen and click **Edit Metadata** in its detail view. Curate can open another album from the queue.
- **Cause:** The detail action did not opt into reopening a completed review, so Curate excluded its target.
- **Resolution:** Reopen completed reviews in the shared metadata-edit handler, using the requested release ID and the existing mechanism for superseding prior commit rows.
- **Browser regression:** Serve `tests/fixtures/curate/edit-metadata-navigation.html` with Vite. Open Dil Se, return to Listen, then click **Edit Metadata**. Before the fix, Curate selected Delhi-6. After the fix, Selected Output showed Dil Se and its tracks.
- **Status:** Browser fixture verified. Desktop verification pending. [GitHub issue #11](https://github.com/matbhuvi-tech/Cadence/issues/11)

## Issue #10 — Curate refresh skips Apple track lookup

- **Reproduction:** Refresh evidence for an Apple match while the refresh allocates one Apple call. The saved result shows the album with zero tracks.
- **Resolution:** Use a 12-call budget for explicit refresh, reserve the Apple track lookup after a match, and make Apple rate-limit waits cancellable. Leaving the album cancels its refresh.
- **Status:** Pending desktop verification. [GitHub issue #10](https://github.com/matbhuvi-tech/Cadence/issues/10)

## Issue #9: Curate evaluation fails on the early identity schema
- **Reproduction:** Open an existing database created by an early Identity foundation build, select Sivaa, and refresh evidence. Identity lookup fails before provider retrieval.
- **Fix:** Migrate the missing identity column at startup while preserving existing identity rows. Show which step failed in the evaluation badge tooltip.
- **Status:** Verified by the user on 2026-11-06. [GitHub issue #9](https://github.com/matbhuvi-tech/Cadence/issues/9)

## Curate identity foundation
- **Scope:** Persist release edition, disc, local track lineage, source-group candidates, provider mappings, and independent revisions.
- **Status:** Implemented and user-verified on 2026-11-06. See the [Milestone A checkpoint](../../docs/designs/CurateArchitecture.md#milestone-a-implementation-checkpoint).

## Curate queue includes albums after a human commit
- **Expected:** A successfully committed album stays out of both Curate queues and the badge count. Explicit metadata edits in Listen reopen the selected review.
- **Status:** Implementation pending verification.

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


## GitHub #4: Curate badge remains unchanged after album commits

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/4
- **Reported:** Curate badge stays at 130 while albums are committed.
- **Cause:** Header adds legacy defect and audit counts instead of using the cockpit's remaining review queues.
- **Change:** Publish the combined Tier 1 and Tier 2 review count to the header, using the existing completed-commit reconciliation logic. Retain the last reported count when navigating away; before the first cockpit visit, retain the existing estimate.
- **Status:** Verified by the user. Frontend/PWA build, 15 curation tests (using tsconfig.app.json), and NSIS installer build passed on 2026-11-06.


## GitHub #5: Pending credits trigger a false local-metadata conflict

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/5
- **Cause:** Library loading overlaid pending artist, composer, and album-artist selections onto the catalog fields used as the Curate Local baseline.
- **Fix:** Load those three fields from the catalog and retain all proposals in `pendingSidecarEdits`. Draft comparison and genuine-change protection remain unchanged.
- **Regression coverage:** `src/test/testLibraryLocalMetadata.ts` exercises the actual library loader with mocked native reads, draft serialization/reopening, retained proposals, genuine credit changes, and missing local credits. No music-drive access is performed by these tests.
- **RED:** Before the fix, 3 of 6 new tests failed on pending-credit overlays.
- **GREEN:** All 23 tests across the new loader suite and existing draft/commit/outcome suites passed. `npm run build` passed, including PWA build and TypeScript checks; Vite reported chunk-size and mixed-import warnings.
- **Verification command:** `npx tsx --tsconfig tsconfig.app.json --test src/test/testLibraryLocalMetadata.ts src/test/testCurateDraft.ts src/test/testCurateCommit.ts src/test/testCurateCommitOutcomes.ts`
- **Desktop QA:** Existing Curate QA automation checks provider/selection oracles but does not recreate a saved draft across library reloads. The new loader/draft regression provides deterministic coverage; live desktop verification remains pending.
- **User check:** Restart the development app with this branch, open En Bommukutti Amavuku CD RIP, and confirm the false warning is gone while Selected retains the saved choices and Local shows catalog credits. Navigate away and reopen. No commit is needed for this check.
- **Limitations:** Drafts previously saved against overlaid values may legitimately require a one-time baseline review after the correction. No saved drafts or music tags are rewritten by this change.
- **CodeScene:** Unavailable; user explicitly approved proceeding without it.
- **Release verification:** Windows NSIS installer build passed on 2026-11-06. User authorized pushing to main after the verification handoff; no separate live-desktop test result was reported.
- **Status:** Ready for the user-authorized merge and push to main.

## GitHub #7: Broken artwork fallback in UnifiedCurateCockpit

- **Link:** https://github.com/matbhuvi-tech/Cadence/issues/7
- **Reported:** When an album has missing or broken artwork, the Curate rail hides the image with inline `display: none` without rendering an icon fallback, and detail table artwork cells render broken image placeholders.
- **Cause:** `UnifiedCurateCockpit` lacked dedicated broken-image error handling and icon fallback components; `onError` in the queue rail hid the image element entirely, and the detail table cells lacked `onError` handlers.
- **Fix:** Implement `CurateArtworkThumbnail` with graceful `<Disc />` fallback on missing or failed images, and integrate it into both the queue rail cards and all detail table artwork candidate cells (Local, Apple, MusicBrainz, AI, Selected).
- **Scope:** Frontend presentation only; no changes to disk I/O, network transport, or audio engine invariants.
- **RED:** Automated test suite `src/test/testCurateArtworkFallback.ts` failed initially on missing `CurateArtworkThumbnail` module (checkpoint before implementation).
- **GREEN:** All 28 tests across `testCurateArtworkFallback.ts`, `testLibraryLocalMetadata.ts`, `testCurateDraft.ts`, `testCurateCommit.ts`, and `testCurateCommitOutcomes.ts` passed.
- **Verification command:** `npx tsx --tsconfig tsconfig.app.json --test src/test/testCurateArtworkFallback.ts src/test/testLibraryLocalMetadata.ts src/test/testCurateDraft.ts src/test/testCurateCommit.ts src/test/testCurateCommitOutcomes.ts`
- **Build:** `npm run build` passed cleanly (including PWA build, TypeScript check `tsc -b`, and Vite production bundle). `npx oxlint` passed with 0 errors.
- **Status:** Verified and Fixed. Merged into main in e4afefa, NSIS installer build passed on 2026-11-06.
