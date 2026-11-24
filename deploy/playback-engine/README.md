# Cadence Playback Engine for Linux

> 🌐 **Online Documentation:** Formatted setup, configuration, and troubleshooting guides are available on the [Cadence Documentation Site](https://matbhuvi-tech.github.io/Cadence/docs/installation/) ([Docker](https://matbhuvi-tech.github.io/Cadence/docs/installation/docker), [TrueNAS SCALE](https://matbhuvi-tech.github.io/Cadence/docs/installation/truenas), [Linux Native `.deb`/`.rpm`](https://matbhuvi-tech.github.io/Cadence/docs/installation/linux)).

This package runs the headless Playback Engine and its UPnP renderer (`cadence-headless --dragonfish`). The image supports `linux/amd64` and `linux/arm64`. Linux host networking is required for discovery and for a renderer to reach the advertised media address. The engine listens on TCP 4040 (TLS control), TCP 18890 (media), and UDP 1900 (SSDP); do not expose them to the internet. The host LAN IPv4 must be reachable from controllers and the renderer.

**Linux Host Requirements:** Requires Linux kernel **5.6+** (`openat2` path containment; unsupported kernels fail closed). Symlinks beneath library roots are rejected.

## Deployment Profiles

Cadence offers two Docker Compose profiles so you can choose between in-app SMB mounting (default) and strict non-root isolation:

| Profile | Template | User / Capabilities | Music Access | Runtime SMB Shares (`mount.cifs`) |
| :--- | :--- | :--- | :--- | :--- |
| **Standard *(Default)*** | `compose.yml` | `user: 0:0`, `IPC_LOCK`, `SYS_ADMIN`, `DAC_READ_SEARCH`, `DAC_OVERRIDE`, `apparmor:unconfined` | Read/Write (`CADENCE_MUSIC_READ_ONLY=false`); local folder optional | **Enabled** (add SMB shares directly inside Cadence UI) |
| **Hardened Read-Only *(Optional)*** | `compose.hardened.yml` | `user: 568:568`, `IPC_LOCK` only, AppArmor enforced | Read-Only (`:ro`, `CADENCE_MUSIC_READ_ONLY=true`); local/NAS folder required | **Disabled** (mount host/NAS folders at `/music` externally) |

> **Why does the default Standard profile run as root with `SYS_ADMIN`?** Linux kernel `mount.cifs` requires `SYS_ADMIN` and `DAC_READ_SEARCH` inside the container to mount remote SMB shares on demand from the Cadence UI. The engine still keeps app-data files accessible to UID/GID `568` (`cadence`) for compatibility. If you already mount your NAS/local music on the host and do not need runtime SMB mounting or Curate tag writes, choose **Hardened Read-Only** (`compose.hardened.yml`).

## Guided setup (First Install & Repeatable Redeploy)

For installation or upgrade on an AMD64 or ARM64 Linux or TrueNAS SCALE machine, download `install.sh` (or `Cadence.PlaybackEngine_<ver>_Linux-setup.zip`) from the [Cadence GitHub Releases](https://github.com/matbhuvi-tech/Cadence/releases) page, open a terminal in the downloaded file's folder, and run:

```sh
sh install.sh
```

The wizard:
1. Verifies downloaded release artifacts (`install.py`, `backup.py`, and remote `compose.yml` / `compose.hardened.yml` templates) against the release's `cadence_checksums.txt` manifest (failing closed on mismatch or missing manifest unless `CADENCE_ALLOW_UNVERIFIED=1` is explicitly set).
2. Suggests the latest published release (including pre-releases) and the machine's LAN IPv4 address.
3. Prompts you to choose **1. Standard (Default — SMB mounting & Curate read/write)** or **2. Hardened Read-Only (Non-root UID 568, `/music:ro`, no runtime SMB)**.
4. Selects your music folder (optional in **Standard** mode if you plan to add SMB shares in Cadence; required in **Hardened Read-Only** mode). Internal engine data (`/var/lib/cadence`) automatically uses a **Docker-managed persistent volume (`cadence_data`)**, eliminating manual data-directory permission setup while preserving state across upgrades.
5. Probes music folder permissions as UID/GID `568` (if a local music folder is mounted), validates the Compose template, pulls the GHCR image, and starts the engine.

- **Linux hosts:** On Debian/Ubuntu, missing `python3`, `curl`, `docker`, and Compose v2 packages are installed from configured `apt` repositories (an administrator password may be requested). On other distributions, install Docker Engine, the Compose v2 plugin, Python 3, and `curl` first, and ensure Docker is running.
- **TrueNAS SCALE 25.10 or later:** Configure the Apps pool in TrueNAS first, then download `install.sh` to the NAS and run `sudo sh install.sh` in the TrueNAS shell. If mounting a local music folder, provide an existing path under `/mnt` and grant UID/GID `568` read/traverse ACL access to music (no manual ACL changes are required for internal Cadence app data). The installer submits a custom app through TrueNAS middleware (`midclt`) so it appears under **Apps** without installing OS packages into TrueNAS. Use the Apps screen for status and logs. TrueNAS 24.10/25.04 users can use the manual YAML method below; the automated API path has not been verified on those versions.
- **Re-running on an existing installation:** `install.sh` / `install.py` supports repeatable redeploys (including on the same release tag). When an existing installer-managed directory is detected (`~/cadence-playback-engine` on Linux or `<pool>/cadence-installation` on TrueNAS), it backs up `.env` and `compose.yml` into `backup-before-redeploy-<timestamp>` before applying changes and restores them automatically if Compose validation fails. If the existing installation still uses a legacy host bind mount (`CADENCE_HOST_DATA_DIR`), `install.py` automatically migrates existing `cadence.db`/identity state into the Docker-managed `cadence_data` volume (leaving the old host folder untouched as a rollback copy). The generated `pairing-token` remains private in `/var/lib/cadence`.

## Manual Docker Compose

1. Install Docker Engine and Compose v2 on Linux. Choose a published release tag from [Cadence Releases](https://github.com/matbhuvi-tech/Cadence/releases) and ensure the GHCR package (`ghcr.io/matbhuvi-tech/cadence-playback-engine`) is accessible. Pin a release tag or immutable digest for predictable upgrades (`latest` follows stable releases only).
2. Copy `.env.example` to `.env`, and copy either **`compose.yml`** (Standard SMB default) or **`compose.hardened.yml`** (Hardened Read-Only) into the deployment directory (renaming `compose.hardened.yml` to `compose.yml` if using default Compose discovery, or passing `-f compose.hardened.yml`). Set `CADENCE_IMAGE`, `CADENCE_ADVERTISED_IP`, and (if mounting local music) `CADENCE_HOST_MUSIC_DIR`. Internal engine data (`/var/lib/cadence`) is persisted automatically in the Docker-managed `cadence_data` volume.
   - In **Standard (`compose.yml`)**, if you want SMB-only mode without a host `/music` mount, remove the volume block between `# LOCAL_MUSIC_VOLUME_START` and `# LOCAL_MUSIC_VOLUME_END`.
   - Ensure UID/GID `568` has read/traverse access to `CADENCE_HOST_MUSIC_DIR` if mounted (use dataset ACLs on NAS shares rather than `chmod`/`chown` on shared libraries).
3. Run `docker compose config` to review the configuration, then `docker compose pull` and `docker compose up -d`. Inspect `docker compose ps` and `docker compose logs playback-engine`. Connect from Cadence Desktop or Mobile Remote using auto-discovery or `https://<CADENCE_ADVERTISED_IP>:4040`.

Both templates store state in a persistent volume outside the container layer, grant `IPC_LOCK` with unlimited `memlock`, place a 4 GiB cgroup memory limit on the service (increase for larger tracks while accounting for host RAM and ZFS ARC, as locked memory is non-pageable), and configure a local HTTPS readiness probe every 60 seconds.

Multiple mounted library roots can be listed in `CADENCE_BROWSE_ROOTS` separated by `:`. Each must be an actual mounted directory distinct from application data. Optional environment variables include `CADENCE_HEADROOM_MB`, `CADENCE_MIN_LOCKABLE_MB`, and `CADENCE_PINNED_RS130_UDN` (`CADENCE_ALLOW_LOOPBACK` is for tests only). Keep music paths stable across upgrades so catalog paths continue to resolve.

## TrueNAS SCALE 24.10 and later (Manual Custom App YAML)

Modern TrueNAS SCALE uses Docker Compose. In **Apps > Discover Apps > more menu > Install via YAML**, paste `compose.yml` (Standard SMB) or `compose.hardened.yml` (Hardened Read-Only) into Custom Config. Replace *all* `${...}` expressions with literal values (published image tag, TrueNAS LAN IPv4, and absolute music dataset path if mounting `/music`). Do not rely on a local `.env` file in the UI. Internal app data is handled automatically via the `cadence_data` Docker volume — no manual ACL setup is needed for `/var/lib/cadence`. If mounting `/music`, grant UID/GID `568` read/traverse ACLs on your music dataset. Ensure host networking and `IPC_LOCK` are accepted. See [TrueNAS custom app instructions](https://apps.truenas.com/managing-apps/installing-custom-apps/). Dragonfish 24.04 uses a legacy Kubernetes app system; see [`deploy/truenas-dragonfish/`](../truenas-dragonfish/README.md).

## Native Linux systemd

**Native compatibility:** These dynamically linked binaries are built on Debian 12 and require **glibc >= 2.36** (including the tarball). Older hosts such as Ubuntu 22.04 and RHEL 9 cannot run them; use the container deployment instead. Packages declare their runtime dependencies. Native installs also require Linux kernel 5.6+, systemd and cgroup v2.

Pre-built **`.deb`** and **`.rpm`** packages are generated by the release workflow for `amd64` and `arm64` (zero FFmpeg dependency) alongside standalone `.tar.gz` archives on [Cadence Releases](https://github.com/matbhuvi-tech/Cadence/releases):

- **Debian / Ubuntu (`.deb`):** `sudo apt install ./Cadence.PlaybackEngine_<ver>_linux_<arch>.deb`
- **Fedora / RHEL (`.rpm`):** `sudo dnf install ./Cadence.PlaybackEngine_<ver>_linux_<arch>.rpm`

The package creates the system `cadence` user/group (preferring UID/GID `568`), `/var/lib/cadence` (`0700`), `/etc/cadence/playback-engine.env` (`0640`, preserved across upgrades), installs the binary at `/usr/bin/cadence-headless`, and installs `/usr/lib/systemd/system/cadence-playback-engine.service`. Edit `/etc/cadence/playback-engine.env` to set your LAN address and music roots, ensure `cadence` has read/traverse access to your music directory, then run:

```sh
sudo systemctl enable --now cadence-playback-engine
sudo -u cadence cadence-headless --doctor --data-dir /var/lib/cadence
```

For manual installations from `Cadence.PlaybackEngine_<ver>_linux_<arch>.tar.gz` (or building from source with `cargo build --locked --release --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite --bin cadence-headless`), install `cadence-headless` as `/usr/local/bin/cadence-headless`, create a non-root UID/GID `568` user, `/var/lib/cadence` writable by that identity, and a readable `/music` mount. Copy `playback-engine.env.example` to `/etc/cadence/playback-engine.env`, install `deploy/playback-engine/cadence-playback-engine.service` to `/etc/systemd/system/`, adjust `ReadWritePaths` and `MemoryMax`, run `systemctl daemon-reload`, and start with `systemctl enable --now cadence-playback-engine`. Both setups assume `systemd`, `cgroup v2`, and permission to grant `CAP_IPC_LOCK`.

## Persistence, upgrades and rollback

The data volume (`/var/lib/cadence`) contains the SQLite database and WAL, engine identity, TLS keys/certificate, `pairing-token`, `localhost-pairing.json`, and internal backups. Versioned backups (`--backup <tag>` / `--restore <tag>`) create an atomic SQLite snapshot and include node identity, TLS files, `pairing-token`, and `localhost-pairing.json` (restoring secret files with `0600` permissions on Unix).

> **Important (Managed Volume Lifecycle):** The `cadence_data` Docker volume persists across container restarts, image pulls, and upgrades (`docker compose up -d` / TrueNAS `app.update`), **but deleting the app with volumes removed (`docker compose down -v` or TrueNAS "Remove volumes") permanently deletes Cadence's database and pairing credentials.** Export a backup to a separate dataset or off-box location before uninstalling or migrating hosts.

### Export / Restore to a Custom Host Location (`backup.py`)

`install.sh` stages `backup.py` inside your Cadence installation directory (`~/cadence-playback-engine` on Linux or `/mnt/<pool>/cadence-installation` on TrueNAS):

```sh
# Export an atomic backup archive (.tar.gz, 0600) to a custom host folder:
python3 backup.py export /mnt/tank/backups --stop

# Restore from an exported backup archive (verifies manifest & runs --doctor):
python3 backup.py restore /mnt/tank/backups/cadence-backup-YYYYMMDDTHHMMSSZ.tar.gz --stop

# Optional: migrate an older host bind-mount install (CADENCE_HOST_DATA_DIR) to the Docker-managed volume:
python3 backup.py migrate-to-volume --stop
```

(`--stop` cleanly stops the engine before the snapshot/restore and restarts it automatically afterward. Omit `--stop` if you already stopped the service manually. `migrate-to-volume` leaves your original host directory untouched as a rollback copy.)

### Manual Upgrade & Rollback

Before upgrading, stop playback and the service (`docker compose stop`), wait for it to exit, then run an offline backup using the **old** image:

```sh
docker compose run --rm --no-deps playback-engine --backup pre-upgrade-YYYYMMDD
```

Use a unique tag (reusing a tag replaces that backup), verify you can access your backup files, and record the old image tag/digest. Update `CADENCE_IMAGE` to the new published release tag, run `docker compose pull` and `docker compose up -d`, then inspect status and run read-only diagnostics (`docker compose exec playback-engine /usr/local/bin/cadence-headless --doctor` or `sudo -u cadence cadence-headless --doctor --data-dir /var/lib/cadence`). Never run `--backup` or `--restore` concurrently with a running daemon.

To roll back, stop the service, restore with the matching old image's `--restore pre-upgrade-YYYYMMDD` (or run `python3 backup.py restore <archive> --stop`), pin `CADENCE_IMAGE` back to the old version, and start the service. For `systemd`, run `systemctl stop cadence-playback-engine`, invoke `cadence-headless --data-dir /var/lib/cadence --backup <tag>` or `--restore <tag>` as user `cadence`, and start the service again (`--doctor` verifies SQLite integrity, identity/TLS/`pairing-token`, memory-lock limits, and live readiness).

## Publishing

Pushing a version tag (`v*`) triggers [`.github/workflows/release.yml`](../../.github/workflows/release.yml), which verifies tests, builds native `linux/amd64` and `linux/arm64` OCI images (no QEMU emulation) + Linux `.tar.gz`/`.deb`/`.rpm` packages, Windows Unified Suite + standalone Desktop & Playback Engine NSIS installers, and the Android Remote APK, merges the multi-arch GHCR manifest (`ghcr.io/matbhuvi-tech/cadence-playback-engine`), attaches `cadence_checksums.txt` and build provenance attestations, and creates a **Draft** GitHub Release. Stable tags (`vX.Y.Z` without pre-release suffix) also update `:latest`. Ensure GHCR package visibility is configured as public by the repository owner.
