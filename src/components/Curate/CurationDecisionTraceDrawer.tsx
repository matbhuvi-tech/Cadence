import React, { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { CurationDecisionTrace, OutcomeStatus } from '../../core/types'

interface CurationDecisionTraceDrawerProps {
  isOpen: boolean
  onClose: () => void
  trace: CurationDecisionTrace | null
  onResumeFetch?: () => void
  isResuming?: boolean
}

export const CurationDecisionTraceDrawer: React.FC<CurationDecisionTraceDrawerProps> = ({
  isOpen,
  onClose,
  trace,
  onResumeFetch,
  isResuming = false
}) => {
  const [showTelemetry, setShowTelemetry] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!isOpen || !trace) {
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

  const fieldEntries = Object.entries(trace.fieldTraces || {})

  return (
    <div
      className="fixed inset-y-0 right-0 w-[460px] max-w-full z-50 bg-zinc-950/95 backdrop-blur-md border-l border-zinc-800 shadow-2xl flex flex-col transform transition-transform duration-200 ease-out animate-in slide-in-from-right"
      role="dialog"
      aria-label="Curation Decision Rationale"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-zinc-100">Curation Rationale</span>
          {formatOutcomeBadge(trace.outcomeStatus)}
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
        {/* Headline Summary */}
        <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800/80">
          <p className="text-xs text-zinc-300 leading-relaxed font-sans">
            {trace.headlineSummary}
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
                      {decision.plainExplanation}
                    </p>
                    {decision.consensusRatio && (
                      <div className="text-[11px] font-mono text-zinc-500">
                        Consensus: <span className="text-zinc-400">{decision.consensusRatio}</span>
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
                          <td className="px-2.5 py-1.5 text-zinc-400">{cand.latencyMs}ms</td>
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
      </div>

      {/* Footer Info */}
      <div className="px-5 py-2.5 border-t border-zinc-800/80 bg-zinc-900/40 flex items-center justify-between text-[11px] text-zinc-500 font-mono">
        <span>Album: {trace.albumId}</span>
        <span>{new Date(trace.updatedAt).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

