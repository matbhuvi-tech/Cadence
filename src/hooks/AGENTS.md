# Hooks Package

## Overview
Houses reusable custom React hooks for Cadence. Currently provides maintenance worker synchronization hooks bridging background Rust worker progress events to UI components.

## Interface
- `useMaintenanceWorker`: Hook subscribing to backend maintenance worker progress events (`portrait-sync-progress`), returning current `MaintenanceStats` (fingerprint count, missing tags, cached art metrics) and a manual `refreshStats` function.

## Invariants
- Event listeners registered via Tauri `listen` must clean up with `UnlistenFn` when unmounted to prevent memory leaks and dangling listeners.
- Polling intervals must automatically halt when `enabled` is false.

## Side Effects
- Registers Tauri event listeners (`portrait-sync-progress`).
- Polls backend maintenance statistics via IPC every 3 seconds while active.

## Verification
- Run: `npm run build`
