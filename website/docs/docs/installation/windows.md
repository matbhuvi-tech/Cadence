# Windows Installation

Cadence publishes a unified suite installer alongside standalone Desktop and Playback Engine installers on [**GitHub Releases**](https://github.com/matbhuvi-tech/Cadence/releases). **No Node.js, Rust, or FFmpeg installation is required.**

## Option 1: All-in-One Installer *(Recommended)*

1. Download **`Cadence_<ver>_x64-setup.exe`** from GitHub Releases.
2. Run the installer and select your components:
   - **Cadence Desktop (Browse, Listen & Curate)** *(Required)* — Installs `Cadence Core`.
   - **Cadence Local Playback Engine (This PC)** *(Checked by default)* — Installs `cadence-engine.exe` for local WASAPI Exclusive, ASIO, and UPnP playback. **Uncheck** this only if you are using Windows solely as a controller for a Linux or TrueNAS engine.
   - **Configure Windows Firewall for LAN & Mobile Remote** *(Optional)* — Requests Administrator approval once to add Windows Defender Firewall (Private profile) allow rules for TCP `4040`/`18890` and UDP `1900`/`5353`.
   - **Run Local Engine as Windows Service (Headless)** *(Optional)* — Registers and starts `CadencePlaybackEngine` as an automatic Windows Service (`LocalSystem`) instead of a tray app.

Both **Cadence Core** and **Cadence Playback Engine** register in **Windows Settings → Apps → Installed apps**.

::: warning Update both components together
When updating a local Windows installation with the suite, select both **Cadence Desktop** and **Cadence Local Playback Engine**. If you use standalone installers, download both from the same release. For an engine on another machine, update that host separately to the same release. See [Core UI and Playback Engine version mismatch](/docs/usage/troubleshooting#core-ui-and-playback-engine-version-mismatch) for verification and recovery.
:::

## System Tray Mode vs. Windows Service Mode

| Mode | Best For | Tray Icon | Shared Library Directory |
| :--- | :--- | :--- | :--- |
| **User Tray *(Default)*** | Desktop PCs, USB DACs (WASAPI Exclusive / ASIO) | Notification area icon (`Restart` / `Quit`) | `%LOCALAPPDATA%\CadenceEngine` |
| **Windows Service *(Installer Option)*** | Unattended audio PCs, UPnP servers booting without login | None (runs in Session 0) | `%LOCALAPPDATA%\CadenceEngine` |

::: info Seamless Mode Switching (Zero Duplicate Engine)
When installed through the setup wizard, **Windows Service mode uses the same `%LOCALAPPDATA%\CadenceEngine` directory** as User Tray mode. You can re-run `Cadence_<ver>_x64-setup.exe` (or `cadence-engine-setup.exe`) at any time to check or uncheck **Windows Service** without losing your catalog, artwork cache, renderer profiles, or engine identity.
:::

::: note Legacy Database Auto-Migration
On first install, if an older monolithic desktop database exists at `%APPDATA%\cadence.db` (or `com.cadence.core\cadence.db`) and `%LOCALAPPDATA%\CadenceEngine\cadence.db` does not yet exist, the installer automatically snapshots and imports tracks, playlists, curation drafts, watched folders, and cached artwork into the Playback Engine.
:::

## Standalone Engine Installer (`cadence-engine-setup.exe`)

If you want a Windows machine to act purely as a headless/tray audio host without installing the Desktop UI, run **`Cadence.PlaybackEngine_<ver>_x64-setup.exe`** (`cadence-engine-setup.exe`):

- Installs to `%LOCALAPPDATA%\Programs\CadenceEngine`.
- Adds Start Menu shortcuts under **Cadence Playback Engine**:
  - **Cadence Playback Engine** (starts tray mode, or shows an informational status dialog if Windows Service mode is active)
  - **Configure Windows Firewall (LAN Access)** (`Configure-CadenceFirewall.ps1`)
  - **Migrate Legacy Cadence DB** (`--migrate-legacy-db`)
  - **Uninstall Cadence Playback Engine** (cleanly stops/removes the tray process, optional Windows Service, and Cadence firewall rules)

Silent automation flags accepted by `cadence-engine-setup.exe`: `/S`, `/FIREWALL`, `/SERVICE`, `/TRAY`.

## Managing Windows Service & Firewall via CLI

You can also inspect or manage the service directly from an elevated (Administrator) PowerShell prompt:

```powershell
# Inspect health, SQLite integrity, memory locks, and live readiness
& "$env:LOCALAPPDATA\Programs\CadenceEngine\cadence-engine.exe" --doctor

# CLI service management (explicit --data-dir defaults to %ProgramData%\CadenceEngine when omitted via CLI)
& "$env:LOCALAPPDATA\Programs\CadenceEngine\cadence-engine.exe" service status
& "$env:LOCALAPPDATA\Programs\CadenceEngine\cadence-engine.exe" service start
& "$env:LOCALAPPDATA\Programs\CadenceEngine\cadence-engine.exe" service stop
```

Verify active Private-profile firewall rules:

```powershell
Get-NetFirewallRule -DisplayName "Cadence Playback Engine (*)" | Format-Table DisplayName, Enabled, Action, Profile
```

Next: [First Steps & Pairing](/docs/usage/getting-started).
