# Modal Dialog Components

## Overview
Houses modal dialogs and overlays for Cadence. Covers library import, playlist lifecycle management, album customization, normalization rules, mobile remote QR pairing, quarantine management, and the central two-phase commit verification modal.

## Interface
- `TwoPhaseCommitModal`: Critical review dialog displaying atomic diffs, dry-run outcomes, and safety confirmations before writing tags to physical audio files.
- `BatchDiffTracksModal`: Multi-track comparison view for evaluating batch proposed changes across tracks.
- `ImportLibraryModal`: Directory picker and scan options dialog for adding music library paths.
- `CustomizeAlbumModal`: Release metadata and artwork override editor with sidecar persistence options.
- `MobileRemoteModal`: QR code display and network pairing status modal for the mobile PWA web remote.
- `NormalizationRulesModal`: Configurator for title/artist casing, leading zero track numbers, and character sanitization rules.
- `CreatePlaylistModal` / `EditPlaylistModal` / `AddTracksToPlaylistModal`: Dialogs managing custom playlist collections.
- `StorageManagerModal`: Disk mount manager for monitoring and managing audio storage directories.
- `QuarantineLogModal`: Log viewer for corrupt, unreadable, or quarantined audio files.
- `SidecarExportModal`: Export manager for writing `.cadence.json` sidecar files alongside audio files.
- `CompilationProvenanceModal`: Modal managing various-artist compilations and soundtrack grouping.
- `BatchRuleModal` / `BatchAiTracksModal`: Quick rule execution and AI metadata assist dialogs.

## Invariants
- Destructive disk operations must route through `TwoPhaseCommitModal` to prevent accidental loss of original tags.
- Modal interactions must trap focus and close gracefully on Escape or backdrop click unless a write operation is actively committing.

## Side Effects
- Mutates audio file ID3/FLAC tags on disk when two-phase commits are confirmed.
- Spawns library imports and writes configuration changes to SQLite.

## Verification
- Run: `npm run build`
