import React from 'react'
import { RotateCw, Pause, AlertTriangle, CheckCircle2, Cpu } from 'lucide-react'
import { ScanProgressPayload } from '../../core/types'
import { MaintenanceStats } from '../../services/tauriBridge'

interface ActivityPillProps {
  telemetry: ScanProgressPayload
  maintenanceStats?: MaintenanceStats | null
  onClick: () => void
  isOpen: boolean
}

export const ActivityPill: React.FC<ActivityPillProps> = ({
  telemetry,
  maintenanceStats,
  onClick,
  isOpen,
}) => {
  const isMaintenanceActive = Boolean(
    maintenanceStats?.isRunning &&
      (maintenanceStats?.pendingItems ?? 0) > 0 &&
      maintenanceStats?.isIdle
  )

  if (
    !telemetry.isScanning &&
    telemetry.stage !== 'complete' &&
    telemetry.skippedCount === 0 &&
    !isMaintenanceActive
  ) {
    return null
  }

  const scanPercent =
    telemetry.totalCount > 0
      ? Math.min(100, Math.round((telemetry.processedCount / telemetry.totalCount) * 100))
      : 0

  const artTotal = maintenanceStats?.totalItems ?? 0
  const artPending = maintenanceStats?.pendingItems ?? 0
  const artScanned = Math.max(0, artTotal - artPending)
  const artPercent = artTotal > 0 ? Math.min(100, Math.round((artScanned / artTotal) * 100)) : 0

  return (
    <button
      onClick={onClick}
      title="Click to open Activity Center & Telemetry"
      className={`h-8 px-3 rounded-full text-xs font-medium flex items-center gap-2 transition-all duration-200 select-none cursor-pointer ${
        isOpen
          ? 'bg-[#00F5FF]/20 border border-[#00F5FF]/60 text-[#00F5FF] shadow-[0_0_15px_rgba(0,245,255,0.3)]'
          : telemetry.isPaused
          ? 'bg-amber-500/10 border border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
          : telemetry.isScanning
          ? 'bg-[#00F5FF]/10 border border-[#00F5FF]/30 text-[#00F5FF] hover:bg-[#00F5FF]/20 shadow-[0_0_10px_rgba(0,245,255,0.15)]'
          : isMaintenanceActive
          ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.15)]'
          : telemetry.skippedCount > 0
          ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
          : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
      }`}
    >
      {telemetry.isScanning ? (
        telemetry.isPaused ? (
          <Pause className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <RotateCw className="w-3.5 h-3.5 text-[#00F5FF] animate-spin" />
        )
      ) : isMaintenanceActive ? (
        <Cpu className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
      ) : telemetry.skippedCount > 0 ? (
        <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
      ) : (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
      )}

      <span>
        {telemetry.isScanning
          ? telemetry.isPaused
            ? `Paused • ${scanPercent}%`
            : `Indexing • ${scanPercent}%`
          : isMaintenanceActive
          ? `Indexing Art • ${artPercent}%`
          : telemetry.skippedCount > 0
          ? `${telemetry.skippedCount} Skipped`
          : 'Catalog Synced'}
      </span>

      {(telemetry.isScanning || isMaintenanceActive) && (
        <div className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden ml-1">
          <div
            className={`h-full transition-all duration-300 ${
              telemetry.isPaused
                ? 'bg-amber-400'
                : telemetry.isScanning
                ? 'bg-[#00F5FF]'
                : 'bg-cyan-400'
            }`}
            style={{ width: `${telemetry.isScanning ? scanPercent : artPercent}%` }}
          />
        </div>
      )}
    </button>
  )
}
