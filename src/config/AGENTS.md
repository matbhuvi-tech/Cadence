# Config Package (`src/config`)

## Overview
Houses runtime configuration flags, environment presets, and client-side feature toggles for Cadence.

## Interface
- `features.ts`: Feature flag declarations and runtime toggles for experimental capabilities and UI workbench variants.

## Invariants
- Configuration values must evaluate synchronously and remain immutable during runtime execution.

## Side Effects
- None (pure configuration declarations).

## Verification
- Run: `npm run build`

