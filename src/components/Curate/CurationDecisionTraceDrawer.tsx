import React, { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { EngineEnrichmentAlbumDetail } from '../../core/coreProtocol'
import type { CurationDecisionTrace, OutcomeStatus } from '../../core/types'
import type { CurateEvidenceRun, CurateEvidenceSummary } from '../../services/curateEvidenceService'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { getUiCurationEvidence, listUiCurationEvidence } from '../../services/engineCurateBridge'
import {
  formatArtworkSourcePlainEnglish,
  formatEnrichmentUserAction,
  formatProviderDisplayName,
  translateVetoToPlainEnglish,
} from './AutoEnrichmentPanel'
import { CurateEvidenceAttempt } from './CurateEvidenceAttempt'

interface CurationDecisionTraceDrawerProps {
  isOpen: boolean
  onClose: () => void
  trace: CurationDecisionTrace | null
  albumId?: string
  lastEvidenceId?: string
  enrichmentDetail?: EngineEnrichmentAlbumDetail | null
  onResumeFetch?: () => void
  isResuming?: boolean
}

const RULE_LABELS: Record<string, string> = {
  consensus_apple_mb: 'Apple Music & MusicBrainz agreement',
  consensus_all: 'All sources agreed',
  earliest_year_rule: 'Earliest verified release year',
  single_provider_match: 'Single source match',
  local_fallback: 'Existing file tag',
  manual_override: 'Manual edit',
  ai_synthesized: 'AI assisted lookup',
}

export function humanizeConsensusRule(code?: string | null): string {
  if (!code) return ''
  const clean = code.trim()
  return RULE_LABELS[clean] || clean.replaceAll('_', ' ')
}

export function humanizeDecisionExplanation(text: string): string {
  let out = text
  for (const [token, label] of Object.entries(RULE_LABELS)) {
    out = out.replaceAll(token, label.toLowerCase())
  }
  return out
}

function AutomaticMatchSection({ detail }: { detail: EngineEnrichmentAlbumDetail }) {
  const proposal = detail.proposal as
    | {
        album?: string | null
        albumArtist?: string | null
        year?: number | null
        tracks?: unknown[]
      }
    | null
    | undefined
  const vetoes = (detail.vetoes ?? []) as Array<{ code?: string; message?: string }>
  const providerName = detail.provider ? formatProviderDisplayName(detail.provider) : null
  const confidencePct =
    detail.distance !== null && detail.distance !== undefined
      ? Math.max(0, Math.min(100, Math.round((1 - detail.distance) * 100)))
      : null
  const artworkPlain = formatArtworkSourcePlainEnglish(
    detail.artworkSource,
    detail.artworkStatus,
    detail.artworkWidth,
    detail.artworkHeight,
  )

  return (
    <section className="space-y-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-zinc-100">Automatic Match</h3>
        {providerName && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-200">
            {providerName}
            {confidencePct !== null ? ` · ${confidencePct}% match` : ''}
          </span>
        )}
      </div>

      {vetoes.map((veto, idx) => (
        <p
          key={`${veto.code ?? 'v'}-${idx}`}
          className="rounded border border-amber-800/50 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-200 leading-snug"
        >
          {translateVetoToPlainEnglish(veto, detail.provider)}
        </p>
      ))}

      {proposal && (proposal.album || proposal.albumArtist || proposal.year) && (
        <div className="rounded bg-zinc-950/70 border border-zinc-800/70 px-2.5 py-2 space-y-1 text-[11px] text-zinc-300">
          {proposal.album && (
            <div>
              <span className="text-zinc-500">Matched album:</span>{' '}
              <span className="font-medium text-zinc-100">{proposal.album}</span>
            </div>
          )}
          {proposal.albumArtist && (
            <div>
              <span className="text-zinc-500">Artist:</span>{' '}
              <span className="text-zinc-200">{proposal.albumArtist}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-zinc-400">
            {proposal.year && <span>Year: {proposal.year}</span>}
            {Array.isArray(proposal.tracks) && proposal.tracks.length > 0 && (
              <span>{proposal.tracks.length} matched tracks</span>
            )}
          </div>
        </div>
      )}

      {artworkPlain && (
        <p className="text-[11px] text-zinc-400">{artworkPlain}</p>
      )}

      {(detail.externalReleaseId || detail.artworkTrace.length > 0) && (
        <details className="text-[11px] text-zinc-400">
          <summary className="cursor-pointer hover:text-zinc-200 select-none">
            Technical details
          </summary>
          <div className="mt-1.5 space-y-1 font-mono text-[10px] text-zinc-500">
            {detail.externalReleaseId && (
              <div>Release ID: {detail.externalReleaseId}</div>
            )}
            {detail.distance !== null && detail.distance !== undefined && (
              <div>
                Match score delta: {detail.distance.toFixed(3)}
                {detail.runnerUpDistance !== null && detail.runnerUpDistance !== undefined
                  ? ` (next candidate margin ${(detail.runnerUpDistance - detail.distance).toFixed(3)})`
                  : ''}
              </div>
            )}
            {detail.artworkTrace.map((step, i) => (
              <div key={i}>
                [{step.outcome}] {step.candidate}: {step.detail}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}

function EvidenceHistory({
  albumId,
  revision,
  hasAutomaticMatch,
}: {
  albumId: string
  revision?: string
  hasAutomaticMatch?: boolean
}) {
  const engine = useOptionalEngineController()
  const engineId = engine?.state.activeProfile?.engineId
  const libraryId = engine?.state.activeDescriptor?.libraryId
  const [runs, setRuns] = useState<CurateEvidenceSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<CurateEvidenceRun | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setSelectedId(undefined)
    setDetail(null)
    setError('')
    try {
      const rows = listUiCurationEvidence(albumId, engineId, libraryId)
      setRuns(rows)
      setLoaded(true)
    } catch {
      setError('Could not load evidence history.')
    }
  }, [albumId, revision, engineId, libraryId])
  const latestId = runs.find(row => row.id === revision)?.id
  const activeId = selectedId ?? latestId ?? runs.find(row => row.current)?.id ?? runs[0]?.id
  useEffect(() => {
    if (!activeId) return
    try {
      setDetail(getUiCurationEvidence(albumId, activeId, engineId, libraryId))
    } catch {
      setError('Could not load this evidence run.')
    }
  }, [albumId, activeId, engineId, libraryId])
  const selected = detail?.id === activeId ? detail : null
  if (loaded && !error && !runs.length && hasAutomaticMatch) {
    return (
      <section className="space-y-1 rounded border border-zinc-800 p-3 text-xs">
        <h3 className="font-semibold text-zinc-100">Manual Lookups</h3>
        <p className="text-zinc-400">No manual Refresh Evidence lookups run for this album.</p>
      </section>
    )
  }
  return (
    <section className="space-y-2 rounded border border-zinc-800 p-3 text-xs">
      <h3 className="font-semibold text-zinc-100">Manual Lookups</h3>
      {error && <p role="alert" className="text-amber-300">{error}</p>}
      {!loaded && !error && <p className="text-zinc-400">Loading lookup history…</p>}
      {loaded && !runs.length && (
        <p className="text-zinc-400">No match or lookup history recorded for this album yet.</p>
      )}
      {runs.length > 0 && (
        <select aria-label="Inspect evidence run" value={activeId} onChange={e => setSelectedId(e.target.value)}
          className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-zinc-200">
          {runs.map(run => (
            <option key={run.id} value={run.id}>
              {run.applicability === 'unverified' ? 'Unverified' : run.applicability === 'superseded' ? 'Superseded' : run.current ? 'Current' : 'Previous'} · {new Date(run.requestedAt).toLocaleString()} · {run.outcome}
            </option>
          ))}
        </select>
      )}
      {selected && (
        <>
          <p className="text-zinc-400">
            {selected.trigger === 'initial' ? 'Initial retrieval' : 'User refresh'} · Ended {new Date(selected.completedAt).toLocaleTimeString()}
          </p>
          {selected.attempts.map((attempt, index) => (
            <CurateEvidenceAttempt key={`${attempt.provider}-${index}`} attempt={attempt} />
          ))}
          {selected.trigger === 'user_refresh' && !selected.attempts.some(attempt => attempt.provider === 'gemini') && (
            <p className="text-zinc-400">This run has no saved AI attempt details.</p>
          )}
          {selected.decision && (
            <details className="text-zinc-300">
              <summary className="cursor-pointer">Decision snapshot</summary>
              <p className="mt-2">{humanizeDecisionExplanation(selected.decision.headlineSummary)}</p>
              {Object.entries(selected.decision.fieldTraces).map(([field, decision]) => (
                <p key={field} className="mt-1">
                  {field} · {decision.chosenValue} · {humanizeDecisionExplanation(decision.plainExplanation)}
                </p>
              ))}
              {selected.trackDecisions?.map(track => (
                <div key={track.trackId} className="mt-1">
                  <p>
                    {track.trackNumber} · {track.selectedTitle || track.localTitle} · {track.selectedArtists || track.localArtists}
                    {track.titleAction === 'Applied' || track.artistsAction === 'Applied' ? ' · Updated' : ' · Retained'}
                  </p>
                  {track.providerDecisions?.filter(decision => decision.reason).map((decision, index) => (
                    <p key={index} className="ml-3 text-amber-300">{decision.proposedValue} · {decision.reason}</p>
                  ))}
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  )
}

export const CurationDecisionTraceDrawer: React.FC<CurationDecisionTraceDrawerProps> = ({
  isOpen,
  onClose,
  trace,
  albumId,
  lastEvidenceId,
  enrichmentDetail,
  onResumeFetch,
  isResuming = false
}) => {
  const [showTelemetry, setShowTelemetry] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!isOpen || (!trace && !albumId && !enrichmentDetail)) {
    return null
  }

  const getProviderUrl = (provider: string, releaseId?: string): string | null => {
    if (!releaseId || releaseId === 'None' || releaseId === 'itunes-match' || releaseId === 'mb-match') return null
    const prov = provider.toLowerCase()
    const cleanId = releaseId.trim()

    if (prov.includes('musicbrainz')) {
      // If it's a valid MusicBrainz UUID (8-4-4-4-12 hex), link directly to the release
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId)) {
        return `https://musicbrainz.org/release/${cleanId}`
      }
      // Fallback: search MusicBrainz release directory
      return `https://musicbrainz.org/search?query=${encodeURIComponent(cleanId)}&type=release`
    }

    if (prov.includes('apple') || prov.includes('itunes')) {
      // If numeric Apple collection/album ID, link directly
      if (/^\d+$/.test(cleanId)) {
        return `https://music.apple.com/album/${cleanId}`
      }
      return `https://music.apple.com/search?term=${encodeURIComponent(cleanId)}`
    }

    if (prov.includes('spotify')) {
      // 22-character alphanumeric Spotify ID
      if (/^[a-zA-Z0-9]{22}$/.test(cleanId)) {
        return `https://open.spotify.com/album/${cleanId}`
      }
      return `https://open.spotify.com/search/${encodeURIComponent(cleanId)}`
    }

    if (prov.includes('discogs')) {
      if (/^\d+$/.test(cleanId)) {
        return `https://www.discogs.com/release/${cleanId}`
      }
      return `https://www.discogs.com/search/?q=${encodeURIComponent(cleanId)}&type=release`
    }

    return null
  }

  const handleOpenLink = async (url: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const handleCopyTelemetry = () => {
    try {
      const payload = JSON.stringify(trace, null, 2)
      navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn('[TraceDrawer] Clipboard copy failed:', err)
    }
  }

  const formatOutcomeBadge = (status: OutcomeStatus) => {
    switch (status) {
      case 'matched_applied':
        return (
          <span className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-emerald-950 text-emerald-400 border border-emerald-700/60">
            Matched & Applied
          </span>
        )
      case 'evaluated_unchanged':
        return (
          <span className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
            Evaluated, Unchanged
          </span>
        )
      case 'incomplete':
        return (
          <span className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-950 text-amber-400 border border-amber-700/60">
            Evaluation Incomplete
          </span>
        )
      case 'paused_playback':
        return (
          <span className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-950 text-amber-400 border border-amber-700/60">
            Paused for Bit-Perfect Playback
          </span>
        )
      case 'failed':
        return (
          <span className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-red-950 text-red-400 border border-red-700/60">
            Evaluation Failed
          </span>
        )
      default:
        return null
    }
  }

  const fieldEntries = Object.entries(trace?.fieldTraces || {})

  const hasAutomaticMatch = Boolean(
    enrichmentDetail &&
      (enrichmentDetail.provider ||
        enrichmentDetail.proposal ||
        enrichmentDetail.artworkSource ||
        enrichmentDetail.vetoes.length > 0),
  )

  return (
    <div
      className="fixed inset-y-0 right-0 w-[460px] max-w-full z-50 bg-zinc-950/95 backdrop-blur-md border-l border-zinc-800 shadow-2xl flex flex-col transform transition-transform duration-200 ease-out animate-in slide-in-from-right"
      role="dialog"
      aria-label="Match & Activity History"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-zinc-100">Match &amp; Activity History</span>
          {trace && formatOutcomeBadge(trace.outcomeStatus)}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-100 p-1 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
          title="Close inspector (Esc or Ctrl+I)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {enrichmentDetail && hasAutomaticMatch && (
          <AutomaticMatchSection detail={enrichmentDetail} />
        )}
        {albumId && (
          <EvidenceHistory
            key={albumId}
            albumId={albumId}
            revision={lastEvidenceId}
            hasAutomaticMatch={hasAutomaticMatch}
          />
        )}
        {enrichmentDetail && enrichmentDetail.userActions.length > 0 && (
          <section className="space-y-2 rounded border border-zinc-800 p-3 text-xs">
            <h3 className="font-semibold text-zinc-100">
              Activity Log ({enrichmentDetail.userActions.length})
            </h3>
            <ul className="space-y-1.5">
              {enrichmentDetail.userActions.slice(0, 20).map((act) => {
                const formatted = formatEnrichmentUserAction(act)
                return (
                  <li key={act.id} className="rounded bg-zinc-900/60 px-2.5 py-1.5 border border-zinc-800/60">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-zinc-200">{formatted.label}</span>
                      <span className="text-[10px] font-mono text-zinc-500">{act.createdAt}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 break-words">{formatted.detail}</p>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {trace && <>
        {/* Headline Summary */}
        <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800/80">
          <p className="text-xs text-zinc-300 leading-relaxed font-sans">
            {humanizeDecisionExplanation(trace.headlineSummary)}
          </p>
        </div>

        {/* Playback Paused Banner with Resume Action */}
        {trace.outcomeStatus === 'paused_playback' && onResumeFetch && (
          <div className="p-3 rounded bg-amber-950/40 border border-amber-800/50 flex items-center justify-between gap-3">
            <span className="text-xs text-amber-200/90 leading-tight">
              Playback interrupted network fetching to preserve bit-perfect transport purity.
            </span>
            <button
              type="button"
              onClick={onResumeFetch}
              disabled={isResuming}
              className="px-2.5 py-1 text-xs font-medium rounded bg-amber-600 hover:bg-amber-500 text-zinc-950 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              {isResuming ? 'Resuming...' : 'Resume Fetch'}
            </button>
          </div>
        )}

        {/* Tier 1: Plain-English Field Decisions */}
        <div className="space-y-2">
          <h4 className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold">
            Decisions & Evidence ({fieldEntries.length})
          </h4>

          {fieldEntries.length === 0 ? (
            <p className="text-xs text-zinc-500 italic py-2">
              No field-level modifications made. Existing local metadata was evaluated as authoritative.
            </p>
          ) : (
            <ul className="space-y-2">
              {fieldEntries.map(([field, decision]) => {
                let badgeClass = 'bg-zinc-800 text-zinc-300'
                if (decision.action === 'Applied') {
                  badgeClass = 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                } else if (decision.action === 'Rejected') {
                  badgeClass = 'bg-red-950 text-red-400 border border-red-800/60'
                }

                return (
                  <li
                    key={field}
                    className="p-3 rounded bg-zinc-900/50 border border-zinc-800/70 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-200 capitalize">
                        {field.replace(/([A-Z])/g, ' $1').trim()}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${badgeClass}`}>
                        {decision.action}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 font-sans leading-normal">
                      {humanizeDecisionExplanation(decision.plainExplanation)}
                    </p>
                    {decision.consensusRatio && (
                      <div className="text-[11px] font-mono text-zinc-500">
                        Source: <span className="text-zinc-400">{humanizeConsensusRule(decision.consensusRatio)}</span>
                        {decision.confidenceScore > 0 && (
                          <span className="ml-2">
                            • Confidence: <span className="text-zinc-400">{Math.round(decision.confidenceScore * 100)}%</span>
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Tier 2: Expandable Telemetry Accordion */}
        <div className="pt-2 border-t border-zinc-800/80">
          <button
            type="button"
            onClick={() => setShowTelemetry(!showTelemetry)}
            className="flex items-center justify-between w-full text-xs font-mono text-zinc-400 hover:text-zinc-200 py-1 cursor-pointer"
          >
            <span className="font-semibold uppercase tracking-wider text-[11px]">
              Diagnostic Telemetry ({trace.candidateTelemetry?.length || 0} candidates)
            </span>
            <span>{showTelemetry ? '▾ Hide' : '▸ Expand'}</span>
          </button>

          {showTelemetry && (
            <div className="mt-3 space-y-3">
              <div className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950">
                <table className="w-full text-[11px] font-mono text-left">
                  <thead className="bg-zinc-900/80 text-zinc-400 border-b border-zinc-800">
                    <tr>
                      <th className="px-2.5 py-1.5 font-medium">Provider</th>
                      <th className="px-2.5 py-1.5 font-medium">Release ID</th>
                      <th className="px-2.5 py-1.5 font-medium">Tracks</th>
                      <th className="px-2.5 py-1.5 font-medium">Score</th>
                      <th className="px-2.5 py-1.5 font-medium">Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900 text-zinc-300">
                    {(trace.candidateTelemetry || []).map((cand, i) => {
                      const url = getProviderUrl(cand.provider, cand.releaseId)
                      return (
                        <tr key={i} className="hover:bg-zinc-900/40">
                          <td className="px-2.5 py-1.5 capitalize text-zinc-200">{cand.provider}</td>
                          <td className="px-2.5 py-1.5 text-zinc-400 max-w-[140px] truncate" title={cand.releaseId}>
                            {url ? (
                              <button
                                type="button"
                                onClick={() => handleOpenLink(url)}
                                className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 flex items-center gap-1 cursor-pointer transition-colors"
                                title={`Open ${cand.provider} release (${cand.releaseId})`}
                              >
                                <span className="truncate max-w-[110px]">{cand.releaseId}</span>
                                <ExternalLink className="w-3 h-3 shrink-0 opacity-80" />
                              </button>
                            ) : (
                              <span>{cand.releaseId || 'None'}</span>
                            )}
                          </td>
                          <td className="px-2.5 py-1.5 text-zinc-300">
                            {cand.trackCount !== undefined ? `${cand.trackCount} trk` : '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-cyan-400">
                            {Math.round(cand.confidenceScore * 100)}%
                          </td>
                          <td className="px-2.5 py-1.5 text-zinc-400">{cand.latencyMs === undefined ? '—' : `${cand.latencyMs}ms`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Engine metadata footer & copy */}
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 pt-1">
                <span>Duration: {trace.durationMs}ms • Engine: {trace.engineVersion}</span>
                <button
                  type="button"
                  onClick={handleCopyTelemetry}
                  className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
                >
                  {copied ? 'Copied JSON!' : 'Copy Telemetry'}
                </button>
              </div>
            </div>
          )}
        </div>
        </>}
      </div>

      {/* Footer Info */}
      <div className="px-5 py-2.5 border-t border-zinc-800/80 bg-zinc-900/40 flex items-center justify-between text-[11px] text-zinc-500 font-mono">
        <span>Album: {albumId ?? trace?.albumId}</span>
        <span>{trace?.updatedAt ? new Date(trace.updatedAt).toLocaleTimeString() : ''}</span>
      </div>
    </div>
  )
}

