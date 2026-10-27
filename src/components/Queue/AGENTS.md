# Queue Components

## Overview
Houses the playback queue drawer component. Manages track sequencing, upcoming playlist items, dynamic reordering via drag-and-drop, and clearing or saving queue contents into playlists.

## Interface
- `QueuePlaylistDrawer`: Slide-over drawer displaying currently active queue items, now-playing indicator, duration totals, and reordering controls.

## Invariants
- Queue modifications must update the playback queue in `AudioPlayerContext` synchronously so the audio engine sequence remains deterministic.
- Removing the currently playing track must cleanly advance to the next track without stopping playback unexpectedly.

## Side Effects
- Mutates queue state and track indices in `AudioPlayerContext`.
- Emits Tauri playback queue synchronization payloads to mobile remote listeners.

## Verification
- Run: `npm run build`
