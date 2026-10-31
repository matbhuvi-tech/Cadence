import React from 'react';
import { Trash2, Disc3, Clock, X, Volume2 } from 'lucide-react';
import type { RemoteQueue } from '../../types/remote';

interface QueueViewProps {
  queue: RemoteQueue;
  onJumpToIndex: (index: number) => void;
  onRemoveFromQueue: (index: number, trackId?: string) => void;
  onClearQueue: () => void;
}

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export const QueueView: React.FC<QueueViewProps> = ({
  queue,
  onJumpToIndex,
  onRemoveFromQueue,
  onClearQueue,
}) => {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0D0E11]">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-zinc-800/60 bg-[#0D0E11]/80 backdrop-blur-sm shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Playback Queue</h2>
          <p className="text-[11px] text-zinc-500 font-mono">
            {queue.items.length} {queue.items.length === 1 ? 'track' : 'tracks'}
          </p>
        </div>

        {queue.items.length > 0 && (
          <button
            onClick={onClearQueue}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-rose-400 text-xs active:scale-95 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Queue List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 pb-8">
        {queue.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center px-6">
            <Disc3 className="w-12 h-12 text-zinc-700 stroke-[1.2] mb-2" />
            <p className="text-sm font-medium text-zinc-400">Queue is empty</p>
            <p className="text-xs text-zinc-600 mt-1">
              Browse the catalog to enqueue bit-perfect tracks or full albums
            </p>
          </div>
        ) : (
          queue.items.map((item, idx) => {
            const isCurrent = idx === queue.currentIndex;

            return (
              <div
                key={`${item.id}-${idx}`}
                className={`flex items-center justify-between p-3 rounded-2xl border transition-all ${
                  isCurrent
                    ? 'bg-amber-500/10 border-amber-500/40 text-[#D4AF37] shadow-sm'
                    : 'bg-zinc-900/40 border-zinc-800/60 text-zinc-300 hover:bg-zinc-800/40'
                }`}
              >
                {/* Clickable body to jump to track */}
                <div
                  onClick={() => onJumpToIndex(idx)}
                  className="flex items-center space-x-3 flex-1 min-w-0 cursor-pointer"
                >
                  <div className="w-6 flex items-center justify-center shrink-0">
                    {isCurrent ? (
                      <Volume2 className="w-4 h-4 text-[#D4AF37] animate-pulse" />
                    ) : (
                      <span className="text-xs font-mono text-zinc-500">{idx + 1}</span>
                    )}
                  </div>

                  <div className="truncate flex-1">
                    <p
                      className={`text-xs font-semibold truncate ${
                        isCurrent ? 'text-[#D4AF37]' : 'text-zinc-200'
                      }`}
                    >
                      {item.title}
                    </p>
                    <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                      {item.artist} • <span className="text-zinc-500">{item.album}</span>
                    </p>
                  </div>
                </div>

                {/* Track Format Badge & Controls */}
                <div className="flex items-center space-x-2 pl-2 shrink-0">
                  {item.isHighRes && (
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[9px] font-mono font-bold text-amber-400 border border-amber-500/20">
                      HI-RES
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-zinc-500 flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-zinc-600" />
                    <span>{formatDuration(item.durationSecs)}</span>
                  </span>
                  <button
                    onClick={() => onRemoveFromQueue(idx, item.id)}
                    className="p-1 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 active:scale-95"
                    title="Remove from queue"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

