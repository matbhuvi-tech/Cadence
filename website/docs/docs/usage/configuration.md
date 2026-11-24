# Configuration & CLI Reference

Cadence Engines are configured via command-line flags and `CADENCE_*` environment variables (for Docker Compose `.env` and Linux `systemd` `/etc/cadence/playback-engine.env`).

## Network Ports

| Port | Protocol | Purpose | Exposure Recommendation |
| :--- | :--- | :--- | :--- |
| **`4040`** | TCP (`HTTPS` + SSE) | Control API v2, catalog paging, artwork serving, SSE events | Loopback & Private LAN only (`Configure-CadenceFirewall.ps1`) |
| **`18890`** | TCP (`HTTP`) | Adaptive paced UPnP / DLNA audio media stream | Private LAN only (reachable by UPnP renderers) |
| **`1900`** | UDP (`SSDP`) | UPnP renderer discovery (`M-SEARCH` / `NOTIFY`) | Private LAN multicast/broadcast |
| **`5353`** | UDP (`mDNS`) | Core engine advertisement (`_cadence-core._tcp.local.`) | Private LAN multicast |

## Data Directory Layout

| Platform / Mode | Default Location | Key Files Stored |
| :--- | :--- | :--- |
| **Windows (Tray & Installer Service)** | `%LOCALAPPDATA%\CadenceEngine` | `cadence.db`, `cadence.db-wal`, `node-identity.json`, `pairing-token`, `tls-cert.pem`, `tls-key.pem`, `tls-cert.json`, `localhost-pairing.json`, `renderer-profiles.json`, `service.log`, `backups\` |
| **Windows Service (CLI Default)** | `%ProgramData%\CadenceEngine` | Same layout when `cadence-engine service install` is invoked without `--data-dir` |
| **Linux (`systemd` / Docker / TrueNAS)** | `/var/lib/cadence` | Same layout (`0700` dir, `0600` secret files) |

## Environment Variables (`CADENCE_*`)

### Shared Engine Variables (`cadence-engine` & `cadence-headless`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CADENCE_DATA_DIR` / `CADENCE_APP_DATA_DIR` | Platform default | Override the persistent engine data directory (`CADENCE_DATA_DIR` takes precedence). |
| `CADENCE_BROWSE_ROOTS` | OS drive roots / `/music` | Path-separator-delimited list (`;` on Windows, `:` on Linux) of browsable music root directories. |
| `CADENCE_PAIRING_TOKEN` | Auto-generated (64 hex chars) | Custom persistent pairing secret (`32–256` URL-safe characters). |
| `CADENCE_RS130_DESC_URL` | Auto-discovered | Explicit UPnP device description XML URL override for RS130 endpoints. |
| `CADENCE_DISABLE_ENRICHMENT` | Unset (`enabled`) | Set to `1` to disable the background enrichment worker. |
| `CADENCE_DISABLE_ENRICHMENT_EXTERNAL` | Unset (`enabled`) | Set to `1` to keep enrichment strictly offline without external artwork lookups. |

### Linux Headless / Container Variables (`cadence-headless --dragonfish`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CADENCE_ADVERTISED_IP` | *(Required)* | Reachable host LAN IPv4 advertised over mDNS, UPnP URLs, and SAN TLS certificate. |
| `CADENCE_MUSIC_DIR` | `/music` | Primary music mount path inside container / host service. |
| `CADENCE_TMP_DIR` | `/tmp` | Temporary staging directory for atomic snapshots. |
| `CADENCE_MUSIC_READ_ONLY` | `true` | `true` disables tag writes in Hardened profile; set `false` in Standard SMB profile. |
| `CADENCE_CONTROL_PORT` | `4040` | HTTPS control listener port. |
| `CADENCE_MEDIA_PORT` | `18890` | HTTP UPnP media server port. |
| `CADENCE_LABEL` | `Cadence Playback Engine` | Display name advertised to Desktop and Mobile controllers. |
| `CADENCE_HEADROOM_MB` | `1024` | Memory headroom reserved for OS/container before admitting RAM-locked tracks. |
| `CADENCE_MIN_LOCKABLE_MB` | *(Probe default)* | Minimum lockable `mlock` RAM threshold validated at startup. |
| `CADENCE_PINNED_RS130_UDN` | Unset | Optional pinned RS130 UPnP device UDN. |

### Docker Compose Host Variables (`.env`)

- `CADENCE_IMAGE` — Published GHCR image (`ghcr.io/matbhuvi-tech/cadence-playback-engine:<tag>`)
- `CADENCE_HOST_MUSIC_DIR` — Existing readable host music directory bound to `/music` (optional in Standard SMB profile)
- Internal app data (`/var/lib/cadence`) is stored automatically in the Docker-managed `cadence_data` persistent volume.

## CLI Flags

### `cadence-engine` (Windows)

```text
cadence-engine [--data-dir <path>] [--port <u16>] [--localhost-only] [--label <name>] [--no-tray]
cadence-engine --stop | --restart
cadence-engine --doctor [--data-dir <path>] [--port <u16>]
cadence-engine --backup <tag> [--data-dir <path>] | --restore <tag> [--data-dir <path>]
cadence-engine --migrate-legacy-db [<path-to-cadence.db>] [--data-dir <path>]
cadence-engine --healthcheck [--data-dir <path>] [--port <u16>]
cadence-engine service <install|uninstall|start|stop|status> [--data-dir <path>] [--port <u16>] [--localhost-only] [--label <name>]
cadence-engine --version | --help
```

### `cadence-headless` (Linux / TrueNAS)

```text
cadence-headless --dragonfish [--data-dir <path>] [--music-dir <path>] [--tmp-dir <path>] [--advertised-ip <ipv4>] [--port <u16>] [--media-port <u16>] [--label <name>] [--headroom-mb <mb>]
cadence-headless --healthcheck [--data-dir <path>] [--port <u16>]
cadence-headless --doctor [--data-dir <path>] [--port <u16>]
cadence-headless --backup <tag> [--data-dir <path>] | --restore <tag> [--data-dir <path>]
cadence-headless --export-snapshot <src.db> <dest.db> | --preview-import ... | --import-snapshot ... | --rollback-import ...
cadence-headless --validate-dragonfish-recipe <yaml> [--validate-dockerfile <dockerfile>]
cadence-headless --version | --help
```

`--app-data-dir` and `--control-port` are accepted as aliases for `--data-dir` and `--port`.
