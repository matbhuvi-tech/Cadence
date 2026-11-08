# Navigation (`pwa/src/components/Navigation`)

## Overview
The `Navigation` component package delivers the persistent top brand header and bottom tab navigation for Cadence Mobile Remote. It provides instant visibility into backend engine connectivity, audiophile transport stream characteristics, and tab routing between Now Playing, Catalog, and Queue.

## Interface
- `TopHeader`: Header component displaying Cadence identity, live connection status indicator (`CONNECTED`, `SYNCING...`, `OFFLINE`), and audio stream badge.
- `TabBar`: Bottom navigation bar providing view switching between active views (`now_playing`, `catalog`, `queue`) with real-time queue count badge.
- `TabId`: Type union (`'now_playing' | 'catalog' | 'queue'`).

## Invariants
- Audio transport badge displays `BIT-PERFECT` or `READY` when idle, `DSD DIRECT` for DSD bitstreams, and sample rate / bit depth (e.g., `FLAC 192kHz / 24b`) for PCM streams.
- Connection indicator strictly reflects the tri-state connection status (`isConnected`, `isConnecting`, or offline).
- Tab controls strictly adhere to Apple HIG minimum touch target dimensions (48px+ touch targets).

## Side Effects
- Dispatches tab selection updates via `onSelectTab`.

## Verification
- Run: `npm run --prefix pwa build`

