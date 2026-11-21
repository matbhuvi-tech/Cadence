# Native Linux Installation (`.deb` / `.rpm` / `systemd`)

For bare-metal Linux servers, Cadence publishes pre-built **`.deb`**, **`.rpm`**, and standalone **`.tar.gz`** archives for **`amd64`** and **`arm64`** on [**GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases) — with **zero FFmpeg dependency**.

## System Requirements

- Linux kernel **5.6+** (`openat2` path containment).
- `systemd` with `cgroup v2` and permission to grant `CAP_IPC_LOCK` (`LimitMEMLOCK=infinity`).
- Architecture: `x86_64` (`amd64`) or `aarch64` (`arm64`).

## Option 1: Debian / Ubuntu (`.deb`) or Fedora / RHEL (`.rpm`)

Download the matching package for your architecture and install:

::: code-group
```sh [Debian / Ubuntu (.deb)]
sudo apt install ./Cadence.PlaybackEngine_<ver>_linux_<arch>.deb
```

```sh [Fedora / RHEL (.rpm)]
sudo dnf install ./Cadence.PlaybackEngine_<ver>_linux_<arch>.rpm
```
:::

### What the Package Configures

- System user and group `cadence` (preferring UID/GID `568` to match TrueNAS/Docker data volumes).
- Persistent data directory `/var/lib/cadence` (`0700`, owned by `cadence:cadence`).
- Environment file `/etc/cadence/playback-engine.env` (`0640`, preserved across package upgrades).
- Binary `/usr/bin/cadence-headless` and hardened unit `/usr/lib/systemd/system/cadence-playback-engine.service` (`CapabilityBoundingSet=CAP_IPC_LOCK`, `AmbientCapabilities=CAP_IPC_LOCK`, `LimitMEMLOCK=infinity`, `MemoryMax=4G`, `ProtectSystem=strict`, `ProtectHome=yes`).

### Configure & Start

1. Edit `/etc/cadence/playback-engine.env` with your LAN IPv4 address and music folder(s):

```dotenv
CADENCE_ADVERTISED_IP=192.168.1.50
CADENCE_APP_DATA_DIR=/var/lib/cadence
CADENCE_MUSIC_DIR=/music
CADENCE_BROWSE_ROOTS=/music
CADENCE_MUSIC_READ_ONLY=true
CADENCE_LABEL="Cadence Playback Engine"
```

2. Grant `cadence` read/traverse permission to your music directory (e.g., POSIX ACLs or shared group) — remember symlinks inside library roots are rejected.
3. Enable, start, and verify health:

```sh
sudo systemctl enable --now cadence-playback-engine
sudo -u cadence cadence-headless --doctor --data-dir /var/lib/cadence
```

## Option 2: Portable `.tar.gz` Archive

For distributions without `apt`/`dnf` (or custom prefixes):

1. Extract `Cadence.PlaybackEngine_<ver>_linux_<arch>.tar.gz` and install `cadence-headless` to `/usr/local/bin/cadence-headless` (`chmod 0755`).
2. Create system user/group `cadence` (UID/GID `568` recommended) and writable `/var/lib/cadence`.
3. Copy [`playback-engine.env.example`](https://github.com/matbhuvi-tech/Cadence/blob/main/deploy/playback-engine/playback-engine.env.example) to `/etc/cadence/playback-engine.env` and [`cadence-playback-engine.service`](https://github.com/matbhuvi-tech/Cadence/blob/main/deploy/playback-engine/nfpm/cadence-playback-engine.service) to `/etc/systemd/system/cadence-playback-engine.service` (adjust `ExecStart=/usr/local/bin/cadence-headless --dragonfish` and `ReadWritePaths` as needed).
4. Reload and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cadence-playback-engine
sudo -u cadence /usr/local/bin/cadence-headless --doctor --data-dir /var/lib/cadence
```
