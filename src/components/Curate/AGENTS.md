# Curate Components (`src/components/Curate`)

## Overview
Houses the dedicated Master-Detail Curation Workbench (`⌘2`) for Cadence. Unifies catalog defect triage, 4-way metadata reconciliation, artwork inspection, and multi-track sidecar staging into a coherent album-hierarchical inspection flow.

## Interface
- `CurationWorkbench`: Master-detail container orchestrating active queue selection, filter switching, keyboard navigation (`⌘[`, `⌘]`, `Esc`, `⌘4`), and staging to `graphEngine`.
- `CurationQueueRail`: 280px left navigation rail displaying defect-categorized album queues (Soundtrack Provenance, Missing Metadata, Missing Artwork, Staged), defect badges, and completion counters.
- `CurationReconciliationStage`: 4-way metadata reconciliation matrix (Local vs Apple Music vs MusicBrainz vs Gemini AI) and cover art inspector with active stepper (`Stage & Next → ⌘↵`), individual track opt-out checkboxes, and compilation soundtrack grouping.

## Invariants
- All staged modifications must be written exclusively to `track.pendingSidecarEdits` and `track.sidecarStatus = 'uncommitted_sidecar'`, leaving in-memory track objects pristine until two-phase commit.
- External metadata queries (MusicBrainz, Apple Music, Gemini AI) must execute strictly on-demand for the active item with a 300ms debounce to prevent network PHY noise during playback.
- Compilation box sets must cluster tracks by resolved soundtrack master without allowing single-film metadata to overwrite sibling tracks.

## Side Effects
- Mutates pending sidecar state on tracks within `graphEngine`.
- Stages cover art replacements and updates staging badges in global application state.

## Verification
- Run: `npm run build`
