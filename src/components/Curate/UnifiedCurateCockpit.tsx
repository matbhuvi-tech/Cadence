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
  Folder,
  FileText,
  Disc,
} from 'lucide-react'
import { CurateArtworkThumbnail } from './CurateArtworkThumbnail'
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
  ConsensusFieldSource,
} from '../../core/types'
import { graphEngine } from '../../core/graphEngine'
import { getCurateChange, isReconciledCurateDraft, makeCurateCommitItems, prepareTier1Commit, projectCurateCommits, type CurateCommitRow, type CurateValueChange } from '../../core/curateCommit'
import type { EnqueueBatchPayload } from '../../types/commit'
import { CurateCommitOutcomes } from './CurateCommitOutcomes'
import {
  captureCurateDraft, restoreCurateDraft, mergeCurateProposal, selectCurateTrackFields,
  type CurateDraftTrack,
} from '../../core/curateDraft'
import { curationQueueService, AlbumCurationQueueItem } from '../../services/curationQueueService'
import { federatedResolversService } from '../../services/federatedResolvers'
import { compilationCanonicalizerService } from '../../services/compilationCanonicalizerService'
import { behavioralLearningService } from '../../services/behavioralLearningService'
import { tauriBridge } from '../../services/tauriBridge'
import { provenanceCacheService } from '../../services/provenanceCacheService'
import { useCurationTrace } from '../../hooks/useCurationTrace'
import { captureTrackDecisions, curateMatchingContext } from '../../services/curateEvidenceService'
import { SteerProgressBar } from './SteerProgressBar'
import { CurationDecisionTraceDrawer } from './CurationDecisionTraceDrawer'
import { resolveGemini } from '../../services/geminiClient'
import type { CompilationProvenanceResult } from '../../core/types'
import {
  cleanRipNoise,
  cleanConsensusTitle,
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
  commitRows?: CurateCommitRow[]
  onCommitQueued?: () => Promise<void>
  supersededCommitIds?: ReadonlySet<string>
  isPlaying?: boolean
}

interface AlbumWorkItem {
  id: string
  userOverridden?: boolean
  leadTrackId?: string
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
  tracks: CurateDraftTrack[]
  draftBasedOn?: string
  rawRelease?: Release
  rawTracks: Track[]
}

const emptyAuditIssues: AuditIssue[] = []
const albumReviewFields = ['albumTitle', 'albumArtist', 'composer', 'year', 'coverArt', 'genre'] as const

function SelectedChangeNote({ change, label }: { change: CurateValueChange | null | undefined; label?: string }) {
  if (!change) return null
  return (
    <span className="block break-words text-[11px] leading-snug text-amber-200">
      {label && `${label} · `}
      {change.previous === undefined ? 'Added · No local value' : `Was: ${change.previous}`}
    </span>
  )
}

// Direct Apple Music URL and Slug Resolver
async function resolveDirectAppleMusicCandidate(collectionId: string, signal: AbortSignal): Promise<{
  releaseTitle: string
  artistCredit: string
  composer: string
  releaseYear?: number
  genre: string
  coverArtUrl: string
  tracks: Array<{ trackNumber: number; trackName: string; artistName?: string }>
} | null> {
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

  const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&country=in&entity=song`, { signal, redirect: 'error' })
  if (!res.ok) return null
  const data = await res.json()
  return data.resultCount > 0 ? parseResults(data.results) : null
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
  auditIssues = emptyAuditIssues,
  initialSelectedAlbumId,
  navigationAnchor,
  onReturnToAnchor,
  onOpenCommitModal,
  onBackToLibrary,
  showToast,
  commitRows,
  onCommitQueued,
  supersededCommitIds,
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
  const batchAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    if (isPlaying) batchAbort.current?.abort()
  }, [isPlaying])
  useEffect(() => () => batchAbort.current?.abort(), [])

  // Compilation Provenance State & Abort Controller
  const [isResolvingProvenance, setIsResolvingProvenance] = useState(false)
  const [editingProvenanceTrackId, setEditingProvenanceTrackId] = useState<string | null>(null)
  const [provenanceEditFilm, setProvenanceEditFilm] = useState('')
  const [provenanceEditYear, setProvenanceEditYear] = useState('')
  const provenanceAbortRef = useRef<AbortController | null>(null)

  // 3. Build Rich Album Work Items
  const [albumItems, setAlbumItems] = useState<Map<string, AlbumWorkItem>>(new Map())
  const previousDraftItems = useRef(albumItems)
  const loadedDrafts = useRef(new Map<string, {
    saved: string
    restored: boolean
    pending?: { serialized: string; write: Promise<void> }
  }>())
  const [draftLoad, setDraftLoad] = useState<{ id: string; failed: boolean } | null>(null)
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0)
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null)
  const [stagingAlbumId, setStagingAlbumId] = useState<string | null>(null)
  const [queuingAlbumId, setQueuingAlbumId] = useState<string | null>(null)

  // Initialize and populate album items - PRESERVES user edits across library refreshes
  useEffect(() => {
    const tracksByRelease = new Map<string, Track[]>()
    for (const track of tracks) {
      const releaseTracks = tracksByRelease.get(track.releaseId)
      if (releaseTracks) releaseTracks.push(track)
      else tracksByRelease.set(track.releaseId, [track])
    }
    setAlbumItems((prev) => {
      const next = new Map(prev)

      for (const qItem of baseQueue) {
        // If album already exists in state, PRESERVE IT and do not overwrite user choices
        if (next.has(qItem.albumId)) {
          continue
        }

        const rel = releases.find((r) => r.id === qItem.albumId)
        const albTracks = (tracksByRelease.get(qItem.albumId) ?? []).sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))

        if (!rel && albTracks.length === 0) continue

        const rawTitle = rel?.title || albTracks[0]?.albumTitle || qItem.albumTitle || 'Unknown Album'
        const rawComposer = rel?.composerName || albTracks.find((t) => t.composerName)?.composerName || ''

        // Multi-track artist consensus: inspect if tracks have multiple distinct performers
        // or an explicit common container tag rather than blindly taking the first track's artist
        const trackArtists = albTracks.map((t) => (t.artistCredit || '').trim()).filter(Boolean)
        const distinctTrackArtists = Array.from(new Set(trackArtists))
        const hasExplicitAlbumArtist = (albTracks.find((t) => (t as any).albumArtist) as any)?.albumArtist

        let resolvedRawArtist: string
        if (hasExplicitAlbumArtist) {
          resolvedRawArtist = hasExplicitAlbumArtist
        } else if (rawComposer && (distinctTrackArtists.length > 1 || !rel?.artistCredit)) {
          // If tracks have diverse performers (e.g. playback singers) or rel artist is missing, promote composer
          resolvedRawArtist = rawComposer
        } else if (distinctTrackArtists.length === 1) {
          // Unanimous single performer across all tracks
          resolvedRawArtist = distinctTrackArtists[0]
        } else {
          resolvedRawArtist = rel?.artistCredit || albTracks[0]?.artistCredit || 'Unknown Artist'
        }

        const rawArtist = resolvedRawArtist
        const rawYear = rel?.releaseYear || albTracks[0]?.canonicalReleaseYear || albTracks[0]?.originalYear || (albTracks[0] as any)?.releaseYear
        const rawArt =
          rel?.coverArtUrl ||
          rel?.artwork?.frontCoverUrl ||
          (rel as any)?.front_cover_url ||
          (rel as any)?.frontCoverUrl ||
          (albTracks[0] as any)?.coverArtUrl ||
          (albTracks[0] as any)?.artworkUrl ||
          (albTracks[0] as any)?.frontCoverUrl ||
          getCuratedAlbumArtwork(rawTitle, rawComposer || rawArtist) ||
          (albTracks[0]?.id ? `cadence:cover://${albTracks[0].id}` : '')
        const trackGenre = (albTracks[0] as any)?.genre
        const rawGenre = rel?.genreTags?.[0] || trackGenre || 'Soundtrack'

        // Detect album primary language for accurate conventions
        const initDetectedLang = detectLanguage({
          title: rawTitle,
          artistCredit: rawArtist,
          composerName: rawComposer,
          genreTags: rel?.genreTags || (trackGenre ? [trackGenre] : []),
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
          filePath: t.filePath,
          fileName: (t as any).fileName || (t.filePath ? t.filePath.replace(/\\/g, '/').split('/').pop() : undefined),
          format: t.format,
          bitDepth: t.bitDepth,
          sampleRate: t.sampleRate,
        }))

        const emptyArtistRule = applyConsensusEmptyStateRule(rawArtist, {})
        const albumConfidence = qItem.confidenceScore ?? (qItem.defectSeverity === 'info' ? 0.90 : 0.60)
        const isDefectiveArtist = isDefectiveArtistTag(rawArtist, rawTitle)
        const hasRipNoise = Boolean(rawTitle && cleanRipNoise(rawTitle).toLowerCase() !== rawTitle.toLowerCase())
        const hasValidYear = Boolean(rawYear && Number(rawYear) >= 1900)
        const isClean =
          !qItem.requiresDisambiguation &&
          albumConfidence >= 0.85 &&
          !isPlaceholderTag(rawArtist) &&
          !isPlaceholderTag(rawTitle) &&
          !isDefectiveArtist &&
          !hasRipNoise &&
          hasValidYear

        const finalAlbumArtist = conv.albumArtist || (emptyArtistRule.selected !== '' ? learnedArtist : '')
        const finalGenre = conv.genre || rawGenre

        next.set(qItem.albumId, {
          id: qItem.albumId,
          folderName: qItem.folderName || rel?.folderPath || albTracks[0]?.folderName || '',
          currentTitle: rawTitle,
          tier: isClean ? 'tier1' : 'tier2',
          status: 'staged',
          confidenceScore: albumConfidence,
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

      if (initialSelectedAlbumId && !prev.has(initialSelectedAlbumId)) {
        const requested = next.get(initialSelectedAlbumId)
        if (requested) setActiveTier(requested.tier)
      }

      return next
    })
  }, [baseQueue, releases, tracks])

  const eligibleIds = useMemo(() => new Set(baseQueue.map(item => item.albumId)), [baseQueue])
  const activeItem = selectedAlbumId && eligibleIds.has(selectedAlbumId) ? albumItems.get(selectedAlbumId) : undefined
  useEffect(() => {
    if (activeItem || eligibleIds.size === 0) return
    const eligible = Array.from(albumItems.values()).filter(item => eligibleIds.has(item.id))
    const first = eligible.find(item => item.tier === activeTier) ?? eligible[0]
    if (first) {
      setSelectedAlbumId(first.id)
      setActiveTier(first.tier)
    }
  }, [activeItem, activeTier, albumItems, eligibleIds])
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
      const restored = draft ? restoreCurateDraft(activeItem, draft) : activeItem
      const snapshot = draft ? { ...captureCurateDraft(restored), baseline: draft.baseline } : initial
      if (draft) {
        setAlbumItems(prev => {
          const current = prev.get(activeItemId)
          if (!current) return prev
          return new Map(prev).set(activeItemId, {
            ...restoreCurateDraft(current, draft),
            draftBasedOn: initial.baseline === draft.baseline ? undefined : draft.baseline,
          })
        })
      }
      loadedDrafts.current.set(activeItemId, {
        saved: JSON.stringify(snapshot),
        restored: Boolean(draft),
      })
      setDraftLoad({ id: activeItemId, failed: false })
    }).catch(err => {
      if (cancelled) return
      console.warn('[UnifiedCurateCockpit] Draft load failed:', err)
      setDraftLoad({ id: activeItemId, failed: true })
    })
    return () => { cancelled = true }
  }, [activeItemId, draftLoadAttempt])

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
  const reconciledAlbumIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of loadedDrafts.current.keys()) {
      const album = albumItems.get(id)
      if (!album || commitsByTrack.get(album.tracks[0]?.trackId)?.status !== 'completed') continue
      if (isReconciledCurateDraft(captureCurateDraft(album), commitsByTrack)) ids.add(id)
    }
    return ids
  }, [albumItems, commitsByTrack, draftLoad])
  const selectedCommitReconciled = Boolean(selectedAlbum && reconciledAlbumIds.has(selectedAlbum.id))
  const selectedCommitStatuses = new Set(selectedCommitRows.map(row => row.status))
  const selectedCommitError = selectedCommitRows.find(row => row.status === 'failed' && row.errorMessage)?.errorMessage
  const selectedCommitStatus = selectedCommitStatuses.has('failed')
    ? (selectedCommitStatuses.has('completed') ? 'Partially written · retry needed' : 'Write failed · retry needed')
    : selectedCommitStatuses.has('in_flight') ? 'Writing tags'
    : selectedCommitStatuses.has('pending') ? 'Queued for tag writing'
    : selectedCommitStatuses.has('completed')
      ? (selectedCommitRows.length === selectedTrackIds.size ? 'Tags written' : 'Some tags written') : null

  const saveAlbumDraft = useCallback(async (album: AlbumWorkItem) => {
    const state = loadedDrafts.current.get(album.id)
    if (!state) return
    const draft = captureCurateDraft(album)
    draft.baseline = album.draftBasedOn ?? draft.baseline
    const serialized = JSON.stringify(draft)
    if (state.pending?.serialized === serialized) return state.pending.write
    if (!state.pending && state.saved === serialized) return
    const pending = { serialized, write: tauriBridge.curationSaveDraft(album.id, draft) }
    state.pending = pending
    try {
      await pending.write
      state.saved = serialized
      if (state.pending === pending) setDraftSaveError(current => current === album.id ? null : current)
    } catch (err) {
      if (state.pending === pending) setDraftSaveError(album.id)
      throw err
    } finally {
      if (state.pending === pending) state.pending = undefined
    }
  }, [])

  // The native projection has confirmed that every written track matches SQLite.
  // Adopt that baseline for the exact draft without touching a newer selection.
  useEffect(() => {
    if (!selectedAlbum || !selectedCommitReconciled) return
    const { tracks: writtenTracks, releases: writtenReleases } = projectCurateCommits(
      selectedAlbum.rawTracks,
      selectedAlbum.rawRelease ? [selectedAlbum.rawRelease] : [],
      selectedCommitRows,
    )
    const release = writtenReleases[0]
    const firstTrack = writtenTracks[0]
    const writtenArtwork = selectedCommitRows.find(row => row.artworkUrl)?.artworkUrl
    const tracksById = new Map(writtenTracks.map(track => [track.id, track]))
    const reconciled: AlbumWorkItem = {
      ...selectedAlbum,
      draftBasedOn: undefined,
      userOverridden: false,
      rawRelease: release,
      rawTracks: writtenTracks,
      albumTitle: { ...selectedAlbum.albumTitle, local: release?.title ?? firstTrack?.albumTitle ?? selectedAlbum.albumTitle.local },
      albumArtist: { ...selectedAlbum.albumArtist, local: firstTrack?.albumArtist ?? release?.artistCredit ?? selectedAlbum.albumArtist.local },
      composer: { ...selectedAlbum.composer, local: release?.composerName ?? firstTrack?.composerName ?? selectedAlbum.composer.local },
      year: { ...selectedAlbum.year, local: release?.releaseYear ?? firstTrack?.canonicalReleaseYear ?? selectedAlbum.year.local },
      genre: { ...selectedAlbum.genre, local: release?.genreTags[0] ?? selectedAlbum.genre.local },
      coverArt: writtenArtwork
        ? { ...selectedAlbum.coverArt, selected: writtenArtwork, local: writtenArtwork, userOverridden: false }
        : selectedAlbum.coverArt,
      tracks: selectedAlbum.tracks.map(track => {
        const written = tracksById.get(track.trackId)
        return written ? { ...track, localTitle: written.title, localArtists: written.artistCredit } : track
      }),
    }
    if (!selectedAlbum.draftBasedOn && !selectedAlbum.userOverridden &&
        selectedAlbum.coverArt.selected === reconciled.coverArt.selected &&
        captureCurateDraft(reconciled).baseline === captureCurateDraft(selectedAlbum).baseline) return
    setAlbumItems(prev => prev.get(selectedAlbum.id) === selectedAlbum
      ? new Map(prev).set(selectedAlbum.id, reconciled)
      : prev)
  }, [selectedAlbum, selectedCommitReconciled, commitsByTrack])

  // Also save edits from a provider operation that finishes after the user selects another album.
  useEffect(() => {
    const previous = previousDraftItems.current
    previousDraftItems.current = albumItems
    for (const id of loadedDrafts.current.keys()) {
      const album = albumItems.get(id)
      if (!album || album === previous.get(id) || album.status === 'committed') continue
      void saveAlbumDraft(album).catch(err => console.warn('[UnifiedCurateCockpit] Draft save failed:', err))
    }
  }, [albumItems, saveAlbumDraft])

  // Curation Decision Trace Hook
  const {
    status: traceStatus,
    progressMessage: traceProgressMessage,
    currentPhase: traceCurrentPhase,
    trace: curationTrace,
    outcomeStatus: traceOutcomeStatus,
    isDrawerOpen: isTraceDrawerOpen,
    isResuming: isTraceResuming,
    setIsResuming: setIsTraceResuming,
    executeFetch: executeTraceFetch,
    lastEvidenceId,
    toggleDrawer: toggleTraceDrawer,
    closeDrawer: closeTraceDrawer,
    setTrace: setCurationTrace,
  } = useCurationTrace({
    albumId: selectedAlbum?.id,
  })

  // Sync steering parameters when active album changes
  useEffect(() => {
    if (selectedAlbum) {
      setSteerAlbum(selectedAlbum.albumTitle.selected || selectedAlbum.currentTitle || '')
      setSteerArtist(selectedAlbum.composer.selected || selectedAlbum.albumArtist.selected || '')
      setSteerYear(selectedAlbum.year.selected ? String(selectedAlbum.year.selected) : '')
      setSteerGroundingUrl('')
    }
  }, [selectedAlbum?.id])

  // Count by tier
  const tier1Items = useMemo(() => {
    return Array.from(albumItems.values()).filter((a) => a.tier === 'tier1' && a.status !== 'committed' && eligibleIds.has(a.id))
  }, [albumItems, eligibleIds])

  const tier2Items = useMemo(() => {
    return Array.from(albumItems.values()).filter((a) => a.tier === 'tier2' && a.status !== 'committed' && eligibleIds.has(a.id))
  }, [albumItems, eligibleIds])

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

  // Asynchronously resolve 4-way consensus for selected album
  useEffect(() => {
    if (!selectedAlbum || !selectedAlbum.rawRelease || !selectedAlbum.rawTracks.length) return
    if (loadedDrafts.current.get(selectedAlbum.id)?.restored) return
    let isMounted = true

    const fetchConsensus = async () => {
      try {
        const release = selectedAlbum.rawRelease!
        const consensus = await executeTraceFetch(selectedAlbum.id, {
          trigger: 'initial', context: curateMatchingContext(release, selectedAlbum.rawTracks),
        }, async (signal, onProgress, record) => {
          const result = await federatedResolversService.resolve2of3ReleaseConsensus(
            release, selectedAlbum.rawTracks, false, undefined, undefined, onProgress, signal, record, 1,
          )
          return { result, trace: result.decisionTrace, trackDecisions: captureTrackDecisions(result) }
        })

        if (!isMounted || !consensus) return

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
            tracks: mergeConsensusTrackStates(consensus.trackStates, current.tracks, current.rawTracks),
          }

          next.set(selectedAlbum.id, mergeCurateProposal(current, updated))
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
  }, [selectedAlbum?.id])

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

  // Select source for track vocalists
  const handleSelectTrackArtist = (trackId: string, artists: string, source: any) => {
    if (!selectedAlbum) return
    setAlbumItems((prev) => {
      const next = new Map(prev)
      const current = next.get(selectedAlbum.id)
      if (!current) return prev

      const updatedTracks = current.tracks.map((t) => {
        if (t.trackId !== trackId) return t
        return selectCurateTrackFields({
          ...t,
          matchedArtists: artists,
          source: source || 'single_provider_match',
          requiresHumanReview: false,
        }, 'matchedArtists')
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
        let val = t.localArtists
        if (source === 'apple') val = t.appleArtists || current.albumArtist.apple || t.localArtists
        if (source === 'musicbrainz') val = t.mbArtists || current.albumArtist.musicbrainz || t.localArtists
        if (source === 'ai') val = t.aiArtists || current.albumArtist.ai || t.localArtists

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

    setIsSteeringLoading(true)
    showToast(`Searching providers for "${steerAlbum || selectedAlbum.currentTitle}"...`)

    try {
      let aiMasterResult: any = undefined
      let directAppleCandidate: any = null
      const localRelease = selectedAlbum.rawRelease
      const consensus = await executeTraceFetch(selectedAlbum.id, {
        trigger: 'user_refresh', context: curateMatchingContext(localRelease, selectedAlbum.rawTracks),
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
      if (useAi) {
        try {
          const canonicalRes = await compilationCanonicalizerService.resolveCompilationSoundtracks(
            localRelease,
            selectedAlbum.rawTracks,
            releases,
            {
              selectedAlbumSignal: signal,
              referenceUrl: steerGroundingUrl.trim() || undefined,
              userSearchQuery: {
                albumTitle: steerAlbum.trim() || undefined,
                artistCredit: steerArtist.trim() || undefined,
                year: Number(steerYear) || undefined,
              },
            }
          )

          if (canonicalRes && canonicalRes.success && canonicalRes.tracks && canonicalRes.tracks.length > 0) {
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
                artistName: (pt as any).primaryVocalists || (pt as any).proposedSingers || (pt as any).proposedArtist || (pt as any).composer,
              })),
            }
          }
        } catch (aiErr) {
          console.warn('[UnifiedCurateCockpit] AI Grounding note:', aiErr)
        }
      }

      // 3. If user gave an Apple Music URL, directly resolve the authentic Apple Music album & tracklist
      signal.throwIfAborted()
      let directAppleMaster: any = null
      const appleId = /^https:\/\/(?:music|itunes)\.apple\.com\//i.test(steerGroundingUrl.trim())
        ? steerGroundingUrl.match(/(?:album\/[^/]+\/|album\/|id=?)(\d{8,12})/)?.[1]
        : undefined
      if (appleId) {
        directAppleMaster = await resolveDirectAppleMusicCandidate(appleId, signal).catch(error => {
          signal.throwIfAborted()
          console.warn('[AppleMusicResolver] Direct ID lookup failed:', error)
          return null
        })
      }

      directAppleCandidate = directAppleMaster ? {
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
        ...localRelease,
        title: directAppleMaster?.releaseTitle || aiMasterResult?.releaseTitle || steerAlbum.trim() || localRelease.title,
        artistCredit: directAppleMaster?.artistCredit || aiMasterResult?.artistCredit || steerArtist.trim() || localRelease.artistCredit,
        composerName: directAppleMaster?.composer || aiMasterResult?.composer || steerArtist.trim() || localRelease.composerName,
        releaseYear: directAppleMaster?.releaseYear || aiMasterResult?.releaseYear || Number(steerYear) || localRelease.releaseYear,
      }

        signal.throwIfAborted()
        const res = await federatedResolversService.resolve2of3ReleaseConsensus(
          steeredRelease,
          selectedAlbum.rawTracks,
          false,
          aiMasterResult,
          directAppleCandidate,
          onProgress,
          signal,
          record,
          appleId ? 0 : (useWikipedia || useAi ? 1 : 2),
        )
        return { trace: res.decisionTrace, result: res, trackDecisions: captureTrackDecisions(res) }
      })

      if (!consensus) {
        setIsSteeringLoading(false)
        return
      }

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

        next.set(selectedAlbum.id, mergeCurateProposal(current, updated))
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
  const provenanceAttempted = useRef<string | undefined>(undefined)
  useEffect(() => { provenanceAttempted.current = undefined }, [selectedAlbum?.id])

  // Automatic debounced compilation provenance resolution (500ms, playback guarded, parameter-hashed cache)
  useEffect(() => {
    if (!selectedAlbum || !isCompilationAlbum) return
    if (loadedDrafts.current.get(selectedAlbum.id)?.restored) return

    // Defer automatic inference until the transport is idle.
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
                  originalAlbum: tState.selectedOverrides?.includes('originalAlbum') ? tState.originalAlbum : match.originalAlbum,
                  originalYear: tState.selectedOverrides?.includes('originalYear') ? tState.originalYear : match.originalYear,
                  provenanceSource: tState.selectedOverrides?.includes('originalAlbum') ? 'user_override' as const : 'consensus' as const,
                  aiTitle: match.title,
                  aiArtists: match.primaryVocalists || (match.primaryVocalists === undefined && (match as any).singers ? (match as any).singers : undefined),
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

        controller.signal.throwIfAborted()
        if (provenanceAttempted.current === selectedAlbum.id) return
        provenanceAttempted.current = selectedAlbum.id
        const result: any = await resolveGemini('compilation', payload, controller.signal, true)
        controller.signal.throwIfAborted()
        const rawTracks = Array.isArray(result) ? result : (Array.isArray(result?.tracks) ? result.tracks : (Array.isArray(result?.results) ? result.results : []))
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
                  originalAlbum: tState.selectedOverrides?.includes('originalAlbum') ? tState.originalAlbum : match.originalAlbum,
                  originalYear: tState.selectedOverrides?.includes('originalYear') ? tState.originalYear : match.originalYear,
                  provenanceSource: tState.selectedOverrides?.includes('originalAlbum') ? 'user_override' as const : 'gemini_ai' as const,
                  aiTitle: match.title,
                  aiArtists: match.primaryVocalists || (match.primaryVocalists === undefined && (match as any).singers ? (match as any).singers : undefined),
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
    if (!selectedAlbum || selectedAlbum.draftBasedOn || stagingAlbumId || selectedCommitReconciled || batchAbort.current) return

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
      setSelectedAlbumId(current => current === selectedAlbum.id ? activeList[currIdx + 1].id : current)
    }
  }, [selectedAlbum, stagingAlbumId, selectedCommitReconciled, saveAlbumDraft, activeTier, tier1Items, tier2Items, showToast])

  // Freeze this album's exact selection in the native queue. The worker owns file writes.
  const handleCommitAlbum = useCallback(async () => {
    if (!selectedAlbum || selectedAlbum.draftBasedOn || stagingAlbumId || queuingAlbumId || selectedCommitReconciled || batchAbort.current) return
    setQueuingAlbumId(selectedAlbum.id)
    try {
      if (!tauriBridge.isTauri()) throw new Error('Open the desktop app to queue tag writes.')
      const draft = captureCurateDraft(selectedAlbum)
      const items = makeCurateCommitItems(draft, selectedAlbum.rawTracks, selectedAlbum.rawRelease)
      if (!items.length) throw new Error('There are no tracks to commit.')
      await saveAlbumDraft(selectedAlbum)
      await tauriBridge.commitEnqueueBatch({
        description: `Curate: ${selectedAlbum.albumTitle.selected}`,
        destination: 'embedded',
        items,
      })
      showToast(`Queued "${selectedAlbum.albumTitle.selected}" for tag writing.`)
      await onCommitQueued?.()
    } catch (err) {
      showToast(`Could not queue album: ${String(err)}`)
    } finally {
      setQueuingAlbumId(null)
    }
  }, [selectedAlbum, stagingAlbumId, queuingAlbumId, selectedCommitReconciled, saveAlbumDraft, onCommitQueued, showToast])

  const handleCommitAllTier1 = async () => {
    if (!tier1Items.length || stagingAlbumId || queuingAlbumId || isPlaying || batchAbort.current) return
    const controller = new AbortController()
    batchAbort.current = controller
    setIsBatchCommitting(true)
    try {
      if (!tauriBridge.isTauri()) throw new Error('Open the desktop app to queue tag writes.')
      const rows = new Map((await tauriBridge.commitGetCurateProjection()).filter(row => !supersededCommitIds?.has(row.id)).map(row => [row.trackId, row]))
      const items: EnqueueBatchPayload['items'] = []
      const drafts: NonNullable<EnqueueBatchPayload['curateDrafts']> = []
      for (const album of tier1Items) {
        controller.signal.throwIfAborted()
        if (album.draftBasedOn) continue
        const loaded = loadedDrafts.current.has(album.id)
        const saved = loaded ? null : await tauriBridge.curationGetDraft(album.id)
        controller.signal.throwIfAborted()
        const prepared = prepareTier1Commit(captureCurateDraft(album), saved, album.rawTracks, album.rawRelease, rows)
        if (!prepared) continue
        items.push(...prepared.items)
        drafts.push({ albumId: album.id, draft: prepared.draft })
      }
      if (!items.length) {
        showToast('No Tier 1 albums are ready to queue. Review their drafts or existing queue items.')
        return
      }
      controller.signal.throwIfAborted()
      await tauriBridge.commitEnqueueBatch({
        description: `Curate Tier 1 · ${drafts.length} albums`,
        destination: 'embedded',
        requireIdle: true,
        curateDrafts: drafts,
        items,
      })
      const skipped = tier1Items.length - drafts.length
      showToast(`Queued ${drafts.length} Tier 1 album(s) for tag writing.${skipped ? ` ${skipped} skipped.` : ''}`)
      await onCommitQueued?.()
    } catch (err) {
      showToast(controller.signal.aborted
        ? 'Tier 1 preparation stopped. Stop playback before queueing a batch.'
        : `Could not queue Tier 1: ${String(err)}`)
    } finally {
      batchAbort.current = null
      setIsBatchCommitting(false)
    }
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
    const change = selectedChanges?.album[fieldKey]

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
          onClick={() => handleSelectFieldSource(fieldKey, 'apple')}
          data-testid={`master-cell-${fieldKey}-apple`}
          className="py-2.5 px-4 cursor-pointer text-white/70 hover:text-[#D4AF37] transition-colors"
        >
          {String(fieldState.apple ?? '—')}
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
                disabled={isBatchCommitting || isPlaying || Boolean(stagingAlbumId || queuingAlbumId)}
                className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-[11px] cursor-pointer transition-colors shadow-sm disabled:opacity-50"
              >
                {isBatchCommitting
                  ? 'Preparing queue…'
                  : `Commit All (${tier1Items.length})`}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
            {(activeTier === 'tier1' ? tier1Items : tier2Items).map((alb) => (
              <div
                key={alb.id}
                data-testid="curate-album-item"
                data-album-id={alb.id}
                onClick={() => setSelectedAlbumId(alb.id)}
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
                  disabled={Boolean(selectedAlbum.draftBasedOn || stagingAlbumId || selectedCommitReconciled || isBatchCommitting)}
                  data-testid="btn-stage-next"
                  className="px-3.5 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-white font-medium text-xs border border-white/20 transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                  title="Save changes and keep in queue for later review"
                >
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{stagingAlbumId === selectedAlbum.id ? 'Saving draft…' : 'Stage & Next'}</span>
                </button>

                {/* Commit Button (saves permanently and removes from queue) */}
                <button
                  onClick={handleCommitAlbum}
                  disabled={Boolean(selectedAlbum.draftBasedOn || stagingAlbumId || queuingAlbumId || selectedCommitReconciled || isBatchCommitting)}
                  data-testid="btn-commit-album"
                  className="px-4 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#c29e2f] text-black font-semibold text-xs transition-colors cursor-pointer shadow-md flex items-center gap-1.5 disabled:opacity-50"
                  title="Queue the selected metadata for background tag writing"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{queuingAlbumId ? 'Queuing…' : 'Commit Album'}</span>
                </button>
              </div>
            </div>

            {selectedCommitStatus && (
              <div role="status" className="px-4 text-xs text-cyan-300">
                Last commit · {selectedCommitStatus}
                {selectedCommitError && <span className="ml-3 text-amber-200">{selectedCommitError}</span>}
                {selectedCommitStatuses.has('failed') && (
                  <button className="ml-3 underline" onClick={async () => {
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
                )}
              </div>
            )}
            <CurateCommitOutcomes tracks={selectedAlbum.tracks} rows={selectedCommitRows} />
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
                        {selectedChanges && (
                          <span data-testid="curate-change-summary" className="mt-0.5 block font-sans font-normal text-zinc-300" aria-live="polite">
                            {selectedChanges.albumCount || selectedChanges.trackCount
                              ? `${selectedChanges.albumCount} album ${selectedChanges.albumCount === 1 ? 'field' : 'fields'} · ${selectedChanges.trackCount} ${selectedChanges.trackCount === 1 ? 'track' : 'tracks'} changed`
                              : 'No changes from local tags'}
                          </span>
                        )}
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
                    {selectedAlbum.tracks.map((trk, idx) => {
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
                            onClick={() => handleSelectTrackArtist(trk.trackId, trk.localArtists, 'local_fallback')}
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
                            onClick={() => {
                              const targetArtist = trk.appleArtists || (trk.appleTitle ? selectedAlbum.albumArtist.apple : undefined)
                              if (targetArtist) {
                                handleSelectTrackArtist(trk.trackId, targetArtist, 'single_provider_match')
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/70 hover:text-[#D4AF37] transition-colors"
                          >
                            <div className="font-medium text-white/70">
                              {trk.appleTitle || (trk.appleArtists ? trk.matchedTitle : '—')}
                            </div>
                            <div className="text-[10px] text-white/50 mt-0.5">
                              {trk.appleArtists || (trk.appleTitle && selectedAlbum.albumArtist.apple ? selectedAlbum.albumArtist.apple : '—')}
                            </div>
                          </td>

                          {/* MusicBrainz Cell */}
                          <td
                            data-testid={`track-cell-${idx}-musicbrainz`}
                            onClick={() => {
                              const targetArtist = trk.mbArtists || (trk.mbTitle ? selectedAlbum.albumArtist.musicbrainz : undefined)
                              if (targetArtist) {
                                handleSelectTrackArtist(trk.trackId, targetArtist, 'single_provider_match')
                              }
                            }}
                            className="py-3 px-3 cursor-pointer text-white/60 hover:text-white transition-colors"
                          >
                            <div className="font-medium text-white/60">
                              {trk.mbTitle || (trk.mbArtists ? trk.matchedTitle : '—')}
                            </div>
                            <div className="text-[10px] text-white/40 mt-0.5">
                              {trk.mbArtists || (trk.mbTitle && selectedAlbum.albumArtist.musicbrainz ? selectedAlbum.albumArtist.musicbrainz : '—')}
                            </div>
                          </td>

                          {/* Gemini AI Cell */}
                          <td
                            data-testid={`track-cell-${idx}-ai`}
                            onClick={() => {
                              const candArtist = trk.aiArtists || (trk.aiTitle ? (trk.matchedArtists || selectedAlbum.albumArtist.ai) : undefined)
                              if (candArtist) {
                                handleSelectTrackArtist(trk.trackId, candArtist, 'ai_synthesized')
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

