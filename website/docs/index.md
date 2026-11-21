---
layout: home

hero:
  name: Cadence
  text: Precision Audio Engine & Local Library Curator
  tagline: Uncompromising bit-perfect playback, deterministic network pacing, and zero-telemetry local curation — engineered for electrical and acoustic silence.
  image:
    src: /images/cadence-logo-stacked.svg
    alt: Cadence Logo
  actions:
    - theme: brand
      text: Get Started (Install)
      link: /docs/installation/
    - theme: alt
      text: GitHub Releases
      link: https://github.com/matbhuvi-tech/Cadence/releases
    - theme: alt
      text: Audio Architecture
      link: /docs/architecture/audio-engine

features:
  - title: Bit-Perfect & RAM-Pinned
    details: Loads tracks into physical RAM with Win32 VirtualLock / POSIX mlock and isolates real-time audio away from Core 0/1 interrupts. Zero disk reads during playback.
  - title: 3-State Adaptive UPnP Pacer
    details: Clamps TCP kernel send buffers (32 KB SO_SNDBUF + TCP_NODELAY) to stream native PCM and DSD256 cleanly without sawtooth bursts or FFmpeg overhead.
  - title: Engine-First Ecosystem
    details: Run the native Playback Engine on Windows (Tray or Service), Docker, TrueNAS SCALE, or bare-metal Linux systemd — controlled by Desktop and Mobile Remote PWA/APK.
  - title: Safe Local Library Curation
    details: Organize by Composer, Lyricist, Vocalist, and Film Provenance with two-phase dry-run tag commits — strictly locked out whenever music is playing.
---

<div class="vp-doc" style="margin-top: 2rem;">

![Cadence Multi-Screen Overview — Desktop Catalog, Curate Cockpit, Album View, Now Playing, and Mobile Remote PWA](/images/cadence-screenshots.jpg)

## Quick Navigation

- **New to Cadence?** Read the [Overview & Setup Selector](/docs/overview/) or jump straight to the [Installation Hub](/docs/installation/).
- **Running on Windows?** Follow the [Windows Suite & Service Guide](/docs/installation/windows).
- **Deploying on a NAS or Linux Server?** Pick [Docker & Compose](/docs/installation/docker), [TrueNAS SCALE](/docs/installation/truenas), or [Linux Native (.deb / .rpm / systemd)](/docs/installation/linux).

</div>
