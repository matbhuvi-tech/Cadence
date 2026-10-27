# CenterStage Components

## Overview
Houses the central data presentation and curation viewports for Cadence. Supports multiple visual browsing and editing modes: album grid, virtualized data tables, classical work-movement hierarchies, multi-track spreadsheet editing, folder tree browsing, and focused release workbenches.

## Interface
- `AlbumCoverGrid`: High-performance grid rendering album cards, variant edition stacks, and audio quality badges.
- `ArtistsView`: Artist-centric curation gallery aggregating albums, bio cards, and catalog discographies.
- `DataCanvas`: The primary multi-view canvas container orchestrating view modes (Grid, Table, Works, Folders, Playlists).
- `FocusedWorkbench`: Focused single-release inspection view showing tracklists, high-res artwork, and sidecar metadata.
- `FolderTreeExplorer`: Physical file system directory tree browser mapped to configured music library drives.
- `PlaylistDetailView`: Detailed view for inspecting, reordering, and playing custom playlists.
- `SpreadsheetMultiEdit`: Batch tabular editing grid for bulk tag modifications.
- `VariantStackCard`: Interactive expandable stack grouping multiple editions (e.g., Vinyl, SACD, Deluxe) of a release.
- `VirtualDataTable`: High-density virtualized list for rendering large track catalogs without UI lag.
- `WorkMovementView`: Hierarchical multi-movement classical music browser grouping compositions by composer and opus.

## Invariants
- Visual virtualization must be utilized in `VirtualDataTable` and `AlbumCoverGrid` to avoid DOM bloat on large libraries (100k+ tracks).
- Tag edits initiated within tables or spreadsheets must be staged into two-phase transaction queues before persistence.

## Side Effects
- Updates selected tracks and active releases in global state.
- Dispatches drag-and-drop file operations and track queue reordering events.

## Verification
- Run: `npm run build`
