<#
.SYNOPSIS
Export the actual files, tags, embedded pictures, folder art, and sidecars under registered Cadence catalogue folders.
.DESCRIPTION
Requires Python 3.10+, mutagen, and Pillow (python -m pip install mutagen Pillow).
Uses watched_folders from the explicit database, including disabled registered folders.
Never accepts arbitrary music roots, follows junctions, downloads tools, or edits tags/database.
Close Cadence and ALL playback engines (including remote engines) and wait 30 seconds.
-OfflineConfirmed attests this condition. Local Cadence process detection also blocks execution.
Outputs must be new files outside music folders. Exit 2 means failed/incomplete inspection; retain the report.
The Python database tool contains shared inspection functions to keep this three-script toolset self-contained.
.EXAMPLE
.\tools\Export-CadenceMetadata.ps1 -DatabasePath 'C:\path\cadence.db' -OutputJson '.\reports\before-files.json' -OfflineConfirmed
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $DatabasePath,
    [Parameter(Mandatory = $true)][string] $OutputJson,
    [switch] $OfflineConfirmed,
    [string] $PythonPath = 'python'
)
$ErrorActionPreference = 'Stop'
if (-not $OfflineConfirmed) {
    throw 'Close Cadence and all local/remote engines, wait at least 30 seconds, then pass -OfflineConfirmed.'
}
$helper = Join-Path $PSScriptRoot 'Export-CadenceDatabase.py'
& $PythonPath $helper --filesystem --db $DatabasePath --output $OutputJson --offline-confirmed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
