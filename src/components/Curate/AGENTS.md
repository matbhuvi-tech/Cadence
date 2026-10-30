# Curate Components (`src/components/Curate`)

## Overview
Houses the dedicated Master-Detail Curation Workbench (`⌘2`) for Cadence. Unifies catalog defect triage, 4-way metadata reconciliation, artwork inspection, and multi-track sidecar staging into a coherent album-hierarchical inspection flow.

## Interface
- `CurationWorkbench`: Master-detail container orchestrating active queue selection, filter switching, keyboard navigation (`⌘[`, `⌘]`, `Esc`, `⌘4`), and staging to `graphEngine`.
- `CurationQueueRail`: 280px left navigation rail displaying defect-categorized album queues (`All`, `Soundtracks`, `Artwork`, `Staged`) with wrapping compact filter pills (`flex-wrap`), broken-cover fallback icons (`onError`), defect badges, completion counters, and `pb-24` bottom scroll clearance.
- `CurationReconciliationStage`: 12-column split top deck (`xl:col-span-4` 2x2 Artwork Inspector + `xl:col-span-8` `table-fixed` 4-Way Metadata Provider Reconciliation Matrix with Column 1 provenance badges), unified full-width single-column editable track table (`trackTitles` and `trackArtists` with 2-state Reset), strict `isCaseB = hasCompilationSignals && compilationClusters.length > 1` heuristic, and 3-tier field merge precedence (`Stage & Next → ⌘↵`).

## Invariants
- All staged modifications must be written exclusively to `track.pendingSidecarEdits` and `track.sidecarStatus = 'uncommitted_sidecar'`, leaving in-memory track objects pristine until two-phase commit.
- External metadata queries (MusicBrainz, Apple Music, Gemini AI) must execute strictly on-demand for the active item with a 300ms debounce to prevent network PHY noise during playback.
- Multi-Soundtrack Compilation Clusters (`isCaseB`) activate strictly when tracks resolve to 2 or more distinct films/albums (`compilationClusters.length > 1`), preserving per-cluster `originalAlbum` and `originalYear` while merging 4-Way shared fields and per-track inline edits.

## Side Effects
- Mutates pending sidecar state on tracks within `graphEngine`.
- Stages cover art replacements and updates staging badges in global application state.

## Verification
- Run: `npm run build`
