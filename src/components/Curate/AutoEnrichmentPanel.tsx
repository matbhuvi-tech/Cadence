import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  Pause,
  Play,
  ShieldAlert,
  Check,
  RotateCcw,
  Lock,
  Unlock,
  RefreshCw,
  Image as ImageIcon,
  History,
} from 'lucide-react'
import type {
  EngineEnrichmentAlbumDetail,
  EngineEnrichmentStatus,
  EngineMetadataUserActionRecord,
} from '../../core/coreProtocol'
import { stripCoreReleasePrefix, type EngineClient } from '../../services/engineClient'
import { formatEnrichmentStateLabel } from '../Modals/StorageManagerModal'

export function formatProviderDisplayName(provider?: string | null): string {
  switch ((provider || '').toLowerCase()) {
    case 'apple_music':
    case 'apple':
      return 'Apple Music'
    case 'musicbrainz':
      return 'MusicBrainz'
    case 'coverartarchive':
    case 'caa':
      return 'Cover Art Archive'
    case 'user_override':
    case 'user_manual':
      return 'Custom Cover'
    case 'spotify':
      return 'Spotify'
    case 'discogs':
      return 'Discogs'
    case 'gemini':
    case 'ai':
      return 'Gemini AI'
    default:
      return provider ? provider.replaceAll('_', ' ') : 'Online Source'
  }
}

export function translateVetoToPlainEnglish(
  veto: { code?: string; message?: string },
  providerLabel?: string | null,
): string {
  const code = (veto.code || '').toUpperCase()
  const rawMsg = veto.message || ''
  const prov = formatProviderDisplayName(providerLabel)

  if (code === 'DURATION_MISMATCH' || /duration/i.test(rawMsg)) {
    const counts = rawMsg.match(/(\d+\/\d+)\s+outside/i)?.[1]
    return counts
      ? `${prov} matched the album, but ${counts} tracks differ noticeably in length — please review before staging.`
      : `${prov} matched the album, but track lengths differ noticeably — please review before staging.`
  }
  if (code === 'TRACK_COUNT_MISMATCH') {
    return `${prov} release has a different number of tracks than your local folder — please review.`
  }
  if (code === 'AMBIGUOUS_RUNNER_UP') {
    return `Multiple similar editions were found — please confirm this is the right pressing.`
  }
  if (code === 'COMPILATION_MISMATCH') {
    return `Compilation vs studio album classification differs from your local tags — please review.`
  }
  if (code === 'EDITION_CONFLICT') {
    return `Edition or remaster details differ from your local folder — please review.`
  }
  if (code === 'LOW_CONFIDENCE' || code === 'HIGH_DISTANCE') {
    return `Confidence was too low to apply automatically — review or refine the search.`
  }
  if (rawMsg) {
    return rawMsg
      .replace(/\b[A-Z][A-Z0-9_]{3,}\b\s*:?\s*/g, '')
      .trim() || 'Held for quick review before applying.'
  }
  return 'Held for quick review before applying.'
}

export function formatArtworkSourcePlainEnglish(
  source?: string | null,
  status?: string | null,
  width?: number | null,
  height?: number | null,
  pending?: {
    url?: string | null
    attempts?: number | null
    error?: string | null
  },
): string | null {
  if (pending?.url?.trim()) {
    return (pending.attempts ?? 0) > 0
      ? 'Retrying staged cover art…'
      : 'Downloading staged cover art…'
  }
  const dims = width && height ? ` · ${width}×${height}` : ''
  const src = (source || '').trim().toLowerCase()
  if (!src && (!status || status === 'pending')) return null
  if (status === 'absent') return 'No cover art found yet'
  if (src === 'user_override') return `Custom cover art staged${dims}`
  if (src === 'embedded') return `Embedded cover art${dims}`
  if (src === 'folder') return `Folder cover art${dims}`
  if (src === 'sidecar') return `Saved cover art${dims}`
  if (src.startsWith('external:')) {
    const prov = formatProviderDisplayName(src.slice('external:'.length))
    return `Cover art from ${prov}${dims}`
  }
  if (src) return `Cover art (${src})${dims}`
  return status === 'found_stale' ? `Low-res local cover${dims}` : null
}

const ACTION_FIELD_LABELS: Record<string, string> = {
  '*': 'Album',
  album: 'Album Title',
  album_artist: 'Album Artist',
  composer: 'Composer',
  year: 'Release Year',
  genre: 'Genre',
  track_title: 'Track Title',
  track_artist: 'Track Artist',
  cover_art: 'Cover Art',
}

export function formatEnrichmentUserAction(action: EngineMetadataUserActionRecord): {
  label: string
  detail: string
} {
  const fieldLabel = ACTION_FIELD_LABELS[action.fieldName] || action.fieldName.replaceAll('_', ' ')
  switch (action.action) {
    case 'manual_edit':
      return {
        label: 'Staged in Cache',
        detail: `${fieldLabel}: ${action.newValue ?? 'Updated'}`,
      }
    case 'stage_artwork':
      return {
        label: 'Staged Cover Art',
        detail: action.newValue === 'uploaded image' ? 'Custom uploaded image' : 'External cover art queued',
      }
    case 'commit_to_file':
      return {
        label: 'Written to File',
        detail: `${fieldLabel}: ${action.newValue ?? 'Saved'}`,
      }
    case 'accept_auto':
      return {
        label: 'Accepted Match',
        detail: `${fieldLabel}: ${action.newValue ?? 'Applied'}`,
      }
    case 'revert_to_file':
      return {
        label: 'Reverted to File Tags',
        detail: 'Cleared cached overrides and restored embedded file tags',
      }
    case 'lock_file_tags':
      return {
        label: 'Kept File Tags',
        detail: 'Locked album against automatic changes',
      }
    case 'unlock_auto':
      return {
        label: 'Allowed Auto-Match',
        detail: 'Re-enabled automatic metadata matching',
      }
    default:
      return {
        label: action.action.replaceAll('_', ' '),
        detail: `${fieldLabel}: ${action.newValue ?? 'Updated'}`,
      }
  }
}

export interface CachedEnrichmentTrackProposal {
  localTrackId: string
  title?: string
  artist?: string
  proposedTitle?: string
  proposedArtist?: string
  trackDistance?: number
  autoApplyFields: string[]
  reviewFields: string[]
}

export interface CachedEnrichmentProposal {
  releaseId: string
  status: string
  provider: 'apple' | 'musicbrainz'
  albumTitle?: string
  albumArtist?: string
  composer?: string
  year?: number
  genre?: string
  coverArtUrl?: string
  reviewReleaseFields: string[]
  tracksById: Map<string, CachedEnrichmentTrackProposal>
}

function nonEmptyText(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined
}

export function extractCachedEnrichmentProposal(
  albumId: string,
  detail: EngineEnrichmentAlbumDetail | null,
): CachedEnrichmentProposal | null {
  if (!detail || !detail.proposal) return null
  if (stripCoreReleasePrefix(detail.releaseId) !== stripCoreReleasePrefix(albumId)) {
    return null
  }
  const prop = detail.proposal as Record<string, unknown>
  const rawProvider = nonEmptyText(prop.provider) ?? detail.provider ?? undefined
  const provider: 'apple' | 'musicbrainz' | null =
    rawProvider === 'apple_music'
      ? 'apple'
      : rawProvider === 'musicbrainz'
        ? 'musicbrainz'
        : null
  if (!provider) return null

  const tracksById = new Map<string, CachedEnrichmentTrackProposal>()
  if (Array.isArray(prop.tracks)) {
    for (const raw of prop.tracks) {
      if (!raw || typeof raw !== 'object') continue
      const tr = raw as Record<string, unknown>
      const localTrackId = nonEmptyText(tr.localTrackId)
      if (!localTrackId) continue
      tracksById.set(localTrackId, {
        localTrackId,
        title: nonEmptyText(tr.candidateTitle),
        artist: nonEmptyText(tr.candidateArtist),
        proposedTitle: nonEmptyText(tr.proposedTitle),
        proposedArtist: nonEmptyText(tr.proposedArtist),
        trackDistance: typeof tr.trackDistance === 'number' ? tr.trackDistance : undefined,
        autoApplyFields: Array.isArray(tr.autoApplyFields)
          ? tr.autoApplyFields.filter((f): f is string => typeof f === 'string')
          : [],
        reviewFields: Array.isArray(tr.reviewFields)
          ? tr.reviewFields.filter((f): f is string => typeof f === 'string')
          : [],
      })
    }
  }

  return {
    releaseId: detail.releaseId,
    status: detail.status,
    provider,
    albumTitle: nonEmptyText(prop.album),
    albumArtist: nonEmptyText(prop.albumArtist),
    composer: nonEmptyText(prop.composer),
    year: typeof prop.year === 'number' && Number.isFinite(prop.year) ? prop.year : undefined,
    genre: nonEmptyText(prop.genre),
    coverArtUrl: nonEmptyText(prop.artworkUrl),
    reviewReleaseFields: Array.isArray(prop.reviewReleaseFields)
      ? prop.reviewReleaseFields.filter((f): f is string => typeof f === 'string')
      : [],
    tracksById,
  }
}

export interface AutoEnrichmentHeaderStripProps {
  status: EngineEnrichmentStatus | null
  busy: boolean
  onTogglePause: () => void
}

export const AutoEnrichmentHeaderStrip: React.FC<AutoEnrichmentHeaderStripProps> = ({
  status,
  busy,
  onTogglePause,
}) => {
  if (!status) return null
  return (
    <div
      data-testid="curate-auto-enrichment-strip"
      className="px-2.5 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center gap-2 text-[11px]"
      title="Background Auto-Enrichment runs on Engine only when playback is idle and cooldown has elapsed"
    >
      <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
      <span className="text-white/75 font-mono">
        {status.totalAlbums === 0
          ? 'Auto-Enrich · No albums indexed'
          : `Auto-Enrich ${status.coveragePercent}% (${status.coveredAlbums}/${status.totalAlbums})`}
      </span>
      <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[10px] text-white/70">
        {formatEnrichmentStateLabel(status)}
      </span>
      <button
        type="button"
        onClick={onTogglePause}
        disabled={busy}
        className="px-1.5 py-0.5 rounded bg-white/[0.08] hover:bg-white/[0.14] text-white/80 text-[10px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
      >
        {status.userPaused ? (
          <>
            <Play className="w-2.5 h-2.5" />
            <span>Resume</span>
          </>
        ) : (
          <>
            <Pause className="w-2.5 h-2.5" />
            <span>Pause</span>
          </>
        )}
      </button>
    </div>
  )
}

export function formatEnrichmentAlbumStatusBadge(status: string): {
  label: string
  className: string
} {
  switch (status) {
    case 'auto_applied':
      return {
        label: 'Auto-Enriched',
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      }
    case 'needs_review':
      return {
        label: 'Needs Review',
        className: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
      }
    case 'user_locked':
      return {
        label: 'User-Locked',
        className: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
      }
    case 'no_match':
      return {
        label: 'No Match',
        className: 'bg-white/[0.06] text-white/60 border-white/10',
      }
    case 'failed':
      return {
        label: 'Retrying',
        className: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
      }
    default:
      return {
        label: 'Pending',
        className: 'bg-white/[0.06] text-white/50 border-white/10',
      }
  }
}

export interface AutoEnrichmentInspectorCardProps {
  albumId: string
  engineClient: EngineClient
  selectedFields?: {
    album?: string
    albumArtist?: string
    composer?: string
    year?: string | number | null
    genre?: string
  }
  selectedTracks?: Array<{
    trackId: string
    title?: string
    artist?: string
  }>
  onCatalogMutated: () => Promise<void> | void
  onDetailChange?: (detail: EngineEnrichmentAlbumDetail | null) => void
  onApplyProposal?: (proposal: CachedEnrichmentProposal) => void
  onOpenHistory?: () => void
  showToast: (msg: string) => void
  refreshNonce: number
}

export function formatStripStatusBadge(detail: EngineEnrichmentAlbumDetail | null): {
  label: string
  className: string
} {
  if (!detail) {
    return {
      label: 'Checking…',
      className: 'bg-white/[0.06] text-white/50 border-white/10',
    }
  }
  const hasStagedContent =
    detail.overlays.some((o) => o.origin === 'user') ||
    detail.artworkStatus === 'user_override' ||
    Boolean(detail.pendingArtworkUrl?.trim())
  switch (detail.status) {
    case 'auto_applied':
      return {
        label: 'Matched automatically',
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      }
    case 'needs_review':
      return {
        label: 'Match ready for review',
        className: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
      }
    case 'user_locked':
      return {
        label: hasStagedContent ? 'Staged in Cache' : 'File Tags Locked',
        className: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
      }
    case 'no_match':
      return {
        label: 'No automatic match',
        className: 'bg-white/[0.06] text-white/60 border-white/10',
      }
    case 'failed':
      return {
        label: 'Retrying lookup',
        className: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
      }
    default:
      return {
        label: 'Pending match',
        className: 'bg-white/[0.06] text-white/50 border-white/10',
      }
  }
}

export const AutoEnrichmentInspectorCard: React.FC<AutoEnrichmentInspectorCardProps> = ({
  albumId,
  engineClient,
  onCatalogMutated,
  onDetailChange,
  onApplyProposal,
  onOpenHistory,
  showToast,
  refreshNonce,
}) => {
  const [detail, setDetail] = useState<EngineEnrichmentAlbumDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const onDetailChangeRef = useRef(onDetailChange)
  onDetailChangeRef.current = onDetailChange
  const requestGenRef = useRef(0)
  const lastAlbumIdRef = useRef<string | null>(null)

  const loadDetail = useCallback(async () => {
    if (!albumId) return
    const gen = ++requestGenRef.current
    setLoading(true)
    try {
      const next = await engineClient.getEnrichmentAlbumDetail(albumId)
      if (gen !== requestGenRef.current) return
      setDetail(next)
      onDetailChangeRef.current?.(next)
    } catch {
      if (gen !== requestGenRef.current) return
      if (lastAlbumIdRef.current !== albumId) {
        setDetail(null)
        onDetailChangeRef.current?.(null)
      }
    } finally {
      if (gen === requestGenRef.current) {
        setLoading(false)
      }
    }
  }, [albumId, engineClient])

  useEffect(() => {
    if (lastAlbumIdRef.current !== albumId) {
      lastAlbumIdRef.current = albumId
      setDetail(null)
      onDetailChangeRef.current?.(null)
    }
    void loadDetail()
    return () => {
      requestGenRef.current++
    }
  }, [albumId, loadDetail, refreshNonce])

  const runAction = async (
    label: string,
    fn: () => Promise<unknown>,
  ) => {
    setMutating(true)
    try {
      await fn()
      await loadDetail()
      await onCatalogMutated()
      showToast(label)
    } catch (err: any) {
      showToast(err?.message || 'Failed to update album cache.')
    } finally {
      setMutating(false)
    }
  }

  if (!detail && !loading) return null

  const badge = formatStripStatusBadge(detail)
  const matchConfidencePct =
    detail?.distance !== null && detail?.distance !== undefined
      ? Math.max(0, Math.min(100, Math.round((1 - detail.distance) * 100)))
      : null

  const vetoes = (detail?.vetoes ?? []) as Array<{ code?: string; message?: string }>
  const parsedProposal = extractCachedEnrichmentProposal(albumId, detail)
  const providerLabel = detail?.provider ? formatProviderDisplayName(detail.provider) : null
  const artworkSummary = formatArtworkSourcePlainEnglish(
    detail?.artworkSource,
    detail?.artworkStatus,
    detail?.artworkWidth,
    detail?.artworkHeight,
    {
      url: detail?.pendingArtworkUrl,
      attempts: detail?.pendingArtworkAttempts,
      error: detail?.pendingArtworkError,
    },
  )
  const artworkIsPending = Boolean(detail?.pendingArtworkUrl?.trim())
  const artworkPendingClass = artworkIsPending
    ? (detail?.pendingArtworkAttempts ?? 0) > 0
      ? 'text-amber-300/90'
      : 'text-cyan-300/90'
    : 'text-white/60'

  return (
    <section
      data-testid="curate-auto-enrichment-inspector"
      className="rounded-xl border border-white/[0.08] bg-[#121318]/70 px-3.5 py-2.5 space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${badge.className}`}>
            {badge.label}
          </span>
          {providerLabel && (
            <span className="px-2 py-0.5 rounded bg-white/[0.05] text-[10px] text-white/80 font-medium">
              {providerLabel}
              {matchConfidencePct !== null ? ` · ${matchConfidencePct}% match` : ''}
            </span>
          )}
          {artworkSummary && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] ${artworkPendingClass}`}
              title={detail?.pendingArtworkError || undefined}
            >
              <ImageIcon className="w-3 h-3 text-[#D4AF37]/80 shrink-0" />
              <span>{artworkSummary}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {parsedProposal && onApplyProposal && (
            <button
              type="button"
              disabled={mutating}
              onClick={() => onApplyProposal(parsedProposal)}
              className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
              title="Load matched suggestions into Selected Output so you can Stage or Commit"
            >
              <Check className="w-3 h-3" />
              <span>Use Suggestion</span>
            </button>
          )}

          {detail && detail.status !== 'user_locked' && (
            <button
              type="button"
              disabled={mutating}
              onClick={() =>
                void runAction('Kept file tags and paused automatic updates for this album.', () =>
                  engineClient.applyEnrichmentAlbumAction({
                    releaseId: albumId,
                    action: 'lock_file_tags',
                  }),
                )
              }
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/15 text-white/75 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
              title="Keep your original file tags and prevent automatic changes"
            >
              <Lock className="w-3 h-3" />
              <span>Keep Original</span>
            </button>
          )}

          {detail && detail.overlays.length > 0 && (
            <button
              type="button"
              disabled={mutating}
              onClick={() =>
                void runAction('Cleared cached changes and restored embedded file tags.', () =>
                  engineClient.applyEnrichmentAlbumAction({
                    releaseId: albumId,
                    action: 'revert_to_file',
                  }),
                )
              }
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/15 text-white/75 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Revert to File Tags</span>
            </button>
          )}

          {detail?.status === 'user_locked' ? (
            <button
              type="button"
              disabled={mutating}
              onClick={() =>
                void runAction('Re-enabled automatic matching for this album.', () =>
                  engineClient.applyEnrichmentAlbumAction({
                    releaseId: albumId,
                    action: 'unlock_auto',
                  }),
                )
              }
              className="px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
            >
              <Unlock className="w-3 h-3" />
              <span>Allow Auto-Match</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={mutating}
              onClick={() =>
                void runAction('Queued album for a fresh automatic lookup.', () =>
                  engineClient.controlEnrichment({
                    action: 'rerun_album',
                    releaseId: albumId,
                  }),
                )
              }
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-white/75 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Re-check</span>
            </button>
          )}

          {onOpenHistory && (
            <button
              type="button"
              onClick={onOpenHistory}
              className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-white/80 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
              title="Open Match & Activity History"
            >
              <History className="w-3 h-3 text-cyan-400" />
              <span>
                History{detail && detail.userActions.length > 0 ? ` (${detail.userActions.length})` : ''}
              </span>
            </button>
          )}
        </div>
      </div>

      {vetoes.length > 0 && (
        <div className="space-y-1" data-testid="curate-auto-enrichment-vetoes">
          {vetoes.slice(0, 1).map((veto, idx) => (
            <div
              key={`${veto.code ?? 'veto'}-${idx}`}
              className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>{translateVetoToPlainEnglish(veto, detail?.provider)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
