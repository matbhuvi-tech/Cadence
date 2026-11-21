# Backup, Restore & Upgrades

Versioned engine backups use SQLite online-safe snapshots (`VACUUM INTO`) combined with node identity, TLS key/certificate, `pairing-token`, and `localhost-pairing.json` so restored engines keep their identity and Desktop/Mobile pairings working without re-pairing.

::: danger Stop Playback & Service First
Never run `--backup` or `--restore` concurrently with an active engine daemon. `--restore` explicitly refuses to run while `cadence-engine` or `CadencePlaybackEngine` is active.
:::

## Backup Contents

Each backup stored in `<data-dir>/backups/<tag>/` contains:

- `cadence.db` (atomic SQLite snapshot)
- `node-identity.json` (`engineId`, `libraryId`, label)
- `tls-cert.pem`, `tls-key.pem`, `tls-cert.json`
- `pairing-token` and `localhost-pairing.json` *(restored with `0600` permissions on Unix)*
- `backup-manifest.json`

Store copies of `<data-dir>/backups` off-host and separate from your music library drives.

## Windows Upgrade & Rollback

```powershell
$exe = "$env:LOCALAPPDATA\Programs\CadenceEngine\cadence-engine.exe"
$dataDir = "$env:LOCALAPPDATA\CadenceEngine"

# 1. Stop tray engine (or stop Windows Service from an elevated prompt)
& $exe --stop
# Or: & $exe service stop

# 2. Create a tagged offline backup
& $exe --backup pre-upgrade-20261121 --data-dir $dataDir

# 3. Run the new installer, then verify health
& $exe --doctor

# To roll back later (while engine/service is stopped):
& $exe --restore pre-upgrade-20261121 --data-dir $dataDir
```

## Docker Compose Upgrade & Rollback

```sh
# 1. Stop container cleanly
docker compose stop

# 2. Create offline backup using the current image
docker compose run --rm --no-deps playback-engine --backup pre-upgrade-20261121

# 3. Update CADENCE_IMAGE in .env to the target release tag, pull, and start
docker compose pull
docker compose up -d

# 4. Run read-only diagnostics
docker compose exec playback-engine /usr/local/bin/cadence-headless --doctor
```

To roll back: run `docker compose stop`, run `docker compose run --rm --no-deps playback-engine --restore pre-upgrade-20261121`, pin `CADENCE_IMAGE` back to the prior tag, and run `docker compose up -d`.

## Native Linux (`systemd`) Upgrade & Rollback

```sh
sudo systemctl stop cadence-playback-engine
sudo -u cadence cadence-headless --backup pre-upgrade-20261121 --data-dir /var/lib/cadence

# Install updated .deb / .rpm package, then verify:
sudo -u cadence cadence-headless --doctor --data-dir /var/lib/cadence
```

## Cross-Platform Library Migration

To move a catalog from a Windows Desktop library (`%APPDATA%\cadence.db` or Windows Engine) to Linux/TrueNAS with path prefix remapping (`D:\Music` → `/music`), use `cadence-headless`:

```sh
cadence-headless --export-snapshot cadence.db portable-snapshot.db
cadence-headless --preview-import --snapshot portable-snapshot.db --map "D:\\Music=/music"
cadence-headless --import-snapshot --snapshot portable-snapshot.db --map "D:\\Music=/music"
```
