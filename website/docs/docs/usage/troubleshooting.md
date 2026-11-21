# Diagnostics & Troubleshooting

## Run Built-In Health Diagnostics (`--doctor`)

Both `cadence-engine` (Windows) and `cadence-headless` (Linux/TrueNAS) include a read-only `--doctor` command checking 6 subsystems in one pass:

::: code-group
```powershell [Windows]
& "$env:LOCALAPPDATA\Programs\CadenceEngine\cadence-engine.exe" --doctor
```

```sh [Docker Compose]
docker compose exec playback-engine /usr/local/bin/cadence-headless --doctor
```

```sh [Linux systemd]
sudo -u cadence cadence-headless --doctor --data-dir /var/lib/cadence
```
:::

When invoked without `--data-dir` on Windows while `CadencePlaybackEngine` is running as a Windows Service, `--doctor` automatically queries Service Control Manager (SCM) to inspect the active service's configured directory.

Example healthy output:

```text
Cadence Engine Doctor (data_dir=C:\Users\Mathan\AppData\Local\CadenceEngine, control_port=4040)
[OK] data_directory: C:\Users\Mathan\AppData\Local\CadenceEngine exists
[OK] identity_and_tls: engineId=core_... schemaVersion=1 tls/token files present
[OK] sqlite_integrity: PRAGMA integrity_check passed (ok)
[OK] sqlite_foreign_keys: PRAGMA foreign_key_check passed (0 violations)
[OK] memory_lock_limits: host_ram=64629 MiB (avail 42807 MiB), cgroup_max=none, rlimit_memlock=unlimited, cap_ipc_lock=true
[OK] live_readiness: running and ready on 127.0.0.1:4040
Overall: HEALTHY
```

## Common Issues

### Windows: "Already running in the background as a Windows Service" dialog on Start Menu launch
Windows Services execute in Session 0 and cannot show a notification-area tray icon in your desktop session. Open **Cadence Core** directly to connect. To switch back to the system tray icon, re-run `Cadence_<ver>_x64-setup.exe` (or `cadence-engine-setup.exe`) and uncheck **Windows Service**.

### Windows: Mobile Remote or LAN Desktop cannot connect
Ensure Private-network firewall rules allow TCP `4040`/`18890` and UDP `1900`/`5353`. Run **Start Menu → Cadence Playback Engine → Configure Windows Firewall (LAN Access)** or inspect active rules:

```powershell
Get-NetFirewallRule -DisplayName "Cadence Playback Engine (*)" | Format-Table DisplayName, Enabled, Action, Profile
```

Also verify the Windows network profile on your LAN adapter is set to **Private** (not *Public*).

### Linux / Docker: `openat2` / Kernel or Symlink Error
Cadence Headless requires **Linux kernel 5.6+** for kernel-enforced `openat2(RESOLVE_BENEATH)` path containment and intentionally rejects symlinks underneath music library roots. Mount real directories (or bind mounts) instead of symlinks inside `/music`.

### Linux / TrueNAS: Memory Lock (`mlock`) Failure
Containers require `cap_add: [IPC_LOCK]` and `ulimits.memlock: -1` (already configured in `compose.yml` and `compose.hardened.yml`). Native `systemd` installations require `LimitMEMLOCK=infinity` and `CAP_IPC_LOCK`. On TrueNAS/ZFS systems, ensure container `mem_limit` does not exceed free RAM outside the ZFS ARC cache.
