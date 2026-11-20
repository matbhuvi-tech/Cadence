param(
  [string]$DesktopInstaller = "",
  [string]$EngineInstaller = "",
  [string]$Version = "",
  [string]$OutputFile = "",
  [switch]$RequireInstaller
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$BundleDir = Join-Path $RepoRoot "src-tauri\target\release\bundle\nsis"

if (-not $Version) {
  $cargoToml = Get-Content (Join-Path $RepoRoot "src-tauri\Cargo.toml") -Raw
  if ($cargoToml -match '(?ms)\[package\].*?^version\s*=\s*"([^"]+)"') {
    $Version = $Matches[1]
  } else {
    $Version = "0.1.0"
  }
}

if (-not $DesktopInstaller) {
  $candidate = Get-ChildItem -Path $BundleDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "cadence-engine-setup.exe" -and $_.Name -notlike "Cadence_*_x64-setup.exe" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) {
    $DesktopInstaller = $candidate.FullName
  }
}

if (-not $EngineInstaller) {
  $candidate = Join-Path $BundleDir "cadence-engine-setup.exe"
  if (Test-Path $candidate) {
    $EngineInstaller = $candidate
  }
}

if (-not $DesktopInstaller -or -not (Test-Path $DesktopInstaller)) {
  Write-Error "Desktop NSIS setup executable not found. Run 'npm run tauri:build -- --bundles nsis' first or pass -DesktopInstaller."
  exit 1
}
if (-not $EngineInstaller -or -not (Test-Path $EngineInstaller)) {
  Write-Error "Playback Engine NSIS setup executable not found. Run '.\deploy\windows-engine\build-windows-engine.ps1 -RequireInstaller' first or pass -EngineInstaller."
  exit 1
}

if (-not $OutputFile) {
  $OutputFile = Join-Path $BundleDir "Cadence_${Version}_x64-setup.exe"
}

$Makensis = Get-Command makensis -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $Makensis) {
  $TauriNsis = Join-Path $env:LOCALAPPDATA "tauri\NSIS\makensis.exe"
  if (Test-Path $TauriNsis) {
    $Makensis = $TauriNsis
  }
}

if (-not $Makensis) {
  if ($RequireInstaller) {
    Write-Error "makensis.exe not found in PATH or $env:LOCALAPPDATA\tauri\NSIS."
    exit 1
  }
  Write-Warning "makensis.exe not found in PATH or $env:LOCALAPPDATA\tauri\NSIS. Skipping unified suite installer packaging."
  exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputFile) | Out-Null

Write-Host "Packaging unified Cadence suite installer ($OutputFile) with $Makensis..." -ForegroundColor Cyan
$nsiScript = Join-Path $PSScriptRoot "cadence-suite.nsi"
& $Makensis `
  "/DPRODUCT_VERSION=$Version" `
  "/DDESKTOP_INSTALLER=$DesktopInstaller" `
  "/DENGINE_INSTALLER=$EngineInstaller" `
  "/DOUT_FILE=$OutputFile" `
  $nsiScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Built: $OutputFile" -ForegroundColor Green
