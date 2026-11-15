import React from 'react';
import { ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import type { EngineKind, PlaybackStatus } from '../../types/remote';

interface TopHeaderProps {
  status: PlaybackStatus;
  isConnected: boolean;
  isConnecting: boolean;
  serverLabel?: string;
  engineKind?: EngineKind;
  outputLabel?: string | null;
  onOpenDiagnostics?: () => void;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  status,
  isConnected,
  isConnecting,
  serverLabel,
  engineKind = 'local',
  outputLabel,
  onOpenDiagnostics,
}) => {
  const stream = status.streamInfo;

  // Format label for audiophile signal badge
  const formatBadge = () => {
    if (!stream) {
      if (status.isBitPerfect) return 'RAW STREAM';
      if (status.purityMode) return 'UNITY GAIN';
      return 'READY';
    }

    if (stream.format.toUpperCase().includes('DSD')) {
      return `${stream.format.toUpperCase()} DIRECT`;
    }

    if (stream.sampleRate && stream.bitDepth) {
      const khz = (stream.sampleRate / 1000).toFixed(1).replace('.0', '');
      return `${stream.format.toUpperCase()} ${khz}kHz / ${stream.bitDepth}b`;
    }

    return stream.format.toUpperCase();
  };

  return (
    <header className="shrink-0 bg-[#0D0E11]/90 backdrop-blur-md border-b border-zinc-800/60 px-4 pt-[calc(var(--sat)+0.75rem)] pb-3 z-30 flex items-center justify-between">
      {/* Brand & Connection Status */}
      <div className="flex items-center space-x-2.5">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#D4AF37]/30 to-amber-950/40 border border-[#D4AF37]/40 flex items-center justify-center">
          <div className="w-2.5 h-2.5 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.8)]" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-semibold tracking-wider text-zinc-100 font-mono">
            CADENCE
          </span>
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col gap-0.5 text-[10px]"
          >
            <div className="flex items-center space-x-1.5 min-w-0">
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isConnected
                    ? 'bg-emerald-500'
                    : isConnecting
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                }`}
              />
              <span
                className={`font-medium truncate max-w-[180px] ${
                  isConnected
                    ? 'text-emerald-400'
                    : isConnecting
                    ? 'text-amber-400'
                    : 'text-rose-400'
                }`}
              >
                {`Playback engine: ${serverLabel || (engineKind === 'core' ? 'Cadence Core' : 'Cadence Desktop')}`}
                {!isConnected && !isConnecting ? ' • Disconnected' : isConnecting ? ' • Syncing' : ''}
              </span>
            </div>
            <span className="text-zinc-400 truncate max-w-[180px]">
              {`Audio output: ${outputLabel || status.activeDevice || 'Unassigned'}`}
            </span>
          </div>
        </div>
      </div>

      {/* Audiophile Transport Badge */}
      <div className="flex items-center space-x-1.5">
        <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-zinc-900/80 border border-amber-500/30 text-[#D4AF37]">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span className="text-[11px] font-mono font-semibold tracking-wide">
            {formatBadge()}
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenDiagnostics}
          aria-label="Open connection status and diagnostics"
          className="min-w-[44px] min-h-[44px] -mr-2 rounded-xl flex items-center justify-center text-zinc-400 hover:bg-zinc-900 active:scale-95 transition-transform"
        >
          {isConnected ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-rose-400" />
          )}
        </button>
      </div>
    </header>
  );
};

