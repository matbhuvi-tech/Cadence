# Issue #51 — missing pacer pill after suite installation

## Failure capture

The installed transport bar lacked the UPnP pacer pill despite newer source/build
outputs existing. The active branch contained feature commit `1229a4a`; the desktop
and playback engine were running from their installed locations, not the build tree.

On 2026-11-21 (Asia/Calcutta), the suite and engine installer were still from 05:07.
The desktop-only installer had been rebuilt at 21:26. Installed executables were
from 05:06–05:07 and had different SHA-256 hashes from the newer release binaries.
7-Zip inspection of the old suite confirmed that it embedded the older installers.

## Root cause and recovery

The unified suite packages existing component installers. A desktop-only build
does not regenerate the engine installer or unified suite. The previous feature
work did not regenerate the unified suite before requesting user verification.

`npm run build:windows` now builds the desktop NSIS installer, builds/packages the
Windows engine, then packages the unified suite. The existing packaging-only mode
remains available. It rejects component installers older than their corresponding
release executables (with two seconds of tolerance for Tauri's final bundle-marker
restoration and timestamp rounding).

The builder writes an adjacent `.manifest.json` containing the suite and both
component installer SHA-256 hashes, build time in UTC, and the source HEAD commit.
This is an artifact record; it does not assert that the source worktree was clean.

The first full build exposed Tauri's executable timestamp restoration about 40 ms
after the desktop installer was written. The initially strict timestamp comparison
rejected that valid installer. The two-second tolerance addresses this observed
packaging behavior while retaining rejection of substantially stale components.

## Verification

- PowerShell AST parsing succeeds and `git diff --check` passes.
- A deliberately old component fixture is rejected before NSIS packaging starts.
- Both desktop and engine component builds completed, followed by suite packaging.
- The full component-build session exposed a `Get-FileHash` command lookup failure
  while writing the manifest. Hashing now uses disposable .NET SHA-256/file-stream
  objects directly. Final packaging and manifest generation passed under Windows
  PowerShell 5.1 after that correction; already successful native builds were not
  repeated for the hash-only change.
- Extracted suite component installers match the manifest/source installer hashes.
- The extracted engine executable matches `target/release/cadence-engine.exe`
  byte-for-byte and contains the `player.upnp_delivery` operation.
- The extracted desktop executable matches `target/release/cadence-core.exe` after
  normalizing exactly one Tauri bundle marker: `__TAURI_BUNDLE_TYPE_VAR_NSS` in the
  NSIS payload versus `__TAURI_BUNDLE_TYPE_VAR_UNK` in the restored build binary.
  The only differences before normalization are those three marker bytes.
- The newly built frontend asset contains `UPnP Delivery Inspector`.
- Logs, extracted payloads and manifest comparisons are retained locally under
  `test-results/upnp-delivery/`; binaries/installers were inspected, not executed.

Final suite: `Cadence_0.1.0_x64-setup.exe`, 16,875,597 bytes, rebuilt at
2026-11-21 21:40:22 +05:30. SHA-256:
`B464C1D6EB059E7D61FBD8A8037EBA466BFE1F808744A384A984F8C53D26130E`.
The installed desktop was independently updated to the 21:26 component during
diagnosis; the installed engine was still the old 05:07 executable at the last
read-only check. Both components should be upgraded from the replacement suite.

No playback code, telemetry cadence, threading, buffers, or installed processes
were changed by this packaging correction. No runtime benchmark or new unit-test
suite is warranted for these build-only changes. The original feature's hardware
performance limits remain documented in `upnp-delivery-inspector-tdd.md`.

## User verification

Use the newly rebuilt `src-tauri/target/release/bundle/nsis/Cadence_0.1.0_x64-setup.exe`,
not a previously copied setup with the same name. Stop playback and close the
desktop before upgrading both Desktop and Local Playback Engine. Select the UPnP
output and confirm that the pacer pill appears beside the output control and opens
the delivery inspector. Actual installed UI confirmation remains pending.

Issue: [#51](https://github.com/matbhuvi-tech/Cadence/issues/51). The issue stays open and
the branch stays unmerged until the user's verification and separate merge approval.

## Self-evaluation

Overall 4.4/5. Accuracy 4: artifact provenance is verified, but the user's upgraded
UI is not yet observed. Completeness 4: corrected build delivery is ready; local
installation remains a user action to avoid interrupting active playback. Clarity
5: the stale-suite cause and exact replacement are identified. Actionability 5:
the full build command, manifest and replacement installer are supplied. Conciseness
4: artifact and marker verification details are retained here instead of the reply.
The highest-impact remaining check is the user's installed UI verification.
Self-check: the evidence supports a packaging fix without claiming installation
or playback verification that has not occurred.
