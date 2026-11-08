# Curate Phase 1 verification

The scope comes from [Curate Priorities, Problem Filtering, and Selected Output Commit](../docs/designs/CURATE_PRIORITIES_AND_SELECTED_OUTPUT.md). Phase 1 delivers the evaluator, queue projection, raw-baseline commit diff, and native draft APIs that the filter rail and Commit All will use.

| Behavior | Red evidence | Green evidence |
| --- | --- | --- |
| Detect and count all 14 categories, rank matching problems, persist settings, and restore dismissals across rescans | The priority module was missing | `testCuratePriorities.ts` passed every detector pair and the ranking, filter transition, and persistence cases |
| Skip in-sync tracks, recognize subset confirmations, project year and genre, and carry earlier selections into a later commit | Both tracks were queued for a one-track edit, partial rows lost earlier fields, and the staged helper was missing | `testCurateCommit.ts` passed the subset, cumulative payload, projection, and staged eligibility cases |
| List saved drafts across sessions and skip corrupt rows | The native draft-list method was missing | The storage suite passed with empty, overwritten, and corrupt rows |
| Replace a pending intent and persist the draft staging state atomically | The saved draft stayed staged after enqueue | The queue test passed, and the native identity test verified the separate enqueue path for a track with a write in flight |

Run these checks from the repository root.

```powershell
npm run build
npx tsx --test src/test/testCuratePriorities.ts src/test/testCurateCommit.ts src/test/testCurateDraft.ts src/test/testCurateHeadless.ts
cargo test --manifest-path src-tauri/Cargo.toml
```

The production build passed. The TypeScript run passed 43 tests, and the native suite passed 33. Node coverage for the two core modules was 93.76% of lines, 88.56% of branches, and 93.94% of functions.

## Audiophile impact assessment

Draft listing reads AppDb after playback has been idle for 30 seconds. It reuses the existing scan permit to keep the query and a new track load from overlapping. The query accesses no music-library files and sends no network traffic. Stop-time tracking runs at playback state transitions and leaves streaming-thread scheduling and pinned playback buffers untouched. Query allocations are confined to the application-side draft list.

The external QA agent drives the desktop workbench. The new priority rail and Commit All entry point are scheduled for later phases, so this phase was checked through fixture tests. A live desktop pass for the playback cooldown is still outstanding.
