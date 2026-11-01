<#
.SYNOPSIS
    Export audio tags and technical properties to JSON for a Cadence catalogue trial.

.DESCRIPTION
    Uses ffprobe to read container metadata without decoding/copying audio. Writes
    relative file paths only and does not modify the source library. Errors are
    recorded in the JSON report and scanning continues. If ffprobe is missing,
    asks before downloading the official Windows FFmpeg essentials build into
    the current user's LocalAppData folder.

.EXAMPLE
    .\Export-CadenceMetadata.ps1 -LibraryRoot 'M:\Music' -OutputJson '.\cadence-catalog.json'

.EXAMPLE
    .\Export-CadenceMetadata.ps1 -LibraryRoot 'M:\Music' -OutputJson '.\sample.json' -MaxFiles 1000
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $LibraryRoot,

    [Parameter(Mandatory = $true)]
    [string] $OutputJson,

    [string] $FfprobePath = 'ffprobe',

    [string] $FfmpegInstallDirectory = (Join-Path $env:LOCALAPPDATA 'Cadence\ffmpeg'),

    [ValidateRange(1, 10000000)]
    [int] $MaxFiles = 0,

    [ValidateRange(1, 10000)]
    [int] $ProgressEvery = 250
)

$ErrorActionPreference = 'Stop'
$extensions = @('.flac', '.dsf', '.dff', '.alac', '.m4a', '.mp3', '.wav', '.ogg', '.aac', '.aiff', '.aif')

$root = (Resolve-Path -LiteralPath $LibraryRoot).Path.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Library root is not a directory: $LibraryRoot"
}

# Path.GetRelativePath is unavailable in Windows PowerShell 5.1/.NET Framework.
# Use URI path resolution for compatibility with both Windows PowerShell and PowerShell 7.
$rootForUri = $root
if (-not $rootForUri.EndsWith([IO.Path]::DirectorySeparatorChar.ToString())) {
    $rootForUri += [IO.Path]::DirectorySeparatorChar
}
$rootUri = [Uri]::new($rootForUri)
function Get-RelativeLibraryPath([string] $BaseUri, [string] $FullPath) {
    $fileUri = [Uri]::new($FullPath)
    $relativeUri = ([Uri]$BaseUri).MakeRelativeUri($fileUri)
    return [Uri]::UnescapeDataString($relativeUri.ToString()).Replace('/', '\')
}

$ffprobeWasDefault = $FfprobePath -eq 'ffprobe'
if ($ffprobeWasDefault) {
    $probe = Get-Command ffprobe -ErrorAction SilentlyContinue
    if ($probe) { $FfprobePath = $probe.Source; $ffprobeWasDefault = $false }
    else {
        $cachedProbe = Get-ChildItem -LiteralPath $FfmpegInstallDirectory -Filter ffprobe.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cachedProbe) { $FfprobePath = $cachedProbe.FullName; $ffprobeWasDefault = $false }
        else {
            $consent = Read-Host 'ffprobe is not installed. Download the official Windows FFmpeg essentials build from gyan.dev (~100 MB) to your LocalAppData folder? [y/N]'
            if ($consent -notmatch '^(y|yes)$') {
                return
            }

            $downloadUri = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
            $installRoot = [IO.Path]::GetFullPath($FfmpegInstallDirectory)
            $parent = Split-Path -Parent $installRoot
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            $zipPath = Join-Path $parent 'ffmpeg-release-essentials.zip'
            $extractRoot = Join-Path $parent 'ffmpeg-extract'
            try {
                Write-Host "Downloading FFmpeg from $downloadUri ..."
                Invoke-WebRequest -Uri $downloadUri -OutFile $zipPath
                if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
                Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
                $downloadedProbe = Get-ChildItem -LiteralPath $extractRoot -Filter ffprobe.exe -File -Recurse | Select-Object -First 1
                if (-not $downloadedProbe) { throw 'The downloaded archive did not contain ffprobe.exe.' }
                if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
                New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
                $sourceBin = Split-Path -Parent $downloadedProbe.FullName
                Copy-Item -LiteralPath $sourceBin -Destination $installRoot -Recurse -Force
                $FfprobePath = Join-Path (Join-Path $installRoot (Split-Path -Leaf $sourceBin)) 'ffprobe.exe'
                if (-not (Test-Path -LiteralPath $FfprobePath -PathType Leaf)) { throw 'FFmpeg extraction did not produce an ffprobe executable at the expected location.' }
                $ffprobeWasDefault = $false
                Write-Host "FFmpeg installed for this Windows user at $installRoot"
            }
            finally {
                Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $extractRoot) {
                    $extractFull = [IO.Path]::GetFullPath($extractRoot)
                    if ($extractFull.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
                        Remove-Item -LiteralPath $extractFull -Recurse -Force -ErrorAction SilentlyContinue
                    }
                }
            }
        }
    }
}
if (-not $ffprobeWasDefault -and -not (Test-Path -LiteralPath $FfprobePath -PathType Leaf)) {
    throw "ffprobe executable not found: $FfprobePath"
}

$outputFull = [IO.Path]::GetFullPath($OutputJson)
$outputDir = Split-Path -Parent $outputFull
if ($outputDir -and -not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$files = @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() } |
    Sort-Object FullName)
if ($MaxFiles -gt 0 -and $files.Count -gt $MaxFiles) {
    $files = @($files | Select-Object -First $MaxFiles)
}
if ($files.Count -eq 0) { throw "No supported audio files found under $root" }

$records = [Collections.Generic.List[object]]::new()
$errors = [Collections.Generic.List[object]]::new()
$index = 0
foreach ($file in $files) {
    $index++
    $relative = (Get-RelativeLibraryPath -BaseUri $rootUri.AbsoluteUri -FullPath $file.FullName).Replace('\', '/')
    try {
        # ffprobe reads tags/stream headers; it does not decode audio samples.
        $raw = & $FfprobePath -v error -show_entries 'format=duration,bit_rate:format_tags:stream=codec_name,codec_type,sample_rate,channels,bits_per_sample,bits_per_raw_sample:stream_tags' -of json $file.FullName 2>$null
        if ($LASTEXITCODE -ne 0) { throw "ffprobe exited with code $LASTEXITCODE" }
        $probe = ($raw -join "`n") | ConvertFrom-Json
        $audio = @($probe.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1)[0]
        $tags = @{}
        $tagSources = @()
        if ($null -ne $probe.format) { $tagSources += $probe.format.tags }
        if ($null -ne $audio) { $tagSources += $audio.tags }
        foreach ($source in $tagSources) {
            if ($null -ne $source) {
                foreach ($property in $source.PSObject.Properties) {
                    if (-not $tags.ContainsKey($property.Name)) { $tags[$property.Name] = $property.Value }
                }
            }
        }
        $records.Add([ordered]@{
            id = [guid]::NewGuid().ToString('N')
            relativePath = $relative
            fileName = $file.Name
            extension = $file.Extension.TrimStart('.').ToLowerInvariant()
            fileSizeBytes = $file.Length
            tags = $tags
            technical = [ordered]@{
                codec = if ($null -ne $audio) { $audio.codec_name } else { $null }
                durationSeconds = if ($probe.format.duration) { [math]::Round([double]$probe.format.duration, 3) } else { $null }
                bitrateBitsPerSecond = if ($probe.format.bit_rate) { [long]$probe.format.bit_rate } else { $null }
                sampleRateHz = if ($null -ne $audio -and $audio.sample_rate) { [int]$audio.sample_rate } else { $null }
                channels = if ($null -ne $audio -and $audio.channels) { [int]$audio.channels } else { $null }
                bitDepth = if ($null -ne $audio -and $audio.bits_per_raw_sample) { [int]$audio.bits_per_raw_sample } elseif ($null -ne $audio -and $audio.bits_per_sample) { [int]$audio.bits_per_sample } else { $null }
            }
        })
    }
    catch {
        $errors.Add([ordered]@{ relativePath = $relative; error = $_.Exception.Message })
    }
    if (($index % $ProgressEvery) -eq 0 -or $index -eq $files.Count) {
        Write-Progress -Activity 'Exporting audio metadata' -Status "$index of $($files.Count) files" -PercentComplete ([int](100 * $index / $files.Count))
        Write-Host ("Processed {0}/{1}; exported {2}; errors {3}" -f $index, $files.Count, $records.Count, $errors.Count)
    }
}
Write-Progress -Activity 'Exporting audio metadata' -Completed

$report = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    libraryLabel = Split-Path -Leaf $root
    rootPathIncluded = $false
    scannedFiles = $files.Count
    exportedFiles = $records.Count
    failedFiles = $errors.Count
    tracks = $records
    errors = $errors
}
$json = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($outputFull, $json, [Text.UTF8Encoding]::new($false))
Write-Host "Export complete: $outputFull"
Write-Host "Scanned $($files.Count), exported $($records.Count), failed $($errors.Count)."
