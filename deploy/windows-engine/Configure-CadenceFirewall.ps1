param(
  [string]$EngineExe = "",
  [switch]$Remove,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not $EngineExe) {
  $candidate = Join-Path $PSScriptRoot "cadence-engine.exe"
  if (Test-Path $candidate) {
    $EngineExe = $candidate
  }
}

$rules = @(
  @{ Name = "Cadence Playback Engine (HTTPS Control 4040)"; Protocol = "TCP"; Port = 4040 },
  @{ Name = "Cadence Playback Engine (UPnP Media 18890)"; Protocol = "TCP"; Port = 18890 },
  @{ Name = "Cadence Playback Engine (SSDP 1900)"; Protocol = "UDP"; Port = 1900 },
  @{ Name = "Cadence Playback Engine (mDNS 5353)"; Protocol = "UDP"; Port = 5353 }
)

if (-not $DryRun) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($EngineExe) {
      $argList += @("-EngineExe", "`"$EngineExe`"")
    }
    if ($Remove) {
      $argList += "-Remove"
    }
    $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList $argList
    exit $proc.ExitCode
  }
}

$hasProgram = $EngineExe -and (Test-Path $EngineExe)

foreach ($rule in $rules) {
  if ($Remove) {
    if ($DryRun) {
      Write-Host "[DRY-RUN] Remove-NetFirewallRule -DisplayName '$($rule.Name)'"
    } else {
      Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
      Write-Host "Removed firewall rule: $($rule.Name)"
    }
    continue
  }

  $params = @{
    DisplayName = $rule.Name
    Direction   = "Inbound"
    Action      = "Allow"
    Enabled     = "True"
    Profile     = "Private"
    Protocol    = $rule.Protocol
    LocalPort   = $rule.Port
  }
  if ($hasProgram) {
    $params["Program"] = $EngineExe
  }

  if ($DryRun) {
    $progDesc = if ($hasProgram) { $EngineExe } else { "<any program>" }
    Write-Host "[DRY-RUN] Ensure Private Inbound Allow $($rule.Protocol)/$($rule.Port) for $progDesc ($($rule.Name))"
  } else {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule @params | Out-Null
    Write-Host "Configured firewall rule: $($rule.Name)"
  }
}
