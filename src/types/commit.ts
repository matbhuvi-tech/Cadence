import { Track, Release } from '../core/types'

/**
 * Decoupled metrics tracking distinct item count units
 */
export interface CommitUnitMetrics {
  albumCount: number
  audioTrackCount: number
  tagEditCount: number
  coverArtUpdateCount: number
}

/**
 * Preflight verification results before executing file/sidecar commit
 */
export interface PreflightCheckResult {
  playbackIdle: boolean
  cooldownElapsed: boolean
  storageWritable: boolean
  blockedPaths: { path: string; reason: string }[]
  canProceed: boolean
}

/**
 * Container padding analysis determining write strategy for embedded headers
 */
export interface HeaderPaddingAnalysis {
  trackId: string
  filePath: string
  format: 'flac' | 'alac' | 'dsf' | 'dff' | 'mp3' | 'm4a' | 'wav' | 'aiff' | 'unknown'
  estimatedHeaderGrowthBytes: number
  availablePaddingBytes: number
  requiresFullRewrite: boolean // true if growth > padding (except DSF tail metadata)
  reason: string
}

/**
 * Batch options including user exclusions
 */
export interface CommitBatchOptions {
  destination: 'sidecar' | 'embedded'
  excludedTrackIds: Set<string>
  excludedReleaseIds: Set<string>
}

/**
 * Result returned by the transaction commit execution
 */
export interface CommitExecutionResult {
  success: boolean
  transactionId: string
  durationMs: number
  metrics: CommitUnitMetrics
  failedTracks: { trackId: string; filePath: string; error: string }[]
  rewrittenFilesCount: number
  inPlaceHeaderCount: number
  error?: string
}

/**
 * Analyzes audio container format and padding availability for a track.
 * Spec:
 * - DSF (.dsf): ID3v2 chunk is appended at the tail of the file per Sony spec.
 *   Never requires a full audio stream rewrite (`requiresFullRewrite: false`).
 * - FLAC (.flac): Has METADATA_BLOCK_PADDING (typically 4096 to 8192 bytes).
 *   If growth <= padding, in-place overwrite. If growth > padding, full file rewrite.
 * - ALAC / M4A: moov atom expansion. If free atom exists, in-place; otherwise rewrite.
 * - MP3: ID3v2 at header; if expansion exceeds padding, file prepend/rewrite.
 */
export function analyzeHeaderPadding(track: Track, newArtworkBytes: number = 0): HeaderPaddingAnalysis {
  const ext = (track.filePath.split('.').pop() || '').toLowerCase()
  const pending = track.pendingSidecarEdits || {}

  // Estimate text tag growth (difference in characters * 2 for UTF-8/UTF-16 padding)
  let textDeltaBytes = 0
  if (pending.title && pending.title !== track.title) textDeltaBytes += 64
  if (pending.artistCredit && pending.artistCredit !== track.artistCredit) textDeltaBytes += 64
  if (pending.composerName && pending.composerName !== track.composerName) textDeltaBytes += 64
  if (pending.album && pending.album !== track.folderName) textDeltaBytes += 64

  const totalGrowth = textDeltaBytes + newArtworkBytes

  if (ext === 'dsf') {
    return {
      trackId: track.id,
      filePath: track.filePath,
      format: 'dsf',
      estimatedHeaderGrowthBytes: totalGrowth,
      availablePaddingBytes: 65536,
      requiresFullRewrite: false,
      reason: 'DSF tail chunk: in-place tail update without stream rewrite',
    }
  }

  if (ext === 'flac') {
    // Standard FLAC has 4096 to 8192 bytes of padding block
    const defaultPadding = 8192
    const requiresFullRewrite = totalGrowth > defaultPadding
    return {
      trackId: track.id,
      filePath: track.filePath,
      format: 'flac',
      estimatedHeaderGrowthBytes: totalGrowth,
      availablePaddingBytes: defaultPadding,
      requiresFullRewrite,
      reason: requiresFullRewrite
        ? `Exceeds FLAC padding (${totalGrowth}B > ${defaultPadding}B): requires full file rewrite`
        : `Within FLAC padding (${totalGrowth}B <= ${defaultPadding}B): fast in-place header overwrite`,
    }
  }

  if (ext === 'm4a' || ext === 'alac') {
    const defaultFree = 4096
    const requiresFullRewrite = totalGrowth > defaultFree
    return {
      trackId: track.id,
      filePath: track.filePath,
      format: 'alac',
      estimatedHeaderGrowthBytes: totalGrowth,
      availablePaddingBytes: defaultFree,
      requiresFullRewrite,
      reason: requiresFullRewrite
        ? `Exceeds ALAC free atom: requires container repack`
        : `Within ALAC free atom: in-place moov overwrite`,
    }
  }

  if (ext === 'mp3') {
    const defaultPadding = 2048
    const requiresFullRewrite = totalGrowth > defaultPadding
    return {
      trackId: track.id,
      filePath: track.filePath,
      format: 'mp3',
      estimatedHeaderGrowthBytes: totalGrowth,
      availablePaddingBytes: defaultPadding,
      requiresFullRewrite,
      reason: requiresFullRewrite
        ? `Exceeds ID3v2 header padding: requires full file rewrite`
        : `Within ID3v2 header padding: in-place overwrite`,
    }
  }

  return {
    trackId: track.id,
    filePath: track.filePath,
    format: 'unknown',
    estimatedHeaderGrowthBytes: totalGrowth,
    availablePaddingBytes: 0,
    requiresFullRewrite: totalGrowth > 0,
    reason: 'Generic audio container: stream copy required',
  }
}


export interface CommitTelemetryPayload {
  state: 'idle' | 'writing' | 'paused_playback' | 'cooldown' | 'paused_mount_offline' | 'user_paused'
  activeBatchId?: string
  activeBatchDescription?: string
  currentTrackId?: string
  currentTrackTitle?: string
  currentTrackFilePath?: string
  pendingItems: number
  inflightItems: number
  completedItems: number
  failedItems: number
  totalItems: number
  percent: number
  throughputItemsPerSec: number
  cooldownRemainingSecs?: number
  offlineMounts: string[]
  errorMessage?: string
}

export interface CommitQueueSummary {
  totalBatches: number
  activeBatchId?: string
  activeBatchDescription?: string
  pendingItems: number
  inflightItems: number
  completedItems: number
  failedItems: number
  totalWrittenBytes: number
  isPaused: boolean
  isEmpty: boolean
}

export interface NewCommitItemPayload {
  id: string
  trackId: string
  filePath: string
  mountId: string
  payloadJson: string
  backupJson: string
  expectedCrc?: string
}

export interface EnqueueBatchPayload {
  id?: string
  description?: string
  destination?: 'sidecar' | 'embedded'
  forceOverride?: boolean
  items: NewCommitItemPayload[]
}
