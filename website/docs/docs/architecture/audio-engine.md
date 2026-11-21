# Audiophile Engine Principles

Conventional music servers treat network and host audio delivery as bursty file transfers. Because modern asynchronous DACs and network transports share ground planes and power rails near master femto clocks, **cyclical current fluctuations, PCIe/NVMe bus wakes, and TCP burst sawtooth patterns modulate the analog noise floor**.

Cadence eliminates source bursts through **7 architectural invariants**:

## 1. CPU Core Isolation (Excluding Core 0 & Core 1)
On Windows, **Core 0 and Core 1** handle hardware ISRs, NVMe completion queues, and NDIS DPC network interrupts.
- **Affinity Mask (`0xfffc`):** Paces synchronous audio and UPnP streaming (`cadence-paced-stream`) off Core 0 and Core 1.
- **MMCSS `"Pro Audio"` Elevation:** Registers via `AvSetMmThreadCharacteristicsW("Pro Audio")` at real-time priority (`Priority 26+`).
- **`1.0 ms` Kernel Timer Precision:** Tightens Windows' default `15.6 ms` timer via `timeBeginPeriod(1)` guarded by an RAII `!Send` `PlatformThreadGuard`.

## 2. Whole-Track Physical RAM Pinning (`VirtualLock` / `mlock`)
- **Zero Disk I/O During Playback:** Tracks pre-load into physical RAM (targeting `25–30%` of free RAM via `GlobalMemoryStatusEx`) and pin via Win32 `VirtualLock` / POSIX `mlock`.
- **Zero-Allocation Hot Loop:** Zero heap allocations (`Box`, `Vec` resizing, `malloc`/`free`) execute inside the active packet-sending loop.
- **Ping-Pong Buffers for Oversized Masters:** Multi-gigabyte tracks switch to dual page-locked `128–256 MB` Ping-Pong windows prefetched at `THREAD_PRIORITY_BELOW_NORMAL`.

## 3. Storage Bus Silence & Curation Lockout
While the engine is `Playing`, `Paused`, `Loading`, or inside the **30-second post-playback cooldown**, zero library disk reads/writes, folder scans, or two-phase tag commits are permitted.

## 4. 3-State Adaptive UPnP Network Pacing
Streaming over Wi-Fi to a **HiFi Rose RS130** without Diretta hardware:
- **State 1 — Fast-Start (`1.25×`):** Bounded `512 KB` pre-roll + controlled ramp.
- **State 2 — Anti-Windup Stepdown (`1.02× → 1.002×`):** Re-anchors pacing clock immediately on socket blocking `> 25 ms`.
- **State 3 — Steady Cruise (`1.002×–1.05×`):** Matches real-time DAC consumption rate with hard-clamped `32 KB` `SO_SNDBUF` and `TCP_NODELAY`.

### Measured Proof: 24-bit / 192 kHz WAV (`4.61 Mbps`)
![Wireshark 10ms I/O Graph — Played PCM WAV 192 kHz / 24-bit to HiFi Rose RS130](/images/cadence_wav_rs130.png)

### Measured Proof: Native DSD256 (`11.2 MHz / 22.58 Mbps`)
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
Bypasses Windows OS mixers, sample-rate converters, equalizers, and software digital volume scaling.

## 6. Ground-Truth Container Clock Extraction
Reads Sony `.dsf` / `.dff` headers natively at exact byte offsets instead of relying on 8-bit FFmpeg container clocks.

## 7. Application-Wide UI, GPU & WebSocket Hygiene
Isolates high-frequency playback progress ticks to leaf React components, avoids continuous idle GPU compositor animations, and communicates with Mobile Remote over event-driven WebSocket deltas + `>= 5 s` heartbeats.
