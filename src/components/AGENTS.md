# UI Components Blueprint

## Overview
Organizes all React user interface components for the Cadence desktop audiophile application. Groups modular component packages for assistant agents, audio transport playback, center browsing canvases, omnibars, navigation rails, maintenance cockpits, modals, queues, contextual sidebars, and onboarding tutorials.

## Interface
- `ErrorBoundary`: Root React error boundary catching uncaught runtime exceptions, providing recovery options, cache resets, and error telemetry.
- Subdirectories and contracts:
  - [Agent](./Agent/AGENTS.md): Embedded AI assistant drawer and recommendation cards.
  - [AudioPlayer](./AudioPlayer/AGENTS.md): Audiophile transport bar, device selector, and Sanctuary lounge.
  - [CenterStage](./CenterStage/AGENTS.md): Album grid, virtual table, works/movements, and workbench viewports.
  - [CommandBar](./CommandBar/AGENTS.md): Omni search bar and background task activity center.
  - [LeftRail](./LeftRail/AGENTS.md): Navigation scopes, faceted filters, health triage, and storage mounts.
  - [Maintain](./Maintain/AGENTS.md): Library maintenance cockpit and batch audit tools.
  - [Modals](./Modals/AGENTS.md): Modals for two-phase commit, library import, playlists, and settings.
  - [Queue](./Queue/AGENTS.md): Playback queue slide-over drawer and track sequencing.
  - [RightPanel](./RightPanel/AGENTS.md): Granular credits, audio integrity card, and artwork media tray.
  - [Tutorial](./Tutorial/AGENTS.md): Guided onboarding walkthrough modal.
  - [common](./common/AGENTS.md): Shared visual elements, hover previews, and ambient backdrops.

## Invariants
- Uncaught component errors must be caught by `ErrorBoundary` to prevent entire application crashes.
- Subcomponents must adhere to Apple Human Interface Guidelines and dark-mode aesthetic conventions.

## Side Effects
- `ErrorBoundary` can clear corrupted application local storage keys during user-triggered reset recovery.

## Verification
- Run: `npm run build`
