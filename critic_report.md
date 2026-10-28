# Stage 7 Review Report: Critic Review

**Target**: `docs/designs/FEDERATED_ALBUM_AND_ARTIST_METADATA_RECOMMENDATION_ENGINE.md` (FeatureRange: Lines 1–284)  
**Evaluators**: `egm-design`, `egm-structural`, `egm-style`  
**Standard**: `resources/document_standards/feature-spec-standard.md`  
**Status**: Passed with Actionable Critiques

---

## Technical & Architecture Critique

The architecture elegantly solves the core requirements: 2-of-3 consensus, original release year preservation, audiophile quietness guards, and rich SQLite profile hydration. However, stress-testing the architecture against high concurrency, external API terms of service, and edge-case token limits reveals several unmitigated risks.

---

## Findings

### Finding 1: MusicBrainz Queue Starvation / Lack of Preemption for Active Navigation
* **Severity**: 🔴 Blocker
* **Affected Scope**: Component 2 (Lines 137–139) & Component 4 (Lines 187–193)
* **Risk & Critique**:
  Component 2 mandates an application-wide singleton FIFO queue enforcing $\ge 1050\text{ms}$ between all outbound MusicBrainz requests. Component 4 enqueues prefetch tasks for Albums $N+1$ and $N+2$.
  If the user skips ahead 3 albums rapidly in the UI (`⌘↵`, `⌘↵`, `⌘↵`), the active album's lookup task will be placed at the tail of the FIFO queue behind 4–6 already enqueued prefetch tasks. The user will experience a multi-second UI freeze waiting for outdated background tasks to drain at 1.05s intervals.
* **Mitigation Recommendation**:
  1. The `GlobalMusicBrainzQueue` must support **Priority Preemption**: Active user-facing lookups must take priority over background prefetch tasks.
  2. Implement task cancellation (`AbortController`): When the user navigates away from Album $N$, any pending prefetch tasks for $N+1$ or $N+2$ that have not yet sent their network request must be purged from the queue.

### Finding 2: Wikipedia & MusicBrainz API User-Agent Policy Violation
* **Severity**: 🟡 Major
* **Affected Scope**: Component 2 (Line 137) & Component 6 (Lines 226–232)
* **Risk & Critique**:
  Both the MusicBrainz API and the Wikimedia REST API strictly enforce a custom `User-Agent` header containing application identification and contact details (e.g., `Cadence/1.0.0 ( contact@cadence.audio )`). Default browser `fetch()` headers or generic client headers are automatically throttled or blocked with HTTP 403 Forbidden by Wikimedia Cloud Services and MusicBrainz rate limiters.
* **Mitigation Recommendation**:
  Explicitly specify in Component 2 and Component 6 that all outbound HTTP calls to MusicBrainz and Wikimedia APIs include an explicit compliant `User-Agent` header configured in the service layer or native HTTP client.

### Finding 3: Gemini Token Budget Underestimation for Anthologies
* **Severity**: 🟡 Major
* **Affected Scope**: Problem Statement 3 (Line 23) & Component 5 (Lines 185–201)
* **Risk & Critique**:
  Component 5 states that Gemini resolves album and per-track credits in a single prompt of "~400 tokens". While ~400 tokens may suffice for an 8-track pop album, Problem Statement 3 explicitly calls out 30+ track custom anthologies (e.g., *"A World Of Music"*). Generating structured JSON containing canonical title, composer, year, and per-track titles, playback singers, and film soundtracks across 30 tracks requires 1200–1800 completion tokens. A 400-token cap would truncate the response, resulting in a JSON parse failure.
* **Mitigation Recommendation**:
  Update Component 5 to specify a dynamic response token ceiling (`maxOutputTokens: 2048`) to accommodate full-tracklist box sets and anthologies without JSON truncation.

### Finding 4: Offline & Network Timeout Degradation Path
* **Severity**: 🟡 Major
* **Affected Scope**: Component 3 (Lines 164–170)
* **Risk & Critique**:
  The document does not detail what happens when the user has no internet connection or when an external API times out. If external calls hang indefinitely, the reconciliation stage will stall.
* **Mitigation Recommendation**:
  Define a strict 4-second timeout on external provider calls. When external providers fail or the system is offline, the consensus engine must cleanly fall back to local file tags, set confidence to `0.50`, and render the `[Local Fallback]` neutral badge.
