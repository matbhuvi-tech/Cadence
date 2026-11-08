# Hooks (`pwa/src/hooks`)

## Overview
The `hooks` package encapsulates reactive state orchestration, real-time WebSocket communication, and mobile browser platform integrations for the Cadence Remote PWA. It manages live state synchronization with the desktop audio engine and bridges mobile lock-screen media controls.

## Interface
- `useRemoteSocket`: Hook managing WebSocket connection lifecycle, receiving `STATE_CHANGE`, `HEARTBEAT`, and `QUEUE_UPDATED` events, and providing dispatchers for all playback actions and device selection.
- `useMediaSession`: Hook integrating the Web MediaSession API with Android and iOS lock-screen media controls, utilizing a silent background audio loop.

## Invariants
- Audiophile network purity (Mobile sleep suspension): Automatically closes the WebSocket connection when the document is hidden (`visibilitychange`) to eliminate radio bursts/EMI while the phone is asleep, and cleanly reconnects on screen wake.
- MediaSession keep-alive: Synthesizes an 8-bit mono PCM silent WAV blob to maintain browser audio focus on mobile without streaming audio data over handset radio.
- Dual-path command dispatch: Dispatches playback actions over WebSocket when open, falling back seamlessly to HTTP REST endpoints (`sendPlaybackAction`) when disconnected.

## Side Effects
- Opens and closes WebSocket connections to `/api/remote/ws`.
- Accesses and updates `localStorage` (`cadence_token`).
- Plays silent audio blob in an HTML `<audio>` element to retain lock-screen controls.
- Registers global event listeners (`visibilitychange`, `pointerdown`, `touchend`, and `navigator.mediaSession` action handlers).

## Verification
- Run: `npm run --prefix pwa build`

