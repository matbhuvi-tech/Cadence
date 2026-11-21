# TrueNAS SCALE Installation

Cadence provides native **TrueNAS SCALE 25.10+** custom-app deployment via middleware (`midclt`), installing **zero extra OS packages** on the NAS host.

## Prerequisites

1. TrueNAS SCALE **25.10 or later** with an Apps pool configured in **Apps → Configuration**. *(TrueNAS 24.10 / 25.04 can use manual Custom App YAML below; Dragonfish 24.04 legacy Kubernetes users see [`deploy/truenas-dragonfish/README.md`](https://github.com/matbhuvi-tech/Cadence/blob/main/deploy/truenas-dragonfish/README.md).)*
2. Two **separate** host datasets/directories under `/mnt/<pool>/...`:
   - **Data folder** (e.g., `/mnt/tank/apps/cadence-data`): persistent `cadence.db`, TLS cert, identity, `pairing-token`, and backups. Writable by **UID/GID `568` (`apps`)**.
   - **Music folder** (e.g., `/mnt/tank/music`): readable (`read` + `execute/traverse` on directories) by **UID/GID `568`**. Never run recursive `chmod`/`chown` blindly on shared NAS datasets — grant UID/GID `568` via TrueNAS Dataset ACLs.

## Option 1: Guided Setup (`midclt` Custom App — Recommended)

Download `install.sh` (or `Cadence.PlaybackEngine_<ver>_Linux-setup.zip`) from [**GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases) onto your TrueNAS host and run in the TrueNAS shell:

```sh
sudo sh install.sh
```

How the TrueNAS wizard behaves:

- Verifies `install.py` and Compose manifests against `cadence_checksums.txt` over HTTPS before running.
- Detects TrueNAS (`midclt`) and refuses to invoke `apt` or modify base system packages.
- Lets you choose **1. Standard (Default — SMB mounting & Curate read/write)** or **2. Hardened Read-Only (`568:568`, `/music:ro`, AppArmor enforced)**.
- Probes your chosen paths non-destructively as UID `568` (`test_as_cadence`), deploys the Custom App via `midclt call app.create` / `app.update`, and stores `.env` / Compose backup snapshots in `<pool>/cadence-installation`.

After setup, monitor container status, readiness, and logs directly from the **TrueNAS Apps** UI.

## Option 2: Manual Custom App YAML (TrueNAS 24.10+)

1. Open **Apps → Discover Apps → menu → Install via YAML**.
2. Paste either [`compose.yml`](https://github.com/matbhuvi-tech/Cadence/blob/main/deploy/playback-engine/compose.yml) (Standard SMB) or [`compose.hardened.yml`](https://github.com/matbhuvi-tech/Cadence/blob/main/deploy/playback-engine/compose.hardened.yml) (Hardened Read-Only).
3. Replace **every** `${...}` variable with literal values (published image tag, TrueNAS LAN IPv4 address, absolute `/mnt/...` paths — TrueNAS YAML UI does not load a `.env` file).
4. Ensure **Host Network** (`network_mode: host`) and **`IPC_LOCK`** capability remain enabled so SSDP/mDNS discovery and `mlock` RAM pinning work.

::: tip Memory Limits vs. ZFS ARC
Because locked track buffers (`mlock`) cannot be swapped out, keep container `mem_limit` (`4g` default) well below `Host RAM − ZFS ARC target` so TrueNAS never faces memory pressure.
:::
