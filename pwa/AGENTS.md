# Cadence Remote PWA Blueprint (`pwa`)

## System Overview
`pwa` is a lightweight, mobile-first Progressive Web App designed to control Cadence bit-perfect audio playback from mobile handsets (iOS and Android). Built with React 19, TypeScript, Vite, and Tailwind CSS, it connects locally over HTTP and WebSockets to the Cadence desktop engine, providing real-time playback control, catalog browsing, queue management, and lock-screen media session controls without compromising audiophile audio engine purity.

## Local Interface & Invariants
- `vite.config.ts`: Vite build configuration outputting production assets directly into `../src-tauri/src/remote/dist` and proxying `/api` requests to local desktop backend (port 5174/4040).
- `package.json`: NPM package definition specifying `cadence-remote-pwa` dependencies and scripts (`dev`, `build`, `preview`).
- Invariant: Built output directory must stay synchronized with Tauri's static file serving directory `src-tauri/src/remote/dist`.

## Subdirectories & System Boundaries
- [src](./src/AGENTS.md): Application source code encompassing components, hooks, services, and types.

## Global Invariants
- Audiophile Transport Integrity: The remote PWA never streams audio data to the mobile device for playback; all audio decoding and DAC output remain strictly on the host desktop.
- Network PHY Quietness: WebSocket connectivity automatically pauses when the mobile screen sleeps, preventing continuous Wi-Fi radio wakeups and burst EMI near sensitive audio hardware.
- Bit-Perfect Volume Protection: Software volume sliders are guarded by default during bit-perfect playback to preserve unity gain signal paths.

## Global Side Effects
- Bundles compiled static distribution files into `../src-tauri/src/remote/dist` on build.
- Manages persistent browser storage under key `cadence_token`.

## System Verification
- Run: `npm run --prefix pwa build`

