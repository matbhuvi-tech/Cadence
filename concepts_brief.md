# Cadence Curation, Auto-Suggestion & Review Lifecycle

* **Author:** Mathan
* **Date:** 2026-10-27

## Overview

Cadence's metadata curation, automated suggestion, and review-and-commit systems currently operate across disjointed surfaces that mislead users and break data integrity. Navigating to "Curate 126" locks onto track zero ("Dil Se") with zero queue context. Inside, the 4-way provider reconciliation table displays hardcoded template strings rather than real provider data, while Copilot recommendations blindly stage hundreds of unreviewed mutations directly into memory. Reviewing staged mutations suffers from divergent counters, contradictory artwork detection, and misaligned batch write modes.

This brief establishes an end-to-end redesign for a coherent 3-stage lifecycle:
1. **Discover & Triage (Audit & Hygiene ⌘3 + Copilot):** Surface prioritized issue queues; clicking an issue routes to Curate scoped strictly to affected items with zero silent mutations.
2. **Inspect & Reconcile (Curate ⌘2):** A dedicated Master-Detail Workbench with an Album-Hierarchical queue on the left (280px) and a real metadata reconciliation table + artwork inspector on the right, backed by a `Stage & Next → (⌘↵)` stepper.
3. **Verify & Commit (Review & Commit Modal):** A strict, read-only pre-flight diff inspector with synchronized counters, consistent artwork detection, global target selection (`Embed Headers` vs `Sidecar JSON`), and unified execution logging.

## Analysis

### 1. Root Causes & Subsystem Failures

#### A. Mystery Selection & Zero Queue Visibility in Curate (⌘2)
* **Arbitrary Fallback:** In `src/core/scopeUtils.ts` (`resolveCurateTargetTrack`), clicking Curate without an active track selection falls back to `tracks[0] || null` ("Dil Se (Dil Se)").
* **Disembodied Workspace:** The top tab says `Curate 126`, implying a queue of 126 items needing attention. Once clicked, there is no left queue, no stepper (`Item 1 of 126`), no reason indicator, and no `Next` button. The user is trapped on one track with only `← Return (Esc)`.

#### B. Mocked Provider Alignment & State Disconnect
* **Simulated Provider Columns:** In `src/components/CenterStage/FocusedWorkbench.tsx` (lines 108–149), `appleMusic`, `musicbrainz`, and `gemini` columns are hardcoded template strings appending suffixes onto local tags (e.g., `'A.R. Rahman'`, `'1998'`) rather than querying real federated APIs.
* **Shared Artwork Pointers:** All three artwork candidate cards (`Local`, `Apple Music Master`, `Cover Art Archive`) point to the exact same URL (`release?.coverArtUrl`).
* **Broken Staged Output Binding:** `handleSave` applies title/artist/composer edits directly to the track object in memory while only placing `coverArtUrl` in `pendingSidecarEdits`. As a result, the green `STAGED OUTPUT` column does not match the proposed diffs in the `Review & Commit Changes` modal.

#### C. Contradictory Artwork State
* In `FocusedWorkbench`, the local embedded card renders the 500x500 JPEG embedded in the file.
* In `TwoPhaseCommitModal`, the album's "Current" artwork box evaluates `artwork?.frontCoverUrl` on the release, reporting `No Embedded Artwork · None detected` and proposing to overwrite the entire compilation's artwork with a single track's soundtrack cover.

#### D. Misplaced Album Actions on Track Surfaces
* A yellow `Split Multi-Disc` button is mounted in the header of `FocusedWorkbench` next to `Cancel` and `Stage to Sidecar`. Disc splitting is an album-level structural operation and does not belong inside a track-level tag reconciliation editor.

#### E. Blind Batch Staging in Copilot & Telemetric Drift
* In `src/components/Agent/EmbeddedAgentDrawer.tsx`, Copilot shows `Scope: Album: A World Of Music`, yet all recommendation cards execute global, catalog-wide operations.
* Clicking recommendations immediately applies unprompted in-memory mutations across hundreds of tracks without a pre-flight staging preview.
* In `src/components/CenterStage/TwoPhaseCommitModal.tsx`, top summary badges (`2 Tag Edits, 4 Cover Art Updates`) conflict with the filter tabs immediately below (`Tag Edits (1), With Artwork Updates (648)`), and row-level badges fail to reflect the selected write target.

---

### 2. Multi-Lens Goldfish Review Findings

#### Lens 1: Contrarian / YAGNI (`egm-zoom-out`)
* **Core Objection:** Why does Curate need to exist as a top-level tab at all? Having both `Curate (⌘2)` and `Audit (⌘3)` in the top segmented control causes user confusion over where triage begins.
* **Resolution:** Retain the 3 top-level modes (`Listen`, `Curate`, `Audit`), but strictly define their scopes:
  * `Listen (⌘1)`: The playback and album browsing surface.
  * `Curate (⌘2)`: The Master-Detail Triage & Editing Workbench (Inbox of items requiring metadata reconciliation or user decisions).
  * `Audit (⌘3)`: The Library Hygiene Cockpit (storage mount diagnostics, dynamic range scans, and catalog health metrics).
* **Queue Re-Use:** Rather than building a bespoke queue component from scratch, the left queue in Curate must leverage virtualized list patterns consistent with `FolderTreeExplorer` and `VirtualDataTable`.

#### Lens 2: Cost, Quota & Token Economics (`egm-codebase-details`)
* **Core Objection:** Replacing mocked provider strings with real remote queries (Apple Music, MusicBrainz, Gemini AI) risks hitting rate limits (MusicBrainz 1 req/sec) and violating Audiophile Invariants 1 & 4 (network PHY packet storms and CPU spikes during playback).
* **Resolution:** Remote lookups must be strictly lazy and demand-driven:
  * Never query external APIs in batch loops across the 126-item queue.
  * Lookups execute strictly for the single active item when selected in the workbench, and only if an internet connection is available and audio playback is idle or user-requested.
  * For compilation soundtrack matching, query the local cache first before calling the Gemini AI provenance endpoint.

#### Lens 3: UX & Ergonomics (`egm-design`)
* **Core Objection 1 (Viewport Real Estate):** On a 1080p display, a 240px left rail + 280px curation queue rail + 320px inspector leaves only 1080px for the 5-column reconciliation table.
  * *Resolution:* Entering `Curate (⌘2)` auto-collapses the global left navigation rail to icon-only (64px) and keeps the right inspector collapsed, dedicating 1500px+ of viewport to the Master-Detail workbench.
* **Core Objection 2 (Curation Fatigue):** Stepping through a flat list of 126 individual tracks with `Stage & Next` is exhausting for album-level fields (Album Title, Year, Cover Art).
  * *Resolution:* The queue must be **Album-Hierarchical**. Albums needing triage sit at the root level (e.g., `A World Of Music · 1 Track Conflict`). Selecting an album allows reconciling album-level tags once, with track-level overrides expandable underneath.

#### Lens 4: Migration & Backward Compatibility (`egm-implementation-readiness`)
* **Core Objection:** Modifying `track.title` and `track.artistCredit` directly in memory breaks two-phase commit undoability. If a user cancels in `TwoPhaseCommitModal`, the in-memory track object retains the edited value.
* **Resolution:** In-memory track objects must remain pristine. All staging actions must strictly mutate `track.pendingSidecarEdits` and set `track.sidecarStatus = 'uncommitted_sidecar'`. The primary track fields only update upon explicit disk commit.

#### Lens 5: Observability & SRE Debuggability (`egm-comprehension`)
* **Core Objection:** Divergent counts (125 albums vs 811 tracks vs 648 artwork vs 102 sidecars) confuse the user and obscure what will be written to disk.
* **Resolution:** Implement a single centralized reactive hook (`useStagedChanges`) that provides consistent, unified telemetry across top header badges, Curate steppers, Copilot cards, and `TwoPhaseCommitModal` filter tabs.

#### Lens 6: Long-Term Tech Debt (`egm-structural`)
* **Core Objection:** Misplaced album actions (such as `Split Multi-Disc`) inside track reconciliation editors create brittle component coupling.
* **Resolution:** Strip `Split Multi-Disc` from `FocusedWorkbench`. Maintain split actions strictly on the Album Detail header where disc structure is visualized.

---

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Build a Master-Detail Curation Queue rail in `Curate (⌘2)` with album-hierarchical grouping, issue reason tags, and a `Stage & Next → (⌘↵)` stepper.
  * Eliminate the `tracks[0]` arbitrary fallback in `resolveCurateTargetTrack`.
  * Replace simulated provider alignment strings with real MusicBrainz and Gemini provenance queries (lazy, on-demand).
  * Enforce strict `pendingSidecarEdits` binding for `STAGED OUTPUT` and Two-Phase Commit diffs.
  * Strip `Split Multi-Disc` from the Curate workbench header.
  * Introduce Batch Proposal preview sheets for Copilot recommendations before mutations are staged.
  * Reconcile divergent diff counts and row-level write target badges in `Review & Commit Changes`.
  * Fix Current artwork detection in `TwoPhaseCommitModal` to match embedded file artwork.
* **Out-of-Scope Non-Goals:**
  * Modifying the native WASAPI audio playback engine, memory pinning (`VirtualLock`), or packet pacing loops.
  * Modifying the physical file-tagging Rust binaries (`taglib` / `lofty`).

## Key Decisions & Staging for Next Steps

* **Decision 1 (Curate Topology):** Curate becomes a Master-Detail Workbench with an Album-Hierarchical queue on the left (280px) and the reconciliation table + artwork inspector on the right. Global left navigation collapses to icon-only mode when Curate is active.
* **Decision 2 (Copilot Safety):** Copilot actions generate a Dry-Run Proposal Sheet with options to bulk-stage or inspect in Curate.
* **Decision 3 (State Binding):** `STAGED OUTPUT` and `TwoPhaseCommitModal` share a unified `pendingSidecarEdits` state structure; in-memory tracks remain pristine until commit.
* **Decision 4 (Lazy Remote Lookups):** Remote API queries for candidate metadata operate strictly on-demand for the active item to prevent network burst noise and quota exhaustion.
