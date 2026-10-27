# Frontend Application Blueprint (`src`)

## Overview
Root of the frontend React and TypeScript codebase for Cadence. Initializes the React application tree, orchestrates top-level routing, sets up keyboard shortcuts, manages full-screen views, and mounts the primary layout (Header, LeftRail, CenterStage, RightPanel, NowPlayingBar, and Modals).

## Local Interface & Invariants
- `App`: Master React application container orchestrating view states, catalog loading, active selections, modal states, and copilot drawers.
- `main.tsx`: Entry point mounting the React root into the DOM with `AudioPlayerProvider` and `ErrorBoundary`.
- Invariant: State mutations crossing subsystem boundaries must route through domain services or context providers.

## Subdirectories & System Boundaries
- [components](./components/AGENTS.md): UI component packages (CenterStage, AudioPlayer, CommandBar, LeftRail, Modals, etc.).
- [context](./context/AGENTS.md): React context providers including `AudioPlayerContext`.
- [core](./core/AGENTS.md): Domain models, relational graph engine, search classifier, and transaction engine.
- [hooks](./hooks/AGENTS.md): Custom hooks bridging Tauri backend event streams to React state.
- [services](./services/AGENTS.md): Business logic, SQLite queries, AcoustID, and Tauri IPC bridges.
- [tutorial](./tutorial/AGENTS.md): Onboarding walkthrough step configurations and agent protocols.
- [types](./types/AGENTS.md): Two-phase commit contracts and padding analysis schemas.

## Global Invariants
- Audio playback purity rules must be honored by preventing background queries or disk I/O while playing.
- All metadata modifications must support non-destructive preview and two-phase commit verification.

## System Verification
- Run: `npm run build`
