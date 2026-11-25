# Cadence Pre-Release Hardware Sign-Off Checklist

> **Scope:** Automated CI ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)) covers unit tests, interactive Desktop & PWA UI tests, Rust contract/fuzz tests, Linux headless acceptance, Android APK assembly, and Playwright E2E against simulated UPnP.
>
> This lightweight **~10-minute checklist** covers **only hardware-bound behaviors** that CI cannot physically attach. Run it once before promoting a release tag (`v*`).

---

## 0. Automated CI Pre-Flight (Must Be Green First)

- [ ] `ci.yml` green on target commit (`frontend-and-pwa`, `rust-linux-headless`, `rust-windows-desktop`, `android-remote`, `e2e-gate`).
- [ ] Local Windows NSIS build succeeded (`npm run tauri:build -- --bundles nsis`).

---

## 1. Windows Desktop — USB DAC & NSIS Suite Installer (~3 min)

- [ ] **WASAPI Exclusive Bit-Perfect PCM:** Play a 24-bit / 96 kHz or 192 kHz FLAC/WAV track to a physical USB DAC. Confirm DAC display/LED locks to the native sample rate, OS mixer volume is bypassed, and Signal Path shows `Bit-Perfect / WASAPI Exclusive`.
- [ ] **DSD Playback (Native / DoP):** Play a `.dsf` (DSD64 or DSD256) track to a DSD-capable DAC (or confirm explicit, non-silent error on PCM-only DAC — never silent resampling).
- [ ] **Storage Bus Silence:** During active playback, confirm zero library-drive disk reads in Windows Resource Monitor after track RAM preload completes.
- [ ] **NSIS Suite Upgrade:** Run the generated NSIS installer over an existing installation. Verify the Local Engine Tray/Service stops cleanly, upgrades in place, preserves `cadence.db` and settings, and restarts cleanly without orphaned processes.

---

## 2. Linux / TrueNAS SCALE — SMB Mount & Hardened Container (~2 min)

- [ ] **Container Startup & `IPC_LOCK`:** Deploy the release image on TrueNAS SCALE (or Linux Docker) as `UID 568` with `IPC_LOCK` capability. Confirm `/readyz` returns `200 OK` and `mlock` / memory headroom check passes without warnings.
- [ ] **Real CIFS/SMB Library Mount:** Browse and stream from a real SMB/ZFS library mount. Confirm read-only mount flag (`CADENCE_MUSIC_READ_ONLY=true`) blocks tag writes while allowing playback and artwork serving.
- [ ] **Auto-Start After Update:** Trigger an app update/restart and verify the engine comes back online automatically with existing library state intact.

---

## 3. Physical UPnP Renderer — e.g., HiFi Rose RS130 (~3 min)

- [ ] **Format Transitions:** Play a queue mixing Redbook PCM (16/44.1), Hi-Res PCM (24/192), and DSD256 (`.dsf`). Verify clean transitions (`Next` / `Previous` / auto-advance) with zero dropouts, clicks, or stuck transport states.
- [ ] **Range Seek & External Takeover:** Seek mid-track and verify smooth HTTP Range continuation. Pause/resume from the renderer's physical front panel or remote and confirm Cadence Desktop & PWA reconcile state accurately.
- [ ] **UPnP Delivery Inspector (`UpnpPacerPill`):** Open the delivery popover during DSD256/Hi-Res playback. Confirm `Pacing steady`, clean 5-second timing graph updates, working `Freeze` + `Pacer` toggle, and zero unexpected write/schedule stalls.

---

## 4. Android APK — Physical Device (~2 min)

- [ ] **Install & Launch:** Install the signed/release APK on a physical Android device and verify clean cold launch.
- [ ] **Camera QR Pairing:** Scan the Desktop/Engine QR code with the device camera. Verify TLS fingerprint confirmation (TOFU) and immediate library/queue sync over LAN Wi-Fi.
- [ ] **Background & Lock-Screen Control:** Lock the phone screen while playing. Confirm Android media notification displays track metadata/artwork and Play/Pause/Next controls work from the lock screen without disconnecting.

---

## Release Sign-Off Record

| Release Tag | Date | Tester | Hardware Used (DAC / Renderer / NAS / Phone) | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| `v0.1.0-rc.X` | YYYY-MM-DD | | | PASS / FAIL | |
