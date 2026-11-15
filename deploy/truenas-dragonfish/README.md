# Cadence Core on TrueNAS SCALE Dragonfish 24.04

Versioned deployment recipe for the headless `cadence-core` (`cadence-headless`) container on TrueNAS SCALE Dragonfish 24.04.

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

```bash
docker build --platform linux/amd64 -f deploy/truenas-dragonfish/Dockerfile -t cadence-core:0.1.0 .
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
