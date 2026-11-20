# Cadence Playback Engine for Linux

This package runs the headless Playback Engine and its UPnP renderer (`cadence-headless --dragonfish`). The image supports `linux/amd64` and `linux/arm64`. Linux host networking is required for discovery and for a renderer to reach the advertised media address. The engine listens on TCP 4040 (TLS control), TCP 18890 (media), and UDP 1900 (SSDP); do not expose them to the internet. The host LAN IPv4 must be reachable from controllers and the renderer.

**Linux Host Requirements:** Requires Linux kernel **5.6+** (`openat2` path containment; unsupported kernels fail closed). Symlinks beneath library roots are rejected.

## Deployment Profiles

Cadence offers two Docker Compose profiles so you can choose between in-app SMB mounting (default) and strict non-root isolation:

| Profile | Template | User / Capabilities | Music Access | Runtime SMB Shares (`mount.cifs`) |
| :--- | :--- | :--- | :--- | :--- |
| **Standard *(Default)*** | `compose.yml` | `user: 0:0`, `IPC_LOCK`, `SYS_ADMIN`, `DAC_READ_SEARCH`, `apparmor:unconfined` | Read/Write (`CADENCE_MUSIC_READ_ONLY=false`); local folder optional | **Enabled** (add SMB shares directly inside Cadence UI) |
| **Hardened Read-Only *(Optional)*** | `compose.hardened.yml` | `user: 568:568`, `IPC_LOCK` only, AppArmor enforced | Read-Only (`:ro`, `CADENCE_MUSIC_READ_ONLY=true`); local/NAS folder required | **Disabled** (mount host/NAS folders at `/music` externally) |

> **Why does the default Standard profile run as root with `SYS_ADMIN`?** Linux kernel `mount.cifs` requires `SYS_ADMIN` and `DAC_READ_SEARCH` inside the container to mount remote SMB shares on demand from the Cadence UI. The engine still keeps app-data files accessible to UID/GID `568` (`cadence`) for compatibility. If you already mount your NAS/local music on the host and do not need runtime SMB mounting or Curate tag writes, choose **Hardened Read-Only** (`compose.hardened.yml`).

## Guided setup (First Install & Repeatable Redeploy)

For installation or upgrade on an AMD64 or ARM64 Linux or TrueNAS SCALE machine, download `install.sh` (or `Cadence.PlaybackEngine_<ver>_Linux-setup.zip`) from the [Cadence GitHub Releases](https://github.com/matbhuvi-tech/Cadence/releases) page, open a terminal in the downloaded file's folder, and run:

```sh
sh install.sh
```

The wizard:
1. Suggests the latest published release (including pre-releases) and the machine's LAN IPv4 address.
2. Prompts you to choose **1. Standard (Default — SMB mounting & Curate read/write)** or **2. Hardened Read-Only (Non-root UID 568, `/music:ro`, no runtime SMB)**.
3. Selects your music folder (optional in **Standard** mode if you plan to add SMB shares in Cadence; required in **Hardened Read-Only** mode) and a separate persistent engine data folder.
4. Probes host directory permissions as UID/GID `568`, downloads/validates the matching Compose template (`compose.yml` or `compose.hardened.yml`), pulls the GHCR image, and starts the engine.

- **Linux hosts:** On Debian/Ubuntu, missing `python3`, `curl`, `docker`, and Compose v2 packages are installed from configured `apt` repositories (an administrator password may be requested). On other distributions, install Docker Engine, the Compose v2 plugin, Python 3, and `curl` first, and ensure Docker is running.
- **TrueNAS SCALE 25.10 or later:** Configure the Apps pool in TrueNAS first, then download `install.sh` to the NAS and run `sudo sh install.sh` in the TrueNAS shell. Provide existing paths under `/mnt` (the parent of a new data folder must already exist). The installer submits a custom app through TrueNAS middleware (`midclt`) so it appears under **Apps** without installing OS packages into TrueNAS. Grant UID/GID `568` read/traverse ACL access to music and write access to an existing data folder; a new data folder is assigned to `568:568`. Use the Apps screen for status and logs. TrueNAS 24.10/25.04 users can use the manual YAML method below; the automated API path has not been verified on those versions.
- **Re-running on an existing installation:** `install.sh` / `install.py` supports repeatable redeploys (including on the same release tag). When an existing installer-managed directory is detected (`~/cadence-playback-engine` on Linux or `<pool>/cadence-installation` on TrueNAS), it backs up `.env` and `compose.yml` into `backup-before-redeploy-<timestamp>` before applying changes and restores them automatically if Compose validation fails. It refuses to overwrite unrecognized or unmanaged containers/apps; if an aborted first setup left files behind, check that no engine is running before moving configuration files aside (always keep your persistent data directory). The generated `pairing-token` remains private in the data directory.

## Manual Docker Compose

1. Install Docker Engine and Compose v2 on Linux. Choose a published release tag from [Cadence Releases](https://github.com/matbhuvi-tech/Cadence/releases) and ensure the GHCR package (`ghcr.io/matbhuvi-tech/cadence-playback-engine`) is accessible. Pin a release tag or immutable digest for predictable upgrades (`latest` follows stable releases only).
2. Copy `.env.example` to `.env`, and copy either **`compose.yml`** (Standard SMB default) or **`compose.hardened.yml`** (Hardened Read-Only) into the deployment directory (renaming `compose.hardened.yml` to `compose.yml` if using default Compose discovery, or passing `-f compose.hardened.yml`). Set `CADENCE_IMAGE`, `CADENCE_ADVERTISED_IP`, `CADENCE_HOST_DATA_DIR`, and `CADENCE_HOST_MUSIC_DIR` to your actual image, LAN IPv4, and **existing absolute** host directories.
   - In **Standard (`compose.yml`)**, if you want SMB-only mode without a host `/music` mount, remove the volume block between `# LOCAL_MUSIC_VOLUME_START` and `# LOCAL_MUSIC_VOLUME_END`.
   - Ensure UID/GID `568` has write access to `CADENCE_HOST_DATA_DIR` and read/traverse access to `CADENCE_HOST_MUSIC_DIR` (use dataset ACLs on NAS shares rather than `chmod`/`chown` on shared libraries).
3. Run `docker compose config` to review the configuration, then `docker compose pull` and `docker compose up -d`. Inspect `docker compose ps` and `docker compose logs playback-engine`. Connect from Cadence Desktop or Mobile Remote using auto-discovery or `https://<CADENCE_ADVERTISED_IP>:4040`.

Both templates store state outside the container, grant `IPC_LOCK` with unlimited `memlock`, place a 4 GiB cgroup memory limit on the service (increase for larger tracks while accounting for host RAM and ZFS ARC, as locked memory is non-pageable), and configure a local HTTPS readiness probe every 60 seconds.

Multiple mounted library roots can be listed in `CADENCE_BROWSE_ROOTS` separated by `:`. Each must be an actual mounted directory distinct from application data. Optional environment variables include `CADENCE_HEADROOM_MB`, `CADENCE_MIN_LOCKABLE_MB`, and `CADENCE_PINNED_RS130_UDN` (`CADENCE_ALLOW_LOOPBACK` is for tests only). Keep music paths stable across upgrades so catalog paths continue to resolve.

## TrueNAS SCALE 24.10 and later (Manual Custom App YAML)

Modern TrueNAS SCALE uses Docker Compose. Prepare separate persistent datasets for engine data and music with the UID/GID `568` ACLs described above. In **Apps > Discover Apps > more menu > Install via YAML**, paste `compose.yml` (Standard SMB) or `compose.hardened.yml` (Hardened Read-Only) into Custom Config. Replace *all* `${...}` expressions with literal values (published image tag, TrueNAS LAN IPv4, absolute dataset paths quoted if containing spaces). Do not rely on a local `.env` file in the UI. Verify dataset ACLs rather than assuming a preset, and ensure host networking and `IPC_LOCK` are accepted. See [TrueNAS custom app instructions](https://apps.truenas.com/managing-apps/installing-custom-apps/). Dragonfish 24.04 uses a legacy Kubernetes app system; see [`deploy/truenas-dragonfish/`](../truenas-dragonfish/README.md).

## Native Linux systemd

Download the standalone `Cadence.PlaybackEngine_<ver>_linux_<arch>.tar.gz` binary archive from [Cadence Releases](https://github.com/matbhuvi-tech/Cadence/releases) (or build from source on a Linux build host with `cargo build --locked --release --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite --bin cadence-headless`). Install `cadence-headless` as `/usr/local/bin/cadence-headless`, create a non-root UID/GID `568` user, `/var/lib/cadence` writable by that identity, and a readable `/music` mount. Copy `playback-engine.env.example` to `/etc/cadence/playback-engine.env`, set the LAN address and paths, and install `cadence-playback-engine.service` to `/etc/systemd/system/`. Adjust `ReadWritePaths`, identity, and `MemoryMax` to match the host (music and data must be separate directories). Run `systemctl daemon-reload`, `systemctl enable --now cadence-playback-engine`, and inspect `journalctl -u cadence-playback-engine`. This setup assumes `systemd`, `cgroup v2`, and permission to grant `CAP_IPC_LOCK`.

## Persistence, upgrades and rollback

The data directory contains the SQLite database and WAL, engine identity, TLS keys/certificate, `pairing-token`, and backups. Preserve the **entire** directory, restrict access, and back it up separately from the music library. The built-in versioned backup includes a consistent SQLite snapshot and identity/TLS files, but **does not include `pairing-token`**; back up that secret separately or copy the entire stopped data directory.

Before upgrading, stop playback and the service (`docker compose stop`), wait for it to exit, then run an offline backup using the **old** image:

```sh
docker compose run --rm --no-deps playback-engine --backup pre-upgrade-YYYYMMDD
```

Use a unique tag (reusing a tag replaces that backup), take an independent copy/snapshot of the complete stopped data directory (including `pairing-token`), and record the old image tag/digest. Update `CADENCE_IMAGE` to the new published release tag, run `docker compose pull` and `docker compose up -d`, then verify logs, readiness, pairing, and playback. Never run `--backup` or `--restore` concurrently with the daemon.

To roll back, stop the service, restore the complete pre-upgrade data-directory snapshot (including `pairing-token`)—or run the matching old image's `--restore pre-upgrade-YYYYMMDD` plus restore your saved token—pin `CADENCE_IMAGE` back to the old version, and start the service. For `systemd`, run `systemctl stop cadence-playback-engine`, invoke `/usr/local/bin/cadence-headless --app-data-dir /var/lib/cadence --backup <tag>` or `--restore <tag>` as UID `568`, and start the service again.

## Publishing

Pushing a version tag (`v*`) triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml), which verifies tests, builds native `linux/amd64` and `linux/arm64` OCI images (no QEMU emulation) + standalone Linux tarballs, Windows Desktop and Playback Engine NSIS installers, and the Android Remote APK, merges the multi-arch GHCR manifest (`ghcr.io/matbhuvi-tech/cadence-playback-engine`), attaches `cadence_checksums.txt` and build provenance attestations, and creates a **Draft** GitHub Release. Stable tags (`vX.Y.Z` without pre-release suffix) also update `:latest`. Ensure GHCR package visibility is configured as public by the repository owner.
