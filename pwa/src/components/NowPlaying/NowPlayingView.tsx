import React, { useState, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Disc3, Shield, ShieldAlert } from 'lucide-react';
import type { PlaybackStatus } from '../../types/remote';
import { getArtworkUrl } from '../../services/api';
import { VolumeGuard } from './VolumeGuard';

interface NowPlayingViewProps {
  status: PlaybackStatus;
  token: string;
  onPlayPause: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  onSeek: (posSecs: number) => void;
  onVolumeChange: (vol: number) => void;
  onTogglePurity: (enabled: boolean) => void;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export const NowPlayingView: React.FC<NowPlayingViewProps> = ({
  status,
  token,
  onPlayPause,
  onNextTrack,
  onPrevTrack,
  onSeek,
  onVolumeChange,
  onTogglePurity,
}) => {
  const [sliderPos, setSliderPos] = useState<number>(status.positionSecs);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [artworkLoaded, setArtworkLoaded] = useState<boolean>(false);

  // Sync slider position with server updates when not scrubbing
  useEffect(() => {
    if (!isScrubbing) {
      setSliderPos(status.positionSecs);
    }
  }, [status.positionSecs, isScrubbing]);

  const stream = status.streamInfo;
  const trackTitle = stream?.title || (status.currentFile ? status.currentFile.split(/[/\\]/).pop() : 'No Track Loaded');
  const artistName = stream?.artist || 'Cadence Transport Engine';
  const albumName = stream?.album || 'Ready for Playback';

  const artworkId = status.currentFile || '';
  const artworkUrl = artworkId ? getArtworkUrl(artworkId, token) : '';

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSliderPos(parseFloat(e.target.value));
  };

  const handleSliderCommit = () => {
    setIsScrubbing(false);
    onSeek(sliderPos);
  };

  return (
    <div className="flex-1 flex flex-col justify-between items-center px-6 py-4 overflow-y-auto no-scrollbar max-w-md mx-auto w-full">
      {/* Artwork Section */}
      <div className="relative my-auto flex flex-col items-center">
        <div
          className={`relative w-64 h-64 sm:w-72 sm:h-72 rounded-3xl overflow-hidden bg-zinc-900 border border-zinc-800 shadow-2xl transition-all duration-700 ${
            status.isPlaying ? 'shadow-[0_0_35px_rgba(212,175,55,0.18)]' : ''
          }`}
        >
          {artworkUrl ? (
            <img
              src={artworkUrl}
              alt={trackTitle || 'Album Art'}
              onLoad={() => setArtworkLoaded(true)}
              onError={() => setArtworkLoaded(false)}
              className={`w-full h-full object-cover transition-opacity duration-300 ${
                artworkLoaded ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ) : null}

          {/* Fallback vinyl graphic */}
          {(!artworkUrl || !artworkLoaded) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-950 to-black text-zinc-600">
              <Disc3 className={`w-24 h-24 stroke-[1.2] ${status.isPlaying ? 'animate-spin-slow' : ''}`} style={{ animationDuration: '10s' }} />
              <span className="text-[10px] font-mono tracking-widest text-zinc-500 mt-2">CADENCE ENGINE</span>
            </div>
          )}
        </div>
      </div>

      {/* Track Metadata */}
      <div className="w-full text-center mt-3 mb-2">
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-100 truncate">
          {trackTitle}
        </h2>
        <p className="text-sm font-medium text-zinc-400 truncate mt-1">
          {artistName}
        </p>
        <p className="text-xs text-zinc-600 truncate mt-0.5">
          {albumName}
        </p>

        {/* Audio Container Ground-Truth Spec Badge */}
        {stream && (
          <div className="inline-flex items-center space-x-1.5 px-3 py-0.5 mt-2 rounded-full bg-zinc-900/90 border border-zinc-800 text-[11px] font-mono text-[#D4AF37]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]" />
            <span>
              {stream.format.toUpperCase()}
              {stream.sampleRate ? ` • ${(stream.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz` : ''}
              {stream.bitDepth ? ` / ${stream.bitDepth}-bit` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Scrubber Progress Bar */}
      <div className="w-full max-w-sm flex flex-col space-y-1 mb-2">
        <div className="relative flex items-center">
          <input
            type="range"
            min="0"
            max={status.durationSecs > 0 ? status.durationSecs : 100}
            step="0.5"
            value={sliderPos}
            onMouseDown={() => setIsScrubbing(true)}
            onTouchStart={() => setIsScrubbing(true)}
            onChange={handleSliderChange}
            onMouseUp={handleSliderCommit}
            onTouchEnd={handleSliderCommit}
            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
          />
        </div>
        <div className="flex justify-between text-[11px] font-mono text-zinc-500 px-0.5">
          <span>{formatTime(sliderPos)}</span>
          <span>-{formatTime(Math.max(0, status.durationSecs - sliderPos))}</span>
        </div>
      </div>

      {/* Transport Controls (Apple HIG 48px+ Touch Targets) */}
      <div className="flex items-center justify-center space-x-6 mb-4">
        <button
          onClick={onPrevTrack}
          aria-label="Previous Track"
          className="w-12 h-12 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800/60 active:scale-95 transition-all"
        >
          <SkipBack className="w-6 h-6 fill-current" />
        </button>

        <button
          onClick={onPlayPause}
          aria-label={status.isPlaying ? 'Pause' : 'Play'}
          className="w-16 h-16 rounded-full bg-[#D4AF37] text-zinc-950 flex items-center justify-center shadow-[0_0_25px_rgba(212,175,55,0.35)] hover:brightness-110 active:scale-95 transition-all"
        >
          {status.isPlaying ? (
            <Pause className="w-7 h-7 fill-current" />
          ) : (
            <Play className="w-7 h-7 fill-current translate-x-0.5" />
          )}
        </button>

        <button
          onClick={onNextTrack}
          aria-label="Next Track"
          className="w-12 h-12 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800/60 active:scale-95 transition-all"
        >
          <SkipForward className="w-6 h-6 fill-current" />
        </button>
      </div>

      {/* Purity Switch & Volume Guard */}
      <div className="w-full flex flex-col space-y-3 mb-2">
        <div className="flex items-center justify-center">
          <button
            onClick={() => onTogglePurity(!status.purityMode)}
            className={`flex items-center space-x-2 px-3 py-1 rounded-full border text-xs font-medium transition-all ${
              status.purityMode
                ? 'bg-amber-500/10 border-amber-500/30 text-[#D4AF37]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500'
            }`}
          >
            {status.purityMode ? (
              <Shield className="w-3.5 h-3.5 text-[#D4AF37]" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5 text-zinc-500" />
            )}
            <span>Bit-Perfect Purity Mode: {status.purityMode ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        <VolumeGuard
          volume={status.volume}
          isBitPerfect={status.isBitPerfect}
          onVolumeChange={onVolumeChange}
        />
      </div>
    </div>
  );
};
