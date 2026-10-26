import React, { useState, useMemo, useEffect } from 'react'
import {
  Play,
  Shuffle,
  ArrowLeft,
  ChevronRight,
  SlidersHorizontal,
  Disc3,
  Layers,
  Star,
  Heart,
  User,
  Search,
  Flame,
  Volume2,
  ArrowUpToLine,
  ListPlus,
  BookmarkPlus,
} from 'lucide-react'
import { Track, Release } from '../../core/types'
import { getCuratedAlbumArtwork, generateMonogramAvatar } from '../../core/taxonomyUtils'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { IntegrityScanner } from '../../services/integrityScanner'
import { ArtistsView } from './ArtistsView'

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
  activeTab?: EntityTab
  onActiveTabChange?: (tab: EntityTab) => void
  sortBy?: SortBy
  onSortByChange?: (sortBy: SortBy) => void
  cardSize?: CardSize
  onCardSizeChange?: (cardSize: CardSize) => void
  hideSubHeader?: boolean
  selectedAlbumId?: string | null
  onSelectAlbumId?: (albumId: string | null) => void
  selectedArtist?: string | null
  onSelectArtist?: (artist: string | null) => void
  selectedComposer?: string | null
  onSelectComposer?: (composer: string | null) => void
}

export type EntityTab = 'albums' | 'artists' | 'composers'
export type SortBy = 'year_desc' | 'year_asc' | 'artist_asc' | 'title_asc' | 'dr_desc'
export type CardSize = 'compact' | 'standard' | 'large'

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
  onOpenBatchDiff: _onOpenBatchDiff,
  activeTab: propActiveTab,
  onActiveTabChange,
  sortBy: propSortBy,
  onSortByChange,
  cardSize: propCardSize,
  onCardSizeChange,
  hideSubHeader = false,
  selectedAlbumId: propSelectedAlbumId,
  onSelectAlbumId: propOnSelectAlbumId,
  selectedArtist: propSelectedArtist,
  onSelectArtist: propOnSelectArtist,
  selectedComposer: propSelectedComposer,
  onSelectComposer: propOnSelectComposer,
}) => {
  const { playTrack, currentTrack, isPlaying, playNext, addToQueue } = useAudioPlayer()

  const [internalActiveTab, setInternalActiveTab] = useState<EntityTab>('albums')
  const [searchFilter, setSearchFilter] = useState('')
  const [internalSortBy, setInternalSortBy] = useState<SortBy>('year_desc')
  const [internalCardSize, setInternalCardSize] = useState<CardSize>('standard')

  const activeTab = propActiveTab ?? internalActiveTab
  const setActiveTab = onActiveTabChange ?? setInternalActiveTab

  const sortBy = propSortBy ?? internalSortBy
  const setSortBy = onSortByChange ?? setInternalSortBy

  const cardSize = propCardSize ?? internalCardSize
  const setCardSize = onCardSizeChange ?? setInternalCardSize

  // Inline drill-down navigation state (lifted or internal)
  const [internalSelectedAlbumId, setInternalSelectedAlbumId] = useState<string | null>(null)
  const [internalSelectedArtist, setInternalSelectedArtist] = useState<string | null>(null)
  const [internalSelectedComposer, setInternalSelectedComposer] = useState<string | null>(null)

  const selectedAlbumId = propSelectedAlbumId !== undefined ? propSelectedAlbumId : internalSelectedAlbumId
  const setSelectedAlbumId = propOnSelectAlbumId ?? setInternalSelectedAlbumId

  const selectedArtist = propSelectedArtist !== undefined ? propSelectedArtist : internalSelectedArtist
  const setSelectedArtist = propOnSelectArtist ?? setInternalSelectedArtist

  const selectedComposer = propSelectedComposer !== undefined ? propSelectedComposer : internalSelectedComposer
  const setSelectedComposer = propOnSelectComposer ?? setInternalSelectedComposer

  // Active Edition / Pressing Variant within the selected album detail view
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null)

  useEffect(() => {
    setActiveVariantId(null)
  }, [selectedAlbumId])

  // Map of canonical artist/composer name (lowercase) -> portraitUrl
  const [composerPortraits, setComposerPortraits] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    sqliteLibraryService
      .getCanonicalArtists(releases, tracks)
      .then((artists) => {
        const map = new Map<string, string>()
        artists.forEach((a) => {
          if (a.portraitUrl) {
            map.set(a.name.toLowerCase().trim(), a.portraitUrl)
          }
        })
        setComposerPortraits(map)
      })
      .catch((err) => {
        console.warn('[AlbumCoverGrid] Failed to load composer portraits:', err)
      })
  }, [releases, tracks])

  // Group tracks into robust AlbumCardData objects (both unfiltered and filtered)
  const { unfilteredCards, albumCards } = useMemo(() => {
    const groupMap = new Map<string, Track[]>()

    tracks.forEach((track) => {
      const key =
        track.masterReleaseId ||
        track.releaseId ||
        track.pendingSidecarEdits?.album ||
        track.folderPath ||
        track.folderName ||
        'unknown'
      const existing = groupMap.get(key) || []
      existing.push(track)
      groupMap.set(key, existing)
    })

    const cards: AlbumCardData[] = []

    groupMap.forEach((groupTracks, key) => {
      // 1. Exact match by master release ID (current master variant preferred) or release ID
      let rel = releases.find((r) => r.masterReleaseId === key && r.variants?.some((v) => v.isCurrentMaster))
      if (!rel) {
        rel = releases.find((r) => r.masterReleaseId === key)
      }
      if (!rel) {
        rel = releases.find((r) => r.id === key)
      }
      // 2. Exact match by folder path
      if (!rel) {
        rel = releases.find((r) => r.folderPath && groupTracks.some((t) => t.folderPath && t.folderPath === r.folderPath))
      }
      // 3. Match by pending edited album title
      if (!rel) {
        rel = releases.find((r) => r.title && groupTracks.some((t) => t.pendingSidecarEdits?.album === r.title))
      }
      // 4. Scoped fallback: folderName ONLY if artist or album title also matches
      if (!rel) {
        rel = releases.find(
          (r) =>
            r.folderName &&
            groupTracks.some(
              (t) => t.folderName === r.folderName && (t.artistCredit === r.artistCredit || (t as any).albumTitle === r.title)
            )
        )
      }

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
        (rel?.artistCredit && !/^(unknown artist|unknown)$/i.test(rel.artistCredit) ? rel.artistCredit : undefined) ||
        groupTracks.find((t) => t.artistCredit && !/^(unknown artist|unknown)$/i.test(t.artistCredit))?.artistCredit ||
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
    return (
      unfilteredCards.find((a) => a.id === selectedAlbumId) ||
      unfilteredCards.find((a) => a.release?.id === selectedAlbumId) ||
      unfilteredCards.find((a) => a.release?.masterReleaseId === selectedAlbumId) ||
      null
    )
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
    const norm = selectedComposer.toLowerCase().trim()
    return unfilteredCards.filter((a) => {
      if ((a.composerName || '').toLowerCase().trim() === norm) return true
      return a.tracks.some(
        (t) => (t.composerName || (t as any).composer || '').toLowerCase().trim() === norm
      )
    })
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

  // Group by Composers across entire library (both release-level and track-level compositions)
  const composerGroups = useMemo(() => {
    const map = new Map<
      string,
      { composer: string; albums: AlbumCardData[]; albumIds: Set<string>; tracksCount: number }
    >()

    albumCards.forEach((album) => {
      // Collect all distinct composers that contributed to this album
      const albumComposers = new Map<string, { name: string; count: number }>()

      // 1. Release-level composer
      if (album.composerName && album.composerName.trim()) {
        const rawComp = album.composerName.trim()
        const norm = rawComp.toLowerCase()
        albumComposers.set(norm, { name: rawComp, count: 0 })
      }

      // 2. Track-level composers
      album.tracks.forEach((t) => {
        const trackComp = (t.composerName || (t as any).composer || '').trim()
        if (trackComp) {
          const norm = trackComp.toLowerCase()
          const cur = albumComposers.get(norm) || { name: trackComp, count: 0 }
          cur.count += 1
          albumComposers.set(norm, cur)
        }
      })

      // Add this album to each contributing composer's group
      albumComposers.forEach((info, norm) => {
        const cur = map.get(norm) || {
          composer: info.name,
          albums: [],
          albumIds: new Set<string>(),
          tracksCount: 0,
        }
        if (!cur.albumIds.has(album.id)) {
          cur.albumIds.add(album.id)
          cur.albums.push(album)
        }
        cur.tracksCount += info.count > 0 ? info.count : album.tracks.length
        map.set(norm, cur)
      })
    })

    return Array.from(map.values())
      .map(({ composer, albums, tracksCount }) => ({ composer, albums, tracksCount }))
      .sort(
        (a, b) =>
          b.albums.length - a.albums.length ||
          b.tracksCount - a.tracksCount ||
          a.composer.localeCompare(b.composer)
      )
  }, [albumCards])

  const handleEditAlbum = (album: AlbumCardData, e?: React.MouseEvent, targetReleaseId?: string) => {
    e?.stopPropagation()
    let relToEdit: Release | undefined = album.release
    if (targetReleaseId && releases) {
      const found = releases.find((r) => r.id === targetReleaseId)
      if (found) relToEdit = found
    }
    if (!relToEdit) {
      relToEdit = {
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

  const handlePlayAlbum = (album: AlbumCardData, trackList?: Track[]) => {
    const list = trackList || album.tracks
    if (list.length > 0) {
      playTrack(list[0], list)
    }
  }

  const handleShuffleAlbum = (album: AlbumCardData, trackList?: Track[]) => {
    const list = trackList || album.tracks
    if (list.length > 0) {
      const shuffled = [...list].sort(() => Math.random() - 0.5)
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

  // Responsive auto-fill grid column calculation (prevents window edge clipping)
  const gridStyle = useMemo(() => {
    const minWidth = cardSize === 'compact' ? 140 : cardSize === 'large' ? 240 : 180
    return {
      gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
    }
  }, [cardSize])

  // Render a Single Album Card (Apple HIG Borderless Lockup)
  const renderAlbumCard = (album: AlbumCardData) => {
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
        className="group/card flex flex-col cursor-pointer select-none transition-all duration-200 hover:-translate-y-1 relative"
      >
        {/* Borderless 1:1 Artwork Container with 8px radius and Inner Specular Ring */}
        <div
          className={`relative aspect-square w-full rounded-lg overflow-hidden bg-[#131418] apple-album-shadow mb-2.5 transition-shadow duration-300 ${
            album.variantsCount > 1 ? 'pressing-stack-layer' : ''
          }`}
        >
          {/* Fallback Artwork Background */}
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-[#1C1D24] via-[#14151B] to-[#0C0D10] text-[#636366] p-3 text-center">
            <Disc3 className="w-10 h-10 text-white/20 mb-1 group-hover/card:rotate-45 transition-transform duration-700" />
            <span className="text-[10px] font-mono text-[#8E8E93] line-clamp-2 px-1">
              {album.title}
            </span>
          </div>

          {album.coverArtUrl ? (
            <img
              src={album.coverArtUrl}
              alt={album.title}
              className="absolute inset-0 w-full h-full object-cover rounded-lg group-hover/card:scale-[1.03] transition-transform duration-500 z-[1]"
              loading="lazy"
              onError={(e) => {
                ;(e.target as HTMLElement).style.display = 'none'
              }}
            />
          ) : null}

          {/* Ultra-thin inner specular ring for sleeve boundary against dark backgrounds */}
          <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/10 pointer-events-none z-10" />

          {/* Top-Right Badges: Staged Status & Editions */}
          <div className="absolute top-2 right-2 flex items-center gap-1 z-10">
            {album.stagedCount > 0 && (
              <span
                className="px-2 py-0.5 rounded-full bg-[#F59E0B] text-black font-mono font-bold text-[9px] shadow-md flex items-center gap-1"
                title={`${album.stagedCount} uncommitted sidecar edits`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
                <span>Staged</span>
              </span>
            )}

            {album.variantsCount > 1 && (
              <span
                className="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[#E5E5EA] border border-white/15 font-mono text-[9px] shadow-sm flex items-center gap-1"
                title={`${album.variantsCount} Master Editions Stacked`}
              >
                <Layers className="w-2.5 h-2.5 text-[#D4AF37]" />
                <span>{album.variantsCount} Editions</span>
              </span>
            )}
          </div>

          {/* Top-Left: Favorite Quick Toggle (Visible on hover or when favorited) */}
          <div
            className={`absolute top-2 left-2 z-10 transition-opacity duration-200 ${
              album.isFavorite ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
            }`}
          >
            <button
              onClick={(e) => handleToggleFavorite(album, e)}
              className="w-7 h-7 rounded-full bg-black/60 backdrop-blur-md border border-white/15 text-white/80 hover:text-[#F43F5E] flex items-center justify-center transition-colors cursor-pointer shadow-sm"
              title={album.isFavorite ? 'Remove Favorite' : 'Mark Favorite'}
            >
              <Heart
                className={`w-3.5 h-3.5 ${
                  album.isFavorite ? 'text-[#F43F5E] fill-[#F43F5E]' : ''
                }`}
              />
            </button>
          </div>

          {/* Hover Overlay: Frosted Glass Play Button & Edit Trigger */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 flex items-end justify-between p-3 z-10 pointer-events-none">
            <button
              onClick={(e) => {
                e.stopPropagation()
                handlePlayAlbum(album)
              }}
              className="w-10 h-10 rounded-full bg-white/95 hover:bg-white text-black flex items-center justify-center shadow-2xl hover:scale-105 active:scale-95 transition-all cursor-pointer pointer-events-auto"
              title="Play Album"
            >
              <Play className="w-4 h-4 fill-current ml-0.5" />
            </button>

            <button
              onClick={(e) => handleEditAlbum(album, e)}
              className="w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white/90 backdrop-blur-md border border-white/20 flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer pointer-events-auto"
              title="Curate Album Metadata & Artwork"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Clean Editorial 3-Line Typography Lockup */}
        <div className="flex flex-col min-w-0">
          {/* Line 1: Album Title */}
          <span
            className="font-semibold text-[13px] text-[#F5F5F7] truncate leading-tight group-hover/card:text-white transition-colors"
            title={album.title}
          >
            {album.title}
          </span>

          {/* Line 2: Primary Artist / Composer */}
          <span
            onClick={(e) => {
              e.stopPropagation()
              setSelectedArtist(album.artistCredit || 'Various Artists')
              setSelectedAlbumId(null)
              setSelectedComposer(null)
            }}
            className="text-[12px] text-[#8E8E93] hover:text-white truncate mt-1 leading-tight transition-colors cursor-pointer"
            title={`Filter by artist: ${album.artistCredit}`}
          >
            {album.artistCredit}
          </span>

          {/* Line 3: Monospace Micro-Telemetry (Year · Format · DR) */}
          <div className="text-[11px] font-mono text-[#636366] tabular-nums mt-1 flex items-center gap-1.5 truncate">
            {album.releaseYear && <span>{album.releaseYear}</span>}
            {album.releaseYear && album.formats.length > 0 && <span className="text-white/20">·</span>}
            {album.formats.length > 0 && (
              <span className={album.formats[0].includes('DSD') || album.formats[0] === 'DSF' || album.formats[0] === 'DFF' ? 'text-[#818CF8]' : ''}>
                {album.formats[0]}
              </span>
            )}
            {album.sampleRates.length > 0 && album.sampleRates[0] !== '0.0kHz' && (
              <>
                <span className="text-white/20">·</span>
                <span>{album.sampleRates[0]}</span>
              </>
            )}
            {album.avgDr > 0 && (
              <>
                <span className="text-white/20">·</span>
                <span className={album.avgDr >= 12 ? 'text-[#D4AF37] font-semibold' : ''}>
                  DR{album.avgDr}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Render the Album Detail Drill-down View
  const renderAlbumDetail = (album: AlbumCardData) => {
    const variants = album.release?.variants || []
    const hasMultipleVariants = variants.length > 1

    const activeVariant = hasMultipleVariants
      ? variants.find((v) => v.id === activeVariantId) ||
        variants.find((v) => v.releaseId === activeVariantId) ||
        variants.find((v) => v.isCurrentMaster) ||
        variants[0]
      : null

    const activeReleaseId =
      activeVariant?.releaseId ||
      activeVariant?.id?.replace(/^var-/, '') ||
      album.release?.id

    const variantTracks =
      hasMultipleVariants && activeReleaseId
        ? album.tracks.filter((t) => t.releaseId === activeReleaseId)
        : album.tracks

    const effectiveTracks = variantTracks.length > 0 ? variantTracks : album.tracks

    const effectiveFormats = Array.from(new Set(effectiveTracks.map((t) => t.format))).filter(Boolean)
    const effectiveSampleRates = Array.from(new Set(effectiveTracks.map((t) => t.sampleRateStr))).filter(Boolean)
    const effectiveAvgDr =
      effectiveTracks.length > 0
        ? Math.round(effectiveTracks.reduce((acc, t) => acc + (t.drScore || 0), 0) / effectiveTracks.length)
        : album.avgDr

    const drClass = IntegrityScanner.getDrBadgeClass(effectiveAvgDr)
    const isPlayingThisAlbum =
      effectiveTracks.some((t) => t.id === currentTrack?.id) && isPlaying

    // Group tracks by disc number
    const discsMap = new Map<number, Track[]>()
    effectiveTracks.forEach((t) => {
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
                {(effectiveFormats.length > 0 ? effectiveFormats : album.formats).map((fmt) => (
                  <span
                    key={fmt}
                    className="px-2 py-0.5 rounded-md bg-white/[0.08] text-white font-mono font-semibold text-[11px] border border-white/[0.12]"
                  >
                    {fmt}
                  </span>
                ))}

                {(effectiveSampleRates.length > 0 ? effectiveSampleRates : album.sampleRates).map((sr) => (
                  <span
                    key={sr}
                    className="px-2 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 font-mono text-[11px] border border-cyan-500/30"
                  >
                    {sr}
                  </span>
                ))}

                {effectiveAvgDr > 0 && (
                  <span
                    className={`px-2 py-0.5 rounded-md font-mono font-bold text-[11px] border ${drClass.bg} ${drClass.text}`}
                    title={`Average Dynamic Range: DR${effectiveAvgDr}`}
                  >
                    DR{effectiveAvgDr}
                  </span>
                )}

                {album.variantsCount > 1 && (
                  <span className="px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 font-mono text-[11px] border border-purple-500/30 flex items-center gap-1">
                    <Layers className="w-3 h-3" />
                    <span>{album.variantsCount} Editions</span>
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
                  {effectiveTracks.length} Tracks &bull; {formatAlbumDuration(effectiveTracks)}
                </span>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="mt-5 flex items-center gap-3 flex-wrap">
              <button
                onClick={() => handlePlayAlbum(album, effectiveTracks)}
                className="px-5 py-2.5 rounded-xl bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black font-bold text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{isPlayingThisAlbum ? 'Resume Album' : 'Play Album'}</span>
              </button>

              <button
                onClick={() => handleShuffleAlbum(album, effectiveTracks)}
                className="px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              >
                <Shuffle className="w-4 h-4 text-cyan-400" />
                <span>Shuffle</span>
              </button>

              <button
                onClick={() => {
                  addToQueue(effectiveTracks)
                  window.dispatchEvent(
                    new CustomEvent('cadence:toast', { detail: `Added ${effectiveTracks.length} tracks to queue` })
                  )
                }}
                className="px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                title="Add album tracks to queue"
              >
                <ListPlus className="w-4 h-4 text-emerald-400" />
                <span>Queue</span>
              </button>

              <button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent('cadence:add-tracks-playlist', { detail: effectiveTracks })
                  )
                }}
                className="px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                title="Add album tracks to a playlist"
              >
                <BookmarkPlus className="w-4 h-4 text-amber-400" />
                <span>Playlist</span>
              </button>

              <button
                onClick={(e) => handleEditAlbum(album, e, activeReleaseId)}
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

        {/* Edition / Pressing Switcher (When Multiple Pressings / Editions Exist) */}
        {hasMultipleVariants && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 px-5 rounded-2xl bg-[#12151D]/90 border border-white/[0.08] shadow-lg backdrop-blur-md">
            <div className="flex items-center gap-2 text-xs font-mono text-slate-400 shrink-0">
              <Layers className="w-4 h-4 text-purple-400" />
              <span className="font-semibold text-white">Editions & Pressings</span>
              <span className="text-white/20">&bull;</span>
              <span>{variants.length} available</span>
            </div>

            <div className="flex items-center gap-2 overflow-x-auto py-0.5 no-scrollbar flex-wrap sm:flex-nowrap">
              {variants.map((v) => {
                const isSelected =
                  (activeVariant?.id === v.id) ||
                  (activeVariant?.releaseId && activeVariant.releaseId === v.releaseId)
                const vDrClass = IntegrityScanner.getDrBadgeClass(v.drScore)
                return (
                  <button
                    key={v.id}
                    onClick={() => setActiveVariantId(v.id)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                      isSelected
                        ? 'bg-purple-500/25 border border-purple-500/60 text-white shadow-lg shadow-purple-500/10 font-bold'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-400 hover:text-white'
                    }`}
                    title={v.notes || v.variantName}
                  >
                    <span>{v.variantName}</span>
                    {v.drScore > 0 && (
                      <span className={`px-1.5 py-0.2 rounded font-mono font-bold text-[9px] border ${vDrClass.bg} ${vDrClass.text}`}>
                        DR{v.drScore}
                      </span>
                    )}
                    {v.isCurrentMaster && (
                      <span className="px-1.5 py-0.2 rounded font-mono text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        Master
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

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
                      onDoubleClick={() => playTrack(track, effectiveTracks)}
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
                            playTrack(track, effectiveTracks)
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

                      {/* Duration & Hover Quick Actions */}
                      <div className="col-span-1 flex items-center justify-end gap-1.5 text-right relative">
                        <span className="text-xs font-mono text-[#64748B] group-hover/tr:hidden">
                          {formatDuration(track.durationSeconds || track.duration)}
                        </span>

                        <div className="hidden group-hover/tr:flex items-center gap-1 animate-fadeIn">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              playNext(track)
                              window.dispatchEvent(
                                new CustomEvent('cadence:toast', { detail: `Queued "${track.title}" to play next` })
                              )
                            }}
                            title="Play Next"
                            className="p-1 rounded text-neutral-400 hover:text-emerald-400 hover:bg-white/10 transition-colors"
                          >
                            <ArrowUpToLine className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              addToQueue(track)
                              window.dispatchEvent(
                                new CustomEvent('cadence:toast', { detail: `Added "${track.title}" to queue` })
                              )
                            }}
                            title="Add to Queue"
                            className="p-1 rounded text-neutral-400 hover:text-emerald-400 hover:bg-white/10 transition-colors"
                          >
                            <ListPlus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              window.dispatchEvent(
                                new CustomEvent('cadence:add-tracks-playlist', { detail: [track] })
                              )
                            }}
                            title="Add to Playlist..."
                            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            <BookmarkPlus className="w-3.5 h-3.5" />
                          </button>
                        </div>
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
            className="px-5 py-2.5 rounded-xl bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-xs flex items-center gap-2 shadow-lg transition-all cursor-pointer shrink-0"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Play All</span>
          </button>
        </div>

        {/* Artist Albums Grid */}
        <div>
          <h2 className="text-xs uppercase font-mono tracking-wider text-[#8E8E93] font-bold mb-3 px-1">
            Albums & Releases
          </h2>
          <div className="grid gap-5" style={gridStyle}>
            {albums.map((album) => renderAlbumCard(album))}
          </div>
        </div>
      </div>
    )
  }

  // Render Composer Detail View
  const renderComposerDetail = (composerName: string, albums: AlbumCardData[]) => {
    const norm = composerName.toLowerCase().trim()
    const composerTracks = albums.flatMap((a) => {
      const specific = a.tracks.filter(
        (t) => (t.composerName || (t as any).composer || '').toLowerCase().trim() === norm
      )
      return specific.length > 0 ? specific : a.tracks
    })
    const heroPortrait =
      composerPortraits.get(norm) ||
      albums[0]?.coverArtUrl ||
      generateMonogramAvatar(composerName)

    return (
      <div className="flex flex-col gap-6 max-w-6xl mx-auto w-full">
        {/* Composer Hero */}
        <div className="flex items-center justify-between gap-6 p-6 rounded-2xl bg-gradient-to-r from-[#2A1826] via-[#16121B] to-[#0D0E12] border border-white/[0.08] shadow-xl">
          <div className="flex items-center gap-5">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-black/60 border-2 border-[#818CF8]/60 shadow-lg shrink-0 flex items-center justify-center text-3xl">
              {heroPortrait ? (
                <img
                  src={heroPortrait}
                  alt={composerName}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).src = generateMonogramAvatar(composerName)
                  }}
                />
              ) : (
                '🎼'
              )}
            </div>
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-[#818CF8] font-semibold">
                Composer Catalog & Works
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-0.5">
                {composerName}
              </h1>
              <div className="text-xs text-[#8E8E93] font-mono mt-1">
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
            className="px-5 py-2.5 rounded-xl bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-xs flex items-center gap-2 shadow-lg transition-all cursor-pointer shrink-0"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Play Works</span>
          </button>
        </div>

        {/* Composer Albums Grid */}
        <div>
          <h2 className="text-xs uppercase font-mono tracking-wider text-[#8E8E93] font-bold mb-3 px-1">
            Compositions & Albums
          </h2>
          <div className="grid gap-5" style={gridStyle}>
            {albums.map((album) => renderAlbumCard(album))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full bg-[#0D0E12] select-none overflow-hidden">
      {/* 1. Sub-Header Toolbar: only render if drill-down is active OR hideSubHeader is false */}
      {hideSubHeader ? (
        (selectedAlbum || selectedArtist || selectedComposer) && (
          <div className="px-6 py-2.5 bg-[#121316]/70 border-b border-white/[0.05] flex items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3">
              {/* Context-aware Back Button */}
              {selectedAlbum ? (
                <button
                  onClick={() => setSelectedAlbumId(null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#D4AF37]/50"
                >
                  <ArrowLeft className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>
                    {selectedArtist
                      ? `Back to ${selectedArtist}`
                      : selectedComposer
                      ? `Back to ${selectedComposer}`
                      : 'Back to Albums'}
                  </span>
                </button>
              ) : selectedArtist ? (
                <button
                  onClick={() => setSelectedArtist(null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#D4AF37]/50"
                >
                  <ArrowLeft className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>All Artists</span>
                </button>
              ) : selectedComposer ? (
                <button
                  onClick={() => setSelectedComposer(null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#818CF8]/50"
                >
                  <ArrowLeft className="w-3.5 h-3.5 text-[#818CF8]" />
                  <span>All Composers</span>
                </button>
              ) : null}

              <span className="text-white/20">&bull;</span>

              {/* Precise 3-Level Breadcrumbs */}
              <div className="flex items-center gap-1.5 text-xs font-mono text-[#8E8E93]">
                {activeTab === 'composers' || selectedComposer ? (
                  <>
                    <span
                      onClick={() => {
                        setSelectedAlbumId(null)
                        setSelectedArtist(null)
                        setSelectedComposer(null)
                        setActiveTab('composers')
                      }}
                      className="hover:text-white cursor-pointer"
                    >
                      Composers
                    </span>
                    {selectedComposer && (
                      <>
                        <ChevronRight className="w-3 h-3 text-white/30" />
                        <span
                          onClick={() => setSelectedAlbumId(null)}
                          className={`cursor-pointer ${
                            selectedAlbum ? 'text-[#818CF8] hover:text-white' : 'text-[#818CF8] font-semibold'
                          }`}
                        >
                          {selectedComposer}
                        </span>
                      </>
                    )}
                  </>
                ) : activeTab === 'artists' || selectedArtist ? (
                  <>
                    <span
                      onClick={() => {
                        setSelectedAlbumId(null)
                        setSelectedArtist(null)
                        setSelectedComposer(null)
                        setActiveTab('artists')
                      }}
                      className="hover:text-white cursor-pointer"
                    >
                      Artists
                    </span>
                    {selectedArtist && (
                      <>
                        <ChevronRight className="w-3 h-3 text-white/30" />
                        <span
                          onClick={() => setSelectedAlbumId(null)}
                          className={`cursor-pointer ${
                            selectedAlbum ? 'text-[#D4AF37] hover:text-white' : 'text-[#D4AF37] font-semibold'
                          }`}
                        >
                          {selectedArtist}
                        </span>
                      </>
                    )}
                  </>
                ) : (
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
                )}

                {selectedAlbum && (
                  <>
                    <ChevronRight className="w-3 h-3 text-white/30" />
                    <span className="text-white font-semibold truncate max-w-[200px] sm:max-w-xs">
                      {selectedAlbum.title}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="px-6 py-2.5 bg-[#12151D] border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0 flex-wrap">
          {/* Left: Breadcrumbs or Entity tabs */}
          {selectedAlbum ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSelectedAlbumId(null)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#D4AF37]/50"
              >
                <ArrowLeft className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>
                  {selectedArtist
                    ? `Back to ${selectedArtist}`
                    : selectedComposer
                    ? `Back to ${selectedComposer}`
                    : 'Back to Albums'}
                </span>
              </button>
              <span className="text-white/20">&bull;</span>
              <div className="flex items-center gap-1.5 text-xs font-mono text-[#8E8E93]">
                {selectedComposer || activeTab === 'composers' ? (
                  <>
                    <span
                      onClick={() => {
                        setSelectedAlbumId(null)
                        setSelectedArtist(null)
                        setSelectedComposer(null)
                        setActiveTab('composers')
                      }}
                      className="hover:text-white cursor-pointer"
                    >
                      Composers
                    </span>
                    {selectedComposer && (
                      <>
                        <ChevronRight className="w-3 h-3 text-white/30" />
                        <span
                          onClick={() => setSelectedAlbumId(null)}
                          className="hover:text-white cursor-pointer text-[#818CF8]"
                        >
                          {selectedComposer}
                        </span>
                      </>
                    )}
                  </>
                ) : selectedArtist || activeTab === 'artists' ? (
                  <>
                    <span
                      onClick={() => {
                        setSelectedAlbumId(null)
                        setSelectedArtist(null)
                        setSelectedComposer(null)
                        setActiveTab('artists')
                      }}
                      className="hover:text-white cursor-pointer"
                    >
                      Artists
                    </span>
                    {selectedArtist && (
                      <>
                        <ChevronRight className="w-3 h-3 text-white/30" />
                        <span
                          onClick={() => setSelectedAlbumId(null)}
                          className="hover:text-white cursor-pointer text-[#D4AF37]"
                        >
                          {selectedArtist}
                        </span>
                      </>
                    )}
                  </>
                ) : (
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#D4AF37]/50"
              >
                <ArrowLeft className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>All Artists</span>
              </button>
              <span className="text-white/20">&bull;</span>
              <div className="flex items-center gap-1.5 text-xs font-mono text-[#8E8E93]">
                <span
                  onClick={() => setSelectedArtist(null)}
                  className="hover:text-white cursor-pointer"
                >
                  Artists
                </span>
                <ChevronRight className="w-3 h-3 text-white/30" />
                <span className="text-[#D4AF37] font-semibold">{selectedArtist}</span>
              </div>
            </div>
          ) : selectedComposer ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSelectedComposer(null)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-all cursor-pointer shadow-sm hover:border-[#818CF8]/50"
              >
                <ArrowLeft className="w-3.5 h-3.5 text-[#818CF8]" />
                <span>All Composers</span>
              </button>
              <span className="text-white/20">&bull;</span>
              <div className="flex items-center gap-1.5 text-xs font-mono text-[#8E8E93]">
                <span
                  onClick={() => setSelectedComposer(null)}
                  className="hover:text-white cursor-pointer"
                >
                  Composers
                </span>
                <ChevronRight className="w-3 h-3 text-white/30" />
                <span className="text-[#818CF8] font-semibold">{selectedComposer}</span>
              </div>
            </div>
          ) : (
            /* Subtle Translucent Switcher */
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
                      ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                      : 'text-[#8E8E93] hover:text-white'
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
                      ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                      : 'text-[#8E8E93] hover:text-white'
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
                      ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                      : 'text-[#8E8E93] hover:text-white'
                  }`}
                >
                  Composers ({composerGroups.length})
                </button>
              </div>

              <span className="text-white/20">&bull;</span>
              <span className="text-xs font-mono text-[#8E8E93]">
                {tracks.length} Tracks in Library
              </span>
            </div>
          )}

          {/* Right: Sort and Card Size Selector */}
          {!selectedAlbum && (
            <div className="flex items-center gap-3">
              {/* Sort By Dropdown */}
              <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
                <span className="text-[11px] font-mono">Sort:</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortBy)}
                  className="bg-black/40 border border-white/[0.1] rounded-lg px-2.5 py-1 text-xs text-[#CBD5E1] focus:border-[#D4AF37] focus:outline-none cursor-pointer"
                >
                  <option value="year_desc">Year (Newest First)</option>
                  <option value="year_asc">Year (Oldest First)</option>
                  <option value="artist_asc">Artist (A-Z)</option>
                  <option value="title_asc">Album Title (A-Z)</option>
                  <option value="dr_desc">Dynamic Range (Avg DR)</option>
                </select>
              </div>

              {/* Card Size Selector */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[11px] font-mono text-[#8E8E93]">
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
      )}

      {/* 2. Main Scrollable Container with Symmetric px-6 Padding */}
      <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto px-6 py-5 pb-36 w-full">
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
                  <div className="grid gap-5" style={gridStyle}>
                    {albumCards.map((album) => renderAlbumCard(album))}
                  </div>
                )}
              </>
            )}

            {/* Artists Tab: Apple HIG Relational Entity System */}
            {activeTab === 'artists' && (
              <div className="-mx-6 -my-5 min-h-[calc(100vh-280px)] flex flex-col">
                <ArtistsView
                  releases={releases}
                  tracks={tracks}
                  onSelectTrack={onSelectTrack}
                  selectedTrackId={selectedTrackId}
                  playbackState={{
                    isPlaying,
                    isPaused: false,
                    currentFile: currentTrack?.filePath || null,
                    positionSecs: 0,
                    durationSecs: currentTrack?.durationSeconds || 0,
                    volume: 1,
                  }}
                  onPlayAlbum={(releaseId) => {
                    const rel = releases.find((r) => r.id === releaseId)
                    if (rel) onInspectRelease(rel.id)
                  }}
                  onNavigateToRelease={(releaseId) => {
                    onInspectRelease(releaseId)
                  }}
                  cardSize={cardSize}
                  onCardSizeChange={setCardSize}
                />
              </div>
            )}

            {/* Composers Tab */}
            {activeTab === 'composers' && (
              <div className="grid gap-5" style={gridStyle}>
                {composerGroups.map((group) => {
                  const compAvatarSize =
                    cardSize === 'compact'
                      ? 'w-20 h-20'
                      : cardSize === 'large'
                      ? 'w-36 h-36'
                      : 'w-24 h-24'
                  const compPortrait =
                    composerPortraits.get(group.composer.toLowerCase().trim()) ||
                    group.albums[0]?.coverArtUrl ||
                    generateMonogramAvatar(group.composer)

                  return (
                    <div
                      key={group.composer}
                      onClick={() => {
                        setSelectedComposer(group.composer)
                        if (group.albums[0]?.tracks[0]) {
                          onSelectTrack(group.albums[0].tracks[0].id)
                        }
                      }}
                      className="flex flex-col items-center text-center p-4 rounded-2xl bg-[#12151D]/60 hover:bg-[#161B26] border border-white/[0.08] hover:border-[#818CF8]/50 transition-all cursor-pointer group/comp shadow-lg"
                    >
                      <div
                        className={`${compAvatarSize} rounded-full overflow-hidden bg-black/60 border-2 border-white/10 group-hover/comp:border-[#818CF8] mb-3 shadow-md flex items-center justify-center transition-all duration-300`}
                      >
                        {compPortrait ? (
                          <img
                            src={compPortrait}
                            alt={group.composer}
                            className="w-full h-full object-cover group-hover/comp:scale-105 transition-transform"
                            onError={(e) => {
                              ;(e.target as HTMLImageElement).src = generateMonogramAvatar(group.composer)
                            }}
                          />
                        ) : (
                          <div className="text-3xl">🎼</div>
                        )}
                      </div>
                      <span className="font-bold text-sm text-[#F1F5F9] group-hover/comp:text-[#818CF8] truncate max-w-full">
                        {group.composer}
                      </span>
                      <span className="text-xs font-mono text-[#8E8E93] mt-1">
                        {group.albums.length} Release{group.albums.length > 1 ? 's' : ''} &bull; {group.tracksCount} Tracks
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
