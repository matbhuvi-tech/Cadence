# Federated Album & Artist Metadata Recommendation Engine

* **Author:** Mathan
* **Date:** 2026-10-28
* **Status:** Refined RFC Concepts Brief (Ready for Formal Design Drafting)

## Overview

Cadence resolves album-level and artist-level metadata by orchestrating Apple Music, MusicBrainz, and Gemini AI through a deterministic **Pre-Sanitized 2-of-3 Consensus Model**, a **Lookahead Queue Prefetcher (Depth = 2)**, and a **Directory-Tree Context Parser**. The system prioritizes Apple Music and MusicBrainz for rapid, unthrottled resolution while shielding Gemini AI behind a strict 15 RPM quota guard. Physical audio file headers receive verified album and track tags via atomic two-phase commit, while rich editorial profiles (biography, active eras, origin, primary musical role) populate the pre-existing SQLite `canonical_artists` table.

## Analysis & Architectural Decisions

### 1. Pre-Consensus Sanitization & Garbage Disqualification
* **The "Dirty Local Tag" Trap:** Local file tags often contain rip noise (e.g., `"Anjali CD RIP"`) or placeholder credits (`"Unknown Artist"`). Comparing raw strings prevents consensus or causes bad local tags to outvote true release metadata (e.g., a 2015 rip year + a 2015 Apple reissue year outvoting MusicBrainz's true 1990 original year).
* **Sanitization Layer:**
  - Before evaluating string equality across Local, Apple Music, and MusicBrainz, run strings through `stripRipNoiseAndTags` (stripping `CD RIP`, `[FLAC]`, `(Original Motion Picture Soundtrack)`, `- Single`, bitrate tags, and brackets).
  - Use `disambiguateComboTitle` to handle multi-movie combo CD pressings (e.g., `"Agni Natchathiram-Ninaivoam N..."`).
* **Garbage Disqualification:**
  - Disqualify generic placeholder values (`"Unknown Artist"`, `"Various Artists"`, `"Track 01"`, `"0000"`, `"None"`) from voting in the 2-of-3 consensus pool.
  - When the local tag is disqualified, consensus shifts to 2-of-2 external agreement (Apple + MusicBrainz) or a high-confidence single-provider match ($\ge 80\%$ track count and title duration alignment).
* **Earliest Release Year Invariant (`ORIGINALYEAR`):**
  - Instead of majority vote, calculate `min(Apple.year, MB.firstReleaseDate.year)` across verified release-group matches. A 2018 digital remaster reissue will never overwrite a 1990 soundtrack master date.

### 2. Multi-Movie / Anthology Rips & Album Signature Matching
* **Signature Query Strategy:**
  - Build an Album Signature consisting of Sanitized Album Title + Track Count + Total Duration + Leading Track Fingerprints.
  - Single-pass lookup queries `/api/itunes-album` and `/api/musicbrainz-release?inc=recordings+artists+release-groups+labels`.
* **Combo CD & Custom Anthology Fallback:**
  - If the primary album query returns 0 matches or the track count diverges by $> 30\%$:
    1. Split album title on delimiters (`/`, `-`, `;`) using `disambiguateComboTitle`.
    2. Fall back to querying the top 2 distinct track titles + durations against MusicBrainz recordings to resolve parent release groups.
* **Gemini AI Quota Shield & Full Tracklist Hand-Off:**
  - When Local, Apple, and MusicBrainz fail to reach consensus (0-consensus), hand off to Gemini AI.
  - Pass Gemini the full tracklist array (`trackNumber`, `title`, `artist`, `duration`) together with the physical directory path.
  - In a single prompt (~400 tokens), Gemini resolves both the album-level `COMPOSER` / `ALBUMARTIST` and the per-track playback singer credits.
  - **Hard Guardrail:** Gemini AI is strictly forbidden from generating or guessing barcodes, catalog numbers, or MusicBrainz UUIDs.

### 3. Lookahead Queue Prefetcher for MusicBrainz 1 Req/Sec Policy
* **The Bottleneck:** MusicBrainz strictly limits requests to 1 req/sec. Querying providers synchronously on every `⌘↵` step adds a 1.2–1.5s delay to each album transition.
* **Prefetcher Architecture:**
  - Implement a **Lookahead Queue Prefetcher (Depth = 2)** within `curationQueueService`.
  - While the user reviews Album $N$, the prefetcher resolves and caches Album $N+1$ and Album $N+2$ in SQLite and in-memory caches.
  - **Audiophile Guard:** The prefetcher queries `tauriBridge.getPlaybackStatus()` and remains completely dormant whenever WASAPI Exclusive or UPnP playback is active or in cooldown.

### 4. Hydration Strategy for `canonical_artists`
* **Schema Reuse:** The SQLite `canonical_artists` table already contains unpopulated columns: `bio_summary`, `era_active`, `primary_role`, `mbid`, `apple_artist_id`, and `portrait_url`.
* **Field-Specific Provenance Sources:**
  - `mbid`, `era_active` (`life-span.begin` / `end`), and `primary_role` (derived from artist type, disambiguation, and relations): Sourced from MusicBrainz Artist Lookup (`/ws/2/artist/{mbid}?inc=url-rels+tags`).
  - `apple_artist_id` and high-resolution portrait URLs: Sourced from Apple iTunes Artist Lookup.
  - `bio_summary`: Sourced from the Wikipedia REST Summary API via MusicBrainz Wikidata/Wikipedia URL relations (free, unthrottled, clean plain-text extract). If no Wikipedia link exists, synthesize on-demand via the Gemini AI button in `ArtistsView`.

### 5. Separation of Concerns: File Tags vs SQLite Profiles
* **Physical Audio File Headers (Two-Phase Commit Staging):**
  - Album Level: `ALBUM`, `ALBUMARTIST`, `COMPOSER`, `DISCNUMBER`, `DATE`/`YEAR`, `ORIGINALYEAR`, `GENRE`, `METADATA_BLOCK_PICTURE`.
  - Track Level: `TITLE`, `ARTIST`, `TRACKNUMBER`.
* **Local SQLite Database (`canonical_artists` table):**
  - `bio_summary`, `era_active`, `primary_role`, `mbid`, `apple_artist_id`, `portrait_url`.
  - Encyclopedic descriptions are never written to physical audio files, preventing header bloat and corruption of legacy media players.

## Goals vs. Non-Goals

### In-Scope Goals
* **G1: Pre-Sanitized Release-Group Queries:** Fetch complete release group metadata via `/api/musicbrainz-release` and `/api/itunes-album` using sanitized album signatures and combo CD splitters.
* **G2: 2-of-3 Consensus Engine with Garbage Disqualification:** Automated field-level voting with placeholder disqualification and `min(Apple.year, MB.firstReleaseDate.year)` original year calculation.
* **G3: Lookahead Queue Prefetcher (Depth = 2):** Asynchronous prefetching for Albums $N+1$ and $N+2$ to eliminate MusicBrainz 1 req/sec stepper latency while respecting audio transport quietness.
* **G4: Gemini AI Quota Shield with Full-Tracklist Context:** 15 RPM protection triggering Gemini AI only on 0-consensus or manual button click, supplying full tracklist and directory path context.
* **G5: Multi-Source `canonical_artists` Hydration:** Populate SQLite artist profiles (`bio_summary` via Wikipedia REST, `era_active`/`primary_role` via MusicBrainz, portraits via Apple).
* **G6: Curate & ArtistsView Surface Integration:** Display consensus badges (`[Local+MB]`, `[Apple+MB]`, `[AI]`) in `CurationReconciliationStage` with single-click cell overrides and an editorial profile drawer in `ArtistsView`.

### Out-of-Scope Non-Goals
* **NG1: Automatic Full-Library Gemini Ingestion:** No unattended background crawling that depletes the 15 RPM quota.
* **NG2: Writing Biographies into File Tags:** Prose summaries remain strictly in SQLite.
* **NG3: Guessing Barcodes/Cat Numbers:** No synthetic fabrication of physical manufacturing identifiers without exact database confirmation.

## Key Decisions & Staging for Next Steps

* **Decision 1:** Pre-consensus sanitization strips rip tags and disqualifies placeholder values (`"Unknown Artist"`) before running 2-of-3 consensus.
* **Decision 2:** Release Year defaults to the minimum valid year across verified release groups (`min(Apple.year, MB.firstReleaseDate.year)`), preserving historical original release dates.
* **Decision 3:** MusicBrainz 1 req/sec pacing is masked using a Lookahead Queue Prefetcher (Depth = 2) gated by audio transport silence.
* **Decision 4:** Artist biographies are fetched deterministically from Wikipedia REST API via MusicBrainz Wikidata URL relations, falling back to Gemini AI on-demand.
