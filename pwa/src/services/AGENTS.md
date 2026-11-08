# Services (`pwa/src/services`)

## Overview
The `services` package provides the HTTP REST client layer for Cadence Mobile Remote. It manages authentication token extraction and persistence, artwork URL generation, catalog and queue data fetching, and playback command dispatching.

## Interface
- `getStoredToken()`: Extracts authentication token from URL query parameters (`?token=...`) or `localStorage`.
- `getArtworkUrl(id: string, token: string)`: Generates endpoint URL for library release and track artwork.
- `fetchOutputDevices(token: string)`: Retrieves list of available desktop audio output endpoints.
- `selectOutputDevice(token: string, deviceName: string)`: Dispatches request to change active output device.
- `fetchReleases(token: string, limit?: number, offset?: number)`: Retrieves paginated release catalog.
- `fetchTracks(token: string, releaseId?: string)`: Retrieves track records for a specific release or whole library.
- `fetchQueue(token: string)`: Fetches current playback queue state.
- `sendPlaybackAction(action, payload, token)`: Sends playback action POST request to `/api/remote/playback/:action`.

## Invariants
- Every REST request includes `x-cadence-token` authentication header and URL token query parameter.
- Tokens found in URL parameters are automatically saved to `localStorage` under `cadence_token`.

## Side Effects
- Executes HTTP network requests (`fetch`) against `/api/remote/*`.
- Reads and writes `localStorage`.

## Verification
- Run: `npm run --prefix pwa build`

