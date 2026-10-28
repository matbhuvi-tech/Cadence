# Core Architecture Package

## Overview
Houses the core domain models, graph traversal algorithms, search intent parsing, taxonomy normalizers, sidecar file serialization, and the atomic two-phase transaction engine for Cadence.

## Interface
- `types.ts`: Foundational data contracts: `Track`, `Release`, `Person`, `Credit`, `Work`, `Movement`, `Playlist`, `IntegrityMetrics`, `SampleRateTransition`, `ReleaseConsensusResult`, `ConsensusFieldResult`, `SubReleaseGrouping`, `UpdateArtistEditorialPayload`.
- `transactionEngine.ts`: Manages atomic staging, diff calculation, dry-run validations, and commit rollbacks for file tag writes.
- `graphEngine.ts`: In-memory relational graph linking artists, releases, tracks, works, and credit roles for high-speed queries.
- `searchIntentClassifier.ts`: NLP query parser tokenizing free-form omnibar text into semantic filters (e.g. genre, decade, audio quality, artist).
- `sidecarManager.ts`: Parser and serializer for `.cadence.json` sidecar files accompanying audio tracks.
- `taxonomyUtils.ts`: Canonical string normalizers for artist names, multi-artist splitters, classical work movement numbering, `cleanConsensusTitle`, `isPlaceholderTag`, `calculateEarliestValidYear`, and `disambiguateComboTitle`.
- `templateEngine.ts`: Dynamic file path and filename template generator for library reorganization.
- `storagePersistence.ts`: Local storage and state hydration utilities.
- `scopeUtils.ts`: Filtering and slicing utilities across release categories and library partitions.
- `mockCatalog.ts`: Comprehensive mock dataset used for testing and UI prototyping.

## Invariants
- Modifications to audio file metadata must be represented as staged `Transaction` objects before physical disk execution.
- Relational graph indices in `graphEngine` must update transactionally when tracks or releases are added, mutated, or deleted.

## Side Effects
- Reads and parses sidecar JSON files from the filesystem.
- Performs regex operations and string canonicalization in memory.

## Verification
- Run: `npm run build`
