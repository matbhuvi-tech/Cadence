/**
 * src/components/Curate/CurationReconciliationStage.tsx
 * Center-Right Pane of Master-Detail Curation Workbench
 *
 * Implements 4-way provider reconciliation (Local Tag, MusicBrainz, Apple Music, AI Provenance),
 * Case A (Uniform Album Defect) track checklist, Case B (Multi-Film Compilation) clusters,
 * high-res artwork inspection, queue completion screen, and transport quietness guards.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Disc,
  Sparkles,
  ExternalLink,
  RotateCcw,
  ZoomIn,
  ShieldCheck,
  Check,
  Layers,
  Film,
  Music,
  AlertCircle,
  Eye,
  X,
  Volume2,
} from 'lucide-react'
import { Track, Release } from '../../core/types'
import { AlbumCurationQueueItem } from '../../services/curationQueueService'
import {
  federatedResolversService,
  CoverArtCandidate,
  ActiveItemCandidateResult,
} from '../../services/federatedResolvers'
import {
  compilationCanonicalizerService,
  ProposedTrackCanonicalization,
} from '../../services/compilationCanonicalizerService'
import { tauriBridge } from '../../services/tauriBridge'

export interface CurationReconciliationStageProps {
  albumItem: AlbumCurationQueueItem | null
  release?: Release
  tracks: Track[]
  allReleases?: Release[]
  currentIndex: number
  totalCount: number
  onPrev: () => void
  onNext: () => void
  onStageAndNext: (stagedEdits: Map<string, Partial<Track>>) => void
  onOpenCommitModal: () => void
  onBackToLibrary: () => void
  showToast: (msg: string) => void
  isQueueCleared?: boolean
}

export const CurationReconciliationStage: React.FC<CurationReconciliationStageProps> = ({
  albumItem,
  release,
  tracks,
  allReleases = [],
  currentIndex,
  totalCount,
  onPrev,
  onNext,
  onStageAndNext,
  onOpenCommitModal,
  onBackToLibrary,
  showToast,
  isQueueCleared = false,
}) => {
  // Candidate loading state
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false)
  const [candidatesResult, setCandidatesResult] = useState<ActiveItemCandidateResult | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isPlaybackQuietNotice, setIsPlaybackQuietNotice] = useState(false)

  // Field selection state for Case A
  const [selectedFields, setSelectedFields] = useState<{
    title: string
    artistCredit: string
    composerName: string
    releaseYear: string
    genre: string
  }>({
    title: '',
    artistCredit: '',
    composerName: '',
    releaseYear: '',
    genre: '',
  })

  // Selected artwork candidate
  const [selectedArtwork, setSelectedArtwork] = useState<CoverArtCandidate | null>(null)
  const [isZoomingArt, setIsZoomingArt] = useState(false)

  // Track selection for Case A (track IDs to stage)
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  // Artist scope policy: 'album_only' sets Album Artist while preserving track vocalists; 'all_tracks' overwrites both
  const [artistPolicy, setArtistPolicy] = useState<'album_only' | 'all_tracks'>('album_only')
  // Track-level editable artists (keyed by trackId)
  const [trackArtists, setTrackArtists] = useState<Record<string, string>>({})

  // Case B compilation resolution state
  const [compilationClusters, setCompilationClusters] = useState<{
    soundtrackTitle: string
    year?: number
    composer?: string
    tracks: Track[]
  }[]>([])
  const [isLoadingClusters, setIsLoadingClusters] = useState(false)

  // AbortController for active remote queries
  const abortControllerRef = useRef<AbortController | null>(null)

  const isCaseB = useMemo(() => {
    if (!albumItem) return false
    return (
      albumItem.primaryIssueType === 'compilation_conflict' ||
      Boolean(release?.isCompilation) ||
      tracks.some((t) => t.isCompilation || /\(from\s+['"][^'"]+['"]\)/i.test(t.title))
    )
  }, [albumItem, release, tracks])

  // Initialize selected tracks & default field values whenever albumItem / release changes
  useEffect(() => {
    if (!albumItem) return

    setSelectedTrackIds(new Set(tracks.map((t) => t.id)))

    const initialTitle = release?.title || tracks[0]?.canonicalAlbumTitle || albumItem.albumTitle
    const initialArtist = release?.artistCredit || tracks[0]?.albumArtist || tracks[0]?.artistCredit || albumItem.artistCredit
    const initialComposer = release?.composerName || tracks[0]?.composerName || ''
    const initialYear = String(release?.releaseYear || tracks[0]?.canonicalReleaseYear || '')
    const initialGenre = release?.genreTags?.join(', ') || ''

    setSelectedFields({
      title: initialTitle,
      artistCredit: initialArtist,
      composerName: initialComposer,
      releaseYear: initialYear,
      genre: initialGenre,
    })

    const initialTrackArtists: Record<string, string> = {}
    tracks.forEach((t) => {
      initialTrackArtists[t.id] = t.artistCredit || ''
    })
    setTrackArtists(initialTrackArtists)

    setSelectedArtwork(null)
  }, [albumItem?.albumId, release?.id, tracks])

  // Load external candidates on selection with 300ms debounce and playback quietness check
  const fetchCandidates = useCallback(
    async (forceEvenIfPlaying = false) => {
      if (!albumItem) return

      // Abort previous in-flight lookup
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      const controller = new AbortController()
      abortControllerRef.current = controller

      setIsLoadingCandidates(true)
      setFetchError(null)

      try {
        if (!forceEvenIfPlaying) {
          const status = await tauriBridge.getPlaybackStatus().catch(() => null)
          if (status && (status.isPlaying || status.isPaused || status.playbackState === 'Loading')) {
            setIsPlaybackQuietNotice(true)
            setIsLoadingCandidates(false)
            return
          }
        }

        setIsPlaybackQuietNotice(false)

        const result = await federatedResolversService.resolveActiveItemCandidate({
          albumTitle: albumItem.albumTitle,
          artistCredit: albumItem.artistCredit,
          composerName: release?.composerName || tracks[0]?.composerName,
          releaseYear: release?.releaseYear || tracks[0]?.canonicalReleaseYear,
          trackTitle: tracks[0]?.title,
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        setCandidatesResult(result)

        // Select the highest-res candidate by default if available
        if (result.artworkCandidates.length > 0) {
          setSelectedArtwork(result.artworkCandidates[0])
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setFetchError(err?.message || 'Remote candidate query failed')
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingCandidates(false)
        }
      }
    },
    [albumItem, tracks]
  )

  // Debounced candidate fetching on album selection
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchCandidates()
    }, 300)

    return () => {
      clearTimeout(timer)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [albumItem?.albumId, fetchCandidates])

  // Compute Case B Compilation Clusters
  useEffect(() => {
    if (!isCaseB || !release || tracks.length === 0) {
      setCompilationClusters([])
      return
    }

    // 1. Initial heuristic grouping from track metadata (instant)
    const clusterMap = new Map<string, { soundtrackTitle: string; year?: number; composer?: string; tracks: Track[] }>()

    tracks.forEach((trk) => {
      let stName = trk.originalAlbum || trk.canonicalAlbumTitle || ''
      if (!stName) {
        const match = trk.title.match(/\(from\s+['"]([^'"]+)['"]\)/i)
        if (match) {
          stName = match[1]
        }
      }
      if (!stName) {
        stName = release.title || 'Compilation Track'
      }

      if (!clusterMap.has(stName)) {
        clusterMap.set(stName, {
          soundtrackTitle: stName,
          year: trk.originalYear || trk.canonicalReleaseYear || release.releaseYear,
          composer: trk.composerName || release.composerName,
          tracks: [],
        })
      }
      clusterMap.get(stName)!.tracks.push(trk)
    })

    setCompilationClusters(Array.from(clusterMap.values()))

    // 2. Fetch AI compilation resolution asynchronously if available
    let isCancelled = false
    setIsLoadingClusters(true)

    compilationCanonicalizerService
      .resolveCompilationSoundtracks(release, tracks, allReleases)
      .then((res) => {
        if (isCancelled || !res.success || res.tracks.length === 0) return

        const resolvedMap = new Map<string, { soundtrackTitle: string; year?: number; composer?: string; tracks: Track[] }>()

        res.tracks.forEach((propTrack: ProposedTrackCanonicalization) => {
          const matchedTrk = tracks.find((t) => t.id === propTrack.trackId)
          if (!matchedTrk) return

          const soundtrack = propTrack.proposedOriginalAlbum || release.title
          if (!resolvedMap.has(soundtrack)) {
            resolvedMap.set(soundtrack, {
              soundtrackTitle: soundtrack,
              year: propTrack.proposedOriginalYear || release.releaseYear,
              composer: propTrack.composer || matchedTrk.composerName,
              tracks: [],
            })
          }
          resolvedMap.get(soundtrack)!.tracks.push(matchedTrk)
        })

        if (resolvedMap.size > 0) {
          setCompilationClusters(Array.from(resolvedMap.values()))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!isCancelled) setIsLoadingClusters(false)
      })

    return () => {
      isCancelled = true
    }
  }, [isCaseB, release, tracks, allReleases])

  // Toggle track selection in Case A
  const toggleTrack = (trackId: string) => {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }

  const toggleAllTracks = () => {
    if (selectedTrackIds.size === tracks.length) {
      setSelectedTrackIds(new Set())
    } else {
      setSelectedTrackIds(new Set(tracks.map((t) => t.id)))
    }
  }

  // Handle "Stage & Next" for Case A
  const handleStageCaseA = () => {
    if (!albumItem || selectedTrackIds.size === 0) return

    const editsMap = new Map<string, Partial<Track>>()

    tracks.forEach((trk) => {
      if (selectedTrackIds.has(trk.id)) {
        const edits: Record<string, any> = {}

        if (selectedFields.title && selectedFields.title !== release?.title) {
          edits.album = selectedFields.title
        }

        // 1. Album Artist: Always stage to albumArtist tag
        if (selectedFields.artistCredit && selectedFields.artistCredit !== (trk.albumArtist || release?.artistCredit)) {
          edits.albumArtist = selectedFields.artistCredit
        }

        // 2. Track Artist (artistCredit tag):
        if (artistPolicy === 'all_tracks') {
          if (selectedFields.artistCredit && selectedFields.artistCredit !== trk.artistCredit) {
            edits.artistCredit = selectedFields.artistCredit
          }
        } else {
          // In album_only mode, only stage artistCredit if user specifically edited this track's artist
          const editedArtist = trackArtists[trk.id]
          if (editedArtist !== undefined && editedArtist !== trk.artistCredit && editedArtist.trim().length > 0) {
            edits.artistCredit = editedArtist.trim()
          }
        }

        if (selectedFields.composerName && selectedFields.composerName !== trk.composerName) {
          edits.composerName = selectedFields.composerName
        }
        if (selectedFields.releaseYear) {
          const parsedYear = Number(selectedFields.releaseYear)
          if (!isNaN(parsedYear) && parsedYear > 0) {
            edits.year = parsedYear
          }
        }
        if (selectedFields.genre) {
          edits.genre = selectedFields.genre
        }
        if (selectedArtwork?.coverArtUrl) {
          edits.coverArtUrl = selectedArtwork.coverArtUrl
        }

        editsMap.set(trk.id, edits)
      }
    })

    onStageAndNext(editsMap)
    showToast(`Staged metadata for ${selectedTrackIds.size} track(s) in "${albumItem.albumTitle}".`)
  }

  // Handle Staging a specific cluster in Case B
  const handleStageCluster = (cluster: { soundtrackTitle: string; year?: number; composer?: string; tracks: Track[] }) => {
    const editsMap = new Map<string, Partial<Track>>()

    cluster.tracks.forEach((trk) => {
      const edits: Record<string, any> = {
        originalAlbum: cluster.soundtrackTitle,
        canonicalAlbumTitle: cluster.soundtrackTitle,
      }
      if (cluster.year) {
        edits.originalYear = cluster.year
        edits.year = cluster.year
      }
      if (cluster.composer) {
        edits.composerName = cluster.composer
      }
      if (selectedArtwork?.coverArtUrl) {
        edits.coverArtUrl = selectedArtwork.coverArtUrl
      }
      editsMap.set(trk.id, edits)
    })

    onStageAndNext(editsMap)
    showToast(`Staged soundtrack provenance "${cluster.soundtrackTitle}" for ${cluster.tracks.length} track(s).`)
  }

  // Keyboard shortcut listener for (⌘↵)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (isCaseB && compilationClusters.length > 0) {
          handleStageCluster(compilationClusters[0])
        } else {
          handleStageCaseA()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleStageCaseA, isCaseB, compilationClusters])

  // 1. Queue Cleared / Empty Screen
  if (isQueueCleared || !albumItem) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center p-8 bg-[#0B0D13] text-center select-none">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4 shadow-xl shadow-emerald-500/10">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Queue Cleared</h2>
        <p className="text-sm text-[#8E8E93] max-w-md mt-1 mb-6 leading-relaxed">
          All catalog defect items in the active queue have been inspected and staged. Your bit-perfect
          audio files remain untouched until explicit commit.
        </p>

        <div className="flex items-center gap-3">
          <button
            onClick={onOpenCommitModal}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-black font-semibold text-xs transition-all shadow-lg shadow-emerald-500/20 cursor-pointer"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Review & Commit Changes (⌘4)</span>
          </button>
          <button
            onClick={onBackToLibrary}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-white font-medium text-xs border border-white/[0.08] transition-all cursor-pointer"
          >
            <span>Return to Library (Esc)</span>
          </button>
        </div>
      </div>
    )
  }

  const itunesCandidate = candidatesResult?.metadataCandidates?.itunes
  const mbCandidate = candidatesResult?.metadataCandidates?.musicbrainz

  return (
    <div className="flex-1 h-full flex flex-col bg-[#0B0D13] overflow-y-auto select-none">
      {/* 1. Action Header */}
      <div className="h-14 px-6 border-b border-white/[0.06] flex items-center justify-between shrink-0 bg-[#0E0F12]/80 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
            <span>Curate</span>
            <span>/</span>
            <span className="font-semibold text-white truncate max-w-[260px] md:max-w-[400px]">
              {albumItem.albumTitle}
            </span>
          </div>

          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium ${
              albumItem.defectSeverity === 'critical'
                ? 'bg-rose-500/15 text-rose-300 border border-rose-500/20'
                : albumItem.defectSeverity === 'high'
                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/20'
                : 'bg-blue-500/15 text-blue-300 border border-blue-500/20'
            }`}
          >
            {albumItem.issueBadgeLabel}
          </span>
        </div>

        {/* Stepper Navigation & Primary Action */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg bg-white/[0.04] border border-white/[0.08] p-0.5">
            <button
              onClick={onPrev}
              disabled={currentIndex <= 0}
              title="Previous Album (⌘[)"
              className="p-1.5 rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent text-[#8E8E93] hover:text-white transition-all cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-[#A1A1AA] px-2">
              {currentIndex + 1} of {totalCount}
            </span>
            <button
              onClick={onNext}
              disabled={currentIndex >= totalCount - 1}
              title="Next Album (⌘])"
              className="p-1.5 rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent text-[#8E8E93] hover:text-white transition-all cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={isCaseB && compilationClusters.length > 0 ? () => handleStageCluster(compilationClusters[0]) : handleStageCaseA}
            disabled={selectedTrackIds.size === 0}
            title="Stage Edits to Non-Destructive Sidecar & Advance (⌘↵)"
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#E5C158] text-black font-semibold text-xs transition-all shadow-md shadow-[#D4AF37]/20 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
          >
            <Check className="w-4 h-4 stroke-[2.5]" />
            <span>✓ Stage & Next →</span>
            <span className="text-[10px] opacity-70 font-mono hidden lg:inline">⌘↵</span>
          </button>
        </div>
      </div>

      {/* 2. Playback Quietness Notice */}
      {isPlaybackQuietNotice && (
        <div className="mx-6 mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-between text-xs text-amber-300">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Playback Active:</strong> Remote candidate lookups deferred to maintain bit-perfect
              audio bus quietness (Audiophile Invariant 4).
            </span>
          </div>
          <button
            onClick={() => fetchCandidates(true)}
            className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[11px] font-medium transition-all cursor-pointer"
          >
            Fetch Online Anyway
          </button>
        </div>
      )}

      {/* 3. Main Stage Content */}
      <div className="p-6 space-y-6 flex-1">
        {/* High-Resolution Artwork Inspector */}
        <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-xs text-white">
              <Eye className="w-4 h-4 text-[#D4AF37]" />
              <span>High-Resolution Artwork Inspector</span>
            </div>
            {selectedArtwork && (
              <span className="text-[11px] font-mono text-[#D4AF37]">
                Selected: {selectedArtwork.coverResolution} ({selectedArtwork.providerLabel})
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* 1. Local Tag Embedded */}
            <div
              onClick={() =>
                setSelectedArtwork({
                  provider: 'local',
                  providerLabel: 'Local Container',
                  albumTitle: albumItem.albumTitle,
                  artistCredit: albumItem.artistCredit,
                  coverArtUrl: albumItem.coverArtUrl || '',
                  thumbnailUrl: albumItem.coverArtUrl || '',
                  coverResolution: albumItem.coverArtUrl ? 'Embedded' : 'Missing',
                  confidenceScore: 1.0,
                })
              }
              className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col items-center gap-2 relative ${
                selectedArtwork?.provider === 'local'
                  ? 'bg-white/[0.08] border-[#D4AF37] ring-1 ring-[#D4AF37]/30'
                  : 'bg-black/30 border-white/[0.06] hover:border-white/[0.12]'
              }`}
            >
              <div className="w-24 h-24 rounded-lg bg-neutral-900 overflow-hidden relative border border-white/10 flex items-center justify-center">
                {albumItem.coverArtUrl ? (
                  <img src={albumItem.coverArtUrl} alt="Local" className="w-full h-full object-cover" />
                ) : (
                  <Disc className="w-8 h-8 text-[#636366]" />
                )}
                {albumItem.coverArtUrl && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsZoomingArt(true)
                    }}
                    className="absolute bottom-1 right-1 p-1 rounded bg-black/60 text-white/80 hover:text-white"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="text-center">
                <span className="text-[11px] font-medium text-white block">Local File</span>
                <span className="text-[10px] font-mono text-[#8E8E93]">
                  {albumItem.coverArtUrl ? 'Embedded Binary' : 'No Cover Art'}
                </span>
              </div>
            </div>

            {/* 2. External Candidates */}
            {candidatesResult?.artworkCandidates && candidatesResult.artworkCandidates.length > 0 ? (
              candidatesResult.artworkCandidates.map((art, idx) => (
                <div
                  key={idx}
                  onClick={() => setSelectedArtwork(art)}
                  className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col items-center gap-2 relative ${
                    selectedArtwork?.coverArtUrl === art.coverArtUrl
                      ? 'bg-white/[0.08] border-[#D4AF37] ring-1 ring-[#D4AF37]/30'
                      : 'bg-black/30 border-white/[0.06] hover:border-white/[0.12]'
                  }`}
                >
                  <div className="w-24 h-24 rounded-lg bg-neutral-900 overflow-hidden relative border border-white/10 flex items-center justify-center">
                    <img src={art.coverArtUrl} alt={art.providerLabel} className="w-full h-full object-cover" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedArtwork(art)
                        setIsZoomingArt(true)
                      }}
                      className="absolute bottom-1 right-1 p-1 rounded bg-black/60 text-white/80 hover:text-white"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-center">
                    <span className="text-[11px] font-medium text-white block">{art.providerLabel}</span>
                    <span className="text-[10px] font-mono text-[#D4AF37]">{art.coverResolution}</span>
                  </div>
                </div>
              ))
            ) : isLoadingCandidates ? (
              <div className="col-span-2 sm:col-span-3 flex items-center justify-center p-6 text-xs text-[#8E8E93]">
                <RotateCcw className="w-4 h-4 animate-spin text-[#D4AF37] mr-2" />
                <span>Resolving high-resolution cover artwork candidates...</span>
              </div>
            ) : (
              <div className="col-span-2 sm:col-span-3 flex items-center justify-between p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] text-xs text-[#8E8E93]">
                <span>No high-resolution artwork candidates returned from online providers.</span>
                <button
                  onClick={() => fetchCandidates(true)}
                  className="px-2.5 py-1 rounded bg-white/[0.06] hover:bg-white/[0.1] text-white text-[11px] transition-all cursor-pointer"
                >
                  Retry Lookup
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 4-Way Reconciliation Table */}
        <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-xs text-white">
              <Sparkles className="w-4 h-4 text-[#D4AF37]" />
              <span>4-Way Metadata Provider Reconciliation</span>
            </div>
            {fetchError && (
              <div className="flex items-center gap-1.5 text-xs text-amber-300">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{fetchError}</span>
                <button onClick={() => fetchCandidates(true)} className="underline hover:text-white ml-1 cursor-pointer">
                  Retry
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08] text-[#8E8E93] text-[11px] font-mono">
                  <th className="py-2.5 px-3 font-medium">Field</th>
                  <th className="py-2.5 px-3 font-medium">Local File Tag</th>
                  <th className="py-2.5 px-3 font-medium">Apple Music Master</th>
                  <th className="py-2.5 px-3 font-medium">MusicBrainz Archive</th>
                  <th className="py-2.5 px-3 font-medium text-emerald-400">Staged Output</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {/* Album Title */}
                <tr>
                  <td className="py-2.5 px-3 font-medium text-white/80">Album Title</td>
                  <td
                    onClick={() => setSelectedFields((prev) => ({ ...prev, title: albumItem.albumTitle }))}
                    className="py-2.5 px-3 text-[#A1A1AA] hover:text-white cursor-pointer transition-colors"
                  >
                    {albumItem.albumTitle}
                  </td>
                  <td
                    onClick={() => {
                      if (itunesCandidate?.releaseTitle) {
                        setSelectedFields((prev) => ({ ...prev, title: itunesCandidate.releaseTitle }))
                      }
                    }}
                    className={`py-2.5 px-3 transition-colors ${
                      itunesCandidate?.releaseTitle ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {itunesCandidate?.releaseTitle || '—'}
                  </td>
                  <td
                    onClick={() => {
                      if (mbCandidate?.releaseTitle) {
                        setSelectedFields((prev) => ({ ...prev, title: mbCandidate.releaseTitle }))
                      }
                    }}
                    className={`py-2.5 px-3 transition-colors ${
                      mbCandidate?.releaseTitle ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {mbCandidate?.releaseTitle || '—'}
                  </td>
                  <td className="py-2.5 px-3">
                    <input
                      type="text"
                      value={selectedFields.title}
                      onChange={(e) => setSelectedFields((prev) => ({ ...prev, title: e.target.value }))}
                      className="w-full px-2 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs"
                    />
                  </td>
                </tr>

                {/* Album Artist */}
                <tr>
                  <td className="py-2.5 px-3 font-medium text-white/80">
                    <div className="flex flex-col">
                      <span>Album Artist</span>
                      <span className="text-[10px] text-[#8E8E93] font-mono">ALBUMARTIST</span>
                    </div>
                  </td>
                  <td
                    onClick={() => setSelectedFields((prev) => ({ ...prev, artistCredit: albumItem.artistCredit }))}
                    className="py-2.5 px-3 text-[#A1A1AA] hover:text-white cursor-pointer transition-colors"
                  >
                    {albumItem.artistCredit}
                  </td>
                  <td
                    onClick={() => {
                      if (itunesCandidate?.artistCredit) {
                        setSelectedFields((prev) => ({ ...prev, artistCredit: itunesCandidate.artistCredit }))
                      }
                    }}
                    className={`py-2.5 px-3 transition-colors ${
                      itunesCandidate?.artistCredit ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {itunesCandidate?.artistCredit || '—'}
                  </td>
                  <td
                    onClick={() => {
                      if (mbCandidate?.artistCredit) {
                        setSelectedFields((prev) => ({ ...prev, artistCredit: mbCandidate.artistCredit }))
                      }
                    }}
                    className={`py-2.5 px-3 transition-colors ${
                      mbCandidate?.artistCredit ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {mbCandidate?.artistCredit || '—'}
                  </td>
                  <td className="py-2.5 px-3">
                    <input
                      type="text"
                      value={selectedFields.artistCredit}
                      onChange={(e) => setSelectedFields((prev) => ({ ...prev, artistCredit: e.target.value }))}
                      className="w-full px-2 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs"
                    />
                  </td>
                </tr>

                {/* Composer */}
                <tr>
                  <td className="py-2.5 px-3 font-medium text-white/80">Composer</td>
                  <td
                    onClick={() =>
                      setSelectedFields((prev) => ({
                        ...prev,
                        composerName: release?.composerName || tracks[0]?.composerName || '',
                      }))
                    }
                    className="py-2.5 px-3 text-[#A1A1AA] hover:text-white cursor-pointer transition-colors"
                  >
                    {release?.composerName || tracks[0]?.composerName || '—'}
                  </td>
                  <td
                    onClick={() => {
                      if (itunesCandidate?.composer) {
                        setSelectedFields((prev) => ({ ...prev, composerName: itunesCandidate.composer! }))
                      }
                    }}
                    className={`py-2.5 px-3 transition-colors ${
                      itunesCandidate?.composer ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {itunesCandidate?.composer || '—'}
                  </td>
                  <td
                    onClick={() => {
                      if (mbCandidate?.composer) {
                        setSelectedFields((prev) => ({ ...prev, composerName: mbCandidate.composer! }))
                      }
                    }}
                    className={`py-2.5 px-3 transition-colors ${
                      mbCandidate?.composer ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {mbCandidate?.composer || '—'}
                  </td>
                  <td className="py-2.5 px-3">
                    <input
                      type="text"
                      value={selectedFields.composerName}
                      onChange={(e) => setSelectedFields((prev) => ({ ...prev, composerName: e.target.value }))}
                      className="w-full px-2 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs"
                    />
                  </td>
                </tr>

                {/* Release Year */}
                <tr>
                  <td className="py-2.5 px-3 font-medium text-white/80">Release Year</td>
                  <td
                    onClick={() =>
                      setSelectedFields((prev) => ({
                        ...prev,
                        releaseYear: String(release?.releaseYear || tracks[0]?.canonicalReleaseYear || ''),
                      }))
                    }
                    className="py-2.5 px-3 text-[#A1A1AA] hover:text-white cursor-pointer transition-colors font-mono"
                  >
                    {release?.releaseYear || tracks[0]?.canonicalReleaseYear || '—'}
                  </td>
                  <td
                    onClick={() => {
                      if (itunesCandidate?.releaseYear) {
                        setSelectedFields((prev) => ({ ...prev, releaseYear: String(itunesCandidate.releaseYear) }))
                      }
                    }}
                    className={`py-2.5 px-3 font-mono transition-colors ${
                      itunesCandidate?.releaseYear ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {itunesCandidate?.releaseYear || '—'}
                  </td>
                  <td
                    onClick={() => {
                      if (mbCandidate?.releaseYear) {
                        setSelectedFields((prev) => ({ ...prev, releaseYear: String(mbCandidate.releaseYear) }))
                      }
                    }}
                    className={`py-2.5 px-3 font-mono transition-colors ${
                      mbCandidate?.releaseYear ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                    }`}
                  >
                    {mbCandidate?.releaseYear || '—'}
                  </td>
                  <td className="py-2.5 px-3 font-mono">
                    <input
                      type="text"
                      value={selectedFields.releaseYear}
                      onChange={(e) => setSelectedFields((prev) => ({ ...prev, releaseYear: e.target.value }))}
                      className="w-24 px-2 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs font-mono"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Artist Scope Policy Selector */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-white/[0.04] text-xs">
            <div className="flex items-center gap-1.5 text-[#8E8E93]">
              <span className="font-medium text-white/80">Artist Scope Policy:</span>
              <span>How should the reconciled artist apply to tracks?</span>
            </div>
            <div className="inline-flex rounded-lg p-0.5 bg-black/50 border border-white/10">
              <button
                type="button"
                onClick={() => setArtistPolicy('album_only')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                  artistPolicy === 'album_only'
                    ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30 shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                Set as Album Artist only (Preserve track singers)
              </button>
              <button
                type="button"
                onClick={() => setArtistPolicy('all_tracks')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                  artistPolicy === 'all_tracks'
                    ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30 shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                Apply to all tracks (Uniform single artist)
              </button>
            </div>
          </div>
        </div>

        {/* Case B: Multi-Film Compilation Box Set Clusters OR Case A: Track Checklist */}
        {isCaseB && compilationClusters.length > 0 ? (
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-xs text-white">
                <Film className="w-4 h-4 text-[#D4AF37]" />
                <span>Multi-Soundtrack Compilation Clusters ({compilationClusters.length} Film Soundtracks)</span>
              </div>
              {isLoadingClusters && (
                <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
                  <RotateCcw className="w-3.5 h-3.5 animate-spin text-[#D4AF37]" />
                  <span>AI resolving soundtrack origins...</span>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {compilationClusters.map((cluster, cIdx) => (
                <div
                  key={cIdx}
                  className="p-3.5 rounded-xl bg-black/40 border border-white/[0.06] hover:border-white/[0.12] transition-all space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white text-xs">{cluster.soundtrackTitle}</span>
                        {cluster.year && (
                          <span className="text-[10px] font-mono text-[#D4AF37] px-1.5 py-0.2 rounded bg-[#D4AF37]/10">
                            ({cluster.year})
                          </span>
                        )}
                      </div>
                      {cluster.composer && (
                        <span className="text-[11px] text-[#8E8E93] block mt-0.5">
                          Score by {cluster.composer}
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => handleStageCluster(cluster)}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium transition-all cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Stage Soundtrack ({cluster.tracks.length} trk)</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 pt-1 border-t border-white/[0.04]">
                    {cluster.tracks.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center gap-2 px-2 py-1 rounded bg-white/[0.02] text-[11px] text-[#A1A1AA]"
                      >
                        <span className="font-mono text-[#636366] w-5">#{t.trackNumber || 1}</span>
                        <span className="text-white truncate flex-1">{t.title}</span>
                        <span className="text-[10px] text-[#8E8E93] truncate max-w-[120px]">
                          {t.artistCredit}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Case A: Track Checklist */
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-xs text-white">
                <Music className="w-4 h-4 text-[#D4AF37]" />
                <span>Affected Tracks to Stage ({selectedTrackIds.size}/{tracks.length} Selected)</span>
                <span className="text-[10px] text-[#8E8E93] font-mono ml-2">
                  {artistPolicy === 'album_only'
                    ? '• Individual track singers preserved / editable'
                    : '• Album Artist will apply to all tracks'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {artistPolicy === 'album_only' && (
                  <button
                    onClick={() => {
                      const reset: Record<string, string> = {}
                      tracks.forEach((t) => {
                        reset[t.id] = t.artistCredit || ''
                      })
                      setTrackArtists(reset)
                    }}
                    className="text-[11px] text-[#8E8E93] hover:text-white cursor-pointer"
                  >
                    Reset Track Artists
                  </button>
                )}
                <button
                  onClick={toggleAllTracks}
                  className="text-[11px] text-[#D4AF37] hover:underline cursor-pointer font-medium"
                >
                  {selectedTrackIds.size === tracks.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>
            </div>

            <div className="divide-y divide-white/[0.04] max-h-64 overflow-y-auto pr-1">
              {tracks.map((t) => {
                const isChecked = selectedTrackIds.has(t.id)
                const currentVal = trackArtists[t.id] ?? t.artistCredit ?? ''
                const isModified = currentVal !== t.artistCredit
                return (
                  <div
                    key={t.id}
                    onClick={() => toggleTrack(t.id)}
                    className="py-2 px-2 flex items-center justify-between hover:bg-white/[0.02] rounded cursor-pointer transition-colors gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleTrack(t.id)}
                        className="rounded border-white/20 text-[#D4AF37] focus:ring-0 cursor-pointer"
                      />
                      <span className="text-xs font-mono text-[#636366] w-6">#{t.trackNumber || 1}</span>
                      <span className="text-xs text-white truncate max-w-[200px] md:max-w-[280px]">
                        {t.title}
                      </span>
                    </div>

                    <div
                      className="flex items-center gap-2 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-[10px] text-[#8E8E93] font-mono">Track Artist:</span>
                      <input
                        type="text"
                        value={artistPolicy === 'all_tracks' ? selectedFields.artistCredit : currentVal}
                        disabled={artistPolicy === 'all_tracks'}
                        onChange={(e) => {
                          const val = e.target.value
                          setTrackArtists((prev) => ({ ...prev, [t.id]: val }))
                        }}
                        placeholder="Vocalist(s) / Performer"
                        className={`px-2 py-1 rounded bg-black/40 border text-xs w-48 md:w-64 font-medium transition-colors focus:outline-none ${
                          artistPolicy === 'all_tracks'
                            ? 'border-white/[0.04] text-[#636366] cursor-not-allowed bg-black/20'
                            : isModified
                            ? 'border-emerald-500/50 text-emerald-300'
                            : 'border-white/10 text-white/90 hover:border-white/20 focus:border-[#D4AF37]'
                        }`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Artwork Zoom Modal */}
      {isZoomingArt && selectedArtwork && (
        <div
          onClick={() => setIsZoomingArt(false)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-8 cursor-pointer"
        >
          <div className="relative max-w-2xl max-h-[85vh] flex flex-col items-center">
            <img
              src={selectedArtwork.coverArtUrl}
              alt="Zoomed"
              className="max-w-full max-h-[75vh] object-contain rounded-xl shadow-2xl border border-white/10"
            />
            <div className="mt-3 text-center text-xs text-white flex items-center gap-2">
              <span className="font-semibold">{selectedArtwork.providerLabel}</span>
              <span>·</span>
              <span className="font-mono text-[#D4AF37]">{selectedArtwork.coverResolution}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
