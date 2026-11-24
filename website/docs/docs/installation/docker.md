# Docker & Compose Installation

The Cadence Linux Playback Engine (`ghcr.io/matbhuvi-tech/cadence-playback-engine`) runs `cadence-headless --dragonfish` on `linux/amd64` and `linux/arm64` hosts with **no FFmpeg dependency**.

## Requirements

- **Linux kernel 5.6+** (`openat2` path containment is enforced; symlinks under library roots are rejected).
- **Docker Engine** and **Docker Compose v2** (`docker compose`).
- **Host networking** (`network_mode: host`) on a stable LAN IPv4 reachable by Desktop/Mobile controllers and UPnP renderers.

::: warning Firewall & Network Exposure
The engine listens on TCP `4040` (HTTPS control/SSE), TCP `18890` (UPnP HTTP media), and UDP `1900` / `5353` (SSDP/mDNS discovery). Keep these restricted to your private LAN — never expose them directly to the public internet.
:::

## Deployment Profiles

| Profile | Template | Container User / Capabilities | Music Access | In-App SMB Mounting |
| :--- | :--- | :--- | :--- | :--- |
| **Standard *(Default)*** | `compose.yml` | `user: 0:0`, `IPC_LOCK`, `SYS_ADMIN`, `DAC_READ_SEARCH`, `apparmor:unconfined` | Read/Write (`/music` optional) | **Enabled** (`mount.cifs` from UI) |
| **Hardened Read-Only *(Optional)*** | `compose.hardened.yml` | `user: 568:568`, `IPC_LOCK` only, AppArmor enforced | Read-Only (`/music:ro` required) | **Disabled** (host-mounted music) |

> **Why does the Standard profile request `SYS_ADMIN`?** Linux kernel `mount.cifs` requires `SYS_ADMIN` and `DAC_READ_SEARCH` inside the container to mount SMB shares from the Cadence UI. The engine still keeps persistent files in `/var/lib/cadence` accessible to UID/GID `568` (`cadence`). Choose `compose.hardened.yml` if you mount shares on the host and do not need Curate file writes.

## Option 1: Guided Setup (`install.sh`)

Download `install.sh` (or `Cadence.PlaybackEngine_<ver>_Linux-setup.zip`) from [**GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases) and run:

```sh
sh install.sh
```

What the wizard does:

1. Downloads `cadence_checksums.txt` over HTTPS (TLS 1.2+) and verifies `install.py`, `backup.py`, and remote `compose.yml` / `compose.hardened.yml` digests fail-closed before execution.
2. Detects available releases (including pre-releases) and suggests your host's LAN IPv4 address.
3. Prompts you to select **1. Standard (Default — SMB mounting)** or **2. Hardened Read-Only (Non-root UID 568)**.
4. Configures `/var/lib/cadence` automatically on the Docker-managed `cadence_data` persistent volume (no host data-directory permission setup required), checks UID/GID `568` read permissions on `/music` if mounted, validates `docker compose config`, pulls the image, and starts the container.
5. On Debian/Ubuntu hosts, offers to install missing `python3`, `curl`, `docker`, or Compose v2 packages from `apt`. On re-runs over `~/cadence-playback-engine`, it backs up `.env` and `compose.yml` automatically, migrates any legacy `CADENCE_HOST_DATA_DIR` install to `cadence_data`, and rolls back if validation fails.

## Option 2: Manual Docker Compose

1. Internal engine data (`/var/lib/cadence`) is stored automatically in the Docker-managed `cadence_data` volume. If mounting a local `/music` folder, ensure UID/GID `568` has read/traverse access to it.
2. Copy `deploy/playback-engine/.env.example` to `.env` alongside `compose.yml` (or `compose.hardened.yml`) and edit all values:

```dotenv
CADENCE_IMAGE=ghcr.io/matbhuvi-tech/cadence-playback-engine:v0.1.0-rc.3
CADENCE_ADVERTISED_IP=192.168.1.50
CADENCE_HOST_MUSIC_DIR=/srv/music
CADENCE_LABEL=Cadence Playback Engine
```

::: tip Optional SMB-Only Standard Setup
When using `compose.yml` (Standard profile) exclusively for in-app SMB shares without a local `/music` folder, remove the block between `# LOCAL_MUSIC_VOLUME_START` and `# LOCAL_MUSIC_VOLUME_END`.
:::

3. Validate and launch:

```sh
docker compose config
docker compose pull
docker compose up -d
```

4. Verify readiness and diagnostics:

```sh
docker compose ps
docker compose exec playback-engine /usr/local/bin/cadence-headless --doctor
```

Both Compose templates grant `IPC_LOCK`, `ulimits.memlock: -1`, a `4 GiB` container `mem_limit` (increase for very large single tracks while leaving host RAM headroom for ZFS ARC/OS), and a 60-second HTTPS `/healthz` healthcheck.

Multiple local library folders can be exposed by mounting them under separate container paths and setting `CADENCE_BROWSE_ROOTS=/music:/music2`. Keep container paths consistent across upgrades.
