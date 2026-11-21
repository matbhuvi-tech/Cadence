# Audiophile Engine Principles

**UPnP is the recommended way to use Cadence.** Its defining transport combines RAM-backed playback, unchanged media delivery, and adaptive network pacing to a network renderer. Windows WASAPI Exclusive and ASIO support locally connected DACs as alternative output paths.

Cadence separates the Playback Engine from its Desktop and Mobile Remote controllers. Windows and Linux/TrueNAS engines share RAM-backed UPnP delivery, while local audio output and operating-system scheduling use platform-specific implementations.

## Platform Coverage

| Capability | Windows Playback Engine | Linux / TrueNAS Playback Engine |
| :--- | :--- | :--- |
| Deployment | Tray or Windows Service | Native Linux service or Linux container, including TrueNAS Apps |
| CPU architectures in the release pipeline | x64 | AMD64 and ARM64 |
| Physical RAM locking | Win32 `VirtualLock` | POSIX `mlock` |
| Network output | Paced UPnP delivery | Paced UPnP delivery from locked track buffers |
| Local DAC output | WASAPI Exclusive and ASIO paths | Current headless packages provide UPnP output; equivalent local ALSA-exclusive output is not provided by this path |
| Scheduling | Windows thread affinity, MMCSS and timer APIs | Linux CPU affinity and monotonic absolute-deadline pacing |

Desktop, browser/PWA and Android controllers do not perform the engine's RAM locking or audio delivery. A Linux ARM64 VM on an Apple Silicon Mac runs the Linux engine; this does not imply a native macOS playback engine.

## 1. CPU Affinity & Dedicated Pacing Threads

### Windows

The Windows UPnP transport uses a dedicated synchronous streaming thread (`cadence-paced-stream`), applies affinity away from logical CPUs 0 and 1 where available, registers with MMCSS `"Pro Audio"`, and manages `timeBeginPeriod(1)` through an RAII thread guard. These are Windows mechanisms, not requirements imposed on Linux.

### Linux / TrueNAS

The headless transport uses a dedicated `cadence-core-pacer` OS thread. It selects a pacing CPU from the process/container's allowed CPU set, preferring CPUs other than 0 and 1 when available, and attempts to apply `sched_setaffinity`. Pacing waits use `clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME)`.

Affinity is not exclusive reservation of a physical core. The current Linux affinity call does not enforce success, and CPU numbering does not establish where host interrupts execute. Container CPU restrictions and VM virtual CPUs also limit the available placement. Validate effective affinity on the deployment being qualified.

## 2. Physical RAM Pinning (`VirtualLock` / `mlock`)

### Windows

Windows uses `VirtualLock` and working-set management for locked buffers. Locking policy depends on the output path: the legacy UPnP lock helper can retain a pageable buffer if locking fails, and the WASAPI Exclusive path makes `VirtualLock` opt-in. Preloading into RAM and successfully locking physical pages are distinct states.

### Linux / TrueNAS

`LockedBytesArena` admits whole media files into RAM and retains their page locks while the renderer or HTTP response uses them. Admission accounts for host memory, cgroup memory limits, reserved headroom and locked-memory limits. `mlock` failure rejects admission; this path has no pageable or windowed-read fallback.

- **Containers:** Configure `IPC_LOCK`, unlimited `memlock`, and a container memory budget that leaves room for the host and, on TrueNAS, ZFS ARC.
- **Native systemd service:** Configure `CAP_IPC_LOCK` and `LimitMEMLOCK=infinity` alongside the service memory budget.
- **Oversized selections:** Admission rejects selections that exceed the available locked-memory budget; reduce the selection or adjust deployment resources.

The Linux UPnP server sends slices from these admitted buffers instead of reopening media files for HTTP delivery. Its synchronous packet-sending loop is designed to avoid heap allocations. These properties describe the audio-serving path, not a guarantee of zero disk activity across the entire host.

See [Linux installation](../installation/linux), [Docker profiles](../installation/docker), and [TrueNAS setup](../installation/truenas) for deployment configuration.

## 3. Storage Bus Silence & Curation Lockout
While the engine is `Playing`, `Paused`, `Loading`, or inside the **30-second post-playback cooldown**, zero library disk reads/writes, folder scans, or two-phase tag commits are permitted.

## 4. 3-State Adaptive UPnP Network Pacing
Both engine implementations pace UPnP delivery without transcoding the media stream. The Linux path normalizes `SO_SNDBUF` for Linux kernel accounting, caps initial pre-roll at `512 KiB`, and avoids repeating pre-roll for sequential HTTP Range continuations.

The pacer bounds initial delivery and adapts to backpressure:
- **State 1 — Fast-Start (`1.25×`):** Bounded `512 KB` pre-roll + controlled ramp.
- **State 2 — Anti-Windup Stepdown (`1.02× → 1.002×`):** Re-anchors pacing clock immediately on socket blocking `> 25 ms`.
- **State 3 — Steady Cruise (`1.002×–1.05×`):** Matches real-time DAC consumption rate with hard-clamped `32 KB` `SO_SNDBUF` and `TCP_NODELAY`.

### UPnP Measurements {#upnp-measurements}

The results below document **UPnP transport to a HiFi Rose RS130**. The latest supplied measurements use a TrueNAS engine with a 1 GbE Ethernet connection; the earlier Wi-Fi captures remain separately labelled below. These are not WASAPI measurements.

### TrueNAS Ethernet: Stereo DSD256 {#truenas-ethernet-dsd256}

**Test configuration:** Cadence Core (TrueNAS, 1 GbE) → HiFi Rose RS130 · Stereo DSD256 · 4 KB pacer · Wireshark capture.

![Wireshark I/O graph showing TrueNAS Ethernet UPnP DSD256 delivery to a HiFi Rose RS130 in 10 ms bins](/images/truenas-upnp-pacer-ethernet.png)

The developer supplied the following analysis for this **74.73-second capture**:

| Performance metric | Reported result |
| :--- | :--- |
| Capture duration | 74.73 seconds |
| Audio format | Stereo DSD256 (11.2896 MHz) |
| Average network throughput | 2,913.4 kB/s |
| Minimum throughput (1 s) | 2,908.8 kB/s |
| Median throughput (1 s) | 2,913.1 kB/s |
| Maximum throughput (1 s) | 2,917.3 kB/s |
| Throughput variation (1-second intervals) | Approximately ±0.15% |
| Transmission chunk size | 4 KB |
| Median transmission interval | 1.451 ms |
| Transmission interval (P5–P95) | 1.428–1.472 ms |
| Total 10 ms intervals analyzed | 7,473 |
| Minimum data per 10 ms | 25.24 kB |
| Median data per 10 ms | 29.60 kB |
| Maximum data per 10 ms | 29.73 kB |
| Empty 10 ms intervals | **0** |
| TCP retransmissions | **0** |
| TCP zero-window events | **0** |
| RS130 median ACK RTT | 0.49 ms |
| RS130 ACK RTT (P95) | 0.58 ms |
| TCP packets analyzed | 102,987 |

**Reading the results:** No empty 10 ms bins means the analyzed stream had data in every bin at that resolution; it does not mean packets arrived continuously or at exactly equal intervals. The approximately ±0.15% figure describes 1-second throughput variation, not packet timing or DAC clock jitter. Network throughput includes the bytes counted by the capture analysis and should not be equated directly with the native DSD audio payload rate. Units are reproduced as supplied; the raw capture and analysis method are needed to establish the exact byte-accounting convention.

**Graph scale:** The overview uses a 0–250 kB vertical scale with 10 ms bins. This makes the delivery band appear flat; refer to the table for its reported variation rather than treating the image as a zero-variation trace.

**Source:** [Developer's HiFiVision measurement post](https://www.hifivision.com/threads/cadence-a-music-player-focused-on-audiophiles.105516/#post-1106054), with the table and original graph supplied by the developer. The raw `.pcap`, analysis script/filter, capture location and exact Cadence build have not been included with this documentation, so the tabulated results have not been independently recomputed.

These results describe the recorded setup and duration. They do not establish identical behavior on every OS, architecture, renderer or network, nor measure the DAC's analogue output or prove an audible improvement.

### Earlier Wi-Fi Captures

The following PCM and DSD256 captures document earlier UPnP sessions over Wi-Fi. Their figures belong to those sessions and should not be combined with the Ethernet table above.

### Recorded UPnP Measurement: 24-bit / 192 kHz WAV (`4.61 Mbps`)
![Wireshark 10ms I/O Graph — Played PCM WAV 192 kHz / 24-bit to HiFi Rose RS130](/images/cadence_wav_rs130.png)

### Recorded UPnP Measurement: Native DSD256 (`11.2 MHz / 22.58 Mbps`)
![Wireshark 100ms I/O Graph — Played DSD 11.2 MHz (DSD256) to HiFi Rose RS130](/images/cadence_dsd256_rs130_100ms.png)
![Wireshark 10ms I/O Graph — Played DSD 11.2 MHz (DSD256) to HiFi Rose RS130](/images/cadence_dsd256_rs130.png)
![Wireshark 1s I/O Graph — Played DSD 11.2 MHz (DSD256) to HiFi Rose RS130](/images/cadence_dsd256_rs130_1s.png)

| Metric (HiFi Rose RS130 Target) | PCM WAV (`192 kHz / 24-bit`) | Native DSD256 (`11.2 MHz`) |
| :--- | :--- | :--- |
| **Native Stream Bitrate** | `4.61 Mbps` (`576 KB/s`) | `22.58 Mbps` (`2,822.4 KB/s`) |
| **10 ms Steady-State Median** | `8,588 B / 10 ms` | `34,352 B / 10 ms` |
| **10 ms `p95` Bound** | `8,588 B / 10 ms` | `35,866 B / 10 ms` |
| **100 ms Median (Peak)** | — | `314,976 B / 100 ms` (`max 349 KB`) |
| **1 s Macro Throughput** | — | `2.96 MB/s` mean / `3.04 MB/s` med (`0` stalls) |
| **Disk Reads During Play** | **`0 Bytes`** | **`0 Bytes`** |

## 5. Bit-Perfect Purity Mode (`1.0` Unity Gain)
### UPnP output on Windows and Linux / TrueNAS

The network path delivers original media bytes without software sample-rate conversion or sample attenuation in the sender. Linux/TrueNAS serves those bytes directly from locked track buffers, bypassing the host audio mixer entirely.

This establishes preservation at the sender's transport boundary. The renderer performs decoding and DAC output; its DSP, volume settings and supported formats determine whether the complete playback chain remains bit-perfect. Sending a lossy source unchanged does not make it lossless.

### Windows local DAC output (alternative)

The WASAPI Exclusive path bypasses the shared Windows mixer for supported integer lossless PCM formats. Shared-mode playback is not established as bit-perfect merely by enabling Purity Mode. Output format, driver and device support must be checked for the selected path.

## 6. Ground-Truth Container Clock Extraction
Reads Sony `.dsf` / `.dff` headers natively at exact byte offsets instead of relying on 8-bit FFmpeg container clocks.

## 7. Application-Wide UI, GPU & WebSocket Hygiene
Isolates high-frequency playback progress ticks to leaf React components, avoids continuous idle GPU compositor animations, and communicates with Mobile Remote over event-driven WebSocket deltas + `>= 5 s` heartbeats.

## Implementation & Release Validation

RAM locking, CPU affinity and unchanged media delivery are implemented capabilities, not evidence that every release artifact has passed hardware validation. Qualify Windows, Linux AMD64 and Linux ARM64 separately, including effective lock limits, service/container permissions, CPU placement, representative PCM/DSD playback and track transitions. VM tests establish guest behavior; physical host scheduling and final DAC output need their own measurements.

Implementation references in the [source repository](https://github.com/matbhuvi-tech/Cadence): `src-tauri/src/core_runtime/platform.rs` (memory admission and CPU partitioning), `core_runtime/upnp_session.rs` (Linux pacing and locked-buffer serving), `audio/stream_tuning.rs` (Windows transport tuning), and `audio/wasapi_exclusive.rs` (Windows exclusive output).
