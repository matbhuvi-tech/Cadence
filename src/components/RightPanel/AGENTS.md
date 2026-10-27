# RightPanel Components

## Overview
Houses the contextual inspection and detailed metadata editing sidebar. Surfaces granular credits, audio integrity telemetry (checksums, true bitrates, clipping detection), artwork management media trays, and side-by-side metadata difference previews.

## Interface
- `UnifiedRightSidebar`: Main collapsible right-hand container coordinating tabs for track details, credits, audio integrity, and artwork.
- `GranularCreditMatrix`: Detailed credit viewer and editor for composers, producers, performers, conductors, and recording engineers.
- `IntegrityCard`: Audio file health monitor showing FLAC MD5 checksum validation, clipping analysis, bit-depth integrity, and true container sample rates.
- `ArtworkMediaTray`: Artwork management tool displaying embedded vs. folder images, resolution specs, and cover art replacement tools.
- `SideBySideDiff`: Visual inspection card comparing original file tags with proposed staged metadata edits.
- `RightPanel`: Legacy container component for contextual details.

## Invariants
- Integrity card calculations must reflect container header ground-truth rather than guessed extensions.
- Artwork replacements must validate image dimensions and MIME types before staging changes.

## Side Effects
- Mutates staged track metadata and selected artwork files.
- Triggers audio file integrity verification routines via backend commands.

## Verification
- Run: `npm run build`
