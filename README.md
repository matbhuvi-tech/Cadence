<div align="center">

# 🎵 Cadence

### A quiet, bit-perfect music player for serious listening

![Windows](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square&logo=windows)
![Rust](https://img.shields.io/badge/Audio_Core-Rust-000000?style=flat-square&logo=rust)
![Tauri v2](https://img.shields.io/badge/Desktop-Tauri_v2-FFC131?style=flat-square&logo=tauri&logoColor=black)

**Your music. Your DAC. Your library. No developer setup required.**

[Listening approach](#built-around-the-listening-session) • [Audio formats](#made-for-local-audio-collections) • [Download and install](#download-and-install) • [Privacy](#your-library-stays-yours)

</div>

---

Cadence is a Windows desktop music player and library organizer for listeners who care about how their system handles audio. Its playback path is designed for direct hardware output, while background library work is kept away from active listening.

Download the Cadence installer, install it, and open the app. You do not need Node.js, Rust, a terminal, or a developer environment to use Cadence.

> **First release:** Installer downloads and release notes will be published here when the first version is ready.

## Built Around the Listening Session

### Direct playback to your audio device

Cadence's native Windows audio engine is designed to use WASAPI Exclusive output when available. In Purity Mode, the goal is to send the decoded audio to the selected device without operating-system mixing, resampling, or software volume adjustment. Device support and the source format determine the available output modes; the app should report the active format and playback path so you can confirm what is in use.

### Keep library activity out of playback

Scanning, metadata writes, and other library work are scheduled around listening. Metadata commits wait until playback is stopped and the quiet period has elapsed; queued work yields at track boundaries when playback resumes. Network discovery and remote-control updates are designed to use restrained, event-driven activity.

### A collection organized by musical relationships

Cadence treats an album as more than a folder and an artist string. Browse relationships among composers, lyricists, vocalists, directors, releases, and tracks, and curate inconsistent credits into a coherent local catalog.

### Curation with review before writes

Metadata changes are staged for review before they are applied. Cadence shows proposed changes so you can approve them before files are modified. Audio playback and catalog curation are separate concerns: review commits carefully, and the playback engine does not silently change your source files.

## Made for Local Audio Collections

Cadence is built for local PCM and DSD libraries, including common formats such as:

- FLAC, WAV, and ALAC
- DSF and DFF
- Other formats supported by the current release

The app reads sample-rate and bit-depth information from supported audio containers and presents library details alongside playback. Actual output depends on the file, selected device, Windows driver, and the device's supported formats.

Cadence also includes tools for organizing large collections, resolving artwork and credits, and searching local music alongside connected services. Optional AI-assisted enrichment requires configuring a provider key; ordinary playback does not require it.

## Download and Install

1. Download the latest Windows installer from the project's **Releases** page.
2. Run the installer and follow the prompts.
3. Open Cadence and choose your music folders when prompted.
4. Select your audio device and review its available playback modes in the app.

> **Release status:** This repository is preparing its first release. Until an installer is published on the Releases page, there is no end-user download yet.

## Your Library Stays Yours

Cadence keeps its catalog database on your computer. It does not upload your music library for playback. If you choose AI or online metadata features, those features may send the specific queries or metadata needed to the service you select. Review that provider's terms and configure its credentials only if you want to use those features.

Tag and metadata writes require your approval through the review-and-commit flow. Back up important libraries before applying large batches of changes.

## For Developers

Developer setup, architecture, build commands, and repository invariants are documented in [DEVELOPER.md](DEVELOPER.md). They are not required to install or use the Windows app.
