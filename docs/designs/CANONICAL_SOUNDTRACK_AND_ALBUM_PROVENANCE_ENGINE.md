# Technical Design Document: Canonical Soundtrack & Album Provenance Engine

* **Feature:** Canonical Soundtrack & Album Provenance Engine: URL Grounding, Refine Search Guidance, and Album-Identity Disambiguation
* **Author:** Mathan & Cadence Engineering Swarm
* **Date:** 2026-11-01
* **Status:** Finalized

---

## 1. Problem Statement

Cadence's current metadata resolution and soundtrack provenance pipeline produces erroneous provenance states under two common real-world conditions:

1. **False "Not in Library" Reports for Standalone Master Albums:**
   When analyzing releases such as *Paasa Mazhai*, the system passes the album to an LLM prompt that explicitly assumes the release is a compilation (*"Analyze the compilation or multi-film soundtrack album"*). Furthermore, string comparisons fail to recognize that titles like `Paasa Mazhai (Original Motion Picture Soundtrack) - EP` and `Paasa Mazhai` represent the same entity. Consequently:
   - `isSameAlbum` evaluates to `false`.
   - `isCompilationTrack` is marked `true`.
   - The engine flags tracks with `isCanonicalAlbumTrack = false`.
   - When searching the local library for the canonical album, the album is omitted or fails exact match, displaying a persistent chip: `"Original Soundtrack: Paasa Mazhai (Not in local library)"` even while the user is actively viewing that exact album.

2. **Ungrounded Hallucination of Unknown Entities:**
   When an album has missing or incomplete embedded metadata (e.g., *Ehtanai Konam* with "Unknown Artist" and track numbers starting from #5), the heuristic and LLM resolvers attempt to fill missing gaps without grounding. For example, the model fabricated "Deva" as the composer and "2004" as the release year with high confidence, which the system automatically accepted and staged.

3. **Premature SQLite Mutation Prior to User Curation:**
   The current resolution workflow writes proposed metadata directly to SQLite upon initial resolution, blurring the boundary between in-memory drafts and committed library truth.

---

## 2. Overview & Solution Concept

The **Canonical Soundtrack & Album Provenance Engine** establishes an evidence-based, deterministic pipeline for discerning whether an audio release is a standalone native master album or a multi-source compilation, and accurately links track provenance to local library masters or external references.

The engine introduces four architectural pillars:
1. **The Ground-Truth Evidence Waterfall:** Resolves provenance in strict priority: Explicit User Reference URL > User Refine Query > Local Container Tags > Grounded Search > Grounded AI > Fuzzy Text Search. Ungrounded guessing is strictly forbidden.
2. **Normalized Album Identity & Self-Referencing Invariant:** Releases are identified via canonical title normalization (stripping commercial packaging suffixes like `- EP`, `(Original Motion Picture Soundtrack)`, `[Remastered]`). An album is **strictly barred from being considered absent from the library when it is itself the canonical source**.
3. **Tri-State Provenance Model:** Explicit distinction between `NativeAlbum` (tracks belong to this release), `CompilationAlbum` (tracks aggregate across multiple original releases), and `ReferencedMasterAlbum` (local master album pointed to by a compilation track).
4. **Non-Destructive Staging & Review:** Proposed provenance changes remain in an isolated staging layer (`staged_album_provenance`) with clear confidence indicators (Grounded 🟢, Heuristic 🟡, Unresolved ⚪). Data is only committed to SQLite and physical file tags upon explicit user action.

---

## 3. Goals & Non-Goals

### Goals
- **Eliminate False Absence Badges:** Ensure standalone soundtrack albums never display "Not in local library" when their own tracks reference them.
- **Support User Reference URLs:** Enable users to supply Apple Music, MusicBrainz, or Wikipedia URLs in both the Refine Search Query bar and the Compilation Resolver to anchor metadata extraction to trusted ground truth.
- **Pass Refine Query to AI Resolver:** Ensure human adjustments in the Refine Search Query bar are injected as top-priority constraints into the Gemini resolution payload.
- **Prevent Ungrounded AI Hallucinations:** Modify prompts and parsing schemas so unknown composers, vocalists, or years return `null` and drop confidence below threshold rather than fabricating values.
- **Maintain Deterministic Evidence Precedence:** Ensure higher-tier evidence always supersedes lower-tier heuristics.
- **Strict Audiophile Purity:** Enforce zero disk I/O, zero network bursts, and isolated thread/memory execution during audio playback per workspace invariants.

### Non-Goals
- **Automatic Tag Writing:** The engine will not write tags to physical audio files without explicit user review and invocation of the two-phase commit process.
- **Heavy Headless Scraping:** The system will not bundle Chromium or headless browser dependencies; external URL handling will rely on direct API matching (Apple Music ID, MusicBrainz ID) and Gemini URL grounding capabilities.
- **Arbitrary Tag Reorganization:** The engine will not rename physical folders or restructure disk paths during provenance resolution.

---

## 4. Technical Plan

### 4.1 Architecture & Component Interaction

```mermaid
flowchart TD
    subgraph UI ["Cadence Frontend (React 19 / Curate)"]
        UserRefine["User 'Refine Search Query' Bar"]
        URLInput["Reference URL Input (Apple / MB / Web)"]
        ProvModal["Compilation Provenance Modal"]
        StagingDrawer["Two-Phase Staging Drawer"]
    end

    subgraph Service ["Core Frontend Services"]
        Canonicalizer["compilationCanonicalizerService.ts"]
        Normalizer["canonicalAlbumNormalizer (taxonomyUtils.ts)"]
        SQLiteLib["sqliteLibraryService.ts (Cross-Album Graph)"]
    end

    subgraph NativeBackend ["Tauri Native Backend (Rust)"]
        TauriIPC["commands::gemini_config.rs"]
        AppleDirect["Direct Apple Music API Lookup"]
        GeminiProxy["Gemini 3.8 / Grounding Client"]
        IdleGuard["Playback Idle Guard (!is_playing && 30s)"]
    end

    subgraph Storage ["Local Storage Layer"]
        SQLiteDB[("%APPDATA%/cadence.db")]
        SidecarJSON["Sidecar Staging Layer"]
    end

    URLInput -->|Tier 1 Link| Canonicalizer
    UserRefine -->|Tier 2 Query| Canonicalizer
    Canonicalizer --> Normalizer
    Canonicalizer -->|Check Idle & Dispatch| TauriIPC
    TauriIPC --> IdleGuard
    IdleGuard -->|Apple ID Detect| AppleDirect
    IdleGuard -->|URL & Context Grounding| GeminiProxy

    GeminiProxy -->|Neutral Schema JSON| Canonicalizer
    Canonicalizer -->|Candidate Verification| SQLiteLib
    SQLiteLib -->|Self-Referencing Check| Normalizer
    Canonicalizer -->|Stage Only (No SQLite Write)| StagingDrawer
    StagingDrawer -->|User Approved Commit| SQLiteDB
    StagingDrawer -->|User Approved Commit| SidecarJSON
```

### 4.2 The Canonical Title Normalizer (`canonicalAlbumNormalizer`)

To satisfy the self-referencing invariant and eliminate discrepancies like `Paasa Mazhai (Original Motion Picture Soundtrack) - EP` vs. `Paasa Mazhai`, we introduce `normalizeCanonicalAlbumTitle(title: string)` in `src/core/taxonomyUtils.ts`:

1. Apply existing `stripRipNoiseAndTags(title)` (removes `[FLAC]`, `CD RIP`, etc.).
2. Strip soundtrack and edition markers:
   - `\s*\((?:original\s+motion\s+picture\s+soundtrack|original\s+soundtrack|ost|motion\s+picture\s+soundtrack)\)`
   - `\s*-\s*(?:ep|single|lp|deluxe(?:\s+edition)?|remastered|expanded(?:\s+edition)?|bonus\s+track\s+version)`
   - `\s*\[(?:ep|deluxe|remastered|special\s+edition)\]`
3. Normalize unicode quotes, hyphens, and multi-whitespace to single lowercase trimmed tokens.

**Matching Invariant:**
```typescript
export function isSameCanonicalAlbum(titleA: string, titleB: string): boolean {
  if (!titleA || !titleB) return false;
  return normalizeCanonicalAlbumTitle(titleA) === normalizeCanonicalAlbumTitle(titleB);
}
```

### 4.3 Neutral AI Resolution Schema & Prompting

In `src-tauri/src/commands/gemini_config.rs`:

1. **Payload Augmentation:**
   Pass optional `referenceUrl: Option<String>` and `refineQuery: Option<UserRefineQuery>`.
2. **Neutral System Framing:**
   Replace the biased assertion (*"Analyze the compilation or multi-film soundtrack album"*) with:
   > *"You are an authoritative archival discographer and musicologist. Analyze the provided audio release and objectively determine if it is: (A) A native standalone soundtrack / studio album, or (B) A multi-film compilation containing songs from different debut releases. Ground your answers strictly on discographical history, provided reference URLs, or user search parameters. Do not invent names, composers, or release years. If unknown or unverified, return null."*
3. **Structured Response Output:**
   Enforce schema requiring:
   - `albumVerdict`: `"native" | "compilation"`
   - `canonicalAlbumTitle`: clean canonical name
   - `canonicalComposer`: string or `null`
   - `releaseYear`: integer or `null`
   - `tracks`: array of `{ id, trackNumber, title, originalAlbum, originalYear, canonicalComposer, primaryVocalists, isCompilationTrack, confidence }`
   - If confidence < 0.70 or required fields are null, flag for user inspection.

### 4.4 Local Library Self-Referencing Guard

In `src/services/sqliteLibraryService.ts` and `src/services/compilationCanonicalizerService.ts`:

1. **Self-Referential Exemption:**
   When analyzing a track whose resolved `originalAlbum` matches the parent release's title via `isSameCanonicalAlbum(trackOriginalAlbum, parentReleaseTitle)`:
   - Mark `isCanonicalAlbumTrack = true`.
   - Clear `canonicalReleaseId = undefined` (or bind to parent release ID).
   - Clear `canonicalAlbumTitle = undefined` (so no external chip is rendered).
2. **Tri-State Local Status:**
   - **Case A (Native Master):** `track.isCanonicalAlbumTrack === true`. No chip rendered in table.
   - **Case B (Compilation Track with Local Master Present):** `track.canonicalReleaseId` points to another release in the library. Chip rendered: `"From <Original Soundtrack> (<Year>)"` with one-click navigation to that release.
   - **Case C (Compilation Track without Local Master):** `track.canonicalAlbumTitle` is known, but `!track.canonicalReleaseId`. Chip rendered: `"From <Original Soundtrack> (Not in local library)"`.

### 4.5 Two-Phase Staging & Curation Integration

Instead of immediately calling `tauriBridge.dbUpdateTrackProvenance` upon AI response:
1. Candidate provenance fixes are placed in React state / `staged_album_provenance`.
2. The user sees a visual diff in the Curation Reconciliation Stage:
   - Green badge (Grounded / URL verified)
   - Amber badge (Heuristic / requires review)
   - Gray badge (Unresolved / needs user input)
3. The user can review, uncheck false suggestions, or edit inline.
4. Clicking **"Stage & Commit"** persists changes to SQLite and creates sidecar records.

### 4.6 Audiophile Transport Gate

Per workspace rules:
- All remote URL fetches, Apple Music calls, and Gemini queries are gated by:
  `if (audioEngine.isPlaying() || audioEngine.isPaused() || !audioEngine.cooldownElapsed()) { abortWithNotice("Playback in progress. Metadata queries deferred to protect audio purity."); }`
- No SQLite writes or sidecar commits occur while audio engine is active.

---

## 5. Alternatives Considered

| Alternative Approach | Description | Reason for Rejection |
| :--- | :--- | :--- |
| **1. Pure Regex / Heuristic Title Matching** | Attempting to resolve all soundtrack provenance locally via regex string splitting (e.g. `Movie - Track` or `Track (From Movie)`) without AI or external search. | **Fails on multi-edition Indian and archival releases.** Many Indian film tracks lack structured hyphenated tags or carry transliterated spelling differences (e.g., *Paasa Mazhai* vs *Pasa Mazhai*, *Alaipayuthey* vs *Alaipayuthe Kanna*). Heuristics alone cannot distinguish uncataloged multi-combo CD rips from genuine compilations. |
| **2. Bundled Headless Browser Scraping (Puppeteer / Playwright)** | Embedding a headless browser instance in the desktop application to scrape dynamic JavaScript web pages (Spotify, Tidal, Wikipedia). | **Violates Audiophile Resource Boundaries & Performance.** Spawning a Chromium process consumes hundreds of megabytes of RAM, spikes background CPU activity across core 0/1, and introduces severe binary bloat. Rejected in favor of direct API parsing (Apple Music ID, MusicBrainz API) and lightweight Gemini search/URL grounding. |
| **3. Universal Fallback Search Across All Releases (Including Compilations)** | Modifying `releaseTitleMap` in `sqliteLibraryService.ts` to index all library releases regardless of compilation status. | **Introduces High Risk of False Positives & Circular References.** As observed with the duplicate release `rel-0ab8...` (*Enn Raasavin manasile CD RIP* tagged as *Paasa Mazhai*), searching compilations and uncurated combo releases by title alone creates collisions where tracks link to compilation containers instead of authentic master releases. |
| **4. Automatic Direct SQLite Writes on AI Resolution** | Immediately updating database rows when the AI returns confidence >= 0.70 without intermediate human staging. | **Creates Silent Library Pollution.** As demonstrated by the *Ehtanai Konam* incident (where the model hallucinated Deva 2004 with 0.95 confidence), automated writes without visual inspection permanently corrupt library state, requiring tedious manual remediation. Two-phase staging is mandatory. |
| **5. Strict Exact String Equality for Native Checks** | Requiring `release.title.toLowerCase().trim() === track.originalAlbum.toLowerCase().trim()` to detect native tracks. | **Direct Root Cause of the *Paasa Mazhai* Defect.** Storefront editions invariably append packaging subtitles (`(Original Motion Picture Soundtrack)`, `- EP`). Strict string equality causes self-referencing tracks to be falsely marked as foreign compilation tracks. |

---

## 6. Detailed Implementation Plan

### 6.1 Enumerate Files to Change & Rationale

| File Path | Component | Rationale & Changes |
| :--- | :--- | :--- |
| `src/core/taxonomyUtils.ts` | Title Normalization Engine | Add `normalizeCanonicalAlbumTitle` and `isSameCanonicalAlbum` to cleanly strip commercial soundtrack editions (`- EP`, `(OST)`, `[Remastered]`) while preserving authentic movie/debut titles. |
| `src/core/types.ts` | Data Models | Add `referenceUrl?: string` and `userSearchQuery?: { albumTitle?: string; artistCredit?: string; year?: number }` to `CompilationResolutionPayload`. Extend `Track` to ensure `isCanonicalAlbumTrack` is preserved in serialization. |
| `src/services/compilationCanonicalizerService.ts` | Provenance Orchestrator | 1. Ingest `referenceUrl` and `userSearchQuery`.<br>2. Compare proposed albums using `isSameCanonicalAlbum`.<br>3. Remove unconditional `targetTrack.isCanonicalAlbumTrack = false`.<br>4. Prevent immediate SQLite writes during initial AI resolution; return staged proposals for review. |
| `src/services/sqliteLibraryService.ts` | Local Graph Engine | 1. Use `isSameCanonicalAlbum` at Layer 1 check and line 801.<br>2. When resolved original album matches parent release, set `isCanonicalAlbumTrack = true` and omit external chip.<br>3. Require 2 or more distinct resolved original soundtracks before classifying a release as a compilation. |
| `src-tauri/src/commands/gemini_config.rs` | Tauri Native Backend | 1. Update compilation payload parsing to extract `referenceUrl` and `userSearchQuery`.<br>2. Replace biased compilation prompt with neutral evaluator.<br>3. Enforce anti-hallucination return rules (return `null` for unknown fields). |
| `src/components/Modals/CompilationProvenanceModal.tsx` | Provenance Modal UI | Add a Reference URL input field and display confidence badges (🟢 Grounded, 🟡 Heuristic, ⚪ Unresolved). Connect human-edited query inputs directly to resolution re-trigger. |
| `src/components/Curate/CurationReconciliationStage.tsx` | Curation Stage | Connect the Refine Search Query bar parameters directly to the compilation provenance workflow, ensuring human keyword inputs are fed into the AI payload. |
| `src/components/CenterStage/VirtualDataTable.tsx` | Track Table UI | Ensure the "From [Album] (Not in local library)" chip is never rendered when `track.isCanonicalAlbumTrack` is true or when canonical title matches parent release title. |
| `src/test/testCanonicalProvenance.ts` | Regression Test Suite | Create comprehensive test suite verifying: (a) Paasa Mazhai self-referencing case, (b) Ehtanai Konam null-guard case, (c) True compilation multi-album resolution, and (d) Audiophile idle gate. |

### 6.2 Testing & Verification Suite

1. **Unit & Logic Tests (`src/test/testCanonicalProvenance.ts`)**:
   - `testSelfReferencingSoundtrack()`: Verifies that `normalizeCanonicalAlbumTitle("Paasa Mazhai (Original Motion Picture Soundtrack) - EP")` matches `"Paasa Mazhai"`, producing `isCanonicalAlbumTrack: true` and no missing chip.
   - `testAntiHallucinationNullGuard()`: Passes an unknown release without tags; verifies that composer and year return `null` and confidence is flagged as `<0.60`.
   - `testReferenceUrlPrecedence()`: Supplies an Apple Music URL; verifies that URL metadata takes absolute precedence over local heuristics.
   - `testMultiFilmCompilationDetection()`: Verifies that a true compilation (*World of Rahmania*) containing tracks from *Rang De Basanti* and *Roja* resolves each track to its respective local or external master.
2. **End-to-End Local Verification**:
   - Navigate to the *Paasa Mazhai* album in the Cadence desktop interface. Verify that all 5 tracks display without any "Not in local library" chip.
   - Open the Curation Stage for *Ehtanai Konam*. Verify that the Refine Search Query and Reference URL inputs are present and that no hallucinated "Deva / 2004" metadata is staged by default.
3. **Audiophile Transport Verification**:
   - Start playback of a 24-bit/192kHz track.
   - Trigger a metadata search; verify the application defers the network request and issues the purity notice without touching the MMCSS streaming thread or disk bus.

