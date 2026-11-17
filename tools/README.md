# Catalogue before/after diagnostics

Three entry points:

1. `Export-CadenceMetadata.ps1`: recursively inventories **only paths registered in `watched_folders`**, including disabled registered folders. Reports audio tags and technical properties, every embedded picture's type/hash/dimensions/decode status, folder images, and sidecar contents. Unregistered siblings and symlinks/junctions are not followed. No arbitrary library-root argument.
2. `Export-CadenceDatabase.py`: exports catalogue tables, schema, counts, SQLite integrity/foreign-key results, release image/cache references, and engine image blob sizes/SHA-256 hashes. Uses a read-only SQLite URI and consistent read transaction. Does not open referenced music or cache files. Other application tables (credentials, etc.) are not exported.
3. `Compare-CadenceCatalogue.py`: compares the two saved inventories and emits findings with paths and values. It does not open the database, music files, or network URLs. `--baseline` lists added/resolved/unchanged findings against a previous consistency report.

The PowerShell entry point uses the Python database tool's shared filesystem implementation; keep all three scripts together. Scripts do not alter source tags, sidecars, images, or database rows, and never overwrite an existing report.

## Setup and execution

Requires Python **3.10+** and PowerShell 5.1+ or PowerShell 7. For filesystem inspection install dependencies explicitly:

```powershell
python -m pip install mutagen Pillow
```

Use the **actual database used by the affected Desktop/Playback Engine**, not an unrelated legacy copy. The path is required intentionally because installations may have multiple `cadence.db` files. Run on the host that owns the database and can access its registered paths (Windows paths on Windows, Linux paths on Linux). For a Linux engine invoke the filesystem implementation directly with `python tools/Export-CadenceDatabase.py --filesystem ...`.

Close Cadence and **all local and remote Playback Engines** and wait at least 30 seconds. `-OfflineConfirmed` / `--offline-confirmed` attests this condition. Local process detection also refuses to run when known Cadence binaries are active and rechecks before each file/table. Remote playback cannot be detected locally: the confirmation includes remote engines. Keep engines stopped throughout both exports; process enumeration is an advisory guard, not a synchronization lock with playback startup.

From the repository root, replace the example database path:

```powershell
$db = 'C:\path\to\cadence.db'
.\tools\Export-CadenceMetadata.ps1 -DatabasePath $db -OutputJson '.\reports\before-files.json' -OfflineConfirmed
python .\tools\Export-CadenceDatabase.py --db $db --output '.\reports\before-db.json' --offline-confirmed
python .\tools\Compare-CadenceCatalogue.py --files '.\reports\before-files.json' --database '.\reports\before-db.json' --output '.\reports\before-consistency.json'
```

After making the intended change and running quick/full scan as applicable, close Cadence/engines again, wait 30 seconds, and capture a new pair:

```powershell
.\tools\Export-CadenceMetadata.ps1 -DatabasePath $db -OutputJson '.\reports\after-files.json' -OfflineConfirmed
python .\tools\Export-CadenceDatabase.py --db $db --output '.\reports\after-db.json' --offline-confirmed
python .\tools\Compare-CadenceCatalogue.py --files '.\reports\after-files.json' --database '.\reports\after-db.json' --output '.\reports\after-consistency.json' --baseline '.\reports\before-consistency.json'
```

Choose report paths **outside all registered music folders**. Existing output files are rejected to protect baselines. Snapshots include full local paths and metadata; inspect before sharing. Folder scope/database identity must match for comparison; if folders are intentionally added/removed, establish a new baseline. Do not change files or the catalogue between paired exports.

## Interpreting reports

Export exit codes: **0** complete, **2** failure or incomplete inspection (a partial JSON report may still be available). Comparison: **0** no findings, **1** differences or inspection warnings, **2** invalid input/runtime failure. A difference is evidence to review, not necessarily a defect: catalogue defaults, curated tags, normalization, sidecars, and deliberate overrides can differ from raw file tags.

Unsupported/corrupt audio is included as an error record rather than silently omitted. Traversal failures and skipped links mark the snapshot incomplete and suppress definitive missing-file conclusions. Invalid images and sidecars remain visible as findings. External artwork URLs, relative references, and cache paths outside the registered folders are recorded as unverified; they are never fetched/read. `has_embedded_art` has different meanings in legacy Desktop and the engine; comparisons distinguish these modes by presence of `engine_artwork`.

Mutagen reads native container tags/headers (including DSF/DSDIFF), rather than inferring DSD clocks from FFmpeg's packed representation. Unsupported technical properties remain null. Image inspection is capped at 32 MiB / 16 megapixels and marks larger images unverified. Large tags are parsed one audio file at a time; complete report inventories are retained in RAM. Engine thumbnails are recompressed, so their hashes are **not** expected to equal original picture hashes. The tools validate availability and report hashes for investigation; they cannot prove perceptual equality or whether a particular UI successfully rendered an image.

## Fixture verification

```powershell
python -m unittest discover -s scripts/qa -p test_catalogue_diagnostics.py
```

The tests create isolated temporary databases/audio/images. They never use your live library. CLI-path tests replace the process guard only for these temporary fixtures. Real DSF/DFF collections, remote NAS access, and affected released versions still require before/after user validation.
