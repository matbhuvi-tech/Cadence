import React, { useState, useMemo } from 'react'
import {
  Disc3,
  SlidersHorizontal,
  Sparkles,
  Folder,
  ChevronDown,
  ChevronRight,
  Edit3,
  Calendar,
  Play,
  Volume2,
  ArrowUpToLine,
  ListPlus,
  BookmarkPlus,
  Film,
  MoreHorizontal,
} from 'lucide-react'
import { Track, Release, AlbumDisplayMode } from '../../core/types'
import { IntegrityScanner } from '../../services/integrityScanner'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'
import { getCuratedAlbumArtwork } from '../../core/taxonomyUtils'
import { backdropAnalyzer } from '../../services/backdropAnalyzer'
import { FEATURES } from '../../config/features'

interface VirtualDataTableProps {
  tracks: Track[]
  releases?: Release[]
  albumDisplayMode?: AlbumDisplayMode
  selectedTrackId?: string
  onSelectTrack: (trackId: string) => void
  selectedTrackIds: Set<string>
  onToggleTrackSelection: (trackId: string, isMulti: boolean) => void
  onSelectAll: (selectAll: boolean) => void
  onOpenMultiEdit: () => void
  onOpenBatchDiff?: () => void
  onOpenBatchAi?: () => void
  onOpenSidecar: (trackId: string) => void
  onCustomizeRelease?: (release: Release) => void
  onInspectRelease?: (releaseId: string) => void
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
    }
  ) => void
}

type SortField = 'trackNumber' | 'title' | 'artistCredit' | 'drScore' | 'sampleRate' | 'sidecarStatus'
type SortOrder = 'asc' | 'desc'

interface ReleaseGroup {
  id: string
  release?: Release
  title: string
  folderName: string
  composerName: string
  artistCredit: string
  releaseYear?: number
  coverArtUrl?: string
  backdropUrl?: string
  formats: string[]
  sampleRates: string[]
  avgDr: number
  tracks: Track[]
  stagedCount: number
}

export const VirtualDataTable: React.FC<VirtualDataTableProps> = ({
  tracks,
  releases = [],
  albumDisplayMode = 'album_first',
  selectedTrackId,
  onSelectTrack,
  onOpenSidecar,
  onCustomizeRelease,
  onInspectRelease,
  onUpdateReleaseDetails,
}) => {
  const [sortField] = useState<SortField>('trackNumber')
  const [sortOrder] = useState<SortOrder>('asc')

  const { currentTrack, isPlaying, playTrack, playNext, addToQueue } = useAudioPlayer()

  const sortedTracks = useMemo(() => {
    const list = [...tracks]
    list.sort((a, b) => {
      let valA: any = a[sortField as keyof Track]
      let valB: any = b[sortField as keyof Track]
      if (sortField === 'sampleRate') {
        valA = a.sampleRateStr
        valB = b.sampleRateStr
      }
      if (valA === undefined) valA = ''
      if (valB === undefined) valB = ''

      if (typeof valA === 'string') {
        return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA)
      }
      return sortOrder === 'asc' ? valA - valB : valB - valA
    })
    return list
  }, [tracks, sortField, sortOrder])

  // Hierarchical Release & Folder Groups
  const releaseGroups = useMemo<ReleaseGroup[]>(() => {
    const groupMap = new Map<string, Track[]>()

    sortedTracks.forEach((track) => {
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

    const groups: ReleaseGroup[] = []

    groupMap.forEach((groupTracks, key) => {
      // 1. Exact match by master release ID (current master variant preferred) or release ID
      let rel = releases?.find((r) => r.masterReleaseId === key && r.variants?.some((v) => v.isCurrentMaster))
      if (!rel) {
        rel = releases?.find((r) => r.masterReleaseId === key)
      }
      if (!rel) {
        rel = releases?.find((r) => r.id === key)
      }
      // 2. Exact match by folder path
      if (!rel) {
        rel = releases?.find((r) => r.folderPath && groupTracks.some((t) => t.folderPath && t.folderPath === r.folderPath))
      }
      // 3. Match by pending edited album title
      if (!rel) {
        rel = releases?.find((r) => r.title && groupTracks.some((t) => t.pendingSidecarEdits?.album === r.title))
      }
      // 4. Scoped fallback: folderName ONLY if artist or album title also matches
      if (!rel) {
        rel = releases?.find(
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

      groups.push({
        id: key,
        release: rel,
        title,
        folderName,
        composerName,
        artistCredit,
        releaseYear,
        coverArtUrl,
        backdropUrl: rel?.artwork?.backdropUrl || rel?.backdropUrl,
        formats,
        sampleRates,
        avgDr,
        tracks: groupTracks,
        stagedCount,
      })
    })

    return groups
  }, [sortedTracks, releases])

  // Track collapsed groups (all folders expanded by default across any number of albums)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  const expandAll = () => {
    setCollapsedGroups(new Set())
  }

  const collapseAll = () => {
    setCollapsedGroups(new Set(releaseGroups.map((g) => g.id)))
  }

  const handleEditAlbum = (group: ReleaseGroup) => {
    const relToEdit: Release = group.release || {
      id: group.id,
      masterReleaseId: group.id,
      title: group.title,
      folderName: group.folderName,
      artistCredit: group.artistCredit,
      composerName: group.composerName,
      originalYear: group.releaseYear || new Date().getFullYear(),
      releaseYear: group.releaseYear || new Date().getFullYear(),
      label: 'Self-Released',
      catalogNumber: '',
      mediaFormat: group.formats[0] || 'Digital Audio',
      country: '',
      matrixRunout: '',
      artwork: {
        frontCoverUrl: group.coverArtUrl || '',
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
      tracksCount: group.tracks.length,
      genreTags: [],
      storageMountId: group.tracks[0]?.storageMountId || '',
    }

    if (onCustomizeRelease) {
      onCustomizeRelease(relToEdit)
    }
  }

  const formatDuration = (secs?: number) => {
    if (!secs || isNaN(secs)) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full bg-[#0D0E12] select-none overflow-hidden">
      {/* Compact Hierarchy Control Bar */}
      <div className="py-2 px-5 bg-[#12151D] border-b border-white/[0.06] flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={expandAll}
            className="px-2.5 py-1 rounded-lg text-[11px] font-mono text-[#94A3B8] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="Expand all album folders"
          >
            Expand All
          </button>
          <span className="text-white/20">&bull;</span>
          <button
            onClick={collapseAll}
            className="px-2.5 py-1 rounded-lg text-[11px] font-mono text-[#94A3B8] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="Collapse all album folders"
          >
            Collapse All
          </button>
        </div>

        <span className="text-[11px] font-mono text-[#64748B]">
          {releaseGroups.length} Albums &bull; {sortedTracks.length} Tracks
        </span>
      </div>

      {/* Hierarchical Folder & Tracks View with Smooth Full Vertical Scrolling */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col p-4 gap-4 pb-28">
        {releaseGroups.map((group) => {
          const isExpanded = !collapsedGroups.has(group.id)

          return (
            <div
              key={group.id}
              className="flex flex-col relative shrink-0 overflow-hidden group/album rounded-2xl border border-white/[0.08] bg-[#12151D]/80 shadow-xl transition-all duration-300"
            >
              {/* Dedicated Full-Card Cinematic Album-Art Backdrop */}
              <PanoramicAtmosphericBackdrop
                coverArtUrl={group.coverArtUrl}
                backdropUrl={group.backdropUrl}
                overlayVariant="banner"
              />

              {/* Album Content Layer: Header + Track List */}
              <div className="relative z-10 flex flex-col w-full">
                {/* 1. EMBEDDED PANORAMIC COVER ART HERO BANNER HEADER */}
                <div className="relative min-h-[104px] px-5 py-4 flex items-center justify-between gap-4 border-b border-white/[0.08] select-none">
                  {/* Left: Collapse, Sharp Front Artwork Thumbnail & Album Metadata */}
                  <div className="flex items-center gap-3.5 min-w-0 flex-1 z-10">
                    {/* Expand / Collapse Toggle Button */}
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className="p-1.5 rounded-lg text-[#94A3B8] hover:text-white hover:bg-white/[0.1] bg-black/40 backdrop-blur-sm border border-white/[0.1] transition-colors cursor-pointer shrink-0"
                      title={isExpanded ? 'Collapse Album' : 'Expand Album'}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-[#00F5FF]" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-[#64748B]" />
                      )}
                    </button>

                    {/* Album Artwork Thumbnail with Large Hover Zoom Popover */}
                    <ArtworkHoverPreview
                      src={group.coverArtUrl}
                      alt={group.title}
                      title={group.title}
                      subtitle={group.artistCredit}
                      composer={group.composerName}
                      resolution={group.release?.artwork?.resolution || (group.formats.length > 0 ? group.formats.join(', ') : undefined)}
                      audioSpec={group.sampleRates.length > 0 ? group.sampleRates[0] : undefined}
                      drScore={group.avgDr}
                      provider="local"
                      providerLabel="Album Art"
                      previewSize={300}
                    >
                      <div
                        onClick={() => handleEditAlbum(group)}
                        className="w-14 h-14 md:w-16 md:h-16 rounded-xl overflow-hidden border border-white/[0.2] bg-black/70 shrink-0 cursor-pointer relative group/thumb hover:border-[#00F5FF] transition-all shadow-2xl ring-1 ring-white/10"
                        title="Click to inspect/curate album (Hover for large preview)"
                      >
                        {group.coverArtUrl ? (
                          <img
                            src={group.coverArtUrl}
                            alt={group.title}
                            className="w-full h-full object-cover group-hover/thumb:scale-105 transition-transform"
                            onError={(e) => {
                              ;(e.target as HTMLElement).style.display = 'none'
                            }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[#64748B]">
                            <Disc3 className="w-6 h-6 text-[#38BDF8]" />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity">
                          <Edit3 className="w-4 h-4 text-[#00F5FF]" />
                        </div>
                      </div>
                    </ArtworkHoverPreview>

                    {/* Album Title, Folder Name Badge & Audiophile Tags */}
                    <div className="flex flex-col min-w-0 text-left gap-1">
                      <div className="flex items-center gap-2 truncate">
                        <span
                          onClick={() => {
                            if (group.tracks.length > 0) onSelectTrack(group.tracks[0].id)
                          }}
                          className="font-bold text-base md:text-lg text-white truncate hover:text-[#00F5FF] cursor-pointer drop-shadow-md tracking-tight"
                          title={`Album: ${group.title}`}
                        >
                          {albumDisplayMode === 'folder_first' ? (group.folderName || group.title) : group.title}
                        </span>

                        {group.folderName && (
                          <span
                            className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/30 flex items-center gap-1 shrink-0 max-w-[220px] truncate backdrop-blur-sm"
                            title={`Physical Folder: ${group.folderName}`}
                          >
                            <Folder className="w-3 h-3 shrink-0" />
                            <span className="truncate">{group.folderName}</span>
                          </span>
                        )}

                        {group.stagedCount > 0 && (
                          <span
                            className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30 flex items-center gap-1 font-semibold shrink-0 backdrop-blur-sm"
                            title={`${group.stagedCount} tracks have uncommitted sidecar edits`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] animate-pulse" />
                            <span>{group.stagedCount} Staged</span>
                          </span>
                        )}
                      </div>

                      {/* Secondary line: Composer, Artist, Year, Formats, Avg DR */}
                      <div className="flex items-center gap-2 text-xs text-[#94A3B8] flex-wrap">
                        {group.composerName && (
                          <>
                            <span className="flex items-center gap-1 text-[#EC4899] font-mono text-[11px] font-semibold">
                              <span>🎼</span>
                              <span>{group.composerName}</span>
                            </span>
                            <span className="text-white/20">&bull;</span>
                          </>
                        )}

                        <span className="text-[#CBD5E1] truncate font-medium">{group.artistCredit}</span>

                        {group.releaseYear && (
                          <>
                            <span className="text-white/20">&bull;</span>
                            <span className="font-mono text-[#F59E0B] flex items-center gap-1 font-semibold">
                              <Calendar className="w-3 h-3" />
                              <span>{group.releaseYear}</span>
                            </span>
                          </>
                        )}

                        <span className="text-white/20">&bull;</span>
                        <span className="font-mono text-[#94A3B8]">{group.tracks.length} tracks</span>

                        {group.formats.length > 0 && (
                          <>
                            <span className="text-white/20">&bull;</span>
                            <span className="font-mono text-[#CBD5E1] uppercase font-semibold">{group.formats.join(', ')}</span>
                          </>
                        )}

                        {FEATURES.DYNAMIC_RANGE && group.avgDr > 0 && (
                          <>
                            <span className="text-white/20">&bull;</span>
                            <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-white/[0.08] text-[#CBD5E1] border border-white/[0.1]">
                              Avg DR{group.avgDr}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Album-Level Actions matching Album Detail */}
                  <div className="flex items-center gap-2.5 shrink-0 z-10">
                    <button
                      onClick={() => {
                        if (group.tracks.length > 0) {
                          playTrack(group.tracks[0], group.tracks)
                        }
                      }}
                      className="px-4 py-2 rounded-xl bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                      title="Play all tracks in this album"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Play Album</span>
                    </button>

                    <button
                      onClick={() => {
                        addToQueue(group.tracks)
                        window.dispatchEvent(
                          new CustomEvent('cadence:toast', { detail: `Added ${group.tracks.length} tracks to queue` })
                        )
                      }}
                      className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-1.5 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                      title="Add album tracks to queue"
                    >
                      <ListPlus className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="hidden sm:inline">Queue</span>
                    </button>

                    <button
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent('cadence:add-tracks-playlist', { detail: group.tracks })
                        )
                      }}
                      className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-white font-semibold text-xs flex items-center gap-1.5 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                      title="Add album tracks to a playlist"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5 text-amber-400" />
                      <span className="hidden sm:inline">Playlist</span>
                    </button>

                    {/* Secondary Overflow Actions */}
                    <div className="relative group/menu">
                      <button
                        className="p-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-white/80 hover:text-white border border-white/[0.12] transition-all text-xs flex items-center justify-center cursor-pointer"
                        title="More album actions"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      <div className="absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-[#12151D] border border-white/10 shadow-2xl p-1.5 hidden group-hover/menu:flex flex-col gap-1 z-30">
                        <button
                          onClick={() => handleEditAlbum(group)}
                          className="w-full px-2.5 py-1.5 rounded-lg hover:bg-white/10 text-white text-xs flex items-center gap-2 text-left cursor-pointer"
                        >
                          <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
                          <span>Edit Metadata in Curate</span>
                        </button>
                        {backdropAnalyzer.isBackdropUnformatted(group.release).isUnformatted && (
                          <button
                            onClick={async () => {
                              if (group.release) {
                                const res = await backdropAnalyzer.formatBackdropForRelease(group.release.id)
                                if (res.success && res.backdropUrl) {
                                  onUpdateReleaseDetails?.(group.release.id, { backdropUrl: res.backdropUrl })
                                  window.dispatchEvent(
                                    new CustomEvent('cadence:toast', {
                                      detail: `Generated 2400×320 panoramic backdrop for "${group.title}"`,
                                    })
                                  )
                                } else {
                                  window.dispatchEvent(
                                    new CustomEvent('cadence:toast', { detail: res.message })
                                  )
                                }
                              }
                            }}
                            className="w-full px-2.5 py-1.5 rounded-lg hover:bg-white/10 text-amber-300 text-xs flex items-center gap-2 text-left cursor-pointer"
                          >
                            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                            <span>Format Backdrop</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. TRACKLIST TABLE (Matching Album Detail View) */}
                {isExpanded && (
                  <div>
                    {/* Table Header */}
                    <div className="grid grid-cols-12 gap-3 px-5 py-2.5 text-[11px] font-mono text-[#64748B] border-b border-white/[0.04] uppercase tracking-wider">
                      <div className="col-span-1 text-center">#</div>
                      <div className={FEATURES.DYNAMIC_RANGE ? 'col-span-6 sm:col-span-7' : 'col-span-7 sm:col-span-8'}>Title</div>
                      <div className="col-span-3 sm:col-span-2 text-right">Format / Spec</div>
                      {FEATURES.DYNAMIC_RANGE && <div className="col-span-1 text-center">DR</div>}
                      <div className="col-span-1 text-right">Time</div>
                    </div>

                    {/* Track Rows */}
                    <div className="divide-y divide-white/[0.03]">
                      {group.tracks.map((track, idx) => {
                        const isCurrentPlaying = currentTrack?.id === track.id
                        const isSelected = selectedTrackId === track.id
                        const trackDrClass = IntegrityScanner.getDrBadgeClass(track.drScore)

                        return (
                          <div
                            key={track.id}
                            onClick={() => onSelectTrack(track.id)}
                            onDoubleClick={() => playTrack(track, group.tracks)}
                            className={`grid grid-cols-12 gap-3 px-5 py-2.5 items-center transition-colors cursor-pointer group/tr ${
                              isCurrentPlaying
                                ? 'bg-cyan-500/10 text-cyan-300'
                                : isSelected
                                ? 'bg-white/[0.05] text-white'
                                : 'hover:bg-white/[0.03] text-[#CBD5E1]'
                            } ${track.isOnline === false ? 'opacity-40 hover:opacity-75' : ''}`}
                          >
                            {/* Track Number / Play button */}
                            <div className="col-span-1 flex items-center justify-center">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  playTrack(track, group.tracks)
                                }}
                                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                                  isCurrentPlaying
                                    ? 'bg-[#00F5FF] text-black shadow-md shadow-cyan-500/30'
                                    : 'hover:bg-cyan-400 hover:text-black'
                                }`}
                                title="Play Track"
                              >
                                {isCurrentPlaying && isPlaying ? (
                                  <Volume2 className="w-3.5 h-3.5 text-black animate-pulse" />
                                ) : isCurrentPlaying ? (
                                  <Play className="w-3.5 h-3.5 fill-current ml-0.5 text-black" />
                                ) : (
                                  <>
                                    <span className="group-hover/tr:hidden text-xs font-mono text-[#64748B]">
                                      {track.trackNumber
                                        ? String(track.trackNumber).padStart(2, '0')
                                        : String(idx + 1).padStart(2, '0')}
                                    </span>
                                    <Play className="w-3.5 h-3.5 fill-current hidden group-hover/tr:block ml-0.5" />
                                  </>
                                )}
                              </button>
                            </div>

                            {/* Title & Classical movement / Artist */}
                            <div className={`${FEATURES.DYNAMIC_RANGE ? 'col-span-6 sm:col-span-7' : 'col-span-7 sm:col-span-8'} min-w-0 pr-2 text-left`}>
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
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onOpenSidecar(track.id)
                                    }}
                                    className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 cursor-pointer"
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
                              {track.artistCredit && track.artistCredit !== group.artistCredit && (
                                <div className="text-[10px] text-[#94A3B8] truncate mt-0.5">
                                  {track.artistCredit}
                                </div>
                              )}
                              {track.canonicalAlbumTitle && !track.isCanonicalAlbumTrack && (
                                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                  {track.canonicalReleaseId && onInspectRelease ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onInspectRelease(track.canonicalReleaseId!)
                                      }}
                                      className="group/orig flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/25 text-cyan-300 hover:text-cyan-200 transition-all text-[10px] font-mono cursor-pointer"
                                      title={`Click to jump to original soundtrack: ${track.canonicalAlbumTitle}`}
                                    >
                                      <Film className="w-2.5 h-2.5 text-cyan-400 group-hover/orig:scale-110 transition-transform" />
                                      <span className="text-cyan-400 font-semibold">From</span>
                                      <span className="font-semibold underline decoration-cyan-500/40 underline-offset-2 truncate max-w-[200px]">
                                        {track.canonicalAlbumTitle}
                                      </span>
                                      {track.canonicalReleaseYear && (
                                        <span className="text-cyan-400/60 font-normal">({track.canonicalReleaseYear})</span>
                                      )}
                                      <ChevronRight className="w-2.5 h-2.5 text-cyan-400/60 group-hover/orig:translate-x-0.5 transition-transform" />
                                    </button>
                                  ) : (
                                    <div
                                      className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-cyan-500/5 border border-cyan-500/15 text-cyan-300/80 text-[10px] font-mono select-none"
                                      title={`Original Soundtrack: ${track.canonicalAlbumTitle} (Not in local library)`}
                                    >
                                      <Film className="w-2.5 h-2.5 text-cyan-400/70" />
                                      <span className="text-cyan-400/80 font-semibold">From</span>
                                      <span className="font-medium truncate max-w-[200px]">
                                        {track.canonicalAlbumTitle}
                                      </span>
                                    </div>
                                  )}
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
                            {FEATURES.DYNAMIC_RANGE && (
                              <div className="col-span-1 text-center">
                                {track.drScore != null && track.drScore > 0 ? (
                                  <span
                                    className={`px-1 py-0.2 rounded font-mono font-bold text-[9px] border ${trackDrClass.bg} ${trackDrClass.text}`}
                                  >
                                    DR{track.drScore}
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-mono text-white/20">-</span>
                                )}
                              </div>
                            )}

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
                                  className="p-1 rounded text-neutral-400 hover:text-emerald-400 hover:bg-white/10 transition-colors cursor-pointer"
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
                                  className="p-1 rounded text-neutral-400 hover:text-emerald-400 hover:bg-white/10 transition-colors cursor-pointer"
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
                                  className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
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
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
