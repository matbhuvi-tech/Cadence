import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  RotateCw,
  Pause,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from 'lucide-react'
import { tauriBridge } from '../../services/tauriBridge'
import type { CommitTelemetryPayload } from '../../types/commit'
import type { CurateCommitRow } from '../../core/curateCommit'
import type { Release, Track } from '../../core/types'
import { CommitQueueDrawer, buildCommitQueueDrawerModel, type CommitQueueTrackIdentity } from './CommitQueueDrawer'

// oxlint-disable-next-line react/only-export-components
export { buildCommitQueueDrawerModel, type CommitQueueDrawerModel } from './CommitQueueDrawer'

const emptyRows: readonly CurateCommitRow[] = []

// oxlint-disable-next-line react/only-export-components
export function deriveExternalEngineCommitTelemetry(
  commitRows: readonly CurateCommitRow[],
  enginePlaybackActivity?: string,
): CommitTelemetryPayload {
  let pendingItems = 0
  let inflightItems = 0
  let completedItems = 0
  let failedItems = 0
  let hasCoolingDown = false
  let errorMessage: string | undefined

  for (const row of commitRows) {
    if (row.status === 'pending') {
      pendingItems++
      if (row.engineJobState === 'cooling_down') hasCoolingDown = true
    } else if (row.status === 'in_flight') {
      inflightItems++
    } else if (row.status === 'completed') {
      completedItems++
    } else if (row.status === 'failed') {
      failedItems++
      if (!errorMessage && row.errorMessage) errorMessage = row.errorMessage
    }
  }

  const totalItems = pendingItems + inflightItems + completedItems + failedItems
  const doneItems = completedItems + failedItems
  const percent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100

  let state: CommitTelemetryPayload['state'] = 'idle'
  if (inflightItems > 0) {
    state = 'writing'
  } else if (pendingItems > 0) {
    if (enginePlaybackActivity === 'playing' || enginePlaybackActivity === 'paused') {
      state = 'paused_playback'
    } else if (hasCoolingDown) {
      state = 'cooldown'
    } else {
      state = 'writing'
    }
  }

  return {
    state,
    pendingItems,
    inflightItems,
    completedItems,
    failedItems,
    totalItems,
    percent,
    throughputItemsPerSec: 0,
    offlineMounts: [],
    activeBatchDescription: totalItems > 0 ? 'Engine Tag Write Queue' : undefined,
    errorMessage,
  }
}

interface CommitStatusPillProps {
  onOpenQuarantine?: () => void
  alwaysVisible?: boolean
  commitRows?: readonly CurateCommitRow[]
  tracks?: Track[]
  releases?: Release[]
  portalTarget?: HTMLElement | null
  isExternalEngine?: boolean
  enginePlaybackActivity?: string
  onClearRecentCommits?: () => void
}

export const CommitStatusPill: React.FC<CommitStatusPillProps> = ({
  alwaysVisible = false,
  commitRows = emptyRows,
  tracks,
  releases,
  portalTarget,
  isExternalEngine = false,
  enginePlaybackActivity,
  onClearRecentCommits,
}) => {
  const [localTelemetry, setLocalTelemetry] = useState<CommitTelemetryPayload>({
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

  const useExternalDerived = isExternalEngine || !tauriBridge.hasLocalEngine()
  const telemetry = useMemo(
    () =>
      useExternalDerived
        ? deriveExternalEngineCommitTelemetry(commitRows, enginePlaybackActivity)
        : localTelemetry,
    [useExternalDerived, commitRows, enginePlaybackActivity, localTelemetry],
  )

  const [isOpen, setIsOpen] = useState(false)
  const [previousTarget, setPreviousTarget] = useState(portalTarget)
  if (previousTarget !== portalTarget) {
    setPreviousTarget(portalTarget)
    setIsOpen(false)
  }
  const drawerId = useId()
  const [showCompletedBanner, setShowCompletedBanner] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const completedTimerRef = useRef<NodeJS.Timeout | null>(null)
  const prevExternalStateRef = useRef<{ active: number; completed: number }>({
    active: 0,
    completed: 0,
  })

  // Trigger brief "All Changes Saved" banner when Engine jobs transition from active -> idle
  useEffect(() => {
    if (!useExternalDerived) return
    const active = telemetry.pendingItems + telemetry.inflightItems
    const completed = telemetry.completedItems
    const prev = prevExternalStateRef.current
    prevExternalStateRef.current = { active, completed }
    if (prev.active > 0 && active === 0 && completed > 0) {
      setShowCompletedBanner(true)
      if (completedTimerRef.current) clearTimeout(completedTimerRef.current)
      completedTimerRef.current = setTimeout(() => {
        setShowCompletedBanner(false)
      }, 8000)
    }
  }, [useExternalDerived, telemetry.pendingItems, telemetry.inflightItems, telemetry.completedItems])

  // Subscribe to live telemetry from Tauri native worker (only when local engine is active)
  useEffect(() => {
    if (isExternalEngine || !tauriBridge.hasLocalEngine()) return
    let unlisten: (() => void) | undefined

    const init = async () => {
      try {
        const initial = await tauriBridge.commitGetTelemetry()
        setLocalTelemetry(initial)

        unlisten = await tauriBridge.listenCommitTelemetry((payload) => {
          setLocalTelemetry((prev) => {
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
  }, [isExternalEngine])

  // Keyboard navigation & accessibility
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
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
    totalItems,
    percent,
    cooldownRemainingSecs,
    activeBatchId,
  } = telemetry

  const catalog = useMemo(() => {
    if (!isOpen || !tracks || !releases) return
    const releaseTitles = new Map(releases.map(release => [release.id, release.title]))
    const identities = new Map<string, CommitQueueTrackIdentity>()
    const queuedTrackIds = new Set(commitRows.map(row => row.trackId))
    for (const track of tracks) {
      if (!queuedTrackIds.has(track.id)) continue
      identities.set(track.id, {
        albumId: track.releaseId,
        albumTitle: releaseTitles.get(track.releaseId) || 'Unknown album',
        trackTitle: track.title,
      })
    }
    return identities
  }, [commitRows, isOpen, releases, tracks])
  const model = useMemo(
    () => buildCommitQueueDrawerModel(isOpen ? commitRows : emptyRows, telemetry, catalog),
    [catalog, commitRows, isOpen, telemetry],
  )

  const hasActiveWork = pendingItems > 0 || inflightItems > 0
  const isIdle = !hasActiveWork && state === 'idle'

  // If idle and not showing recent completion banner, render nothing (pure silence)
  if (!alwaysVisible && isIdle && !showCompletedBanner) {
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

  if (alwaysVisible) {
    const activeCount = isOpen ? model.activeCount : Math.max(
      pendingItems + inflightItems,
      commitRows.filter(row => row.status === 'pending' || row.status === 'in_flight').length,
    )
    if (activeCount === 0 && showCompletedBanner) {
      pillText = 'All Changes Saved'
    } else if (activeCount > 0 && state === 'paused_playback') {
      pillText = `Commit Queue (${activeCount} · Paused)`
    } else if (activeCount > 0 && state === 'cooldown') {
      pillText = `Commit Queue (${activeCount} · Cooldown)`
    } else {
      pillText = 'Commit Queue (' + activeCount + ')'
    }
  }

  const control = (
    <div className="relative inline-block text-left">
      <button
        ref={triggerRef}
        tabIndex={0}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? drawerId : undefined}
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
        <CommitQueueDrawer
          id={drawerId}
          drawerRef={popoverRef}
          telemetry={telemetry}
          model={model}
          isCurate={alwaysVisible}
          isExternalEngine={useExternalDerived}
          onClose={() => {
            setIsOpen(false)
            triggerRef.current?.focus()
          }}
          onClearRecent={() => {
            onClearRecentCommits?.()
            setShowCompletedBanner(false)
          }}
          onTogglePause={handleTogglePause}
          onCancelPending={handleCancelPending}
          onUndoBatch={handleUndoBatch}
          onRetryMounts={handleRetryMounts}
        />
      )}
    </div>
  )
  return portalTarget ? createPortal(control, portalTarget) : control
}
