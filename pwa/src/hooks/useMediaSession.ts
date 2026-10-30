import { useEffect } from 'react';
import type { PlaybackStatus } from '../types/remote';
import { getArtworkUrl } from '../services/api';

interface MediaSessionProps {
  status: PlaybackStatus;
  token: string;
  onPlayPause: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  onSeek: (positionSecs: number) => void;
}

export function useMediaSession({
  status,
  token,
  onPlayPause,
  onNextTrack,
  onPrevTrack,
  onSeek,
}: MediaSessionProps) {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const stream = status.streamInfo;
    const title = stream?.title || (status.currentFile ? status.currentFile.split(/[/\\]/).pop() : 'Cadence');
    const artist = stream?.artist || 'Cadence Audiophile';
    const album = stream?.album || 'Bit-Perfect Playback';

    const artworkUrl = status.currentFile
      ? getArtworkUrl(status.currentFile, token)
      : '';

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'Cadence Audio',
        artist,
        album,
        artwork: artworkUrl
          ? [
              { src: artworkUrl, sizes: '192x192', type: 'image/jpeg' },
              { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
            ]
          : [],
      });

      navigator.mediaSession.playbackState = status.isPlaying
        ? 'playing'
        : status.isPaused
        ? 'paused'
        : 'none';

      // Set Action Handlers
      navigator.mediaSession.setActionHandler('play', () => {
        onPlayPause();
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        onPlayPause();
      });

      navigator.mediaSession.setActionHandler('previoustrack', () => {
        onPrevTrack();
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        onNextTrack();
      });

      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') {
          onSeek(details.seekTime);
        }
      });
    } catch (e) {
      console.warn('[MediaSession] Handler error:', e);
    }

    return () => {
      if (!('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
        navigator.mediaSession.setActionHandler('seekto', null);
      } catch {
        // ignore
      }
    };
  }, [status, token, onPlayPause, onNextTrack, onPrevTrack, onSeek]);
}
