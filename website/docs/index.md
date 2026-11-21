---
layout: home

hero:
  name: Cadence
  text: Precision UPnP Audio Transport
  tagline: Original audio bytes. Deliberately paced delivery. Stream from RAM to your UPnP renderer with adaptive network pacing on Windows, Linux, and TrueNAS.
  image:
    src: /images/cadence-logo-stacked.svg
    alt: Cadence Logo
  actions:
    - theme: brand
      text: Set Up UPnP Playback
      link: /docs/usage/getting-started
    - theme: alt
      text: GitHub Releases
      link: https://github.com/matbhuvi-tech/Cadence/releases
    - theme: alt
      text: See UPnP Measurements
      link: /docs/architecture/audio-engine#upnp-measurements

features:
  - title: UPnP Is the Recommended Path
    details: Send music directly to your network renderer. Cadence combines RAM-backed playback, unchanged media bytes, and adaptive packet pacing in its UPnP transport. WASAPI Exclusive and ASIO remain alternatives for a Windows-connected DAC.
  - title: Adaptive Pacing, Measured
    details: TrueNAS to HiFi Rose RS130 over Ethernet, streaming DSD256. The reported 74.73-second capture recorded zero empty 10 ms intervals, zero retransmissions, and approximately ±0.15% variation in 1-second throughput.
    link: /docs/architecture/audio-engine#upnp-measurements
    linkText: Inspect the UPnP measurements
  - title: RAM Playback Across Platforms
    details: Run the Playback Engine on Windows, Linux, or TrueNAS. Tracks are preloaded for RAM-backed delivery, with platform-specific VirtualLock or mlock support and a dedicated pacing thread.
  - title: Your Library, Your Control
    details: Control the engine from Desktop or Mobile Remote. Keep your library local, with zero telemetry and two-phase metadata curation deferred until playback is idle.

---

<div class="vp-doc" style="margin-top: 2rem;">

## Built Around the Network Audio Path

**UPnP is Cadence's recommended playback mode.** Run the engine beside your library on Windows, Linux, or TrueNAS, then send the original media stream to your network renderer. Cadence's defining focus is the combination of RAM-backed playback and deliberate pacing of that delivery.

**Library → RAM-backed Cadence engine → paced UPnP stream → network renderer → DAC**

Desktop and Mobile Remote control the engine; the engine sends the audio directly to the renderer.

## DSD256 over UPnP. Measured on TrueNAS.

**TrueNAS · 1 GbE · HiFi Rose RS130 · Stereo DSD256 · 4 KB pacer**

In the developer's **74.73-second Wireshark capture**, Cadence recorded:

| No gaps at the measured scale | Consistent delivery | TCP behavior |
| :--- | :--- | :--- |
| **0 empty 10 ms intervals** across 7,473 intervals | **≈ ±0.15%** variation in 1-second throughput | **0 retransmissions · 0 zero-window events** |

![Wireshark I/O graph of TrueNAS Ethernet UPnP delivery of DSD256 to a HiFi Rose RS130, in bytes per 10 ms](/images/truenas-upnp-pacer-ethernet.png)

The graph shows bytes per **10 ms** on a **0–250 kB** vertical scale. The full measurement table reports the smaller variations within the delivery band. These are network transport measurements from this capture, not DAC clock-jitter or analogue sound-quality measurements.

[Inspect the full Ethernet results and earlier Wi-Fi captures](/docs/architecture/audio-engine#upnp-measurements) · [Set up your network renderer](/docs/usage/getting-started#_3-select-your-audio-endpoint-purity-mode)

Using a USB or locally connected DAC instead? Windows **WASAPI Exclusive and ASIO** are supported alternatives. See the [platform architecture](/docs/architecture/audio-engine#platform-coverage).

## Browse, Listen & Curate


![Cadence Multi-Screen Overview — Desktop Catalog, Curate Cockpit, Album View, Now Playing, and Mobile Remote PWA](/images/cadence-screenshots.jpg)

## Quick Navigation

- **New to Cadence?** Read the [Overview & Setup Selector](/docs/overview/) or jump straight to the [Installation Hub](/docs/installation/).
- **Running on Windows?** Follow the [Windows Suite & Service Guide](/docs/installation/windows).
- **Deploying on a NAS or Linux Server?** Pick [Docker & Compose](/docs/installation/docker), [TrueNAS SCALE](/docs/installation/truenas), or [Linux Native (.deb / .rpm / systemd)](/docs/installation/linux).

</div>
