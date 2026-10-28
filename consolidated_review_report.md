# Consolidated Goldfish Review Report

* **Target Document**: `docs/designs/FEDERATED_ALBUM_AND_ARTIST_METADATA_RECOMMENDATION_ENGINE.md`
* **Date**: 2026-10-28
* **Review Pipeline**: Full Flow (Stages 5, 6, 7, 8, 9)
* **Audited Ranges**:
  - `FeatureRange`: Lines 1–284
  - `DetailedRange`: Lines 285–436
* **Status**: **PASS (All 10 Action Items Remediated & Verified)**

---

## 1. Executive Summary & Review Verdict

The design document for the **Federated Album & Artist Metadata Recommendation Engine** provides a comprehensive, bit-perfect audiophile curation architecture. It resolves long-standing metadata starvation by introducing release-group queries, garbage disqualification, earliest release year protection, virtual album splitting, and background prefetching.

All **1 Blocker**, **6 Major findings**, and **3 Nits** identified during the EGM Goldfish review have been completely remediated directly in [`docs/designs/FEDERATED_ALBUM_AND_ARTIST_METADATA_RECOMMENDATION_ENGINE.md`](file:///e:/Mathan/Code/Music%20Agent/docs/designs/FEDERATED_ALBUM_AND_ARTIST_METADATA_RECOMMENDATION_ENGINE.md), incorporating specific runtime constraints (WebView2 User-Agent proxy routing, cold-boot cooldown initialization, serde camelCase deserialization, and HTTP-dispatch-anchored timeouts). The document satisfies all EGM qualitative rubrics and is ready for implementation.

---

## 2. Traceability Matrix

| Raw Finding ID | Stage / Persona | Severity | Consolidated Action Item |
| :--- | :--- | :--- | :--- |
| **C7-1** | Stage 7 (`egm-design`) | 🔴 Blocker | **ACT-1: MusicBrainz Queue Preemption & Cancellation** |
| **C6-1** | Stage 6 (`egm-comprehension`) | 🟡 Major | **ACT-2: Explicit `AlbumSignature` Contract** |
| **C7-2** | Stage 7 (`egm-design`) | 🟡 Major | **ACT-3: API User-Agent Policy Compliance** |
| **C6-2** | Stage 6 (`egm-comprehension`) | 🟡 Major | **ACT-4: Wikipedia Search Fallback Endpoint** |
| **C6-3** | Stage 6 (`egm-comprehension`) | 🟡 Major | **ACT-5: Local Tracking of `lastPlaybackStoppedTime`** |
| **C7-3** | Stage 7 (`egm-design`) | 🟡 Major | **ACT-6: Gemini Token Ceiling Expansion for Compilations** |
| **C7-4** | Stage 7 (`egm-design`) | 🟡 Major | **ACT-7: Offline 4-Second Timeout & Degradation Path** |
| **C9-1** | Stage 9 (`egm-implementation`) | 🟡 Major | **ACT-8: Exact Tauri IPC Payload Struct Declaration** |
| **C5-1** | Stage 5 (`egm-zoom-out`) | 🟢 Nit | **ACT-9: Prefetch Cache Clarification (In-Memory Only)** |
| **C6-4** | Stage 6 (`egm-comprehension`) | 🟢 Nit | **ACT-10: Strip Obsolete "Option B" Brainstorming References** |

---

## 3. Consolidated Action Items & Technical Guidance

### 🔴 Blocker

#### ACT-1: MusicBrainz Queue Preemption & Task Cancellation
* **Scope**: Component 2 (Lines 137–150), Component 4 (Lines 182–193), Manifest File 7 (Line 335), Manifest File 8 (Line 358)
* **Finding**: In `GlobalMusicBrainzQueue`, background prefetch requests for Albums $N+1$ and $N+2$ are placed in the same FIFO queue as active album requests. If a user rapidly navigates past multiple albums (`⌘↵`), active requests sit behind backlog prefetch tasks, locking the UI in 1.05-second intervals.
* **Resolution**:
  1. Add priority preemption to `GlobalMusicBrainzQueue`: `enqueueActive(fn)` places active user requests at the front of the queue immediately following any in-flight HTTP request.
  2. Add task cancellation: When navigating to a new album, `curationQueueService` invokes `cancelPendingPrefetch()` via an `AbortController` to purge stale background prefetch tasks.

---

### 🟡 Major Findings

#### ACT-2: Explicit `AlbumSignature` Contract
* **Scope**: Component 2 (Line 139), Manifest File 2 (Line 300), Manifest File 7 (Line 336)
* **Finding**: `AlbumSignature` is passed to `fetchItunesAlbumCandidate` and `fetchMusicBrainzReleaseCandidate` but not defined.
* **Resolution**: Define `AlbumSignature` explicitly in `src/core/types.ts`:
  ```typescript
  export interface AlbumSignature {
    sanitizedTitle: string;
    sanitizedArtist: string;
    trackCount: number;
    totalDurationSecs?: number;
    firstTrackTitle?: string;
  }
  ```

#### ACT-3: API User-Agent Policy Compliance
* **Scope**: Component 2 (Line 137), Component 6 (Line 222), Manifest File 7 (Line 332)
* **Finding**: MusicBrainz and Wikimedia APIs reject or throttle requests without a customized `User-Agent`.
* **Resolution**: Specify that all external HTTP requests send:
  `User-Agent: Cadence/1.0.0 ( contact@cadence.audio; https://github.com/matbhuvi-tech/Cadence )`

#### ACT-4: Wikipedia Search Fallback Endpoint
* **Scope**: Component 6 (Lines 228–230), Manifest File 7 (Line 346)
* **Finding**: The summary endpoint `/api/rest_v1/page/summary/{title}` does not support query searches when Wikidata Q-IDs are absent.
* **Resolution**: Specify the exact two-step fallback endpoint:
  1. Search: `https://en.wikipedia.org/w/rest.php/v1/search/page?q={query}&limit=1` to extract article title.
  2. Summary: `https://en.wikipedia.org/api/rest_v1/page/summary/{resolvedTitle}`.

#### ACT-5: Local Tracking of `lastPlaybackStoppedTime`
* **Scope**: Component 4 (Line 190), Manifest File 8 (Line 357)
* **Finding**: The 30s cooldown logic evaluates `lastPlaybackStoppedTime` without explaining where it is tracked.
* **Resolution**: Specify that `curationQueueService` subscribes to `tauriBridge.onPlaybackStateChanged` and updates `lastPlaybackStoppedTime = Date.now()` whenever `playbackState` transitions to `Stopped`.

#### ACT-6: Gemini Token Ceiling Expansion for Compilations
* **Scope**: Component 5 (Line 185), Manifest File 7 (Line 340)
* **Finding**: An estimated "~400 tokens" for Gemini synthesis will truncate responses on 30+ track compilation pressings.
* **Resolution**: Configure `maxOutputTokens: 2048` on the Gemini AI invocation call.

#### ACT-7: Offline 4-Second Timeout & Degradation Path
* **Scope**: Component 3 (Line 164), Manifest File 7 (Line 340)
* **Finding**: Missing timeout behavior on lost internet connection.
* **Resolution**: Apply a 4000ms timeout per external HTTP request. If external calls fail or time out, resolve to `source: 'local_default'` with confidence `0.50` and visual badge `[Local Fallback]`.

#### ACT-8: Exact Tauri IPC Payload Struct Declaration
* **Scope**: Component 6 (Line 260), Manifest File 3 (Line 330), Manifest File 4 (Line 340)
* **Finding**: Ambiguous deserialization struct for `db_update_canonical_artist_editorial`.
* **Resolution**: Declare the exact serde payload struct in `src-tauri/src/db/operations.rs` and `commands/library.rs` with camelCase renaming:
  ```rust
  #[derive(serde::Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct UpdateArtistEditorialPayload {
      pub bio_summary: Option<String>,
      pub era_active: Option<String>,
      pub primary_role: Option<String>,
      pub mbid: Option<String>,
      pub apple_artist_id: Option<String>,
      pub portrait_url: Option<String>,
  }
  ```

---

### 🟢 Nits

#### ACT-9: Prefetch Cache Clarification (In-Memory Only)
* **Scope**: Mermaid Diagram (Line 80)
* **Resolution**: Rename `L1Cache[In-Memory / SQLite Cache]` to `L1Cache[In-Memory LRU Cache]` to clarify that prefetch queries do not perform disk I/O.

#### ACT-10: Strip Obsolete "Option B" Brainstorming References
* **Scope**: CUJ 2 (Line 51), Component 5 (Line 197), Manifest File 10 (Line 372)
* **Resolution**: Replace `"Virtual Split in Queue (Option B Architecture)"` with `"Virtual Split in Queue"`.
