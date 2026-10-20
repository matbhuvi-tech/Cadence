import React, { useState, useMemo } from 'react'
import {
  Play,
  Shuffle,
  ArrowLeft,
  ChevronRight,
  SlidersHorizontal,
  Sparkles,
  Disc3,
  Calendar,
  Layers,
  Star,
  Heart,
  Folder,
  Music,
  User,
  Search,
  CheckCircle2,
  AlertTriangle,
  Flame,
  Volume2,
  Clock,
} from 'lucide-react'
import { Track, Release } from '../../core/types'
import { getCuratedAlbumArtwork } from '../../core/taxonomyUtils'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { IntegrityScanner } from '../../services/integrityScanner'

interface AlbumCoverGridProps {
  releases: Release[]
  tracks: Track[]
  selectedTrackId?: string
  onSelectTrack: (trackId: string) => void
  onInspectRelease: (releaseId: string) => void
  onCustomizeRelease?: (release: Release) => void
  onUpdateReleaseDetails?: (
    releaseId: string,
    updates: {
      title?: string
      folderName?: string
      composerName?: string
      artistCredit?: string
      releaseYear?: number
      coverArtUrl?: string
      backdropUrl?: string
      rating?: number
      isFavorite?: boolean
      isMasterpiece?: boolean
    }
  ) => void
  onOpenBatchDiff?: () => void
}

type EntityTab = 'albums' | 'artists' | 'composers'
type SortBy = 'year_desc' | 'year_asc' | 'artist_asc' | 'title_asc' | 'dr_desc'
type CardSize = 'compact' | 'standard' | 'large'

interface AlbumCardData {
  id: string
  release?: Release
  title: string
  folderName: string
  composerName: string
  artistCredit: string
  releaseYear?: number
  coverArtUrl: string
  formats: string[]
  sampleRates: string[]
  avgDr: number
  tracks: Track[]
  stagedCount: number
  variantsCount: number
  rating: number
  isFavorite: boolean
  isMasterpiece: boolean
}

export const AlbumCoverGrid: React.FC<AlbumCoverGridProps> = ({
  releases = [],
  tracks = [],
  selectedTrackId,
  onSelectTrack,
  onInspectRelease,
  onCustomizeRelease,
  onUpdateReleaseDetails,
  onOpenBatchDiff,
}) => {
  const { playTrack, currentTrack, isPlaying } = useAudioPlayer()

  const [activeTab, setActiveTab] = useState<EntityTab>('albums')
  const [searchFilter, setSearchFilter] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('year_desc')
  const [cardSize, setCardSize] = useState<CardSize>('standard')

  // Inline drill-down navigation state
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedComposer, setSelectedComposer] = useState<string | null>(null)

  // Group tracks into robust AlbumCardData objects (both unfiltered and filtered)
  const { unfilteredCards, albumCards } = useMemo(() => {
    const groupMap = new Map<string, Track[]>()

    tracks.forEach((track) => {
      const key =
        track.releaseId ||
        track.pendingSidecarEdits?.album ||
        track.folderName ||
        'unknown'
      const existing = groupMap.get(key) || []
      existing.push(track)
      groupMap.set(key, existing)
    })

    const cards: AlbumCardData[] = []

    groupMap.forEach((groupTracks, key) => {
      const rel = releases.find(
        (r) =>
          r.id === key ||
          (r.folderName && groupTracks.some((t) => t.folderName === r.folderName)) ||
          (r.title && groupTracks.some((t) => t.pendingSidecarEdits?.album === r.title))
      )

      const title =
        rel?.title ||
        groupTracks.find((t) => t.pendingSidecarEdits?.album)?.pendingSidecarEdits?.album ||
        groupTracks[0]?.folderName ||
        'Unknown Album'
      const folderName = rel?.folderName || groupTracks[0]?.folderName || ''
      const composerName =
        rel?.composerName ||
        groupTracks.find((t) => t.composerName)?.composerName ||
        groupTracks.find((t) => t.pendingSidecarEdits?.composerName)?.pendingSidecarEdits?.composerName ||
        ''
      const artistCredit =
        rel?.artistCredit ||
        groupTracks[0]?.artistCredit ||
        'Various Artists'
      const releaseYear =
        rel?.releaseYear ||
        rel?.originalYear ||
        groupTracks.find((t) => t.pendingSidecarEdits?.year)?.pendingSidecarEdits?.year

      const rawCover =
        rel?.artwork?.frontCoverUrl ||
        groupTracks.find((t) => t.pendingSidecarEdits?.coverArtUrl)?.pendingSidecarEdits?.coverArtUrl ||
        ''
      const coverArtUrl = rawCover || getCuratedAlbumArtwork(title, composerName || artistCredit)

      const formats = Array.from(new Set(groupTracks.map((t) => t.format))).filter(Boolean)
      const sampleRates = Array.from(new Set(groupTracks.map((t) => t.sampleRateStr))).filter(Boolean)
      const avgDr =
        groupTracks.length > 0
          ? Math.round(groupTracks.reduce((acc, t) => acc + (t.drScore || 0), 0) / groupTracks.length)
          : 0
      const stagedCount = groupTracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar').length
      const variantsCount = rel?.variants?.length || 1

      cards.push({
        id: key,
        release: rel,
        title,
        folderName,
        composerName,
        artistCredit,
        releaseYear,
        coverArtUrl,
        formats,
        sampleRates,
        avgDr,
        tracks: groupTracks,
        stagedCount,
        variantsCount,
        rating: rel?.rating || 0,
        isFavorite: Boolean(rel?.isFavorite),
        isMasterpiece: Boolean(rel?.isMasterpiece),
      })
    })

    // Filter by quick search
    const filtered = cards.filter((album) => {
      if (!searchFilter.trim()) return true
      const q = searchFilter.toLowerCase()
      return (
        album.title.toLowerCase().includes(q) ||
        album.artistCredit.toLowerCase().includes(q) ||
        album.composerName.toLowerCase().includes(q) ||
        album.formats.some((f) => f.toLowerCase().includes(q))
      )
    })

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'year_desc':
          return (b.releaseYear || 0) - (a.releaseYear || 0)
        case 'year_asc':
          return (a.releaseYear || 0) - (b.releaseYear || 0)
        case 'artist_asc':
          return a.artistCredit.localeCompare(b.artistCredit)
        case 'title_asc':
          return a.title.localeCompare(b.title)
        case 'dr_desc':
          return b.avgDr - a.avgDr
        default:
          return 0
      }
    })

    return { unfilteredCards: cards, albumCards: filtered }
  }, [tracks, releases, searchFilter, sortBy])

  // Drilldown Selected Album
  const selectedAlbum = useMemo(() => {
    if (!selectedAlbumId) return null
    return unfilteredCards.find((a) => a.id === selectedAlbumId) || null
  }, [unfilteredCards, selectedAlbumId])

  // Drilldown Filtered Albums for Selected Artist
  const artistFilteredAlbums = useMemo(() => {
    if (!selectedArtist) return []
    return unfilteredCards.filter(
      (a) => (a.artistCredit || 'Various Artists').toLowerCase() === selectedArtist.toLowerCase()
    )
  }, [unfilteredCards, selectedArtist])

  // Drilldown Filtered Albums for Selected Composer
  const composerFilteredAlbums = useMemo(() => {
    if (!selectedComposer) return []
    return unfilteredCards.filter(
      (a) => (a.composerName || 'Contemporary').toLowerCase() === selectedComposer.toLowerCase()
    )
  }, [unfilteredCards, selectedComposer])

  // Group by Artists
  const artistGroups = useMemo(() => {
    const map = new Map<string, { artist: string; albums: AlbumCardData[]; tracksCount: number }>()
    albumCards.forEach((album) => {
      const art = album.artistCredit || 'Various Artists'
      const cur = map.get(art) || { artist: art, albums: [], tracksCount: 0 }
      cur.albums.push(album)
      cur.tracksCount += album.tracks.length
      map.set(art, cur)
    })
    return Array.from(map.values()).sort((a, b) => b.albums.length - a.albums.length)
  }, [albumCards])

  // Group by Composers
  const composerGroups = useMemo(() => {
    const map = new Map<string, { composer: string; albums: AlbumCardData[]; tracksCount: number }>()
    albumCards.forEach((album) => {
      const comp = album.composerName || 'Contemporary'
      const cur = map.get(comp) || { composer: comp, albums: [], tracksCount: 0 }
      cur.albums.push(album)
      cur.tracksCount += album.tracks.length
      map.set(comp, cur)
    })
    return Array.from(map.values()).sort((a, b) => b.albums.length - a.albums.length)
  }, [albumCards])

  const handleEditAlbum = (album: AlbumCardData, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const relToEdit: Release = album.release || {
      id: album.id,
      masterReleaseId: album.id,
      title: album.title,
      folderName: album.folderName,
      artistCredit: album.artistCredit,
      composerName: album.composerName,
      originalYear: album.releaseYear || new Date().getFullYear(),
      releaseYear: album.releaseYear || new Date().getFullYear(),
      label: 'Self-Released',
      catalogNumber: '',
      mediaFormat: album.formats[0] || 'Digital Audio',
      country: '',
      matrixRunout: '',
      artwork: {
        frontCoverUrl: album.coverArtUrl || '',
        resolution: 'Custom Front Cover',
        width: 2400,
        height: 2400,
        dpi: 300,
        colorProfile: 'sRGB',
        isLowRes: false,
        hasBookletPdf: false,
      },
      variants: [],
      discsCount: 1,
      tracksCount: album.tracks.length,
      genreTags: [],
      storageMountId: album.tracks[0]?.storageMountId || '',
    }

    if (onCustomizeRelease) {
      onCustomizeRelease(relToEdit)
    }
  }

  const handleToggleFavorite = (album: AlbumCardData, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (album.release && onUpdateReleaseDetails) {
      onUpdateReleaseDetails(album.release.id, { isFavorite: !album.isFavorite })
    }
  }

  const handleSetRating = (album: AlbumCardData, star: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (album.release && onUpdateReleaseDetails) {
      const nextRating = album.rating === star ? 0 : star
      onUpdateReleaseDetails(album.release.id, { rating: nextRating })
    }
  }

  const handlePlayAlbum = (album: AlbumCardData) => {
    if (album.tracks.length > 0) {
      playTrack(album.tracks[0], album.tracks)
    }
  }

  const handleShuffleAlbum = (album: AlbumCardData) => {
    if (album.tracks.length > 0) {
      const shuffled = [...album.tracks].sort(() => Math.random() - 0.5)
      playTrack(shuffled[0], shuffled)
    }
  }

  const formatDuration = (secs?: number): string => {
    if (!secs || isNaN(secs) || secs < 0) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s < 10 ? '0' : ''}${s}`
  }

  const formatAlbumDuration = (albumTracks: Track[]): string => {
    const totalSecs = albumTracks.reduce(
      (acc, t) => acc + (t.durationSeconds || t.duration || 0),
      0
    )
    if (totalSecs <= 0) return ''
    const hrs = Math.floor(totalSecs / 3600)
    const mins = Math.floor((totalSecs % 3600) / 60)
    const secs = Math.floor(totalSecs % 60)
    if (hrs > 0) {
      return `${hrs} hr ${mins} min`
    }
    return `${mins} min ${secs} sec`
  }

  const sizeClasses = {
    compact: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3.5',
    standard: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-5',
    large: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6',
  }

  // Render a Single Album Card
  const renderAlbumCard = (album: AlbumCardData) => {
    const drClass = IntegrityScanner.getDrBadgeClass(album.avgDr)

    return (
      <div
        key={album.id}
        onClick={() => {
          setSelectedAlbumId(album.id)
          if (album.tracks.length > 0) {
            onSelectTrack(album.tracks[0].id)
          }
          if (album.release) {
            onInspectRelease(album.release.id)
          }
        }}
        className="group/card flex flex-col bg-[#12151D]/60 hover:bg-[#161B26] border border-white/[0.08] hover:border-[#00F5FF]/50 rounded-2xl p-3 transition-all duration-200 cursor-pointer shadow-lg hover:shadow-2xl hover:shadow-[#00F5FF]/10 relative select-none"
      >
        {/* Artwork Container */}
        <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-black/80 border border-white/[0.1] shadow-inner mb-3">
          {/* Always present fallback background */}
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-[#1E2536] via-[#141824] to-[#0A0D14] text-[#64748B] p-3 text-center">
            <Disc3 className="w-12 h-12 text-[#38BDF8]/40 mb-1 group-hover/card:rotate-45 transition-transform duration-500" />
            <span className="text-[10px] font-mono text-slate-400 line-clamp-2 px-1">
              {album.title}
            </span>
          </div>

          {album.coverArtUrl ? (
            <img
              src={album.coverArtUrl}
              alt={album.title}
              className="absolute inset-0 w-full h-full object-cover group-hover/card:scale-105 transition-transform duration-300 z-[1]"
              loading="lazy"
              onError={(e) => {
                ;(e.target as HTMLElement).style.display = 'none'
              }}
            />
          ) : null}

          {/* Top-Right Badges: Format & Staged Status */}
          <div className="absolute top-2 right-2 flex items-center gap-1 z-10">
            {album.stagedCount > 0 && (
              <span
                className="px-1.5 py-0.5 rounded-md bg-[#F59E0B] text-black font-mono font-bold text-[9px] shadow-md flex items-center gap-1"
                title={`${album.stagedCount} uncommitted sidecar edits`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
                <span>Staged</span>
              </span>
            )}

            {album.formats.length > 0 && (
              <span className="px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-md text-white font-mono font-semibold text-[10px] border border-white/20 shadow-md">
                {album.formats[0]}
              </span>
            )}
          </div>

          {/* Top-Left: High-Res or Masterpiece indicator */}
          <div className="absolute top-2 left-2 flex items-center gap-1 z-10">
            {album.isMasterpiece && (
              <span className="px-1.5 py-0.5 rounded-md bg-gradient-to-r from-amber-500 to-orange-500 text-black font-bold text-[9px] shadow-md flex items-center gap-0.5">
                <Flame className="w-2.5 h-2.5 fill-current" />
                <span>Masterpiece</span>
              </span>
            )}
          </div>

          {/* Hover Overlay: Play & Quick Edit Actions */}
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2 backdrop-blur-[2px] z-10">
            <button
              onClick={(e) => {
                e.stopPropagation()
                handlePlayAlbum(album)
              }}
              className="w-11 h-11 rounded-full bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black flex items-center justify-center shadow-xl hover:scale-110 active:scale-95 transition-all cursor-pointer"
              title="Play Album"
            >
              <Play className="w-5 h-5 fill-current ml-0.5" />
            </button>

            <button
              onClick={(e) => handleEditAlbum(album, e)}
              className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 text-white backdrop-blur-md border border-white/20 flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer"
              title="Customize Album Metadata & Artwork"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Album Details */}
        <div className="flex flex-col min-w-0 flex-1">
          {/* Title */}
          <span
            className="font-bold text-sm text-[#F1F5F9] truncate group-hover/card:text-[#00F5FF] transition-colors"
            title={album.title}
          >
            {album.title}
          </span>

          {/* Artist / Performer (Clickable to jump to artist) */}
          <span
            onClick={(e) => {
              e.stopPropagation()
              setSelectedArtist(album.artistCredit || 'Various Artists')
              setSelectedAlbumId(null)
              setSelectedComposer(null)
            }}
            className="text-xs text-[#94A3B8] hover:text-[#00F5FF] hover:underline truncate mt-0.5 font-medium transition-colors cursor-pointer"
            title={`Filter by artist: ${album.artistCredit}`}
          >
            {album.artistCredit}
          </span>

          {/* Composer Pill (Clickable to jump to composer) */}
          {album.composerName && album.composerName !== album.artistCredit && (
            <span
              onClick={(e) => {
                e.stopPropagation()
                setSelectedComposer(album.composerName)
                setSelectedAlbumId(null)
                setSelectedArtist(null)
              }}
              className="text-[10px] text-[#EC4899] hover:text-[#F472B6] hover:underline font-mono truncate mt-0.5 flex items-center gap-1 cursor-pointer transition-colors"
              title={`Filter by composer: ${album.composerName}`}
            >
              <span>🎼</span>
              <span className="truncate">{album.composerName}</span>
            </span>
          )}

          {/* Card Footer: Year • Tracks • DR • Pressings */}
          <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono text-[#64748B] flex-wrap gap-1">
            <div className="flex items-center gap-1.5">
              {album.releaseYear && (
                <span className="text-[#94A3B8] font-semibold">{album.releaseYear}</span>
              )}
              <span className="text-white/20">&bull;</span>
              <span>{album.tracks.length} tracks</span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {album.avgDr > 0 && (
                <div
                  className={`px-1.5 py-0.2 rounded font-mono font-bold text-[10px] border ${drClass.bg} ${drClass.text}`}
                  title={`Average Dynamic Range: DR${album.avgDr}`}
                >
                  DR{album.avgDr}
                </div>
              )}
              {album.variantsCount > 1 && (
                <span
                  className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-0.5"
                  title={`${album.variantsCount} Master Pressings Stacked`}
                >
                  <Layers className="w-2.5 h-2.5" />
                  <span>{album.variantsCount}</span>
                </span>
              )}
            </div>
          </div>

          {/* Rating Stars row (Clickable) + Favorite Heart */}
          <div className="mt-2 flex items-center justify-between pt-1">
            <div className="flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={(e) => handleSetRating(album, star, e)}
                  className="p-0.5 hover:scale-125 transition-transform cursor-pointer"
                  title={`Rate ${star} star${star > 1 ? 's' : ''}`}
                >
                  <Star
                    className={`w-3 h-3 ${
                      album.rating >= star
                        ? 'text-amber-400 fill-amber-400'
                        : 'text-white/20 hover:text-amber-400/60'
                    }`}
                  />
                </button>
              ))}
            </div>

            <button
              onClick={(e) => handleToggleFavorite(album, e)}
              className="p-1 text-[#64748B] hover:text-[#F43F5E] cursor-pointer transition-colors"
              title={album.isFavorite ? 'Remove Favorite' : 'Mark Favorite'}
            >
              <Heart
                className={`w-3.5 h-3.5 ${
                  album.isFavorite ? 'text-[#F43F5E] fill-[#F43F5E]' : ''
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Render the Album Detail Drill-down View
  const renderAlbumDetail = (album: AlbumCardData) => {
    const drClass = IntegrityScanner.getDrBadgeClass(album.avgDr)
    const isPlayingThisAlbum =
      album.tracks.some((t) => t.id === currentTrack?.id) && isPlaying

    // Group tracks by disc number
    const discsMap = new Map<number, Track[]>()
    album.tracks.forEach((t) => {
      const disc = t.discNumber || 1
      const list = discsMap.get(disc) || []
      list.push(t)
      discsMap.set(disc, list)
    })
    const discEntries = Array.from(discsMap.entries()).sort(([a], [b]) => a - b)
    discEntries.forEach(([, dTracks]) => {
      dTracks.sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
    })

    return (
      <div className="flex flex-col gap-6 max-w-6xl mx-auto w-full">
        {/* 1. Hero Banner */}
        <div className="flex flex-col md:flex-row items-start gap-6 p-6 rounded-2xl bg-gradient-to-b from-[#181E2C] to-[#12151D] border border-white/[0.1] shadow-2xl relative overflow-hidden">
          <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />

          {/* Large Album Artwork */}
          <div className="relative w-48 h-48 sm:w-56 sm:h-56 shrink-0 rounded-2xl overflow-hidden bg-black/80 border border-white/[0.15] shadow-2xl group">
            {album.coverArtUrl ? (
              <img
                src={album.coverArtUrl}
                alt={album.title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                onError={(e) => {
                  ;(e.target as HTMLElement).style.display = 'none'
                }}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-[#1E2536] to-[#0A0D14] text-slate-500 p-4 text-center">
                <Disc3 className="w-16 h-16 text-[#38BDF8]/40 mb-2" />
                <span className="text-xs font-mono">{album.title}</span>
              </div>
            )}

            {album.isMasterpiece && (
              <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-gradient-to-r from-amber-500 to-orange-500 text-black font-bold text-[10px] shadow-md flex items-center gap-1 z-10">
                <Flame className="w-3 h-3 fill-current" />
                <span>Masterpiece</span>
              </div>
            )}
          </div>

          {/* Hero Info */}
          <div className="flex flex-col justify-between flex-1 min-w-0 h-full py-1">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono text-[#00F5FF] uppercase tracking-wider font-semibold mb-1">
                <span>Album</span>
                {album.releaseYear && (
                  <>
                    <span className="text-white/20">&bull;</span>
                    <span className="text-slate-400">{album.releaseYear}</span>
                  </>
                )}
              </div>

              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight leading-tight line-clamp-2">
                {album.title}
              </h1>

              {/* Clickable Artist */}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => {
                    setSelectedArtist(album.artistCredit || 'Various Artists')
                    setSelectedAlbumId(null)
                    setSelectedComposer(null)
                  }}
                  className="text-base sm:text-lg font-semibold text-cyan-400 hover:text-cyan-300 hover:underline cursor-pointer transition-colors"
                  title={`Go to artist: ${album.artistCredit}`}
                >
                  {album.artistCredit}
                </button>

                {album.composerName && album.composerName !== album.artistCredit && (
                  <>
                    <span className="text-white/20">&bull;</span>
                    <button
                      onClick={() => {
                        setSelectedComposer(album.composerName)
                        setSelectedAlbumId(null)
                        setSelectedArtist(null)
                      }}
                      className="text-xs sm:text-sm font-medium text-[#EC4899] hover:text-[#F472B6] hover:underline cursor-pointer flex items-center gap-1 transition-colors"
                      title={`Go to composer: ${album.composerName}`}
                    >
                      <span>🎼</span>
                      <span>{album.composerName}</span>
                    </button>
                  </>
                )}
              </div>

              {/* Badges Bar */}
              <div className="mt-3 flex items-center gap-2 flex-wrap text-xs">
                {album.formats.map((fmt) => (
                  <span
                    key={fmt}
                    className="px-2 py-0.5 rounded-md bg-white/[0.08] text-white font-mono font-semibold text-[11px] border border-white/[0.12]"
                  >
                    {fmt}
                  </span>
                ))}

                {album.sampleRates.map((sr) => (
                  <span
                    key={sr}
                    className="px-2 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 font-mono text-[11px] border border-cyan-500/30"
                  >
                    {sr}
                  </span>
                ))}

                {album.avgDr > 0 && (
                  <span
                    className={`px-2 py-0.5 rounded-md font-mono font-bold text-[11px] border ${drClass.bg} ${drClass.text}`}
                    title={`Average Dynamic Range: DR${album.avgDr}`}
                  >
                    DR{album.avgDr}
                  </span>
                )}

                {album.variantsCount > 1 && (
                  <span className="px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 font-mono text-[11px] border border-purple-500/30 flex items-center gap-1">
                    <Layers className="w-3 h-3" />
                    <span>{album.variantsCount} Pressings</span>
                  </span>
                )}

                {album.stagedCount > 0 && (
                  <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 font-mono text-[11px] border border-amber-500/30 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    <span>{album.stagedCount} Staged</span>
                  </span>
                )}

                <span className="text-white/20">&bull;</span>
                <span className="text-slate-400 font-mono text-xs">
                  {album.tracks.length} Tracks &bull; {formatAlbumDuration(album.tracks)}
                </span>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="mt-5 flex items-center gap-3 flex-wrap">
              <button
                onClick={() => handlePlayAlbum(album)}
                className="px-5 py-2.5 rounded-xl bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black font-bold text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{isPlayingThisAlbum ? 'Resume Album' : 'Play Album'}</span>
              </button>

              <button
                onClick={() => handleShuffleAlbum(album)}
                className="px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              >
                <Shuffle className="w-4 h-4 text-cyan-400" />
                <span>Shuffle</span>
              </button>

              <button
                onClick={(e) => handleEditAlbum(album, e)}
                className="px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              >
                <SlidersHorizontal className="w-4 h-4 text-slate-400" />
                <span>Edit Metadata</span>
              </button>

              {/* Rating Stars */}
              <div className="flex items-center gap-1 px-3 py-2 rounded-xl bg-black/40 border border-white/[0.08]">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={(e) => handleSetRating(album, star, e)}
                    className="p-0.5 hover:scale-125 transition-transform cursor-pointer"
                  >
                    <Star
                      className={`w-4 h-4 ${
                        album.rating >= star
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-white/20 hover:text-amber-400/60'
                      }`}
                    />
                  </button>
                ))}
              </div>

              {/* Favorite Heart */}
              <button
                onClick={(e) => handleToggleFavorite(album, e)}
                className="p-2.5 rounded-xl bg-black/40 border border-white/[0.08] text-[#64748B] hover:text-[#F43F5E] cursor-pointer transition-colors"
                title={album.isFavorite ? 'Remove Favorite' : 'Mark Favorite'}
              >
                <Heart
                  className={`w-4 h-4 ${
                    album.isFavorite ? 'text-[#F43F5E] fill-[#F43F5E]' : ''
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* 2. Tracklist Table */}
        <div className="rounded-2xl bg-[#12151D]/80 border border-white/[0.08] overflow-hidden shadow-xl">
          {discEntries.map(([discNum, dTracks]) => (
            <div key={discNum} className="last:border-b-0 border-b border-white/[0.06]">
              {discEntries.length > 1 && (
                <div className="px-5 py-2.5 bg-white/[0.03] border-b border-white/[0.06] flex items-center gap-2 text-xs font-mono font-bold text-slate-400">
                  <Disc3 className="w-4 h-4 text-cyan-400" />
                  <span>Disc {discNum}</span>
                  <span className="text-white/20">&bull;</span>
                  <span className="font-normal text-slate-500">{dTracks.length} tracks</span>
                </div>
              )}

              {/* Table Header */}
              <div className="grid grid-cols-12 gap-3 px-5 py-2.5 text-[11px] font-mono text-[#64748B] border-b border-white/[0.04] uppercase tracking-wider">
                <div className="col-span-1 text-center">#</div>
                <div className="col-span-6 sm:col-span-7">Title</div>
                <div className="col-span-3 sm:col-span-2 text-right">Format / Spec</div>
                <div className="col-span-1 text-center">DR</div>
                <div className="col-span-1 text-right">Time</div>
              </div>

              {/* Track Rows */}
              <div className="divide-y divide-white/[0.03]">
                {dTracks.map((track, idx) => {
                  const isCurrentPlaying = currentTrack?.id === track.id
                  const isSelected = selectedTrackId === track.id
                  const trackDrClass = IntegrityScanner.getDrBadgeClass(track.drScore)

                  return (
                    <div
                      key={track.id}
                      onClick={() => onSelectTrack(track.id)}
                      onDoubleClick={() => playTrack(track, album.tracks)}
                      className={`grid grid-cols-12 gap-3 px-5 py-2.5 items-center transition-colors cursor-pointer group/tr ${
                        isCurrentPlaying
                          ? 'bg-cyan-500/10 text-cyan-300'
                          : isSelected
                          ? 'bg-white/[0.05] text-white'
                          : 'hover:bg-white/[0.03] text-[#CBD5E1]'
                      }`}
                    >
                      {/* Track Number / Play button */}
                      <div className="col-span-1 flex items-center justify-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            playTrack(track, album.tracks)
                          }}
                          className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-cyan-400 hover:text-black transition-all cursor-pointer"
                          title="Play Track"
                        >
                          {isCurrentPlaying && isPlaying ? (
                            <Volume2 className="w-3.5 h-3.5 text-[#00F5FF] animate-pulse" />
                          ) : (
                            <>
                              <span className="group-hover/tr:hidden text-xs font-mono text-[#64748B]">
                                {track.trackNumber
                                  ? String(track.trackNumber).padStart(2, '0')
                                  : idx + 1}
                              </span>
                              <Play className="w-3.5 h-3.5 fill-current hidden group-hover/tr:block ml-0.5" />
                            </>
                          )}
                        </button>
                      </div>

                      {/* Title & Classical movement */}
                      <div className="col-span-6 sm:col-span-7 min-w-0 pr-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-xs font-semibold truncate ${
                              isCurrentPlaying ? 'text-[#00F5FF]' : 'text-white'
                            }`}
                          >
                            {track.title}
                          </span>
                          {track.sidecarStatus === 'uncommitted_sidecar' && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                              title="Staged sidecar edit"
                            />
                          )}
                        </div>
                        {(track.movementTitle || track.workTitle) && (
                          <div className="text-[10px] text-slate-400 truncate mt-0.5 font-mono">
                            {track.movementNumber ? `${track.movementNumber}. ` : ''}
                            {track.movementTitle || track.workTitle}
                          </div>
                        )}
                        {track.artistCredit && track.artistCredit !== album.artistCredit && (
                          <div className="text-[10px] text-[#94A3B8] truncate mt-0.5">
                            {track.artistCredit}
                          </div>
                        )}
                      </div>

                      {/* Spec badge */}
                      <div className="col-span-3 sm:col-span-2 text-right min-w-0">
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-400 bg-white/[0.04] border border-white/[0.06] truncate">
                          {track.format} {track.sampleRateStr}
                        </span>
                      </div>

                      {/* DR */}
                      <div className="col-span-1 text-center">
                        {track.drScore > 0 ? (
                          <span
                            className={`px-1 py-0.2 rounded font-mono font-bold text-[9px] border ${trackDrClass.bg} ${trackDrClass.text}`}
                          >
                            DR{track.drScore}
                          </span>
                        ) : (
                          <span className="text-[10px] font-mono text-white/20">-</span>
                        )}
                      </div>

                      {/* Duration */}
                      <div className="col-span-1 text-right text-xs font-mono text-[#64748B]">
                        {formatDuration(track.durationSeconds || track.duration)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Render Artist Detail View
  const renderArtistDetail = (artistName: string, albums: AlbumCardData[]) => {
    const artistTracks = albums.flatMap((a) => a.tracks)
    return (
      <div className="flex flex-col gap-6 max-w-6xl mx-auto w-full">
        {/* Artist Hero */}
        <div className="flex items-center justify-between gap-6 p-6 rounded-2xl bg-gradient-to-r from-[#1E2536] via-[#12151D] to-[#0D0E12] border border-white/[0.08] shadow-xl">
          <div className="flex items-center gap-5">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-black/60 border-2 border-[#00F5FF]/60 shadow-lg shrink-0 flex items-center justify-center">
              {albums[0]?.coverArtUrl ? (
                <img
                  src={albums[0].coverArtUrl}
                  alt={artistName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <User className="w-10 h-10 text-[#00F5FF]" />
              )}
            </div>
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-cyan-400 font-semibold">
                Artist Discography
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-0.5">
                {artistName}
              </h1>
              <div className="text-xs text-slate-400 font-mono mt-1">
                {albums.length} Album{albums.length > 1 ? 's' : ''} &bull; {artistTracks.length} Tracks in Library
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              if (artistTracks.length > 0) {
                playTrack(artistTracks[0], artistTracks)
              }
            }}
            className="px-5 py-2.5 rounded-xl bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black font-bold text-xs flex items-center gap-2 shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer shrink-0"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Play All</span>
          </button>
        </div>

        {/* Artist Albums Grid */}
        <div>
          <h2 className="text-xs uppercase font-mono tracking-wider text-slate-400 font-bold mb-3 px-1">
            Albums & Releases
          </h2>
          <div className={`grid ${sizeClasses[cardSize]}`}>
            {albums.map((album) => renderAlbumCard(album))}
          </div>
        </div>
      </div>
    )
  }

  // Render Composer Detail View
  const renderComposerDetail = (composerName: string, albums: AlbumCardData[]) => {
    const composerTracks = albums.flatMap((a) => a.tracks)
    return (
      <div className="flex flex-col gap-6 max-w-6xl mx-auto w-full">
        {/* Composer Hero */}
        <div className="flex items-center justify-between gap-6 p-6 rounded-2xl bg-gradient-to-r from-[#2A1826] via-[#16121B] to-[#0D0E12] border border-white/[0.08] shadow-xl">
          <div className="flex items-center gap-5">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-black/60 border-2 border-[#EC4899]/60 shadow-lg shrink-0 flex items-center justify-center text-3xl">
              {albums[0]?.coverArtUrl ? (
                <img
                  src={albums[0].coverArtUrl}
                  alt={composerName}
                  className="w-full h-full object-cover"
                />
              ) : (
                '🎼'
              )}
            </div>
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-[#EC4899] font-semibold">
                Composer Catalog & Works
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-0.5">
                {composerName}
              </h1>
              <div className="text-xs text-slate-400 font-mono mt-1">
                {albums.length} Release{albums.length > 1 ? 's' : ''} &bull; {composerTracks.length} Works / Movements
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              if (composerTracks.length > 0) {
                playTrack(composerTracks[0], composerTracks)
              }
            }}
            className="px-5 py-2.5 rounded-xl bg-[#EC4899] hover:bg-[#EC4899]/90 text-white font-bold text-xs flex items-center gap-2 shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer shrink-0"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Play Works</span>
          </button>
        </div>

        {/* Composer Albums Grid */}
        <div>
          <h2 className="text-xs uppercase font-mono tracking-wider text-slate-400 font-bold mb-3 px-1">
            Compositions & Albums
          </h2>
          <div className={`grid ${sizeClasses[cardSize]}`}>
            {albums.map((album) => renderAlbumCard(album))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full bg-[#0D0E12] select-none overflow-hidden">
      {/* 1. Sub-Header Toolbar with Breadcrumbs & Controls */}
      <div className="px-5 py-3 bg-[#12151D] border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0 flex-wrap">
        {/* Left: Breadcrumbs or Entity tabs */}
        {selectedAlbum ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedAlbumId(null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#00F5FF]/50"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-[#00F5FF]" />
              <span>
                {selectedArtist
                  ? `Back to ${selectedArtist}`
                  : selectedComposer
                  ? `Back to ${selectedComposer}`
                  : 'Back to Albums'}
              </span>
            </button>
            <span className="text-white/20">&bull;</span>
            <div className="flex items-center gap-1.5 text-xs font-mono text-[#94A3B8]">
              <span
                onClick={() => {
                  setSelectedAlbumId(null)
                  setSelectedArtist(null)
                  setSelectedComposer(null)
                  setActiveTab('albums')
                }}
                className="hover:text-white cursor-pointer"
              >
                Albums
              </span>
              {selectedArtist && (
                <>
                  <ChevronRight className="w-3 h-3 text-white/30" />
                  <span
                    onClick={() => setSelectedAlbumId(null)}
                    className="hover:text-white cursor-pointer text-cyan-400"
                  >
                    {selectedArtist}
                  </span>
                </>
              )}
              {selectedComposer && (
                <>
                  <ChevronRight className="w-3 h-3 text-white/30" />
                  <span
                    onClick={() => setSelectedAlbumId(null)}
                    className="hover:text-white cursor-pointer text-pink-400"
                  >
                    {selectedComposer}
                  </span>
                </>
              )}
              <ChevronRight className="w-3 h-3 text-white/30" />
              <span className="text-white font-semibold truncate max-w-[200px] sm:max-w-xs">
                {selectedAlbum.title}
              </span>
            </div>
          </div>
        ) : selectedArtist ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedArtist(null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#00F5FF]/50"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-[#00F5FF]" />
              <span>All Artists</span>
            </button>
            <span className="text-white/20">&bull;</span>
            <div className="flex items-center gap-1.5 text-xs font-mono text-[#94A3B8]">
              <span
                onClick={() => setSelectedArtist(null)}
                className="hover:text-white cursor-pointer"
              >
                Artists
              </span>
              <ChevronRight className="w-3 h-3 text-white/30" />
              <span className="text-cyan-400 font-semibold">{selectedArtist}</span>
            </div>
          </div>
        ) : selectedComposer ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedComposer(null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#EC4899]/50"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-[#EC4899]" />
              <span>All Composers</span>
            </button>
            <span className="text-white/20">&bull;</span>
            <div className="flex items-center gap-1.5 text-xs font-mono text-[#94A3B8]">
              <span
                onClick={() => setSelectedComposer(null)}
                className="hover:text-white cursor-pointer"
              >
                Composers
              </span>
              <ChevronRight className="w-3 h-3 text-white/30" />
              <span className="text-pink-400 font-semibold">{selectedComposer}</span>
            </div>
          </div>
        ) : (
          /* Normal tabs: Albums, Artists, Composers */
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.08]">
              <button
                onClick={() => {
                  setActiveTab('albums')
                  setSelectedAlbumId(null)
                  setSelectedArtist(null)
                  setSelectedComposer(null)
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'albums'
                    ? 'bg-[#00F5FF] text-black shadow-sm'
                    : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                Albums ({albumCards.length})
              </button>
              <button
                onClick={() => {
                  setActiveTab('artists')
                  setSelectedAlbumId(null)
                  setSelectedArtist(null)
                  setSelectedComposer(null)
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'artists'
                    ? 'bg-[#00F5FF] text-black shadow-sm'
                    : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                Artists ({artistGroups.length})
              </button>
              <button
                onClick={() => {
                  setActiveTab('composers')
                  setSelectedAlbumId(null)
                  setSelectedArtist(null)
                  setSelectedComposer(null)
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  activeTab === 'composers'
                    ? 'bg-[#00F5FF] text-black shadow-sm'
                    : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                Composers ({composerGroups.length})
              </button>
            </div>

            <span className="text-white/20">&bull;</span>
            <span className="text-xs font-mono text-[#64748B]">
              {tracks.length} Tracks in Library
            </span>
          </div>
        )}

        {/* Right: Quick Search, Sort, Size Slider (hidden in album detail for focus) */}
        {!selectedAlbum && (
          <div className="flex items-center gap-3">
            {/* Quick Filter */}
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-2.5 pointer-events-none" />
              <input
                type="text"
                placeholder="Filter grid..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="pl-8 pr-3 py-1 rounded-lg bg-black/40 border border-white/[0.1] text-xs text-white placeholder-[#64748B] focus:border-[#00F5FF] focus:outline-none w-40 md:w-52 transition-all font-sans"
              />
            </div>

            {/* Sort By Dropdown */}
            <div className="flex items-center gap-1.5 text-xs text-[#94A3B8]">
              <span className="text-[11px] font-mono">Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="bg-black/40 border border-white/[0.1] rounded-lg px-2.5 py-1 text-xs text-[#CBD5E1] focus:border-[#00F5FF] focus:outline-none cursor-pointer"
              >
                <option value="year_desc">Year (Newest First)</option>
                <option value="year_asc">Year (Oldest First)</option>
                <option value="artist_asc">Artist (A-Z)</option>
                <option value="title_asc">Album Title (A-Z)</option>
                <option value="dr_desc">Dynamic Range (Avg DR)</option>
              </select>
            </div>

            {/* Card Size Selector */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[11px] font-mono text-[#94A3B8]">
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
          </div>
        )}
      </div>

      {/* 2. Main Scrollable Container */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 pb-32">
        {/* VIEW 1: Album Detail Drill-down */}
        {selectedAlbum ? (
          renderAlbumDetail(selectedAlbum)
        ) : selectedArtist ? (
          /* VIEW 2: Artist Detail Drill-down */
          renderArtistDetail(selectedArtist, artistFilteredAlbums)
        ) : selectedComposer ? (
          /* VIEW 3: Composer Detail Drill-down */
          renderComposerDetail(selectedComposer, composerFilteredAlbums)
        ) : (
          /* VIEW 4: Main Tabs */
          <>
            {activeTab === 'albums' && (
              <>
                {albumCards.length === 0 ? (
                  <div className="h-64 flex flex-col items-center justify-center text-[#64748B] gap-2">
                    <Disc3 className="w-10 h-10 text-white/20 animate-pulse" />
                    <p className="text-sm">No albums match your current filter.</p>
                  </div>
                ) : (
                  <div className={`grid ${sizeClasses[cardSize]}`}>
                    {albumCards.map((album) => renderAlbumCard(album))}
                  </div>
                )}
              </>
            )}

            {/* Artists Tab */}
            {activeTab === 'artists' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {artistGroups.map((group) => (
                  <div
                    key={group.artist}
                    onClick={() => {
                      setSelectedArtist(group.artist)
                      if (group.albums[0]?.tracks[0]) {
                        onSelectTrack(group.albums[0].tracks[0].id)
                      }
                    }}
                    className="flex flex-col items-center text-center p-4 rounded-2xl bg-[#12151D]/60 hover:bg-[#161B26] border border-white/[0.08] hover:border-[#00F5FF]/50 transition-all cursor-pointer group/art shadow-lg"
                  >
                    <div className="w-24 h-24 rounded-full overflow-hidden bg-black/60 border-2 border-white/10 group-hover/art:border-[#00F5FF] mb-3 shadow-md flex items-center justify-center">
                      {group.albums[0]?.coverArtUrl ? (
                        <img
                          src={group.albums[0].coverArtUrl}
                          alt={group.artist}
                          className="w-full h-full object-cover group-hover/art:scale-105 transition-transform"
                        />
                      ) : (
                        <User className="w-10 h-10 text-[#38BDF8]" />
                      )}
                    </div>
                    <span className="font-bold text-sm text-[#F1F5F9] group-hover/art:text-[#00F5FF] truncate max-w-full">
                      {group.artist}
                    </span>
                    <span className="text-xs font-mono text-[#94A3B8] mt-1">
                      {group.albums.length} Album{group.albums.length > 1 ? 's' : ''} &bull; {group.tracksCount} Tracks
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Composers Tab */}
            {activeTab === 'composers' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {composerGroups.map((group) => (
                  <div
                    key={group.composer}
                    onClick={() => {
                      setSelectedComposer(group.composer)
                      if (group.albums[0]?.tracks[0]) {
                        onSelectTrack(group.albums[0].tracks[0].id)
                      }
                    }}
                    className="flex flex-col items-center text-center p-4 rounded-2xl bg-[#12151D]/60 hover:bg-[#161B26] border border-white/[0.08] hover:border-[#EC4899]/50 transition-all cursor-pointer group/comp shadow-lg"
                  >
                    <div className="w-24 h-24 rounded-full overflow-hidden bg-black/60 border-2 border-white/10 group-hover/comp:border-[#EC4899] mb-3 shadow-md flex items-center justify-center">
                      {group.albums[0]?.coverArtUrl ? (
                        <img
                          src={group.albums[0].coverArtUrl}
                          alt={group.composer}
                          className="w-full h-full object-cover group-hover/comp:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="text-3xl">🎼</div>
                      )}
                    </div>
                    <span className="font-bold text-sm text-[#F1F5F9] group-hover/comp:text-[#EC4899] truncate max-w-full">
                      {group.composer}
                    </span>
                    <span className="text-xs font-mono text-[#94A3B8] mt-1">
                      {group.albums.length} Album{group.albums.length > 1 ? 's' : ''} &bull; {group.tracksCount} Works
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
