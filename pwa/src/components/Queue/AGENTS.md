# Queue (`pwa/src/components/Queue`)

## Overview
The `Queue` component package provides the interactive playback queue interface for Cadence Mobile Remote. It displays ordered track items, highlights the currently playing track, denotes high-resolution audio badges, and supports item removal, jumping to specific queue indices, and clearing the entire queue.

## Interface
- `QueueView`: Component rendering the list of queued tracks with interactive track jump and removal controls.

## Invariants
- Highlights the current playing track at `queue.currentIndex` with an animated equalizer volume icon and gold highlight accent.
- Renders `HI-RES` badge for tracks flagged with `isHighRes: true`.
- Track durations are consistently formatted as `m:ss`.

## Side Effects
- Dispatches queue manipulation events (`onJumpToIndex`, `onRemoveFromQueue`, `onClearQueue`) to the remote socket dispatcher.

## Verification
- Run: `npm run --prefix pwa build`

