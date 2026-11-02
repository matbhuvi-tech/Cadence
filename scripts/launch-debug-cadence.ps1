<#
.SYNOPSIS
  Launches Cadence with WebView2 Chrome DevTools Protocol (CDP) remote debugging enabled on port 9222.
.DESCRIPTION
  Used by the external Multimodal QA Testing Agent (scripts/qa/curateQaAgent.ts) to connect to Cadence externally
  without modifying production binaries or audio streaming threads.
#>

[CmdletBinding()]
param (
    [int]$Port = 9222,
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"

Write-Host "[INFO] Checking if Cadence is already running with remote debugging on port $Port..." -ForegroundColor Cyan

function Test-CdpPort {
    param([int]$TargetPort)
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$TargetPort/json/version" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp -and $resp.Browser) {
            return $true
        }
    } catch {
        return $false
    }
    return $false
}

if (Test-CdpPort -TargetPort $Port) {
    Write-Host "[OK] Cadence is already running and listening for CDP on port $Port!" -ForegroundColor Green
    exit 0
}

# Set Microsoft WebView2 browser arguments so the embedded browser opens the CDP debugging port
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

# Search for built binaries first (debug or release)
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$candidates = @(
    "$repoRoot\src-tauri\target\debug\cadence.exe",
    "$repoRoot\src-tauri\target\release\cadence.exe"
)

$targetExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($targetExe) {
    Write-Host "[LAUNCH] Launching Cadence binary from $targetExe with --remote-debugging-port=$Port..." -ForegroundColor Cyan
    $process = Start-Process -FilePath $targetExe -ArgumentList "--remote-debugging-port=$Port" -PassThru
} else {
    Write-Host "[LAUNCH] No pre-built cadence.exe found. Launching via npm run tauri:dev..." -ForegroundColor Yellow
    $process = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "tauri:dev", "--", "--", "--remote-debugging-port=$Port" -PassThru
}

Write-Host "[WAIT] Waiting for WebView2 CDP endpoint to initialize at http://127.0.0.1:$Port/json/version..." -ForegroundColor Cyan
$startTime = Get-Date
$ready = $false

while (((Get-Date) - $startTime).TotalSeconds -lt $TimeoutSeconds) {
    Start-Sleep -Milliseconds 1000
    if (Test-CdpPort -TargetPort $Port) {
        $ready = $true
        break
    }
    Write-Host "." -NoNewline
}

Write-Host ""

if ($ready) {
    Write-Host "[READY] Cadence WebView2 CDP debug endpoint is ready at http://127.0.0.1:$Port!" -ForegroundColor Green
    Write-Host "You can now run: npx tsx scripts/qa/curateQaAgent.ts" -ForegroundColor Green
    exit 0
} else {
    Write-Error "[TIMEOUT] Timeout waiting for Cadence CDP debug endpoint on port $Port after $TimeoutSeconds seconds."
    exit 1
}
