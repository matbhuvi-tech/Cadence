# Windows UPnP Pacer — Wi-Fi DSD256 Stutter Analysis & Experiment Ledger

- **Date:** 2026-11-18
- **Target Topology:** Windows Playback Engine (`cadence-engine.exe` on `192.168.1.120:18890`, Wi-Fi) → HiFi ROSE RS130 (`ROSE-67` on `192.168.1.106`, UDN `uuid:6610f352-d5a1-b8dc-ffff-ffffc0860aa6`)
- **Reference Wired Baseline:** TrueNAS Linux Playback Engine (`192.168.1.6:18890`, 1GbE `eno1`) → HiFi ROSE RS130 (`192.168.1.106`)
- **Test Formats:**
  - Stereo DSD256 (`44.1 kHz × 256 = 11.2896 MHz`, `2,822,400 B/s` = `22.579 Mbps` payload)
  - Stereo DSD256 (`48.0 kHz × 256 = 12.2880 MHz`, `3,072,000 B/s` = `24.576 Mbps` payload)

---

## 1. Executive Summary & Problem Statement

While streaming stereo DSD256 (`22.58 – 24.58 Mbps`) from the Windows Playback Engine over Wi-Fi to the HiFi ROSE RS130, playback suffered periodic audible stutters. By contrast, streaming the same DSD256 tracks from the TrueNAS Linux Playback Engine over wired 1GbE (`eno1`) achieved a razor-flat `1.000×` lock across 74+ seconds with **0 TCP retransmissions**, **0 TCP Zero-Window events**, and a **0.49 ms median ACK RTT** (see [`docs/Wireshark-DSD256 Quality TrueNAS-RS130 Config.pdf`](../Wireshark-DSD256%20Quality%20TrueNAS-RS130%20Config.pdf)).

Through a controlled series of **9 packet captures (`RS130Wifi.pcapng` and `try1.pcapng` through `try8.pcapng`)**, we traced the failures to **five distinct root causes**—spanning build/process architecture, kernel socket buffer sizing (`SO_SNDBUF`), chunk framing, wired-vs-Wi-Fi calibration assumptions, and a multi-strike soft-ceiling lockout bug in `upnp_pacer.rs`.

Fixing all five root causes produced a verified, zero-stutter 209.5-second (`653.0 MB`) full-track DSD256 Wi-Fi run (`try8.pcapng`, `syn=1, fin=1`) that maintained **`+2,155 ms` to `+2,793 ms`** of audio cushion inside the RS130 across 26 Wi-Fi airtime stalls (up to `348.5 ms`) with **0 TCP Zero-Window events**.

---

## 2. Historical Chronology: What Earlier Pacer Versions Tried & Why They Failed

Before the `try1–try8` experiments, four iterations of `src-tauri/src/audio/upnp_pacer.rs` and `stream_tuning.rs` were attempted in git history:

| Version / Commit | Architecture & Parameters | What It Tried to Solve | Why It Failed on Windows Wi-Fi DSD256 |
| :--- | :--- | :--- | :--- |
| **1. Phase 2.2 Bounded Recovery** (`ba68c51`) | Open-loop lead estimator (`sent - elapsed * bitrate`), `1.000×` cruise, `1.02× / 1.05× / 1.08×` recovery tiers below `1.2s` target lead. | Keep a small `~1.2s` buffer in the renderer without overflowing its FIFO. | **Open-loop clock drift:** The sender cannot observe when the RS130 starts DAC clock consumption or how much HTTP/ID3v2 metadata was stripped before audio frames began, causing estimated lead to drift from actual renderer buffer occupancy. |
| **2. Closed-Loop `SIO_TCP_INFO` Adaptive Overfeed** (`cde5f83`) | Polled Windows `SIO_TCP_INFO` to detect `ReceiverFlowControl` (RWIN collapse / `SndLimTimeRwin`). Overfed at `1.08×–1.12×` until RWIN collapsed, drained at `0.995×`, halved excess above `1.000×`. Fixed `16 KB` chunks, `32 KB` `SO_SNDBUF`, `512 KB` pre-roll. | Replace open-loop guessing with real TCP receiver window feedback. | **Insufficient startup & kernel headroom:** `512 KB` pre-roll is only **`181 ms`** of DSD256, and `32 KB` `SO_SNDBUF` is only **`11.5 ms`** of DSD256. Any early Wi-Fi stall drained the `181 ms` cushion immediately. |
| **3. `4 KB` Fine-Chunk High-Res Timer & `1 MB` Pre-Roll** (`2ad1b13`) | Raised `MAX_PREROLL_BYTES` to `1 MB` (`~363 ms` DSD256) + `1.18×` `InitialFill` to `1000 ms`. Shrank write chunks from `16 KB` down to **`4 KB`** (`~1.30 ms` ticks via Win32 `CreateWaitableTimerExW`), kept `32 KB` steady `SO_SNDBUF`, and clamped phase-slip catch-up to `2 × 4 KB = 8 KB` (`2.8 ms`). | Flatten 10 ms Wireshark I/O graph buckets (`~38–41 KB / 10 ms`) to mimic Diretta-style flat envelopes. | **Fatal under Wi-Fi ACK stalls:** With `32 KB` `SO_SNDBUF` (`36,864 B` max in flight = `12.7 ms` at DSD256), any `>13 ms` Wi-Fi ACK delay filled `SO_SNDBUF` and blocked `write()`. When `write()` blocked for `>10 ms`, `on_chunk_sent` reset `next_chunk_due = now` (**permanently discarding the lost time**), preventing any post-stall catch-up above the ~40 KB/10ms line. |
| **4. `1.000×` Hard-Locked RS130 Profile on Windows** (`3aac430`, reverted in `d2ade9b`) | Applied a built-in RS130 profile on Windows capping pre-roll to `512 KB` and locking steady multipliers (`initial_overfeed`, `max_overfeed`, `soft_ceiling_floor`) to **`1.000×`** while retaining `4 KB` chunks and `32 KB` `SO_SNDBUF`. | Copy the wired Linux TrueNAS RS130 `1.000×` profile onto Windows. | **Catastrophic delivery deficit (`1.83 MB/s` vs `2.82 MB/s`):** Every Wi-Fi ACK stall blocked on the `32 KB` `SO_SNDBUF` and discarded time (`next_chunk_due = now`), while the `1.000×` ceiling prohibited any recovery above real-time rate. Reverted at 08:50 AM (`d2ade9b`). |

---

## 3. The 9-Capture Experiment Matrix (`RS130Wifi` through `try8`)

### Summary Table

| Capture | Duration / Payload | Active Engine Config | Chunk Framing on Wire | Max Steady In-Flight | Retransmits | Zero / Low Win | Audible Result & Key Finding |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`RS130Wifi`** | `29.5s` / `81.5 MB` | `2ad1b13` baseline (`4 KB` chunks, `32 KB` `SO_SNDBUF`) | `2×1448 + 1200 = 4,096 B` (**4 KB**) | `36,864 B` (`36 KB`) | `170` (`0.28%`) | `0` / `0` | **Stuttered:** `256.8 ms` Wi-Fi ACK stall at `t=1.7s` and 1s slowdown at `t=9–10s` (`6.87 Mbps`) hit `36,864 B` `SO_SNDBUF` ceiling. |
| **`try1`** | `67.3s` / `185.9 MB` | Intended `512 KB` `SO_SNDBUF`, **but ran stale 08:50 AM `cadence-engine.exe`** | `2×1448 + 1200 = 4,096 B` (**4 KB**) | `36,864 B` (`36 KB`) | `442` (`0.32%`) | `0` / `0` | **Stuttered (`22.11 Mbps` avg):** `npm run tauri:build` only rebuilt `cadence-core.exe` (UI), leaving the 08:50 AM `cadence-engine.exe` running. |
| **`try2`** | `84.9s` / `258.5 MB` | Intended `16 KB` chunks, **but ran stale 08:50 AM `cadence-engine.exe`** | `2×1448 + 1200 = 4,096 B` (**4 KB**) | `36,864 B` (`36 KB`) | `573` (`0.30%`) | `0` / `0` | **Stuttered:** Multi-second Wi-Fi dips (`t=7–9s` at `14.4 Mbps`, `t=46–50s`, `t=52–54s`) drained buffer due to `36 KB` `SO_SNDBUF` + discarded stall time. |
| **`try3`** | `57.7s` / `159.2 MB` | Intended Pacer OFF toggle, **but toggle only mutated `cadence-core.exe` & ran stale 08:50 AM `cadence-engine.exe`** | `2×1448 + 1200 = 4,096 B` (**4 KB**) | `36,864 B` (`36 KB`) | `353` (`0.30%`) | `0` / `0` | **Stuttered (`t=6–9s` at `7.5 Mbps`, `t=27–31s` at `12.1 Mbps`):** Exposed both the stale `cadence-engine-setup.exe` installer and cross-process IPC gap. |
| **`try4`** | `114.0s` / `354.4 MB` (`12.288 MHz` DSD256) | **Rebuilt `cadence-engine-setup.exe`**: `16 KB` chunks + `288 KB` DSD256 `SO_SNDBUF` + `64 KB` `low_wnd_floor` cap + `32 KB` `sndbuf_margin` cap | `11×1448 + 456 = 16,384 B` (**16 KB**) | **`327,680 B` (`320 KB`)** | `557` (`0.21%`) | `0` / `30` | **No Stutter (114s):** Overfed `26.5–27.8 Mbps` until RS130 buffer filled at `t=34s` (`30` RWIN pushbacks), then cruised at `24.55 Mbps` (`1.000×` of `12.288 MHz`). |
| **`try5`** | `17.4s` / `47.8 MB` (`11.2896 MHz` DSD256) | `renderer-profiles.json` wired on Windows with **`1.000×` hard-locked cruise** (`max_overfeed_multiplier: 1.0`) | `11×1448 + 456 = 16,384 B` (**16 KB**) | `327,680 B` (`320 KB`) | `124` (`0.35%`) | `0` / `0` | **Stuttered (`t=13–14s`):** Locked to exact `1.000×` (`22.58–22.60 Mbps`). When a 450 ms Wi-Fi stall at `t=13s` drained `487 ms` (`11.59 Mbps`), `1.000×` lock prohibited refilling the lost cushion. |
| **`try6`** | `128.0s` / `393.8 MB` (`12.288 MHz` DSD256) | **UPnP Pacer OFF** (via `/v1/core` `player.upnp_pacer` command to `cadence-engine.exe`) | **`99.92%` full `1,448 B` MSS** (`271,808` pkts) | **`975,952 B` (`976 KB`)** | **`284` (`0.104%`)** | `97` / `2,690` | **No Stutter (128s):** RS130 kept its buffer 100% full and self-paced via TCP RWIN (`24.4–24.8 Mbps` every second, `min 1s = 22.83 Mbps`), but incurred `97` TCP Zero-Window stalls. |
| **`try7`** | `186.6s` / `572.0 MB` (`12.288 MHz` DSD256) | Pacer ON with `try4` profile (`1.08×–1.12×`) over a longer 3-minute run (before strike-cascade fix) | `11×1448 + 456 = 16,384 B` (**16 KB**) | `327,680 B` (`320 KB`) | `1,144` (`0.27%`) | `0` / `71` | **Stuttered at `+160s` (`pcap t=167s`):** 6s full-buffer episode at `+25s` fired 5 cascading strikes, crushing `soft_ceiling_mult` to `1.010×` for the rest of the track so `+2,860 ms` cushion bled to `-497 ms`. |
| **`try8`** | **`209.5s` / `653.0 MB`** (`12.288 MHz` DSD256, `syn=1, fin=1`) | **Final Fix:** Single strike per RWIN episode (`rwin_reopened_since_strike`) + immediate refill unlock on open-RWIN Wi-Fi stalls / `>400 ms` cushion drop | `11×1448 + 456 = 16,384 B` (**16 KB**) | `327,680 B` (`320 KB`) | `1,069` (`0.22%`) | **`0`** / `229` | **Zero Stutters (Full Track to `FIN`):** Buffer cushion stayed locked between **`+2,155 ms` and `+2,793 ms`** across the entire 3.5-minute track despite `348.5 ms` and `324.8 ms` Wi-Fi stalls, with **`0` Zero-Windows**. |

---

## 4. Deep-Dive: The Five Failures & Engineering Gaps Uncovered

### Failure 1: The Two-Process Windows Architecture & Build Split (`try1` – `try3`)
- **What Happened:**
  On Windows, Cadence runs as two independent executables with separate NSIS installers:
  1. **`cadence-core.exe`** (Desktop UI Controller, built by `npm run tauri:build -- --bundles nsis` → `Cadence Core_0.1.0-2_x64-setup.exe`).
  2. **`cadence-engine.exe`** (Standalone Windows Playback Engine serving HTTPS control on `:4040` and UPnP media on `:18890`, built by [`deploy/windows-engine/build-windows-engine.ps1`](../../deploy/windows-engine/build-windows-engine.ps1) → `cadence-engine-setup.exe`, installed at `%LOCALAPPDATA%\Programs\CadenceEngine\cadence-engine.exe`).
- **Why `try1`, `try2`, and `try3` Failed:**
  1. During `try1–try3`, only `npm run tauri:build -- --bundles nsis` was executed. `cadence-engine-setup.exe` remained at its `08:50:07 AM` build, and the running `cadence-engine.exe` process remained the `08:50:04 AM` binary. Every single packet in `try1`, `try2`, and `try3` still exhibited the `08:50 AM` `4 KB` framing (`1448 + 1448 + 1200 = 4,096 B`) and `36,864 B` (`32 KB`) steady in-flight ceiling.
  2. In `try3`, the **UPnP Stream Pacer** toggle in `CadenceSettingsModal.tsx` invoked a local Tauri command (`set_upnp_pacer_enabled`) that mutated an `AtomicBool` inside `cadence-core.exe` rather than sending an authenticated HTTPS `/v1/core` operation to `cadence-engine.exe`.

### Failure 2: Why `32 KB` `SO_SNDBUF` + `4 KB` Anti-Windup Fails on Wi-Fi (`RS130Wifi`, `try1–3`)
- At DSD256 (`2.82 – 3.07 MB/s`), a `32 KB` kernel send buffer (`36,864 B` max in flight on Windows) holds only **`11.5 – 12.7 ms`** of audio.
- On Wi-Fi, 50–250 ms ACK blackouts occur routinely due to airtime contention, beacon/roaming intervals, and CSMA/CA backoff. Any ACK delay `> 13 ms` fills the `32 KB` `SO_SNDBUF` and blocks `stream.write()` on `cadence-paced-stream`.
- Worse, in [`upnp_pacer.rs`](../../src-tauri/src/audio/upnp_pacer.rs), whenever `write_block_dur > stall_threshold_ms` (`25 ms`), line 839 resets `self.next_chunk_due = Some(now)` to prevent wire-speed bursts, and for sub-stall delays `max_phase_slip` is clamped to `2 × last_chunk_bytes` (`8 KB = 2.8 ms` at `4 KB` chunks).
- Consequently, every Wi-Fi ACK stall permanently threw away 50–200 ms of delivery time, while `4 KB` chunks split every write into two `1,448 B` MSS frames plus a `1,200 B` sub-MSS tail frame (33% tail-fragment overhead), degrading Wi-Fi A-MPDU aggregation.

### Failure 3: Secondary Effects When Scaling `SO_SNDBUF` to `512 KB` (`288 KB` for DSD256)
When we raised `MAX_SOCKET_SNDBUF_BYTES` from `32 KB` to `512 KB` in [`stream_tuning.rs`](../../src-tauri/src/audio/stream_tuning.rs) (so `calculate_sndbuf_bytes` gives DSD256 `~100 ms` = **`288 KB`** steady `SO_SNDBUF` while keeping Redbook CD at `32 KB`), two internal formulas in `upnp_pacer.rs` broke until capped:
1. **`low_wnd_floor` in `is_receiver_flow_control` (`upnp_pacer.rs:986`):**
   - Originally computed `low_wnd_floor = (self.steady_sndbuf as u32).saturating_mul(2)` (`64 KB` when `steady_sndbuf` was `32 KB`).
   - With `steady_sndbuf = 288 KB` (or `512 KB`), `low_wnd_floor` became **`576 KB – 1,024 KB`**. Because the RS130's scaled TCP receive window (`ws_shift = 6`) starts at `87,616 B` and auto-tunes up to `870,336 B`, an uncapped `low_wnd_floor` falsely triggers `ReceiverFlowControl` on an open window!
   - **Fix:** Capped `low_wnd_floor` at `64 * 1024` (`64 KB`).
2. **`unacked_bound` in `compute_delivered_bounds` (`upnp_pacer.rs:933`):**
   - Originally subtracted `inflight + self.steady_sndbuf` from `self.sent` to estimate pessimistic delivered lead.
   - With `steady_sndbuf = 288–512 KB`, it subtracted an extra `100–185 ms` even when `BytesInFlight` was only `8 KB`, preventing `InitialFill` from recognizing that the `1,000 ms` cushion had been reached.
   - **Fix:** Capped `sndbuf_margin = (self.steady_sndbuf as u64).min(32 * 1024)` (`32 KB`).

### Failure 4: Why Wired Linux `1.000×` Calibration (`calibrate.py` / `try5`) Cannot Be Used Verbatim on Wi-Fi
- **Why `calibrate.py` Works on Wired TrueNAS (`1GbE eno1`, `0.49 ms` RTT):**
  - On wired 1GbE ([`docs/Wireshark-DSD256 Quality TrueNAS-RS130.pdf`](../Wireshark-DSD256%20Quality%20TrueNAS-RS130.pdf)), there are **0 random packet losses** during the first `17.8 seconds` of cushion fill.
  - At `t = 17.8s` (`~2.14s` audio cushion), the RS130's internal buffer fills and switches to a **40 ms application read cycle (`~13 ms` pause + drain)**.
  - On a `0.49 ms` wired link, Linux's TCP Tail Loss Probe (TLP) timer (`~10 ms`) fires during the RS130's `13 ms` read pauses, emitting `1,200 B` TLP retransmissions (`~24/s`). Thus, on wired Linux, the **first TCP retransmission (`t = 17.8s`) is an exact proxy for the RS130's `2.14s` buffer wall**. Stopping at half that lead (`1.2s`) and locking to `1.000×` keeps the RS130 below its 40 ms read-pause threshold and yields `0` retransmissions across the entire track.
- **Why Both Assumptions Break on Wi-Fi (`try4` & `try5`):**
  1. **Random Wi-Fi RF retransmissions happen immediately:** In `try4.pcapng`, the first Wi-Fi RF retransmission occurred at **`t = 0.194s`** (`367 ms` lead), whereas the RS130's actual buffer wall (signaled on Windows by TCP RWIN collapse `win < 6.4 KB`, not TLP probes) occurred at **`t = 34.167s`** (`6,250 ms` lead).
  2. **Hard-locked `1.000×` (`try5`) cannot refill after Wi-Fi blackouts:** In `try5.pcapng`, `renderer-profiles.json` locked the RS130 to `1.000×` (`2,822,392 – 2,825,288 B/s = 22.58 – 22.60 Mbps`). When a 450 ms Wi-Fi blackout cluster hit at `t = 13.1–13.7s` (`217 ms`, `144 ms`, `94 ms` server gaps), throughput in `t = 13–14s` dropped to `11.59 Mbps`, draining **`487 ms`** from the `1,200 ms` cushion. Because `max_overfeed_multiplier` was locked to `1.000×` and `next_chunk_due` re-anchored to `now`, `t = 14–17s` resumed at `1.000×` (`22.60 Mbps`), never refilling the lost `487 ms`, and playback stuttered.

### Failure 5: The Multi-Strike `soft_ceiling_mult` Lockout Bug on Long Tracks (`try7`)
In `try7.pcapng` (`186.6s`, `572.0 MB`, `12.288 MHz` DSD256 = `3,072,000 B/s` / `24.576 Mbps`), the adaptive pacer (`1.08×–1.12×`) played cleanly for the first 2.5 minutes, then stuttered at **`+160s` (`pcap t = 167s`)**.
- **Root Cause in `trigger_flow_backoff` (`upnp_pacer.rs:1075–1106`):**
  1. At **`+24.65s`**, the RS130's internal buffer reached 100% capacity (`+2,860 ms` cushion ≈ `8.8 MB`), and the RS130 held its TCP receive window low (`< 6.4 KB`, `71` low-window packets) for **6 seconds** (`+24.65s` to `+30.53s`).
  2. Because the debounce holdoff `flow_clear_ms` was only **`1.5 seconds` (`1,500 ms`)** and did not check whether RWIN had reopened between strikes, that **single** 6-second full-buffer episode fired **5 consecutive backoff strikes** (`+24.65s`, `+26.15s`, `+27.65s`, `+29.15s`, `+30.65s`).
  3. On each strike, `soft_ceiling_mult` was clamped to `prev_mult - 0.005` using the **already-halved `prev_mult`**, crushing `soft_ceiling_mult` from **`1.120× → 1.105× → 1.050× → 1.023× → 1.010×` (`soft_ceiling_floor`)**!
  4. Because `soft_ceiling_relax_ms = 30,000 ms` only relaxes `soft_ceiling_mult` by **`+0.005×` every 30 seconds** (an 11-minute recovery time!), the pacer remained handcuffed to **`1.015× – 1.025×` (`24.9 – 25.1 Mbps`)** for the next two minutes (`+30s` to `+155s`) even though the RS130's TCP window was wide open (`870 KB`).
  5. Minor Wi-Fi dips between `+80s` and `+148s` eroded the cushion from `+2,860 ms` down to `+1,703 ms`. Then, a 4-second Wi-Fi dropout at `+150–153s` (`pcap t = 156–160s`, `410.5 ms` server gap) drained **`1,339 ms`**, leaving only `+364 ms`. During the 6 clean seconds from `t = 160–166s`, the handcuffed `1.021×` pacer recovered **0 ms** (`+352 ms`), so when a second Wi-Fi stall hit at `t = 166–168s` (`-849 ms`), the cushion plunged to **`-497 ms` (audible stutter)**.

---

## 5. What We Changed & Why

### 5.1. Kernel Socket Headroom & `16 KB` Chunk Framing ([`src-tauri/src/audio/stream_tuning.rs`](../../src-tauri/src/audio/stream_tuning.rs))
- **`MAX_SOCKET_SNDBUF_BYTES` raised from `32 KB` to `512 KB`:**
  - `calculate_sndbuf_bytes(bitrate)` continues to target `0.100s` (`100 ms`) of audio in flight:
    - Redbook CD (`176.4 KB/s`): stays at **`32 KB`**.
    - DSD256 (`2.82 – 3.07 MB/s`): scales to **`288 – 304 KB`** (`~100 ms` kernel buffer headroom, absorbing `<100 ms` Wi-Fi ACK delays without blocking `write()`).
- **`calculate_pacing_chunk_bytes` restored to `16 KB` (`CHUNK_BYTES`):**
  - Eliminates the 33% sub-MSS `1,200 B` tail fragmentation of `4 KB` chunks (producing 11 full `1,448 B` MSS packets per `456 B` tail packet) and improves Wi-Fi A-MPDU frame aggregation while reducing pacer timer wakeups by 4× (`~5.3 ms` per chunk instead of `~1.3 ms`).

### 5.2. Single-Strike Episode Gating & Open-RWIN Refill Unlock ([`src-tauri/src/audio/upnp_pacer.rs`](../../src-tauri/src/audio/upnp_pacer.rs))
- **`rwin_reopened_since_strike: bool` (Single Strike per Full-Buffer Episode):**
  - When `trigger_flow_backoff` fires on `tcp_flow_control`, it sets `rwin_reopened_since_strike = false`.
  - Until a subsequent `SIO_TCP_INFO` sample observes the receiver's TCP window reopen above `128 KB` (`curr.snd_wnd > 128 * 1024`), any continued low-window probes during the same full-buffer episode extend the `0.995×` relief-drain timer (`flow_suppressed_until`) **without incrementing `flow_strikes` or crushing `soft_ceiling_mult`**.
- **Immediate Refill Unlock on Wi-Fi Stalls & Cushion Drop (`peak_lead_ms`):**
  - When `LinkCongestion` or `AmbiguousWriteStall` occurs while the receiver's TCP window is wide open (`snd_wnd > 128 KB`), or when `display_lead_ms` drops by `> 400 ms` below `peak_lead_ms` (`>= 500 ms`) with `snd_wnd > 128 KB`, the pacer immediately resets `flow_strikes = 0`, unlocks `soft_ceiling_mult = max_overfeed_multiplier` (`1.120×`), and restores `active_pace_mult >= initial_overfeed_multiplier` (`1.080×`) so the RS130's buffer refills back to 100% capacity immediately after any Wi-Fi dropout.
- **Fixed `low_wnd_floor` (`<= 64 KB`) and `sndbuf_margin` (`<= 32 KB`):**
  - Prevents larger `SO_SNDBUF` values (`288–512 KB`) from triggering false-positive `ReceiverFlowControl` or underestimating delivered cushion during `InitialFill`.

### 5.3. Windows `renderer-profiles.json` Integration & Live `/v1/core` Pacer Toggle ([`upnp.rs`](../../src-tauri/src/audio/upnp.rs), [`windows_engine.rs`](../../src-tauri/src/core_runtime/windows_engine.rs), [`commands/audio.rs`](../../src-tauri/src/commands/audio.rs), [`CadenceSettingsModal.tsx`](../../src/components/Modals/CadenceSettingsModal.tsx))
- **Startup Profile Loading on Windows (`UpnpManager::load_windows_renderer_profiles`):**
  - Loads `%LOCALAPPDATA%\CadenceEngine\renderer-profiles.json` once at engine startup (zero disk I/O during playback) and seeds a Wi-Fi-safe adaptive overfeed default (`hifi-rose-rs130-wifi`, `1.08×–1.12×` fill → RWIN-guided cruise) if absent.
- **Cross-Process `/v1/core` Pacer Toggle (`player.upnp_pacer`):**
  - Exposed an interactive **UPnP Stream Pacer** toggle in **Cadence Settings → Playback Engine** that updates `UPNP_PACER_ENABLED` locally and forwards `{"operation": "player.upnp_pacer", "enabled": ...}` over HTTPS (`localhost-pairing.json`) to the running `cadence-engine.exe` process.
  - Checked live inside `SynchronousPacer::on_chunk_sent` so toggling the pacer off/on takes effect immediately on active streams.

---

## 6. Final Verification: `try7` (Before Fix) vs. `try8` (After Fix)

Both `try7.pcapng` and `try8.pcapng` streamed the exact same `636.4 MB`, `207.2-second` stereo `12.288 MHz` DSD256 track (`3,072,000 B/s` = `24.576 Mbps` real-time consumption rate) from `192.168.1.120:18890` to `192.168.1.106`:

| Stream Elapsed Time | `try7` RS130 Buffer Cushion (Cascading Strike Lockout) | `try8` RS130 Buffer Cushion (With Refill Unlock Fix) | `try8` Wi-Fi Events & Recovery Behavior |
| :--- | :--- | :--- | :--- |
| **`+10s`** | `+1,595 ms` | `+1,129 ms` | `InitialFill` + `1.08×–1.12×` ramp |
| **`+30s`** | `+2,857 ms` | **`+2,583 ms`** | RS130 buffer reaches full capacity (`zero_wins = 0`) |
| **`+60s`** | `+2,773 ms` | **`+2,765 ms`** | Holding full `+2.77s` cushion |
| **`+70s`** | `+2,500 ms` | `+2,155 ms` | Absorbed `324.8 ms` Wi-Fi blackout at `+69.5s` |
| **`+90s`** | `+2,300 ms` | **`+2,779 ms`** | **Unlocked & refilled back to 100%** (even across a `348.5 ms` Wi-Fi blackout at `+81.7s`) |
| **`+100s`** | `+1,894 ms` | `+2,355 ms` | Absorbed two `145 ms` Wi-Fi stalls at `+100.8s` |
| **`+110s`** | `+1,750 ms` | **`+2,747 ms`** | **Immediately refilled back to `+2.75s`** |
| **`+140s`** | `+1,615 ms` | **`+2,741 ms`** | `+1,126 ms` more cushion than `try7` going into late-track Wi-Fi storms |
| **`+160s`** | **`-497 ms` (STUTTER)** | **`+2,696 ms`** | Absorbed `233.1 ms` + `125.3 ms` Wi-Fi stalls at `+155s` and refilled to `+2.70s` |
| **`+180s`** | **`-762 ms` (STUTTER)** | **`+2,607 ms`** | Absorbed `102.6 ms` Wi-Fi stall at `+180.6s` |
| **`+200s`** | *(aborted after stutters)* | **`+2,751 ms`** | Completed all `652,998,785 B` to clean TCP `FIN` with **`0` Zero-Windows** and **0 audible stutters** |
