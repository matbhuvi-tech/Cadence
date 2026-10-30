# Common Components

## Overview
Houses shared visual and presentation utility components used throughout the Cadence desktop user interface. Includes floating cover art hover previews and dynamic atmospheric ambient background canvas renderers.

## Interface
- `ArtworkHoverPreview`: High-resolution floating image hover tooltip for previewing album artwork over table rows and grid cells.
- `CadenceLogo`: Scalable concentric-C geometric vector logo component supporting `gold`, `white`, and `currentColor` variants.
- `PanoramicAtmosphericBackdrop`: Canvas/CSS background component that analyzes current album artwork palette to generate immersive, subtle ambient gradients.

## Invariants
- Atmospheric canvas animations must remain low CPU/GPU cost so background rendering does not cause audio buffer under-runs.
- Hover previews must be dismissed cleanly when the pointer leaves the target area to prevent ghost tooltips.

## Side Effects
- Analyzes album cover image data to extract color palettes via `backdropAnalyzer`.
- Manages lightweight requestAnimationFrame loops for smooth ambient gradient shifts.

## Verification
- Run: `npm run build`
