# Overview & Architecture

Most players treat digital audio as a simple file-transfer job. **Cadence treats the entire playback chain — host storage bus, CPU scheduling, network interface, and DAC — as a coupled mixed-signal audio system.**

## Engine-First Ecosystem

Cadence separates audio ownership from control surfaces so your library, queue, and DAC connection stay deterministic and independent:

| Role | Binary / Artifact | Responsibilities |
| :--- | :--- | :--- |
| **Playback Engine (Windows)** | `cadence-engine.exe` *(Tray daemon or Windows Service)* | Owns `cadence.db`, folder scanning, artwork cache, tag commits, **WASAPI Exclusive / ASIO**, **UPnP/DLNA**, and HTTPS/mDNS pairing. |
| **Playback Engine (Linux / NAS)** | `cadence-headless` *(OCI container, `.deb`/`.rpm`, or `.tar.gz`)* | Tauri-free headless core for Linux and TrueNAS SCALE, serving **UPnP/DLNA** (paced PCM/DSD), SMB/local scanning, and LAN controllers. |
| **Desktop Controller** | `Cadence Core` *(Windows Tauri v2 + React)* | Thin browsing, listening, telemetry, and idle-only Curate UI connecting locally (`127.0.0.1:4040`) or across the LAN (`https://<engine-ip>:4040`). |
| **Mobile Remote** | Embedded **Web PWA** or `Cadence.Remote_<ver>.apk` | Zero-cloud Wi-Fi QR pairing, gapless queue/transport control, output selection, and live telemetry on iOS & Android. |

## Choose Your Setup

| Your Setup | What to Install | Start Here |
| :--- | :--- | :--- |
| **Single Windows PC** *(USB DAC via WASAPI Exclusive / ASIO, or UPnP)* | Unified installer `Cadence_<ver>_x64-setup.exe` (Desktop + Local Playback Engine checked by default) | [Windows Guide](/docs/installation/windows) |
| **Linux or NAS Server + Windows Controller** | Engine on Linux (`install.sh` or `.deb`/`.rpm`) **+** Windows Desktop (`Cadence_<ver>_x64-setup.exe` with Local Engine unchecked) | [Docker](/docs/installation/docker) · [TrueNAS](/docs/installation/truenas) · [Linux Native](/docs/installation/linux) |
| **Phone / Tablet Controller** *(same Wi-Fi network)* | Open Desktop **Remote → QR Code** *(PWA, zero install)* or install the Android APK | [Mobile Remote Guide](/docs/installation/mobile) |

## Supported Formats & Privacy

- **Lossless Native Playback:** FLAC, WAV, AIFF, ALAC, and 1-bit **DSD** (`.dsf` / `.dff`, native container header clock extraction for DSD64–DSD256+). No FFmpeg runtime dependency or hidden resampling.
- **100% Local Library & Zero Telemetry:** Your music files and SQLite catalog stay on your hardware (`%LOCALAPPDATA%\CadenceEngine` on Windows, `/var/lib/cadence` on Linux). Online metadata enrichment runs strictly on user action in Curate mode while playback is stopped.
