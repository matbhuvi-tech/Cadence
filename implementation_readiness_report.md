# Stage 9 Review Report: Implementation Readiness Test

**Target**: `docs/designs/FEDERATED_ALBUM_AND_ARTIST_METADATA_RECOMMENDATION_ENGINE.md` (DetailedRange: Lines 285–436)  
**Evaluators**: `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`  
**Standard**: `resources/document_standards/implementation-readiness-standard.md`  
**Status**: Passed with Actionable Fixes

---

## Pragmatic Tech Lead & Codebase Evaluation

The implementation plan is comprehensive, clearly mapping 16 files across the native Tauri/Rust backend, core taxonomy utilities, federated resolvers, curation prefetchers, and UI components. All file paths have been verified to exist in the repository or are explicitly marked for creation.

To pass the Zero-Decision Rule completely, several minor gaps must be closed before an engineer can write the code without ambiguity.

---

## Findings

### Finding 1: Explicit Method Signature for Native Command Dispatch
* **Severity**: 🟡 Major
* **Affected Scope**: Manifest File 4 (Line 317) & File 6 (Line 329)
* **Rationale**: File 4 specifies `db_update_canonical_artist_editorial`, but does not declare the exact JSON argument struct shape passed from Tauri IPC. If the Rust struct uses `camelCase` rename attributes or `snake_case`, IPC serialization will fail if not aligned.
* **Recommendation**: Declare the exact argument payload in File 4 and File 6:
  ```rust
  #[derive(serde::Deserialize)]
  pub struct UpdateArtistEditorialPayload {
      pub artist_id: String,
      pub bio_summary: Option<String>,
      pub era_active: Option<String>,
      pub primary_role: Option<String>,
      pub mbid: Option<String>,
      pub apple_artist_id: Option<String>,
      pub portrait_url: Option<String>,
  }
  ```

### Finding 2: `GlobalMusicBrainzQueue` Interface & Abort Semantics
* **Severity**: 🟡 Major
* **Affected Scope**: Manifest File 7 (Line 335)
* **Rationale**: In line with Critic Finding 1, File 7 must specify how `GlobalMusicBrainzQueue` prioritizes requests and purges obsolete tasks:
  - `enqueueActive<T>(fn: () => Promise<T>): Promise<T>` (preempts prefetch tasks, placing itself at the head of pending items).
  - `enqueuePrefetch<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>` (placed at tail, dropped if aborted).
  - `clearPrefetchTasks(): void` (cancels all unexecuted prefetch tasks when user steps to a new album).
* **Recommendation**: Include the queue method contract in File 7 of the implementation plan.

### Finding 3: Exact Unit Test Assertions for Earliest Release Year Carve-Out
* **Severity**: 🟢 Nit
* **Affected Scope**: Manifest File 12 (`src/test/testFederatedConsensus.ts`, Lines 384–393)
* **Rationale**: File 12 lists unit tests, but does not provide the concrete test matrix for the earliest release year carve-out.
* **Recommendation**: Specify the test fixture:
  - Input: Local year `2015`, Apple year `2015`, MusicBrainz year `1990`.
  - Expected Output: `releaseYear = 1990`, `source = 'earliest_release_rule'`, confidence `0.95`.
  - Verifies that 2015 == 2015 majority does not outvote 1990.
