# Unified Metadata Management & Catalog Coherence Architecture

* **Author:** Mathan
* **Date:** 2026-10-29
* **Status:** Synthesized RFC Concepts Brief (Multi-Lens Goldfish Review Complete)

## Overview

Cadence metadata management currently suffers from fragmented editing surfaces (`CustomizeAlbumModal`, playback drawer `Details` tab, standalone `Identify Soundtracks` modal, and `Curate` workbench), inverted credit attributions in South Asian and soundtrack catalogs (playback singers mistakenly assigned as Album Artist), brittle version stacking (minor typos or rip tags causing duplicate album cards), isolated automation runs (fetching artwork without fixing dirty titles or credits), and unverified dynamic range (DR) metrics.

This initiative establishes a single, consolidated metadata system:
1. **Single Unified Surface in Curate (⌘2)**: Eliminates competing modals and sidecar tabs. The right drawer in **Listen (⌘1)** is strictly restricted to **Queue** and **Playlists**. Any "Edit Metadata" or "Identify Soundtracks" trigger immediately loads the album into **Curate (⌘2)** with a clean "← Return to Album" breadcrumb.
2. **Confidence-Scored Role Inference & Authority Taxonomy**: Automatically infers whether `Composer = Album Artist` (soundtracks / film releases) or `Performer = Album Artist` (classical, ghazal, devotional) using multi-signal scoring (release type, genre, track-credit distributions). User manual overrides in Curate are permanently persisted so automated refreshes never silently undo them.
3. **Resilient Fuzzy Stacking with Curate Override**: Normalizes rip noise from both titles and artists, applies bounded fuzzy title clustering (catching *Captain* vs *Captian* with track count validation), and provides a manual "Stack / Unstack Edition" control in Curate.
4. **Source-Specific Authority with Configurable Transliteration**: Designates Apple Music as the authority for commercial display titles and artwork, MusicBrainz for structured credits and release relationships, and Gemini AI strictly as a fallback for transliteration and conflict resolution. Preserves original script tags and provides clear review, parameter adjustment, and atomic two-phase commit.
5. **Complete DR Bypass**: Disables dynamic range calculations entirely during file ingestion and scanning, hiding all DR filters and badges via `FEATURE_DYNAMIC_RANGE = false`.

---

## Analysis & Multi-Lens Review Findings

### 1. Contrarian & YAGNI Lens (Code Minimization & Simplicity)
* **Elimination over Addition:** Retiring `CustomizeAlbumModal` (974 lines) and stripping the "Details" inspector from `UnifiedRightSidebar` (removing `SideBySideDiff` and `GranularCreditMatrix` from the playback drawer) eliminates over 1,500 lines of redundant UI code and prevents state drift between competing editors.
* **Avoid Heuristic Bloat:** Rather than building an opaque machine-learning classifier for credit roles, use a deterministic 3-rule confidence scoring system based on existing file metadata: genre tag presence, release type keywords (`OST`, `Soundtrack`), and track composer uniformity ($\ge 80\%$). If confidence is below threshold, defer to a single two-state button in Curate (`Composer Authority` vs `Performer Authority`) rather than guessing.

### 2. Codebase Details & Architecture Lens
* **Right Panel Separation of Concerns:** `UnifiedRightSidebar.tsx` currently conflates playback controls (`queue`, `playlists`) with metadata auditing (`inspector`). Removing `inspector` from the drawer ensures the playback thread and sidecar stay quiet during listening sessions.
* **Card Subtitle & Filter Binding:** In `AlbumCoverGrid.tsx` (lines 683–703) and `renderAlbumDetail` (lines 830–860), display logic currently relies on `album.artistCredit`. When an album is classified under Composer Authority, the card subtitle, hero header, and artist grouping must bind to `effectiveAlbumArtist = album.composerName || album.artistCredit`.
* **Search Indexing Integrity:** Inverting the album artist to the Composer must not break searchability for vocalists. The local search engine (`searchEngine.ts` and SQLite full-text search) must index `releases.composer`, `releases.artist_credit`, and `tracks.artist` concurrently so typing "Yesudas" still surfaces *Agni Natchathiram*.
* **Scanner Ingestion Speedup:** In `integrityScanner.ts` (lines 88–111) and `libraryImporter.ts`, skipping peak/RMS and DR calculations completely avoids opening and decoding audio packets during initial file import, significantly reducing CPU usage and library scanning time.

### 3. UX & Workflow Ergonomics Lens
* **Context Preservation on Mode Switch:** Navigating from **Listen (⌘1)** to **Curate (⌘2)** via "Edit Metadata" must not be a disruptive dead end. The application state must record the return anchor (`previousViewMode`, `selectedAlbumId`, scroll position). Curate must provide a prominent top-left button: `← Back to Album in Listen` so users can return directly to their listening session after staging edits.
* **Ergonomics of Manual Stacking:** Automated fuzzy matching must remain conservative (similarity $\ge 0.88$, track count within $\pm 1$, duration within $\pm 5\%$) to prevent false merges of distinct albums. When fuzzy logic misses (e.g. *Nilavae Oru Sangeetham* variants with completely different titles), Curate's album header must offer an intuitive action: "Stack with another Album...", opening a simple picker to merge release IDs under a single `masterReleaseId`.
* **Two-Phase Review Clarity:** Staging output in Curate must present changes as an unambiguous diff table with green additions, red deletions, and single-click revert buttons per field. Users must never feel uncertain about what will write to physical file tags upon commit.

### 4. Migration & Backward Compatibility Lens
* **Non-Destructive Tag Staging:** All inferred role corrections, title cleanups, and transliterations remain strictly inside `pendingSidecarEdits` and SQLite until the user explicitly confirms the Two-Phase Commit modal. Existing physical tags on disk are never altered without user approval.
* **Persistent Authority Flags:** To prevent future library rescans from reverting user corrections, SQLite stores `metadata_authority_override` (`'composer' | 'performer'`) on the `releases` table. If set, automated scanners must respect this override.
* **Feature Flag Rollout:** Setting `FEATURE_DYNAMIC_RANGE = false` immediately suppresses DR badges, cards, and filters in the frontend without requiring database migrations or dropping existing database columns.

---

## Goals vs. Non-Goals

### In-Scope Goals
* **G1: Unified Surface Navigation**: Eliminate `CustomizeAlbumModal` and remove "Details" from `UnifiedRightSidebar`. Route all album metadata editing into **Curate (⌘2)** with a state-preserving "← Return to Album" action.
* **G2: Confidence-Scored Credit Engine**: Automatic inference for `Composer = Album Artist` on soundtracks vs `Performer = Album Artist` on classical/ghazal/devotional, backed by persistent SQLite override flags and joint search indexing.
* **G3: Resilient & Manual Version Stacking**: Pre-sanitized Jaro-Winkler fuzzy matching combined with track count/duration bounds, plus an explicit Curate stack/unstack picker.
* **G4: Federated Source Authority**: Apple Music for titles/art, MusicBrainz for credits/relationships, Gemini AI strictly for fallback disambiguation and transliteration.
* **G5: Complete DR Bypass**: Zero CPU/disk time spent on fake DR calculations during file ingestion; all DR indicators hidden across the UI behind `FEATURE_DYNAMIC_RANGE = false`.

### Out-of-Scope Non-Goals
* **NG1: Building a Custom Offline TT-DR Audio Meter**: Deferred until a bit-perfect native Rust WASAPI/FFmpeg implementation is prioritized.
* **NG2: Direct Disk Modification Without Review**: Zero uncommitted writes; all changes stage through sidecar buffers and require user confirmation in the Two-Phase Commit modal.
* **NG3: Unconstrained Fuzzy Merging**: Albums with mismatched track counts ($> 1$ track difference) or diverging durations ($> 5\%$) will not auto-stack without user confirmation.

---

## Key Decisions & Staging for Next Steps

* **Decision 1 (Navigation):** `UnifiedRightSidebar` is strictly playback context (Queue/Playlists). All editing operations transition directly to `Curate (⌘2)`, which preserves return navigation state to Listen mode.
* **Decision 2 (Credit Taxonomy):** Multi-signal confidence engine assigns Composer as Album Artist for soundtracks and Performer for classical/vocal genres, with permanent user override retention and joint search indexing across singers and composers.
* **Decision 3 (Grouping):** Stacking pairs sanitized fuzzy matching with manual Curate controls to permanently fix variant fragmentation.
* **Decision 4 (Data Provenance):** Strict role division between Apple (presentation/art), MusicBrainz (structure/credits), and Gemini (fallback/transliteration).
* **Decision 5 (Audio Metrics):** Complete removal and scanner bypass of DR metrics until native TT-DR analysis is developed.
