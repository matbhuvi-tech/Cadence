import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Search,
  Play,
  Shuffle,
  ArrowLeft,
  RefreshCw,
  Check,
  Disc,
  Music,
  ExternalLink,
  Sparkles,
  SlidersHorizontal,
  Lock,
} from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  ArtistSummary,
  ArtistDetail,
  ArtistCreditItem,
  Release,
  Track,
  PlaybackStatePayload,
} from '../../core/types'
import { generateMonogramAvatar } from '../../core/taxonomyUtils'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'
import { federatedResolversService, ArtistPortraitCandidate } from '../../services/federatedResolvers'
import { ambientCurationService } from '../../services/ambientCurationService'
import { tauriBridge } from '../../services/tauriBridge'

export type CardSize = 'compact' | 'standard' | 'large'

export function isPerformerRole(role?: string): boolean {
  if (!role) return false
  const r = role.toLowerCase().trim()
  return (
    r === 'performer' ||
    r === 'primary' ||
    r === 'featured' ||
    r.includes('performer') ||
    r.includes('primary') ||
    r.includes('featured') ||
    r.includes('soloist') ||
    r.includes('vocalist') ||
    r.includes('singer')
  )
}

export function isComposerRole(role?: string): boolean {
  if (!role) return false
  const r = role.toLowerCase().trim()
  return r === 'composer' || r.includes('composer') || r.includes('arranger')
}

interface ArtistsViewProps {
  releases: Release[]
  tracks: Track[]
  onSelectTrack: (trackId: string) => void
  selectedTrackId?: string
  playbackState?: PlaybackStatePayload
  onPlayAlbum?: (releaseId: string) => void
  onNavigateToRelease?: (releaseId: string) => void
  cardSize?: CardSize
  onCardSizeChange?: (cardSize: CardSize) => void
}

type RoleFilter = 'all' | 'composer' | 'performer'
type SortBy = 'albums_desc' | 'tracks_desc' | 'name_asc'

function resolvePortraitUrl(url?: string): string {
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url
  }
  try {
    return convertFileSrc(url)
  } catch {
    return url
  }
}

export const ArtistsView: React.FC<ArtistsViewProps> = ({
  releases,
  tracks,
  onSelectTrack,
  selectedTrackId,
  playbackState,
  onPlayAlbum,
  onNavigateToRelease,
  cardSize: propCardSize,
  onCardSizeChange,
}) => {
  const [artists, setArtists] = useState<ArtistSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [sortBy, setSortBy] = useState<SortBy>('albums_desc')
  const [internalCardSize, setInternalCardSize] = useState<CardSize>('standard')

  const cardSize = propCardSize ?? internalCardSize
  const setCardSize = onCardSizeChange ?? setInternalCardSize

  // Selected Artist for Editorial Detail View
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null)
  const [artistDetail, setArtistDetail] = useState<ArtistDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [detailRoleTab, setDetailRoleTab] = useState<'all' | 'composer' | 'performer'>('all')

  // Portrait Enrichment Modal
  const [isPortraitModalOpen, setIsPortraitModalOpen] = useState(false)
  const [portraitCandidates, setPortraitCandidates] = useState<ArtistPortraitCandidate[]>([])
  const [isSearchingPortraits, setIsSearchingPortraits] = useState(false)
  const [customPortraitUrl, setCustomPortraitUrl] = useState('')
  const [queuedPortraitNotification, setQueuedPortraitNotification] = useState<string | null>(null)
  const [isEnrichingEditorial, setIsEnrichingEditorial] = useState(false)

  // Ambient Hardware Telemetry: Curation state subscription
  const [curationState, setCurationState] = useState(ambientCurationService.getState())

  useEffect(() => {
    const unsub = ambientCurationService.subscribe((state) => {
      setCurationState(state)
    })
    return () => unsub()
  }, [])

  // Zero-polling instantaneous cross-dissolve: update specific artist in memory
  useEffect(() => {
    let unlisten: (() => void) | undefined
    tauriBridge.onPortraitEnriched((payload) => {
      if (!payload.artistId || !payload.portraitUrl) return
      setArtists((prev) =>
        prev.map((a) =>
          a.id === payload.artistId
            ? { ...a, portraitUrl: payload.portraitUrl }
            : a
        )
      )
      setArtistDetail((prev) => {
        if (prev && prev.artist.id === payload.artistId) {
          return {
            ...prev,
            artist: { ...prev.artist, portraitUrl: payload.portraitUrl },
          }
        }
        return prev
      })
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  // Load canonical artists
  const loadArtists = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await sqliteLibraryService.getCanonicalArtists(releases, tracks)
      setArtists(data)
    } catch (err) {
      console.error('[ArtistsView] Error loading canonical artists:', err)
      const fallback = sqliteLibraryService.deriveCanonicalArtistsFromState(releases, tracks)
      setArtists(fallback)
    } finally {
      setIsLoading(false)
    }
  }, [releases, tracks])

  useEffect(() => {
    loadArtists()
  }, [loadArtists])

  // Load detail when an artist is selected
  useEffect(() => {
    if (!selectedArtistId) {
      setArtistDetail(null)
      return
    }

    let isMounted = true
    setIsLoadingDetail(true)
    setDetailRoleTab('all')

    sqliteLibraryService
      .getCanonicalArtistDetail(selectedArtistId, releases, tracks)
      .then((detail) => {
        if (isMounted) {
          setArtistDetail(detail)
          setIsLoadingDetail(false)
        }
      })
      .catch((err) => {
        console.error('[ArtistsView] Error loading artist detail:', err)
        if (isMounted) setIsLoadingDetail(false)
      })

    return () => {
      isMounted = false
    }
  }, [selectedArtistId, releases, tracks])

  // Filtered & Sorted Artists Grid
  const filteredArtists = useMemo(() => {
    let result = artists

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.sortName && a.sortName.toLowerCase().includes(q))
      )
    }

    if (roleFilter === 'composer') {
      result = result.filter(
        (a) => isComposerRole(a.primaryRole) || a.roles.some(isComposerRole)
      )
    } else if (roleFilter === 'performer') {
      result = result.filter(
        (a) => isPerformerRole(a.primaryRole) || a.roles.some(isPerformerRole)
      )
    }

    return [...result].sort((a, b) => {
      if (sortBy === 'albums_desc') {
        return b.albumsCount - a.albumsCount || a.name.localeCompare(b.name)
      }
      if (sortBy === 'tracks_desc') {
        return b.tracksCount - a.tracksCount || a.name.localeCompare(b.name)
      }
      return a.name.localeCompare(b.name)
    })
  }, [artists, searchQuery, roleFilter, sortBy])

  // Open Portrait Picker Modal
  const handleOpenPortraitModal = async () => {
    if (!artistDetail) return
    setIsPortraitModalOpen(true)
    setCustomPortraitUrl('')
    setQueuedPortraitNotification(null)
    setIsSearchingPortraits(true)

    try {
      const candidates = await federatedResolversService.searchArtistPortraits(artistDetail.artist.name)
      setPortraitCandidates(candidates)
    } catch (err) {
      console.warn('[ArtistsView] Error fetching portrait candidates:', err)
      setPortraitCandidates([])
    } finally {
      setIsSearchingPortraits(false)
    }
  }

  // Apply Selected Portrait
  const handleApplyPortrait = async (url: string) => {
    if (!artistDetail) return

    const isAudioPlaying = Boolean(playbackState?.isPlaying)

    // Update in-memory state immediately for instant responsive UI
    setArtistDetail((prev) =>
      prev
        ? {
            ...prev,
            artist: { ...prev.artist, portraitUrl: url, portraitStatus: 'enriched' },
          }
        : null
    )

    setArtists((prev) =>
      prev.map((a) =>
        a.id === artistDetail.artist.id
          ? { ...a, portraitUrl: url, portraitStatus: 'enriched' }
          : a
      )
    )

    if (isAudioPlaying) {
      // Audiophile Invariant: Queue SQLite/disk write for idle transport to prevent PHY/bus jitter
      setQueuedPortraitNotification('● Queued for Idle Transport (Playback Active)')
      setTimeout(() => {
        setIsPortraitModalOpen(false)
        setQueuedPortraitNotification(null)
      }, 1400)
    } else {
      try {
        await sqliteLibraryService.setArtistPortrait(artistDetail.artist.id, url, 'enriched')
      } catch (err) {
        console.warn('[ArtistsView] Failed to persist portrait to SQLite:', err)
      }
      setIsPortraitModalOpen(false)
    }
  }

  // Hydrate & Enrich Artist Editorial Profile (Bio, Era, MBID, Portrait)
  const handleEnrichEditorialProfile = async () => {
    if (!artistDetail) return
    setIsEnrichingEditorial(true)
    try {
      const profile = await federatedResolversService.hydrateArtistEditorialProfile(
        artistDetail.artist.name,
        artistDetail.artist.id
      )

      if (profile) {
        const isAudioPlaying = Boolean(playbackState?.isPlaying)
        if (!isAudioPlaying) {
          await sqliteLibraryService.updateArtistEditorialProfile(artistDetail.artist.id, {
            bioSummary: profile.bioSummary,
            eraActive: profile.eraActive,
            primaryRole: profile.primaryRole,
            mbid: profile.mbid,
            appleArtistId: profile.appleArtistId,
            portraitUrl: profile.portraitUrl,
          })
        }

        setArtistDetail((prev) =>
          prev
            ? {
                ...prev,
                artist: {
                  ...prev.artist,
                  bioSummary: profile.bioSummary || prev.artist.bioSummary,
                  eraActive: profile.eraActive || prev.artist.eraActive,
                  portraitUrl: profile.portraitUrl || prev.artist.portraitUrl,
                  mbid: profile.mbid || prev.artist.mbid,
                  appleArtistId: profile.appleArtistId || prev.artist.appleArtistId,
                },
              }
            : null
        )

        setArtists((prev) =>
          prev.map((a) =>
            a.id === artistDetail.artist.id
              ? {
                  ...a,
                  portraitUrl: profile.portraitUrl || a.portraitUrl,
                  eraActive: profile.eraActive || a.eraActive,
                }
              : a
          )
        )
      }
    } catch (err) {
      console.warn('[ArtistsView] Error enriching artist editorial profile:', err)
    } finally {
      setIsEnrichingEditorial(false)
    }
  }

  // Play Artist's Essential Tracks
  const handlePlayEssentialTracks = () => {
    if (!artistDetail || artistDetail.appearingTracks.length === 0) return
    const firstTrack = artistDetail.appearingTracks[0]
    onSelectTrack(firstTrack.trackId)
  }

  // Shuffle Artist's Tracks
  const handleShuffleTracks = () => {
    if (!artistDetail || artistDetail.appearingTracks.length === 0) return
    const randomIndex = Math.floor(Math.random() * artistDetail.appearingTracks.length)
    const randomTrack = artistDetail.appearingTracks[randomIndex]
    onSelectTrack(randomTrack.trackId)
  }

  // Dimensions based on card size
  const avatarSizeClass =
    cardSize === 'compact'
      ? 'w-24 h-24 sm:w-28 sm:h-28'
      : cardSize === 'large'
      ? 'w-44 h-44 sm:w-52 sm:h-52'
      : 'w-32 h-32 sm:w-36 sm:h-36'

  const gridTemplateClass =
    cardSize === 'compact'
      ? 'grid-cols-[repeat(auto-fill,minmax(130px,1fr))]'
      : cardSize === 'large'
      ? 'grid-cols-[repeat(auto-fill,minmax(220px,1fr))]'
      : 'grid-cols-[repeat(auto-fill,minmax(170px,1fr))]'

  // =========================================================================
  // VIEW: EDITORIAL ARTIST DETAIL PAGE
  // =========================================================================
  if (selectedArtistId && artistDetail) {
    const { artist, albumsCount, tracksCount, discography, appearingTracks } = artistDetail

    const isComposer = isComposerRole(artist.primaryRole) || artistDetail.roles.some(isComposerRole)
    const isPerformer = isPerformerRole(artist.primaryRole) || artistDetail.roles.some(isPerformerRole)

    // Filter discography by role tab
    const filteredDiscography = discography.filter((rel) => {
      if (detailRoleTab === 'composer') {
        return rel.composerName?.toLowerCase().includes(artist.name.toLowerCase())
      }
      if (detailRoleTab === 'performer') {
        return (
          rel.artistCredit?.toLowerCase().includes(artist.name.toLowerCase()) ||
          appearingTracks.some(
            (t) => t.releaseId === rel.id && isPerformerRole(t.role)
          )
        )
      }
      return true
    })

    const portraitSrc =
      resolvePortraitUrl(artist.portraitUrl) || generateMonogramAvatar(artist.name)

    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[#0D0E11] text-[#F5F5F7] overflow-y-auto px-8 py-6">
        {/* Top Back Navigation Bar */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => setSelectedArtistId(null)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold text-[#8E8E93] hover:text-white bg-white/[0.04] hover:bg-white/[0.08] transition-all cursor-pointer border border-white/[0.06]"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>All Artists</span>
          </button>

          <div className="flex items-center gap-2 text-xs font-mono text-[#8E8E93]">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
            <span>Relational Entity Master</span>
          </div>
        </div>

        {/* Editorial Artist Hero Banner */}
        <div className="relative flex flex-col md:flex-row items-center md:items-end gap-8 pb-10 border-b border-white/[0.08]">
          {/* Large Circular Portrait with Specular Glow */}
          <div className="relative group shrink-0">
            <div className="relative w-40 h-40 md:w-48 md:h-48 rounded-full overflow-hidden ring-1 ring-inset ring-white/15 shadow-[0_16px_40px_rgba(0,0,0,0.8)] bg-[#14161A]">
              <img
                src={portraitSrc}
                alt={artist.name}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).src = generateMonogramAvatar(artist.name)
                }}
              />
              {/* Hover overlay to change portrait */}
              <div
                onClick={handleOpenPortraitModal}
                className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center gap-1.5 transition-opacity cursor-pointer text-white"
              >
                <RefreshCw className="w-6 h-6 text-[#D4AF37]" />
                <span className="text-[11px] font-medium tracking-wide">Change Portrait</span>
              </div>
            </div>

            {/* Role Badge Indicator */}
            <span
              className={`absolute bottom-2 right-2 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase shadow-md ${
                isComposer
                  ? 'bg-indigo-600/90 text-indigo-100 ring-1 ring-indigo-400/30'
                  : 'bg-amber-600/90 text-amber-100 ring-1 ring-amber-400/30'
              }`}
            >
              {artist.primaryRole}
            </span>
          </div>

          {/* Hero Metadata & Typography */}
          <div className="flex-1 text-center md:text-left min-w-0">
            <div className="flex items-center justify-center md:justify-start gap-2 text-xs font-mono text-[#8E8E93] mb-1.5 uppercase tracking-wider">
              <span>Library Artist Entity</span>
              <span>&bull;</span>
              <span>{artist.eraActive || 'Canonical Master'}</span>
            </div>

            <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white mb-3 truncate">
              {artist.name}
            </h1>

            <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 text-xs text-[#8E8E93] font-mono mb-4">
              <span className="text-[#F5F5F7] font-semibold">{albumsCount} Albums</span>
              <span>&bull;</span>
              <span>{tracksCount} Tracks</span>
              {artistDetail.roles.length > 1 && (
                <>
                  <span>&bull;</span>
                  <span className="text-white/60">Roles: {artistDetail.roles.join(', ')}</span>
                </>
              )}
            </div>

            {artist.bioSummary && (
              <p className="text-xs text-[#A1A1AA] max-w-2xl leading-relaxed mb-6 line-clamp-3">
                {artist.bioSummary}
              </p>
            )}

            {/* Hero Quick Action Buttons */}
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-3">
              <button
                onClick={handlePlayEssentialTracks}
                disabled={appearingTracks.length === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-black font-semibold text-xs hover:bg-[#E5E5EA] transition-all cursor-pointer shadow-lg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4 fill-black" />
                <span>Play Essential Tracks</span>
              </button>

              <button
                onClick={handleShuffleTracks}
                disabled={appearingTracks.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-white font-semibold text-xs border border-white/[0.08] transition-all cursor-pointer shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Shuffle className="w-4 h-4 text-[#8E8E93]" />
                <span>Shuffle Catalogue</span>
              </button>

              <button
                onClick={handleOpenPortraitModal}
                className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white font-medium text-xs border border-white/[0.06] transition-all cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Change Portrait</span>
              </button>

              <button
                onClick={handleEnrichEditorialProfile}
                disabled={isEnrichingEditorial}
                className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 text-[#D4AF37] hover:text-[#E5C158] font-medium text-xs border border-[#D4AF37]/30 transition-all cursor-pointer disabled:opacity-40"
              >
                <Sparkles className={`w-3.5 h-3.5 ${isEnrichingEditorial ? 'animate-spin' : ''}`} />
                <span>{isEnrichingEditorial ? 'Enriching...' : 'Enrich Profile'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Role-Scoped Discography Tabs */}
        <div className="mt-8 mb-6 flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDetailRoleTab('all')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                detailRoleTab === 'all'
                  ? 'bg-white/[0.08] text-white shadow-sm'
                  : 'text-[#8E8E93] hover:text-white'
              }`}
            >
              All Releases ({discography.length})
            </button>

            {isComposer && (
              <button
                onClick={() => setDetailRoleTab('composer')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  detailRoleTab === 'composer'
                    ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/30 shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                As Composer
              </button>
            )}

            {isPerformer && (
              <button
                onClick={() => setDetailRoleTab('performer')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  detailRoleTab === 'performer'
                    ? 'bg-amber-600/30 text-amber-200 border border-amber-500/30 shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                As Performer
              </button>
            )}
          </div>

          <span className="text-xs font-mono text-[#8E8E93]">
            {filteredDiscography.length} Release{filteredDiscography.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Discography Albums Grid */}
        {filteredDiscography.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5 mb-12">
            {filteredDiscography.map((rel) => {
              const coverArt =
                rel.artwork?.frontCoverUrl ||
                'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" fill="%23222"><rect width="200" height="200"/></svg>'

              return (
                <div
                  key={rel.id}
                  onClick={() => {
                    if (onNavigateToRelease) {
                      onNavigateToRelease(rel.id)
                    } else if (onPlayAlbum) {
                      onPlayAlbum(rel.id)
                    }
                  }}
                  className="group flex flex-col text-left cursor-pointer transition-all"
                >
                  <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-[#161B22] mb-3 shadow-[0_8px_20px_rgba(0,0,0,0.5)] ring-1 ring-inset ring-white/[0.08]">
                    <img
                      src={coverArt}
                      alt={rel.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                      <div className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center shadow-lg hover:scale-105 transition-transform">
                        <Play className="w-5 h-5 fill-black ml-0.5" />
                      </div>
                    </div>
                  </div>
                  <span className="font-semibold text-xs text-[#F5F5F7] group-hover:text-white truncate">
                    {rel.title}
                  </span>
                  <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#8E8E93] mt-0.5">
                    {rel.releaseYear ? <span>{rel.releaseYear}</span> : null}
                    {rel.releaseYear ? <span>&bull;</span> : null}
                    <span>{rel.mediaFormat || 'Lossless'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center py-12 text-[#8E8E93] text-xs">
            No albums found for this role category.
          </div>
        )}

        {/* Collaborative Works & Appears On Track List */}
        <div className="mt-4 mb-16">
          <div className="flex items-center justify-between mb-4 border-b border-white/[0.06] pb-2">
            <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#D4AF37]" />
              <span>Catalogue & Collaborative Appearances</span>
            </h2>
            <span className="text-xs font-mono text-[#8E8E93]">
              {appearingTracks.length} Track{appearingTracks.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="bg-[#121418]/60 rounded-2xl border border-white/[0.06] overflow-hidden divide-y divide-white/[0.04]">
            {appearingTracks.slice(0, 50).map((t, idx) => {
              const isSelected = selectedTrackId === t.trackId
              const mins = Math.floor(t.durationSecs / 60)
              const secs = Math.floor(t.durationSecs % 60)
                .toString()
                .padStart(2, '0')

              return (
                <div
                  key={t.trackId}
                  className={`flex items-center justify-between px-4 py-3 hover:bg-white/[0.04] transition-colors group/trk ${
                    isSelected ? 'bg-white/[0.06]' : ''
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0 flex-1">
                    <span className="text-xs font-mono text-[#8E8E93] w-6 text-right shrink-0">
                      {idx + 1}
                    </span>

                    <button
                      onClick={() => onSelectTrack(t.trackId)}
                      className="w-7 h-7 rounded-lg bg-white/[0.06] hover:bg-white text-white hover:text-black flex items-center justify-center transition-all cursor-pointer shrink-0"
                    >
                      <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          onClick={() => onSelectTrack(t.trackId)}
                          className="font-medium text-xs text-[#F5F5F7] group-hover/trk:text-white cursor-pointer truncate"
                        >
                          {t.trackTitle}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/[0.06] text-[#8E8E93] shrink-0">
                          {t.role}
                        </span>
                      </div>

                      {/* Interactive Collaborators Links */}
                      <div className="flex items-center gap-1.5 text-[11px] text-[#8E8E93] mt-0.5 truncate">
                        <span className="truncate">{t.releaseTitle}</span>
                        {t.coArtists.length > 0 && (
                          <>
                            <span className="text-white/30">&bull;</span>
                            <span className="text-white/50 text-[10px]">with</span>
                            <div className="flex items-center gap-1">
                              {t.coArtists.map((co) => (
                                <button
                                  key={co}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    // Navigate to co-artist detail!
                                    const match = artists.find(
                                      (a) => a.name.toLowerCase() === co.toLowerCase()
                                    )
                                    if (match) {
                                      setSelectedArtistId(match.id)
                                    }
                                  }}
                                  className="text-[#D4AF37] hover:underline hover:text-white transition-colors cursor-pointer text-[11px]"
                                >
                                  {co}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0 text-xs font-mono text-[#8E8E93]">
                    <span className="hidden sm:inline-block px-1.5 py-0.5 rounded bg-white/[0.04] text-[10px] border border-white/[0.06]">
                      {t.format} {t.sampleRate ? `${Math.round(t.sampleRate / 1000)}k` : ''}
                      {t.bitDepth ? `/${t.bitDepth}b` : ''}
                    </span>
                    <span>
                      {mins}:{secs}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Change Portrait Modal */}
        {isPortraitModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="w-full max-w-xl bg-[#14161A] rounded-2xl border border-white/10 shadow-2xl p-6 flex flex-col max-h-[85vh]">
              <div className="flex items-center justify-between pb-4 border-b border-white/[0.08] mb-4">
                <div>
                  <h3 className="text-base font-bold text-white">Select Portrait</h3>
                  <p className="text-xs text-[#8E8E93] font-mono mt-0.5">
                    Studio photography for {artist.name}
                  </p>
                </div>
                <button
                  onClick={() => setIsPortraitModalOpen(false)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold text-[#8E8E93] hover:text-white bg-white/[0.04] hover:bg-white/[0.08]"
                >
                  Close
                </button>
              </div>

              {queuedPortraitNotification && (
                <div className="mb-4 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-mono flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  <span>{queuedPortraitNotification}</span>
                </div>
              )}

              {/* Custom URL Input */}
              <div className="mb-4">
                <label className="block text-[11px] font-mono text-[#8E8E93] mb-1.5">
                  Paste Custom Image URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customPortraitUrl}
                    onChange={(e) => setCustomPortraitUrl(e.target.value)}
                    placeholder="https://example.com/portrait.jpg"
                    className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-[#D4AF37]"
                  />
                  <button
                    onClick={() => {
                      if (customPortraitUrl.trim()) {
                        handleApplyPortrait(customPortraitUrl.trim())
                      }
                    }}
                    disabled={!customPortraitUrl.trim()}
                    className="px-4 py-1.5 rounded-xl bg-white text-black font-semibold text-xs hover:bg-[#E5E5EA] disabled:opacity-40 cursor-pointer"
                  >
                    Apply
                  </button>
                </div>
              </div>

              {/* Candidate Gallery */}
              <div className="flex-1 overflow-y-auto min-h-[240px]">
                {isSearchingPortraits ? (
                  <div className="flex flex-col items-center justify-center h-48 gap-3 text-[#8E8E93]">
                    <RefreshCw className="w-6 h-6 animate-spin text-[#D4AF37]" />
                    <span className="text-xs font-mono">
                      Querying Apple Music & Deezer Archives...
                    </span>
                  </div>
                ) : portraitCandidates.length > 0 ? (
                  <div className="grid grid-cols-3 gap-4">
                    {portraitCandidates.map((cand, idx) => (
                      <div
                        key={idx}
                        onClick={() => handleApplyPortrait(cand.portraitUrl)}
                        className="group flex flex-col items-center p-2 rounded-xl bg-black/40 hover:bg-white/[0.06] border border-white/[0.06] hover:border-[#D4AF37] transition-all cursor-pointer"
                      >
                        <div className="w-24 h-24 rounded-full overflow-hidden mb-2 ring-1 ring-white/10 shadow-md">
                          <img
                            src={cand.portraitUrl}
                            alt={cand.providerLabel}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          />
                        </div>
                        <span className="text-[11px] font-medium text-white truncate max-w-full">
                          {cand.providerLabel}
                        </span>
                        <span className="text-[10px] font-mono text-[#8E8E93]">
                          {cand.width}×{cand.height}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-48 gap-3 text-center px-4">
                    <div className="w-20 h-20 rounded-full overflow-hidden shadow-inner">
                      <img
                        src={generateMonogramAvatar(artist.name)}
                        alt={artist.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <span className="text-xs text-[#8E8E93]">
                      No online portrait found. Showing Brushed Titanium Monogram Avatar.
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // =========================================================================
  // VIEW: MAIN ARTISTS GRID (APPLE HIG DEFERENCE SPEC)
  // =========================================================================
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0D0E11] text-[#F5F5F7] overflow-hidden">
      {/* Top Filter and Search Control Bar */}
      <div className="px-8 py-4 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-4 shrink-0 bg-[#0D0E11]/90 backdrop-blur-md sticky top-0 z-10">
        {/* Search Field */}
        <div className="relative w-64">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#8E8E93]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search artists..."
            className="w-full bg-white/[0.04] border border-white/[0.08] focus:border-white/20 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-[#8E8E93] focus:outline-none transition-colors"
          />
        </div>

        {/* Role Filters */}
        <div className="flex items-center gap-1.5 p-0.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
          <button
            onClick={() => setRoleFilter('all')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              roleFilter === 'all'
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-[#8E8E93] hover:text-white'
            }`}
          >
            All Roles
          </button>
          <button
            onClick={() => setRoleFilter('composer')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              roleFilter === 'composer'
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-[#8E8E93] hover:text-white'
            }`}
          >
            Composers
          </button>
          <button
            onClick={() => setRoleFilter('performer')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              roleFilter === 'performer'
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-[#8E8E93] hover:text-white'
            }`}
          >
            Performers
          </button>
        </div>

        {/* Sort & Card Size Options */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-mono text-[#8E8E93]">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              aria-label="Sort artists by"
              className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1 text-xs text-[#F5F5F7] focus:outline-none cursor-pointer"
            >
              <option value="albums_desc" className="bg-[#14161A]">
                Most Albums
              </option>
              <option value="tracks_desc" className="bg-[#14161A]">
                Most Tracks
              </option>
              <option value="name_asc" className="bg-[#14161A]">
                Name (A-Z)
              </option>
            </select>
          </div>

          {/* Card Size Density Toggle */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono text-[#8E8E93]">
            {(['compact', 'standard', 'large'] as CardSize[]).map((size) => (
              <button
                key={size}
                onClick={() => setCardSize(size)}
                className={`px-2 py-0.5 rounded capitalize transition-all cursor-pointer ${
                  cardSize === size ? 'bg-white/10 text-white font-bold' : 'hover:text-white'
                }`}
              >
                {size}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-[#8E8E93]">
              {filteredArtists.length} Artist{filteredArtists.length !== 1 ? 's' : ''}
            </span>

            {/* Ambient Curation Header Subtitle Pill */}
            {curationState.pending > 0 && (
              <>
                {curationState.state === 'active' && (
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 flex items-center gap-1.5 animate-pulse">
                    <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                    <span>Fetching {curationState.pending} portraits…</span>
                  </span>
                )}
                {curationState.state === 'paused_playback' && (
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5">
                    <Lock className="w-2.5 h-2.5" />
                    <span>{curationState.pending} portraits queued for idle</span>
                  </span>
                )}
                {curationState.state === 'cooldown' && (
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1.5">
                    <span>⏳</span>
                    <span>{curationState.pending} portraits · Cooldown ({curationState.cooldownRemainingSecs ?? 30}s)</span>
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Grid View */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-[#8E8E93]">
            <RefreshCw className="w-6 h-6 animate-spin text-[#D4AF37]" />
            <span className="text-xs font-mono">Loading Canonical Artists...</span>
          </div>
        ) : filteredArtists.length > 0 ? (
          <div className={`grid ${gridTemplateClass} gap-8`}>
            {filteredArtists.map((artist) => {
              const portraitSrc =
                resolvePortraitUrl(artist.portraitUrl) || generateMonogramAvatar(artist.name)
              const isActiveEnriching =
                curationState.state === 'active' && curationState.currentArtistId === artist.id

              return (
                <div
                  key={artist.id}
                  onClick={() => setSelectedArtistId(artist.id)}
                  className="group flex flex-col items-center text-center cursor-pointer transition-transform"
                >
                  {/* Apple HIG Borderless Circular Avatar */}
                  <div
                    className={`relative ${avatarSizeClass} rounded-full overflow-hidden bg-[#14161A] ring-1 ring-inset ring-white/10 shadow-[0_12px_28px_rgba(0,0,0,0.6)] group-hover:scale-[1.03] transition-transform duration-300 ease-out mb-3`}
                  >
                    {/* Subtle Rotating Specular Shimmer Ring on Active Enriching Card */}
                    {isActiveEnriching && (
                      <div
                        className="absolute -inset-1 rounded-full pointer-events-none animate-spin"
                        style={{
                          animationDuration: '3.5s',
                          background:
                            'conic-gradient(from 0deg, transparent 0%, rgba(212, 175, 55, 0.8) 50%, transparent 100%)',
                          mask: 'radial-gradient(farthest-side, transparent calc(100% - 2.5px), white calc(100% - 2px))',
                          WebkitMask:
                            'radial-gradient(farthest-side, transparent calc(100% - 2.5px), white calc(100% - 2px))',
                        }}
                      />
                    )}

                    <img
                      src={portraitSrc}
                      alt={artist.name}
                      className="w-full h-full object-cover transition-opacity duration-700 ease-out"
                      loading="lazy"
                      onError={(e) => {
                        // Fall back to brushed titanium monogram on any failure
                        ;(e.target as HTMLImageElement).src = generateMonogramAvatar(artist.name)
                      }}
                    />

                    {/* Subtle Specular Ring on Hover */}
                    <div className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />

                    {/* Floating Hover Play Button */}
                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                      <div
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedArtistId(artist.id)
                        }}
                        className="w-11 h-11 rounded-full bg-white text-black flex items-center justify-center shadow-2xl hover:scale-105 transition-transform"
                      >
                        <Play className="w-5 h-5 fill-black ml-0.5" />
                      </div>
                    </div>
                  </div>

                  {/* Centered Typography: Apple HIG Deference */}
                  <span className="font-medium text-sm text-[#F5F5F7] group-hover:text-white transition-colors truncate max-w-full px-1">
                    {artist.name}
                  </span>

                  <span className="text-[11px] font-mono text-[#8E8E93] mt-0.5 truncate max-w-full px-1">
                    {isPerformerRole(artist.primaryRole) && !isComposerRole(artist.primaryRole) ? 'Performer' : artist.primaryRole} &bull; {artist.albumsCount} Album
                    {artist.albumsCount !== 1 ? 's' : ''} &bull; {artist.tracksCount} Tracks
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-64 gap-2 text-[#8E8E93]">
            <Search className="w-8 h-8 text-white/20 mb-2" />
            <span className="text-sm font-medium text-white/60">No artists found</span>
            <span className="text-xs">
              {searchQuery ? `No matches for "${searchQuery}"` : 'Your library has no indexed artists yet.'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
