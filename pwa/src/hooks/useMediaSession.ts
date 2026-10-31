import { useEffect, useRef } from 'react';
import type { PlaybackStatus } from '../types/remote';
import { getArtworkUrl } from '../services/api';

/**
 * Builds a ~1 second silent 8-bit mono PCM WAV as a Blob URL.
 * Mobile browsers only expose lock-screen media controls (navigator.mediaSession)
 * while a real <audio> element is playing in the tab. Cadence plays audio on the
 * desktop DAC, so the phone loops this silence purely to keep the widget alive.
 */
function createSilentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  new Uint8Array(buffer, 44).fill(0x80); // 8-bit PCM silence
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

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
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const isPlayingRef = useRef(false);
  isPlayingRef.current = status.isPlaying;

  // Create the silent loop once and unlock it on the first user gesture
  // (iOS Safari and Chrome both require a gesture before audio.play()).
  useEffect(() => {
    const audio = new Audio();
    audio.src = createSilentWavUrl();
    audio.loop = true;
    audio.preload = 'auto';
    silentAudioRef.current = audio;

    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      if (isPlayingRef.current) {
        audio.play().catch(() => {
          unlockedRef.current = false;
        });
      }
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('touchend', unlock, { once: true });

    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchend', unlock);
      audio.pause();
      URL.revokeObjectURL(audio.src);
      silentAudioRef.current = null;
    };
  }, []);

  // Loop silence only while the desktop is actually playing; free it otherwise.
  useEffect(() => {
    const audio = silentAudioRef.current;
    if (!audio || !unlockedRef.current) return;
    if (status.isPlaying) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [status.isPlaying]);

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

