# Catalog (`pwa/src/components/Catalog`)

## Overview
The `Catalog` component package provides album and track browsing, faceted searching, and album detail modal inspection for Cadence's mobile remote interface. It allows users to filter releases by audiophile format, search by title or artist, and enqueue individual tracks or complete releases.

## Interface
- `CatalogView`: Main React component managing search input, filter state, release grid rendering, and album modal interaction.
- `FacetShelf`: Horizontal filter chip bar supporting category switching (`all`, `hires`, `dsd`, `flac`, `compilations`).
- `CatalogFilter`: Type union (`'all' | 'hires' | 'dsd' | 'flac' | 'compilations'`).
- `AlbumModal`: Bottom-sheet modal component displaying release artwork, tracklist, track durations, and action controls (`Play Album`, `Play Next`, `Queue`).

## Invariants
- Requires a valid authentication token passed from the remote session to load artwork and tracklists.
- In-memory catalog caching (`releaseCache`) persists fetched releases per token to avoid redundant network fetch on tab switching.
- Filter chips inspect release format flags (`isCompilation`, `hasDsd`, `hasHighRes`, `hasFlac`) and fall back to folder name substring matching (`dsd`, `hi-res`, `24bit`, `flac`).
- Search queries are evaluated case-insensitively against both release titles and artist credits.

## Side Effects
- Initiates HTTP requests via `fetchReleases` and `fetchTracks` against the Cadence remote backend.
- Modifies module-level in-memory cache `releaseCache`.
- Dispatches playback commands to parent handler callbacks (`onPlayRelease`, `onQueueRelease`, `onPlayTrack`, `onQueueTrack`).

## Verification
- Run: `npm run --prefix pwa build`

