# Frequently Asked Questions

### Do I need Node.js, Rust, or FFmpeg to use Cadence?
**No.** All release binaries (`Cadence_<ver>_x64-setup.exe`, Linux `.deb`/`.rpm`/`.tar.gz`, OCI images, and Android APK) are self-contained and have **zero FFmpeg dependency**.

### Why does Cadence split Desktop and Playback Engine?
Because audio hardware stability depends on uninterrupted RAM pinning, device ownership, and real-time thread priority. Separating the Engine lets you close the UI, run headless on Windows Service or a NAS, and seamlessly control playback from multiple Windows or mobile remotes without dropping audio or re-scanning your library.

### Will switching between Windows Tray and Windows Service lose my library?
**No.** When installed via `Cadence_<ver>_x64-setup.exe` or `cadence-engine-setup.exe`, both **User Tray** mode and **Windows Service** mode share `%LOCALAPPDATA%\CadenceEngine` (`cadence.db`, artwork cache, renderer profiles, TLS cert, and engine identity). Toggling the **Windows Service** checkbox in the installer preserves everything cleanly. *(Note: invoking `cadence-engine service install` manually from the CLI without `--data-dir` still defaults to `%ProgramData%\CadenceEngine`.)*

### Why is Curation / Tag Editing locked while music is playing?
Disk writes, SQLite transactions, folder scans, and network lookups inject storage bus interrupts and CPU wakeups that violate Cadence's zero-disk-I/O playback guarantee. Stopping playback unlocks the Curate workbench immediately.

### Should I choose Standard (`compose.yml`) or Hardened (`compose.hardened.yml`) on Docker / TrueNAS?
- Choose **Standard *(Default)*** if you want to mount SMB shares directly from inside the Cadence UI or allow Curate tag writes (`SYS_ADMIN` is required by Linux `mount.cifs`).
- Choose **Hardened Read-Only** if your music folder is already mounted by the host/NAS OS and you want non-root `568:568`, AppArmor enforcement, and `/music:ro` read-only protection.

### Does Cadence send usage telemetry?
**No.** Cadence performs zero analytics or telemetry. External metadata providers (MusicBrainz, Apple Music lookup, or user-configured Gemini API) are queried only when you explicitly trigger curation tools while playback is stopped.
