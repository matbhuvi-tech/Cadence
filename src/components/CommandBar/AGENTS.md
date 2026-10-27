# CommandBar Components

## Overview
Houses the omnibar header navigation and global task activity monitor for Cadence. Enables fast keyboard-driven search intent classification, action triggering, and real-time status popovers for background operations (library scan, acoustic fingerprinting, artwork fetching).

## Interface
- `OmniCommandBar`: Global search input and intent engine executing natural language navigation, quick filters, and action commands.
- `ActivityPill`: Compact indicator showing currently running background jobs, progress percentages, and warnings.
- `ActivityCenterPopover`: Expanded floating popover displaying detailed job logs, cancel controls, and background task histories.

## Invariants
- Search inputs in `OmniCommandBar` must trigger `searchIntentClassifier` to differentiate between metadata filtering, audio commands, and natural language prompts.
- Background progress indicators in `ActivityPill` must update reactivity without triggering re-renders of the heavy center canvas.

## Side Effects
- Mutates global search query, active facet filters, and view modes.
- Can pause, resume, or abort background jobs via Tauri bridge invocations.

## Verification
- Run: `npm run build`
