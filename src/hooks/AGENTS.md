# Hooks Package (`src/hooks`)

## Overview
Houses reusable custom React hooks for Cadence. Manages backend maintenance worker synchronization, catalog health scoring, inspector layout persistence, container responsive breakpoints, curation decision traces, and centralized staged modification tracking.

## Interface
- `useContainerBreakpoint`: Container query hook observing element width transitions across progressive-disclosure breakpoint tiers (`wide`, `compact`, `popover`).
- `useCurationTrace`: Hook managing curation decision trace retrieval, field outcome filtering, provider latency tracking, and playback-guarded trace persistence.
- `useMaintenanceWorker`: Hook subscribing to backend maintenance worker progress events (`portrait-sync-progress`), returning current `MaintenanceStats` (fingerprint count, missing tags, cached art metrics) and a manual `refreshStats` function.
- `useCatalogHealth`: Hook calculating catalog hygiene scores, triage issue categories, and defect filters across tracks.
- `useInspectorPersistence`: Hook persisting right sidebar tab selection, collapse state, and inspector layout settings.
- `useStagedChanges`: Centralized staging hook tracking pending tag edits, artwork updates, uncommitted sidecars, and cross-surface badge counters.

## Invariants
- Event listeners registered via Tauri `listen` must clean up with `UnlistenFn` when unmounted to prevent memory leaks and dangling listeners.
- Polling intervals must automatically halt when `enabled` is false.

## Side Effects
- Registers Tauri event listeners (`portrait-sync-progress`).
- Polls backend maintenance statistics via IPC every 3 seconds while active.

## Verification
- Run: `npm run build`
