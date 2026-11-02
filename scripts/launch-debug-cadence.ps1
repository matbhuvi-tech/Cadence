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
    [int]$TimeoutSeconds = 90
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

function Test-HttpPort {
    param([string]$Uri)
    try {
        $resp = Invoke-WebRequest -Uri $Uri -TimeoutSec 1 -ErrorAction SilentlyContinue
        return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400)
    } catch {
        return $false
    }
}

if (Test-CdpPort -TargetPort $Port) {
    Write-Host "[OK] Cadence is already running and listening for CDP on port $Port!" -ForegroundColor Green
    exit 0
}

# Set Microsoft WebView2 browser arguments so embedded browser opens the CDP debugging port
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$candidates = @(
    "$repoRoot\src-tauri\target\debug\cadence-core.exe",
    "$repoRoot\src-tauri\target\debug\cadence.exe",
    "$repoRoot\src-tauri\target\release\cadence-core.exe",
    "$repoRoot\src-tauri\target\release\cadence.exe"
)

$targetExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($targetExe) {
    # If using debug binary, ensure Vite dev server is running on port 5173
    if ($targetExe -like "*\debug\*" -and -not (Test-HttpPort "http://localhost:5173")) {
        Write-Host "[VITE] Starting Vite dev server on http://localhost:5173..." -ForegroundColor Cyan
        Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" -WorkingDirectory $repoRoot
        
        Write-Host "[WAIT] Waiting for Vite to be ready..." -ForegroundColor Cyan
        $viteReady = $false
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Milliseconds 1000
            if (Test-HttpPort "http://localhost:5173") {
                $viteReady = $true
                break
            }
        }
        if ($viteReady) {
            Write-Host "[OK] Vite is ready!" -ForegroundColor Green
        }
    }

    Write-Host "[LAUNCH] Launching Cadence binary from $targetExe with --remote-debugging-port=$Port..." -ForegroundColor Cyan
    $process = Start-Process -FilePath $targetExe -ArgumentList "--remote-debugging-port=$Port" -WorkingDirectory "$repoRoot\src-tauri" -PassThru
} else {
    Write-Host "[LAUNCH] Launching via npm run tauri:dev..." -ForegroundColor Yellow
    $process = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "tauri:dev", "--", "--", "--remote-debugging-port=$Port" -WorkingDirectory $repoRoot -PassThru
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
