# PWA Source Blueprint (`pwa/src`)

## System Overview
`pwa/src` contains the application source code for the Cadence Mobile Remote Progressive Web App. It wires together UI component views, real-time WebSocket communication hooks, REST client services, and TypeScript types into a cohesive remote control experience for the Cadence bit-perfect audio engine.

## Local Interface & Invariants
- `App`: Root React application component orchestrating active tab selection (`NowPlaying`, `Catalog`, `Queue`), token pairing prompts, offline alerts, and MediaSession integration.
- `main.tsx`: React DOM client entry point initializing application into root DOM element within `React.StrictMode`.
- Invariant: If no pairing token is present, renders a pairing prompt directing the user to scan the desktop QR code or manually input a token before granting access.
- Invariant: Renders an offline banner with retry button whenever the socket is disconnected with an active error.

## Subdirectories & System Boundaries
- [components](./components/AGENTS.md): Presentation UI views for catalog, navigation, now playing, and queue.
- [hooks](./hooks/AGENTS.md): Custom React hooks for remote WebSocket synchronization and MediaSession lock-screen controls.
- [services](./services/AGENTS.md): REST API endpoints and token management utilities.
- [types](./types/AGENTS.md): TypeScript data models and protocol event interfaces.

## Global Invariants
- Zero unneeded network polling during background or locked screen states on mobile handsets.
- Strict adherence to Apple HIG 48px+ touch targets across all mobile interface controls.

## Global Side Effects
- Connects to `/api/remote/ws` and issues REST requests to `/api/remote/*`.
- Reads and updates browser `localStorage` and `navigator.mediaSession`.

## System Verification
- Run: `npm run --prefix pwa build`
