import React, { useState, useEffect } from 'react'
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
  Sparkles,
  Cpu,
  Image as ImageIcon,
} from 'lucide-react'
import { ScanProgressPayload } from '../../core/types'
import { tauriBridge } from '../../services/tauriBridge'
import { useMaintenanceWorker } from '../../hooks/useMaintenanceWorker'
import { backgroundArtworkService, BackgroundArtworkState } from '../../services/backgroundArtworkService'

interface ActivityCenterPopoverProps {
  isOpen: boolean
  onClose: () => void
  telemetry: ScanProgressPayload
  onOpenQuarantineModal: () => void
  onDismissAllSkipped?: () => void
}

export const ActivityCenterPopover: React.FC<ActivityCenterPopoverProps> = ({
  isOpen,
  onClose,
  telemetry,
  onOpenQuarantineModal,
  onDismissAllSkipped,
}) => {
  const { maintenanceStats } = useMaintenanceWorker(isOpen)
  const [aiQuota, setAiQuota] = useState<{
    rateLimitRpm: number
    pacingIntervalMs: number
    nextSlotRemainingMs: number
    isPacingActive: boolean
  } | null>(null)

  const [bgArtState, setBgArtState] = useState<BackgroundArtworkState>(() => backgroundArtworkService.getState())

  useEffect(() => {
    if (!isOpen) return
    return backgroundArtworkService.subscribe((s) => setBgArtState(s))
  }, [isOpen])

  const [playbackPolicy, setPlaybackPolicy] = useState<'purist' | 'paced' | 'unthrottled'>(() => {
    return (localStorage.getItem('cadence_scan_playback_policy') as any) || 'purist'
  })

  const handlePolicySwitch = (policy: 'purist' | 'paced' | 'unthrottled') => {
    setPlaybackPolicy(policy)
    localStorage.setItem('cadence_scan_playback_policy', policy)
    tauriBridge.setScannerPlaybackPolicy(policy).catch(() => {})
  }

  useEffect(() => {
    if (!isOpen) return
    let isMounted = true
    const checkQuota = async () => {
      try {
        const res = await fetch('/api/ai-quota-telemetry')
        if (res.ok && isMounted) {
          const data = await res.json()
          setAiQuota(data)
        }
      } catch {}
    }
    checkQuota()
    const interval = setInterval(checkQuota, 2000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [isOpen])

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
                telemetry.stage === 'suspended_playback'
                  ? 'bg-amber-400'
                  : telemetry.isPaused
                  ? 'bg-amber-400'
                  : telemetry.isScanning
                  ? 'bg-[#00F5FF]'
                  : 'bg-emerald-400'
              }`}
            />
          </span>
          <h3 className="font-semibold text-sm tracking-wide">
            {telemetry.stage === 'suspended_playback'
              ? 'Suspended (Playback Active)'
              : telemetry.isScanning
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

      {/* Playback Suspended Banner */}
      {telemetry.stage === 'suspended_playback' && (
        <div className="mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-medium text-[11px]">
              Transport Purity: Scan paused during playback to guarantee zero disk/NIC jitter.
            </span>
          </div>
          <button
            onClick={() => handlePolicySwitch('paced')}
            className="text-[10px] font-mono underline text-amber-200 hover:text-white cursor-pointer shrink-0 ml-2"
          >
            Switch to Paced
          </button>
        </div>
      )}

      {/* Multi-Stage Pipeline Bar */}
      <div className="my-4">
        <div className="flex items-center justify-between gap-1 text-[11px] mb-2">
          {stages.map((st, i) => {
            const Icon = st.icon
            const isAudioStage = st.key === 'audio_analysis'
            const isAudioActive =
              isAudioStage &&
              Boolean(
                maintenanceStats?.isRunning &&
                  (maintenanceStats?.pendingItems ?? 0) > 0 &&
                  maintenanceStats?.isIdle
              )
            const isAudioPassed =
              isAudioStage &&
              Boolean(maintenanceStats && maintenanceStats.pendingItems === 0)

            const isPassed = isAudioStage
              ? isAudioPassed
              : currentStageIdx > i || telemetry.stage === 'complete'
            const isCurrent = isAudioStage
              ? isAudioActive
              : currentStageIdx === i && telemetry.isScanning
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
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                onClose()
                onOpenQuarantineModal()
              }}
              className="text-[11px] underline font-medium hover:text-white transition-colors cursor-pointer"
            >
              Review Log
            </button>
            {onDismissAllSkipped && (
              <button
                onClick={onDismissAllSkipped}
                className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 transition-colors cursor-pointer"
              >
                Dismiss All
              </button>
            )}
          </div>
        </div>
      )}

      {/* Audio-Idle Background Worker Bento */}
      {maintenanceStats && (
        <div className="mb-4 p-3 rounded-xl bg-black/40 border border-white/[0.08] flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>Audio-Idle Maintenance Worker</span>
            </div>
            <span
              className={`text-[9px] font-mono px-2 py-0.5 rounded-full flex items-center gap-1 ${
                maintenanceStats.statusMessage.startsWith('Suspended')
                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                  : maintenanceStats.statusMessage.startsWith('Cooling')
                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                  : maintenanceStats.pendingItems === 0
                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                  : 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  maintenanceStats.statusMessage.startsWith('Suspended')
                    ? 'bg-amber-400'
                    : maintenanceStats.statusMessage.startsWith('Cooling')
                    ? 'bg-amber-300 animate-pulse'
                    : maintenanceStats.pendingItems === 0
                    ? 'bg-emerald-400'
                    : 'bg-cyan-400 animate-pulse'
                }`}
              />
              {maintenanceStats.statusMessage.startsWith('Suspended')
                ? 'Paused — Transport Purity'
                : maintenanceStats.statusMessage.startsWith('Cooling')
                ? maintenanceStats.statusMessage.match(/\d+s/)?.[0]
                  ? `Cooldown (${maintenanceStats.statusMessage.match(/\d+s/)?.[0]})`
                  : 'Cooldown (30s)'
                : maintenanceStats.pendingItems === 0
                ? 'Up to date'
                : 'Active'}
            </span>
          </div>

          <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
            <span className="flex items-center gap-1.5">
              <ImageIcon className="w-3 h-3 text-slate-400" />
              <span>Album Covers Pre-Cached:</span>
            </span>
            <span className="font-mono text-white">
              {maintenanceStats.cachedCount} / {maintenanceStats.totalItems} Albums
            </span>
          </div>

          {/* Progress bar for artwork caching */}
          {maintenanceStats.totalItems > 0 && (
            <div className="w-full bg-white/[0.06] rounded-full h-1 overflow-hidden">
              <div
                className="bg-cyan-400 h-full transition-all duration-300"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((maintenanceStats.cachedCount / maintenanceStats.totalItems) * 100)
                  )}%`,
                }}
              />
            </div>
          )}

          <div className="text-[10px] text-white/40 font-mono truncate" title={maintenanceStats.statusMessage}>
            {maintenanceStats.statusMessage}
          </div>
        </div>
      )}

      {/* Background Archival Artwork Enrichment Bento */}
      {bgArtState.status !== 'idle' && (
        <div className="mb-4 p-3 rounded-xl bg-black/40 border border-amber-500/20 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Archival Artwork Enrichment</span>
            </div>
            <span
              className={`text-[9px] font-mono px-2 py-0.5 rounded-full flex items-center gap-1 ${
                bgArtState.status === 'suspended_playback'
                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                  : bgArtState.status === 'cooldown'
                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                  : bgArtState.status === 'user_paused'
                  ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                  : bgArtState.status === 'complete'
                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  bgArtState.status === 'suspended_playback'
                    ? 'bg-amber-400'
                    : bgArtState.status === 'cooldown'
                    ? 'bg-amber-300 animate-pulse'
                    : bgArtState.status === 'user_paused'
                    ? 'bg-zinc-400'
                    : bgArtState.status === 'complete'
                    ? 'bg-emerald-400'
                    : 'bg-amber-400 animate-pulse'
                }`}
              />
              {bgArtState.status === 'suspended_playback'
                ? 'Suspended — Audio Active'
                : bgArtState.status === 'cooldown'
                ? `Cooldown (${bgArtState.cooldownRemainingSecs}s)`
                : bgArtState.status === 'user_paused'
                ? 'Paused'
                : bgArtState.status === 'complete'
                ? 'Complete'
                : 'Active'}
            </span>
          </div>

          <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
            <span className="flex items-center gap-1.5">
              <ImageIcon className="w-3 h-3 text-amber-400/80" />
              <span>Archival Covers Staged:</span>
            </span>
            <span className="font-mono text-white">
              {bgArtState.completed} / {bgArtState.total} Albums
            </span>
          </div>

          {/* Progress bar */}
          {bgArtState.total > 0 && (
            <div className="w-full bg-white/[0.06] rounded-full h-1 overflow-hidden">
              <div
                className="bg-amber-400 h-full transition-all duration-300"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((bgArtState.completed / bgArtState.total) * 100)
                  )}%`,
                }}
              />
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-white/50 font-mono truncate max-w-[200px]" title={bgArtState.currentAlbumTitle}>
              {bgArtState.currentAlbumTitle ? `Resolving: ${bgArtState.currentAlbumTitle}` : 'Waiting for audio idle...'}
            </span>
            <div className="flex items-center gap-1.5">
              {bgArtState.status === 'user_paused' ? (
                <button
                  type="button"
                  onClick={() => backgroundArtworkService.resume()}
                  className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 transition-colors cursor-pointer"
                >
                  Resume
                </button>
              ) : bgArtState.status === 'active' || bgArtState.status === 'cooldown' ? (
                <button
                  type="button"
                  onClick={() => backgroundArtworkService.pause()}
                  className="px-2 py-0.5 rounded text-[10px] font-mono bg-white/10 hover:bg-white/20 text-zinc-300 border border-white/10 transition-colors cursor-pointer"
                >
                  Pause
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => backgroundArtworkService.cancel()}
                className="px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gemini AI Quota & Pacing Telemetry Bento */}
      <div className="mb-4 p-3 rounded-xl bg-black/40 border border-white/[0.08] flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span>Gemini AI Cloud Pipeline</span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
            Free Tier (15 RPM Safe)
          </span>
        </div>

        <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
          <span>Token Bucket Buffer:</span>
          <span className="font-mono text-white">
            {aiQuota?.isPacingActive
              ? `Refilling in ${(aiQuota.nextSlotRemainingMs / 1000).toFixed(1)}s`
              : 'Safe Pacing Active (4.0s Floor)'}
          </span>
        </div>

        {/* 15-LED Quota Slot Display */}
        <div className="flex items-center justify-between pt-1 border-t border-white/[0.06]">
          <span className="text-[10px] text-[#64748B] font-mono">1-Min Window Budget:</span>
          <div className="flex items-center gap-1" title="15 Requests Per Minute Safe Window">
            {Array.from({ length: 15 }).map((_, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${
                  aiQuota?.isPacingActive && i < 4
                    ? 'bg-amber-400'
                    : i < 3
                    ? 'bg-cyan-400'
                    : 'bg-white/10'
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Audiophile Playback Policy Selector */}
      <div className="mb-3 pt-2 border-t border-white/[0.06] flex items-center justify-between">
        <span className="text-[11px] text-white/50">Playback Scan Policy:</span>
        <div className="flex items-center gap-1 bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.06]">
          {(['purist', 'paced', 'unthrottled'] as const).map(p => (
            <button
              key={p}
              onClick={() => handlePolicySwitch(p)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize transition-all ${
                playbackPolicy === p
                  ? p === 'purist'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : p === 'paced'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

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
