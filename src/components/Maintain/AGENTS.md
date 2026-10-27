# Maintain Cockpit Component

## Overview
Houses the dedicated library maintenance cockpit interface. Coordinates batch audit scans, AcoustID fingerprint matching, cover art enrichment, missing tag identification, and bulk automated tag fixes.

## Interface
- `MaintainCockpit`: Full cockpit dashboard presenting health scores, triage tabs (Missing Tags, Inconsistent Artists, Duplicate Tracks, Missing Art), batch action triggers, and quarantine review.

## Invariants
- All bulk fixes triggered from the cockpit must stage changes into two-phase commit batches for user review.
- Must not trigger database heavy writes while playback is active, complying with audiophile transport purity.

## Side Effects
- Spawns background worker tasks via `useMaintenanceWorker` and Tauri backend bridges.
- Modifies staged tag modifications awaiting two-phase commit.

## Verification
- Run: `npm run build`
