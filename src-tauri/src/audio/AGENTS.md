# Audio Engine Package (`src-tauri/src/audio`)

## Overview
Houses the core audiophile playback transport engines for Cadence on Windows. Manages bit-perfect WASAPI Exclusive playback, ASIO streaming, memory pinning via Win32 `VirtualLock`, deterministic UPnP/DLNA network pacing, and DAC clock transition synchronization.

## Interface
- `AudioEngine`: High-performance playback engine managing audio threads, decoders (FLAC, ALAC, WAV, AIFF, DSF/DSD), device enumeration, and volume bypass.
- `AudioStreamInfo`: Telemetry struct reporting sample rate, bit depth, channels, codec format, and active purity mode.
- `PlaybackStatus`: Enum representing playback states (`Playing`, `Paused`, `Stopped`, `Loading`).
- `UpnpManager`: UPnP/AV transport coordinator discovering network renderers and pacing HTTP audio streams.
- `UpnpDevice`: Representation of network audio renderers discovered via SSDP.
- `StreamBufferInfo`: Buffer fill metrics and real-time network jitter telemetry.
- `stream_tuning.rs`: Tuning constants, MMCSS registration (`Pro Audio`), socket buffer sizing (`SO_SNDBUF`), and high-resolution timer management.

## Invariants
- Audio pacing and streaming loops must run with MMCSS `"Pro Audio"` priority and isolated away from Core 0 and Core 1.
- Active audio tracks must be pre-loaded and pinned in RAM via Win32 `VirtualLock` to eliminate disk I/O while playing.
- Steady-state network streaming over UPnP must clamp `SO_SNDBUF` to 32 KB with `TCP_NODELAY` and strict anti-windup backpressure.
- Bit-Perfect / Purity Mode must bypass OS mixers, resampling, and digital attenuation.

## Side Effects
- Allocates and locks physical RAM via Win32 `VirtualLock` and `SetProcessWorkingSetSizeEx`.
- Binds TCP sockets and SSDP multicast listeners (UDP 1900) for UPnP renderer streaming.
- Calls `timeBeginPeriod(1)` and MMCSS Win32 APIs for microsecond kernel timing.

## Verification
- Run: `cargo test`
