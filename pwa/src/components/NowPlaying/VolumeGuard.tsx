import React, { useState } from 'react';
import { Lock, Unlock, Volume2, VolumeX } from 'lucide-react';

interface VolumeGuardProps {
  volume: number;
  isBitPerfect: boolean;
  onVolumeChange: (vol: number) => void;
}

export const VolumeGuard: React.FC<VolumeGuardProps> = ({
  volume,
  isBitPerfect,
  onVolumeChange,
}) => {
  const [isUnlocked, setIsUnlocked] = useState(false);

  // If in bit-perfect mode and not explicitly overridden, show the lock guard
  const isLocked = isBitPerfect && !isUnlocked;

  return (
    <div className="w-full max-w-sm mx-auto bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-3 flex flex-col space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center space-x-1.5 text-zinc-400">
          {volume === 0 ? (
            <VolumeX className="w-4 h-4 text-rose-400" />
          ) : (
            <Volume2 className="w-4 h-4 text-zinc-300" />
          )}
          <span className="font-medium">Output Volume</span>
        </div>

        {isBitPerfect && (
          <button
            onClick={() => setIsUnlocked(!isUnlocked)}
            className="flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-[#D4AF37] border border-amber-500/20 text-[10px] font-mono hover:bg-amber-500/20 active:scale-95 transition-all"
          >
            {isLocked ? (
              <>
                <Lock className="w-3 h-3 text-[#D4AF37]" />
                <span>LOCKED</span>
              </>
            ) : (
              <>
                <Unlock className="w-3 h-3 text-amber-400" />
                <span>OVERRIDDEN</span>
              </>
            )}
          </button>
        )}
      </div>

      {isLocked ? (
        <div className="flex items-center justify-center py-2 px-3 bg-zinc-950/60 rounded-xl border border-zinc-800/40 text-center">
          <p className="text-xs text-zinc-400 font-mono flex items-center space-x-1.5">
            <Lock className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Purity Signal Path (100% Unity Gain)</span>
          </p>
        </div>
      ) : (
        <div className="flex items-center space-x-3 px-1">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
          />
          <span className="text-xs font-mono text-zinc-300 min-w-[36px] text-right">
            {Math.round(volume * 100)}%
          </span>
        </div>
      )}
    </div>
  );
};
