# Components (`pwa/src/components`)

## Overview
The `components` directory organizes the user interface presentation layer of the Cadence Mobile Remote PWA. It groups modular components responsible for catalog exploration, top and bottom navigation, active playback controls, and queue management.

## Subdirectories & Boundaries
- [Catalog](./Catalog/AGENTS.md): Album browsing, format-specific filtering, and tracklist inspection modal.
- [Navigation](./Navigation/AGENTS.md): Persistent application header, transport state badges, and tab bar navigation.
- [NowPlaying](./NowPlaying/AGENTS.md): Active track playback deck, album artwork, bit-perfect volume guard, and device selector.
- [Queue](./Queue/AGENTS.md): Real-time queue inspection, track jump execution, and queue clearing controls.

## Invariants
- All UI views adhere to audiophile dark aesthetic (`#0D0E11`) and gold accent branding (`#D4AF37`).
- Zero audio stream decoding occurs within presentation components; display state mirrors remote backend telemetry.

## Side Effects
- None directly (delegated to child component packages).

## Verification
- Run: `npm run --prefix pwa build`

