# Cadence Core on TrueNAS SCALE Dragonfish 24.04

Versioned deployment recipe for the headless `cadence-core` (`cadence-headless`) container on TrueNAS SCALE Dragonfish 24.04.

## Phase 1 library API and local verification

The controller now uses real HTTPS with a persistent self-signed certificate.
Trust/pin the engine certificate before connecting; `tlsFingerprintSha256` identifies
that certificate. All `/v1/*` APIs, artwork and progress streams require an
`x-cadence-token` or `Authorization: Bearer ...` header. Query-string tokens are
not supported. The owner credential is generated once in app data as `pairing-token`
(0600 on Linux); protect it as a secret. `CADENCE_PAIRING_TOKEN` can override it
with a random 32–256 character value for an isolated test deployment.

`CADENCE_BROWSE_ROOTS` is an OS path list (colon-separated on Linux), defaulting to
`CADENCE_MUSIC_DIR`. It authorizes directories, never arbitrary paths from a client.
Library roots must not overlap persistent app data. Linux requires `openat2`
(kernel 5.6+); unsupported kernels fail closed. Symlinks beneath roots are rejected,
including symlinks targeting another otherwise authorized directory.

Mount separate datasets at `/music/master` and `/music/rajafans` to browse and scan
both beneath `/music` (or mount extra roots such as `/music-share2` and list them colon-separated in `CADENCE_BROWSE_ROOTS`); examples are included in Compose. In the Custom App YAML,
add one `hostPath` volume and `volumeMount` for each submount, retaining
`readOnly: true` for playback-only deployments.

> **Important — Write Permission Required for Curate Tag Writing:**  
> By default, `cadence-core` mounts `/music` read-only (`:ro` + `CADENCE_MUSIC_READ_ONLY=true`). Playback, library browsing, AI/provider lookup, and saving Curate drafts/dry-runs work in read-only mode, **but writing embedded tags back to audio files requires ALL three:**
> 1. Mount the music volume read-write (`:rw`),
> 2. Set `-e CADENCE_MUSIC_READ_ONLY=false`, and
> 3. Grant UID/GID `568:568` (`apps`) read + write ACLs on the host dataset.
> *(Supported write containers: `FLAC`, `WAV`, `MP3`, `MP4/M4A`, `AIFF`; DSD `.dsf`/`.dff` tags and folder/file renames remain read-only.)*

Run the disposable regression harness from the repository root:

```sh
docker build -f deploy/engine-regression/Dockerfile -t cadence-engine-regression:phase1 .
docker run --rm --network none --cap-add SYS_PTRACE cadence-engine-regression:phase1
```

The image includes Rust tests, Node/tsx contract tooling, ffmpeg, synthetic DSD256,
Python HTTP acceptance tests and a Linux syscall audit. The run creates its own
database/music/caches under temporary directories, starts the actual executable,
and never contacts a NAS or renderer. Network access is required to build the
image; execution needs no external network. This is not physical RS130 or
audiophile performance qualification.

See [the Phase 1 evidence and API contract](../../reports/standalone-playback-phase1.tdd.md)
for supported operations, writer limits and release gates.

## Host & Dataset Preparation

1. **App Data Dataset (SSD recommended):**
   Create a dedicated dataset (for example `/mnt/ssd-pool/apps/cadence`) separate from `/music` and assign `apps` (`568:568`) full read/write ACLs.
2. **Music Dataset (Read-Only by default):**
   Mount your music dataset at `/music` with `readOnly: true` and grant `apps` (`568:568`) read-only traversal/read ACLs.
3. **Wired LAN IP:**
   Set `CADENCE_ADVERTISED_IP` to the wired LAN IPv4 address of the TrueNAS host reachable by your HiFi ROSE RS130. Pod (`172.16.x.x` / `10.42.x.x`), loopback (`127.x.x.x`), unspecified (`0.0.0.0`), link-local (`169.254.x.x`), and Tailscale/CGNAT (`100.64.0.0/10`) addresses are rejected at startup.
4. **Ports & Host Networking:**
   `hostNetwork: true` exposes fixed TCP `4040` (controller), TCP `18890` (UPnP media HTTP), and UDP `1900` (SSDP) without kube-proxy NAT. Fixed listener conflicts fail `/healthz` readiness immediately.
5. **Memory & `CAP_IPC_LOCK`:**
   `IPC_LOCK` capability + explicit container memory limits (`4Gi` recommended for DSD/high-res PCM album admission) allow `mlock` pre-faulting with zero pageable fallback.

## Build OCI `linux/amd64` Image

### 1. Transfer build files from Windows to TrueNAS
Avoid `scp -r src-tauri` because `src-tauri/target/` contains multi-GB Windows build artifacts. Package only the files needed by `Dockerfile` and copy the archive to TrueNAS:

```powershell
tar -cf cadence-core-src.tar deploy/truenas-dragonfish src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs src-tauri/src
scp cadence-core-src.tar <user>@<truenas-ip>:~/
```

On TrueNAS:

```bash
mkdir -p ~/cadence-core-build && tar -xf ~/cadence-core-src.tar -C ~/cadence-core-build && cd ~/cadence-core-build
```

### 2. Build and run the container

```bash
docker build --platform linux/amd64 -f deploy/truenas-dragonfish/Dockerfile -t cadence-core:0.1.0 .
```

Example `docker run` (read-only playback; replace `:ro` with `:rw` and add `-e CADENCE_MUSIC_READ_ONLY=false` if enabling Curate tag writes):

```bash
sudo docker run -d --name cadence-core --restart unless-stopped \
  --network host --user 568:568 \
  --cap-drop ALL --cap-add IPC_LOCK --ulimit memlock=-1:-1 \
  --security-opt no-new-privileges:true --memory=4g \
  -e CADENCE_ADVERTISED_IP=<TRUENAS_WIRED_LAN_IP> \
  -e CADENCE_LABEL="Music Room Core" \
  -v "/mnt/pool/cadence-core-data:/var/lib/cadence:rw" \
  -v "/mnt/pool/Music:/music:ro" \
  cadence-core:0.1.0 --dragonfish
```

Retrieve the generated `x-cadence-token` pairing secret for Cadence Desktop:

```bash
sudo docker exec cadence-core cat /var/lib/cadence/pairing-token
```

## Pre-Upgrade Backup & Rollback

Create an atomic `VACUUM INTO` snapshot + identity/certificate backup before changing image tags:

```bash
cadence-headless --app-data-dir /var/lib/cadence --backup pre-0.2.0
```

If an upgrade introduces an incompatible schema or needs rollback:

1. Stop the pod (`replicas: 0` or scale down before restoring).
2. Restore the matching snapshot:
   ```bash
   cadence-headless --app-data-dir /var/lib/cadence --restore pre-0.2.0
   ```
3. Pin the matching image version (e.g. `0.1.0`) and start with `replicas: 1`.
