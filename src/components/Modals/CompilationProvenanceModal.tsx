/**
 * src/components/Modals/CompilationProvenanceModal.tsx
 * Cadence Semantic AI Engine: Compilation Soundtrack Canonicalization Review Sheet.
 * Built adhering strictly to Apple HIG (Human Interface Guidelines):
 * - Full user agency: zero arbitrary truncation, full text readability for verification.
 * - Progressive disclosure: scannable hierarchy, clear badges, high-contrast typography.
 * - Non-destructive staging: user checks/unchecks individual track mappings before applying.
 */

import React, { useState, useEffect, useMemo } from 'react'
import {
  Sparkles,
  X,
  CheckCircle2,
  AlertCircle,
  Film,
  FolderCheck,
  ArrowRight,
  Disc3,
  Loader2,
  RefreshCw,
  CheckSquare,
  Square,
  ShieldAlert,
  Info,
} from 'lucide-react'
import { Release, Track } from '../../core/types'
import {
  compilationCanonicalizerService,
  ProposedTrackCanonicalization,
} from '../../services/compilationCanonicalizerService'

export interface CompilationProvenanceModalProps {
  isOpen: boolean
  onClose: () => void
  release: Release | null
  allTracks: Track[]
  allReleases: Release[]
  onSuccess?: (updatedCount: number) => void
  showToast?: (msg: string) => void
}

export const CompilationProvenanceModal: React.FC<CompilationProvenanceModalProps> = ({
  isOpen,
  onClose,
  release,
  allTracks,
  allReleases,
  onSuccess,
  showToast,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isApplying, setIsApplying] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDeferredPlayback, setIsDeferredPlayback] = useState<boolean>(false)
  const [proposedTracks, setProposedTracks] = useState<ProposedTrackCanonicalization[]>([])
  const [telemetry, setTelemetry] = useState<{
    modelUsed?: string
    pacingDelayMs?: number
    retriesAttempted?: number
  } | null>(null)

  // Filter tracks belonging to the selected release
  const releaseTracks = useMemo(() => {
    if (!release) return []
    return allTracks
      .filter((t) => t.releaseId === release.id)
      .sort((a, b) => (a.trackNumber || 1) - (b.trackNumber || 1))
  }, [release, allTracks])

  // Automatically start resolution when modal opens for a release
  useEffect(() => {
    if (!isOpen || !release) {
      setProposedTracks([])
      setErrorMessage(null)
      setIsDeferredPlayback(false)
      setIsLoading(false)
      return
    }

    let isMounted = true
    const runResolution = async () => {
      setIsLoading(true)
      setErrorMessage(null)
      setIsDeferredPlayback(false)

      const result = await compilationCanonicalizerService.resolveCompilationSoundtracks(
        release,
        releaseTracks,
        allReleases
      )

      if (!isMounted) return

      setIsLoading(false)
      if (result.deferredPlayback) {
        setIsDeferredPlayback(true)
        setErrorMessage(result.error || 'Playback active. Transport Purity Lock enforced.')
        return
      }

      if (!result.success) {
        setErrorMessage(result.error || 'Failed resolving compilation soundtracks.')
        return
      }

      setProposedTracks(result.tracks)
      if (result.telemetry) {
        setTelemetry(result.telemetry)
      }
    }

    runResolution()

    return () => {
      isMounted = false
    }
  }, [isOpen, release])

  if (!isOpen || !release) return null

  const selectedCount = proposedTracks.filter((t) => t.selected).length
  const matchedInLibraryCount = proposedTracks.filter((t) => t.matchedInLibrary).length
  const externalMasterCount = proposedTracks.filter((t) => !t.matchedInLibrary && t.proposedOriginalAlbum).length
  const allSelected = proposedTracks.length > 0 && selectedCount === proposedTracks.length

  const handleToggleSelect = (trackId: string) => {
    setProposedTracks((prev) =>
      prev.map((t) => (t.trackId === trackId ? { ...t, selected: !t.selected } : t))
    )
  }

  const handleToggleSelectAll = () => {
    const nextState = !allSelected
    setProposedTracks((prev) => prev.map((t) => ({ ...t, selected: nextState })))
  }

  const handleApply = async () => {
    if (selectedCount === 0) return
    setIsApplying(true)
    try {
      const { updatedCount } = await compilationCanonicalizerService.applyBatchCanonicalization(
        proposedTracks,
        allTracks,
        allReleases
      )

      if (showToast) {
        showToast(
          `Successfully applied canonical soundtrack origins to ${updatedCount} track${
            updatedCount === 1 ? '' : 's'
          }.`
        )
      }

      if (onSuccess) {
        onSuccess(updatedCount)
      }
      onClose()
    } catch (err: any) {
      console.error('[CompilationProvenanceModal] Apply error:', err)
      setErrorMessage(err.message || 'Failed applying changes')
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="compilation-provenance-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md animate-fade-in text-left select-none"
    >
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-[#0C0D10]/95 border border-white/[0.08] shadow-2xl overflow-hidden backdrop-blur-2xl">
        {/* Top Header Row (Apple HIG: Clean & Contextual) */}
        <div className="flex items-center justify-between p-5 px-6 border-b border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h2 id="compilation-provenance-title" className="text-base font-semibold text-white tracking-tight">
                  Canonical Soundtrack Resolver
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                  Gemini AI
                </span>
              </div>
              <span className="text-xs text-[#8E8E93] mt-0.5">
                {release.title} {release.releaseYear ? `(${release.releaseYear})` : ''} &bull;{' '}
                {releaseTracks.length} tracks
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status / Metrics Sub-header (Simplicity & Scannability) */}
        {!isLoading && !errorMessage && proposedTracks.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 bg-black/40 border-b border-white/[0.04] text-xs">
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5 text-slate-300 font-mono">
                <span className="font-semibold text-white">{proposedTracks.length}</span>
                <span className="text-slate-400">total tracks</span>
              </div>
              <div className="flex items-center gap-1.5 text-emerald-400 font-mono">
                <FolderCheck className="w-3.5 h-3.5" />
                <span className="font-semibold">{matchedInLibraryCount}</span>
                <span className="text-emerald-300/70">in local library</span>
              </div>
              <div className="flex items-center gap-1.5 text-cyan-400 font-mono">
                <Film className="w-3.5 h-3.5" />
                <span className="font-semibold">{externalMasterCount}</span>
                <span className="text-cyan-300/70">external masters</span>
              </div>
            </div>

            <button
              onClick={handleToggleSelectAll}
              className="flex items-center gap-1.5 text-xs text-cyan-300 hover:text-cyan-200 transition-colors cursor-pointer py-1 px-2 rounded hover:bg-white/[0.04]"
            >
              {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              <span>{allSelected ? 'Deselect All' : 'Select All'}</span>
            </button>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {/* Loading State */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold text-white">
                  Consulting Archival Discography...
                </span>
                <p className="text-xs text-[#8E8E93] max-w-md">
                  Gemini is analyzing the complete tracklist of "{release.title}" to determine the
                  canonical original motion picture soundtracks, debut years, and composers.
                </p>
              </div>
            </div>
          )}

          {/* Transport Purity Playback Guard Alert */}
          {isDeferredPlayback && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-3 text-amber-200">
              <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-semibold text-amber-300 text-sm">
                  Transport Purity Lock Active
                </span>
                <p className="text-amber-200/90 leading-relaxed">
                  Cadence enforces absolute hardware silence on storage buses and network interfaces
                  during active audio playback or cooldown.
                </p>
                <p className="text-amber-300/70 mt-1">
                  Please pause or stop audio playback to resolve compilation track origins.
                </p>
              </div>
            </div>
          )}

          {/* General Error State */}
          {errorMessage && !isDeferredPlayback && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/25 flex items-start gap-3 text-rose-200">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-semibold text-rose-300 text-sm">Resolution Incomplete</span>
                <p className="text-rose-200/90 leading-relaxed">{errorMessage}</p>
              </div>
            </div>
          )}

          {/* Review List (Apple HIG Agency: Full Non-Truncated Readability) */}
          {!isLoading && proposedTracks.length > 0 && (
            <div className="flex flex-col gap-2">
              {proposedTracks.map((item) => {
                const isSelected = item.selected

                return (
                  <div
                    key={item.trackId}
                    onClick={() => handleToggleSelect(item.trackId)}
                    className={`group relative p-3.5 rounded-xl border transition-all cursor-pointer flex items-start gap-3.5 ${
                      isSelected
                        ? 'bg-cyan-950/20 border-cyan-500/30 shadow-sm'
                        : 'bg-white/[0.02] border-white/[0.05] hover:border-white/[0.1] opacity-75'
                    }`}
                  >
                    {/* Checkbox Toggle */}
                    <div className="pt-0.5 shrink-0 text-cyan-400">
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-cyan-400" />
                      ) : (
                        <Square className="w-4 h-4 text-[#64748B] group-hover:text-slate-300 transition-colors" />
                      )}
                    </div>

                    {/* Track Number Badge */}
                    <span className="text-[11px] font-mono text-[#64748B] w-6 shrink-0 pt-0.5 text-center">
                      #{item.trackNumber}
                    </span>

                    {/* Side-by-Side Full Data (No Truncation) */}
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                      {/* Top Line: Song Title -> Proposed Origin */}
                      <div className="flex flex-col md:flex-row md:items-baseline justify-between gap-2">
                        {/* Current Song Title (Full, Unclipped) */}
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-semibold text-white break-words leading-tight">
                            {item.title}
                          </span>
                          {item.primaryVocalists && (
                            <span className="text-[10px] text-[#8E8E93] break-words mt-0.5">
                              {item.primaryVocalists}
                            </span>
                          )}
                        </div>

                        {/* Mapping Arrow & Proposed Soundtrack */}
                        <div className="flex items-start md:items-baseline gap-2 shrink-0 md:text-right">
                          <ArrowRight className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5 md:mt-0" />
                          <div className="flex flex-col md:items-end">
                            <div className="flex items-baseline gap-1.5 flex-wrap md:justify-end">
                              <span className="text-xs font-semibold text-cyan-200 break-words leading-tight">
                                {item.proposedOriginalAlbum || release.title}
                              </span>
                              {item.proposedOriginalYear && (
                                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/25 shrink-0 font-medium">
                                  ({item.proposedOriginalYear})
                                </span>
                              )}
                            </div>

                            {/* Badge: In Library vs External Master */}
                            <div className="mt-1 flex items-center gap-1.5">
                              {item.matchedInLibrary ? (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
                                  <FolderCheck className="w-2.5 h-2.5" />
                                  <span>In Library: {item.matchedReleaseTitle || 'Matched'}</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-cyan-500/10 text-cyan-400/90 border border-cyan-500/20">
                                  <Film className="w-2.5 h-2.5" />
                                  <span>External Master</span>
                                </span>
                              )}

                              {item.composer && (
                                <span className="text-[10px] text-amber-300/80 font-mono">
                                  &bull; {item.composer}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Discographical Origin Note */}
                      {item.notes && (
                        <p className="text-[10px] text-[#8E8E93] leading-normal pt-1 border-t border-white/[0.03] mt-1 font-sans">
                          {item.notes}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer Actions (Apple HIG: Clear Prominence & Forgiveness) */}
        <div className="flex items-center justify-between p-4 px-6 border-t border-white/[0.06] bg-black/40 text-xs">
          {/* Telemetry info */}
          <div className="flex items-center gap-2 text-[#8E8E93]">
            {telemetry && (
              <span className="text-[10px] font-mono">
                Model: {telemetry.modelUsed || 'Gemini 2.5'} &bull; Safe delay:{' '}
                {telemetry.pacingDelayMs || 0}ms
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isApplying}
              className="px-4 py-2 rounded-xl text-xs text-[#8E8E93] hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>

            <button
              onClick={handleApply}
              disabled={isApplying || isLoading || selectedCount === 0}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-black font-semibold text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 hover:scale-105 active:scale-95 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100"
            >
              {isApplying ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Applying to Library...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-black" />
                  <span>
                    Apply Provenance ({selectedCount} Track{selectedCount === 1 ? '' : 's'})
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CompilationProvenanceModal
