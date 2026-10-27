# Types Package

## Overview
Houses specialized TypeScript contract types and interface definitions for Cadence. Currently specifies the two-phase commit protocol, container header padding analysis, and transaction execution results.

## Interface
- `CommitUnitMetrics`: Quantifies items modified during a commit batch (albums, tracks, tag edits, cover art updates).
- `PreflightCheckResult`: Audiophile safety checks verifying playback silence, storage writability, and blocked paths.
- `HeaderPaddingAnalysis`: Predicts whether metadata tag additions can fit in-place within container padding blocks or require a full audio payload rewrite.
- `CommitBatchOptions`: User execution options specifying sidecar vs. embedded destination and exclusion sets.
- `CommitExecutionResult`: Outcome telemetry reporting transaction IDs, rewrite counts, and any track write failures.

## Invariants
- `PreflightCheckResult.canProceed` must evaluate to `false` if `playbackIdle` is false or cooldown has not elapsed, preserving audiophile transport silence.
- Padding analysis for DSF files must leverage trailing metadata offset rewriting rather than full 1GB+ container rewrites.

## Side Effects
- Type-only package; no runtime side effects.

## Verification
- Run: `npm run build`
