# NowPlaying (`pwa/src/components/NowPlaying`)

## Overview
The `NowPlaying` component package implements the primary playback deck for Cadence Mobile Remote. It renders high-resolution album artwork, ground-truth audio format badges, an interpolated progress scrubber, full transport controls, output device selection, and an audiophile bit-perfect volume guard.

## Interface
- `NowPlayingView`: Primary view component managing playback display, progress timeline, transport controls, device selection, and purity toggling.
- `VolumeGuard`: Audiophile volume protection component that locks volume slider to 100% unity gain when bit-perfect playback is active.

## Invariants
- Bit-perfect volume locking: When `isBitPerfect` is active, the volume slider is locked to unity gain (100%) to prevent software attenuation and preserve bit purity unless explicitly unlocked by the user.
- UPnP route locking: When streaming over UPnP (`activeDevice` starts with `[UPnP]`), output device switching is disabled during active playback to prevent transport stream disruption.
- Smooth time tracking: Playback position interpolates smoothly using `requestAnimationFrame` anchored to server timestamps when user scrubbing is not active.
- Transport buttons strictly adhere to Apple HIG minimum touch target standards (48px secondary controls, 64px primary play button).

## Side Effects
- Dispatches transport commands (`onPlayPause`, `onNextTrack`, `onPrevTrack`, `onSeek`, `onVolumeChange`, `onTogglePurity`, `onChangeOutputDevice`, `onRefreshOutputDevices`).
- Animates rotating vinyl disc graphic when audio is playing and artwork is unavailable.

## Verification
- Run: `npm run --prefix pwa build`

