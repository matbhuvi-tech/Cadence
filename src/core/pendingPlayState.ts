import type { Release, Track } from './types'

export interface PendingPlayTarget {
  requestId: number
  track: Track
  release: Release | null
  releaseId: string | null
  queueEntryId: string | null
  startedAtMs: number
  showSpinner: boolean
  isSlowStorage: boolean
}

export const PENDING_SPINNER_DELAY_MS = 150
export const PENDING_SLOW_STORAGE_MS = 5000

export function isDuplicatePendingPlay(
  current: PendingPlayTarget | null,
  trackId: string,
  queueEntryId?: string | null,
): boolean {
  if (!current) return false
  const normalizedEntryId = queueEntryId ?? null
  if (current.queueEntryId !== null || normalizedEntryId !== null) {
    return current.queueEntryId === normalizedEntryId && current.track.id === trackId
  }
  return current.track.id === trackId
}

export function formatTrackSizeLabel(fileSize?: number): string | null {
  if (!fileSize || fileSize <= 0) return null
  const gb = 1024 ** 3
  const mb = 1024 ** 2
  if (fileSize >= gb) {
    return `${(fileSize / gb).toFixed(2)} GB`
  }
  if (fileSize >= mb) {
    return `${Math.round(fileSize / mb)} MB`
  }
  return `${Math.max(1, Math.round(fileSize / 1024))} KB`
}

export function resolveLoadingPillLabel(
  pending: PendingPlayTarget | null,
  isBackendLoading: boolean,
): string | null {
  if (pending?.isSlowStorage) return 'Reading from storage…'
  if (pending || isBackendLoading) return 'Loading…'
  return null
}

export function resolveLoadingSubLabel(pending: PendingPlayTarget | null): string {
  if (pending?.isSlowStorage) return 'Reading from storage…'
  const sizeLabel = formatTrackSizeLabel(pending?.track.fileSize)
  if (sizeLabel) {
    return `Loading to RAM · ${sizeLabel}`
  }
  return 'Loading to RAM…'
}

export function shouldClearPendingPlayFromSnapshot(
  pending: PendingPlayTarget | null,
  snapshotActivity: string | undefined,
  snapshotTrackId: string | null,
): boolean {
  if (!pending) return false
  if (snapshotActivity !== 'playing' && snapshotActivity !== 'paused') return false
  return snapshotTrackId === pending.track.id
}
