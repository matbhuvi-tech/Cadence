# Multi-Platform Packaging & Distribution Analysis: Navidrome vs. Cadence

## Executive Summary

**Navidrome** and **Cadence** solve overlapping but structurally different packaging problems:

- **Navidrome** is a **single-binary, server-first** Go + embedded React web application. One `Dockerfile` + `GoReleaser` pipeline cross-compiles **11 OS/CPU targets** on Linux CI and emits **28 verified release artifacts** (`.tar.gz`, `.zip`, `.deb`, `.rpm`, `.msi`, `checksums.txt`) plus multi-arch container images on **GHCR and Docker Hub**.
- **Cadence** is an **Engine-First, Zero-DB Frontend audiophile ecosystem** spanning **4 distinct deployable surfaces**:
  1. **Desktop Frontend** (`cadence-core`, Windows Tauri v2 + React + embedded Mobile PWA)
  2. **Windows Playback Engine** (`cadence-engine`, native Rust tray daemon with `WASAPI Exclusive`, `ASIO`, and `UPnP`)
  3. **Linux / TrueNAS Playback Engine** (`cadence-headless`, multi-arch OCI container + guided installer + systemd unit)
  4. **Android Remote** (`com.cadence.remote`, Capacitor APK wrapping `pwa/`)

Cadence already outperforms Navidrome in several critical operational areas—especially **container `HEALTHCHECK` readiness probing**, **interactive TrueNAS middleware deployment (`midclt`)**, **non-destructive UID 568 ACL pre-flight probing**, **atomic `VACUUM INTO` snapshot migrations**, **Protocol v2 Desktop-vs-Engine version-skew warnings** (`src/core/buildInfo.ts`), and **tiny FFmpeg-free Rust binaries** (`5.5–9.2 MB` vs. Navidrome's `101–131 MB` Windows MSI).

However, comparing Cadence against Navidrome exposes **major baseline gaps in release automation, first-time user journey, container profile separation, supply-chain hygiene, and documentation coherence**.

---

## 1. How Navidrome Packages Its Product

### Packaging Architecture
- **Single-Artifact Cohesion:** The React UI is built once inside `Dockerfile` (`node:lts-alpine`) and embedded directly into the Go binary. Every platform receives one self-contained executable acting as web server, UI host, CLI, OS service manager, database health checker, and backup tool.
- **Single Source of Truth for Cross-Compilation:** One multi-stage `Dockerfile` uses `tonistiigi/xx` + `osxcross` to cross-compile **all 11 targets** (`linux/{386,amd64,arm/v5,arm/v6,arm/v7,arm64,riscv64}`, `darwin/{amd64,arm64}`, `windows/{386,amd64}`) on `ubuntu-latest` runners:
  - **Standalone builds (`build` stage):** Static glibc binaries (`-extldflags '-static -latomic'`, LLD linker on 32-bit ARM to avoid GNU `ld` `R_ARM_IRELATIVE` corruption), verified via `xx-verify --static` and `release/verify-binary.sh` (blocks `ebitengine/purego` leaks on 32-bit arches).
  - **Docker builds (`build-alpine` + `final` stage):** Dynamic musl binary enabling `dlopen` for `libwebp`, paired with an `mpv-stubs` stage generating no-op `libEGL.so.1`/`libgbm.so.1` stubs and dropping Mesa/LLVM (`~218 MB` uncompressed saved) in the same image layer.
- **No Double Compilation:** `release/goreleaser.yml` uses a minimal shim (`release/xxgo`) to package the already-compiled Docker output instead of recompiling.

### Release Pipeline & Artifact Matrix (`v0.64.2` / `.github/workflows/pipeline.yml`)
- **Pre-Build Quality Gates:** Go lint (`golangci-lint`), `goimports` / `go mod tidy`, OpenAPI linting & breaking-change checks (`oasdiff`), DB migration order validation, Go `-race` tests, plugin WASM tests, Windows Go tests (with cached FFmpeg), JS lint/test/build, and i18n JSON validation must all pass before packaging starts.
- **QEMU Smoke Testing:** Every cross-compiled Linux binary is smoke-tested (`"$BIN" --help`) via QEMU before upload.
- **28 Standardized GitHub Release Assets:**
  - Portable `.tar.gz` / `.zip` archives for all 11 targets.
  - Native `.deb` and `.rpm` packages (via `nfpms`) for all 7 Linux architectures, declaring `ffmpeg` dependency, `config|noreplace` for `/etc/navidrome/navidrome.toml`, dedicated system user creation (`preinstall.sh`), symlink-safe ownership repair and idempotent service install/restart (`postinstall.sh`), and upgrade-safe uninstall messaging (`preremove.sh`).
  - **Cross-built Windows MSI installers (`x86` & `x64`)** built on Linux CI with `wixl` (`release/wix/navidrome.wxs` + `SettingsDlg.wxs`): prompts for Install Dir, Port, Music Folder, and Data Folder, persists them in `HKLM` across upgrades (`MajorUpgrade AllowDowngrades="no"`), bundles `ffmpeg.exe` + `ffprobe.exe`, writes `navidrome.ini`, and installs/starts a native Windows Service.
  - **`navidrome_checksums.txt`** (SHA256 for every artifact).
  - **Draft GitHub Release** (`draft: true`) with auto-grouped Conventional Commit changelog and "Where to go next?" installation links.
- **Dual Registries + Parallel Digest Merge:** Per-arch container images push by digest (`push-by-digest=true`), then `docker buildx imagetools create` assembles multi-arch manifests for **both GHCR and Docker Hub** (with `mirror.gcr.io` configured in `prepare-docker/action.yml`).
- **PR Downloadability:** `.github/workflows/download-link-on-pr.yml` posts `nightly.link` download URLs on PRs.
- **Built-in Operations CLIs:** `cmd/svc.go` (`navidrome service install|start|stop|status|uninstall` with hardened systemd template), `cmd/backup.go` (`backup create|prune|restore`), and `cmd/doctor.go` (SQLite integrity & foreign-key checks).
- **Package-Channel Markers:** Writes `.package` (`deb`/`rpm`/`msi`) and `/.nddockerenv` to distinguish install methods in telemetry (`core/metrics/insights.go`).

### Navidrome Weaknesses (Not Worth Copying)
- **No code signing / notarization** on Windows MSI or macOS binaries (docs instruct macOS users to strip `com.apple.quarantine`).
- **No SBOM or build provenance attestations** (`actions/attest-build-provenance`) in `pipeline.yml`.
- **No Docker `HEALTHCHECK`** and container runs as root by default unless the operator adds `user: 1000:1000`.
- **Floating FFmpeg download** in `release/wix/build_msi.sh` (`releases/download/latest/...`) without SHA256 pinning, inflating MSI size to `101–131 MB`.
- **Opt-out telemetry (`EnableInsightsCollector=true`)** — incompatible with Cadence's zero-telemetry, network-quietness architecture.

---

## 2. How Cadence Packages Its Product (Baseline Assessment)

Inspecting Cadence `v0.1.0-rc.2` alongside the repository shows **4 artifacts built via 4 disconnected processes**:

| Surface | Binary / Package | Baseline Build Trigger | Size (`v0.1.0-rc.2`) | Packaging Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **Desktop Frontend** | `cadence-core` (`Cadence.Desktop_..._x64-setup.exe`) | Manual local (`npm run tauri:build -- --bundles nsis`) | `9.2 MB` | Tauri v2 NSIS (`src-tauri/tauri.conf.json`) |
| **Windows Engine** | `cadence-engine` (`Cadence.PlaybackEngine_..._x64-setup.exe`) | Manual local (`deploy/windows-engine/build-windows-engine.ps1`) | `5.5 MB` | Hand-written NSIS (`deploy/windows-engine/cadence-engine.nsi`) |
| **Linux / TrueNAS Engine** | `cadence-headless` (`ghcr.io/.../cadence-playback-engine`) + `install.{sh,py}` + `compose.yml` + `Linux-setup.zip` | CI on `release: [published]` (`playback-engine-image.yml`) + manual zip | OCI image (`amd64`/`arm64`) + `10.7 KB` zip | Debian Bookworm-slim `Dockerfile` + Python wizard (`install.py`) + systemd unit |
| **Android Remote** | `com.cadence.remote` (`Cadence.Remote_...apk`) | Manual local Gradle/Capacitor (`pwa/android/app/build.gradle`) | `23.6 MB` | Capacitor Android (**debug-signed** in RC1/RC2) |

### Existing Cadence Strengths
1. **Guided Linux & TrueNAS SCALE Wizard (`deploy/playback-engine/install.py`):** TrueNAS middleware integration (`midclt call app.create`/`app.update`), interactive `/mnt` pool/dataset picker, non-destructive UID 568 permission probing (`test_as_cadence`), LAN IPv4 validation (rejecting loopback, link-local, CGNAT), music/data path-overlap checks, and pre-redeploy backup with rollback if `docker compose config` fails.
2. **Built-in Readiness & Atomic DB Safety:** Container `HEALTHCHECK` (`cadence-headless --healthcheck`), atomic `VACUUM INTO` backups (`--backup` / `--restore`), cross-platform snapshot migration (`--export-snapshot` / `--import-snapshot`), and automatic `%APPDATA%\cadence.db` migration during Windows Engine NSIS installation.
3. **Disposable Containerized Regression Harness (`deploy/engine-regression/Dockerfile`):** Offline Rust, Node/tsx, synthetic DSD256, Python HTTP acceptance, and `strace` syscall audit suite.
4. **Compact Binaries & Rich Build Identity:** Zero FFmpeg bloat (`5.5–9.2 MB` Windows installers), compile-time git metadata embedded via `src-tauri/build.rs`, and live Desktop-vs-Engine version/protocol skew detection in `src/core/buildInfo.ts`.

### Concrete Baseline Gaps & Drift Identified
1. **Container Security vs. Documentation Drift:** `deploy/playback-engine/README.md` previously claimed guided setup mounted music read-only and added only `IPC_LOCK`, while `compose.yml` ran `user: "0:0"` with `SYS_ADMIN`, `DAC_READ_SEARCH`, `apparmor:unconfined`, and `CADENCE_MUSIC_READ_ONLY: "false"` to support dynamic SMB mounting—and `install.py` hard-rejected any Compose template without `SYS_ADMIN`.
2. **Stale Installer Semantics & Broken Unit Tests:** `deploy/playback-engine/README.md` claimed `install.py` refused to replace existing installs even after `install.py` evolved into an in-place redeployer; `test_installer.py` had 3 broken tests from that refactor.
3. **Broken `/releases/latest` Assumption on Pre-Releases:** With all Cadence tags marked pre-release, `https://github.com/matbhuvi-tech/Cadence/releases/latest` (and `install.py`'s `latest_release()`) failed with 404.
4. **Legacy Recipe Drift (`deploy/truenas-dragonfish/`):** `custom-app-24.04.yaml` referenced `ghcr.io/matbhuvi/cadence-core:0.1.0` (wrong owner/image name). *(Note: `deploy-truenas.local.ps1` and `cadence-core-src.tar` in the local workspace are gitignored developer harness files and are not committed to git.)*
5. **5 Unsynchronized Version Strings:** `package.json` (`0.0.0`), `src-tauri/Cargo.toml` (`0.1.0`), `src-tauri/tauri.conf.json` (`0.1.0-2` + `productName: "Cadence Core"`), Android `build.gradle` (`versionCode 1` / `versionName "0.1.0"`), and git tag (`v0.1.0-rc.2`) drifted independently.
6. **Manual Multi-Artifact Release Process & Slow QEMU ARM64 Builds:** Desktop NSIS, Windows Engine NSIS, Linux setup zip, and Android APK were built manually off-CI; `playback-engine-image.yml` compiled `linux/arm64` Rust via QEMU with no `cargo-chef`/BuildKit caching, ran *after* `release: [published]`, omitted SHA256 checksums/provenance, and lacked `--version`/`--help` smoke tests on engine binaries.
7. **Windows Engine NSIS Omissions:** Missing Windows `Add/Remove Programs` (`Uninstall`) registry entry, firewall port guidance/automation, optional Windows Service mode, and `--backup`/`--restore`/`--version` parity with `cadence-headless`.

---

## 3. Side-by-Side Comparison

### 3.1 User Journey (Apple HIG Lens)

| Journey Stage | Navidrome | Cadence (Baseline) | Gap |
| :--- | :--- | :--- | :--- |
| **Download Selection** (*Purpose, Simplicity*) | Structured `navidrome.org/docs/installation/` hub; 1 clear asset per OS/arch. | Outdated monolithic Windows instructions in `README.md` vs. 7 assets on `v0.1.0-rc.2` without a topology matrix. | **Critical:** Users don't know which combinations apply to Windows-local vs. NAS-hosted vs. mobile. |
| **First-Run (Windows)** (*Simplicity, Familiarity*) | Single MSI captures Port/Music/Data and starts Windows Service automatically. | Two separate unsigned NSIS installers (`Desktop` + `PlaybackEngine`); Engine missing from *Installed Apps*. | **High:** Two-installer split exposes internal architecture to single-PC listeners. |
| **First-Run (Linux / NAS)** (*Agency, Forgiveness*) | `.deb`/`.rpm` (with systemd + `ffmpeg`) or minimal Compose YAML. | Great `install.sh` + TrueNAS `midclt` wizard, but no pre-built Linux `.deb`/`.rpm`/tarballs (must compile Rust for bare-metal systemd). | **Medium-High:** Bare-metal Linux users face full Rust compilation. |
| **Mobile Companion** (*Familiarity, Responsibility*) | Browser + 3rd-party Subsonic apps. | QR-paired PWA (instant, zero install) + debug-signed Android APK (`23.6 MB`). | **Medium:** Debug signing blocks clean upgrades and triggers Play Protect warnings. |
| **Upgrades & Rollback** (*Agency, Forgiveness*) | MSI `MajorUpgrade`, `apt` restart, `navidrome backup/doctor`. | Linux has `--backup`/`--restore` (omits `pairing-token`); Windows Engine lacks `--backup` and auto-update; Android `versionCode` stuck at `1`. | **High:** Risk of protocol/version skew across 4 independently updated binaries. |

### 3.2 Build & Packaging Efficiency

| Dimension | Navidrome | Cadence (Baseline) | Gap |
| :--- | :--- | :--- | :--- |
| **CI Automation** | 100% automated on `v*` tag push (11 targets, `.deb`, `.rpm`, `.msi`, Docker, Draft Release, PR `nightly.link`). | Only Linux OCI image + `install.{sh,py}` automated (`playback-engine-image.yml`); Windows & Android built manually. | **Critical:** Manual release steps cannot scale or guarantee reproducibility. |
| **ARM64 Build Speed** | `tonistiigi/xx` cross-compile on `$BUILDPLATFORM` + BuildKit caches (zero QEMU compilation). | Full Rust compile under `linux/arm64` QEMU with zero cargo/BuildKit caching. | **Critical:** 15–40+ min uncached QEMU builds vs. ~2–4 min native `ubuntu-24.04-arm` + cache mounts. |
| **Release Gate** | Lint + tests + migration checks + QEMU smoke tests run **before** creating a **Draft** release. | Triggers *after* `release: [published]` with no test job or container smoke test. | **Critical:** Unverified artifacts can publish immediately. |
| **Binary Footprint** | ~23–25 MB Go binary; 101–131 MB MSI (FFmpeg). | `5.5 MB` Windows Engine; `9.2 MB` Desktop; `[profile.release]` lacked `strip = "symbols"` and `lto = "thin"`. | **Medium:** Easy win to shrink Rust binaries & OCI layers further. |

### 3.3 Packaging Best Practices & Security

| Practice | Navidrome | Cadence (Baseline) | Gap & Cadence Nuance |
| :--- | :--- | :--- | :--- |
| **Checksums & Provenance** | `navidrome_checksums.txt` on every release. | No checksum manifest, no build provenance attestations, no digest check in `install.sh`. | **High** |
| **Container Privileges** | Non-root user option + heavily sandboxed systemd unit. | `compose.yml` required root + `SYS_ADMIN` for SMB without offering a non-root hardened option. | **Critical:** Fixed in P0 by keeping SMB (`compose.yml`) default while offering opt-in `compose.hardened.yml`. |
| **Code Signing** | Unsigned MSI/macOS binaries. | Unsigned Windows EXEs; debug-signed Android APK. | **High** (CI Android keystore signing + future Windows Authenticode). |
| **Telemetry & Audio Purity** | Opt-out Insights HTTP telemetry; bundles FFmpeg. | Strict zero-telemetry, zero-disk-I/O during playback (`VirtualLock`/`mlock`, MMCSS isolation). | **Preserve Cadence's edge:** Never add telemetry or background update polling during playback. |

---

## 4. Prioritized Roadmap

### Product Decision on Linux/TrueNAS Profiles
- **Default (`compose.yml` — Standard Profile):** Retains runtime **SMB share mounting (`mount.cifs`)** and optional **Curate tag writing** (`user: "0:0"`, `IPC_LOCK`, `SYS_ADMIN`, `DAC_READ_SEARCH`, `apparmor:unconfined`, `CADENCE_MUSIC_READ_ONLY: "false"`).
- **Optional (`compose.hardened.yml` — Hardened Read-Only Profile):** Offered directly in `install.py` and documented side-by-side for users mounting local/NAS folders read-only without runtime SMB (`user: "568:568"`, `IPC_LOCK` only, AppArmor enforced, `/music:ro`, `CADENCE_MUSIC_READ_ONLY: "true"`).

### P0 — Implemented on `feat/packaging-p0-release-pipeline`
1. **Documentation & Topology Alignment:**
   - Updated `README.md` with a 2-second **"Choose Your Setup"** decision table across all 4 surfaces and accurate Engine-First DB locations.
   - Reconciled `deploy/playback-engine/README.md` with `install.py` redeploy semantics, Standard vs. Hardened profiles, kernel 5.6+ (`openat2`) requirements, and `release.yml` publishing.
   - Fixed `.env.example` `compose.yaml` typo, fixed `deploy/truenas-dragonfish/custom-app-24.04.yaml` image reference (`ghcr.io/matbhuvi-tech/cadence-playback-engine`), and marked `deploy/truenas-dragonfish/` clearly as legacy.
2. **Default SMB + Opt-In Hardened Container Profile:**
   - Added `deploy/playback-engine/compose.hardened.yml` while keeping `deploy/playback-engine/compose.yml` as the SMB-capable default.
   - Updated `deploy/playback-engine/install.py` with profile selection (default `1` Standard SMB, option `2` Hardened Read-Only), pre-release tag fallback when `/releases/latest` is absent, and profile-specific template & `mount.cifs` validation.
   - Repaired and expanded `deploy/playback-engine/test_installer.py`.
3. **Unified Version Sync & Multi-Artifact Draft Release Pipeline (`.github/workflows/release.yml`):**
   - Added `scripts/release/sync_version.py` + `test_sync_version.py` to keep `package.json`, `package-lock.json`, `pwa/package.json`, `pwa/package-lock.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, and Android `versionCode`/`versionName` aligned to `v*` git tags.
   - Added `--version` / `-V` and `--help` / `-h` smoke-test flags to `cadence-headless` and `--version` / `-V` to `cadence-engine`, plus `[profile.release]` (`strip = "symbols"`, `lto = "thin"`) in `src-tauri/Cargo.toml` and `-RequireInstaller` in `build-windows-engine.ps1`.
   - Replaced `playback-engine-image.yml` with `.github/workflows/release.yml` building all 4 surfaces (Windows Desktop NSIS, Windows Engine NSIS, Linux `amd64`/`arm64` OCI + standalone tarballs, Android APK), generating `cadence_checksums.txt`, attaching `actions/attest-build-provenance`, and emitting a **Draft GitHub Release**.
4. **Fast Native Multi-Arch Docker Build:**
   - Eliminated QEMU ARM64 compilation in favor of native `ubuntu-24.04` + `ubuntu-24.04-arm` digest builds merged via `docker buildx imagetools create`.
   - Added `cargo fetch` dependency caching, BuildKit cache mounts (`registry`, `git`, `target`), GHA build cache (`type=gha`), and `FROM scratch AS binary` extraction in `deploy/playback-engine/Dockerfile`.

### P1 — Implemented on `feat/packaging-p1-ux-platform`
5. **Unified Windows Installer, Firewall Helper & Windows Service Mode:**
   - Added [`deploy/windows-suite/cadence-suite.nsi`](../deploy/windows-suite/cadence-suite.nsi) and `build-windows-suite.ps1` producing `Cadence_<ver>_x64-setup.exe` with selectable components (*Cadence Desktop (Required)*, *Cadence Local Playback Engine (This PC)*, *Configure Windows Firewall*, and *Run Local Engine as Windows Service*).
   - Added Windows *Installed Apps* (`Uninstall`) registry registration (`DisplayVersion`, `EstimatedSize`, `QuietUninstallString`), single-UAC `Configure-CadenceHost.ps1`, reversible Tray ↔ Service switching sharing `%LOCALAPPDATA%\CadenceEngine` (preserving user libraries and identities), and [`deploy/windows-engine/Configure-CadenceFirewall.ps1`](../deploy/windows-engine/Configure-CadenceFirewall.ps1) (Private profile LAN rules for TCP `4040`/`18890` and UDP `1900`/`5353`) in `cadence-engine.nsi`.
   - Added native Windows SCM service support (`service install|uninstall|start|stop|status`, `--service-run`), SCM-backed service `--data-dir` discovery in `cadence-core` and `cadence-engine --doctor`, Start Menu GUI status dialogs (`--autostart` guard), and an embedded Windows 10/11 application manifest (`src-tauri/windows/cadence-engine.manifest`) to avoid Program Compatibility Assistant false warnings.
6. **Pre-Built Native Linux `.deb` & `.rpm` Packages (`nfpm`):**
   - Added [`deploy/playback-engine/nfpm/nfpm.yaml`](../deploy/playback-engine/nfpm/nfpm.yaml), hardened `cadence-playback-engine.service`, and `preinstall.sh`/`postinstall.sh`/`preremove.sh` creating system `cadence` user/group (preferring UID/GID `568`), `/etc/cadence/playback-engine.env`, and `/var/lib/cadence` (`0700`) with zero FFmpeg dependencies.
   - Integrated pinned `goreleaser/nfpm` (`v2.49.0`) SHA256-verified packaging into `.github/workflows/release.yml` for `linux/amd64` and `linux/arm64` `.deb` and `.rpm` artifacts plus `dpkg-deb` smoke checks.
7. **Unified Engine CLI & Complete Backups (`--doctor`, `--backup`/`--restore` Parity):**
   - Added `src-tauri/src/core_runtime/doctor.rs` shared read-only diagnostics (`--doctor` checking data dir, identity/TLS/`pairing-token`, SQLite `PRAGMA integrity_check(20)` & `foreign_key_check`, memory/lock limits, and live readiness) and `--data-dir`/`--port`/`CADENCE_DATA_DIR` aliases across `cadence-headless` and `cadence-engine`.
   - Extended `cadence-engine` with `--backup`, `--restore` (guarded against running daemon or Windows service), and `--doctor`, and updated `create_versioned_backup_at` / `restore_versioned_backup` to include `pairing-token` and `localhost-pairing.json` with `0o600` Unix permissions.
8. **Cryptographic Digest Verification in `install.sh` & `install.py`:**
   - Updated `deploy/playback-engine/install.sh` and `install.py` to fetch `cadence_checksums.txt` and verify `install.py` and remote `compose*.yml` templates via SHA256 fail-closed (unless `CADENCE_ALLOW_UNVERIFIED=1`), covered by expanded tests in `test_installer.py`.

### P2 — Ecosystem Scale
9. **Winget Manifest Automation & Idle-Safe Update Check:** Automated Winget PRs on stable releases + strictly user-triggered/idle-only update check UI in Desktop.
10. **Windows Authenticode & Production Android Release Distribution:** OSS code signing for Windows installers and release-signed Android APK (plus F-Droid / Obtainium metadata).
11. **Structured `docs/installation/` Site & PR `nightly.link` Artifacts:** Dedicated VitePress GitHub Pages site (`website/` + `.github/workflows/docs.yml`) providing platform installation pages, CLI/configuration reference, and backup/troubleshooting guides; remaining P2 items: PR `nightly.link` artifacts and optional macOS thin-frontend `.dmg` evaluation.


### Native Linux packaging follow-up (2026-11-21)

- `nfpm.yaml` is tracked in Git; the local `.git/info/exclude` wildcard does not remove tracked files. Added a local exception to make that intent explicit.
- Standalone binaries and both package formats retain the Debian 12 build baseline: **glibc >= 2.36**, Linux kernel 5.6+, systemd/cgroup v2 for the service. Package-specific dependencies now prevent installation on older glibc hosts.
- Release CI now installs each generated `.deb` on Debian 12 and `.rpm` on Fedora 43, checks CLI execution and installed ownership/modes on native amd64 and arm64 runners before artifact upload.
- These are container-based packaging checks, not full systemd startup or audio playback validation. Successful CI generation and artifacts remain unverified until a workflow run completes.
