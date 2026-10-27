# LeftRail Components

## Overview
Houses the primary navigation and sidebar filtering components. Manages audio library views, faceted tag filters, library hygiene triage queues, connected storage drive monitors, and ambient smart curation capsules.

## Interface
- `LeftRail`: Primary vertical navigation rail hosting library scopes, playlists, settings triggers, and sub-panels.
- `FacetedFilters`: Dynamic filter lists for genre, year, resolution (Hi-Res, DSD, CD), sample rate, and format tags.
- `HealthTriageQueue`: List of catalog hygiene issues (missing metadata, duplicate fingerprints, low-res covers) with direct remediation triggers.
- `StorageMounts`: Real-time monitoring component displaying active music storage mounts, drive health, and free space.
- `AmbientCurationCapsule`: Smart ambient mix generator based on time of day, listening history, and acoustic properties.

## Invariants
- Filter selections must apply combinatorially to `DataCanvas` without modifying underlying library database rows.
- Health triage queue items must immediately sync when batch metadata fixes are committed.

## Side Effects
- Mutates active view filters and current selected navigation route in app state.
- Triggers storage mount configuration modal dialogs.

## Verification
- Run: `npm run build`
