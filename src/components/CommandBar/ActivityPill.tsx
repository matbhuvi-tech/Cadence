import React from 'react'
import { RotateCw, Pause, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ScanProgressPayload } from '../../core/types'

interface ActivityPillProps {
  telemetry: ScanProgressPayload
  onClick: () => void
  isOpen: boolean
}

export const ActivityPill: React.FC<ActivityPillProps> = ({ telemetry, onClick, isOpen }) => {
  if (!telemetry.isScanning && telemetry.stage !== 'complete' && telemetry.skippedCount === 0) {
    return null
  }

  const percent =
    telemetry.totalCount > 0
      ? Math.min(100, Math.round((telemetry.processedCount / telemetry.totalCount) * 100))
      : 0

  return (
    <button
      onClick={onClick}
      title="Click to open Activity Center & Scan Telemetry"
      className={`h-8 px-3 rounded-full text-xs font-medium flex items-center gap-2 transition-all duration-200 select-none ${
        isOpen
          ? 'bg-[#00F5FF]/20 border border-[#00F5FF]/60 text-[#00F5FF] shadow-[0_0_15px_rgba(0,245,255,0.3)]'
          : telemetry.isPaused
          ? 'bg-amber-500/10 border border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
          : telemetry.isScanning
          ? 'bg-[#00F5FF]/10 border border-[#00F5FF]/30 text-[#00F5FF] hover:bg-[#00F5FF]/20 shadow-[0_0_10px_rgba(0,245,255,0.15)]'
          : telemetry.skippedCount > 0
          ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
          : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
      }`}
    >
      {telemetry.isScanning ? (
        telemetry.isPaused ? (
          <Pause className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <RotateCw className="w-3.5 h-3.5 text-[#00F5FF] animate-spin" />
        )
      ) : telemetry.skippedCount > 0 ? (
        <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
      ) : (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
      )}

      <span>
        {telemetry.isScanning
          ? telemetry.isPaused
            ? `Paused • ${percent}%`
            : `Indexing • ${percent}%`
          : telemetry.skippedCount > 0
          ? `${telemetry.skippedCount} Skipped`
          : 'Catalog Synced'}
      </span>

      {telemetry.isScanning && (
        <div className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden ml-1">
          <div
            className={`h-full transition-all duration-300 ${
              telemetry.isPaused ? 'bg-amber-400' : 'bg-[#00F5FF]'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </button>
  )
}
