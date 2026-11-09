import React from 'react';
import { Play, Pause, ChevronUp, Disc3 } from 'lucide-react';
import type { PlaybackStatus } from '../../types/remote';

interface MiniPlayerProps {
  status: PlaybackStatus;
  onExpand: () => void;
  onPlayPause: () => void;
}

export const MiniPlayer: React.FC<MiniPlayerProps> = ({
  status,
  onExpand,
  onPlayPause,
}) => {
  const isVisible = (status.isPlaying || status.isPaused) && Boolean(status.currentFile);
  const stream = status.streamInfo;
  const title = stream?.title || (status.currentFile ? status.currentFile.split(/[\\/]/).pop() : 'No Track Loaded');
  const artist = stream?.artist || 'Unknown Artist';
  const format = stream?.format || 'PCM';
  const isDsd = format.toUpperCase().includes('DSD') || format.toUpperCase().includes('DSF') || format.toUpperCase().includes('DFF');

  return (
    <div
      style={{
        transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      className={`mx-3 z-20 shrink-0 ${
        isVisible
          ? 'h-13 opacity-100 mb-2 pointer-events-auto'
          : 'h-0 opacity-0 mb-0 pointer-events-none overflow-hidden'
      }`}
    >
      <div
        onClick={onExpand}
        className="h-full px-3.5 bg-[#14161C]/95 backdrop-blur-md rounded-2xl border border-zinc-800/80 shadow-lg flex items-center justify-between cursor-pointer active:scale-[0.99] transition-transform select-none"
      >
        {/* Track Metadata & Leading Disc */}
        <div className="flex items-center space-x-3 min-w-0 flex-1 pr-2">
          <div className="w-8 h-8 rounded-lg bg-zinc-800/80 border border-zinc-700/40 flex items-center justify-center shrink-0 overflow-hidden">
            <Disc3
              className={`w-5 h-5 text-[#D4AF37] ${
                status.isPlaying && !status.isPaused ? 'animate-spin-slow' : ''
              }`}
              style={{ animationDuration: '8s' }}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center space-x-1.5">
              <p className="text-xs font-semibold text-zinc-100 truncate">
                {title}
              </p>
              {stream?.isHighRes && (
                <span className="px-1 py-0.2 rounded bg-amber-500/20 text-[9px] font-mono font-bold text-amber-400 shrink-0">
                  {isDsd ? 'DSD' : 'HI-RES'}
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400 truncate">
              {artist}
            </p>
          </div>
        </div>

        {/* Trailing Controls: 44pt Play/Pause and Expand Chevron */}
        <div className="flex items-center space-x-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onPlayPause}
            className="w-11 h-11 flex items-center justify-center rounded-full text-zinc-200 hover:text-white active:scale-95 transition-transform"
            aria-label={status.isPlaying && !status.isPaused ? 'Pause' : 'Play'}
          >
            {status.isPlaying && !status.isPaused ? (
              <Pause className="w-5 h-5 fill-current text-amber-400" />
            ) : (
              <Play className="w-5 h-5 fill-current text-amber-400 ml-0.5" />
            )}
          </button>

          <button
            onClick={onExpand}
            className="w-8 h-11 flex items-center justify-center text-zinc-500 hover:text-zinc-300"
            aria-label="Expand Now Playing"
          >
            <ChevronUp className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
      </div>
    </div>
  );
};
