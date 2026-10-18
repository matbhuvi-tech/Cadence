import React, { useState, useMemo } from 'react'
import {
  Play,
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

  // Group tracks into robust AlbumCardData objects
  const albumCards = useMemo<AlbumCardData[]>(() => {
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

    return filtered
  }, [tracks, releases, searchFilter, sortBy])

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

  const handleToggleFavorite = (album: AlbumCardData, e: React.MouseEvent) => {
    e.stopPropagation()
    if (album.release && onUpdateReleaseDetails) {
      onUpdateReleaseDetails(album.release.id, { isFavorite: !album.isFavorite })
    }
  }

  const handleSetRating = (album: AlbumCardData, star: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (album.release && onUpdateReleaseDetails) {
      const nextRating = album.rating === star ? 0 : star
      onUpdateReleaseDetails(album.release.id, { rating: nextRating })
    }
  }

  const sizeClasses = {
    compact: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3.5',
    standard: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-5',
    large: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6',
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full bg-[#0D0E12] select-none overflow-hidden">
      {/* 1. Sub-Header Toolbar (Mockup Section 1 style) */}
      <div className="px-5 py-3 bg-[#12151D] border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0 flex-wrap">
        {/* Left: Entity tabs & Catalog counts */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.08]">
            <button
              onClick={() => setActiveTab('albums')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'albums'
                  ? 'bg-[#00F5FF] text-black shadow-sm'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              Albums ({albumCards.length})
            </button>
            <button
              onClick={() => setActiveTab('artists')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'artists'
                  ? 'bg-[#00F5FF] text-black shadow-sm'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              Artists ({artistGroups.length})
            </button>
            <button
              onClick={() => setActiveTab('composers')}
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

        {/* Right: Quick Search, Sort, Size Slider */}
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
      </div>

      {/* 2. Main Scrollable Container */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 pb-32">
        {activeTab === 'albums' && (
          <>
            {albumCards.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center text-[#64748B] gap-2">
                <Disc3 className="w-10 h-10 text-white/20 animate-pulse" />
                <p className="text-sm">No albums match your current filter.</p>
              </div>
            ) : (
              <div className={`grid ${sizeClasses[cardSize]}`}>
                {albumCards.map((album) => {
                  const isCurrentPlayingAlbum = album.tracks.some((t) => t.id === currentTrack?.id)
                  const drClass = IntegrityScanner.getDrBadgeClass(album.avgDr)

                  return (
                    <div
                      key={album.id}
                      onClick={() => {
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
                          <span className="text-[10px] font-mono text-slate-400 line-clamp-2 px-1">{album.title}</span>
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
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2 backdrop-blur-[2px]">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (album.tracks.length > 0) {
                                playTrack(album.tracks[0], album.tracks)
                              }
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

                        {/* Artist / Performer */}
                        <span
                          className="text-xs text-[#94A3B8] truncate mt-0.5 font-medium"
                          title={album.artistCredit}
                        >
                          {album.artistCredit}
                        </span>

                        {/* Composer Pill (if classical/film) */}
                        {album.composerName && album.composerName !== album.artistCredit && (
                          <span
                            className="text-[10px] text-[#EC4899] font-mono truncate mt-0.5 flex items-center gap-1"
                            title={`Composer: ${album.composerName}`}
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
                            <Heart className={`w-3.5 h-3.5 ${album.isFavorite ? 'text-[#F43F5E] fill-[#F43F5E]' : ''}`} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
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
                  if (group.albums[0]?.tracks[0]) {
                    onSelectTrack(group.albums[0].tracks[0].id)
                  }
                }}
                className="flex flex-col items-center text-center p-4 rounded-2xl bg-[#12151D]/60 hover:bg-[#161B26] border border-white/[0.08] hover:border-[#00F5FF]/50 transition-all cursor-pointer group/art shadow-lg"
              >
                <div className="w-24 h-24 rounded-full overflow-hidden bg-black/60 border-2 border-white/10 group-hover/art:border-[#00F5FF] mb-3 shadow-md">
                  {group.albums[0]?.coverArtUrl ? (
                    <img
                      src={group.albums[0].coverArtUrl}
                      alt={group.artist}
                      className="w-full h-full object-cover group-hover/art:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[#64748B]">
                      <User className="w-10 h-10 text-[#38BDF8]" />
                    </div>
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
      </div>
    </div>
  )
}
