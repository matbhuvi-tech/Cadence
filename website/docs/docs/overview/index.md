# Overview & Architecture

**Cadence is built around paced UPnP playback.** Its recommended path sends original media bytes from a RAM-backed engine to your network renderer, with adaptive delivery pacing and dedicated transport scheduling on Windows and Linux/TrueNAS.

**Library → Cadence engine → paced UPnP → network renderer → DAC**

The [published UPnP measurements](/docs/architecture/audio-engine#upnp-measurements) feature TrueNAS Ethernet DSD256 delivery to a HiFi Rose RS130, with earlier PCM and DSD256 Wi-Fi captures retained separately. Windows WASAPI Exclusive and ASIO remain supported alternatives for locally connected DACs.

## Engine-First Ecosystem

Cadence separates audio ownership from control surfaces so your library, queue, and DAC connection stay deterministic and independent:

| Role | Binary / Artifact | Responsibilities |
| :--- | :--- | :--- |
| **Playback Engine (Windows)** | `cadence-engine.exe` *(Tray daemon or Windows Service)* | Owns `cadence.db`, folder scanning, artwork cache, tag commits, **UPnP/DLNA** (recommended), local **WASAPI Exclusive / ASIO** alternatives, and HTTPS/mDNS pairing. |
| **Playback Engine (Linux / NAS)** | `cadence-headless` *(OCI container, `.deb`/`.rpm`, or `.tar.gz`)* | Tauri-free headless core for Linux and TrueNAS SCALE, serving **UPnP/DLNA** (paced PCM/DSD), SMB/local scanning, and LAN controllers. |
| **Desktop Controller** | `Cadence Core` *(Windows Tauri v2 + React)* | Thin browsing, listening, telemetry, and idle-only Curate UI connecting locally (`127.0.0.1:4040`) or across the LAN (`https://<engine-ip>:4040`). |
| **Mobile Remote** | Embedded **Web PWA** or `Cadence.Remote_<ver>.apk` | Zero-cloud Wi-Fi QR pairing, gapless queue/transport control, output selection, and live telemetry on iOS & Android. |

## Choose Your Setup

| Your Setup | What to Install | Start Here |
| :--- | :--- | :--- |
| **Single Windows PC** *(UPnP recommended; WASAPI Exclusive / ASIO for a local DAC)* | Unified installer `Cadence_<ver>_x64-setup.exe` (Desktop + Local Playback Engine checked by default) | [Windows Guide](/docs/installation/windows) |
| **Linux or NAS Server + Windows Controller** | Engine on Linux (`install.sh` or `.deb`/`.rpm`) **+** Windows Desktop (`Cadence_<ver>_x64-setup.exe` with Local Engine unchecked) | [Docker](/docs/installation/docker) · [TrueNAS](/docs/installation/truenas) · [Linux Native](/docs/installation/linux) |
| **Phone / Tablet Controller** *(same Wi-Fi network)* | Open Desktop **Remote → QR Code** *(PWA, zero install)* or install the Android APK | [Mobile Remote Guide](/docs/installation/mobile) |

## Supported Formats & Privacy

- **Lossless Native Playback:** FLAC, WAV, AIFF, ALAC, and 1-bit **DSD** (`.dsf` / `.dff`, native container header clock extraction for DSD64–DSD256+). No FFmpeg runtime dependency or hidden resampling.
- **100% Local Library & Zero Telemetry:** Your music files and SQLite catalog stay on your hardware (`%LOCALAPPDATA%\CadenceEngine` on Windows, `/var/lib/cadence` on Linux). Online metadata enrichment runs strictly on user action in Curate mode while playback is stopped.
