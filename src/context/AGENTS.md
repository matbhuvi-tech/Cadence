# Context Package

## Overview
Houses React context providers for Cadence. Currently provides `AudioPlayerContext`, which serves as the central audio transport state machine connecting the React frontend to the Rust backend playback engines (WASAPI Exclusive, ASIO, UPnP/DLNA renderers).

## Interface
- `AudioPlayerProvider`: Context provider wrapping application components to supply playback state, queue management, volume control, device routing, and stream telemetry.
- `useAudioPlayer`: React hook exposing the `AudioPlayerContextType` interface to components.
- `computeSampleRateTransition`: Utility calculating DAC clock switching delays and relay settling intervals between track format/rate changes (e.g. PCM 44.1k to 96k, or PCM to DSD).

## Invariants
- Transport commands (`play`, `pause`, `seek`, `nextTrack`, `prevTrack`) must synchronize bidirectionally with backend audio events.
- Bit-Perfect / Purity Mode must bypass software digital volume attenuators and notify the user when OS mixers are disengaged.
- Audio clock domain transitions must insert calculated hardware settling delays to prevent DAC relay click/pop transients.

## Side Effects
- Invokes Tauri IPC commands via `tauriBridge` (`start_playback`, `pause_playback`, `seek_playback`, `set_output_device`).
- Updates `localStorage` for persisted playback settings (`cadence:active_device`, `cadence:volume`, `cadence:purity_mode`).

## Verification
- Run: `npm run build`
