/**
 * src/components/Curate/CurationReconciliationStage.tsx
 * Center-Right Pane of Master-Detail Curation Workbench
 *
 * Implements 4-way provider reconciliation (Local Tag, MusicBrainz, Apple Music, AI Provenance),
 * 33%/67% side-by-side top split deck, Case A (Uniform Album / Single-Film Soundtrack) and
 * Case B (Multi-Film Compilation, clusters.length > 1) unified single-column editable track table,
 * high-res artwork inspection, queue completion screen, and transport quietness guards.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Disc,
  Sparkles,
  RotateCcw,
  ZoomIn,
  ShieldCheck,
  Check,
  Film,
  Music,
  AlertCircle,
  Eye,
  X,
  Volume2,
  Split,
  Search,
  SlidersHorizontal,
  ArrowLeft,
  Link2,
  Unlink,
  Folder,
  Wand2,
} from 'lucide-react'
import { Track, Release, ReleaseConsensusResult, ConsensusFieldSource, NavigationAnchor } from '../../core/types'
import { AlbumCurationQueueItem, lookaheadQueuePrefetcher } from '../../services/curationQueueService'
import {
  federatedResolversService,
  CoverArtCandidate,
  ActiveItemCandidateResult,
} from '../../services/federatedResolvers'
import {
  compilationCanonicalizerService,
  ProposedTrackCanonicalization,
} from '../../services/compilationCanonicalizerService'
import { isDefectiveArtistTag, isPlaceholderTag, cleanRipNoise, extractMeaningfulFolderName } from '../../core/taxonomyUtils'
import { creditInferenceService } from '../../services/creditInferenceService'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'
import { tauriBridge } from '../../services/tauriBridge'

export interface CurationReconciliationStageProps {
  albumItem: AlbumCurationQueueItem | null
  release?: Release
  tracks: Track[]
  allReleases?: Release[]
  allTracks?: Track[]
  queue?: AlbumCurationQueueItem[]
  currentIndex: number
  totalCount: number
  onPrev: () => void
  onNext: () => void
  onStageAndNext: (stagedEdits: Map<string, Partial<Track>>) => void
  onOpenCommitModal: () => void
  onBackToLibrary: () => void
  showToast: (msg: string) => void
  isQueueCleared?: boolean
  navigationAnchor?: NavigationAnchor | null
  autoTriggerAi?: boolean
  onReturnToAnchor?: () => void
}

export const CurationReconciliationStage: React.FC<CurationReconciliationStageProps> = ({
  albumItem,
  release,
  tracks,
  allReleases = [],
  allTracks = [],
  queue = [],
  currentIndex,
  totalCount,
  onPrev,
  onNext,
  onStageAndNext,
  onOpenCommitModal,
  onBackToLibrary,
  showToast,
  isQueueCleared = false,
  navigationAnchor,
  autoTriggerAi = false,
  onReturnToAnchor,
}) => {
  // Candidate loading state
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false)
  const [candidatesResult, setCandidatesResult] = useState<ActiveItemCandidateResult | null>(null)
  const [consensusResult, setConsensusResult] = useState<ReleaseConsensusResult | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isPlaybackQuietNotice, setIsPlaybackQuietNotice] = useState(false)

  // Broken cover art URL tracking for graceful <Disc /> fallback
  const [failedArtUrls, setFailedArtUrls] = useState<Set<string>>(new Set())

  // Stacking modal state
  const [isStackPickerOpen, setIsStackPickerOpen] = useState(false)
  const [stackSearchQuery, setStackSearchQuery] = useState('')

  // Authority inference
  const authorityInference = useMemo(() => {
    return creditInferenceService.inferReleaseAuthority(release, tracks)
  }, [release, tracks, release?.metadataAuthorityOverride])

  const handleToggleAuthority = async () => {
    if (!release) return
    const nextAuth = authorityInference.authority === 'composer' ? 'performer' : 'composer'
    await sqliteLibraryService.updateReleaseAuthorityOverride(release.id, nextAuth)
    showToast(`Locked authority to ${nextAuth === 'composer' ? 'Composer (Soundtrack mode)' : 'Performer (Solo/Classical mode)'}`)
  }

  // Provenance Badge Helper (compact microcopy for Column 1 Field)
  const renderProvenanceBadge = (source?: ConsensusFieldSource) => {
    if (!source) return null
    if (source.startsWith('consensus_')) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 w-fit">
          <ShieldCheck className="w-3 h-3 shrink-0" />
          <span>2/3 Match</span>
        </span>
      )
    }
    if (source === 'earliest_year_rule') {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 w-fit">
          Master Yr
        </span>
      )
    }
    if (source === 'single_provider_match') {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-500/15 text-blue-300 border border-blue-500/25 w-fit">
          Provider
        </span>
      )
    }
    if (source === 'local_fallback') {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-500/15 text-zinc-300 border border-zinc-500/25 w-fit">
          Local
        </span>
      )
    }
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/25 w-fit">
        {source}
      </span>
    )
  }

  // Field selection state for 4-Way Reconciliation Table
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

  // Track selection (track IDs to stage)
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  // Artist scope policy: 'album_only' sets Album Artist while preserving track vocalists; 'all_tracks' overwrites both
  const [artistPolicy, setArtistPolicy] = useState<'album_only' | 'all_tracks'>('album_only')
  // Track-level editable titles & artists (keyed by trackId)
  const [trackTitles, setTrackTitles] = useState<Record<string, string>>({})
  const [trackArtists, setTrackArtists] = useState<Record<string, string>>({})

  // User query parameter steering for external providers
  const [queryAlbum, setQueryAlbum] = useState('')
  const [queryArtist, setQueryArtist] = useState('')
  const [queryYear, setQueryYear] = useState('')
  const [isQueryRefineOpen, setIsQueryRefineOpen] = useState(false)

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

  // Raw compilation signal detector (triggers cluster analysis)
  const hasCompilationSignals = useMemo(() => {
    if (!albumItem) return false
    return (
      albumItem.primaryIssueType === 'compilation_conflict' ||
      Boolean(release?.isCompilation) ||
      tracks.some((t) => t.isCompilation || /\(from\s+['"][^'"]+['"]\)/i.test(t.title))
    )
  }, [albumItem, release, tracks])

  // Effective Case B gate: only activate multi-soundtrack cluster UI when 2+ distinct film clusters exist
  const isCaseB = useMemo(() => {
    return hasCompilationSignals && compilationClusters.length > 1
  }, [hasCompilationSignals, compilationClusters.length])

  // Quick Action: Strip Rip Flags (cleans both Album Title and Track Titles)
  const handleStripRipFlags = () => {
    const rawTitle = selectedFields.title || albumItem?.albumTitle || ''
    const cleaned = cleanRipNoise(rawTitle)
    if (cleaned) {
      setSelectedFields((prev) => ({ ...prev, title: cleaned }))
      setQueryAlbum(cleaned)
    }
    setTrackTitles((prev) => {
      const next = { ...prev }
      tracks.forEach((t) => {
        const rawTrkTitle = prev[t.id] ?? t.title ?? ''
        const cleanedTrk = cleanRipNoise(rawTrkTitle)
        if (cleanedTrk) {
          next[t.id] = cleanedTrk
        }
      })
      return next
    })
    showToast(`Stripped rip flags from album and track titles.`)
  }

  // Quick Action: Folder -> Album
  const handleFolderToAlbum = () => {
    const rawFolder = release?.folderName || tracks[0]?.folderName
    const meaningful = extractMeaningfulFolderName(rawFolder, release?.folderPath, release?.artistCredit)
    const cleaned = cleanRipNoise(meaningful || rawFolder || '')
    if (cleaned) {
      setSelectedFields((prev) => ({ ...prev, title: cleaned }))
      setQueryAlbum(cleaned)
      showToast(`Adopted folder descriptor as title: "${cleaned}"`)
    }
  }

  // Quick Action: Album -> Folder
  const handleAlbumToFolder = () => {
    const title = selectedFields.title || albumItem?.albumTitle || ''
    if (title && release) {
      release.folderName = title
      showToast(`Synced folder descriptor to match title: "${title}"`)
    }
  }

  // Stacking: Unstack
  const handleUnstack = async () => {
    if (!release) return
    await sqliteLibraryService.unlinkMasterRelease(release.id)
    showToast(`Unstacked "${release.title}" into a standalone master.`)
  }

  // Stacking: Link to target master
  const handleStackWith = async (targetMasterId: string) => {
    if (!release) return
    await sqliteLibraryService.setMasterReleaseLink(release.id, targetMasterId)
    setIsStackPickerOpen(false)
    showToast(`Stacked edition under master release.`)
  }

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

    // Prepare clean initial search terms for external database steering
    const cleanInitialTitle = initialTitle.replace(/\s*(?:\[|\()?cd\s*rip(?:\s*#?\d*)?(?:\]|\))?/i, '').trim() || initialTitle
    const cleanInitialArtist = isPlaceholderTag(initialArtist) || isDefectiveArtistTag(initialArtist, initialTitle) ? '' : initialArtist
    setQueryAlbum(cleanInitialTitle)
    setQueryArtist(cleanInitialArtist)
    setQueryYear(initialYear)

    // Auto-disclose query refinement if tag is an obvious placeholder or defective rip
    if (isPlaceholderTag(initialArtist) || isDefectiveArtistTag(initialArtist, initialTitle)) {
      setIsQueryRefineOpen(true)
    } else {
      setIsQueryRefineOpen(false)
    }

    const initialTrackTitles: Record<string, string> = {}
    const initialTrackArtists: Record<string, string> = {}
    tracks.forEach((t) => {
      initialTrackTitles[t.id] = t.title || ''
      if (isDefectiveArtistTag(t.artistCredit, albumItem.albumTitle)) {
        initialTrackArtists[t.id] = isPlaceholderTag(initialArtist) ? '' : initialArtist
      } else {
        initialTrackArtists[t.id] = t.artistCredit || ''
      }
    })
    setTrackTitles(initialTrackTitles)
    setTrackArtists(initialTrackArtists)

    setSelectedArtwork(null)
    setCandidatesResult(null)
    setConsensusResult(null)
  }, [albumItem?.albumId, release?.id, tracks])

  // Load external candidates on selection with 300ms debounce and playback quietness check
  const fetchCandidates = useCallback(
    async (
      forceEvenIfPlaying = false,
      queryOverrides?: {
        albumTitle?: string
        artistCredit?: string
        composerName?: string
        releaseYear?: string
      }
    ) => {
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

        const searchAlbum = (queryOverrides?.albumTitle !== undefined ? queryOverrides.albumTitle : queryAlbum) || albumItem.albumTitle
        const searchArtist = (queryOverrides?.artistCredit !== undefined ? queryOverrides.artistCredit : queryArtist) || albumItem.artistCredit
        const searchComposer = (queryOverrides?.composerName !== undefined ? queryOverrides.composerName : release?.composerName) || tracks[0]?.composerName
        const rawYear = queryOverrides?.releaseYear !== undefined ? queryOverrides.releaseYear : queryYear
        const searchYear = rawYear ? Number(rawYear) : (release?.releaseYear || tracks[0]?.canonicalReleaseYear || 0)

        const isCustomQuery = Boolean(queryOverrides) || (searchAlbum !== albumItem.albumTitle || searchArtist !== albumItem.artistCredit)

        // 1. Check Lookahead Cache first for 2-of-3 consensus (only if not a custom user-steered search)
        let consensus = !isCustomQuery ? lookaheadQueuePrefetcher.getCachedConsensus(albumItem.albumId) : null
        if (!consensus) {
          const targetRelease = {
            id: albumItem.albumId,
            masterReleaseId: albumItem.albumId,
            title: searchAlbum,
            folderName: albumItem.albumTitle,
            folderPath: '',
            targetFolderPath: '',
            artistCredit: searchArtist,
            composerName: searchComposer,
            releaseYear: searchYear || 0,
            originalYear: searchYear || 0,
            label: 'Lossless Master',
            catalogNumber: '',
            mediaFormat: 'Lossless Audio',
            country: 'Global',
            matrixRunout: '',
            artwork: {
              frontCoverUrl: albumItem.coverArtUrl || '',
              resolution: albumItem.coverArtUrl ? '3000x3000px' : 'No Embedded Art',
              width: 3000,
              height: 3000,
              dpi: 300,
              colorProfile: 'sRGB',
              isLowRes: !albumItem.coverArtUrl,
              hasBookletPdf: false,
            },
            genres: [],
            tracks: tracks,
            isLocalOnline: true,
            storageMountId: 'mount-main',
            isCompilation: false,
            genreTags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as Release

          consensus = await federatedResolversService.resolve2of3ReleaseConsensus(
            targetRelease,
            tracks,
            false
          )
          lookaheadQueuePrefetcher.setCachedConsensus(albumItem.albumId, consensus)
        }

        if (controller.signal.aborted) return

        setConsensusResult(consensus)

        // Prepopulate staged fields with consensus values if present
        if (consensus) {
          const resolvedMasterArtist = consensus?.albumArtist?.value || searchArtist
          setSelectedFields((prev) => ({
            title: consensus?.albumTitle?.value || searchAlbum || prev.title,
            artistCredit: consensus?.albumArtist?.value || searchArtist || prev.artistCredit,
            composerName: consensus?.composer?.value || searchComposer || prev.composerName,
            releaseYear: consensus?.releaseYear?.value
              ? String(consensus.releaseYear.value)
              : (searchYear ? String(searchYear) : prev.releaseYear),
            genre: consensus?.genre?.value || prev.genre,
          }))

          setTrackTitles((prev) => {
            const next = { ...prev }
            tracks.forEach((t) => {
              const tc = consensus?.trackConsensus?.[t.id]
              if (tc?.title?.value) {
                next[t.id] = tc.title.value
              } else if (!next[t.id]) {
                next[t.id] = t.title || ''
              }
            })
            return next
          })

          setTrackArtists((prev) => {
            const next = { ...prev }
            tracks.forEach((t) => {
              const tc = consensus?.trackConsensus?.[t.id]
              if (tc?.artists?.value) {
                next[t.id] = tc.artists.value
              } else if (isDefectiveArtistTag(t.artistCredit, searchAlbum) || !next[t.id]) {
                if (resolvedMasterArtist && !isPlaceholderTag(resolvedMasterArtist)) {
                  next[t.id] = resolvedMasterArtist
                }
              }
            })
            return next
          })
        }

        const result = await federatedResolversService.resolveActiveItemCandidate({
          albumTitle: searchAlbum,
          artistCredit: searchArtist,
          composerName: searchComposer,
          releaseYear: searchYear || undefined,
          trackTitle: tracks[0]?.title,
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        setCandidatesResult(result)

        // Select the highest-res candidate by default if available
        if (result.artworkCandidates.length > 0) {
          setSelectedArtwork(result.artworkCandidates[0])
        }

        // 2. Dispatch Lookahead Prefetch for next 2 queue items in idle background
        if (queue && queue.length > 0 && allTracks && allTracks.length > 0 && allReleases) {
          lookaheadQueuePrefetcher.prefetchLookahead(queue, currentIndex, allReleases, allTracks)
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
    [albumItem, release, tracks, queue, allTracks, allReleases, currentIndex, queryAlbum, queryArtist, queryYear]
  )

  // Debounced candidate fetching on album selection
  useEffect(() => {
    setIsLoadingCandidates(true)
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

  // Compute Compilation Clusters when hasCompilationSignals is true
  useEffect(() => {
    if (!hasCompilationSignals || !release || tracks.length === 0) {
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
  }, [hasCompilationSignals, release, tracks, allReleases])

  // Auto-trigger AI soundtrack canonicalization if requested
  useEffect(() => {
    if (autoTriggerAi && release && tracks.length > 0) {
      setIsLoadingClusters(true)
      compilationCanonicalizerService
        .resolveCompilationSoundtracks(release, tracks, allReleases)
        .then((res) => {
          if (!res.success || res.tracks.length === 0) return
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
          setIsLoadingClusters(false)
        })
    }
  }, [autoTriggerAi, release, tracks, allReleases])

  // Toggle track selection
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

  // Two-state smart per-row reset (Manual Edit -> Consensus -> Local File Tag)
  const handleResetTrackRow = (trk: Track) => {
    const localTitle = trk.title || ''
    const consensusTitle = consensusResult?.trackConsensus?.[trk.id]?.title?.value || localTitle
    const localArtist = trk.artistCredit || ''
    const fallbackMasterArtist =
      isDefectiveArtistTag(localArtist, albumItem?.albumTitle) && !isPlaceholderTag(selectedFields.artistCredit)
        ? selectedFields.artistCredit
        : localArtist
    const consensusArtist = consensusResult?.trackConsensus?.[trk.id]?.artists?.value || fallbackMasterArtist

    const currTitle = trackTitles[trk.id] ?? localTitle
    const currArtist = trackArtists[trk.id] ?? localArtist

    const isManualTitle = currTitle !== consensusTitle && currTitle !== localTitle
    const isManualArtist = currArtist !== consensusArtist && currArtist !== localArtist

    if (isManualTitle || isManualArtist) {
      setTrackTitles((prev) => ({ ...prev, [trk.id]: consensusTitle }))
      setTrackArtists((prev) => ({ ...prev, [trk.id]: consensusArtist }))
    } else if (currTitle !== localTitle || currArtist !== localArtist) {
      setTrackTitles((prev) => ({ ...prev, [trk.id]: localTitle }))
      setTrackArtists((prev) => ({ ...prev, [trk.id]: localArtist }))
    } else {
      setTrackTitles((prev) => ({ ...prev, [trk.id]: consensusTitle }))
      setTrackArtists((prev) => ({ ...prev, [trk.id]: consensusArtist }))
    }
  }

  // Bulk Reset All Tracks
  const handleResetAllTracks = () => {
    const resetTitles: Record<string, string> = {}
    const resetArtists: Record<string, string> = {}
    tracks.forEach((t) => {
      resetTitles[t.id] = t.title || ''
      resetArtists[t.id] = t.artistCredit || ''
    })
    setTrackTitles(resetTitles)
    setTrackArtists(resetArtists)
    showToast('Reset all track titles and artists to local file tags.')
  }

  // Handle "Stage & Next" for Case A (Standard Album or Single-Film Soundtrack)
  const handleStageCaseA = useCallback(() => {
    if (!albumItem || selectedTrackIds.size === 0) return

    const editsMap = new Map<string, Partial<Track>>()

    tracks.forEach((trk) => {
      if (selectedTrackIds.has(trk.id)) {
        const edits: Record<string, any> = {}

        const trimmedAlbumTitle = selectedFields.title.trim()
        const existingAlbumTitle = trk.albumTitle || release?.title || albumItem.albumTitle
        if (trimmedAlbumTitle && trimmedAlbumTitle !== existingAlbumTitle) {
          edits.album = trimmedAlbumTitle
        }

        // Track Title inline edit
        const editedTitle = trackTitles[trk.id]?.trim()
        if (editedTitle && editedTitle !== trk.title) {
          edits.title = editedTitle
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
          const editedArtist = trackArtists[trk.id]?.trim()
          if (
            editedArtist &&
            (editedArtist !== trk.artistCredit || isDefectiveArtistTag(trk.artistCredit, release?.title || albumItem?.albumTitle))
          ) {
            edits.artistCredit = editedArtist
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
  }, [
    albumItem,
    selectedTrackIds,
    tracks,
    selectedFields,
    release,
    trackTitles,
    artistPolicy,
    trackArtists,
    selectedArtwork,
    onStageAndNext,
    showToast,
  ])

  // Build 3-tier merged track edits for a compilation cluster in Case B
  const buildClusterTrackEdits = useCallback(
    (cluster: { soundtrackTitle: string; year?: number; composer?: string; tracks: Track[] }) => {
      const editsMap = new Map<string, Partial<Track>>()

      cluster.tracks.forEach((trk) => {
        if (!selectedTrackIds.has(trk.id)) return

        // Tier 1: Cluster-specific provenance wins per cluster
        const edits: Record<string, any> = {
          originalAlbum: cluster.soundtrackTitle,
          canonicalAlbumTitle: cluster.soundtrackTitle,
        }
        const parsedSharedYear = Number(selectedFields.releaseYear)
        const effectiveYear = cluster.year || (!isNaN(parsedSharedYear) && parsedSharedYear > 0 ? parsedSharedYear : undefined)
        if (effectiveYear) {
          edits.originalYear = effectiveYear
          edits.year = effectiveYear
        }

        // Tier 2: 4-Way Table shared release fields merge across all clusters
        if (selectedFields.artistCredit && selectedFields.artistCredit !== (trk.albumArtist || release?.artistCredit)) {
          edits.albumArtist = selectedFields.artistCredit
        }
        const effectiveComposer = cluster.composer || selectedFields.composerName
        if (effectiveComposer && effectiveComposer !== trk.composerName) {
          edits.composerName = effectiveComposer
        }
        if (selectedFields.genre) {
          edits.genre = selectedFields.genre
        }
        if (selectedArtwork?.coverArtUrl) {
          edits.coverArtUrl = selectedArtwork.coverArtUrl
        }

        // Tier 3: Track-level inline edits always win per track
        const editedTitle = trackTitles[trk.id]?.trim()
        if (editedTitle && editedTitle !== trk.title) {
          edits.title = editedTitle
        }
        if (artistPolicy === 'all_tracks') {
          if (selectedFields.artistCredit && selectedFields.artistCredit !== trk.artistCredit) {
            edits.artistCredit = selectedFields.artistCredit
          }
        } else {
          const editedArtist = trackArtists[trk.id]?.trim()
          if (
            editedArtist &&
            (editedArtist !== trk.artistCredit || isDefectiveArtistTag(trk.artistCredit, release?.title || albumItem?.albumTitle))
          ) {
            edits.artistCredit = editedArtist
          }
        }

        editsMap.set(trk.id, edits)
      })

      return editsMap
    },
    [selectedTrackIds, selectedFields, release, selectedArtwork, trackTitles, artistPolicy, trackArtists, albumItem]
  )

  // Handle Staging a specific cluster in Case B
  const handleStageCluster = useCallback(
    (cluster: { soundtrackTitle: string; year?: number; composer?: string; tracks: Track[] }) => {
      const editsMap = buildClusterTrackEdits(cluster)
      if (editsMap.size === 0) return
      onStageAndNext(editsMap)
      showToast(`Staged soundtrack provenance "${cluster.soundtrackTitle}" for ${editsMap.size} track(s).`)
    },
    [buildClusterTrackEdits, onStageAndNext, showToast]
  )

  // Handle Staging all clusters + 4-Way table + inline track edits in Case B
  const handleStageAllClusters = useCallback(() => {
    if (!albumItem || compilationClusters.length === 0) return
    const combinedEditsMap = new Map<string, Partial<Track>>()
    compilationClusters.forEach((cluster) => {
      const clusterMap = buildClusterTrackEdits(cluster)
      clusterMap.forEach((edits, trackId) => {
        combinedEditsMap.set(trackId, edits)
      })
    })
    if (combinedEditsMap.size === 0) return
    onStageAndNext(combinedEditsMap)
    showToast(
      `Staged ${compilationClusters.length} soundtracks (${combinedEditsMap.size} tracks) in "${albumItem.albumTitle}".`
    )
  }, [albumItem, compilationClusters, buildClusterTrackEdits, onStageAndNext, showToast])

  // Handle Splitting a Combo Release into Virtual Albums
  const handleSplitVirtualAlbums = () => {
    if (!consensusResult?.subReleaseGroupings || consensusResult.subReleaseGroupings.length === 0) return
    const editsMap = new Map<string, Partial<Track>>()

    consensusResult.subReleaseGroupings.forEach((grouping, groupIdx) => {
      const targetTracks = grouping.trackIds && grouping.trackIds.length > 0
        ? tracks.filter((t) => grouping.trackIds!.includes(t.id))
        : tracks.filter((t) => grouping.trackNumbers.includes(t.trackNumber || 0))

      targetTracks.forEach((t) => {
        const edits: Record<string, any> = {
          originalAlbum: grouping.subTitle,
          canonicalAlbumTitle: grouping.subTitle,
          discNumber: groupIdx + 1,
        }
        if (grouping.originalYear) {
          edits.originalYear = grouping.originalYear
        }
        if (grouping.composer) {
          edits.composerName = grouping.composer
        }
        if (selectedArtwork?.coverArtUrl) {
          edits.coverArtUrl = selectedArtwork.coverArtUrl
        }
        editsMap.set(t.id, edits)
      })
    })

    onStageAndNext(editsMap)
    showToast(`Staged virtual album split for ${consensusResult.subReleaseGroupings.length} releases in "${albumItem?.albumTitle}".`)
  }

  // Handle executing a user-refined search across online databases
  const handleExecuteRefinedSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!queryAlbum.trim()) return
    fetchCandidates(true, {
      albumTitle: queryAlbum.trim(),
      artistCredit: queryArtist.trim(),
      releaseYear: queryYear.trim(),
    })
    showToast(`Searching online providers for "${queryAlbum.trim()}"...`)
  }

  // Handle resetting query parameters back to raw file tags
  const handleResetQuery = () => {
    const rawAlbum = albumItem?.albumTitle || ''
    const rawArtist = release?.artistCredit || tracks[0]?.albumArtist || tracks[0]?.artistCredit || albumItem?.artistCredit || ''
    const rawYear = String(release?.releaseYear || tracks[0]?.canonicalReleaseYear || '')
    setQueryAlbum(rawAlbum)
    setQueryArtist(rawArtist)
    setQueryYear(rawYear)
    fetchCandidates(true, {
      albumTitle: rawAlbum,
      artistCredit: rawArtist,
      releaseYear: rawYear,
    })
    showToast('Reset search parameters to local container tags.')
  }

  // Keyboard shortcut listener for (⌘↵)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (isCaseB) {
          handleStageAllClusters()
        } else {
          handleStageCaseA()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleStageCaseA, handleStageAllClusters, isCaseB])

  // Unified Single-Column Editable Track Table Renderer (shared by Case A and Case B)
  const renderTrackTable = (tracksToRender: Track[]) => (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-left text-xs border-collapse">
        <thead>
          <tr className="border-b border-white/[0.08] text-[#8E8E93] text-[11px] font-mono">
            <th className="py-2 px-2 w-12 font-medium">#</th>
            <th className="py-2 px-2 w-[42%] font-medium">Track Title</th>
            <th className="py-2 px-2 w-[44%] font-medium">Track Vocalists / Artists</th>
            <th className="py-2 px-2 w-28 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {tracksToRender.map((t) => {
            const isChecked = selectedTrackIds.has(t.id)
            const currentTitle = trackTitles[t.id] ?? t.title ?? ''
            const currentArtist = artistPolicy === 'all_tracks' ? selectedFields.artistCredit : (trackArtists[t.id] ?? t.artistCredit ?? '')
            const isTitleModified = currentTitle.trim() !== (t.title || '').trim()
            const isArtistModified =
              artistPolicy !== 'all_tracks' && currentArtist.trim() !== (t.artistCredit || '').trim()
            const isRowModified = isTitleModified || isArtistModified

            return (
              <tr
                key={t.id}
                className={`hover:bg-white/[0.02] transition-colors ${!isChecked ? 'opacity-50' : ''}`}
              >
                {/* Column 1: Checkbox & Track Number (48px / w-12) */}
                <td className="py-2 px-2 align-middle">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      checked={isChecked}
                      onChange={() => toggleTrack(t.id)}
                      className="rounded border-white/20 text-[#D4AF37] focus:ring-0 cursor-pointer shrink-0"
                    />
                    <span className="text-[11px] font-mono text-[#636366]">
                      #{t.trackNumber || 1}
                    </span>
                  </div>
                </td>

                {/* Column 2: Inline-Editable Track Title (42%) */}
                <td className="py-2 px-2 align-middle">
                  <input
                    type="text"
                    value={currentTitle}
                    title={currentTitle}
                    onChange={(e) => {
                      const val = e.target.value
                      setTrackTitles((prev) => ({ ...prev, [t.id]: val }))
                    }}
                    placeholder="Track Title"
                    className={`w-full px-2.5 py-1 rounded bg-black/40 border text-xs font-medium transition-colors focus:outline-none ${
                      isTitleModified
                        ? 'border-emerald-500/50 text-emerald-300'
                        : 'border-white/10 text-white hover:border-white/20 focus:border-[#D4AF37]'
                    }`}
                  />
                </td>

                {/* Column 3: Inline-Editable Track Vocalists / Artists (44%) */}
                <td className="py-2 px-2 align-middle">
                  <input
                    type="text"
                    value={currentArtist}
                    title={currentArtist}
                    disabled={artistPolicy === 'all_tracks'}
                    onChange={(e) => {
                      const val = e.target.value
                      setTrackArtists((prev) => ({ ...prev, [t.id]: val }))
                    }}
                    placeholder="Vocalist(s) / Performer"
                    className={`w-full px-2.5 py-1 rounded bg-black/40 border text-xs font-medium transition-colors focus:outline-none ${
                      artistPolicy === 'all_tracks'
                        ? 'border-white/[0.04] text-[#636366] cursor-not-allowed bg-black/20'
                        : isArtistModified
                        ? 'border-emerald-500/50 text-emerald-300'
                        : 'border-white/10 text-white/90 hover:border-white/20 focus:border-[#D4AF37]'
                    }`}
                  />
                </td>

                {/* Column 4: Status & Smart Per-Row Reset (112px / w-28) */}
                <td className="py-2 px-2 align-middle text-right">
                  <div className="inline-flex items-center justify-end gap-1.5">
                    {isRowModified && (
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                        Edited
                      </span>
                    )}
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => handleResetTrackRow(t)}
                      title="Reset track row (cycles Manual Edit → Consensus → Local File Tag)"
                      className="p-1 rounded bg-white/[0.04] hover:bg-white/[0.1] text-[#8E8E93] hover:text-white border border-white/[0.06] transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

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
  const hasValidLocalArt = Boolean(albumItem.coverArtUrl && !failedArtUrls.has(albumItem.coverArtUrl))

  return (
    <div className="flex-1 h-full flex flex-col bg-[#0B0D13] overflow-y-auto select-none">
      {/* 1. Action Header */}
      <div className="h-14 px-6 border-b border-white/[0.06] flex items-center justify-between shrink-0 bg-[#0E0F12]/80 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          {navigationAnchor && onReturnToAnchor && (
            <button
              onClick={onReturnToAnchor}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-all cursor-pointer font-medium text-xs shadow-sm shrink-0"
              title="Return to the album in Listen view"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Return to Listen</span>
            </button>
          )}

          <div className="flex items-center gap-1.5 text-xs text-[#8E8E93] min-w-0">
            <span>Curate</span>
            <span>/</span>
            <span className="font-semibold text-white truncate max-w-[260px] md:max-w-[420px]" title={albumItem.albumTitle}>
              {albumItem.albumTitle}
            </span>
          </div>

          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium shrink-0 ${
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
            onClick={isCaseB ? handleStageAllClusters : handleStageCaseA}
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

      {/* 1.5 Curate Unified Control Bar: Authority Pill, Quick Actions, Stacking */}
      <div className="px-6 py-2.5 bg-[#090A0D] border-b border-white/[0.05] flex items-center justify-between gap-3 flex-wrap text-xs">
        {/* Left: Authority Inference & Toggle */}
        <div className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-mono text-[11px] border ${
              authorityInference.authority === 'composer'
                ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
            }`}
            title={authorityInference.rationale}
          >
            <span>{authorityInference.authority === 'composer' ? '🎼 Composer Authority' : '🎤 Performer Authority'}</span>
            <span className="text-[9px] opacity-75">({(authorityInference.confidence * 100).toFixed(0)}%)</span>
            {authorityInference.isOverride && <span className="text-[9px] text-amber-300 font-sans font-medium">Locked</span>}
          </div>

          <button
            onClick={handleToggleAuthority}
            className="text-[10px] px-2 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 hover:text-white border border-white/[0.08] transition-colors cursor-pointer"
            title="Override authority between Composer (Soundtracks) and Performer (Classical/Solo)"
          >
            Switch to {authorityInference.authority === 'composer' ? 'Performer' : 'Composer'}
          </button>
        </div>

        {/* Center: Quick Clean Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleStripRipFlags}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 hover:text-white border border-white/[0.08] text-[11px] transition-all cursor-pointer"
            title="Strip CD RIP, FLAC, bitrate tags, and brackets from album and track titles"
          >
            <Wand2 className="w-3 h-3 text-[#D4AF37]" />
            <span>Strip Rip Flags</span>
          </button>

          <button
            onClick={handleFolderToAlbum}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 hover:text-white border border-white/[0.08] text-[11px] transition-all cursor-pointer"
            title="Adopt clean folder name as album title"
          >
            <Folder className="w-3 h-3 text-cyan-400" />
            <span>Folder → Album</span>
          </button>

          <button
            onClick={handleAlbumToFolder}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 hover:text-white border border-white/[0.08] text-[11px] transition-all cursor-pointer"
            title="Sync folder descriptor to match album title"
          >
            <Folder className="w-3 h-3 text-emerald-400" />
            <span>Album → Folder</span>
          </button>
        </div>

        {/* Right: Edition Stacking Controls */}
        <div className="flex items-center gap-2">
          {release?.masterReleaseId && release.masterReleaseId !== release.id ? (
            <button
              onClick={handleUnstack}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/25 text-[11px] transition-all cursor-pointer"
              title="Detach this edition to become an independent standalone master"
            >
              <Unlink className="w-3 h-3" />
              <span>Unstack Edition</span>
            </button>
          ) : (
            <button
              onClick={() => setIsStackPickerOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/25 text-[11px] transition-all cursor-pointer"
              title="Link this release as a variant/edition under another master release"
            >
              <Link2 className="w-3 h-3" />
              <span>Stack Edition...</span>
            </button>
          )}
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

      {/* 3. Main Stage Content (pb-24 clears NowPlayingBar) */}
      <div className="p-6 pb-24 space-y-5 flex-1">
        {/* Combo CD Virtual Release Split Banner */}
        {consensusResult?.isComboRelease && consensusResult?.subReleaseGroupings && consensusResult.subReleaseGroupings.length > 0 && (
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg shadow-amber-500/5">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-amber-500/20 text-amber-300 shrink-0">
                <Split className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-amber-200">
                  Combo / 2-in-1 CD Release Detected
                </h3>
                <p className="text-[11px] text-amber-300/80 mt-0.5 leading-relaxed">
                  This release packages multiple distinct soundtrack or album works:
                  {' '}
                  <span className="text-amber-100 font-medium">
                    {consensusResult.subReleaseGroupings
                      .map((g) => `"${g.subTitle}" (${g.trackIds?.length ?? g.trackNumbers.length} tracks)`)
                      .join(' & ')}
                  </span>
                  . You can stage a virtual split to index them cleanly while leaving audio files bit-perfect.
                </p>
              </div>
            </div>
            <button
              onClick={handleSplitVirtualAlbums}
              className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition-all shadow-md shadow-amber-500/20 cursor-pointer shrink-0 flex items-center gap-1.5"
            >
              <Split className="w-4 h-4" />
              <span>Split into Virtual Albums</span>
            </button>
          </div>
        )}

        {/* Top Side-by-Side Split Deck: Artwork Inspector (xl:col-span-4) + 4-Way Reconciliation Matrix (xl:col-span-8) */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
          {/* Left Pane (33%): High-Resolution Artwork Inspector */}
          <div className="xl:col-span-4 p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium text-xs text-white">
                <Eye className="w-4 h-4 text-[#D4AF37] shrink-0" />
                <span>Artwork Inspector</span>
              </div>
              {selectedArtwork && (
                <span className="text-[10px] font-mono text-[#D4AF37] truncate" title={`${selectedArtwork.coverResolution} (${selectedArtwork.providerLabel})`}>
                  {selectedArtwork.coverResolution} · {selectedArtwork.providerLabel}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5 flex-1 items-center">
              {/* 1. Local Tag Embedded */}
              <div
                onClick={() =>
                  setSelectedArtwork({
                    provider: 'local',
                    providerLabel: 'Local Container',
                    albumTitle: albumItem.albumTitle,
                    artistCredit: albumItem.artistCredit,
                    coverArtUrl: hasValidLocalArt ? (albumItem.coverArtUrl || '') : '',
                    thumbnailUrl: hasValidLocalArt ? (albumItem.coverArtUrl || '') : '',
                    coverResolution: hasValidLocalArt ? 'Embedded' : 'Missing',
                    confidenceScore: 1.0,
                  })
                }
                className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col items-center justify-center gap-1.5 relative h-full ${
                  selectedArtwork?.provider === 'local'
                    ? 'bg-white/[0.08] border-[#D4AF37] ring-1 ring-[#D4AF37]/30'
                    : 'bg-black/30 border-white/[0.06] hover:border-white/[0.12]'
                }`}
              >
                <div className="w-20 h-20 rounded-lg bg-neutral-900 overflow-hidden relative border border-white/10 flex items-center justify-center shrink-0">
                  {hasValidLocalArt ? (
                    <img
                      src={albumItem.coverArtUrl}
                      alt={albumItem.albumTitle}
                      className="w-full h-full object-cover"
                      onError={() => {
                        if (albumItem.coverArtUrl) {
                          setFailedArtUrls((prev) => {
                            const next = new Set(prev)
                            next.add(albumItem.coverArtUrl!)
                            return next
                          })
                        }
                      }}
                    />
                  ) : (
                    <Disc className="w-7 h-7 text-[#636366]" />
                  )}
                  {hasValidLocalArt && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedArtwork({
                          provider: 'local',
                          providerLabel: 'Local Container',
                          albumTitle: albumItem.albumTitle,
                          artistCredit: albumItem.artistCredit,
                          coverArtUrl: albumItem.coverArtUrl || '',
                          thumbnailUrl: albumItem.coverArtUrl || '',
                          coverResolution: 'Embedded',
                          confidenceScore: 1.0,
                        })
                        setIsZoomingArt(true)
                      }}
                      className="absolute bottom-1 right-1 p-1 rounded bg-black/60 text-white/80 hover:text-white"
                    >
                      <ZoomIn className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="text-center min-w-0 w-full">
                  <span className="text-[11px] font-medium text-white truncate block">Local File</span>
                  <span className="text-[10px] font-mono text-[#8E8E93] truncate block">
                    {hasValidLocalArt ? 'Embedded Binary' : 'No Cover Art'}
                  </span>
                </div>
              </div>

              {/* 2. External Candidates */}
              {candidatesResult?.artworkCandidates && candidatesResult.artworkCandidates.length > 0 ? (
                candidatesResult.artworkCandidates.slice(0, 3).map((art, idx) => {
                  const isArtValid = Boolean(art.coverArtUrl && !failedArtUrls.has(art.coverArtUrl))
                  return (
                    <div
                      key={idx}
                      onClick={() => setSelectedArtwork(art)}
                      className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col items-center justify-center gap-1.5 relative h-full ${
                        selectedArtwork?.coverArtUrl === art.coverArtUrl
                          ? 'bg-white/[0.08] border-[#D4AF37] ring-1 ring-[#D4AF37]/30'
                          : 'bg-black/30 border-white/[0.06] hover:border-white/[0.12]'
                      }`}
                    >
                      <div className="w-20 h-20 rounded-lg bg-neutral-900 overflow-hidden relative border border-white/10 flex items-center justify-center shrink-0">
                        {isArtValid ? (
                          <img
                            src={art.coverArtUrl}
                            alt={art.providerLabel}
                            className="w-full h-full object-cover"
                            onError={() => {
                              setFailedArtUrls((prev) => {
                                const next = new Set(prev)
                                next.add(art.coverArtUrl)
                                return next
                              })
                            }}
                          />
                        ) : (
                          <Disc className="w-7 h-7 text-[#636366]" />
                        )}
                        {isArtValid && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedArtwork(art)
                              setIsZoomingArt(true)
                            }}
                            className="absolute bottom-1 right-1 p-1 rounded bg-black/60 text-white/80 hover:text-white"
                          >
                            <ZoomIn className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div className="text-center min-w-0 w-full">
                        <span className="text-[11px] font-medium text-white truncate block" title={art.providerLabel}>
                          {art.providerLabel}
                        </span>
                        <span className="text-[10px] font-mono text-[#D4AF37] truncate block">
                          {art.coverResolution}
                        </span>
                      </div>
                    </div>
                  )
                })
              ) : isLoadingCandidates ? (
                <div className="col-span-1 flex flex-col items-center justify-center p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] text-center text-xs text-[#8E8E93] h-full gap-2">
                  <RotateCcw className="w-4 h-4 animate-spin text-[#D4AF37]" />
                  <span className="text-[11px] leading-snug">Resolving high-res cover art...</span>
                </div>
              ) : (
                <div className="col-span-1 flex flex-col items-center justify-center p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] text-center text-xs text-[#8E8E93] h-full gap-2">
                  <span className="text-[11px] leading-snug">No online artwork candidates found.</span>
                  <button
                    onClick={() => fetchCandidates(true)}
                    className="px-2.5 py-1 rounded bg-white/[0.06] hover:bg-white/[0.1] text-white text-[10px] transition-all cursor-pointer"
                  >
                    Retry Lookup
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Pane (67%): 4-Way Metadata Provider Reconciliation Table */}
          <div className="xl:col-span-8 p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] flex flex-col justify-between space-y-3">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium text-xs text-white">
                  <Sparkles className="w-4 h-4 text-[#D4AF37]" />
                  <span>4-Way Metadata Provider Reconciliation</span>
                </div>
                <div className="flex items-center gap-2">
                  {fetchError && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-300 mr-2">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>{fetchError}</span>
                      <button onClick={() => fetchCandidates(true)} className="underline hover:text-white ml-1 cursor-pointer">
                        Retry
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setIsQueryRefineOpen((prev) => !prev)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer ${
                      isQueryRefineOpen
                        ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40 shadow-sm'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/80 hover:text-white border border-white/[0.08]'
                    }`}
                    title="Adjust album, artist, or year search parameters used to query online metadata databases"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span>{isQueryRefineOpen ? 'Hide Query Parameters' : 'Refine Search Query'}</span>
                  </button>
                </div>
              </div>

              {/* Refine Search Query Bar (Progressive Disclosure) */}
              {isQueryRefineOpen && (
                <form
                  onSubmit={handleExecuteRefinedSearch}
                  className="p-3 rounded-xl bg-black/40 border border-[#D4AF37]/30 flex flex-col md:flex-row items-stretch md:items-center gap-2.5 shadow-inner transition-all"
                >
                  <div className="flex items-center gap-1.5 text-[#D4AF37] shrink-0 text-xs font-medium px-1">
                    <Search className="w-3.5 h-3.5" />
                    <span>Search Parameters:</span>
                  </div>
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-12 gap-2">
                    <div className="sm:col-span-5 relative">
                      <input
                        type="text"
                        value={queryAlbum}
                        onChange={(e) => setQueryAlbum(e.target.value)}
                        placeholder="Album Title (e.g. Baasha)"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-[#D4AF37]/60 focus:ring-1 focus:ring-[#D4AF37]/30 transition-all"
                      />
                      <span className="absolute right-2 top-2 text-[9px] font-mono text-zinc-500 uppercase pointer-events-none">Album</span>
                    </div>
                    <div className="sm:col-span-4 relative">
                      <input
                        type="text"
                        value={queryArtist}
                        onChange={(e) => setQueryArtist(e.target.value)}
                        placeholder="Artist / Composer (e.g. Deva)"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-[#D4AF37]/60 focus:ring-1 focus:ring-[#D4AF37]/30 transition-all"
                      />
                      <span className="absolute right-2 top-2 text-[9px] font-mono text-zinc-500 uppercase pointer-events-none">Artist</span>
                    </div>
                    <div className="sm:col-span-3 relative">
                      <input
                        type="text"
                        value={queryYear}
                        onChange={(e) => setQueryYear(e.target.value)}
                        placeholder="Year (e.g. 1995)"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-[#D4AF37]/60 focus:ring-1 focus:ring-[#D4AF37]/30 transition-all"
                      />
                      <span className="absolute right-2 top-2 text-[9px] font-mono text-zinc-500 uppercase pointer-events-none">Year</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 justify-end">
                    <button
                      type="submit"
                      disabled={isLoadingCandidates || !queryAlbum.trim()}
                      className="px-3 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#D4AF37]/90 text-black font-semibold text-xs flex items-center gap-1.5 transition-all shadow-md shadow-[#D4AF37]/15 disabled:opacity-50 cursor-pointer"
                    >
                      {isLoadingCandidates ? (
                        <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Search className="w-3.5 h-3.5" />
                      )}
                      <span>Re-Search (↵)</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleResetQuery}
                      className="px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-[#8E8E93] hover:text-white text-xs transition-all cursor-pointer"
                      title="Reset to local container tags"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </form>
              )}

              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-[#8E8E93] text-[11px] font-mono">
                      <th className="py-2 px-3 w-[18%] font-medium">Field</th>
                      <th className="py-2 px-3 w-[18%] font-medium">Local File Tag</th>
                      <th className="py-2 px-3 w-[18%] font-medium">Apple Music Master</th>
                      <th className="py-2 px-3 w-[18%] font-medium">MusicBrainz Archive</th>
                      <th className="py-2 px-3 w-[28%] font-medium text-emerald-400">Staged Output</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {/* Album Title */}
                    <tr>
                      <td className="py-2 px-3 align-middle">
                        <div className="flex flex-col items-start gap-1">
                          <span className="font-medium text-white/80">Album Title</span>
                          {renderProvenanceBadge(consensusResult?.albumTitle?.source)}
                        </div>
                      </td>
                      <td
                        onClick={() => setSelectedFields((prev) => ({ ...prev, title: albumItem.albumTitle }))}
                        title={albumItem.albumTitle}
                        className="py-2 px-3 align-middle text-[#A1A1AA] hover:text-white cursor-pointer transition-colors truncate"
                      >
                        {albumItem.albumTitle}
                      </td>
                      <td
                        onClick={() => {
                          if (itunesCandidate?.releaseTitle) {
                            setSelectedFields((prev) => ({ ...prev, title: itunesCandidate.releaseTitle }))
                          }
                        }}
                        title={itunesCandidate?.releaseTitle || ''}
                        className={`py-2 px-3 align-middle truncate transition-colors ${
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
                        title={mbCandidate?.releaseTitle || ''}
                        className={`py-2 px-3 align-middle truncate transition-colors ${
                          mbCandidate?.releaseTitle ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                        }`}
                      >
                        {mbCandidate?.releaseTitle || '—'}
                      </td>
                      <td className="py-2 px-3 align-middle">
                        <input
                          type="text"
                          value={selectedFields.title}
                          title={selectedFields.title}
                          onChange={(e) => setSelectedFields((prev) => ({ ...prev, title: e.target.value }))}
                          className="w-full px-2.5 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs"
                        />
                      </td>
                    </tr>

                    {/* Album Artist */}
                    <tr>
                      <td className="py-2 px-3 align-middle">
                        <div className="flex flex-col items-start gap-1">
                          <span className="font-medium text-white/80">Album Artist</span>
                          {renderProvenanceBadge(consensusResult?.albumArtist?.source)}
                        </div>
                      </td>
                      <td
                        onClick={() => setSelectedFields((prev) => ({ ...prev, artistCredit: albumItem.artistCredit }))}
                        title={albumItem.artistCredit}
                        className="py-2 px-3 align-middle text-[#A1A1AA] hover:text-white cursor-pointer transition-colors truncate"
                      >
                        {albumItem.artistCredit}
                      </td>
                      <td
                        onClick={() => {
                          if (itunesCandidate?.artistCredit) {
                            setSelectedFields((prev) => ({ ...prev, artistCredit: itunesCandidate.artistCredit }))
                          }
                        }}
                        title={itunesCandidate?.artistCredit || ''}
                        className={`py-2 px-3 align-middle truncate transition-colors ${
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
                        title={mbCandidate?.artistCredit || ''}
                        className={`py-2 px-3 align-middle truncate transition-colors ${
                          mbCandidate?.artistCredit ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                        }`}
                      >
                        {mbCandidate?.artistCredit || '—'}
                      </td>
                      <td className="py-2 px-3 align-middle">
                        <input
                          type="text"
                          value={selectedFields.artistCredit}
                          title={selectedFields.artistCredit}
                          onChange={(e) => setSelectedFields((prev) => ({ ...prev, artistCredit: e.target.value }))}
                          className="w-full px-2.5 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs"
                        />
                      </td>
                    </tr>

                    {/* Composer */}
                    <tr>
                      <td className="py-2 px-3 align-middle">
                        <div className="flex flex-col items-start gap-1">
                          <span className="font-medium text-white/80">Composer</span>
                          {renderProvenanceBadge(consensusResult?.composer?.source)}
                        </div>
                      </td>
                      <td
                        onClick={() =>
                          setSelectedFields((prev) => ({
                            ...prev,
                            composerName: release?.composerName || tracks[0]?.composerName || '',
                          }))
                        }
                        title={release?.composerName || tracks[0]?.composerName || ''}
                        className="py-2 px-3 align-middle text-[#A1A1AA] hover:text-white cursor-pointer transition-colors truncate"
                      >
                        {release?.composerName || tracks[0]?.composerName || '—'}
                      </td>
                      <td
                        onClick={() => {
                          if (itunesCandidate?.composer) {
                            setSelectedFields((prev) => ({ ...prev, composerName: itunesCandidate.composer! }))
                          }
                        }}
                        title={itunesCandidate?.composer || ''}
                        className={`py-2 px-3 align-middle truncate transition-colors ${
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
                        title={mbCandidate?.composer || ''}
                        className={`py-2 px-3 align-middle truncate transition-colors ${
                          mbCandidate?.composer ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                        }`}
                      >
                        {mbCandidate?.composer || '—'}
                      </td>
                      <td className="py-2 px-3 align-middle">
                        <input
                          type="text"
                          value={selectedFields.composerName}
                          title={selectedFields.composerName}
                          onChange={(e) => setSelectedFields((prev) => ({ ...prev, composerName: e.target.value }))}
                          className="w-full px-2.5 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs"
                        />
                      </td>
                    </tr>

                    {/* Release Year */}
                    <tr>
                      <td className="py-2 px-3 align-middle">
                        <div className="flex flex-col items-start gap-1">
                          <span className="font-medium text-white/80">Release Year</span>
                          {renderProvenanceBadge(consensusResult?.releaseYear?.source)}
                        </div>
                      </td>
                      <td
                        onClick={() =>
                          setSelectedFields((prev) => ({
                            ...prev,
                            releaseYear: String(release?.releaseYear || tracks[0]?.canonicalReleaseYear || ''),
                          }))
                        }
                        className="py-2 px-3 align-middle text-[#A1A1AA] hover:text-white cursor-pointer transition-colors font-mono truncate"
                      >
                        {release?.releaseYear || tracks[0]?.canonicalReleaseYear || '—'}
                      </td>
                      <td
                        onClick={() => {
                          if (itunesCandidate?.releaseYear) {
                            setSelectedFields((prev) => ({ ...prev, releaseYear: String(itunesCandidate.releaseYear) }))
                          }
                        }}
                        className={`py-2 px-3 align-middle font-mono truncate transition-colors ${
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
                        className={`py-2 px-3 align-middle font-mono truncate transition-colors ${
                          mbCandidate?.releaseYear ? 'text-white hover:text-[#D4AF37] cursor-pointer' : 'text-[#636366]'
                        }`}
                      >
                        {mbCandidate?.releaseYear || '—'}
                      </td>
                      <td className="py-2 px-3 align-middle font-mono">
                        <input
                          type="text"
                          value={selectedFields.releaseYear}
                          title={selectedFields.releaseYear}
                          onChange={(e) => setSelectedFields((prev) => ({ ...prev, releaseYear: e.target.value }))}
                          className="w-full px-2.5 py-1 rounded bg-black/40 border border-emerald-500/30 text-emerald-300 font-medium focus:outline-none focus:border-emerald-400 text-xs font-mono"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
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
        </div>

        {/* Case B: Multi-Film Compilation Box Set Clusters (Strictly >1 Film Soundtracks) OR Case A: Standard Album Track Table */}
        {isCaseB ? (
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 font-medium text-xs text-white">
                <Film className="w-4 h-4 text-[#D4AF37]" />
                <span>Multi-Soundtrack Compilation Clusters ({compilationClusters.length} Film Soundtracks)</span>
              </div>
              <div className="flex items-center gap-3">
                {isLoadingClusters && (
                  <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
                    <RotateCcw className="w-3.5 h-3.5 animate-spin text-[#D4AF37]" />
                    <span>AI resolving soundtrack origins...</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleResetAllTracks}
                  className="text-[11px] text-[#8E8E93] hover:text-white cursor-pointer"
                >
                  Reset All Tracks
                </button>
                <button
                  type="button"
                  onClick={toggleAllTracks}
                  className="text-[11px] text-[#D4AF37] hover:underline cursor-pointer font-medium"
                >
                  {selectedTrackIds.size === tracks.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>
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

                  <div className="pt-1 border-t border-white/[0.04]">
                    {renderTrackTable(cluster.tracks)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Case A: Standard Album / Single-Film Soundtrack Track Table */
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 font-medium text-xs text-white">
                <Music className="w-4 h-4 text-[#D4AF37]" />
                <span>Affected Tracks to Stage ({selectedTrackIds.size}/{tracks.length} Selected)</span>
                <span className="text-[10px] text-[#8E8E93] font-mono ml-2">
                  {artistPolicy === 'album_only'
                    ? '• Individual track titles & singers preserved / editable'
                    : '• Album Artist will apply to all tracks'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleResetAllTracks}
                  className="text-[11px] text-[#8E8E93] hover:text-white cursor-pointer"
                >
                  Reset All Tracks
                </button>
                <button
                  type="button"
                  onClick={toggleAllTracks}
                  className="text-[11px] text-[#D4AF37] hover:underline cursor-pointer font-medium"
                >
                  {selectedTrackIds.size === tracks.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>
            </div>

            {renderTrackTable(tracks)}
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

      {/* Stacking Release Picker Modal */}
      {isStackPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-[#12141A] border border-white/10 rounded-2xl w-full max-w-lg p-5 shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-indigo-400" />
                <h3 className="font-semibold text-white text-sm">Stack with Master Release</h3>
              </div>
              <button
                onClick={() => setIsStackPickerOpen(false)}
                className="p-1 rounded-md hover:bg-white/10 text-neutral-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-neutral-400 my-3">
              Select another release to attach <span className="text-white font-medium">"{albumItem.albumTitle}"</span> as a pressing variant:
            </p>

            <div className="relative mb-3">
              <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={stackSearchQuery}
                onChange={(e) => setStackSearchQuery(e.target.value)}
                placeholder="Search releases..."
                className="w-full pl-9 pr-3 py-1.5 bg-black/40 border border-white/10 rounded-lg text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-400"
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-1.5 min-h-[200px] max-h-[360px] pr-1">
              {allReleases
                .filter((r) => r.id !== release?.id)
                .filter((r) => !stackSearchQuery || r.title.toLowerCase().includes(stackSearchQuery.toLowerCase()))
                .slice(0, 30)
                .map((r) => (
                  <div
                    key={r.id}
                    onClick={() => handleStackWith(r.id)}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/[0.04] hover:border-indigo-500/40 transition-all cursor-pointer group"
                  >
                    <div className="min-w-0 pr-3">
                      <div className="text-xs font-medium text-white truncate group-hover:text-indigo-300">
                        {r.title}
                      </div>
                      <div className="text-[10px] text-neutral-400 truncate">
                        {r.artistCredit || r.composerName || 'Unknown Artist'} • {r.releaseYear || 'Unknown Year'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 text-[10px] font-medium shrink-0 group-hover:bg-indigo-500 group-hover:text-white transition-all"
                    >
                      Attach
                    </button>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
