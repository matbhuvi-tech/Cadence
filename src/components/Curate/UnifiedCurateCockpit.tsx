/**
 * src/components/Curate/UnifiedCurateCockpit.tsx
 * Production Unified Curate & Metadata Management Cockpit (⌘2).
 * 
 * Priority-ordered album triage and metadata reconciliation.
 *
 * Features:
 * - Sequence-aware track offset alignment (e.g. #6-#10 mapped to #1-#5 for Ranga).
 * - Consensus Empty-State Invariant: leaves Selected empty when local tag is missing and external providers lack quorum.
 * - Inline manual override pencil on every tag (including custom artwork URL).
 * - Audiophile Transport Quietness Guard (yields background disk I/O when isPlaying is active).
 * - Real-time Behavioral Learning integration (remembers user spelling & delimiter corrections).
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Sparkles,
  CheckCircle2,
  BookOpen,
  Volume2,
  Pause,
  X,
  Edit2,
  Check,
  Trash2,
  Link2,
  RotateCcw,
  Search,
  ArrowLeft,
  PanelLeft,
  FileText,
  Disc,
  SlidersHorizontal,
} from 'lucide-react'
import { CurateArtworkThumbnail } from './CurateArtworkThumbnail'
import { SelectedOutputCard } from './SelectedOutputCard'
import {
  evaluateCatalogProblems, filterAndRankCurateAlbums, loadDismissedProblems, loadPrioritySettings,
  loadCurateFilterState, saveCurateFilterState, resolveFilterTransition, saveDismissedProblem, removeDismissedProblem,
  type CurateFilterState, type CurateProblemCategoryId, type CatalogProblemSummary, type PrioritySettings, type DismissedProblemsMap,
} from '../../core/curatePriorities'
import {
  Track,
  Release,
  MetadataFieldState,
  TrackCandidateState,
  LearnedRule,
  SemanticConventions,
  ConsensusFieldSource,
} from '../../core/types'
import { getCurateChange, isReconciledCurateDraft, matchesCurateConfirmation, makeCurateCommitItems, projectCurateCommits, curateReviewKeys, type CurateCommitRow, type CurateValueChange } from '../../core/curateCommit'
import { stepFilteredAlbumSelection, resolvePostCommitNavigation, applyAcceptedSuggestionsToDraft, resolveStagedAlbumIds, resolveAlbumSelectionDraftState } from '../../core/curateWorkflow'
import { CurateAlbumSearch, CurateFilterBar } from './CurateFilterBar'
import { CurateCommitPreviewModal, type CommitPreviewAlbumInput } from './CurateCommitPreviewModal'
import { labels } from './curateProblemLabels'
import type { EnqueueBatchPayload } from '../../types/commit'
import {
  applyCurateTrackSelection, captureCurateDraft, captureCurateBaseline, restoreCurateDraft, migrateCurateDraft, mergeCurateProposal, selectCurateTrackFields,
  type CurateDraft, type CurateDraftTrack,
} from '../../core/curateDraft'
import { federatedResolversService, type ProviderResult } from '../../services/federatedResolvers'
import { compilationCanonicalizerService } from '../../services/compilationCanonicalizerService'
import { behavioralLearningService } from '../../services/behavioralLearningService'
import { tauriBridge } from '../../services/tauriBridge'
import { useCurationTrace } from '../../hooks/useCurationTrace'
import { CURATE_REFRESH_PROVIDER_BUDGET, captureTrackDecisions, curateMatchingContext, restoreAppleTrackCandidates, sourceCandidatesFromGrouping, type CurateSourceCandidate } from '../../services/curateEvidenceService'
import { SteerProgressBar } from './SteerProgressBar'
import { CurationDecisionTraceDrawer } from './CurationDecisionTraceDrawer'
import {
  cleanConsensusTitle,
  isPlaceholderTag,
  detectLanguage,
} from '../../core/taxonomyUtils'

export interface UnifiedCurateCockpitProps {
  tracks: Track[]
  releases: Release[]
  rawTracks?: Track[]
  rawReleases?: Release[]
  summary?: CatalogProblemSummary
  prioritySettings?: PrioritySettings
  dismissedProblems?: DismissedProblemsMap
  onPrioritySettingsChange?: (settings: PrioritySettings) => void
  onDismissedProblemsChange?: (dismissals: DismissedProblemsMap) => void
  initialSelectedAlbumId?: string | null
  onReturnToAnchor?: () => void
  onBackToLibrary: () => void
  showToast: (msg: string) => void
  commitRows?: CurateCommitRow[]
  commitQueueHostRef?: React.Ref<HTMLDivElement>
  onCommitQueued?: () => Promise<void>
  onDraftSaved?: (draft: CurateDraft) => void
  supersededCommitIds?: ReadonlySet<string>
  isPlaying?: boolean
}

interface AlbumWorkItem {
  id: string
  userOverridden?: boolean
  leadTrackId?: string
  folderName: string
  currentTitle: string
  confidenceScore: number
  offsetApplied?: number
  albumTitle: MetadataFieldState<string>
  albumArtist: MetadataFieldState<string>
  composer: MetadataFieldState<string>
  year: MetadataFieldState<number | undefined>
  coverArt: MetadataFieldState<string>
  genre: MetadataFieldState<string>
  tracks: CurateDraftTrack[]
  draftBasedOn?: string
  heldTrackEdits?: CurateDraft['heldTrackEdits']
  proposal?: CurateDraft
  rawRelease?: Release
  rawTracks: Track[]
}

function captureAlbumDraft(album: AlbumWorkItem): CurateDraft {
  const draft = captureCurateDraft(album)
  return { ...draft, baseline: album.draftBasedOn ?? draft.baseline }
}

const albumReviewFields = ['albumTitle', 'albumArtist', 'composer', 'year', 'coverArt', 'genre'] as const

const priorityChipNames: Record<string, string> = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' }

function formatAlbumDiscriminator(album: AlbumWorkItem): string | null {
  const leafFolder = album.folderName.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const title = (album.albumTitle.selected || album.currentTitle || '').toLowerCase()
  const editionMatch = leafFolder.match(/[[(]([^\]()]{2,28})[\])]\s*$/)
  if (editionMatch) {
    const hint = editionMatch[1].trim()
    if (hint && !title.includes(hint.toLowerCase())) return hint
  }
  const mediaFormat = album.rawRelease?.mediaFormat?.trim()
  if (mediaFormat) return mediaFormat
  const trackFormat = album.tracks[0]?.format?.trim().toUpperCase()
  return trackFormat || null
}

function SelectedChangeNote({ change, label }: { change: CurateValueChange | null | undefined; label?: string }) {
  if (!change) return null
  return (
    <span className="block break-words text-[11px] leading-snug text-amber-200">
      {label && `${label} · `}
      {change.previous === undefined ? 'Added · No local value' : `Was: ${change.previous}`}
    </span>
  )
}

// Direct Wikipedia Tracklist & Metadata Resolver (100% deterministic, zero API quota)
async function resolveDirectWikipediaCandidate(inputUrl: string, signal: AbortSignal): Promise<{
  releaseTitle: string
  artistCredit: string
  composer: string
  releaseYear?: number
  genre: string
  coverArtUrl?: string
  tracks: Array<{ trackNumber: number; trackName: string; artistName?: string }>
} | null> {
  let slug = inputUrl.trim()
  const m = inputUrl.match(/wiki\/([^#?]+)/)
  if (m) slug = m[1]
  if (!slug) return null

  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(slug)}`
    const r = await fetch(url, { signal, redirect: 'error', headers: { 'User-Agent': 'Cadence/1.0 (Bit-Perfect Music Manager)' } })
    if (!r.ok) return null
    const html = await r.text()

    // 1. Parse Composer, Year, Genre, Artist & Poster from Infobox
    let composer = ''
    let releaseYear: number | undefined
    let genre = 'Film Soundtrack'
    let coverArtUrl = ''
    let releaseTitle = decodeURIComponent(slug)
      .replace(/_/g, ' ')
      .replace(/\(soundtrack\)|\(film\)|\(album\)|\(\d{4}[^)]*\)/gi, '')
      .trim()

    const infoboxMatch = html.match(/<table[^>]*class=[^>]*infobox[^>]*>([\s\S]*?)<\/table>/i)
    if (infoboxMatch) {
      const boxHtml = infoboxMatch[1]

      // Extract Poster Artwork if present
      const imgMatch = boxHtml.match(/<img[^>]*src=["']([^"']+)["']/i)
      if (imgMatch) {
        let src = imgMatch[1].split('?')[0]
        if (src.startsWith('//')) src = 'https:' + src
        if (src.includes('/thumb/')) {
          src = src.replace(/\/thumb(\/archive)?\//, '$1/').replace(/\/[^\/]+$/, '')
        }
        coverArtUrl = src
      }

      // Parse infobox rows
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
      let trMatch: RegExpExecArray | null
      while ((trMatch = trRegex.exec(boxHtml)) !== null) {
        const tr = trMatch[1]
        const thMatch = tr.match(/<th[^>]*>([\s\S]*?)<\/th>/i)
        const tdMatch = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/i)
        if (thMatch && tdMatch) {
          const thText = thMatch[1].replace(/<[^>]+>/g, '').toLowerCase().trim()
          const tdText = tdMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

          if (!composer && (thText.includes('music by') || thText.includes('composer'))) {
            composer = tdText.replace(/–/g, '-')
          }
          if (!releaseYear && (thText.includes('release date') || thText.includes('released'))) {
            const y = tdText.match(/\b(19\d{2}|20\d{2})\b/)
            if (y) releaseYear = parseInt(y[1], 10)
          }
        }
      }
    }

    // Fallback release year from slug if not in infobox (e.g. Ranga_(1982_film))
    if (!releaseYear) {
      const slugYear = slug.match(/\b(19\d{2}|20\d{2})\b/)
      if (slugYear) releaseYear = parseInt(slugYear[1], 10)
    }

    // 2. Parse Tracklist tables (matching class tracklist, wikitable, or tables with song/singer headers)
    const tracks: Array<{ trackNumber: number; trackName: string; artistName?: string }> = []
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi
    let match: RegExpExecArray | null
    while ((match = tableRegex.exec(html)) !== null) {
      const tContent = match[1]
      const rows = tContent.match(/<tr[\s\S]*?<\/tr>/gi) || []
      if (rows.length < 2) continue

      let titleIdx = -1
      let singerIdx = -1
      const headerRow = rows.find((r) => /<th/i.test(r))
      if (headerRow) {
        const thCells = (headerRow.match(/<th[\s\S]*?<\/th>/gi) || []).map((c) =>
          c.replace(/<[^>]+>/g, '').toLowerCase().trim()
        )
        titleIdx = thCells.findIndex((c) => c.includes('title') || c.includes('song') || c.includes('track'))
        singerIdx = thCells.findIndex((c) => c.includes('singer') || c.includes('artist') || c.includes('performer'))
      }

      if (titleIdx === -1 && singerIdx === -1) {
        if (!match[0].includes('class="tracklist') && !match[0].includes("class='tracklist")) continue
        titleIdx = 1
        singerIdx = 2
      }

      if (titleIdx === -1) titleIdx = 0
      if (singerIdx === -1) singerIdx = 1

      let tNum = 1
      for (const row of rows) {
        const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map((c) =>
          c.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
        )
        if (
          cells.length >= 2 &&
          !cells[0].toLowerCase().includes('no') &&
          !cells[0].toLowerCase().includes('#') &&
          !cells[0].toLowerCase().includes('total') &&
          !cells[0].toLowerCase().includes('song')
        ) {
          const title = (cells[titleIdx] || `Track ${tNum}`).replace(/^"|"$/g, '').trim()
          const singers = (cells[singerIdx] || '').replace(/\s+/g, ' ').trim()
          if (title && !title.toLowerCase().includes('song') && !title.toLowerCase().includes('title')) {
            tracks.push({
              trackNumber: tNum++,
              trackName: title,
              artistName: singers || undefined,
            })
          }
        }
      }
      if (tracks.length > 0) break // Adopt primary soundtrack tracklist table
    }

    return {
      releaseTitle,
      artistCredit: composer || 'Various Artists',
      composer: composer || 'Various Artists',
      releaseYear,
      genre,
      coverArtUrl: coverArtUrl || undefined,
      tracks,
    }
  } catch (err) {
    console.warn('[WikipediaResolver] Direct fetch error:', err)
    return null
  }
}

async function resolveDirectSpotifyCandidate(inputUrl: string): Promise<{
  releaseTitle: string
  artistCredit: string
  composer: string
  releaseYear?: number
  genre: string
  coverArtUrl?: string
  tracks: Array<{ trackNumber: number; trackName: string; artistName?: string }>
} | null> {
  const m = inputUrl.match(/album\/([a-zA-Z0-9]+)/)
  if (!m) return null
  const albumId = m[1]

  try {
    const res = await fetch(`https://open.spotify.com/embed/album/${albumId}`)
    if (!res.ok) return null
    const html = await res.text()
    const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!scriptMatch) return null
    const data = JSON.parse(scriptMatch[1])
    const entity = data?.props?.pageProps?.state?.data?.entity
    if (!entity) return null

    let rawTitle = entity.name || entity.title || ''
    let artist = 'Various Artists'
    let title = rawTitle
    if (rawTitle.includes(' - ')) {
      const parts = rawTitle.split(' - ')
      artist = parts[0].trim()
      title = parts.slice(1).join(' - ').trim()
    }

    const coverArtUrl = entity.visualIdentity?.image?.reduce((best: any, img: any) => {
      return (img.maxWidth > (best?.maxWidth || 0)) ? img : best
    }, null)?.url

    let releaseYear: number | undefined
    if (entity.releaseDate) {
      const y = String(entity.releaseDate).match(/\b(19\d{2}|20\d{2})\b/)
      if (y) releaseYear = parseInt(y[1], 10)
    }

    const tracks = (entity.trackList || []).map((t: any, idx: number) => ({
      trackNumber: idx + 1,
      trackName: t.title || `Track ${idx + 1}`,
      artistName: (t.subtitle || '').replace(/\u00a0/g, ' ').trim(),
    }))

    return {
      releaseTitle: title || rawTitle,
      artistCredit: artist,
      composer: artist,
      releaseYear,
      genre: 'Soundtrack',
      coverArtUrl,
      tracks,
    }
  } catch (err) {
    console.warn('[UnifiedCurateCockpit] Spotify embed parsing error:', err)
    return null
  }
}

function mergeConsensusTrackStates(
  candTracks: TrackCandidateState[] | undefined,
  currentTracks: TrackCandidateState[],
  rawTracks?: Track[]
): TrackCandidateState[] {
  if (!candTracks || candTracks.length === 0) return currentTracks
  const candidates = new Map(candTracks.map(track => [track.trackId, track]))
  const rawById = new Map(rawTracks?.map(track => [track.id, track]))
  return currentTracks.map(cur => {
    const ts = candidates.get(cur.trackId)
    if (!ts) return cur
    const raw = rawById.get(ts.trackId)
    const effectiveFilePath = ts.filePath || cur?.filePath || raw?.filePath
    const effectiveFileName =
      ts.fileName ||
      cur?.fileName ||
      (raw as any)?.fileName ||
      (effectiveFilePath ? effectiveFilePath.replace(/\\/g, '/').split('/').pop() : undefined)
    return {
      ...ts,
      localTitle: cur.localTitle,
      localArtists: cur.localArtists,
      trackNumber: cur.trackNumber,
      originalAlbum: ts.originalAlbum ?? cur.originalAlbum,
      originalYear: ts.originalYear ?? cur.originalYear,
      provenanceSource: ts.provenanceSource ?? cur.provenanceSource,
      filePath: effectiveFilePath,
      fileName: effectiveFileName,
      format: ts.format || cur?.format || raw?.format,
      bitDepth: ts.bitDepth || cur?.bitDepth || raw?.bitDepth,
      sampleRate: ts.sampleRate || cur?.sampleRate || raw?.sampleRate,
    }
  })
}

export const UnifiedCurateCockpit: React.FC<UnifiedCurateCockpitProps> = ({
  tracks,
  releases,
  rawTracks = tracks,
  rawReleases = releases,
  summary,
  prioritySettings: settingsProp,
  dismissedProblems: dismissalsProp,
  onPrioritySettingsChange: _onPrioritySettingsChange,
  onDismissedProblemsChange,
  initialSelectedAlbumId,
  onReturnToAnchor,
  onBackToLibrary,
  showToast,
  commitRows,
  commitQueueHostRef,
  onCommitQueued,
  onDraftSaved,
  supersededCommitIds,
  isPlaying = false,
}) => {
  const [localSettings] = useState(loadPrioritySettings)
  const [localDismissals, setDismissedProblems] = useState(loadDismissedProblems)
  const prioritySettings = settingsProp ?? localSettings
  const dismissedProblems = dismissalsProp ?? localDismissals
  const problemSummary = useMemo(
    () => summary ?? evaluateCatalogProblems(tracks, releases, prioritySettings, dismissedProblems),
    [summary, tracks, releases, prioritySettings, dismissedProblems],
  )
  const [filter, setFilter] = useState(loadCurateFilterState)
  const [showFilters, setShowFilters] = useState(() =>
    !filter.priorities.length && !filter.categories.length && !filter.selectedAlbumIdFilter,
  )
  const filterToggleRef = useRef<HTMLButtonElement>(null)
  const filterToggleLabel = showFilters ? 'Hide filter sidebar' : 'Show filter sidebar'
  const [preview, setPreview] = useState<CommitPreviewAlbumInput[] | null>(null)
  const [stagedIds, setStagedIds] = useState<ReadonlySet<string>>(new Set())
  const albums = useMemo(() => {
    const byId = new Map(releases.map(release => [release.id, { id: release.id, title: release.title }]))
    for (const track of tracks) {
      if (!byId.has(track.releaseId)) byId.set(track.releaseId, { id: track.releaseId, title: track.albumTitle ?? '' })
    }
    return [...byId.values()]
  }, [releases, tracks])
  const filteredAlbums = useMemo(() => filterAndRankCurateAlbums(albums, problemSummary, filter), [albums, problemSummary, filter])
  const hasActiveFilters = Boolean(filter.priorities.length || filter.categories.length || filter.selectedAlbumIdFilter)
  const changeFilter = (next: CurateFilterState) => {
    directSelection.current = null
    const transition = resolveFilterTransition(albums, problemSummary, next, 'filter_change')
    saveCurateFilterState(transition.filter)
    setFilter(transition.filter)
    if (transition.toastMessage) showToast(transition.toastMessage)
    const applied = transition.filter
    const addedCategoryOrAlbum =
      applied.categories.some(category => !filter.categories.includes(category)) ||
      (applied.selectedAlbumIdFilter && applied.selectedAlbumIdFilter !== filter.selectedAlbumIdFilter)
    if (showFilters && addedCategoryOrAlbum) {
      setShowFilters(false)
      filterToggleRef.current?.focus()
    }
    if (!transition.filteredAlbums.some(album => album.id === selectedAlbumId)) {
      setSelectedAlbumId(transition.filteredAlbums[0]?.id ?? null)
    }
  }
  const updateDismissals = (dismissals: DismissedProblemsMap) => {
    setDismissedProblems(dismissals)
    onDismissedProblemsChange?.(dismissals)
  }
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false)
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

  // Inline editing state
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null)
  const [editInputValue, setEditInputValue] = useState<string>('')
  const [editingTrack, setEditingTrack] = useState<{ trackId: string; field: 'title' | 'artists' } | null>(null)
  const [trackEditValue, setTrackEditValue] = useState<string>('')

  // Commit progress state
  const [isBatchCommitting, setIsBatchCommitting] = useState(false)
  const batchAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    if (isPlaying) batchAbort.current?.abort()
  }, [isPlaying])
  useEffect(() => () => batchAbort.current?.abort(), [])

  // Compilation Provenance State & Abort Controller
  const [editingProvenanceTrackId, setEditingProvenanceTrackId] = useState<string | null>(null)
  const [provenanceEditFilm, setProvenanceEditFilm] = useState('')
  const [provenanceEditYear, setProvenanceEditYear] = useState('')

  // 3. Build Rich Album Work Items
  const [albumItems, setAlbumItems] = useState<Map<string, AlbumWorkItem>>(new Map())
  const displayedAlbums = useMemo(
    () => filteredAlbums.flatMap(({ id }) => albumItems.get(id) ?? []),
    [filteredAlbums, albumItems],
  )
  const filteredTrackCount = useMemo(
    () => displayedAlbums.reduce((sum, alb) => sum + alb.tracks.length, 0),
    [displayedAlbums],
  )
  const previousDraftItems = useRef(albumItems)
  const loadedDrafts = useRef(new Map<string, {
    serialized: string
    draft: CurateDraft
    restored: boolean
    pending?: Promise<void>
    saved: boolean
  }>())
  const [draftLoad, setDraftLoad] = useState<{ id: string; failed: boolean } | null>(null)
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0)
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null)
  const [savedAppleEvidence, setSavedAppleEvidence] = useState<{ albumId: string; title?: string; artist?: string; composer?: string; year?: number; genre?: string; trackCount?: number; releaseId?: string; rejectionReason?: string; trackRows: ReturnType<typeof restoreAppleTrackCandidates> } | null>(null)
  const initialSteering = useRef<{ albumId: string; title: string; artist: string; year: string }>(undefined)
  const [stagingAlbumId, setStagingAlbumId] = useState<string | null>(null)
  const [queuingAlbumId, setQueuingAlbumId] = useState<string | null>(null)

  // Initialize and populate album items - PRESERVES user edits across library refreshes
  useEffect(() => {
    const tracksByRelease = new Map<string, Track[]>()
    for (const track of rawTracks) {
      const releaseTracks = tracksByRelease.get(track.releaseId)
      if (releaseTracks) releaseTracks.push(track)
      else tracksByRelease.set(track.releaseId, [track])
    }
    setAlbumItems((prev) => {
      const next = new Map(prev)

      const releasesById = new Map(rawReleases.map(release => [release.id, release]))
      for (const albumId of new Set([...releasesById.keys(), ...tracksByRelease.keys()])) {
        const rel = releasesById.get(albumId)
        const albTracks = (tracksByRelease.get(albumId) ?? []).sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
        const existing = next.get(albumId)
        if (existing && existing.rawRelease === rel && existing.rawTracks.length === albTracks.length &&
            existing.rawTracks.every((track, index) => track === albTracks[index])) continue

        const rawTitle = rel?.title || albTracks[0]?.albumTitle || ''
        const rawComposer = rel?.composerName || albTracks.find(track => track.composerName)?.composerName || ''
        const rawArtist = albTracks.find(track => track.albumArtist)?.albumArtist || rel?.artistCredit || ''
        const rawYear = rel?.releaseYear || albTracks[0]?.canonicalReleaseYear
        const rawArt = rel?.coverArtUrl || rel?.artwork?.frontCoverUrl || ''
        const rawGenre = rel?.genreTags?.[0] || albTracks[0]?.genre || ''

        // Track candidate states
        const trackStates: TrackCandidateState[] = albTracks.map((t) => ({
          trackId: t.id,
          trackNumber: t.trackNumber || 0,
          localTitle: t.title,
          localArtists: t.artistCredit || '',
          localDuration: t.duration,
          matchedTitle: t.title,
          matchedArtists: t.artistCredit || '',
          originalAlbum: t.originalAlbum || '',
          originalYear: t.originalYear,
          provenanceSource: t.originalAlbum ? ('local_fallback' as any) : undefined,
          confidence: 0.90,
          source: 'local_fallback',
          requiresHumanReview: isPlaceholderTag(t.artistCredit || ''),
          filePath: t.filePath,
          fileName: (t as any).fileName || (t.filePath ? t.filePath.replace(/\\/g, '/').split('/').pop() : undefined),
          format: t.format,
          bitDepth: t.bitDepth,
          sampleRate: t.sampleRate,
        }))

        const baseline: AlbumWorkItem = {
          id: albumId,
          folderName: rel?.folderPath || albTracks[0]?.folderName || '',
          currentTitle: rawTitle,
          confidenceScore: 0.9,
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
            selected: rawArtist,
            confidence: rawArtist ? 0.9 : 0.3,
            source: 'local_fallback',
            requiresHumanReview: !rawArtist,
          },
          composer: {
            local: rawComposer,
            apple: undefined,
            musicbrainz: undefined,
            ai: undefined,
            selected: rawComposer,
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
            selected: rawGenre,
            confidence: 0.85,
            source: 'local_fallback',
          },
          tracks: trackStates,
        }
        if (!existing) {
          next.set(albumId, baseline)
          continue
        }
        const draft = captureAlbumDraft(existing)
        const fresh = captureCurateBaseline(baseline)
        if (draft.baseline === fresh.baseline) {
          next.set(albumId, { ...existing, rawRelease: rel, rawTracks: albTracks })
        } else if (loadedDrafts.current.get(albumId)?.draft.revision) {
          next.set(albumId, {
            ...restoreCurateDraft(baseline, migrateCurateDraft(draft, fresh)),
            draftBasedOn: draft.baseline,
          })
        } else {
          next.set(albumId, baseline)
        }
      }

      for (const id of next.keys()) {
        if (!releasesById.has(id) && !tracksByRelease.has(id)) next.delete(id)
      }
      return next
    })
  }, [rawReleases, rawTracks])

  const previousFiltered = useRef(filteredAlbums)
  const previousPrioritySettings = useRef(prioritySettings)
  const preserveSelectionOnRank = useRef(false)
  const directSelection = useRef(initialSelectedAlbumId)
  useEffect(() => {
    if (previousPrioritySettings.current !== prioritySettings) {
      previousPrioritySettings.current = prioritySettings
      preserveSelectionOnRank.current = true
      directSelection.current = selectedAlbumId
    }
  }, [prioritySettings, selectedAlbumId])
  useEffect(() => {
    directSelection.current = initialSelectedAlbumId
    if (initialSelectedAlbumId) setSelectedAlbumId(initialSelectedAlbumId)
  }, [initialSelectedAlbumId])
  useEffect(() => {
    const previous = previousFiltered.current
    previousFiltered.current = filteredAlbums
    const preserveSelection = preserveSelectionOnRank.current
    preserveSelectionOnRank.current = false
    setSelectedAlbumId(id => {
      if (id && (preserveSelection || (directSelection.current === id && !previous.some(album => album.id === id)))) return id
      if (id && !previous.some(album => album.id === id) && !filteredAlbums.some(album => album.id === id)) {
        return filteredAlbums[0]?.id ?? null
      }
      return resolvePostCommitNavigation(previous, filteredAlbums, id)
    })
  }, [filteredAlbums])
  const activeItem = selectedAlbumId ? albumItems.get(selectedAlbumId) : undefined
  const activeItemId = activeItem?.id

  // Only the selected album needs a draft read. Resolve it before showing editable output.
  useEffect(() => {
    if (!activeItemId || !activeItem) return
    if (loadedDrafts.current.has(activeItemId)) {
      setDraftLoad({ id: activeItemId, failed: false })
      return
    }
    let cancelled = false
    tauriBridge.curationGetDraft(activeItemId).then(draft => {
      if (cancelled) return
      const initial = captureCurateDraft(activeItem)
      // Completed confirmations supersede their saved draft.
      const rows = new Map((commitRows ?? []).map(row => [row.trackId, row]))
      const completedDraft = draft && isReconciledCurateDraft(draft, rows, activeItem.rawTracks, activeItem.rawRelease)
      const restoredDraft = resolveAlbumSelectionDraftState(
        draft, captureCurateBaseline(activeItem), Boolean(completedDraft),
        Boolean(draft && matchesCurateConfirmation(draft, rows, false, activeItem.rawTracks, activeItem.rawRelease)),
      )
      const restored = restoredDraft ? restoreCurateDraft(activeItem, restoredDraft) : activeItem
      const snapshot = restoredDraft
        ? { ...captureCurateDraft(restored), baseline: restoredDraft.baseline }
        : initial
      if (restoredDraft) {
        setAlbumItems(prev => {
          const current = prev.get(activeItemId)
          if (!current) return prev
          return new Map(prev).set(activeItemId, {
            ...restoreCurateDraft(current, restoredDraft),
            draftBasedOn: initial.baseline === restoredDraft.baseline ? undefined : restoredDraft.baseline,
          })
        })
      }
      loadedDrafts.current.set(activeItemId, {
        serialized: JSON.stringify(snapshot),
        draft: { ...snapshot, revision: restoredDraft === draft ? draft?.revision : undefined },
        saved: true,
        restored: Boolean(restoredDraft),
      })
      if (restoredDraft?.staged) setStagedIds(previous => new Set(previous).add(activeItemId))
      setDraftLoad({ id: activeItemId, failed: false })
    }).catch(err => {
      if (cancelled) return
      console.warn('[UnifiedCurateCockpit] Draft load failed:', err)
      setDraftLoad({ id: activeItemId, failed: true })
    })
    return () => { cancelled = true }
  }, [activeItemId, draftLoadAttempt, commitRows, supersededCommitIds])

  const selectedAlbum = activeItem && draftLoad?.id === activeItem.id && !draftLoad.failed ? activeItem : null
  const selectedChanges = useMemo(() => {
    if (!selectedAlbum) return null
    const album = Object.fromEntries(albumReviewFields.map(key => [
      key, getCurateChange(selectedAlbum[key].local, selectedAlbum[key].selected),
    ])) as Record<typeof albumReviewFields[number], CurateValueChange | null>
    const baselineTracks = new Map(selectedAlbum.rawTracks.map(track => [track.id, track]))
    const tracks = new Map(selectedAlbum.tracks.map(track => {
      const local = baselineTracks.get(track.trackId)
      return [track.trackId, {
        title: getCurateChange(track.localTitle, track.matchedTitle),
        singers: getCurateChange(track.localArtists, track.matchedArtists),
        originalAlbum: getCurateChange(local?.originalAlbum, track.originalAlbum),
        originalYear: getCurateChange(local?.originalYear, track.originalYear),
      }] as const
    }))
    return {
      album, tracks,
      albumCount: Object.values(album).filter(Boolean).length,
      trackCount: Array.from(tracks.values()).filter(change => Object.values(change).some(Boolean)).length,
    }
  }, [selectedAlbum])
  const selectedTrackIds = new Set(selectedAlbum?.tracks.map(track => track.trackId))
  const selectedCommitRows = commitRows?.filter(row => selectedTrackIds.has(row.trackId) && !supersededCommitIds?.has(row.id)) ?? []
  const commitsByTrack = useMemo(() => new Map(commitRows?.filter(row => !supersededCommitIds?.has(row.id)).map(row => [row.trackId, row])), [commitRows, supersededCommitIds])
  const selectedDraft = selectedAlbum && captureAlbumDraft(selectedAlbum)
  const loadedSelection = selectedAlbum ? loadedDrafts.current.get(selectedAlbum.id) : undefined
  if (selectedDraft && loadedSelection?.serialized === JSON.stringify(selectedDraft)) {
    selectedDraft.revision = loadedSelection.draft.revision
  }
  const selectedCommitConfirmed = Boolean(selectedAlbum && selectedDraft && matchesCurateConfirmation(selectedDraft, commitsByTrack, false, selectedAlbum.rawTracks, selectedAlbum.rawRelease))
  const selectedCommitReconciled = Boolean(selectedAlbum && selectedDraft && isReconciledCurateDraft(selectedDraft, commitsByTrack, selectedAlbum.rawTracks, selectedAlbum.rawRelease))
  const selectedCommitStatuses = new Set(selectedCommitRows.map(row => row.status))
  const selectedCommitError = selectedCommitRows.find(row => row.status === 'failed' && row.errorMessage)?.errorMessage

  const saveAlbumDraft = useCallback(async (album: AlbumWorkItem, requireRevision = false, renewRevision = false) => {
    const state = loadedDrafts.current.get(album.id)
    if (!state) throw new Error('The album draft has not loaded.')
    const draft = captureAlbumDraft(album)
    const serialized = JSON.stringify(draft)
    if (!renewRevision && state.serialized === serialized && (!requireRevision || state.draft.revision)) {
      const sameDraft = state.draft
      if (state.pending) {
        await state.pending
        return sameDraft
      }
      if (state.saved) return sameDraft
      draft.revision = sameDraft.revision
    }
    draft.revision ??= crypto.randomUUID()
    const prior = state.pending
    // Serialize writes per album. An older save cannot overwrite a newer edit.
    const write = (prior?.catch(() => undefined) ?? Promise.resolve())
      .then(() => tauriBridge.curationSaveDraft(album.id, draft))
    Object.assign(state, { draft, serialized, pending: write, saved: false })
    try {
      await write
      if (state.pending === write) {
        state.saved = true
        setDraftSaveError(current => current === album.id ? null : current)
      }
    } catch (err) {
      if (state.pending === write) setDraftSaveError(album.id)
      throw err
    } finally {
      if (state.pending === write) state.pending = undefined
    }
    return draft
  }, [])

  // Also save edits from a provider operation that finishes after the user selects another album.
  useEffect(() => {
    const previous = previousDraftItems.current
    previousDraftItems.current = albumItems
    for (const id of loadedDrafts.current.keys()) {
      const album = albumItems.get(id)
      if (!album || album === previous.get(id) || album.draftBasedOn) continue
      void saveAlbumDraft(album).then(draft => {
        const state = loadedDrafts.current.get(album.id)
        if (state?.saved && state.draft === draft && draft.revision &&
            album.tracks.some(track => commitsByTrack.has(track.trackId))) onDraftSaved?.(draft)
      }).catch(err => console.warn('[UnifiedCurateCockpit] Draft save failed:', err))
    }
  }, [albumItems, saveAlbumDraft, commitsByTrack, onDraftSaved])

  // Curation Decision Trace Hook
  const {
    status: traceStatus,
    progressMessage: traceProgressMessage,
    currentPhase: traceCurrentPhase,
    trace: curationTrace,
    outcomeStatus: traceOutcomeStatus,
    isDrawerOpen: isTraceDrawerOpen,
    isResuming: isTraceResuming,
    executeFetch: executeTraceFetch,
    isRefreshing: isSteeringLoading,
    cancelRefresh,
    lastEvidenceId,
    toggleDrawer: toggleTraceDrawer,
    closeDrawer: closeTraceDrawer,
  } = useCurationTrace({
    albumId: selectedAlbum?.id,
  })

  // Evidence is independent of the editable draft. Restore the compact provider
  // identity even when a completed commit makes the old draft obsolete.
  useEffect(() => {
    const albumId = selectedAlbum?.id
    setSavedAppleEvidence(null)
    if (!albumId) return
    let cancelled = false
    void tauriBridge.curationListEvidence(albumId).then(async runs => {
      const current = runs.find(run => run.current)
      if (!current) return
      const run = await tauriBridge.curationGetEvidence(albumId, current.id)
      const candidate = run?.attempts.find(attempt => attempt.provider === 'apple' && attempt.outcome === 'success')?.candidate
      const telemetry = run?.decision?.candidateTelemetry?.find(item => item.provider === 'apple')
      if (!cancelled && candidate && run) setSavedAppleEvidence({
        ...candidate, albumId, releaseId: candidate.releaseId ?? telemetry?.releaseId,
        rejectionReason: telemetry?.rejectionReason,
        trackRows: restoreAppleTrackCandidates({ ...run, applicability: current.applicability }),
      })
    }).catch(err => console.warn('[Curate] Evidence restore failed:', err))
    return () => { cancelled = true }
  }, [selectedAlbum?.id, lastEvidenceId])

  useEffect(() => {
    if (selectedAlbum) {
      const title = selectedAlbum.albumTitle.selected || selectedAlbum.currentTitle || ''
      const artist = selectedAlbum.composer.selected || selectedAlbum.albumArtist.selected || ''
      const year = selectedAlbum.year.selected ? String(selectedAlbum.year.selected) : ''
      initialSteering.current = { albumId: selectedAlbum.id, title, artist, year }
      setSteerAlbum(title)
      setSteerArtist(artist)
      setSteerYear(year)
      setSteerGroundingUrl('')
    }
  }, [selectedAlbum?.id])

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
        userOverridden: true,
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

  // Select source for track title & vocalists
  const handleSelectTrack = (
    trackId: string,
    selection: { title?: string; artists?: string; source?: ConsensusFieldSource },
  ) => {
    if (!selectedAlbum) return
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const updatedTracks = current.tracks.map((t) =>
        t.trackId === trackId ? applyCurateTrackSelection(t, selection) : t,
      )

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
        return selectCurateTrackFields({
          ...t,
          [field === 'title' ? 'matchedTitle' : 'matchedArtists']: trimmed,
          userOverridden: true,
          source: 'manual_override' as ConsensusFieldSource,
          requiresHumanReview: false,
        }, field === 'title' ? 'matchedTitle' : 'matchedArtists')
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
        const val = source === 'apple' ? t.appleArtists
          : source === 'musicbrainz' ? t.mbArtists
          : source === 'ai' ? t.aiArtists
          : t.localArtists
        if (val === undefined) return t

        return selectCurateTrackFields({
          ...t,
          matchedArtists: val || t.localArtists,
          source: (source === 'local' ? 'local_fallback' : (source === 'ai' ? 'ai_synthesized' : 'single_provider_match')) as ConsensusFieldSource,
          requiresHumanReview: false,
        }, 'matchedArtists')
      })

      next.set(selectedAlbum.id, { ...current, tracks: updatedTracks })
      return next
    })
    showToast(`Adopted ${source.toUpperCase()} for all tracks`)
  }

  // Steer Providers & Ground AI handler
  const handleFetchAndAnchor = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!selectedAlbum || !selectedAlbum.rawRelease || isSteeringLoading) return

    showToast(`Searching providers for "${steerAlbum || selectedAlbum.currentTitle}"...`)

    try {
      let aiMasterResult: any = undefined
      let directAppleCandidate: ProviderResult | null = null
      const effective = projectCurateCommits(selectedAlbum.rawTracks, [selectedAlbum.rawRelease], selectedCommitRows)
      const localRelease = effective.releases[0]
      const consensus = await executeTraceFetch(selectedAlbum.id, {
        trigger: 'user_refresh', context: curateMatchingContext(localRelease, effective.tracks),
        confirmedCommitIds: Object.fromEntries(effective.tracks.map(track => [
          track.id, commitRows?.find(row => row.trackId === track.id)?.id ?? null,
        ])),
      }, async (signal, onProgress, record) => {
      let directWikiMaster: any = null
      const useWikipedia = steerGroundingUrl.includes('wikipedia.org')
      const useAi = !useWikipedia && Boolean(steerGroundingUrl.trim() || steerAlbum.trim())

      // 1. If user supplied a Wikipedia URL, resolve directly and deterministically (zero quota)
      if (useWikipedia) {
        directWikiMaster = await resolveDirectWikipediaCandidate(steerGroundingUrl, signal)
        signal.throwIfAborted()
        if (directWikiMaster) {
          aiMasterResult = {
            releaseTitle: directWikiMaster.releaseTitle,
            artistCredit: directWikiMaster.artistCredit,
            composer: directWikiMaster.composer,
            releaseYear: directWikiMaster.releaseYear || (Number(steerYear) || undefined),
            genre: directWikiMaster.genre || `${detectedLanguage} Film Soundtrack`,
            tracks: directWikiMaster.tracks,
          }
        }
      }

      // 2. If user supplied a grounding URL or custom search, call compilationCanonicalizerService if not already resolved
      let sourceCandidates: CurateSourceCandidate[] = []
      if (useAi) {
        try {
          const canonicalRes = await compilationCanonicalizerService.resolveCompilationSoundtracks(
            localRelease,
            effective.tracks,
            releases,
            {
              selectedAlbumSignal: signal,
              recordAttempt: record,
              referenceUrl: steerGroundingUrl.trim() || undefined,
              userSearchQuery: {
                albumTitle: steerAlbum.trim() || undefined,
                artistCredit: steerArtist.trim() || undefined,
                year: Number(steerYear) || undefined,
              },
            }
          )

          if (canonicalRes && canonicalRes.success && canonicalRes.tracks && canonicalRes.tracks.length > 0) {
            sourceCandidates = canonicalRes.tracks.flatMap(track => track.trackId && track.proposedOriginalAlbum ? [{
              localTrackId: track.trackId, title: track.proposedOriginalAlbum, year: track.proposedOriginalYear,
            }] : [])
            const firstProp = canonicalRes.tracks[0]
            const cleanRawTitle = cleanConsensusTitle(localRelease.title)
            const fallbackAlbumTitle = steerAlbum.trim() || cleanRawTitle
            const fallbackComposer = steerArtist.trim() || localRelease.composerName || localRelease.artistCredit || ''

            aiMasterResult = {
              releaseTitle: isCompilationAlbum
                ? fallbackAlbumTitle
                : (firstProp?.proposedOriginalAlbum || fallbackAlbumTitle),
              artistCredit: (firstProp as any)?.composer || (firstProp as any)?.proposedComposer || fallbackComposer,
              composer: (firstProp as any)?.composer || (firstProp as any)?.proposedComposer || fallbackComposer,
              releaseYear: (firstProp as any)?.proposedOriginalYear || (firstProp as any)?.proposedYear || (Number(steerYear) || localRelease.releaseYear),
              genre: `${detectedLanguage} Film Soundtrack`,
              tracks: canonicalRes.tracks.map((pt, idx) => ({
                trackNumber: pt.trackNumber || idx + 1,
                trackName: pt.title || (pt as any).proposedTitle || `Track ${idx + 1}`,
                artistName: (pt as any).primaryVocalists || (pt as any).proposedSingers,
              })),
            }
          }
        } catch (aiErr) {
          console.warn('[UnifiedCurateCockpit] AI Grounding note:', aiErr)
        }
      }

      // 3. If user gave an Apple Music URL, directly resolve the authentic Apple Music album & tracklist
      signal.throwIfAborted()
      const linkedAppleId = /^https:\/\/(?:music|itunes)\.apple\.com\//i.test(steerGroundingUrl.trim())
        ? steerGroundingUrl.match(/(?:album\/[^/]+\/|album\/|id=?)(\d{8,12})/)?.[1]
        : undefined
      const initial = initialSteering.current
      const savedAppleId = !steerGroundingUrl.trim() && initial?.albumId === selectedAlbum.id &&
        initial.title === steerAlbum && initial.artist === steerArtist && initial.year === steerYear &&
        savedAppleEvidence?.albumId === selectedAlbum.id && !savedAppleEvidence.rejectionReason &&
        /^\d+$/.test(savedAppleEvidence.releaseId ?? '') ? savedAppleEvidence.releaseId : undefined
      const appleId = linkedAppleId ?? savedAppleId
      if (appleId) {
        onProgress({ phase: 'querying_apple', message: 'Fetching the Apple release and tracklist…', elapsedMs: 0 })
        try {
          directAppleCandidate = await federatedResolversService.fetchItunesAlbumCandidate({
            sanitizedTitle: localRelease.title,
            sanitizedArtist: localRelease.artistCredit || '',
            trackCount: selectedAlbum.rawTracks.length,
          }, record, signal, 1, { appleReleaseId: appleId })
        } catch (appleErr) {
          signal.throwIfAborted()
          if (linkedAppleId && !aiMasterResult) throw appleErr
        }
        signal.throwIfAborted()
        if (linkedAppleId && !directAppleCandidate && !aiMasterResult) {
          throw new Error('Apple could not find the linked release.')
        }
      }

      // 3. Build steered release for federated provider resolution
      const steeredRelease: Release = {
        ...localRelease,
        title: directAppleCandidate?.releaseTitle || aiMasterResult?.releaseTitle || steerAlbum.trim() || localRelease.title,
        artistCredit: directAppleCandidate?.artistCredit || aiMasterResult?.artistCredit || steerArtist.trim() || localRelease.artistCredit,
        composerName: directAppleCandidate?.composer || aiMasterResult?.composer || steerArtist.trim() || localRelease.composerName,
        releaseYear: directAppleCandidate?.releaseYear || aiMasterResult?.releaseYear || Number(steerYear) || localRelease.releaseYear,
      }

        signal.throwIfAborted()
        const res = await federatedResolversService.resolve2of3ReleaseConsensus(
          steeredRelease,
          effective.tracks,
          false,
          aiMasterResult,
          directAppleCandidate,
          onProgress,
          signal,
          record,
          directAppleCandidate ? 0 : CURATE_REFRESH_PROVIDER_BUDGET / 2,
          CURATE_REFRESH_PROVIDER_BUDGET / 2 - Number(useWikipedia || useAi),
          true,
        )
        return { trace: res.decisionTrace, result: res, trackDecisions: captureTrackDecisions(res),
          identityMappings: res.identityMappings, sourceCandidates: sourceCandidates.length ? sourceCandidates : sourceCandidatesFromGrouping(res) }
      })

      if (!consensus) return

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
          albumTitle: {
            ...current.albumTitle,
            ...(consensus.albumFieldStates?.albumTitle || {}),
            ai: aiMasterResult?.releaseTitle || consensus.albumFieldStates?.albumTitle?.ai || current.albumTitle.ai,
            selected: consensus.albumFieldStates?.albumTitle?.selected ?? current.albumTitle.selected,
          },
          albumArtist: {
            ...current.albumArtist,
            ...(consensus.albumFieldStates?.albumArtist || {}),
            ai: aiMasterResult?.artistCredit || consensus.albumFieldStates?.albumArtist?.ai || current.albumArtist.ai,
            selected: consensus.albumFieldStates?.albumArtist?.selected ?? current.albumArtist.selected,
          },
          composer: {
            ...current.composer,
            ...(consensus.albumFieldStates?.composer || {}),
            ai: aiMasterResult?.composer || consensus.albumFieldStates?.composer?.ai || current.composer.ai,
            selected: consensus.albumFieldStates?.composer?.selected ?? current.composer.selected,
          },
          year: {
            ...current.year,
            ...(consensus.albumFieldStates?.releaseYear || {}),
            ai: aiMasterResult?.releaseYear || consensus.albumFieldStates?.releaseYear?.ai || current.year.ai,
            selected: consensus.albumFieldStates?.releaseYear
              ? consensus.albumFieldStates.releaseYear.selected : current.year.selected,
          },
          genre: {
            ...current.genre,
            ...(consensus.albumFieldStates?.genre || {}),
            ai: aiMasterResult?.genre || consensus.albumFieldStates?.genre?.ai || current.genre.ai,
            selected: consensus.albumFieldStates?.genre?.selected ?? current.genre.selected,
          },
          coverArt: directAppleCandidate?.coverArtUrl ? {
            ...current.coverArt,
            apple: directAppleCandidate.coverArtUrl,
            selected: consensus.albumFieldStates?.coverArt?.selected || directAppleCandidate.coverArtUrl,
          } : (consensus.albumFieldStates?.coverArt ? {
            ...current.coverArt,
            apple: consensus.albumFieldStates.coverArt.apple || current.coverArt.apple,
            musicbrainz: consensus.albumFieldStates.coverArt.musicbrainz || current.coverArt.musicbrainz,
            ai: aiMasterResult?.coverArtUrl || consensus.albumFieldStates.coverArt.ai || current.coverArt.ai,
            selected: consensus.albumFieldStates.coverArt.selected,
          } : current.coverArt),
          tracks: mergeConsensusTrackStates(consensus.trackStates, current.tracks, current.rawTracks),
        }

        const proposal = mergeCurateProposal(current, updated)
        next.set(selectedAlbum.id, {
          ...restoreCurateDraft(proposal, captureCurateDraft(current)),
          proposal: captureCurateDraft(proposal),
        })
        return next
      })

      showToast(`✓ Grounded providers with "${steerAlbum || steerGroundingUrl}"!`)
    } catch (err) {
      console.error('[UnifiedCurateCockpit] Fetch & Anchor error:', err)
      showToast('⚠️ Failed to re-query providers. Check search inputs.')
    }
  }

  const acceptSuggestions = () => {
    if (!selectedAlbum) return
    const apple = savedAppleEvidence?.albumId === selectedAlbum.id && !savedAppleEvidence.rejectionReason ? savedAppleEvidence : undefined
    const learned = behavioralLearningService.applySoundtrackConventions({
      composer: selectedAlbum.composer.selected,
      albumArtist: selectedAlbum.albumArtist.selected,
      genre: selectedAlbum.genre.selected,
      language: detectedLanguage,
    })
    const candidates = {
      albumTitle: apple?.title,
      albumArtist: apple?.artist || behavioralLearningService.applyLearnedRules(learned.albumArtist || selectedAlbum.albumArtist.selected, 'artist').value,
      composer: apple?.composer || behavioralLearningService.applyLearnedRules(selectedAlbum.composer.selected, 'composer').value,
      year: apple?.year,
      genre: apple?.genre || learned.genre,
      coverArt: undefined,
    }
    setAlbumItems(previous => {
      const current = previous.get(selectedAlbum.id)
      if (!current) return previous
      const currentDraft = captureAlbumDraft(current)
      const trackSuggestions = new Map(current.proposal?.tracks.map(track => [track.trackId, track]))
      for (const track of currentDraft.tracks) {
        const saved = apple?.trackRows.get(track.trackId)
        if (!saved || saved.conflicted || trackSuggestions.has(track.trackId)) continue
        trackSuggestions.set(track.trackId, {
          ...track, matchedTitle: saved.title || track.matchedTitle,
          matchedArtists: saved.artist || track.matchedArtists,
        })
      }
      const proposal = { ...currentDraft, ...current.proposal, tracks: [...trackSuggestions.values()] }
      const draft = applyAcceptedSuggestionsToDraft(currentDraft, proposal, candidates)
      return new Map(previous).set(current.id, restoreCurateDraft(current, draft))
    })
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

  // Manual edit handler for track provenance
  const handleSaveProvenance = useCallback((trackId: string) => {
    setAlbumItems(prev => {
      const next = new Map(prev)
      if (!selectedAlbum) return prev
      const cur = next.get(selectedAlbum.id)
      if (!cur) return prev
      const updatedTracks = cur.tracks.map(t => {
        if (t.trackId === trackId) {
          return selectCurateTrackFields({
            ...t,
            originalAlbum: provenanceEditFilm.trim(),
            originalYear: provenanceEditYear.trim() ? parseInt(provenanceEditYear.trim(), 10) : undefined,
            provenanceSource: 'user_override' as any,
            userOverridden: true,
          }, 'originalAlbum', 'originalYear')
        }
        return t
      })
      next.set(selectedAlbum.id, { ...cur, tracks: updatedTracks })
      return next
    })
    setEditingProvenanceTrackId(null)
  }, [selectedAlbum, provenanceEditFilm, provenanceEditYear])

  // Stage Album: saves state, keeps in queue with 'staged' badge, and advances
  const handleStage = useCallback(async () => {
    if (!selectedAlbum || selectedAlbum.draftBasedOn || stagingAlbumId || queuingAlbumId || selectedCommitReconciled || batchAbort.current) return

    // Advance only after SQLite has acknowledged the staged draft.
    setStagingAlbumId(selectedAlbum.id)
    try {
      await saveAlbumDraft({ ...selectedAlbum, userOverridden: true })
    } catch (err) {
      console.warn('[UnifiedCurateCockpit] Stage draft failed:', err)
      showToast('Could not save the staged draft. Try Stage & Next again.')
      return
    } finally {
      setStagingAlbumId(null)
    }
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (current) {
        next.set(selectedAlbum.id, {
          ...current,
          userOverridden: true,
        })
      }
      return next
    })

    showToast(`✓ Staged "${selectedAlbum.albumTitle.selected}". Saved for review in queue.`)

    setStagedIds(prev => new Set(prev).add(selectedAlbum.id))
    setSelectedAlbumId(current => current === selectedAlbum.id
      ? stepFilteredAlbumSelection(filteredAlbums, current, 1) : current)
  }, [selectedAlbum, stagingAlbumId, queuingAlbumId, selectedCommitReconciled, saveAlbumDraft, filteredAlbums, showToast])

  const markDraftsQueued = (drafts: NonNullable<EnqueueBatchPayload['curateDrafts']>) => {
    const queued = new Set(drafts.map(({ albumId }) => albumId))
    for (const { albumId, draft } of drafts) {
      const state = loadedDrafts.current.get(albumId)
      if (state && (!state.draft.revision || state.draft.revision === draft.revision)) {
        // Keep the local snapshot ordering. The native draft may round-trip
        // through a JSON object with a different property order.
        const snapshot: CurateDraft = JSON.parse(state.serialized)
        Object.assign(state, { draft, serialized: JSON.stringify({ ...snapshot, staged: false }), saved: true })
      }
    }
    setStagedIds(previous => new Set([...previous].filter(id => !queued.has(id))))
    setAlbumItems(previous => {
      const next = new Map(previous)
      for (const id of queued) {
        const album = next.get(id)
        if (album) next.set(id, { ...album, userOverridden: false })
      }
      return next
    })
  }

  // Freeze the selection in the same transaction that enqueues the writes.
  const handleCommitAlbum = async () => {
    if (!selectedAlbum || selectedAlbum.draftBasedOn || stagingAlbumId || queuingAlbumId || selectedCommitConfirmed || batchAbort.current) return
    setQueuingAlbumId(selectedAlbum.id)
    try {
      if (!tauriBridge.isTauri()) throw new Error('Open the desktop app to queue tag writes.')
      const draft = await saveAlbumDraft(selectedAlbum, true, selectedCommitRows.some(row => row.lineageChanged))
      const items = makeCurateCommitItems(draft, selectedAlbum.rawTracks, selectedAlbum.rawRelease)
      if (!items.length) throw new Error('There are no tracks to commit.')
      const drafts = [{ albumId: selectedAlbum.id, draft: { ...draft, staged: false } }]
      await tauriBridge.commitEnqueueBatch({
        description: `Curate: ${selectedAlbum.albumTitle.selected}`,
        destination: 'embedded',
        curateDrafts: drafts,
        items,
      })
      markDraftsQueued(drafts)
      showToast(`Queued "${selectedAlbum.albumTitle.selected}" for tag writing.`)
      await onCommitQueued?.()
    } catch (err) {
      showToast(`Could not queue album: ${String(err)}`)
    } finally {
      setQueuingAlbumId(null)
    }
  }

  // The native draft-list command enforces the idle cooldown. Refresh the
  // staged badges when entering Curate or returning to idle.
  useEffect(() => {
    if (isPlaying) return
    let cancelled = false
    void tauriBridge.listCurationDrafts().then(drafts => {
      if (!cancelled) setStagedIds(new Set(resolveStagedAlbumIds(drafts)))
    }).catch(() => {
      // The transport may still be in cooldown. Commit All can retry on demand.
    })
    return () => { cancelled = true }
  }, [isPlaying])

  const openCommitPreview = async () => {
    if (stagingAlbumId || queuingAlbumId || isPlaying || batchAbort.current) return
    const controller = new AbortController()
    batchAbort.current = controller
    setIsBatchCommitting(true)
    try {
      await Promise.all([...loadedDrafts.current.values()].map(state => state.pending))
      const drafts = await tauriBridge.listCurationDrafts()
      controller.signal.throwIfAborted()
      const ids = resolveStagedAlbumIds(drafts)
      setStagedIds(new Set(ids))
      const candidates = ids.flatMap(albumId => {
        const album = albumItems.get(albumId)
        const draft = drafts[albumId]
        if (!album || matchesCurateConfirmation(draft, commitsByTrack, false, album.rawTracks, album.rawRelease)) return []
        return [{
          albumId, title: album.currentTitle, draft,
          rawTracks: album.rawTracks, rawRelease: album.rawRelease,
          currentBaseline: captureCurateBaseline(album).baseline,
          lineageChanged: album.rawTracks.some(track => commitsByTrack.get(track.id)?.lineageChanged),
        }]
      })
      if (candidates.length) setPreview(candidates)
      else showToast('No staged albums are ready to commit.')
    } catch (err) {
      if (!controller.signal.aborted) showToast(`Could not load staged albums: ${String(err)}`)
    } finally {
      batchAbort.current = null
      setIsBatchCommitting(false)
    }
  }

  const confirmBatch = async (eligibleAlbumIds: readonly string[]) => {
    if (!preview || batchAbort.current || stagingAlbumId || queuingAlbumId) return
    batchAbort.current = new AbortController()
    setIsBatchCommitting(true)
    try {
      if (!tauriBridge.isTauri()) throw new Error('Open the desktop app to queue tag writes.')
      const items: EnqueueBatchPayload['items'] = []
      const drafts: NonNullable<EnqueueBatchPayload['curateDrafts']> = []
      for (const entry of preview) {
        if (!eligibleAlbumIds.includes(entry.albumId)) continue
        const album = albumItems.get(entry.albumId)
        if (!album || album.rawTracks !== entry.rawTracks || album.rawRelease !== entry.rawRelease) {
          throw new Error('Local tags changed. Open the preview again.')
        }
        const current = loadedDrafts.current.get(entry.albumId)
        if (current?.pending || (current?.draft.revision && current.draft.revision !== entry.draft.revision)) {
          throw new Error('A staged draft changed. Open the preview again.')
        }
        if (matchesCurateConfirmation(entry.draft, commitsByTrack, false, entry.rawTracks, entry.rawRelease)) continue
        const draft = { ...entry.draft, revision: entry.draft.revision ?? crypto.randomUUID(), staged: false }
        const changed = makeCurateCommitItems(draft, entry.rawTracks, entry.rawRelease)
        if (!changed.length) continue
        drafts.push({ albumId: entry.albumId, draft })
        items.push(...changed)
      }
      if (!items.length) throw new Error('There are no tracks to commit.')
      await tauriBridge.commitEnqueueBatch({
        description: `Curate · ${drafts.length} staged albums`,
        destination: 'embedded',
        curateDrafts: drafts,
        items,
      })
      markDraftsQueued(drafts)
      setPreview(null)
      showToast(`Queued ${drafts.length} staged album(s) for tag writing.`)
      await onCommitQueued?.()
    } catch (err) {
      setPreview(null)
      showToast(`Could not queue staged albums: ${String(err)}`)
    } finally {
      batchAbort.current = null
      setIsBatchCommitting(false)
    }
  }

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        directSelection.current = null
        setSelectedAlbumId(current => stepFilteredAlbumSelection(filteredAlbums, current, e.key === '[' ? -1 : 1))
      } else if (e.key === 'Escape') {
        if (document.querySelector('[data-curate-priority-popover]:popover-open')) return
        if (preview) return
        if (isRulesModalOpen) setIsRulesModalOpen(false)
        else onBackToLibrary()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [filteredAlbums, preview, isRulesModalOpen, onBackToLibrary])

  // Row Renderer: Album Text Field
  const renderFieldRow = (
    fieldKey: 'albumTitle' | 'albumArtist' | 'composer' | 'year' | 'genre',
    label: string,
    fieldState: MetadataFieldState<any>
  ) => {
    const isEditing = editingFieldKey === fieldKey
    const selectedVal = fieldState.selected
    const change = selectedChanges?.album[fieldKey]
    const archivedApple = fieldKey === 'albumTitle' ? savedAppleEvidence?.title
      : fieldKey === 'albumArtist' ? savedAppleEvidence?.artist
      : fieldKey === 'composer' ? savedAppleEvidence?.composer
      : fieldKey === 'year' ? savedAppleEvidence?.year
      : fieldKey === 'genre' ? savedAppleEvidence?.genre : undefined
    const appleValue = fieldState.apple ?? archivedApple

    return (
      <tr key={fieldKey} data-testid={`master-row-${fieldKey}`} className="hover:bg-white/[0.015] transition-colors">
        <td className="py-2.5 px-4 font-medium text-white/70">{label}</td>

        {/* Local */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'local')}
          data-testid={`master-cell-${fieldKey}-local`}
          className={`py-2.5 px-4 cursor-pointer transition-colors ${
            fieldState.source === 'local_fallback' ? 'bg-white/[0.04] text-white font-medium' : 'text-white/60 hover:text-white'
          }`}
        >
          {String(fieldState.local ?? '—')}
        </td>

        {/* Apple */}
        <td
          onClick={() => { if (fieldState.apple !== undefined) handleSelectFieldSource(fieldKey, 'apple') }}
          data-testid={`master-cell-${fieldKey}-apple`}
          className="py-2.5 px-4 cursor-pointer text-white/70 hover:text-[#D4AF37] transition-colors"
        >
          {String(appleValue ?? '—')}
          {fieldState.apple === undefined && archivedApple !== undefined && (
            <span className="block text-[10px] text-amber-300">Saved evidence · inspect before adopting</span>
          )}
        </td>

        {/* MusicBrainz */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'musicbrainz')}
          data-testid={`master-cell-${fieldKey}-musicbrainz`}
          className="py-2.5 px-4 cursor-pointer text-white/60 hover:text-white transition-colors"
        >
          {String(fieldState.musicbrainz ?? '—')}
        </td>

        {/* Gemini AI */}
        <td
          onClick={() => handleSelectFieldSource(fieldKey, 'ai')}
          data-testid={`master-cell-${fieldKey}-ai`}
          className="py-2.5 px-4 cursor-pointer text-white/70 hover:text-cyan-300 transition-colors"
        >
          {String(fieldState.ai ?? '—')}
        </td>

        {/* Selected Output */}
        <td data-testid={`master-cell-${fieldKey}-selected`} className={`py-2.5 px-4 border-l border-white/[0.06] ${change ? 'bg-amber-500/[0.07]' : 'bg-emerald-500/[0.03]'}`}>
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
                <div className="min-w-0">
                  <span className="block break-words font-semibold text-emerald-300">{String(selectedVal)}</span>
                  <SelectedChangeNote change={change} />
                </div>
              ) : (
                <span className="text-[11px] text-amber-300 font-medium">
                  ⚠️ Action Required (No Consensus)
                </span>
              )}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                <button
                  onClick={() => {
                    setEditingFieldKey(fieldKey)
                    setEditInputValue(String(selectedVal || ''))
                  }}
                  className="p-1 rounded hover:bg-white/[0.08] text-white/60 hover:text-white transition-colors cursor-pointer"
                  data-testid={`btn-edit-master-${fieldKey}`}
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
    const change = selectedChanges?.album.coverArt

    return (
      <tr data-testid="master-row-coverArt" className="hover:bg-white/[0.015] transition-colors">
        <td className="py-3 px-4 font-medium text-white/70">Cover Artwork</td>

        {/* Local */}
        <td
          onClick={() => {
            if (!selectedAlbum) return;
            const fallbackArt = selectedAlbum?.leadTrackId
              ? `cadence:cover://${selectedAlbum.leadTrackId}`
              : (selectedAlbum?.tracks?.[0]?.trackId ? `cadence:cover://${selectedAlbum.tracks[0].trackId}` : null);
            const effectiveArt = fieldState.local || fallbackArt;
            if (!fieldState.local && effectiveArt) {
              setAlbumItems((prev) => {
                const next = new Map(prev);
                const curr = next.get(selectedAlbum.id);
                if (curr) {
                  next.set(selectedAlbum.id, {
                    ...curr,
                    coverArt: { ...curr.coverArt, local: effectiveArt, selected: effectiveArt, source: 'local_fallback' },
                  });
                }
                return next;
              });
              showToast('Adopted LOCAL artwork');
            } else {
              handleSelectFieldSource('coverArt', 'local');
            }
          }}
          data-testid="master-cell-coverArt-local"
          className="py-3 px-4 cursor-pointer group"
        >
          {fieldState.local || (selectedAlbum?.tracks?.[0]?.trackId ? `cadence:cover://${selectedAlbum.tracks[0].trackId}` : null) ? (
            <div className="p-0.5 rounded-lg w-fit">
              <CurateArtworkThumbnail
                src={fieldState.local || (selectedAlbum?.tracks?.[0]?.trackId ? `cadence:cover://${selectedAlbum.tracks[0].trackId}` : '')}
                alt="Local Art"
                className="w-12 h-12 rounded border border-white/10 group-hover:border-emerald-500/50 transition-colors"
                fallbackLabel="No Local Art"
                testId="master-coverArt-local"
              />
              <span className="text-[9px] text-neutral-400 block mt-1">Local Tag</span>
            </div>
          ) : (
            <div className="w-12 h-12 rounded border border-white/10 bg-black/40 flex flex-col items-center justify-center text-white/30 text-[10px]">
              <Disc className="w-5 h-5 text-white/20 mb-0.5" />
              <span>None</span>
            </div>
          )}
        </td>

        {/* Apple */}
        <td data-testid="master-cell-coverArt-apple" onClick={() => handleSelectFieldSource('coverArt', 'apple')} className="py-3 px-4 cursor-pointer">
          {fieldState.apple ? (
            <div className="p-0.5 rounded-lg w-fit">
              <CurateArtworkThumbnail
                src={fieldState.apple}
                alt="Apple Art"
                className="w-12 h-12 rounded shadow border border-white/10"
                fallbackLabel="Failed"
                testId="master-coverArt-apple"
              />
              <span className="text-[9px] text-[#D4AF37] block mt-1">3000px HD</span>
            </div>
          ) : (
            <span className="text-white/40 text-xs">—</span>
          )}
        </td>

        {/* MusicBrainz */}
        <td data-testid="master-cell-coverArt-musicbrainz" onClick={() => handleSelectFieldSource('coverArt', 'musicbrainz')} className="py-3 px-4 cursor-pointer">
          {fieldState.musicbrainz ? (
            <div className="p-0.5 rounded-lg w-fit">
              <CurateArtworkThumbnail
                src={fieldState.musicbrainz}
                alt="MB Art"
                className="w-12 h-12 rounded shadow opacity-70 border border-white/10"
                fallbackLabel="Failed"
                testId="master-coverArt-musicbrainz"
              />
              <span className="text-[9px] text-white/50 block mt-1">CAA</span>
            </div>
          ) : (
            <span className="text-white/40 text-xs">—</span>
          )}
        </td>

        {/* Gemini AI */}
        <td data-testid="master-cell-coverArt-ai" onClick={() => handleSelectFieldSource('coverArt', 'ai')} className="py-3 px-4 cursor-pointer">
          {fieldState.ai ? (
            <div className="p-0.5 rounded-lg w-fit">
              <CurateArtworkThumbnail
                src={fieldState.ai}
                alt="AI Art"
                className="w-12 h-12 rounded shadow border border-white/10"
                fallbackLabel="Failed"
                testId="master-coverArt-ai"
              />
              <span className="text-[9px] text-cyan-300 block mt-1">AI Verified</span>
            </div>
          ) : (
            <span className="text-white/40 text-xs">—</span>
          )}
        </td>

        {/* Selected Artwork */}
        <td data-testid="master-cell-coverArt-selected" className={`py-3 px-4 border-l border-white/[0.06] ${change ? 'bg-amber-500/[0.07]' : 'bg-emerald-500/[0.03]'}`}>
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
                <CurateArtworkThumbnail
                  src={fieldState.selected}
                  alt="Selected Art"
                  className="w-14 h-14 rounded-lg border-2 border-emerald-500/60 shadow-lg"
                  fallbackIconClassName="w-7 h-7 text-white/40"
                  fallbackLabel="No Art"
                  testId="master-coverArt-selected"
                />
              ) : (
                <div className="w-14 h-14 rounded-lg border-2 border-dashed border-amber-400/40 flex flex-col items-center justify-center text-amber-300 text-[10px] text-center p-1">
                  <Disc className="w-5 h-5 text-amber-400/50 mb-0.5" />
                  <span>No Art</span>
                </div>
              )}
              <div>
                {change && <span className="block text-[11px] text-amber-200">Cover changed</span>}
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
            <p className="text-[10px] text-white/50">Album metadata and artwork</p>
          </div>
        </div>

        {/* Right Action Icons */}
        <div className="flex items-center gap-2">
          {commitQueueHostRef && <div ref={commitQueueHostRef} />}
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
        <div className={`relative shrink-0 overflow-hidden border-r border-white/10 bg-[#121318] motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-in-out ${showFilters ? 'w-52 xl:w-64' : 'w-9'}`}>
          <div className="relative z-10 flex h-10 items-center justify-end gap-1 border-b border-white/[0.06] px-1">
            {showFilters && <span className="mr-auto pl-2 text-xs font-semibold text-zinc-300">Filters</span>}
            {showFilters && hasActiveFilters && (
              <button
                type="button"
                aria-label="Reset Filters"
                title="Reset Filters"
                onClick={() => changeFilter({ priorities: [], categories: [] })}
                className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                <RotateCcw aria-hidden="true" className="h-3 w-3" />
                <span>Reset</span>
              </button>
            )}
            <button
              ref={filterToggleRef}
              type="button"
              aria-label={filterToggleLabel}
              aria-controls="curate-filters"
              aria-expanded={showFilters}
              title={filterToggleLabel}
              className={`cursor-pointer rounded-lg p-1.5 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline focus-visible:outline-cyan-300 ${
                !showFilters && hasActiveFilters
                  ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30'
                  : 'text-white/70 aria-expanded:bg-white/[0.08] aria-expanded:text-white'
              }`}
              onClick={() => setShowFilters(visible => !visible)}
            >
              <PanelLeft aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <div inert={!showFilters}
            className={`absolute bottom-0 right-0 top-10 flex motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-in-out ${showFilters ? '' : '-translate-x-9'}`}>
            <CurateFilterBar summary={problemSummary} settings={prioritySettings} filter={filter}
              albums={albums} onFilterChange={changeFilter} hideReset />
          </div>
        </div>
        {/* Left Album Rail */}
        <aside className="w-60 border-r border-white/[0.08] bg-[#0A0B0E] flex flex-col shrink-0 xl:w-72">
          <div className="p-3 border-b border-white/[0.06] flex items-center justify-end">
            <button
              onClick={openCommitPreview}
              disabled={isBatchCommitting || isPlaying || Boolean(stagingAlbumId || queuingAlbumId)}
              className={`px-2.5 py-1 rounded font-semibold text-[11px] cursor-pointer transition-colors shadow-sm disabled:opacity-50 ${
                stagedIds.size > 0
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-black'
                  : 'bg-white/[0.06] hover:bg-white/[0.1] text-zinc-400 border border-white/10'
              }`}
            >
              {isBatchCommitting
                ? 'Preparing queue…'
                : `Commit All (${stagedIds.size})`}
            </button>
          </div>

          <div className="shrink-0 space-y-2 border-b border-white/[0.06] px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  {filter.categories.length === 1 ? (
                    <>
                      <span className="shrink-0 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">
                        {prioritySettings[filter.categories[0]]}
                      </span>
                      <span className="truncate">{labels[filter.categories[0]]}</span>
                    </>
                  ) : (
                    <span className="truncate">Albums requiring attention</span>
                  )}
                </h2>
                <p className="mt-0.5 text-[11px] text-zinc-400 tabular-nums">
                  {filteredAlbums.length} {filteredAlbums.length === 1 ? 'album' : 'albums'} • {filteredTrackCount} {filteredTrackCount === 1 ? 'track' : 'tracks'}
                </p>
              </div>
              {!showFilters && (
                <button
                  type="button"
                  onClick={() => setShowFilters(true)}
                  className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-white/15 bg-white/[0.05] px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.1] hover:text-white"
                >
                  <SlidersHorizontal aria-hidden="true" className="h-3 w-3" />
                  <span>Open Filters</span>
                </button>
              )}
            </div>

            {hasActiveFilters && (
              <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
                {filter.priorities
                  .filter(tier => !filter.categories.some(cat => prioritySettings[cat] === tier))
                  .map(tier => (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => changeFilter({ ...filter, priorities: filter.priorities.filter(p => p !== tier) })}
                      className="inline-flex items-center gap-1 rounded-full border border-rose-400/30 bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-200 transition-colors hover:bg-rose-500/25"
                    >
                      <span>{tier} · {priorityChipNames[tier] ?? tier}</span>
                      <X aria-hidden="true" className="h-2.5 w-2.5" />
                    </button>
                  ))}
                {filter.categories.map(categoryId => (
                  <button
                    key={categoryId}
                    type="button"
                    onClick={() => changeFilter({ ...filter, categories: filter.categories.filter(c => c !== categoryId) })}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-400/25"
                  >
                    <span className="truncate">
                      {labels[categoryId]} ({problemSummary.categoryCounts[categoryId].count})
                    </span>
                    <X aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
                  </button>
                ))}
                {filter.selectedAlbumIdFilter && (
                  <button
                    type="button"
                    onClick={() => changeFilter({ ...filter, selectedAlbumIdFilter: undefined })}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-medium text-cyan-200 transition-colors hover:bg-cyan-500/25"
                  >
                    <span className="truncate">
                      {albums.find(a => a.id === filter.selectedAlbumIdFilter)?.title ?? 'Selected album'}
                    </span>
                    <X aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
                  </button>
                )}
              </div>
            )}

            <CurateAlbumSearch
              summary={problemSummary}
              settings={prioritySettings}
              filter={filter}
              albums={albums}
              onFilterChange={changeFilter}
              placeholder={`Search within ${filteredAlbums.length} ${filteredAlbums.length === 1 ? 'album' : 'albums'}...`}
            />
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
            {displayedAlbums.map((alb) => {
              const discriminator = formatAlbumDiscriminator(alb)
              return (
                <div
                  key={alb.id}
                  data-testid="curate-album-item"
                  data-album-id={alb.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedAlbumId === alb.id}
                  onClick={() => { directSelection.current = null; setSelectedAlbumId(alb.id) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      directSelection.current = null
                      setSelectedAlbumId(alb.id)
                    }
                  }}
                  className={`p-3.5 transition-colors cursor-pointer flex gap-3 ${
                    selectedAlbum?.id === alb.id
                      ? 'bg-white/[0.08] border-l-2 border-[#D4AF37]'
                      : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <CurateArtworkThumbnail
                    src={alb.coverArt.selected || alb.coverArt.apple || alb.coverArt.local || null}
                    alt={alb.currentTitle}
                    className="w-12 h-12 rounded-lg shrink-0 border border-white/10"
                    testId={`curate-rail-cover-${alb.id}`}
                  />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-xs font-medium text-white truncate">{alb.albumTitle.selected || alb.currentTitle}</h3>
                    <p className="text-[11px] text-white/50 truncate mt-0.5">
                      {alb.albumArtist.selected || 'Unknown Artist'} • {alb.year.selected || '—'}
                      {discriminator ? ` • ${discriminator}` : ''}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.06] text-white/60">
                        {alb.tracks.length} {alb.tracks.length === 1 ? 'track' : 'tracks'}
                      </span>
                      {alb.offsetApplied !== undefined && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#D4AF37]/20 text-[#D4AF37] font-mono">
                          +{alb.offsetApplied} offset
                        </span>
                      )}
                      {stagedIds.has(alb.id) && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-medium">
                          ✓ Staged
                        </span>
                      )}
                      {filter.categories.length !== 1 && problemSummary.albumProblems.get(alb.id)?.filter(problem =>
                        (!filter.priorities.length || filter.priorities.includes(problem.priority)) &&
                        (!filter.categories.length || filter.categories.includes(problem.categoryId)),
                      ).sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 1).map(problem => (
                        <span key={problem.categoryId} title={labels[problem.categoryId]}
                          className="min-w-0 truncate rounded bg-amber-500/20 px-1.5 text-[9px] text-amber-300">
                          {problem.priority} · {labels[problem.categoryId]}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}

            {filteredAlbums.length === 0 && (
              <div className="p-8 text-center text-white/40 text-xs">
                {resolveFilterTransition(albums, problemSummary, filter, 'batch_resolved').filterCompleted ? (
                  <>All albums matching current filters are resolved
                    <button className="block mx-auto mt-2 text-cyan-300" onClick={() => changeFilter({ priorities: [], categories: [] })}>Reset Filters</button>
                  </>
                ) : 'No albums need curation'}
              </div>
            )}
          </div>
        </aside>

        {/* Center Reconciliation Workbench */}
        {selectedAlbum ? (
          <main className="flex-1 flex flex-col bg-[#0E0F12] overflow-y-auto p-6 space-y-6 pb-48">


            {/* Header for Active Album */}
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-white/[0.06] text-white/60 uppercase">
                  {selectedAlbum.folderName}
                </span>
                <span className="text-xs text-white/40">•</span>
              </div>

              <div className="flex items-center gap-2.5">
                {Boolean(problemSummary.albumProblems.get(selectedAlbum.id)?.length) && (
                  <label className="text-xs text-white/70">
                    <select aria-label="Dismiss Problem" value="" onChange={event =>
                      updateDismissals(saveDismissedProblem(selectedAlbum.id, event.target.value as CurateProblemCategoryId, selectedAlbum.rawTracks))
                    } className="rounded border border-white/10 bg-zinc-900 p-1.5">
                      <option value="" disabled>Dismiss Problem</option>
                      {problemSummary.albumProblems.get(selectedAlbum.id)?.map(problem =>
                        <option key={problem.categoryId} value={problem.categoryId}>{labels[problem.categoryId]}</option>
                      )}
                    </select>
                  </label>
                )}
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
                  disabled={Boolean(selectedAlbum.draftBasedOn || stagingAlbumId || queuingAlbumId || selectedCommitReconciled || isBatchCommitting)}
                  data-testid="btn-stage-next"
                  className="px-3.5 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-white font-medium text-xs border border-white/20 transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                  title="Save changes and keep in queue for later review"
                >
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{stagingAlbumId === selectedAlbum.id ? 'Saving draft…' : 'Stage & Next'}</span>
                </button>

                {/* Queue writes for this album */}
                <button
                  onClick={handleCommitAlbum}
                  disabled={Boolean(selectedAlbum.draftBasedOn || stagingAlbumId || queuingAlbumId || selectedCommitConfirmed || isBatchCommitting)}
                  data-testid="btn-commit-album"
                  className="px-4 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#c29e2f] text-black font-semibold text-xs transition-colors cursor-pointer shadow-md flex items-center gap-1.5 disabled:opacity-50"
                  title="Queue the selected metadata for background tag writing"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{queuingAlbumId ? 'Queuing…' : 'Commit Album'}</span>
                </button>
              </div>
            </div>

            {selectedCommitStatuses.has('failed') && (
              <div role="status" className="flex flex-wrap gap-2 px-4 text-xs text-amber-200">
                <span>{selectedCommitError || 'Tag writing failed.'}</span>
                <button className="underline" onClick={async () => {
                  try {
                    const count = await tauriBridge.commitRetryCurateItems(
                      selectedCommitRows.filter(row => row.status === 'failed').map(row => row.id),
                    )
                    await onCommitQueued?.()
                    showToast(count ? `Queued ${count} failed track(s) for retry.` : 'No failed tracks remain to retry.')
                  } catch (err) {
                    showToast(`Could not retry failed tracks: ${String(err)}`)
                  }
                }}>Retry failed tracks</button>
              </div>
            )}
            {loadedDrafts.current.get(selectedAlbum.id)?.restored && !loadedDrafts.current.get(selectedAlbum.id)?.draft.revision && !selectedCommitConfirmed && (
              <p role="status" className="px-4 text-xs text-amber-200">
                Saved provider proposals without verified dependencies need review. Refresh evidence to evaluate them against this album.
              </p>
            )}
            {Boolean(selectedAlbum.heldTrackEdits?.length) && (
              <p role="status" className="px-4 text-xs text-amber-200">
                Some track edits are held for review because their original tracks are absent from this album.
              </p>
            )}
            {selectedAlbum.draftBasedOn && (
              <div role="alert" className="px-4 py-3 text-xs bg-amber-500/10 text-amber-200">
                Local metadata changed since this draft was saved. Review the Local and Selected columns before staging or committing.
                <button
                  className="ml-3 underline"
                  onClick={() => setAlbumItems(prev => {
                    const album = prev.get(selectedAlbum.id)
                    return album ? new Map(prev).set(album.id, { ...album, draftBasedOn: undefined }) : prev
                  })}
                >
                  Keep Selected Output against current tags
                </button>
              </div>
            )}
            {draftSaveError === selectedAlbum.id && (
              <div role="alert" className="px-4 py-3 text-xs bg-red-500/10 text-red-200">
                Curate could not save this draft.
                <button
                  className="ml-3 underline"
                  onClick={() => void saveAlbumDraft(selectedAlbum).catch(() => {})}
                >
                  Retry save
                </button>
              </div>
            )}
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
                    data-testid="input-steer-album"
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
                    data-testid="input-steer-artist"
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
                    placeholder="Paste Apple Music / Spotify / Discogs / MusicBrainz URL for AI Grounding..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-white placeholder:text-white/40 text-xs focus:outline-none focus:border-cyan-400/60"
                  />
                  <Link2 className="w-3.5 h-3.5 text-cyan-400 absolute left-2.5 top-2.5 pointer-events-none" />
                </div>

                {/* Fetch & Anchor Button */}
                <button
                  type="submit"
                  data-testid="btn-fetch-anchor"
                  disabled={isSteeringLoading || (!steerAlbum.trim() && !steerGroundingUrl.trim())}
                  className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-md shadow-cyan-500/20 disabled:opacity-50 transition-all shrink-0"
                >
                  {isSteeringLoading ? (
                    <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  <span>Refresh Evidence</span>
                </button>

                <SteerProgressBar
                  phase={traceCurrentPhase}
                  message={traceProgressMessage}
                  outcomeStatus={traceOutcomeStatus}
                  isFetching={isSteeringLoading || traceStatus === 'fetching'}
                  evidenceSaveFailed={traceStatus === 'save_error'}
                  cancelled={traceStatus === 'cancelled'}
                  onCancel={isSteeringLoading ? cancelRefresh : undefined}
                  onToggleRationale={toggleTraceDrawer}
                  hasTrace={Boolean(selectedAlbum)}
                />
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

              const currentGenreLower = currentGenre.toLowerCase();
              const langLower = detectedLanguage.toLowerCase();
              const alreadyMatchesLang = currentGenreLower.includes(langLower) && (currentGenreLower.includes('soundtrack') || currentGenreLower.includes('film') || currentGenreLower.includes('music'));

              if (!isSoundtrackLike || currentGenre === targetSoundtrackGenre || alreadyMatchesLang || dismissedPrompts.has('prompt_genre')) {
                return null;
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

              {selectedChanges && (
                <SelectedOutputCard albumCount={selectedChanges.albumCount} trackCount={selectedChanges.trackCount} />
              )}
              <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#121318]/40 shadow-xl">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.02] text-white/40 text-[11px] font-mono">
                      <th className="py-2.5 px-4 w-32">Field</th>
                      <th className="py-2.5 px-4 w-1/5">Local File Tag</th>
                      <th className="py-2.5 px-4 w-1/5 text-[#D4AF37]">Apple Music Master</th>
                      <th className="py-2.5 px-4 w-1/5">MusicBrainz Archive</th>
                      <th className="py-2.5 px-4 w-1/5 text-cyan-400">Gemini AI Master</th>
                      <th className="py-2.5 px-4 w-1/4 text-emerald-400 font-semibold bg-emerald-500/[0.03]">
                        Selected Output
                        <button type="button" onClick={acceptSuggestions}
                          disabled={Boolean(stagingAlbumId || queuingAlbumId || isBatchCommitting)}
                          className="mt-1 block rounded border border-emerald-500/40 px-2 py-1 text-[10px] hover:bg-emerald-500/15 disabled:opacity-50">
                          Accept Suggestions
                        </button>
                      </th>
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
                      Candidate Sequence Offset {selectedAlbum.offsetApplied > 0 ? `+${selectedAlbum.offsetApplied}` : selectedAlbum.offsetApplied}
                    </span>
                  )}
                </div>

                {/* Bulk Adoption Actions */}
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-white/40 mr-1">Use Track Artist Credits</span>
                  <button
                    onClick={() => handleAdoptAllTracks('apple')}
                    className="px-2 py-1 rounded bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30 cursor-pointer"
                  >
                    Apple Music
                  </button>
                  <button
                    onClick={() => handleAdoptAllTracks('musicbrainz')}
                    className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-white/80 border border-white/15 cursor-pointer"
                  >
                    MusicBrainz
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
                    {selectedAlbum.tracks.map((trk, idx) => {
                      const savedAppleTrack = savedAppleEvidence?.albumId === selectedAlbum.id
                        ? savedAppleEvidence.trackRows.get(trk.trackId) : undefined
                      const hasLiveAppleTrack = Boolean(trk.appleTitle || trk.appleArtists)
                      const appleTitle = hasLiveAppleTrack ? trk.appleTitle : savedAppleTrack?.title
                      const appleCredit = hasLiveAppleTrack ? trk.appleArtists : savedAppleTrack?.artist
                      const appleConflict = trk.providerDecisions?.some(decision =>
                        decision.mapping?.provider === 'apple' && decision.mapping.status === 'conflicted') ||
                        (savedAppleTrack?.conflicted && (!hasLiveAppleTrack ||
                          (appleTitle === savedAppleTrack.title && appleCredit === savedAppleTrack.artist)))
                      const hasAppleTrack = Boolean(appleTitle || appleCredit)
                      const isEditing = editingTrack?.trackId === trk.trackId
                      const change = selectedChanges?.tracks.get(trk.trackId)
                      const hasChange = change && Object.values(change).some(Boolean)
                      return (
                        <tr key={trk.trackId} data-testid={`track-row-${idx}`} className="hover:bg-white/[0.015] transition-colors">
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
                            data-testid={`track-cell-${idx}-local`}
                            onClick={() => handleSelectTrack(trk.trackId, {
                              title: trk.localTitle,
                              artists: trk.localArtists,
                              source: 'local_fallback',
                            })}
                            className="py-3 px-3 cursor-pointer text-white/60 hover:text-white transition-colors"
                          >
                            <div className="font-medium text-white/80">{trk.localTitle}</div>
                            <div className="text-[10px] text-white/40 font-mono">{trk.localArtists || 'Unknown'}</div>
                            {(() => {
                              const rawTrk = selectedAlbum.rawTracks?.find((t) => t.id === trk.trackId);
                              const effectiveFilePath = trk.filePath || rawTrk?.filePath;
                              const effectiveFileName =
                                trk.fileName ||
                                (rawTrk as any)?.fileName ||
                                (effectiveFilePath ? effectiveFilePath.replace(/\\/g, '/').split('/').pop() : '');
                              const effectiveFormat = trk.format || rawTrk?.format;
                              const effectiveBitDepth = trk.bitDepth || rawTrk?.bitDepth;
                              const effectiveSampleRate = trk.sampleRate || rawTrk?.sampleRate;

                              if (!effectiveFileName) return null;

                              return (
                                <div
                                  className="flex items-center gap-1.5 text-[10px] text-neutral-400 font-mono mt-1 max-w-[280px] select-text"
                                  title={effectiveFilePath || effectiveFileName}
                                >
                                  <FileText className="w-3 h-3 text-neutral-500 shrink-0" />
                                  <span data-testid="local-track-filename" className="truncate">{effectiveFileName}</span>
                                  {(effectiveFormat || effectiveBitDepth) && (
                                    <span className="text-[9px] text-neutral-400 border border-neutral-700 rounded px-1 shrink-0">
                                      {effectiveFormat?.toUpperCase() || ''}{effectiveBitDepth ? ` ${effectiveBitDepth}b` : ''}{effectiveSampleRate ? `/${Math.round(effectiveSampleRate / 1000)}k` : ''}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </td>

                          {/* Apple Music Cell */}
                          <td
                            data-testid={`track-cell-${idx}-apple`}
                            onClick={hasAppleTrack ? () => {
                              handleSelectTrack(trk.trackId, {
                                title: appleTitle,
                                artists: appleCredit,
                                source: 'single_provider_match',
                              })
                            } : undefined}
                            className={`py-3 px-3 text-white/70 ${hasAppleTrack ? 'cursor-pointer hover:text-[#D4AF37] transition-colors' : ''}`}
                          >
                            <div className="font-medium text-white/70">{appleTitle || '—'}</div>
                            <div className="text-[10px] text-white/50 mt-0.5">{appleCredit || '—'}</div>
                            {appleConflict ? (
                              <div className="mt-1 text-[10px] text-amber-300">Conflicting match · Review needed</div>
                            ) : !hasLiveAppleTrack && savedAppleTrack && (
                              <div className="mt-1 text-[10px] text-white/50">Saved candidate</div>
                            )}
                          </td>

                          {/* MusicBrainz Cell */}
                          <td
                            data-testid={`track-cell-${idx}-musicbrainz`}
                            onClick={() => {
                              if (trk.mbTitle || trk.mbArtists) {
                                handleSelectTrack(trk.trackId, {
                                  title: trk.mbTitle,
                                  artists: trk.mbArtists,
                                  source: 'single_provider_match',
                                })
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/60 hover:text-white transition-colors"
                          >
                            <div className="font-medium text-white/60">
                              {trk.mbTitle || (trk.mbArtists ? trk.matchedTitle : '—')}
                            </div>
                            <div className="text-[10px] text-white/40 mt-0.5">
                              {trk.mbArtists || '—'}
                            </div>
                          </td>

                          {/* Gemini AI Cell */}
                          <td
                            data-testid={`track-cell-${idx}-ai`}
                            onClick={() => {
                              if (trk.aiTitle || trk.aiArtists) {
                                handleSelectTrack(trk.trackId, {
                                  title: trk.aiTitle,
                                  artists: trk.aiArtists,
                                  source: 'ai_synthesized',
                                })
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/70 hover:text-cyan-300 transition-colors"
                          >
                            <div className="font-medium text-cyan-300">
                              {trk.aiTitle || (trk.aiArtists ? trk.matchedTitle : '—')}
                            </div>
                            <div className="text-[10px] text-cyan-200/60 mt-0.5">
                              {trk.aiArtists
                                ? trk.aiArtists
                                : (trk.aiTitle && selectedAlbum.albumArtist.ai ? `${selectedAlbum.albumArtist.ai} (Composer)` : '—')}
                            </div>
                          </td>

                          {/* Selected Output Cell */}
                          <td data-testid={`track-cell-${idx}-selected`} className={`py-3 px-3 border-l border-white/[0.06] ${hasChange ? 'bg-amber-500/[0.07]' : 'bg-emerald-500/[0.03]'}`}>
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
                                  <div className="min-w-0">
                                    <div className="break-words font-medium text-emerald-300">{trk.matchedTitle}</div>
                                    <SelectedChangeNote change={change?.title} />
                                  </div>
                                  <button
                                    onClick={() => {
                                      setEditingTrack({ trackId: trk.trackId, field: 'title' })
                                      setTrackEditValue(trk.matchedTitle || '')
                                    }}
                                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-1 hover:bg-white/[0.08] rounded text-white/60 transition-opacity cursor-pointer"
                                    title="Edit Title"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                </div>
                                <div className="flex items-center justify-between gap-2 mt-0.5">
                                  {trk.matchedArtists ? (
                                    <div className="min-w-0 text-[11px] text-white/80">
                                      <div className="break-words">{trk.matchedArtists}</div>
                                      <SelectedChangeNote change={change?.singers} />
                                    </div>
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
                                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-1 hover:bg-white/[0.08] rounded text-white/60 transition-opacity cursor-pointer"
                                    title="Edit Singers"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                </div>

                                {trk.providerDecisions?.filter(decision => decision.status === 'needs_review').map((decision, index) => (
                                  <p key={index} className="mt-1 text-[10px] text-amber-300">
                                    {decision.proposedValue} · {decision.reason}
                                  </p>
                                ))}

                                {/* Progressive Disclosure Compilation Provenance Sub-Row */}
                                {(isCompilationAlbum || change?.originalAlbum || change?.originalYear) && (
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
                                      <>
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
                                          className="opacity-0 group-hover/prov:opacity-100 group-focus-within/prov:opacity-100 p-0.5 hover:bg-white/[0.08] rounded text-white/50 transition-opacity cursor-pointer"
                                          title="Edit Original Film & Year (Enter)"
                                        >
                                          <Edit2 className="w-2.5 h-2.5" />
                                        </button>
                                      </div>
                                      <SelectedChangeNote change={change?.originalAlbum} label="Original film" />
                                      <SelectedChangeNote change={change?.originalYear} label="Original year" />
                                      </>
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
          <div className="flex-1 flex items-center justify-center gap-3 text-white/50 text-sm">
            {activeItemId ? (
              draftLoad?.id === activeItemId && draftLoad.failed ? (
                <>
                  <span role="alert">Curate could not load the saved draft.</span>
                  <button className="underline" onClick={() => {
                    setDraftLoad(null)
                    setDraftLoadAttempt(attempt => attempt + 1)
                  }}>Retry</button>
                </>
              ) : <span role="status">Loading Selected Output…</span>
            ) : 'Select an album from the left queue to begin reconciliation'}
          </div>
        )}
      </div>

      <CurateCommitPreviewModal isOpen={preview !== null} albumsToCommit={preview ?? []}
        isTransportBusy={isPlaying} onCancel={() => { if (!isBatchCommitting) setPreview(null) }}
        onConfirm={ids => void confirmBatch(ids)} />
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

            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-white/70">Dismissed Problem Exemptions</h3>
              {Array.from(albumItems.values()).flatMap(album => {
                const keys = curateReviewKeys(album.id, album.rawTracks)
                const categories = (keys[1] && dismissedProblems[keys[1]]) || dismissedProblems[album.id] || []
                return categories.map(category => (
                  <div key={`${album.id}:${category}`} className="flex justify-between gap-3 text-xs text-white/70">
                    <span>{album.currentTitle} · {labels[category]}</span>
                    <button type="button" className="text-cyan-300" onClick={() =>
                      updateDismissals(removeDismissedProblem(album.id, category, album.rawTracks))
                    }>Restore</button>
                  </div>
                ))
              })}
            </section>
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

      <CurationDecisionTraceDrawer
        albumId={selectedAlbum?.id}
        lastEvidenceId={lastEvidenceId}
        isOpen={isTraceDrawerOpen}
        onClose={closeTraceDrawer}
        trace={curationTrace}
        onResumeFetch={handleFetchAndAnchor}
        isResuming={isTraceResuming}
      />
    </div>
  )
}
export default UnifiedCurateCockpit

