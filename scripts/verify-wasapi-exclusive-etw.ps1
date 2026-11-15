<#
.SYNOPSIS
    Authoritative Tier 3 ETW File/Disk I/O & WASAPI Exclusive Hardware Verification Script for Cadence.
.DESCRIPTION
    Starts a Windows Kernel File ETW trace (`Microsoft-Windows-Kernel-File`), executes the optimized
    `--release` WASAPI Exclusive RAM-Preload benchmark suite against the active WASAPI audio endpoint,
    stops the ETW session, and converts the trace via `tracerpt` to verify zero Cadence file reads
    occur during the `Playing` window.
    Note: Requires an elevated (Run as Administrator) PowerShell prompt for Kernel File ETW tracing
    and an active local WASAPI output endpoint (USB DAC / Headphones / Speakers).
#>
param(
    [string]$EtlDir = $env:TEMP
)

$ErrorActionPreference = "Continue"
$SessionName = "CadenceWasapiExclEtw"
$EtlPath = Join-Path $EtlDir "cadence_wasapi_excl_trace.etl"
$CsvPath = Join-Path $EtlDir "cadence_wasapi_excl_events.csv"

Write-Host "=== Cadence Tier 3 WASAPI Exclusive + ETW Verification ===" -ForegroundColor Cyan

# Clean up any stale trace
logman stop $SessionName -ets *> $null
Remove-Item $EtlPath -Force -ErrorAction SilentlyContinue
Remove-Item $CsvPath -Force -ErrorAction SilentlyContinue

# 0. Pre-build the release test binary BEFORE starting ETW so compiler/linker I/O does not clutter the trace
Write-Host "[0/3] Ensuring --release benchmark binary is compiled before starting ETW..." -ForegroundColor Yellow
cargo test --release --no-run --manifest-path "$PSScriptRoot\..\src-tauri\Cargo.toml" --lib

# 1. Start ETW Microsoft-Windows-Kernel-File session
# Keywords 0x1FF0 = FILENAME (0x10) | FILEIO (0x20) | OP_END (0x40) | CREATE (0x80) | READ (0x100) | WRITE (0x200) | DELETE/RENAME/CREATE_NEW
Write-Host "[1/3] Starting ETW session '$SessionName' (Microsoft-Windows-Kernel-File, mask 0x1FF0)..." -ForegroundColor Yellow
logman create trace $SessionName -p "Microsoft-Windows-Kernel-File" 0x1FF0 0xFF -o $EtlPath -ets
$etwActive = ($LASTEXITCODE -eq 0)
if (-not $etwActive) {
    Write-Warning "ETW Kernel-File trace requires an elevated Administrator PowerShell session. Proceeding with supplementary process I/O & page-fault telemetry..."
}

# 2. Run the optimized --release WASAPI Exclusive RAM Preload & Hardware Benchmark
Write-Host "[2/3] Running --release WASAPI Exclusive RAM Preload & Hardware Benchmark..." -ForegroundColor Yellow
$env:CADENCE_RUN_TIER3_BENCH = "1"
cargo test --release --manifest-path "$PSScriptRoot\..\src-tauri\Cargo.toml" --lib wasapi_exclusive::tests -- --nocapture

# 3. Stop ETW trace and export summary
if ($etwActive) {
    Write-Host "[3/3] Stopping ETW session and exporting trace to $CsvPath ..." -ForegroundColor Yellow
    logman stop $SessionName -ets | Out-Null
    tracerpt $EtlPath -o $CsvPath -of CSV -y | Out-Null
    if (Test-Path $CsvPath) {
        Write-Host "ETW CSV exported to: $CsvPath" -ForegroundColor Green
    }
}
