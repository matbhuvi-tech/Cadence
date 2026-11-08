# Types (`pwa/src/types`)

## Overview
The `types` package defines canonical TypeScript interfaces, payload contracts, and event schemas for Cadence Mobile Remote. It mirrors the desktop backend's remote communication models across REST and WebSocket boundaries.

## Interface
- `AudioStreamInfo`: Metadata contract describing active audio stream (format, sample rate, bit depth, channels, high-res status).
- `PlaybackStatus`: Comprehensive engine state contract (isPlaying, isPaused, currentFile, positionSecs, durationSecs, volume, purityMode, isBitPerfect, activeDevice, streamInfo).
- `RemoteTrackItem`: Contract for an enqueued track item.
- `RemoteQueue`: Playback queue state structure (items, currentIndex, repeatMode, isShuffle).
- `RemoteEvent`: Discriminated union of incoming WebSocket messages (`STATE_CHANGE`, `HEARTBEAT`, `QUEUE_UPDATED`).
- `DbRelease`: Database album/release schema representation.
- `DbTrack`: Database track schema representation.

## Invariants
- Pure TypeScript type declarations; emits zero runtime JavaScript.
- Audio stream properties reflect ground-truth container and DAC parameters from the native audio engine.

## Side Effects
- None (compile-time declarations only).

## Verification
- Run: `npm run --prefix pwa build`

