/**
 * src/components/Agent/BatchProposalSheet.tsx
 * Copilot Batch Proposal Safety Layer
 *
 * Provides a dry-run before-and-after diff inspection interface for Copilot recommendations,
 * preventing blind in-memory mutations across hundreds of tracks.
 */

import React, { useState, useMemo, useEffect } from 'react'
import {
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  X,
  Search,
  ExternalLink,
  Disc,
  ArrowRight,
  Filter,
} from 'lucide-react'

export interface BatchProposalDiffRow {
  trackId: string
  trackTitle: string
  albumTitle: string
  fieldName: 'title' | 'artistCredit' | 'composerName' | 'albumTitle' | 'releaseYear' | 'genre'
  currentValue: string | number | undefined
  proposedValue: string | number | undefined
}

export interface BatchProposalData {
  proposalId: string
  title: string
  description: string
  scopeLabel: string
  affectedAlbumsCount: number
  affectedTracksCount: number
  diffs: BatchProposalDiffRow[]
  onStageAll: () => Promise<void>
  onInspectInCurate: (affectedAlbumIds: string[]) => void
}

interface BatchProposalSheetProps {
  proposal: BatchProposalData | null
  isOpen: boolean
  onClose: () => void
  showToast: (msg: string) => void
}

export const BatchProposalSheet: React.FC<BatchProposalSheetProps> = ({
  proposal,
  isOpen,
  onClose,
  showToast,
}) => {
  const [filterQuery, setFilterQuery] = useState('')
  const [isStaging, setIsStaging] = useState(false)

  // Listen for Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Filter diff rows by text
  const filteredDiffs = useMemo(() => {
    if (!proposal) return []
    if (!filterQuery.trim()) return proposal.diffs

    const q = filterQuery.toLowerCase()
    return proposal.diffs.filter(
      (d) =>
        d.trackTitle.toLowerCase().includes(q) ||
        d.albumTitle.toLowerCase().includes(q) ||
        d.fieldName.toLowerCase().includes(q) ||
        String(d.proposedValue || '').toLowerCase().includes(q) ||
        String(d.currentValue || '').toLowerCase().includes(q)
    )
  }, [proposal, filterQuery])

  if (!isOpen || !proposal) return null

  const handleStageAll = async () => {
    setIsStaging(true)
    try {
      await proposal.onStageAll()
      showToast(`Staged ${proposal.affectedTracksCount} tracks across ${proposal.affectedAlbumsCount} albums into sidecars.`)
      onClose()
    } catch (err: any) {
      showToast(`Failed to stage proposal: ${err?.message || err}`)
    } finally {
      setIsStaging(false)
    }
  }

  const handleInspectInCurate = () => {
    // Collect unique affected album IDs
    const albumTitles = Array.from(new Set(proposal.diffs.map((d) => d.albumTitle)))
    proposal.onInspectInCurate(albumTitles)
    onClose()
  }

  const fieldLabels: Record<BatchProposalDiffRow['fieldName'], string> = {
    title: 'Track Title',
    artistCredit: 'Primary Artist',
    composerName: 'Composer',
    albumTitle: 'Album Title',
    releaseYear: 'Release Year',
    genre: 'Genre',
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 select-none animate-fadeIn">
      <div className="w-full max-w-4xl max-h-[90vh] bg-[#0E1015] border border-white/[0.12] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* 1. Header Bar */}
        <div className="p-5 border-b border-white/[0.08] bg-[#12141C] flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30">
                <Sparkles className="w-4 h-4" />
              </span>
              <h2 className="text-base font-semibold text-white tracking-tight">{proposal.title}</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.08] text-[#A1A1AA] border border-white/[0.06]">
                {proposal.scopeLabel}
              </span>
            </div>
            <p className="text-xs text-[#8E8E93] max-w-2xl leading-relaxed">{proposal.description}</p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 2. Overview Stats & Search Bar */}
        <div className="px-5 py-3 border-b border-white/[0.06] bg-black/30 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-1.5 text-[#D1D1D6]">
              <Disc className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>{proposal.affectedAlbumsCount} Albums</span>
            </div>
            <span className="text-white/20">·</span>
            <div className="flex items-center gap-1.5 text-[#D1D1D6]">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>{proposal.affectedTracksCount} Tracks</span>
            </div>
            <span className="text-white/20">·</span>
            <div className="flex items-center gap-1.5 text-[#8E8E93]">
              <span>{proposal.diffs.length} Field Modifications</span>
            </div>
          </div>

          {/* Search filter */}
          <div className="relative w-64">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#636366]" />
            <input
              type="text"
              placeholder="Filter tracks, albums, fields..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder-[#636366] focus:outline-none focus:border-[#D4AF37]/50"
            />
          </div>
        </div>

        {/* 3. Virtualized / Windowed Diff Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="border border-white/[0.08] rounded-xl overflow-hidden bg-black/20">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08] bg-white/[0.02] text-[#8E8E93] text-[11px] font-mono">
                  <th className="py-2.5 px-3 font-medium">Track & Album</th>
                  <th className="py-2.5 px-3 font-medium">Field</th>
                  <th className="py-2.5 px-3 font-medium text-rose-300">Current Value</th>
                  <th className="py-2.5 px-3 font-medium text-emerald-400">Proposed Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {filteredDiffs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-xs text-[#8E8E93]">
                      No modifications matching the filter.
                    </td>
                  </tr>
                ) : (
                  filteredDiffs.map((diff, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-2.5 px-3">
                        <span className="font-medium text-white block truncate max-w-[240px]">
                          {diff.trackTitle}
                        </span>
                        <span className="text-[10px] text-[#8E8E93] block truncate max-w-[240px]">
                          {diff.albumTitle}
                        </span>
                      </td>

                      <td className="py-2.5 px-3 font-mono text-[11px] text-[#A1A1AA]">
                        {fieldLabels[diff.fieldName] || diff.fieldName}
                      </td>

                      <td className="py-2.5 px-3 text-rose-300/80 line-through truncate max-w-[200px]">
                        {diff.currentValue !== undefined && diff.currentValue !== ''
                          ? String(diff.currentValue)
                          : '—'}
                      </td>

                      <td className="py-2.5 px-3 text-emerald-300 font-medium truncate max-w-[220px]">
                        {diff.proposedValue !== undefined && diff.proposedValue !== ''
                          ? String(diff.proposedValue)
                          : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4. Action Dual-Path Footer */}
        <div className="p-4 border-t border-white/[0.08] bg-[#12141C] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] text-[#8E8E93]">
            <ShieldAlert className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Changes stage strictly into non-destructive sidecars. Base audio files remain untouched.</span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              disabled={isStaging}
              className="px-3.5 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white text-xs font-medium transition-all cursor-pointer"
            >
              Cancel
            </button>

            <button
              onClick={handleInspectInCurate}
              disabled={isStaging}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-[#D4AF37] border border-[#D4AF37]/30 text-xs font-medium transition-all cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Inspect in Curate (⌘2)</span>
            </button>

            <button
              onClick={handleStageAll}
              disabled={isStaging}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-black text-xs font-semibold shadow-lg shadow-emerald-500/20 transition-all cursor-pointer disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{isStaging ? 'Staging Drafts...' : 'Stage All as Draft'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
