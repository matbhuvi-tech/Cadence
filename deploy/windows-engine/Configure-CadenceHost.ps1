param(
  [string]$EngineExe = "",
  [string]$DataDir = "",
  [int]$Port = 4040,
  [switch]$InstallService,
  [switch]$StopService,
  [switch]$UninstallService,
  [switch]$ConfigureFirewall,
  [switch]$RemoveFirewall,
  [switch]$UninstallCleanup,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not $EngineExe) {
  $candidate = Join-Path $PSScriptRoot "cadence-engine.exe"
  if (Test-Path $candidate) {
    $EngineExe = $candidate
  }
}

$serviceName = "CadencePlaybackEngine"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$existingFwRules = @(Get-NetFirewallRule -DisplayName "Cadence Playback Engine (*)" -ErrorAction SilentlyContinue)

if ($UninstallCleanup) {
  if ($existingService) {
    $UninstallService = $true
  }
  if ($existingFwRules.Count -gt 0) {
    $RemoveFirewall = $true
  }
  if (-not $UninstallService -and -not $RemoveFirewall) {
    if ($DryRun) {
      Write-Host "[DRY-RUN] No Cadence Windows Service or firewall rules present; nothing to clean up."
    } else {
      Write-Host "No Cadence Windows Service or firewall rules present; nothing to clean up."
    }
    exit 0
  }
}

$onlyStop = $StopService -and -not ($InstallService -or $UninstallService -or $ConfigureFirewall -or $RemoveFirewall)
if ($onlyStop -and (-not $existingService -or $existingService.Status -eq "Stopped")) {
  if ($DryRun) {
    Write-Host "[DRY-RUN] Windows service '$serviceName' is not running; no elevation required."
  } else {
    Write-Host "Windows service '$serviceName' is not running."
  }
  exit 0
}

$onlyUninstall = $UninstallService -and -not ($InstallService -or $StopService -or $ConfigureFirewall -or $RemoveFirewall)
if ($onlyUninstall -and -not $existingService) {
  if ($DryRun) {
    Write-Host "[DRY-RUN] Windows service '$serviceName' is not installed; no elevation required."
  } else {
    Write-Host "Windows service '$serviceName' is not installed."
  }
  exit 0
}

$hasAction = $InstallService -or $StopService -or $UninstallService -or $ConfigureFirewall -or $RemoveFirewall
if (-not $hasAction) {
  exit 0
}

if (-not $DryRun) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($EngineExe) {
      $argList += @("-EngineExe", "`"$EngineExe`"")
    }
    if ($DataDir) {
      $argList += @("-DataDir", "`"$DataDir`"")
    }
    $argList += @("-Port", "$Port")
    if ($InstallService) { $argList += "-InstallService" }
    if ($StopService) { $argList += "-StopService" }
    if ($UninstallService) { $argList += "-UninstallService" }
    if ($ConfigureFirewall) { $argList += "-ConfigureFirewall" }
    if ($RemoveFirewall) { $argList += "-RemoveFirewall" }

    try {
      $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList $argList
      exit $proc.ExitCode
    } catch {
      Write-Error $_.Exception.Message
      exit 1223
    }
  }
}

$needsEngineExe = $InstallService -or $StopService -or $UninstallService
if ($needsEngineExe -and -not $DryRun) {
  if (-not $EngineExe -or -not (Test-Path $EngineExe)) {
    throw "cadence-engine.exe not found at '$EngineExe'."
  }
}

if ($StopService) {
  if ($DryRun) {
    Write-Host "[DRY-RUN] Stop Windows service '$serviceName' if running"
  } elseif ($existingService -and $existingService.Status -ne "Stopped") {
    & $EngineExe service stop
    if ($LASTEXITCODE -ne 0) {
      Stop-Service -Name $serviceName -Force -ErrorAction Stop
    }
  }
}

if ($InstallService) {
  if ($DryRun) {
    $displayExe = if ($EngineExe) { $EngineExe } else { "<cadence-engine.exe>" }
    $dataOpt = if ($DataDir) { " --data-dir '$DataDir'" } else { "" }
    Write-Host "[DRY-RUN] & '$displayExe' --stop"
    Write-Host "[DRY-RUN] & '$displayExe' service install --port $Port$dataOpt"
    Write-Host "[DRY-RUN] & '$displayExe' service start"
  } else {
    & $EngineExe --stop | Out-Null
    $svcArgs = @("service", "install", "--port", "$Port")
    if ($DataDir) {
      $svcArgs += @("--data-dir", $DataDir)
    }
    & $EngineExe @svcArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $EngineExe service start
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

if ($UninstallService) {
  if ($DryRun) {
    $displayExe = if ($EngineExe) { $EngineExe } else { "<cadence-engine.exe>" }
    Write-Host "[DRY-RUN] & '$displayExe' service uninstall"
  } elseif ($existingService) {
    & $EngineExe service uninstall
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

$fwScript = Join-Path $PSScriptRoot "Configure-CadenceFirewall.ps1"

if ($ConfigureFirewall) {
  $fwParams = @{}
  if ($EngineExe) {
    $fwParams["EngineExe"] = $EngineExe
  }
  if ($DryRun) {
    $fwParams["DryRun"] = $true
  }
  & $fwScript @fwParams
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($RemoveFirewall) {
  $fwParams = @{ Remove = $true }
  if ($DryRun) {
    $fwParams["DryRun"] = $true
  }
  & $fwScript @fwParams
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
