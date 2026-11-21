param(
  [string]$DesktopInstaller = "",
  [string]$EngineInstaller = "",
  [string]$Version = "",
  [string]$OutputFile = "",
  [switch]$BuildComponents,
  [switch]$RequireInstaller
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$BundleDir = Join-Path $RepoRoot "src-tauri\target\release\bundle\nsis"

function Get-Sha256Hex([string]$FilePath) {
  # Use the .NET API so npm's Windows PowerShell host does not depend on the
  # Get-FileHash cmdlet/module being available in that session.
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [System.IO.File]::OpenRead((Get-Item -LiteralPath $FilePath).FullName)
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "")
  } finally {
    if ($stream) { $stream.Dispose() }
    $algorithm.Dispose()
  }
}

if ($BuildComponents) {
  if ($DesktopInstaller -or $EngineInstaller) {
    throw "-BuildComponents cannot be combined with prebuilt -DesktopInstaller or -EngineInstaller paths."
  }
  Push-Location $RepoRoot
  try {
    Write-Host "Building current Desktop installer before packaging the suite..." -ForegroundColor Cyan
    & npm.cmd run tauri:build -- --bundles nsis
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & (Join-Path $RepoRoot "deploy\windows-engine\build-windows-engine.ps1") -RequireInstaller
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

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

# A Desktop-only build leaves the old unified installer untouched. Do not silently
# wrap an engine/desktop setup that predates the corresponding newly built binary.
foreach ($component in @(
  @{ Name = "Desktop"; Installer = $DesktopInstaller; Binary = (Join-Path $RepoRoot "src-tauri\target\release\cadence-core.exe") },
  @{ Name = "Playback Engine"; Installer = $EngineInstaller; Binary = (Join-Path $RepoRoot "src-tauri\target\release\cadence-engine.exe") }
)) {
  # Tauri restores a temporary NSIS bundle marker just after the installer is
  # written. Allow two seconds for that final write and installer timestamp rounding.
  if ((Test-Path -LiteralPath $component.Binary) -and
      (Get-Item -LiteralPath $component.Binary).LastWriteTimeUtc -gt (Get-Item -LiteralPath $component.Installer).LastWriteTimeUtc.AddSeconds(2)) {
    throw "$($component.Name) installer is older than its binary. Run 'npm run build:windows' to rebuild both components and the unified suite."
  }
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

$sourceCommit = & git -C $RepoRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { $sourceCommit = "unknown" }
$manifest = [ordered]@{
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
  sourceCommit = $sourceCommit
  suite = @{ file = (Split-Path -Leaf $OutputFile); sha256 = (Get-Sha256Hex $OutputFile) }
  desktop = @{ file = (Split-Path -Leaf $DesktopInstaller); sha256 = (Get-Sha256Hex $DesktopInstaller) }
  engine = @{ file = (Split-Path -Leaf $EngineInstaller); sha256 = (Get-Sha256Hex $EngineInstaller) }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$OutputFile.manifest.json" -Encoding UTF8
Write-Host "Build manifest: $OutputFile.manifest.json" -ForegroundColor Green
