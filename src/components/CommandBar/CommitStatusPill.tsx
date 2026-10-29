import React, { useEffect, useRef, useState } from 'react'
import {
  RotateCw,
  Pause,
  Play,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  XCircle,
  Undo2,
  Clock,
  Sparkles,
} from 'lucide-react'
import { tauriBridge } from '../../services/tauriBridge'
import type { CommitTelemetryPayload } from '../../types/commit'

interface CommitStatusPillProps {
  onOpenQuarantine?: () => void
}

export const CommitStatusPill: React.FC<CommitStatusPillProps> = () => {
  const [telemetry, setTelemetry] = useState<CommitTelemetryPayload>({
    state: 'idle',
    pendingItems: 0,
    inflightItems: 0,
    completedItems: 0,
    failedItems: 0,
    totalItems: 0,
    percent: 100,
    throughputItemsPerSec: 0,
    offlineMounts: [],
  })

  const [isOpen, setIsOpen] = useState(false)
  const [showCompletedBanner, setShowCompletedBanner] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const completedTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Subscribe to live telemetry from Tauri native worker
  useEffect(() => {
    let unlisten: (() => void) | undefined

    const init = async () => {
      try {
        const initial = await tauriBridge.commitGetTelemetry()
        setTelemetry(initial)

        unlisten = await tauriBridge.listenCommitTelemetry((payload) => {
          setTelemetry((prev) => {
            // When transitioning from writing/paused to idle with items written, show subtle completion
            if (
              (prev.state === 'writing' || prev.state === 'cooldown' || prev.state === 'paused_playback') &&
              payload.state === 'idle' &&
              payload.completedItems > 0
            ) {
              setShowCompletedBanner(true)
              if (completedTimerRef.current) clearTimeout(completedTimerRef.current)
              completedTimerRef.current = setTimeout(() => {
                setShowCompletedBanner(false)
              }, 8000)
            }
            return payload
          })
        })
      } catch (err) {
        console.warn('[CommitStatusPill] Telemetry init error:', err)
      }
    }

    init()

    return () => {
      if (unlisten) unlisten()
      if (completedTimerRef.current) clearTimeout(completedTimerRef.current)
    }
  }, [])

  // Keyboard navigation & accessibility
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  // Dismiss on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        isOpen &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const {
    state,
    pendingItems,
    inflightItems,
    completedItems,
    failedItems,
    totalItems,
    percent,
    throughputItemsPerSec,
    cooldownRemainingSecs,
    offlineMounts,
    activeBatchId,
    activeBatchDescription,
    currentTrackTitle,
    currentTrackFilePath,
    errorMessage,
  } = telemetry

  const hasActiveWork = pendingItems > 0 || inflightItems > 0
  const isIdle = !hasActiveWork && state === 'idle'

  // If idle and not showing recent completion banner, render nothing (pure silence)
  if (isIdle && !showCompletedBanner) {
    return null
  }

  const handleTogglePause = async () => {
    try {
      await tauriBridge.commitTogglePause()
    } catch (err) {
      console.warn('Failed to toggle pause:', err)
    }
  }

  const handleCancelPending = async () => {
    if (!activeBatchId) return
    try {
      await tauriBridge.commitCancelBatch(activeBatchId)
    } catch (err) {
      console.warn('Failed to cancel batch:', err)
    }
  }

  const handleUndoBatch = async () => {
    if (!activeBatchId) return
    try {
      await tauriBridge.commitUndoBatch(activeBatchId)
    } catch (err) {
      console.warn('Failed to undo batch:', err)
    }
  }

  const handleRetryMounts = async () => {
    try {
      await tauriBridge.commitRetryOfflineMounts()
    } catch (err) {
      console.warn('Failed to retry offline mounts:', err)
    }
  }

  const handleForceOverride = async () => {
    if (!activeBatchId) return
    try {
      await tauriBridge.commitSetOverride(activeBatchId, true)
    } catch (err) {
      console.warn('Failed to set override:', err)
    }
  }

  // Label text for top pill
  let pillText = `Saving ${completedItems}/${totalItems || 1}`
  if (state === 'paused_playback') {
    pillText = 'Paused for Playback'
  } else if (state === 'cooldown') {
    pillText = `Resuming in ${cooldownRemainingSecs || 30}s...`
  } else if (state === 'paused_mount_offline') {
    pillText = 'Drive Disconnected'
  } else if (state === 'user_paused') {
    pillText = 'Saving Paused'
  } else if (showCompletedBanner) {
    pillText = 'All Changes Saved'
  }

  return (
    <div className="relative inline-block text-left">
      <button
        ref={triggerRef}
        tabIndex={0}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        title="Background Save Queue (Enter or Space to view details)"
        className={`h-8 px-3 rounded-full text-xs font-medium flex items-center gap-2 transition-all duration-200 select-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#00F5FF]/50 ${
          isOpen
            ? 'bg-[#00F5FF]/20 border border-[#00F5FF]/60 text-[#00F5FF] shadow-[0_0_15px_rgba(0,245,255,0.3)]'
            : state === 'paused_playback' || state === 'cooldown' || state === 'user_paused'
            ? 'bg-amber-500/10 border border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
            : state === 'paused_mount_offline'
            ? 'bg-rose-500/10 border border-rose-500/40 text-rose-300 hover:bg-rose-500/20 animate-pulse'
            : showCompletedBanner
            ? 'bg-emerald-500/10 border border-emerald-500/40 text-emerald-300'
            : 'bg-[#00F5FF]/10 border border-[#00F5FF]/30 text-[#00F5FF] hover:bg-[#00F5FF]/20 shadow-[0_0_10px_rgba(0,245,255,0.15)]'
        }`}
      >
        {state === 'writing' ? (
          <RotateCw className="w-3.5 h-3.5 text-[#00F5FF] animate-spin" />
        ) : state === 'cooldown' ? (
          <Clock className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
        ) : state === 'paused_playback' || state === 'user_paused' ? (
          <Pause className="w-3.5 h-3.5 text-amber-400" />
        ) : state === 'paused_mount_offline' ? (
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        )}

        <span>{pillText}</span>

        {hasActiveWork && (
          <div className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden ml-1">
            <div
              className={`h-full transition-all duration-300 ${
                state === 'paused_playback' || state === 'cooldown' || state === 'user_paused'
                  ? 'bg-amber-400'
                  : 'bg-[#00F5FF]'
              }`}
              style={{ width: `${Math.max(4, percent)}%` }}
            />
          </div>
        )}
      </button>

      {/* Accessible Popover Dialog */}
      {isOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Background Save Queue"
          className="absolute right-0 mt-2 w-96 rounded-xl bg-[#1C1C1E]/95 backdrop-blur-xl border border-white/15 p-4 shadow-2xl z-50 text-white animate-in fade-in zoom-in-95 duration-150"
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[#00F5FF]" />
              <span className="text-xs font-semibold uppercase tracking-wider text-white/80">
                Background Save Queue
              </span>
            </div>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                state === 'writing'
                  ? 'bg-[#00F5FF]/10 border-[#00F5FF]/30 text-[#00F5FF]'
                  : state === 'paused_playback' || state === 'cooldown' || state === 'user_paused'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : state === 'paused_mount_offline'
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              }`}
            >
              {state.toUpperCase().replace('_', ' ')}
            </span>
          </div>

          {/* Active Batch Summary */}
          <div className="py-3">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-[#8E8E93]">
                {activeBatchDescription || 'Batch Metadata Commit'}
              </span>
              <span className="font-mono text-white/90">
                {completedItems} of {totalItems} saved ({percent.toFixed(0)}%)
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden mb-2">
              <div
                className={`h-full transition-all duration-300 ${
                  state === 'paused_playback' || state === 'cooldown' || state === 'user_paused'
                    ? 'bg-amber-400'
                    : 'bg-[#00F5FF]'
                }`}
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-[#8E8E93] font-mono">
              <span>Throughput: {throughputItemsPerSec.toFixed(1)} files/sec</span>
              {failedItems > 0 && (
                <span className="text-rose-400 font-semibold">{failedItems} failed</span>
              )}
            </div>
          </div>

          {/* Current track writing indicator */}
          {currentTrackTitle && (
            <div className="p-2.5 rounded-lg bg-black/30 border border-white/5 mb-3 text-xs">
              <div className="text-[10px] text-[#8E8E93] uppercase tracking-wider mb-0.5">
                Current File
              </div>
              <div className="font-medium text-white truncate">{currentTrackTitle}</div>
              {currentTrackFilePath && (
                <div className="text-[10px] text-white/40 truncate font-mono">
                  {currentTrackFilePath}
                </div>
              )}
            </div>
          )}

          {/* Transport Preemption Advisory Banner */}
          {state === 'paused_playback' && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-3">
              <div className="font-semibold flex items-center gap-1.5 mb-1">
                <Pause className="w-3.5 h-3.5" />
                Listening Quietness Active
              </div>
              <p className="text-[11px] text-amber-300/80 leading-relaxed mb-2">
                Storage Bus Silence is protected during audio playback. Saving will resume after 30
                seconds of quietness.
              </p>
              <button
                onClick={handleForceOverride}
                className="text-[10px] font-semibold text-amber-200 underline hover:text-white cursor-pointer"
              >
                Force Save Now (Shared mode only · may impact playback)
              </button>
            </div>
          )}

          {/* Cooldown Timer Banner */}
          {state === 'cooldown' && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-3">
              <div className="font-semibold flex items-center gap-1.5 mb-1">
                <Clock className="w-3.5 h-3.5" />
                Storage Quietness Cooldown
              </div>
              <p className="text-[11px] text-amber-300/80 leading-relaxed">
                Waiting for playback bus settling... Resuming writes in{' '}
                <span className="font-mono font-bold">{cooldownRemainingSecs || 30}s</span>.
              </p>
            </div>
          )}

          {/* Mount Offline Alert */}
          {offlineMounts.length > 0 && (
            <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs mb-3">
              <div className="font-semibold flex items-center gap-1.5 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                Drive Offline
              </div>
              <p className="text-[11px] text-rose-300/80 leading-relaxed mb-2">
                Mount <span className="font-mono">{offlineMounts.join(', ')}</span> is currently
                unreachable. Reconnect drive to continue saving.
              </p>
              <button
                onClick={handleRetryMounts}
                className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[10px] font-medium transition cursor-pointer"
              >
                Retry Mount Connection
              </button>
            </div>
          )}

          {/* Error Message */}
          {errorMessage && (
            <div className="p-2 rounded bg-rose-950/40 border border-rose-500/30 text-rose-300 text-[11px] mb-3">
              {errorMessage}
            </div>
          )}

          {/* Actions Bar */}
          <div className="flex items-center justify-between pt-3 border-t border-white/10 text-xs">
            <button
              onClick={handleTogglePause}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
            >
              {state === 'user_paused' ? (
                <>
                  <Play className="w-3 h-3 text-[#00F5FF]" /> Resume
                </>
              ) : (
                <>
                  <Pause className="w-3 h-3 text-amber-400" /> Pause
                </>
              )}
            </button>

            <div className="flex items-center gap-2">
              {hasActiveWork && (
                <button
                  onClick={handleCancelPending}
                  title="Stop remaining unwritten tracks in this batch"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/5 hover:bg-rose-500/20 text-white/70 hover:text-rose-300 transition cursor-pointer"
                >
                  <XCircle className="w-3 h-3" /> Cancel Pending
                </button>
              )}

              {completedItems > 0 && (
                <button
                  onClick={handleUndoBatch}
                  title="Revert already committed tracks using pre-commit snapshot"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/5 hover:bg-[#00F5FF]/20 text-white/70 hover:text-[#00F5FF] transition cursor-pointer"
                >
                  <Undo2 className="w-3 h-3" /> Undo Batch
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
