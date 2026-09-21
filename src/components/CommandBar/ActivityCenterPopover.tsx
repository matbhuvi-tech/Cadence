import React from 'react'
import {
  X,
  Pause,
  Play,
  StopCircle,
  Database,
  FileSearch,
  Tag,
  Activity,
  AlertTriangle,
  FolderOpen,
} from 'lucide-react'
import { ScanProgressPayload } from '../../core/types'
import { tauriBridge } from '../../services/tauriBridge'

interface ActivityCenterPopoverProps {
  isOpen: boolean
  onClose: () => void
  telemetry: ScanProgressPayload
  onOpenQuarantineModal: () => void
}

export const ActivityCenterPopover: React.FC<ActivityCenterPopoverProps> = ({
  isOpen,
  onClose,
  telemetry,
  onOpenQuarantineModal,
}) => {
  if (!isOpen) return null

  const percent =
    telemetry.totalCount > 0
      ? Math.min(100, Math.round((telemetry.processedCount / telemetry.totalCount) * 100))
      : 0

  const formatEta = (secs: number) => {
    if (!secs || secs <= 0 || !isFinite(secs)) return 'Calculating...'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    if (m === 0) return `${s}s remaining`
    return `${m}m ${s}s remaining`
  }

  const stages = [
    { key: 'discovery', label: 'Discovery', icon: FileSearch },
    { key: 'extraction', label: 'Lofty Tags', icon: Tag },
    { key: 'database', label: 'SQLite FTS', icon: Database },
    { key: 'audio_analysis', label: 'DR & Audio', icon: Activity },
  ]

  const getCurrentStageIndex = () => {
    if (telemetry.stage === 'discovery') return 0
    if (telemetry.stage === 'extraction') return 1
    if (telemetry.stage === 'database') return 2
    if (telemetry.stage === 'complete') return 3
    return 1
  }

  const currentStageIdx = getCurrentStageIndex()

  return (
    <div className="absolute top-14 right-6 z-50 w-[440px] rounded-2xl border border-white/[0.12] bg-[#12151D]/95 backdrop-blur-2xl shadow-2xl p-5 text-white animate-in fade-in zoom-in-95 duration-150">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {telemetry.isScanning && !telemetry.isPaused && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00F5FF] opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                telemetry.isPaused
                  ? 'bg-amber-400'
                  : telemetry.isScanning
                  ? 'bg-[#00F5FF]'
                  : 'bg-emerald-400'
              }`}
            />
          </span>
          <h3 className="font-semibold text-sm tracking-wide">
            {telemetry.isScanning
              ? telemetry.isPaused
                ? 'Indexing Paused'
                : 'Library Ingestion Active'
              : 'Activity Center'}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white/80 p-1 rounded-lg hover:bg-white/[0.06] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Multi-Stage Pipeline Bar */}
      <div className="my-4">
        <div className="flex items-center justify-between gap-1 text-[11px] mb-2">
          {stages.map((st, i) => {
            const Icon = st.icon
            const isPassed = currentStageIdx > i || telemetry.stage === 'complete'
            const isCurrent = currentStageIdx === i && telemetry.isScanning
            return (
              <div
                key={st.key}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${
                  isCurrent
                    ? 'bg-[#00F5FF]/15 text-[#00F5FF] font-medium'
                    : isPassed
                    ? 'text-emerald-400 font-normal'
                    : 'text-white/30'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{st.label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Progress Bar & Counters */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-white/60">Total Ingestion Progress</span>
          <span className="font-mono font-medium text-[#00F5FF]">
            {percent}% ({telemetry.processedCount.toLocaleString()} /{' '}
            {telemetry.totalCount.toLocaleString()} tracks)
          </span>
        </div>
        <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              telemetry.isPaused ? 'bg-amber-400' : 'bg-gradient-to-r from-[#00F5FF] to-blue-500'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Current File Being Read */}
      <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 mb-4 text-xs">
        <div className="text-[10px] uppercase font-semibold text-white/40 mb-1 tracking-wider">
          Currently Processing
        </div>
        <div
          className="font-mono text-white/80 truncate text-[11px]"
          title={telemetry.currentFile || 'Waiting for next file...'}
        >
          {telemetry.currentFile ? `📄 ${telemetry.currentFile}` : 'Scanning directory hierarchy...'}
        </div>
        {telemetry.currentFolder && (
          <div
            className="text-white/40 truncate text-[10px] mt-0.5 flex items-center gap-1"
            title={telemetry.currentFolder}
          >
            <FolderOpen className="w-3 h-3 shrink-0" />
            <span className="truncate">{telemetry.currentFolder}</span>
          </div>
        )}
      </div>

      {/* Performance Telemetry Grid */}
      <div className="grid grid-cols-3 gap-2 mb-4 text-center">
        <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05]">
          <div className="text-[10px] text-white/40 mb-0.5">Throughput</div>
          <div className="font-mono font-medium text-xs text-white/90">
            {telemetry.speedTracksPerSec > 0
              ? `${telemetry.speedTracksPerSec.toFixed(1)} trk/s`
              : '—'}
          </div>
        </div>
        <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05]">
          <div className="text-[10px] text-white/40 mb-0.5">Estimated Time</div>
          <div className="font-mono font-medium text-xs text-white/90">
            {telemetry.isScanning ? formatEta(telemetry.etaSeconds) : 'Idle'}
          </div>
        </div>
        <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05]">
          <div className="text-[10px] text-white/40 mb-0.5">Skipped Files</div>
          <div
            className={`font-mono font-medium text-xs ${
              telemetry.skippedCount > 0 ? 'text-amber-400' : 'text-white/90'
            }`}
          >
            {telemetry.skippedCount}
          </div>
        </div>
      </div>

      {/* Skipped Files Alert Banner */}
      {telemetry.skippedCount > 0 && (
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>{telemetry.skippedCount} audio files were skipped</span>
          </div>
          <button
            onClick={() => {
              onClose()
              onOpenQuarantineModal()
            }}
            className="text-[11px] underline font-medium hover:text-white transition-colors"
          >
            Review Log
          </button>
        </div>
      )}

      {/* Control Buttons */}
      <div className="flex items-center justify-between pt-2 border-t border-white/[0.08]">
        {telemetry.isScanning ? (
          <>
            <div className="flex items-center gap-2">
              {telemetry.isPaused ? (
                <button
                  onClick={() => tauriBridge.resumeLibraryScan()}
                  className="px-3 py-1.5 rounded-lg bg-[#00F5FF]/20 hover:bg-[#00F5FF]/30 text-[#00F5FF] text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  Resume
                </button>
              ) : (
                <button
                  onClick={() => tauriBridge.pauseLibraryScan()}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Pause className="w-3.5 h-3.5" />
                  Pause
                </button>
              )}
              <button
                onClick={() => tauriBridge.cancelLibraryScan()}
                className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs font-medium flex items-center gap-1.5 transition-colors"
              >
                <StopCircle className="w-3.5 h-3.5" />
                Cancel
              </button>
            </div>
            <button
              onClick={onClose}
              className="text-xs text-white/50 hover:text-white/90 transition-colors"
            >
              Run in Background
            </button>
          </>
        ) : (
          <div className="w-full flex items-center justify-between text-xs text-white/50">
            <span>Database ready in WAL mode</span>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-white text-xs font-medium transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
