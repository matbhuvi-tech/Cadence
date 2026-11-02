/**
 * src/components/Curate/UnifiedCurateCockpit.tsx
 * Production Unified Curate & Metadata Management Cockpit (⌘2).
 * 
 * Merges Curate and Audit into a single command center with 2-Tier Workflow:
 * - Tier 1: Auto-Staged (High-confidence 3-of-4 consensus, 1-click non-blocking batch commit).
 * - Tier 2: Guided 4-Way Table Reconciliation (Local, Apple Music, MusicBrainz, Gemini AI, Selected).
 * 
 * Features:
 * - Sequence-aware track offset alignment (e.g. #6-#10 mapped to #1-#5 for Ranga).
 * - Consensus Empty-State Invariant: leaves Selected empty when local tag is missing and external providers lack quorum.
 * - Inline manual override pencil on every tag (including custom artwork URL).
 * - Audiophile Transport Quietness Guard (yields background disk I/O when isPlaying is active).
 * - Real-time Behavioral Learning integration (remembers user spelling & delimiter corrections).
 * - Unified Health & Audit drawer.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Sparkles,
  CheckCircle2,
  SlidersHorizontal,
  Layers,
  ArrowRight,
  BookOpen,
  Volume2,
  Pause,
  X,
  Edit2,
  Check,
  Undo2,
  Trash2,
  Image as ImageIcon,
  Link2,
  Music,
  Info,
  ChevronDown,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  AlertCircle,
  Plus,
  Search,
  ArrowLeft,
} from 'lucide-react'
import {
  Track,
  Release,
  AuditIssue,
  NavigationAnchor,
  CurateTier,
  MetadataFieldState,
  TrackCandidateState,
  LearnedRule,
  SemanticConventions,
} from '../../core/types'
import { graphEngine } from '../../core/graphEngine'
import { curationQueueService, AlbumCurationQueueItem } from '../../services/curationQueueService'
import { federatedResolversService } from '../../services/federatedResolvers'
import { compilationCanonicalizerService } from '../../services/compilationCanonicalizerService'
import { behavioralLearningService } from '../../services/behavioralLearningService'
import { tauriBridge } from '../../services/tauriBridge'
import { provenanceCacheService } from '../../services/provenanceCacheService'
import { resolveGemini } from '../../services/geminiClient'
import type { CompilationProvenanceResult } from '../../core/types'
import {
  cleanRipNoise,
  isPlaceholderTag,
  isDefectiveArtistTag,
  detectSequenceOffset,
  applyConsensusEmptyStateRule,
  detectLanguage,
  getCuratedAlbumArtwork,
} from '../../core/taxonomyUtils'

export interface UnifiedCurateCockpitProps {
  tracks: Track[]
  releases: Release[]
  auditIssues?: AuditIssue[]
  initialSelectedAlbumId?: string | null
  navigationAnchor?: NavigationAnchor | null
  onReturnToAnchor?: () => void
  onOpenCommitModal: () => void
  onBackToLibrary: () => void
  showToast: (msg: string) => void
  onRefreshLibrary?: () => void
  isPlaying?: boolean
}

interface AlbumWorkItem {
  id: string
  folderName: string
  currentTitle: string
  tier: CurateTier
  status: 'staged' | 'committing' | 'committed'
  confidenceScore: number
  offsetApplied?: number
  albumTitle: MetadataFieldState<string>
  albumArtist: MetadataFieldState<string>
  composer: MetadataFieldState<string>
  year: MetadataFieldState<number | undefined>
  coverArt: MetadataFieldState<string>
  genre: MetadataFieldState<string>
  tracks: TrackCandidateState[]
  rawRelease?: Release
  rawTracks: Track[]
}

// Direct Apple Music URL and Slug Resolver
async function resolveDirectAppleMusicCandidate(inputUrl: string, steerTitle?: string, steerArtist?: string): Promise<{
  releaseTitle: string
  artistCredit: string
  composer: string
  releaseYear?: number
  genre: string
  coverArtUrl: string
  tracks: Array<{ trackNumber: number; trackName: string; artistName?: string }>
} | null> {
  let collectionId: string | null = null
  const idMatch = inputUrl.match(/(?:album\/[^\/]+\/|album\/|id=?)(\d{8,12})/)
  if (idMatch) collectionId = idMatch[1]

  const parseResults = (results: any[]) => {
    const coll = results.find(r => r.wrapperType === 'collection') || results[0]
    const songs = results.filter(r => r.wrapperType === 'track')
    return {
      releaseTitle: coll.collectionName,
      artistCredit: coll.artistName,
      composer: coll.artistName,
      releaseYear: coll.releaseDate ? parseInt(coll.releaseDate.slice(0, 4), 10) : undefined,
      genre: coll.primaryGenreName || 'Soundtrack',
      coverArtUrl: coll.artworkUrl100 ? coll.artworkUrl100.replace('100x100bb', '3000x3000bb') : '',
      tracks: songs.map(s => ({
        trackNumber: s.trackNumber,
        trackName: s.trackName,
        artistName: s.artistName,
      })),
    }
  }

  // 1. Direct ID lookup on iTunes Store API (try India storefront then global)
  if (collectionId) {
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&country=in&entity=song`)
      const data = await res.json()
      if (data.resultCount > 0) return parseResults(data.results)

      const resGlobal = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=song`)
      const dataGlobal = await resGlobal.json()
      if (dataGlobal.resultCount > 0) return parseResults(dataGlobal.results)
    } catch (e) {
      console.warn('[AppleMusicResolver] Direct ID lookup failed:', e)
    }
  }

  // 2. Fallback: Extract title slug from URL (e.g. if ID has typo or regional redirection)
  let slugTitle = ''
  const slugMatch = inputUrl.match(/album\/([^\/]+)\//)
  if (slugMatch) {
    slugTitle = slugMatch[1]
      .replace(/-/g, ' ')
      .replace(/\b(?:original motion picture soundtrack|soundtrack|ep|ost)\b/gi, '')
      .trim()
  }

  const queryTerms = [slugTitle || steerTitle, steerArtist].filter(Boolean).join(' ')
  if (queryTerms) {
    try {
      const sRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(queryTerms)}&country=in&media=music&entity=album`)
      const sData = await sRes.json()
      if (sData.resultCount > 0) {
        const bestColl = sData.results[0]
        const lRes = await fetch(`https://itunes.apple.com/lookup?id=${bestColl.collectionId}&country=in&entity=song`)
        const lData = await lRes.json()
        if (lData.resultCount > 0) return parseResults(lData.results)
      }
    } catch (e) {
      console.warn('[AppleMusicResolver] Slug fallback search failed:', e)
    }
  }

  return null
}

export const UnifiedCurateCockpit: React.FC<UnifiedCurateCockpitProps> = ({
  tracks,
  releases,
  auditIssues = [],
  initialSelectedAlbumId,
  navigationAnchor,
  onReturnToAnchor,
  onOpenCommitModal,
  onBackToLibrary,
  showToast,
  onRefreshLibrary,
  isPlaying = false,
}) => {
  // 1. Compute Base Queue from Curation Queue Service
  const baseQueue = useMemo(() => {
    return curationQueueService.computeCurationQueue(tracks, releases, auditIssues)
  }, [tracks, releases, auditIssues])

  // 2. Active Tier & Modals
  const [activeTier, setActiveTier] = useState<CurateTier>('tier2')
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false)
  const [isHealthDrawerOpen, setIsHealthDrawerOpen] = useState(false)
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(initialSelectedAlbumId || null)
  const [learnedRules, setLearnedRules] = useState<LearnedRule[]>(() => behavioralLearningService.getLearnedRules())
  const [conventions, setConventions] = useState<SemanticConventions>(() => behavioralLearningService.getConventions())
  const [dismissedPrompts, setDismissedPrompts] = useState<Set<string>>(new Set())

  // Steer Providers & AI Grounding State
  const [isReQueryOpen, setIsReQueryOpen] = useState(true)
  const [steerAlbum, setSteerAlbum] = useState('')
  const [steerArtist, setSteerArtist] = useState('')
  const [steerYear, setSteerYear] = useState('')
  const [steerGroundingUrl, setSteerGroundingUrl] = useState('')
  const [isSteeringLoading, setIsSteeringLoading] = useState(false)

  // Inline editing state
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null)
  const [editInputValue, setEditInputValue] = useState<string>('')
  const [editingTrack, setEditingTrack] = useState<{ trackId: string; field: 'title' | 'artists' } | null>(null)
  const [trackEditValue, setTrackEditValue] = useState<string>('')

  // Commit progress state
  const [isBatchCommitting, setIsBatchCommitting] = useState(false)
  const [commitProgress, setCommitProgress] = useState<{ current: number; total: number } | null>(null)

  // Compilation Provenance State & Abort Controller
  const [isResolvingProvenance, setIsResolvingProvenance] = useState(false)
  const [editingProvenanceTrackId, setEditingProvenanceTrackId] = useState<string | null>(null)
  const [provenanceEditFilm, setProvenanceEditFilm] = useState('')
  const [provenanceEditYear, setProvenanceEditYear] = useState('')
  const provenanceAbortRef = useRef<AbortController | null>(null)

  // 3. Build Rich Album Work Items
  const [albumItems, setAlbumItems] = useState<Map<string, AlbumWorkItem>>(new Map())

  // Initialize and populate album items - PRESERVES user edits across library refreshes
  useEffect(() => {
    setAlbumItems((prev) => {
      const next = new Map(prev)

      for (const qItem of baseQueue) {
        // If album already exists in state, PRESERVE IT and do not overwrite user choices
        if (next.has(qItem.albumId)) {
          continue
        }

        const rel = releases.find((r) => r.id === qItem.albumId)
        const albTracks = tracks.filter(
          (t) =>
            t.releaseId === qItem.albumId ||
            (t.albumTitle && t.albumTitle.toLowerCase().trim() === qItem.albumTitle.toLowerCase().trim())
        ).sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))

        if (!rel && albTracks.length === 0) continue

        const rawTitle = rel?.title || albTracks[0]?.albumTitle || qItem.albumTitle || 'Unknown Album'
        const rawArtist = rel?.artistCredit || albTracks[0]?.artistCredit || 'Unknown Artist'
        const rawComposer = rel?.composerName || albTracks.find((t) => t.composerName)?.composerName || ''
        const rawYear = rel?.releaseYear || albTracks[0]?.releaseYear
        const rawArt =
          rel?.coverArtUrl ||
          rel?.artwork?.frontCoverUrl ||
          (rel as any)?.front_cover_url ||
          (rel as any)?.frontCoverUrl ||
          albTracks[0]?.coverArtUrl ||
          albTracks[0]?.artworkUrl ||
          albTracks[0]?.frontCoverUrl ||
          getCuratedAlbumArtwork(rawTitle, rawComposer || rawArtist) ||
          ''
        const rawGenre = rel?.genreTags?.[0] || albTracks[0]?.genre || 'Soundtrack'

        // Detect album primary language for accurate conventions
        const initDetectedLang = detectLanguage({
          title: rawTitle,
          artistCredit: rawArtist,
          composerName: rawComposer,
          genreTags: rel?.genreTags || (albTracks[0]?.genre ? [albTracks[0].genre] : []),
          filePath: albTracks[0]?.filePath,
        }) || 'Hindi'

        // Check learned rules for artist and composer
        const learnedArtist = behavioralLearningService.applyLearnedRules(rawArtist, 'artist').value
        const learnedComposer = rawComposer ? behavioralLearningService.applyLearnedRules(rawComposer, 'composer').value : ''

        // Apply semantic conventions (Indian Soundtrack -> Artist = Composer, Language-prefixed genre)
        const conv = behavioralLearningService.applySoundtrackConventions({
          composer: rawComposer,
          albumArtist: rawArtist,
          genre: rawGenre,
          language: initDetectedLang,
        })

        // Track candidate states
        const trackStates: TrackCandidateState[] = albTracks.map((t) => ({
          trackId: t.id,
          trackNumber: t.trackNumber || 0,
          localTitle: t.title,
          localArtists: t.artistCredit || '',
          localDuration: t.duration,
          matchedTitle: t.title,
          matchedArtists: behavioralLearningService.applyLearnedRules(t.artistCredit || rawArtist, 'artist').value,
          originalAlbum: t.originalAlbum || '',
          originalYear: t.originalYear,
          provenanceSource: t.originalAlbum ? ('local_fallback' as any) : undefined,
          confidence: 0.90,
          source: 'local_fallback',
          requiresHumanReview: isPlaceholderTag(t.artistCredit || ''),
        }))

        const emptyArtistRule = applyConsensusEmptyStateRule(rawArtist, {})
        const isClean = !qItem.requiresDisambiguation && qItem.confidenceScore >= 0.85 && !isPlaceholderTag(rawArtist)

        const finalAlbumArtist = conv.albumArtist || (emptyArtistRule.selected !== '' ? learnedArtist : '')
        const finalGenre = conv.genre || rawGenre

        next.set(qItem.albumId, {
          id: qItem.albumId,
          folderName: qItem.folderName,
          currentTitle: rawTitle,
          tier: isClean ? 'tier1' : 'tier2',
          status: 'staged',
          confidenceScore: qItem.confidenceScore,
          rawRelease: rel,
          rawTracks: albTracks,
          albumTitle: {
            local: rawTitle,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: rawTitle,
            confidence: 0.9,
            source: 'local_fallback',
          },
          albumArtist: {
            local: rawArtist,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: finalAlbumArtist,
            confidence: emptyArtistRule.hasConsensus ? 0.9 : 0.3,
            source: 'local_fallback',
            requiresHumanReview: !finalAlbumArtist || emptyArtistRule.requiresHumanReview,
          },
          composer: {
            local: rawComposer,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: learnedComposer,
            confidence: rawComposer ? 0.9 : 0.4,
            source: 'local_fallback',
          },
          year: {
            local: rawYear,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: rawYear,
            confidence: rawYear ? 0.9 : 0.4,
            source: 'local_fallback',
          },
          coverArt: {
            local: rawArt,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: rawArt,
            confidence: rawArt ? 0.9 : 0.3,
            source: 'local_fallback',
          },
          genre: {
            local: rawGenre,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: finalGenre,
            confidence: 0.85,
            source: 'local_fallback',
          },
          tracks: trackStates,
        })
      }

      if (!selectedAlbumId && next.size > 0) {
        const firstTier2 = Array.from(next.values()).find((a) => a.tier === 'tier2' && a.status !== 'committed')
        if (firstTier2) setSelectedAlbumId(firstTier2.id)
      }

      return next
    })
  }, [baseQueue, releases, tracks])

  // Active selected album
  const selectedAlbum = useMemo(() => {
    if (!selectedAlbumId) return null
    return albumItems.get(selectedAlbumId) || null
  }, [albumItems, selectedAlbumId])

  // Sync steering parameters when active album changes
  useEffect(() => {
    if (selectedAlbum) {
      setSteerAlbum(selectedAlbum.albumTitle.selected || selectedAlbum.currentTitle || '')
      setSteerArtist(selectedAlbum.composer.selected || selectedAlbum.albumArtist.selected || '')
      setSteerYear(selectedAlbum.year.selected ? String(selectedAlbum.year.selected) : '')
      setSteerGroundingUrl('')
    }
  }, [selectedAlbumId])

  // Count by tier
  const tier1Items = useMemo(() => {
    return Array.from(albumItems.values()).filter((a) => a.tier === 'tier1' && a.status !== 'committed')
  }, [albumItems])

  const tier2Items = useMemo(() => {
    return Array.from(albumItems.values()).filter((a) => a.tier === 'tier2' && a.status !== 'committed')
  }, [albumItems])

  // Asynchronously resolve 4-way consensus for selected album
  useEffect(() => {
    if (!selectedAlbum || !selectedAlbum.rawRelease || !selectedAlbum.rawTracks.length) return
    let isMounted = true

    const fetchConsensus = async () => {
      try {
        const consensus = await federatedResolversService.resolve2of3ReleaseConsensus(
          selectedAlbum.rawRelease!,
          selectedAlbum.rawTracks,
          false
        )

        if (!isMounted) return

        setAlbumItems((prev) => {
          const next = new Map(prev)
          const current = next.get(selectedAlbum.id)
          if (!current) return prev

          // Preserve user-selected values and manual overrides when online provider candidates arrive
          const preserveField = <T,>(curr: MetadataFieldState<T>, cand?: MetadataFieldState<T>): MetadataFieldState<T> => {
            if (!cand) return curr
            const isUserSet = curr.userOverridden || (curr.selected !== '' && curr.selected !== undefined && curr.source !== 'local_fallback')
            return {
              ...cand,
              selected: isUserSet ? curr.selected : (cand.selected || curr.selected),
              userOverridden: curr.userOverridden,
              source: curr.userOverridden ? 'manual_override' : (isUserSet ? curr.source : cand.source),
            }
          }

          // Apply semantic conventions (Indian Soundtrack -> Artist = Composer, Language-prefixed genre)
          const convRes = behavioralLearningService.applySoundtrackConventions({
            composer: String(consensus.albumFieldStates?.composer?.selected || current.composer.selected || ''),
            albumArtist: String(consensus.albumFieldStates?.albumArtist?.selected || current.albumArtist.selected || ''),
            genre: String(consensus.albumFieldStates?.genre?.selected || current.genre.selected || ''),
            language: detectedLanguage,
          })

          const updated: AlbumWorkItem = {
            ...current,
            tier: consensus.tier || current.tier,
            confidenceScore: consensus.confidenceScore || current.confidenceScore,
            offsetApplied: consensus.sequenceOffsetResult?.isConfidentOffset
              ? consensus.sequenceOffsetResult.detectedOffset
              : undefined,
            albumTitle: preserveField(current.albumTitle, consensus.albumFieldStates?.albumTitle),
            albumArtist: {
              ...preserveField(current.albumArtist, consensus.albumFieldStates?.albumArtist),
              selected: current.userOverridden
                ? current.albumArtist.selected
                : (convRes.albumArtist || preserveField(current.albumArtist, consensus.albumFieldStates?.albumArtist).selected),
            },
            composer: preserveField(current.composer, consensus.albumFieldStates?.composer),
            year: preserveField(current.year, consensus.albumFieldStates?.releaseYear),
            coverArt: preserveField(current.coverArt, consensus.albumFieldStates?.coverArt),
            genre: {
              ...preserveField(current.genre, consensus.albumFieldStates?.genre),
              selected: current.userOverridden
                ? current.genre.selected
                : (convRes.genre || preserveField(current.genre, consensus.albumFieldStates?.genre).selected),
            },
            tracks: current.tracks.some(t => t.userOverridden)
              ? current.tracks
              : (consensus.trackStates && consensus.trackStates.length > 0 ? consensus.trackStates : current.tracks),
          }

          next.set(selectedAlbum.id, updated)
          return next
        })
      } catch (err) {
        console.warn('[UnifiedCurateCockpit] Consensus fetch deferred:', err)
      }
    }

    fetchConsensus()

    return () => {
      isMounted = false
    }
  }, [selectedAlbumId])

  // Select provider cell for an album field
  const handleSelectFieldSource = (
    fieldKey: 'albumTitle' | 'albumArtist' | 'composer' | 'year' | 'coverArt' | 'genre',
    source: 'local' | 'apple' | 'musicbrainz' | 'ai'
  ) => {
    if (!selectedAlbum) return
    const field = selectedAlbum[fieldKey] as MetadataFieldState<any>
    const val = field[source]
    if (val === undefined || val === '') return

    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const updatedField: MetadataFieldState<any> = {
        ...field,
        selected: val,
        source: source === 'local' ? 'local_fallback' : 'single_provider_match',
        requiresHumanReview: false,
      }

      next.set(selectedAlbum.id, {
        ...current,
        [fieldKey]: updatedField,
      })
      return next
    })

    showToast(`Adopted ${source.toUpperCase()} for ${fieldKey}`)
  }

  // Save manual field edit
  const handleSaveManualField = (fieldKey: 'albumTitle' | 'albumArtist' | 'composer' | 'year' | 'coverArt' | 'genre') => {
    if (!selectedAlbum) return
    const trimmed = editInputValue.trim()
    if (!trimmed) return

    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const field = current[fieldKey] as MetadataFieldState<any>
      const original = String(field.selected || '')

      const updatedField: MetadataFieldState<any> = {
        ...field,
        selected: fieldKey === 'year' ? parseInt(trimmed, 10) || undefined : trimmed,
        userOverridden: true,
        source: 'manual_override',
        requiresHumanReview: false,
      }

      // If user corrected an artist or composer spelling, teach behavioral learning engine!
      if ((fieldKey === 'albumArtist' || fieldKey === 'composer') && original && original !== trimmed) {
        const cat = fieldKey === 'albumArtist' ? 'artist' : 'composer'
        behavioralLearningService.teachRule(original, trimmed, cat)
        setLearnedRules(behavioralLearningService.getLearnedRules())
        showToast(`Learned convention: "${original}" ➔ "${trimmed}"`)
      }

      next.set(selectedAlbum.id, {
        ...current,
        [fieldKey]: updatedField,
      })
      return next
    })

    setEditingFieldKey(null)
  }

  // Select source for track vocalists
  const handleSelectTrackArtist = (trackId: string, artists: string, source: any) => {
    if (!selectedAlbum) return
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const updatedTracks = current.tracks.map((t) => {
        if (t.trackId !== trackId) return t
        return {
          ...t,
          matchedArtists: artists,
          source: source || 'single_provider_match',
          requiresHumanReview: false,
        }
      })

      next.set(selectedAlbum.id, { ...current, tracks: updatedTracks })
      return next
    })
  }

  // Save manual track edit
  const handleSaveManualTrack = (trackId: string, field: 'title' | 'artists') => {
    if (!selectedAlbum) return
    const trimmed = trackEditValue.trim()
    if (!trimmed) return

    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const updatedTracks = current.tracks.map((t) => {
        if (t.trackId !== trackId) return t
        const orig = field === 'title' ? t.matchedTitle : t.matchedArtists
        if (field === 'artists' && orig && orig !== trimmed) {
          behavioralLearningService.teachRule(orig, trimmed, 'artist')
          setLearnedRules(behavioralLearningService.getLearnedRules())
        }
        return {
          ...t,
          [field === 'title' ? 'matchedTitle' : 'matchedArtists']: trimmed,
          userOverridden: true,
          source: 'manual_override',
          requiresHumanReview: false,
        }
      })

      next.set(selectedAlbum.id, { ...current, tracks: updatedTracks })
      return next
    })

    setEditingTrack(null)
    showToast(`Saved track ${field}`)
  }

  // Bulk adopt provider for all tracks
  const handleAdoptAllTracks = (source: 'apple' | 'musicbrainz' | 'ai' | 'local') => {
    if (!selectedAlbum) return
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const updatedTracks = current.tracks.map((t) => {
        let val = t.localArtists
        if (source === 'apple' && current.albumArtist.apple) val = current.albumArtist.apple
        if (source === 'musicbrainz' && current.albumArtist.musicbrainz) val = current.albumArtist.musicbrainz
        if (source === 'ai' && current.albumArtist.ai) val = current.albumArtist.ai

        return {
          ...t,
          matchedArtists: val || t.localArtists,
          source: source === 'local' ? 'local_fallback' : 'single_provider_match',
          requiresHumanReview: false,
        }
      })

      next.set(selectedAlbum.id, { ...current, tracks: updatedTracks })
      return next
    })
    showToast(`Adopted ${source.toUpperCase()} for all tracks`)
  }

  // Steer Providers & Ground AI handler
  const handleFetchAndAnchor = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!selectedAlbum || !selectedAlbum.rawRelease) return

    setIsSteeringLoading(true)
    showToast(`Searching providers for "${steerAlbum || selectedAlbum.currentTitle}"...`)

    try {
      let aiMasterResult: any = undefined

      // 1. If user supplied a grounding URL or custom search, call compilationCanonicalizerService
      if (steerGroundingUrl.trim() || steerAlbum.trim()) {
        try {
          const canonicalRes = await compilationCanonicalizerService.resolveCompilationSoundtracks(
            selectedAlbum.rawRelease,
            selectedAlbum.rawTracks,
            releases,
            {
              referenceUrl: steerGroundingUrl.trim() || undefined,
              userSearchQuery: steerAlbum.trim() || undefined,
            }
          )

          if (canonicalRes && canonicalRes.success && canonicalRes.tracks && canonicalRes.tracks.length > 0) {
            const firstProp = canonicalRes.tracks[0]
            aiMasterResult = {
              releaseTitle: isCompilationAlbum ? (steerAlbum.trim() || selectedAlbum.rawRelease.title) : (firstProp?.proposedOriginalAlbum || steerAlbum.trim()),
              artistCredit: firstProp?.proposedComposer || steerArtist.trim(),
              composer: firstProp?.proposedComposer || steerArtist.trim(),
              releaseYear: firstProp?.proposedYear || (Number(steerYear) || undefined),
              genre: `${detectedLanguage} Film Soundtrack`,
              tracks: canonicalRes.tracks.map((pt, idx) => ({
                trackNumber: idx + 1,
                trackName: pt.proposedTitle || pt.localTitle,
                artistName: pt.proposedSingers || pt.proposedArtist,
              })),
            }
          }
        } catch (aiErr) {
          console.warn('[UnifiedCurateCockpit] AI Grounding note:', aiErr)
        }
      }

      // 2. If user gave an Apple Music URL, directly resolve the authentic Apple Music album & tracklist
      let directAppleMaster: any = null
      if (steerGroundingUrl.includes('music.apple.com') || steerGroundingUrl.includes('itunes.apple.com')) {
        directAppleMaster = await resolveDirectAppleMusicCandidate(steerGroundingUrl, steerAlbum, steerArtist)
      }

      const directAppleCandidate: any = directAppleMaster ? {
        provider: 'itunes',
        confidenceScore: 0.99,
        releaseTitle: directAppleMaster.releaseTitle,
        trackTitle: directAppleMaster.tracks[0]?.trackName || '',
        artistCredit: directAppleMaster.artistCredit,
        composer: directAppleMaster.composer,
        releaseYear: directAppleMaster.releaseYear,
        catalogNumber: '',
        label: 'Apple Music Catalog',
        barcodeUpc: '',
        coverArtUrl: directAppleMaster.coverArtUrl,
        coverResolution: '3000x3000px (Apple Music Master Scan)',
        genre: directAppleMaster.genre,
        tracks: directAppleMaster.tracks.map((t: any) => ({
          trackNumber: t.trackNumber,
          trackName: t.trackName,
          artistName: t.artistName || '',
        })),
      } : null

      // 3. Build steered release for federated provider resolution
      const steeredRelease: Release = {
        ...selectedAlbum.rawRelease,
        title: directAppleMaster?.releaseTitle || steerAlbum.trim() || selectedAlbum.rawRelease.title,
        artistCredit: directAppleMaster?.artistCredit || steerArtist.trim() || selectedAlbum.rawRelease.artistCredit,
        composerName: directAppleMaster?.composer || steerArtist.trim() || selectedAlbum.rawRelease.composerName,
        releaseYear: directAppleMaster?.releaseYear || Number(steerYear) || selectedAlbum.rawRelease.releaseYear,
      }

      const consensus = await federatedResolversService.resolve2of3ReleaseConsensus(
        steeredRelease,
        selectedAlbum.rawTracks,
        false,
        aiMasterResult,
        directAppleCandidate
      )

      // 3. Update album state with fresh candidates and grounded results
      setAlbumItems((prev) => {
        const next = new Map(prev)
        const current = next.get(selectedAlbum.id)
        if (!current) return prev

        const updated: AlbumWorkItem = {
          ...current,
          confidenceScore: consensus.confidenceScore || current.confidenceScore,
          offsetApplied: consensus.sequenceOffsetResult?.isConfidentOffset
            ? consensus.sequenceOffsetResult.detectedOffset
            : current.offsetApplied,
          albumTitle: consensus.albumFieldStates?.albumTitle || current.albumTitle,
          albumArtist: consensus.albumFieldStates?.albumArtist || current.albumArtist,
          composer: consensus.albumFieldStates?.composer || current.composer,
          year: consensus.albumFieldStates?.releaseYear || current.year,
          genre: consensus.albumFieldStates?.genre || current.genre,
          coverArt: directAppleCandidate?.coverArtUrl ? {
            ...current.coverArt,
            apple: directAppleCandidate.coverArtUrl,
            selected: current.coverArt.selected || directAppleCandidate.coverArtUrl,
          } : (consensus.albumFieldStates?.coverArt ? {
            ...current.coverArt,
            apple: consensus.albumFieldStates.coverArt.apple || current.coverArt.apple,
            musicbrainz: consensus.albumFieldStates.coverArt.musicbrainz || current.coverArt.musicbrainz,
            selected: current.coverArt.selected || consensus.albumFieldStates.coverArt.selected,
          } : current.coverArt),
          tracks: consensus.trackStates && consensus.trackStates.length > 0 ? consensus.trackStates : current.tracks,
        }

        next.set(selectedAlbum.id, updated)
        return next
      })

      showToast(`✓ Grounded providers with "${steerAlbum || steerGroundingUrl}"!`)
    } catch (err) {
      console.error('[UnifiedCurateCockpit] Fetch & Anchor error:', err)
      showToast('⚠️ Failed to re-query providers. Check search inputs.')
    } finally {
      setIsSteeringLoading(false)
    }
  }

  // Dynamically detect album language based on tags, file path, and title
  const detectedLanguage = useMemo(() => {
    if (!selectedAlbum) return 'Hindi'
    return detectLanguage({
      title: selectedAlbum.albumTitle?.selected || selectedAlbum.currentTitle,
      artistCredit: selectedAlbum.albumArtist?.selected,
      composerName: selectedAlbum.composer?.selected,
      genreTags: selectedAlbum.genre?.selected
        ? [selectedAlbum.genre.selected]
        : (selectedAlbum.genre?.local ? [selectedAlbum.genre.local] : (selectedAlbum.rawRelease?.genreTags || [])),
      filePath: selectedAlbum.rawTracks?.[0]?.filePath,
    }) || 'Hindi'
  }, [selectedAlbum])

  // Compilation album detection heuristic
  const isCompilationAlbum = useMemo(() => {
    if (!selectedAlbum) return false
    const rel = selectedAlbum.rawRelease
    const g = (selectedAlbum.genre?.selected || '').toLowerCase()
    const t = (selectedAlbum.albumTitle?.selected || selectedAlbum.currentTitle || '').toLowerCase()
    return Boolean(
      rel?.isCompilation ||
      g.includes('compilation') ||
      /\b(hits\s+of|best\s+of|golden\s+hits|anthology|collection|classics)\b/i.test(t) ||
      selectedAlbum.rawTracks.some(trk => trk.isCompilation || /\(from\s+["'][^"']+["']\)/i.test(trk.title))
    )
  }, [selectedAlbum])

  // Automatic debounced compilation provenance resolution (500ms, playback guarded, parameter-hashed cache)
  useEffect(() => {
    if (!selectedAlbum || !isCompilationAlbum) return

    // Transport Invariant: Defer inference if audio is actively playing or in post-playback cooldown
    if (isPlaying) {
      console.log('[UnifiedCurateCockpit] Audio playback active; deferring provenance inference')
      return
    }

    // Abort previous in-flight request if user switched albums
    if (provenanceAbortRef.current) {
      provenanceAbortRef.current.abort()
      provenanceAbortRef.current = null
    }

    const controller = new AbortController()
    provenanceAbortRef.current = controller

    const timer = setTimeout(async () => {
      try {
        const albumTitleStr = selectedAlbum.albumTitle?.selected || selectedAlbum.currentTitle
        const albumArtistStr = selectedAlbum.albumArtist?.selected || ''
        const composerStr = selectedAlbum.composer?.selected || ''

        const hashKey = await provenanceCacheService.computeHashKey(
          albumTitleStr,
          albumArtistStr,
          composerStr,
          selectedAlbum.rawTracks
        )

        // 1. Check SQLite / memory cache first
        const cached = await provenanceCacheService.get(hashKey)
        if (cached && Array.isArray(cached.tracks) && cached.tracks.length > 0) {
          setAlbumItems(prev => {
            const next = new Map(prev)
            const cur = next.get(selectedAlbum.id)
            if (!cur) return prev
            const updatedTracks = cur.tracks.map(tState => {
              const match = cached.tracks.find(ct => ct.trackId === tState.trackId || ct.trackNumber === tState.trackNumber)
              if (match && match.originalAlbum) {
                return {
                  ...tState,
                  originalAlbum: tState.userOverridden ? tState.originalAlbum : match.originalAlbum,
                  originalYear: tState.userOverridden ? tState.originalYear : match.originalYear,
                  provenanceSource: (tState.userOverridden ? 'user_override' : 'consensus') as any,
                  aiTitle: match.title,
                  aiArtists: match.primaryVocalists || match.canonicalComposer,
                }
              }
              return tState
            })
            next.set(selectedAlbum.id, {
              ...cur,
              albumTitle: { ...cur.albumTitle, ai: albumTitleStr },
              albumArtist: { ...cur.albumArtist, ai: albumArtistStr || cur.albumArtist.selected },
              composer: { ...cur.composer, ai: composerStr || cur.composer.selected },
              year: { ...cur.year, ai: cur.year.selected },
              genre: { ...cur.genre, ai: `${detectedLanguage} Film Soundtrack` },
              tracks: updatedTracks,
            })
            return next
          })
          return
        }

        // 2. Cache miss: initiate single-pass Gemini call via DPAPI backend
        setIsResolvingProvenance(true)
        const payload = {
          albumTitle: albumTitleStr,
          artistCredit: albumArtistStr,
          composerName: composerStr,
          tracks: selectedAlbum.rawTracks.map(t => ({
            id: t.id,
            trackNumber: t.trackNumber || 1,
            title: t.title,
            duration: t.duration || t.durationSeconds,
            artists: t.artistCredit,
          }))
        }

        const result: any = await resolveGemini('compilation', payload, controller.signal)
        const rawTracks = Array.isArray(result) ? result : (Array.isArray(result?.tracks) ? result.tracks : [])
        if (rawTracks.length > 0) {
          const provenanceResult: CompilationProvenanceResult = {
            albumTitle: albumTitleStr,
            isCompilation: true,
            cached: false,
            tracks: rawTracks.map((rt: any, idx: number) => ({
              trackId: rt.trackId || rt.id || selectedAlbum.rawTracks[idx]?.id || `trk-${idx}`,
              trackNumber: rt.trackNumber || (idx + 1),
              title: rt.title || selectedAlbum.rawTracks[idx]?.title || '',
              originalAlbum: rt.originalAlbum || rt.proposedOriginalAlbum || rt.movie || '',
              originalYear: rt.originalYear || rt.proposedOriginalYear || rt.year,
              confidence: rt.confidence || 0.9,
              reasoning: rt.reasoning || rt.notes,
              primaryVocalists: rt.primaryVocalists || rt.singers || rt.artists,
              canonicalComposer: rt.canonicalComposer || rt.composer,
            }))
          }

          // Save to parameter-hashed cache
          await provenanceCacheService.set(hashKey, selectedAlbum.id, albumTitleStr, payload, provenanceResult)

          // Update tracks and Gemini AI Master column in UI state
          setAlbumItems(prev => {
            const next = new Map(prev)
            const cur = next.get(selectedAlbum.id)
            if (!cur) return prev
            const updatedTracks = cur.tracks.map(tState => {
              const match = provenanceResult.tracks.find(ct => ct.trackId === tState.trackId || ct.trackNumber === tState.trackNumber)
              if (match && match.originalAlbum) {
                return {
                  ...tState,
                  originalAlbum: tState.userOverridden ? tState.originalAlbum : match.originalAlbum,
                  originalYear: tState.userOverridden ? tState.originalYear : match.originalYear,
                  provenanceSource: (tState.userOverridden ? 'user_override' : 'gemini_ai') as any,
                  aiTitle: match.title,
                  aiArtists: match.primaryVocalists || match.canonicalComposer,
                }
              }
              return tState
            })
            next.set(selectedAlbum.id, {
              ...cur,
              albumTitle: { ...cur.albumTitle, ai: albumTitleStr },
              albumArtist: { ...cur.albumArtist, ai: albumArtistStr || cur.albumArtist.selected },
              composer: { ...cur.composer, ai: composerStr || cur.composer.selected },
              year: { ...cur.year, ai: cur.year.selected },
              genre: { ...cur.genre, ai: `${detectedLanguage} Film Soundtrack` },
              tracks: updatedTracks,
            })
            return next
          })
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.warn('[UnifiedCurateCockpit] Provenance inference note:', err)
        }
      } finally {
        setIsResolvingProvenance(false)
      }
    }, 500)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [selectedAlbum?.id, isCompilationAlbum, isPlaying])

  // Manual edit handler for track provenance
  const handleSaveProvenance = useCallback((trackId: string) => {
    setAlbumItems(prev => {
      const next = new Map(prev)
      if (!selectedAlbum) return prev
      const cur = next.get(selectedAlbum.id)
      if (!cur) return prev
      const updatedTracks = cur.tracks.map(t => {
        if (t.trackId === trackId) {
          return {
            ...t,
            originalAlbum: provenanceEditFilm.trim(),
            originalYear: provenanceEditYear.trim() ? parseInt(provenanceEditYear.trim(), 10) : undefined,
            provenanceSource: 'user_override' as any,
            userOverridden: true,
          }
        }
        return t
      })
      next.set(selectedAlbum.id, { ...cur, tracks: updatedTracks })
      return next
    })
    setEditingProvenanceTrackId(null)
  }, [selectedAlbum, provenanceEditFilm, provenanceEditYear])

  // Stage Album: saves state, keeps in queue with 'staged' badge, and advances
  const handleStage = useCallback(() => {
    if (!selectedAlbum) return

    // 1. Mark as staged in local state so changes are strictly preserved
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (current) {
        next.set(selectedAlbum.id, {
          ...current,
          status: 'staged',
          userOverridden: true,
        })
      }
      return next
    })

    // 2. Save sidecar in memory via graphEngine
    for (const trk of selectedAlbum.tracks) {
      graphEngine.updateTrackSidecar(trk.trackId, {
        title: trk.matchedTitle,
        artistCredit: trk.matchedArtists,
        albumTitle: selectedAlbum.albumTitle.selected,
        composerName: selectedAlbum.composer.selected,
        releaseYear: selectedAlbum.year.selected,
        genre: selectedAlbum.genre.selected,
        originalAlbum: trk.originalAlbum,
        originalYear: trk.originalYear,
      })
    }

    showToast(`✓ Staged "${selectedAlbum.albumTitle.selected}". Saved for review in queue.`)

    // 3. Advance to next album in queue
    const activeList = (activeTier === 'tier1' ? tier1Items : tier2Items).filter(a => a.status !== 'committed')
    const currIdx = activeList.findIndex((a) => a.id === selectedAlbum.id)
    if (currIdx >= 0 && currIdx < activeList.length - 1) {
      setSelectedAlbumId(activeList[currIdx + 1].id)
    }
  }, [selectedAlbum, activeTier, tier1Items, tier2Items, showToast])

  // Commit Album: permanently writes to disk and REMOVES it from the queue
  const handleCommitAlbum = useCallback(async () => {
    if (!selectedAlbum) return

    // Audiophile Transport Guard
    if (isPlaying) {
      showToast('⚠️ Storage Bus Silence: Playback active. Disk writes are paused until audio pauses.')
      return
    }

    // 1. Commit edits into graphEngine sidecars
    for (const trk of selectedAlbum.tracks) {
      graphEngine.updateTrackSidecar(trk.trackId, {
        title: trk.matchedTitle,
        artistCredit: trk.matchedArtists,
        albumTitle: selectedAlbum.albumTitle.selected,
        composerName: selectedAlbum.composer.selected,
        releaseYear: selectedAlbum.year.selected,
        genre: selectedAlbum.genre.selected,
      })
    }

    // 2. Physical flush to disk via tauriBridge
    try {
      await tauriBridge.commitStagedSidecars()
    } catch (err) {
      console.warn('[UnifiedCurateCockpit] Commit notice:', err)
    }

    // 3. Mark as committed in state so it is removed from active review queue
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (current) {
        next.set(selectedAlbum.id, {
          ...current,
          status: 'committed',
        })
      }
      return next
    })

    onRefreshLibrary?.()
    showToast(`✓ Committed "${selectedAlbum.albumTitle.selected}" to library and removed from queue!`)

    // 4. Advance to next remaining album
    const remaining = tier2Items.filter((a) => a.id !== selectedAlbum.id && a.status !== 'committed')
    if (remaining.length > 0) {
      setSelectedAlbumId(remaining[0].id)
    } else {
      setSelectedAlbumId(null)
    }
  }, [selectedAlbum, isPlaying, tier2Items, onRefreshLibrary, showToast])

  // Batch commit Tier 1 albums in background with Audiophile Guard
  const handleCommitAllTier1 = async () => {
    if (tier1Items.length === 0) return

    // Audiophile Transport Guard: Check if music is playing
    if (isPlaying) {
      showToast('⚠️ Storage Bus Silence: Playback active. Batch writes will start once audio pauses.')
      return
    }

    setIsBatchCommitting(true)
    setCommitProgress({ current: 0, total: tier1Items.length })

    let processed = 0
    for (const alb of tier1Items) {
      // Stage each album's tracks
      for (const trk of alb.tracks) {
        graphEngine.updateTrackSidecar(trk.trackId, {
          title: trk.matchedTitle,
          artistCredit: trk.matchedArtists,
          albumTitle: alb.albumTitle.selected,
          composerName: alb.composer.selected,
          releaseYear: alb.year.selected,
          genre: alb.genre.selected,
        })
      }

      processed++
      setCommitProgress({ current: processed, total: tier1Items.length })
      await new Promise((r) => setTimeout(r, 60)) // Yield to event loop
    }

    // Trigger physical sidecar flush via tauriBridge
    try {
      await tauriBridge.commitStagedSidecars()
    } catch (err) {
      console.warn('[UnifiedCurateCockpit] Sidecar commit note:', err)
    }

    setIsBatchCommitting(false)
    setCommitProgress(null)
    onRefreshLibrary?.()
    showToast(`✓ Successfully committed all ${tier1Items.length} Tier 1 albums!`)
  }

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault()
        const currentIdx = tier2Items.findIndex((a) => a.id === selectedAlbumId)
        if (currentIdx > 0) setSelectedAlbumId(tier2Items[currentIdx - 1].id)
      } else if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault()
        const currentIdx = tier2Items.findIndex((a) => a.id === selectedAlbumId)
        if (currentIdx < tier2Items.length - 1) setSelectedAlbumId(tier2Items[currentIdx + 1].id)
      } else if (e.key === 'Escape') {
        if (isRulesModalOpen) setIsRulesModalOpen(false)
        else if (isHealthDrawerOpen) setIsHealthDrawerOpen(false)
        else onBackToLibrary()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedAlbumId, tier2Items, isRulesModalOpen, isHealthDrawerOpen, onBackToLibrary])

  // Row Renderer: Album Text Field
  const renderFieldRow = (
    fieldKey: 'albumTitle' | 'albumArtist' | 'composer' | 'year' | 'genre',
    label: string,
    fieldState: MetadataFieldState<any>
  ) => {
    const isEditing = editingFieldKey === fieldKey
    const selectedVal = fieldState.selected

    return (
      <tr key={fieldKey} className="hover:bg-white/[0.015] transition-colors">
        <td className="py-2.5 px-4 font-medium text-white/70">{label}</td>

        {/* Local */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'local')}
          className={`py-2.5 px-4 cursor-pointer transition-colors ${
            fieldState.source === 'local_fallback' ? 'bg-white/[0.04] text-white font-medium' : 'text-white/60 hover:text-white'
          }`}
        >
          {String(fieldState.local ?? '—')}
        </td>

        {/* Apple */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'apple')}
          className="py-2.5 px-4 cursor-pointer text-white/70 hover:text-[#D4AF37] transition-colors"
        >
          {String(fieldState.apple ?? '—')}
        </td>

        {/* MusicBrainz */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'musicbrainz')}
          className="py-2.5 px-4 cursor-pointer text-white/60 hover:text-white transition-colors"
        >
          {String(fieldState.musicbrainz ?? '—')}
        </td>

        {/* Gemini AI */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'ai')}
          className="py-2.5 px-4 cursor-pointer text-white/70 hover:text-cyan-300 transition-colors"
        >
          {String(fieldState.ai ?? '—')}
        </td>

        {/* Selected Output */}
        <td className="py-2.5 px-4 bg-emerald-500/[0.03] border-l border-white/[0.06]">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editInputValue}
                onChange={(e) => setEditInputValue(e.target.value)}
                className="flex-1 bg-black/60 border border-emerald-400 rounded px-2 py-1 text-xs text-white focus:outline-none"
                autoFocus
              />
              <button
                onClick={() => handleSaveManualField(fieldKey)}
                className="p-1 rounded bg-emerald-500 text-black cursor-pointer"
                title="Save"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setEditingFieldKey(null)}
                className="p-1 rounded bg-white/[0.08] text-white/60 cursor-pointer"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 group">
              {selectedVal !== '' && selectedVal !== undefined ? (
                <span className="font-semibold text-emerald-300 truncate">{String(selectedVal)}</span>
              ) : (
                <span className="text-[11px] text-amber-300 font-medium">
                  ⚠️ Action Required (No Consensus)
                </span>
              )}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => {
                    setEditingFieldKey(fieldKey)
                    setEditInputValue(String(selectedVal || ''))
                  }}
                  className="p-1 rounded hover:bg-white/[0.08] text-white/60 hover:text-white transition-colors cursor-pointer"
                  title="Edit manually"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </td>
      </tr>
    )
  }

  // Row Renderer: Artwork Row
  const renderArtworkRow = (fieldState: MetadataFieldState<string>) => {
    const isEditing = editingFieldKey === 'coverArt'

    return (
      <tr className="hover:bg-white/[0.015] transition-colors">
        <td className="py-3 px-4 font-medium text-white/70">Cover Artwork</td>

        {/* Local */}
        <td onClick={() => handleSelectFieldSource('coverArt', 'local')} className="py-3 px-4 cursor-pointer">
          {fieldState.local ? (
            <img src={fieldState.local} alt="Local Art" className="w-12 h-12 rounded object-cover shadow" />
          ) : (
            <div className="w-10 h-10 rounded border border-white/10 bg-black/40 flex items-center justify-center text-white/30 text-[10px]">
              None
            </div>
          )}
        </td>

        {/* Apple */}
        <td onClick={() => handleSelectFieldSource('coverArt', 'apple')} className="py-3 px-4 cursor-pointer">
          {fieldState.apple ? (
            <div className="p-0.5 rounded-lg w-fit">
              <img src={fieldState.apple} alt="Apple Art" className="w-12 h-12 rounded object-cover shadow" />
              <span className="text-[9px] text-[#D4AF37] block mt-1">3000px HD</span>
            </div>
          ) : (
            <span className="text-white/40 text-xs">—</span>
          )}
        </td>

        {/* MusicBrainz */}
        <td onClick={() => handleSelectFieldSource('coverArt', 'musicbrainz')} className="py-3 px-4 cursor-pointer">
          {fieldState.musicbrainz ? (
            <div className="p-0.5 rounded-lg w-fit">
              <img src={fieldState.musicbrainz} alt="MB Art" className="w-12 h-12 rounded object-cover shadow opacity-70" />
              <span className="text-[9px] text-white/50 block mt-1">CAA</span>
            </div>
          ) : (
            <span className="text-white/40 text-xs">—</span>
          )}
        </td>

        {/* Gemini AI */}
        <td onClick={() => handleSelectFieldSource('coverArt', 'ai')} className="py-3 px-4 cursor-pointer">
          {fieldState.ai ? (
            <div className="p-0.5 rounded-lg w-fit">
              <img src={fieldState.ai} alt="AI Art" className="w-12 h-12 rounded object-cover shadow" />
              <span className="text-[9px] text-cyan-300 block mt-1">AI Verified</span>
            </div>
          ) : (
            <span className="text-white/40 text-xs">—</span>
          )}
        </td>

        {/* Selected Artwork */}
        <td className="py-3 px-4 bg-emerald-500/[0.03] border-l border-white/[0.06]">
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={editInputValue}
                onChange={(e) => setEditInputValue(e.target.value)}
                placeholder="Paste Image URL (https://...)"
                className="bg-black/60 border border-emerald-400 rounded px-2.5 py-1 text-xs text-white focus:outline-none"
                autoFocus
              />
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => handleSaveManualField('coverArt')}
                  className="px-2.5 py-0.5 rounded bg-emerald-500 text-black font-semibold text-[11px] cursor-pointer"
                >
                  Save URL
                </button>
                <button
                  onClick={() => setEditingFieldKey(null)}
                  className="px-2.5 py-0.5 rounded bg-white/[0.08] text-white/60 text-[11px] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 group">
              {fieldState.selected ? (
                <img
                  src={fieldState.selected}
                  alt="Selected Art"
                  className="w-14 h-14 rounded-lg object-cover border-2 border-emerald-500/60 shadow-lg"
                />
              ) : (
                <div className="w-14 h-14 rounded-lg border-2 border-dashed border-amber-400/40 flex items-center justify-center text-amber-300 text-[10px] text-center p-1">
                  No Art
                </div>
              )}
              <div>
                <button
                  onClick={() => {
                    setEditingFieldKey('coverArt')
                    setEditInputValue(fieldState.selected || '')
                  }}
                  className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white cursor-pointer"
                >
                  <Edit2 className="w-3 h-3" />
                  <span>Custom URL</span>
                </button>
              </div>
            </div>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="flex-1 h-full min-h-0 bg-[#0E0F12] text-[#F3F4F6] flex flex-col font-sans select-none overflow-hidden">
      {/* 1. Header Navigation Bar */}
      <header className="h-14 border-b border-white/[0.08] px-6 flex items-center justify-between shrink-0 bg-[#121318]/90 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <button
            onClick={onReturnToAnchor || onBackToLibrary}
            className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white transition-colors cursor-pointer mr-1"
            title="Return to Library (Esc)"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37]">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-white">Curate & Metadata Cockpit</h1>
            <p className="text-[10px] text-white/50">Unified 2-Tier Pipeline • Audiophile Clean Transport</p>
          </div>
        </div>

        {/* Center: 2-Tier Segmented Switch */}
        <div className="flex items-center p-1 bg-black/40 rounded-xl border border-white/[0.08]">
          <button
            onClick={() => setActiveTier('tier1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
              activeTier === 'tier1'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Tier 1: Auto-Staged</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/30 text-emerald-200">
              {tier1Items.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTier('tier2')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
              activeTier === 'tier2'
                ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40 shadow-sm'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Tier 2: Guided Reconciliation</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#D4AF37]/30 text-[#D4AF37]">
              {tier2Items.length}
            </span>
          </button>
        </div>

        {/* Right Action Icons */}
        <div className="flex items-center gap-2">
          {/* Audiophile Transport Status Indicator */}
          <div
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
              isPlaying
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-white/[0.04] text-white/60 border-white/[0.08]'
            }`}
            title={isPlaying ? 'WASAPI/ASIO Playback Active (Zero Disk I/O)' : 'Audio Engine Idle'}
          >
            {isPlaying ? <Volume2 className="w-3.5 h-3.5 animate-pulse text-amber-400" /> : <Pause className="w-3.5 h-3.5" />}
            <span className="text-[11px]">{isPlaying ? 'Playing (Bus Silent)' : 'Engine Idle'}</span>
          </div>

          <button
            onClick={() => setIsHealthDrawerOpen(true)}
            className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white text-xs border border-white/[0.08] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>Health & Audit</span>
            {auditIssues.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-cyan-500/20 text-cyan-300 text-[10px]">
                {auditIssues.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setIsRulesModalOpen(true)}
            className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white text-xs border border-white/[0.08] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Learned Rules ({learnedRules.length})</span>
          </button>
        </div>
      </header>

      {/* 2. Main Body Split Deck */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Album Rail */}
        <aside className="w-72 border-r border-white/[0.08] bg-[#0A0B0E] flex flex-col shrink-0">
          <div className="p-3 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-xs font-medium text-white/70">
              {activeTier === 'tier1' ? 'Tier 1 Auto-Staged' : 'Tier 2 Pending Review'}
            </span>
            {activeTier === 'tier1' && tier1Items.length > 0 && (
              <button
                onClick={handleCommitAllTier1}
                disabled={isBatchCommitting}
                className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-[11px] cursor-pointer transition-colors shadow-sm disabled:opacity-50"
              >
                {isBatchCommitting
                  ? `Writing ${commitProgress?.current}/${commitProgress?.total}...`
                  : `Commit All (${tier1Items.length})`}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
            {(activeTier === 'tier1' ? tier1Items : tier2Items).map((alb) => (
              <div
                key={alb.id}
                onClick={() => setSelectedAlbumId(alb.id)}
                className={`p-3.5 transition-colors cursor-pointer flex gap-3 ${
                  selectedAlbum?.id === alb.id
                    ? 'bg-white/[0.08] border-l-2 border-[#D4AF37]'
                    : 'hover:bg-white/[0.03]'
                }`}
              >
                <img
                  src={alb.coverArt.selected || alb.coverArt.apple || alb.coverArt.local || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'}
                  alt={alb.currentTitle}
                  className="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0 bg-black/40"
                  onError={(e) => {
                    ;(e.target as HTMLElement).style.display = 'none'
                  }}
                />
                <div className="flex-1 min-w-0">
                  <h3 className="text-xs font-medium text-white truncate">{alb.albumTitle.selected || alb.currentTitle}</h3>
                  <p className="text-[11px] text-white/50 truncate mt-0.5">
                    {alb.albumArtist.selected || 'Requires Review'} • {alb.year.selected || '—'}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.06] text-white/60">
                      {alb.tracks.length} tracks
                    </span>
                    {alb.offsetApplied !== undefined && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#D4AF37]/20 text-[#D4AF37] font-mono">
                        +{alb.offsetApplied} offset
                      </span>
                    )}
                    {alb.userOverridden && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-medium">
                        ✓ Staged
                      </span>
                    )}
                    {alb.albumArtist.requiresHumanReview && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-medium">
                        Action Req.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {(activeTier === 'tier1' ? tier1Items : tier2Items).length === 0 && (
              <div className="p-8 text-center text-white/40 text-xs">
                No albums in {activeTier === 'tier1' ? 'Tier 1' : 'Tier 2'}
              </div>
            )}
          </div>
        </aside>

        {/* Center Reconciliation Workbench */}
        {selectedAlbum ? (
          <main className="flex-1 flex flex-col bg-[#0E0F12] overflow-y-auto p-6 space-y-6 pb-48">
            {/* Status bar when resolving compilation provenance */}
            {isResolvingProvenance && (
              <div className="flex items-center justify-between px-3.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 animate-in fade-in duration-200">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  <span>✦ Identifying source soundtracks and release years via Gemini...</span>
                </div>
                <button
                  onClick={() => {
                    if (provenanceAbortRef.current) {
                      provenanceAbortRef.current.abort()
                      provenanceAbortRef.current = null
                      setIsResolvingProvenance(false)
                    }
                  }}
                  className="px-2 py-0.5 rounded bg-white/[0.08] hover:bg-white/[0.15] text-white/70 text-[10px] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Header for Active Album */}
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-white/[0.06] text-white/60 uppercase">
                  {selectedAlbum.folderName}
                </span>
                <span className="text-xs text-white/40">•</span>
                <span className="text-xs text-[#D4AF37] font-medium flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>
                    {selectedAlbum.tier === 'tier1' ? 'Tier 1 Auto-Staged' : 'Tier 2 Guided 4-Way Reconciliation Table'}
                  </span>
                </span>
              </div>

              <div className="flex items-center gap-2.5">
                {/* Re-Query / Paste Store Link Button */}
                <button
                  onClick={() => setIsReQueryOpen(!isReQueryOpen)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 cursor-pointer ${
                    isReQueryOpen
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-sm'
                      : 'bg-white/[0.06] hover:bg-white/[0.1] text-white/80 border-white/10'
                  }`}
                  title="Toggle Steer Providers and AI Grounding bar"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>{isReQueryOpen ? 'Hide Query' : 'Re-Query / Paste Store Link'}</span>
                </button>

                {/* Stage Button (keeps in queue, preserves all changes) */}
                <button
                  onClick={handleStage}
                  className="px-3.5 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-white font-medium text-xs border border-white/20 transition-all cursor-pointer flex items-center gap-1.5"
                  title="Save changes and keep in queue for later review"
                >
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Stage & Next</span>
                </button>

                {/* Commit Button (saves permanently and removes from queue) */}
                <button
                  onClick={handleCommitAlbum}
                  className="px-4 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#c29e2f] text-black font-semibold text-xs transition-colors cursor-pointer shadow-md flex items-center gap-1.5"
                  title="Commit permanently to library and remove from queue"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Commit Album</span>
                </button>
              </div>
            </div>

            {/* Steer Providers & AI Grounding Bar */}
            {isReQueryOpen && (
              <form
                onSubmit={handleFetchAndAnchor}
                className="p-3 rounded-xl bg-black/60 border border-cyan-500/30 flex flex-wrap items-center gap-2.5 shadow-xl transition-all"
              >
                <div className="flex items-center gap-1.5 text-cyan-400 font-medium text-xs shrink-0">
                  <Search className="w-3.5 h-3.5" />
                  <span>Steer Providers:</span>
                </div>

                {/* Album Input */}
                <div className="relative w-40">
                  <input
                    type="text"
                    value={steerAlbum}
                    onChange={(e) => setSteerAlbum(e.target.value)}
                    placeholder="Album Title"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-white text-xs focus:outline-none focus:border-[#D4AF37]/60"
                  />
                  <span className="absolute right-2 top-2 text-[9px] font-mono text-white/40 pointer-events-none uppercase">Album</span>
                </div>

                {/* Artist / Composer Input */}
                <div className="relative w-40">
                  <input
                    type="text"
                    value={steerArtist}
                    onChange={(e) => setSteerArtist(e.target.value)}
                    placeholder="Artist / Composer"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-white text-xs focus:outline-none focus:border-[#D4AF37]/60"
                  />
                  <span className="absolute right-2 top-2 text-[9px] font-mono text-white/40 pointer-events-none uppercase">Artist</span>
                </div>

                {/* Year Input */}
                <div className="relative w-24">
                  <input
                    type="text"
                    value={steerYear}
                    onChange={(e) => setSteerYear(e.target.value)}
                    placeholder="Year"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-white text-xs focus:outline-none focus:border-[#D4AF37]/60"
                  />
                  <span className="absolute right-2 top-2 text-[9px] font-mono text-white/40 pointer-events-none uppercase">Year</span>
                </div>

                <span className="text-xs text-white/40 font-medium">or</span>

                {/* Grounding URL Input */}
                <div className="relative flex-1 min-w-[260px]">
                  <input
                    type="url"
                    value={steerGroundingUrl}
                    onChange={(e) => setSteerGroundingUrl(e.target.value)}
                    placeholder="Paste Apple Music / Discogs / MusicBrainz URL for AI Grounding..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-white placeholder:text-white/40 text-xs focus:outline-none focus:border-cyan-400/60"
                  />
                  <Link2 className="w-3.5 h-3.5 text-cyan-400 absolute left-2.5 top-2.5 pointer-events-none" />
                </div>

                {/* Fetch & Anchor Button */}
                <button
                  type="submit"
                  disabled={isSteeringLoading || (!steerAlbum.trim() && !steerGroundingUrl.trim())}
                  className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-md shadow-cyan-500/20 disabled:opacity-50 transition-all shrink-0"
                >
                  {isSteeringLoading ? (
                    <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  <span>Fetch & Anchor</span>
                </button>
              </form>
            )}

            {/* Interactive Learned Rule Confirmation Banners */}
            {selectedAlbum.composer.selected &&
              selectedAlbum.albumArtist.selected !== selectedAlbum.composer.selected &&
              !dismissedPrompts.has('prompt_composer_artist') && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between animate-fade-in shadow-md">
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-[#D4AF37] shrink-0" />
                    <div>
                      <span className="text-xs font-semibold text-white">Indian Soundtrack Rule:</span>{' '}
                      <span className="text-xs text-white/80">
                        Set Album Artist equal to Composer (<strong>{selectedAlbum.composer.selected}</strong>)?
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setAlbumItems((prev) => {
                          const next = new Map(prev)
                          const curr = next.get(selectedAlbum.id)
                          if (curr) {
                            next.set(selectedAlbum.id, {
                              ...curr,
                              albumArtist: { ...curr.albumArtist, selected: curr.composer.selected, userOverridden: true },
                            })
                          }
                          return next
                        })
                        behavioralLearningService.updateConventions({ albumArtistEqualsComposerForIndianSoundtracks: true })
                        setConventions(behavioralLearningService.getConventions())
                        showToast(`✓ Learned convention: Album Artist = Composer for Indian soundtracks!`)
                      }}
                      className="px-3 py-1 rounded bg-[#D4AF37] hover:bg-[#c29e2f] text-black font-semibold text-xs cursor-pointer transition-colors shadow-sm"
                    >
                      Apply & Remember Always
                    </button>
                    <button
                      onClick={() => setDismissedPrompts((prev) => new Set(prev).add('prompt_composer_artist'))}
                      className="p-1 text-white/40 hover:text-white cursor-pointer"
                      title="Dismiss prompt"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

            {(() => {
              const targetSoundtrackGenre = `${detectedLanguage} Film Soundtrack`
              const currentGenre = selectedAlbum.genre.selected || ''
              const isSoundtrackLike =
                currentGenre.toLowerCase().includes('soundtrack') ||
                currentGenre.toLowerCase().includes('film') ||
                currentGenre.toLowerCase().includes('ost') ||
                isCompilationAlbum

              if (!isSoundtrackLike || currentGenre === targetSoundtrackGenre || dismissedPrompts.has('prompt_genre')) {
                return null
              }

              return (
                <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-between animate-fade-in shadow-md">
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
                    <div>
                      <span className="text-xs font-semibold text-white">Soundtrack Genre Rule:</span>{' '}
                      <span className="text-xs text-white/80">
                        Standardize Genre as <strong>{targetSoundtrackGenre}</strong>?
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setAlbumItems((prev) => {
                          const next = new Map(prev)
                          const curr = next.get(selectedAlbum.id)
                          if (curr) {
                            next.set(selectedAlbum.id, {
                              ...curr,
                              genre: { ...curr.genre, selected: targetSoundtrackGenre, userOverridden: true },
                            })
                          }
                          return next
                        })
                        behavioralLearningService.updateConventions({
                          languagePrefixedSoundtrackGenre: true,
                          defaultSoundtrackLanguage: detectedLanguage,
                        })
                        setConventions(behavioralLearningService.getConventions())
                        showToast(`✓ Learned convention: ${targetSoundtrackGenre} genre!`)
                      }}
                      className="px-3 py-1 rounded bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs cursor-pointer transition-colors shadow-sm"
                    >
                      Apply & Remember Always
                    </button>
                    <button
                      onClick={() => setDismissedPrompts((prev) => new Set(prev).add('prompt_genre'))}
                      className="p-1 text-white/40 hover:text-white cursor-pointer"
                      title="Dismiss prompt"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )
            })()}

            {/* TABLE 1: Album-Level 4-Way Metadata Reconciliation Table */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-white/70">
                  1. Album-Level Master Metadata
                </h2>
                <span className="text-[11px] text-white/40">
                  Click any provider cell to adopt as Selected • Click <Edit2 className="w-3 h-3 inline text-white/60" /> to provide manual override
                </span>
              </div>

              <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#121318]/40 shadow-xl">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.02] text-white/40 text-[11px] font-mono">
                      <th className="py-2.5 px-4 w-32">Field</th>
                      <th className="py-2.5 px-4 w-1/5">Local File Tag</th>
                      <th className="py-2.5 px-4 w-1/5 text-[#D4AF37]">Apple Music Master</th>
                      <th className="py-2.5 px-4 w-1/5">MusicBrainz Archive</th>
                      <th className="py-2.5 px-4 w-1/5 text-cyan-400">Gemini AI Master</th>
                      <th className="py-2.5 px-4 w-1/4 text-emerald-400 font-semibold bg-emerald-500/[0.03]">Selected Output</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {/* Album Title */}
                    {renderFieldRow('albumTitle', 'Album Title', selectedAlbum.albumTitle)}
                    {/* Album Artist */}
                    {renderFieldRow('albumArtist', 'Album Artist', selectedAlbum.albumArtist)}
                    {/* Composer */}
                    {renderFieldRow('composer', 'Composer', selectedAlbum.composer)}
                    {/* Release Year */}
                    {renderFieldRow('year', 'Release Year', selectedAlbum.year)}
                    {/* Cover Art */}
                    {renderArtworkRow(selectedAlbum.coverArt)}
                    {/* Genre */}
                    {renderFieldRow('genre', 'Genre', selectedAlbum.genre)}
                  </tbody>
                </table>
              </div>
            </section>

            {/* TABLE 2: Track-Level 4-Way Metadata Reconciliation Table */}
            <section className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-white/70">
                    2. Track-Level Metadata & Performers
                  </h2>
                  {selectedAlbum.offsetApplied !== undefined && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-[#D4AF37]/20 text-[#D4AF37] font-mono border border-[#D4AF37]/30">
                      Sequence Offset Applied: {selectedAlbum.offsetApplied > 0 ? `+${selectedAlbum.offsetApplied}` : selectedAlbum.offsetApplied}
                    </span>
                  )}
                </div>

                {/* Bulk Adoption Actions */}
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-white/40 mr-1">Adopt Tracklist:</span>
                  <button
                    onClick={() => handleAdoptAllTracks('apple')}
                    className="px-2 py-1 rounded bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30 cursor-pointer"
                  >
                    Apple Music
                  </button>
                  <button
                    onClick={() => handleAdoptAllTracks('ai')}
                    className="px-2 py-1 rounded bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 cursor-pointer"
                  >
                    Gemini AI
                  </button>
                  <button
                    onClick={() => handleAdoptAllTracks('local')}
                    className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-white/60 border border-white/10 cursor-pointer"
                  >
                    Reset Local
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#121318]/40 shadow-xl">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.02] text-white/40 text-[11px] font-mono">
                      <th className="py-2.5 px-3 w-14">#</th>
                      <th className="py-2.5 px-3 w-1/5">Local File</th>
                      <th className="py-2.5 px-3 w-1/5 text-[#D4AF37]">Apple Music Track</th>
                      <th className="py-2.5 px-3 w-1/5">MusicBrainz Track</th>
                      <th className="py-2.5 px-3 w-1/5 text-cyan-400">Gemini AI Track</th>
                      <th className="py-2.5 px-3 w-1/4 text-emerald-400 font-semibold bg-emerald-500/[0.03]">Selected Track & Singers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {selectedAlbum.tracks.map((trk) => {
                      const isEditing = editingTrack?.trackId === trk.trackId
                      return (
                        <tr key={trk.trackId} className="hover:bg-white/[0.015] transition-colors">
                          <td className="py-3 px-3 font-mono text-white/50 text-[11px]">
                            #{trk.trackNumber}
                            {trk.sequenceOffset ? (
                              <span className="block text-[9px] text-[#D4AF37]">
                                ➔ #{trk.trackNumber - trk.sequenceOffset}
                              </span>
                            ) : null}
                          </td>

                          {/* Local Track Cell */}
                          <td
                            onClick={() => handleSelectTrackArtist(trk.trackId, trk.localArtists, 'local_fallback')}
                            className="py-3 px-3 cursor-pointer text-white/60 hover:text-white transition-colors"
                          >
                            <div className="font-medium text-white/80">{trk.localTitle}</div>
                            <div className="text-[10px] text-white/40 font-mono">{trk.localArtists || 'Unknown'}</div>
                          </td>

                          {/* Apple Music Cell */}
                          <td
                            onClick={() => {
                              if (selectedAlbum.albumArtist.apple) {
                                handleSelectTrackArtist(trk.trackId, selectedAlbum.albumArtist.apple, 'single_provider_match')
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/70 hover:text-[#D4AF37] transition-colors"
                          >
                            <div className="font-medium">{trk.matchedTitle}</div>
                            <div className="text-[10px] text-white/50 mt-0.5">
                              {selectedAlbum.albumArtist.apple || '—'}
                            </div>
                          </td>

                          {/* MusicBrainz Cell */}
                          <td
                            onClick={() => {
                              if (selectedAlbum.albumArtist.musicbrainz) {
                                handleSelectTrackArtist(trk.trackId, selectedAlbum.albumArtist.musicbrainz, 'single_provider_match')
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/60 hover:text-white transition-colors"
                          >
                            <div className="font-medium">{trk.matchedTitle}</div>
                            <div className="text-[10px] text-white/40 mt-0.5">
                              {selectedAlbum.albumArtist.musicbrainz || '—'}
                            </div>
                          </td>

                          {/* Gemini AI Cell */}
                          <td
                            onClick={() => {
                              const candArtist = trk.aiArtists || selectedAlbum.albumArtist.ai
                              if (candArtist) {
                                handleSelectTrackArtist(trk.trackId, candArtist, 'ai_synthesized')
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/70 hover:text-cyan-300 transition-colors"
                          >
                            <div className="font-medium text-cyan-300">{trk.aiTitle || trk.matchedTitle}</div>
                            <div className="text-[10px] text-cyan-200/60 mt-0.5">
                              {trk.aiArtists || selectedAlbum.albumArtist.ai || '—'}
                            </div>
                          </td>

                          {/* Selected Output Cell */}
                          <td className="py-3 px-3 bg-emerald-500/[0.03] border-l border-white/[0.06]">
                            {isEditing ? (
                              <div className="flex flex-col gap-1.5">
                                <input
                                  type="text"
                                  value={trackEditValue}
                                  onChange={(e) => setTrackEditValue(e.target.value)}
                                  className="w-full bg-black/60 border border-emerald-400 rounded px-2 py-1 text-xs text-white focus:outline-none"
                                  placeholder={`Edit ${editingTrack.field}`}
                                  autoFocus
                                />
                                <div className="flex justify-end gap-1">
                                  <button
                                    onClick={() => handleSaveManualTrack(trk.trackId, editingTrack.field)}
                                    className="px-2 py-0.5 rounded bg-emerald-500 text-black font-semibold text-[10px] cursor-pointer"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => setEditingTrack(null)}
                                    className="px-2 py-0.5 rounded bg-white/[0.08] text-white/60 text-[10px] cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="group relative">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-medium text-emerald-300">{trk.matchedTitle}</div>
                                  <button
                                    onClick={() => {
                                      setEditingTrack({ trackId: trk.trackId, field: 'title' })
                                      setTrackEditValue(trk.matchedTitle || '')
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/[0.08] rounded text-white/60 transition-opacity cursor-pointer"
                                    title="Edit Title"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                </div>
                                <div className="flex items-center justify-between gap-2 mt-0.5">
                                  {trk.matchedArtists ? (
                                    <div className="text-[11px] text-white/80">{trk.matchedArtists}</div>
                                  ) : (
                                    <span className="text-[10px] text-amber-300 font-medium">
                                      ⚠️ Requires Action (Empty)
                                    </span>
                                  )}
                                  <button
                                    onClick={() => {
                                      setEditingTrack({ trackId: trk.trackId, field: 'artists' })
                                      setTrackEditValue(trk.matchedArtists || '')
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/[0.08] rounded text-white/60 transition-opacity cursor-pointer"
                                    title="Edit Singers"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                </div>

                                {/* Progressive Disclosure Compilation Provenance Sub-Row */}
                                {isCompilationAlbum && (
                                  <div className="mt-1 pt-1 border-t border-white/[0.04]">
                                    {editingProvenanceTrackId === trk.trackId ? (
                                      <div className="flex items-center gap-1.5 w-full">
                                        <input
                                          type="text"
                                          value={provenanceEditFilm}
                                          onChange={(e) => setProvenanceEditFilm(e.target.value)}
                                          className="flex-1 bg-black/60 border border-amber-400 rounded px-1.5 py-0.5 text-[11px] text-white focus:outline-none"
                                          placeholder="Original Film / Album"
                                          autoFocus
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleSaveProvenance(trk.trackId)
                                            if (e.key === 'Escape') setEditingProvenanceTrackId(null)
                                          }}
                                        />
                                        <input
                                          type="text"
                                          value={provenanceEditYear}
                                          onChange={(e) => setProvenanceEditYear(e.target.value)}
                                          className="w-14 bg-black/60 border border-amber-400 rounded px-1.5 py-0.5 text-[11px] text-white focus:outline-none"
                                          placeholder="Year"
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleSaveProvenance(trk.trackId)
                                            if (e.key === 'Escape') setEditingProvenanceTrackId(null)
                                          }}
                                        />
                                        <button
                                          onClick={() => handleSaveProvenance(trk.trackId)}
                                          className="px-1.5 py-0.5 rounded bg-amber-400 text-black font-semibold text-[10px] cursor-pointer"
                                        >
                                          ✓
                                        </button>
                                        <button
                                          onClick={() => setEditingProvenanceTrackId(null)}
                                          className="px-1.5 py-0.5 rounded bg-white/[0.08] text-white/60 text-[10px] cursor-pointer"
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center justify-between w-full group/prov">
                                        <div className="flex items-center gap-1.5 text-[11px]">
                                          <span className="text-[#D4AF37]/80 font-mono text-[10px]">↳ Film:</span>
                                          <span className="text-white/80 font-medium">
                                            {trk.originalAlbum || <span className="text-white/40 italic">Unassigned</span>}
                                          </span>
                                          {trk.originalYear && (
                                            <span className="text-white/40 font-mono">({trk.originalYear})</span>
                                          )}
                                          {trk.provenanceSource === 'gemini_ai' && (
                                            <span className="px-1.5 py-0.2 rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono">
                                              ✦ AI
                                            </span>
                                          )}
                                        </div>
                                        <button
                                          onClick={() => {
                                            setEditingProvenanceTrackId(trk.trackId)
                                            setProvenanceEditFilm(trk.originalAlbum || '')
                                            setProvenanceEditYear(trk.originalYear ? String(trk.originalYear) : '')
                                          }}
                                          className="opacity-0 group-hover/prov:opacity-100 p-0.5 hover:bg-white/[0.08] rounded text-white/50 transition-opacity cursor-pointer"
                                          title="Edit Original Film & Year (Enter)"
                                        >
                                          <Edit2 className="w-2.5 h-2.5" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* Bottom Scrolling Breathing Room Spacer */}
              <div className="h-36 pointer-events-none" />
            </section>
          </main>
        ) : (
          <div className="flex-1 flex items-center justify-center text-white/40 text-sm">
            Select an album from the left queue to begin reconciliation
          </div>
        )}
      </div>

      {/* 3. Learned Rules Modal */}
      {isRulesModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-xl bg-[#121318] border border-white/[0.1] rounded-2xl p-6 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-[#D4AF37]" />
                <h3 className="text-sm font-semibold text-white">Learned Library Conventions</h3>
              </div>
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="text-white/40 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-white/60 mt-2">
              Cadence learns your spelling, punctuation, and initials preferences and auto-elevates matches to Tier 1.
            </p>

            {/* Automated Semantic Conventions */}
            <div className="mt-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.08] space-y-3">
              <h4 className="text-xs font-semibold text-white/80 uppercase tracking-wider">
                Automated Library Conventions
              </h4>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-white">Indian Film Soundtracks: Album Artist = Composer</div>
                  <div className="text-[11px] text-white/50">Automatically sets Album Artist to Composer (e.g. Ilaiyaraaja, A. R. Rahman)</div>
                </div>
                <input
                  type="checkbox"
                  checked={conventions.albumArtistEqualsComposerForIndianSoundtracks}
                  onChange={(e) => {
                    behavioralLearningService.updateConventions({ albumArtistEqualsComposerForIndianSoundtracks: e.target.checked })
                    setConventions(behavioralLearningService.getConventions())
                  }}
                  className="w-4 h-4 accent-[#D4AF37] cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-white/[0.04]">
                <div>
                  <div className="text-xs font-medium text-white">Soundtrack Genre Formatting</div>
                  <div className="text-[11px] text-white/50">Standardizes film soundtrack genres to "{conventions.defaultSoundtrackLanguage} Film Soundtrack"</div>
                </div>
                <input
                  type="checkbox"
                  checked={conventions.languagePrefixedSoundtrackGenre}
                  onChange={(e) => {
                    behavioralLearningService.updateConventions({ languagePrefixedSoundtrackGenre: e.target.checked })
                    setConventions(behavioralLearningService.getConventions())
                  }}
                  className="w-4 h-4 accent-[#D4AF37] cursor-pointer"
                />
              </div>
            </div>
            <div className="mt-4 divide-y divide-white/[0.06] max-h-72 overflow-y-auto">
              {learnedRules.map((rule) => (
                <div key={rule.id} className="py-2.5 flex items-center justify-between group">
                  <div>
                    <span className="text-xs line-through text-white/40">{rule.pattern}</span>
                    <span className="mx-2 text-[#D4AF37]">➔</span>
                    <span className="text-xs font-semibold text-emerald-300">{rule.normalizedValue}</span>
                    <span className="ml-2 text-[9px] font-mono px-1 py-0.2 rounded bg-white/[0.06] text-white/40 uppercase">
                      {rule.category}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-white/40">{rule.frequency} uses</span>
                    <button
                      onClick={() => {
                        behavioralLearningService.deleteRule(rule.id)
                        setLearnedRules(behavioralLearningService.getLearnedRules())
                        showToast(`Removed rule "${rule.pattern}"`)
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 text-white/40 hover:text-red-400 cursor-pointer transition-opacity"
                      title="Delete rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {learnedRules.length === 0 && (
                <div className="py-8 text-center text-white/40 text-xs">
                  No custom normalization rules recorded yet.
                </div>
              )}
            </div>
            <div className="pt-4 border-t border-white/[0.08] flex justify-end">
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-white/[0.08] text-xs font-medium text-white cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Unified Health & Audit Drawer */}
      {isHealthDrawerOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end">
          <div className="w-96 bg-[#121318] border-l border-white/[0.1] p-6 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-semibold text-white">Catalog Hygiene & Health</h3>
              </div>
              <button
                onClick={() => setIsHealthDrawerOpen(false)}
                className="text-white/40 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-4 space-y-3 flex-1 overflow-y-auto">
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="text-[11px] text-white/50">Total Library Tracks</div>
                <div className="text-xl font-semibold text-white mt-0.5">{tracks.length}</div>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="text-[11px] text-white/50">Curated / Total Releases</div>
                <div className="text-xl font-semibold text-emerald-300 mt-0.5">
                  {releases.length - tier2Items.length} / {releases.length}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="text-[11px] text-white/50">Pending Review (Tier 2)</div>
                <div className="text-xl font-semibold text-[#D4AF37] mt-0.5">{tier2Items.length}</div>
              </div>

              {auditIssues.length > 0 && (
                <div className="pt-2">
                  <h4 className="text-xs font-semibold text-white/70 uppercase tracking-wider mb-2">
                    Active Audit Alerts
                  </h4>
                  <div className="space-y-2">
                    {auditIssues.map((issue) => (
                      <div
                        key={issue.id}
                        className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.06] text-xs"
                      >
                        <div className="font-medium text-white/90">{issue.title}</div>
                        <div className="text-[11px] text-white/50 mt-0.5">{issue.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-auto pt-4 border-t border-white/[0.08]">
              <button
                onClick={() => setIsHealthDrawerOpen(false)}
                className="w-full py-2.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-xs font-medium text-white cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
export default UnifiedCurateCockpit

