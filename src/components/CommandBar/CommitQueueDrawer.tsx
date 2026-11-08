import { AlertTriangle, Clock, HardDrive, Pause, Play, Undo2, X, XCircle } from 'lucide-react'
import React, { type Ref } from 'react'
import type { CurateCommitRow } from '../../core/curateCommit'
import type { CommitTelemetryPayload } from '../../types/commit'

export interface CommitQueueTrackIdentity {
  albumId: string
  albumTitle: string
  trackTitle: string
}

export interface CommitQueueDrawerModel {
  activeCount: number
  albums: {
    id: string
    title: string
    tracks: { id: string; title: string; statusLabel: string }[]
  }[]
}

// oxlint-disable-next-line react/only-export-components
export function buildCommitQueueDrawerModel(
  commitRows: readonly CurateCommitRow[],
  telemetry: CommitTelemetryPayload | null,
  catalog?: ReadonlyMap<string, CommitQueueTrackIdentity>,
): CommitQueueDrawerModel {
  const albums = new Map<string, CommitQueueDrawerModel['albums'][number]>()
  const labels: Record<'pending' | 'in_flight', string> = {
    pending: telemetry?.state === 'paused_playback' ? 'Queued — waiting for playback'
      : telemetry?.state === 'cooldown' ? 'Queued — cooldown' : 'Queued',
    in_flight: 'Writing',
  }
  let activeCount = 0
  for (const row of commitRows) {
    if (row.status !== 'pending' && row.status !== 'in_flight') continue
    let identity = catalog?.get(row.trackId)
    if (!identity) {
      try {
        const payload = JSON.parse(row.payloadJson)
        if (typeof payload?.album === 'string' && payload.album.trim()) {
          identity = {
            albumId: 'payload:' + (payload.curateReviewId || payload.album),
            albumTitle: payload.album,
            trackTitle: typeof payload.title === 'string' ? payload.title : row.trackId,
          }
        }
      } catch {
        // A missing catalog entry can still display its queue status.
      }
    }
    const id = identity?.albumId ?? 'unknown'
    let album = albums.get(id)
    if (!album) {
      album = { id, title: identity?.albumTitle ?? 'Unknown album', tracks: [] }
      albums.set(id, album)
    }
    album.tracks.push({
      id: row.id, title: identity?.trackTitle || row.trackId,
      statusLabel: labels[row.status],
    })
    activeCount++
  }
  return {
    activeCount: Math.max(activeCount, (telemetry?.pendingItems ?? 0) + (telemetry?.inflightItems ?? 0)),
    albums: [...albums.values()],
  }
}

interface CommitQueueDrawerProps {
  id: string
  drawerRef: Ref<HTMLDivElement>
  telemetry: CommitTelemetryPayload
  model: CommitQueueDrawerModel
  isCurate: boolean
  onClose: () => void
  onTogglePause: () => void
  onCancelPending: () => void
  onUndoBatch: () => void
  onRetryMounts: () => void
}

export function CommitQueueDrawer({
  id, drawerRef, telemetry, model, isCurate, onClose,
  onTogglePause, onCancelPending, onUndoBatch, onRetryMounts,
}: CommitQueueDrawerProps) {
  const {
    state, pendingItems, inflightItems, completedItems, failedItems, totalItems,
    percent, throughputItemsPerSec, cooldownRemainingSecs, offlineMounts, activeBatchId,
    activeBatchDescription, currentTrackTitle, currentTrackFilePath, errorMessage,
  } = telemetry
  const hasActiveWork = pendingItems > 0 || inflightItems > 0
  const showBatch = !isCurate || hasActiveWork
  const title = isCurate ? 'Commit Queue' : 'Background Save Queue'

  return (
    <div
      id={id}
      ref={drawerRef}
      role="dialog"
      aria-label={title}
      className="absolute right-0 mt-2 max-h-[calc(100vh-8rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl bg-[#1C1C1E]/95 backdrop-blur-xl border border-white/15 p-4 shadow-2xl z-50 text-white animate-in fade-in zoom-in-95 duration-150"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-[#00F5FF]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-white/80">
            {title}
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
          {state.replaceAll('_', ' ').toUpperCase()}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="rounded p-1 text-zinc-300 hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Active Batch Summary */}
      {showBatch && (
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
      )}

      {/* Current track writing indicator */}
      {showBatch && currentTrackTitle && (
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
      {showBatch && state === 'paused_playback' && (
        <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-3">
          <div className="font-semibold flex items-center gap-1.5 mb-1">
            <Pause className="w-3.5 h-3.5" />
            Listening Quietness Active
          </div>
          <p className="text-[11px] text-amber-300/80 leading-relaxed mb-2">
            Tag writing resumes when playback stops.
          </p>
        </div>
      )}

      {/* Cooldown Timer Banner */}
      {showBatch && state === 'cooldown' && (
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
      {showBatch && offlineMounts.length > 0 && (
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
            onClick={onRetryMounts}
            className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[10px] font-medium transition cursor-pointer"
          >
            Retry Mount Connection
          </button>
        </div>
      )}

      {/* Error Message */}
      {showBatch && errorMessage && (
        <div className="p-2 rounded bg-rose-950/40 border border-rose-500/30 text-rose-300 text-[11px] mb-3">
          {errorMessage}
        </div>
      )}

      {isCurate && (
        <div className="my-3 space-y-3 text-xs">
          {model.albums.map(album => (
            <section key={album.id}>
              <h3 className="font-semibold text-white">{album.title}</h3>
              <ul className="mt-1 space-y-1">
                {album.tracks.map(track => (
                  <li key={track.id} className="rounded bg-white/5 px-2 py-1">
                    <div className="flex justify-between gap-2">
                      <span className="break-words min-w-0">{track.title}</span>
                      <span className="shrink-0 text-zinc-300">{track.statusLabel}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!model.albums.length && !hasActiveWork && <p className="text-zinc-300">The queue is empty.</p>}
        </div>
      )}

      {/* Actions Bar */}
      {(showBatch || state === 'user_paused') && (
        <div className="flex items-center justify-between pt-3 border-t border-white/10 text-xs">
          <button
            onClick={onTogglePause}
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
            {hasActiveWork && activeBatchId && (
              <button
                onClick={onCancelPending}
                title="Stop remaining unwritten tracks in this batch"
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/5 hover:bg-rose-500/20 text-white/70 hover:text-rose-300 transition cursor-pointer"
              >
                <XCircle className="w-3 h-3" /> Cancel Pending
              </button>
            )}

            {showBatch && completedItems > 0 && activeBatchId && (
              <button
                onClick={onUndoBatch}
                title="Revert already committed tracks using pre-commit snapshot"
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/5 hover:bg-[#00F5FF]/20 text-white/70 hover:text-[#00F5FF] transition cursor-pointer"
              >
                <Undo2 className="w-3 h-3" /> Undo Batch
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
