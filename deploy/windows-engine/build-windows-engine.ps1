param(
  [switch]$SkipCargoBuild,
  [switch]$RequireInstaller,
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

if (-not $Version) {
  $cargoToml = Get-Content (Join-Path $RepoRoot "src-tauri\Cargo.toml") -Raw
  if ($cargoToml -match '(?ms)\[package\].*?^version\s*=\s*"([^"]+)"') {
    $Version = $Matches[1]
  } else {
    $Version = "0.1.0"
  }
}

if (-not $SkipCargoBuild) {
  Write-Host "Building cadence-engine.exe (release, engine-audio)..." -ForegroundColor Cyan
  cargo build --release --locked --manifest-path (Join-Path $RepoRoot "src-tauri\Cargo.toml") --no-default-features --features engine-audio --bin cadence-engine
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$BundleDir = Join-Path $RepoRoot "src-tauri\target\release\bundle\nsis"
New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null

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
  Write-Warning "makensis.exe not found in PATH or $env:LOCALAPPDATA\tauri\NSIS. Skipping NSIS installer packaging; binary is at src-tauri\target\release\cadence-engine.exe."
  exit 0
}

Write-Host "Packaging cadence-engine-setup.exe (version=$Version) with $Makensis..." -ForegroundColor Cyan
& $Makensis "/DPRODUCT_VERSION=$Version" (Join-Path $PSScriptRoot "cadence-engine.nsi")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Built: $(Join-Path $BundleDir 'cadence-engine-setup.exe')" -ForegroundColor Green
