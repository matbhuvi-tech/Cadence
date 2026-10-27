# AudioPlayer Components

## Overview
Hosts the audiophile playback interface controls, including the persistent bottom Now Playing transport bar, the full-screen Sanctuary Listening Lounge visualization, and the output device selection modal (supporting WASAPI Exclusive and UPnP renderers).

## Interface
- `NowPlayingBar`: Persistent playback control bar rendering play/pause, seek scrub, volume, bitrate/sample-rate telemetry tags, purity indicators, and device routing triggers.
- `AudioDeviceSelectorModal`: Modal allowing selection between WASAPI Exclusive devices and discovered UPnP/DLNA network renderers.
- `SanctuaryListeningLounge`: Full-screen immersive listening view displaying album artwork, bit-perfect transport metrics, and minimalist controls.

## Invariants
- Playback state changes and seeks must invoke methods provided by `AudioPlayerContext` to ensure synchronization with the backend audio engine.
- Volume attenuation controls must visually reflect bypassed status when Bit-Perfect / Purity Mode is engaged.

## Side Effects
- Dispatches playback commands to Rust backend via `AudioPlayerContext` (WASAPI audio thread or UPnP pacing stream).
- Manages full-screen DOM transitions when toggling Sanctuary Listening Lounge.

## Verification
- Run: `npm run build`
