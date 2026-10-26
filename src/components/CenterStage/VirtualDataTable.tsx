import React, { useState, useMemo, useRef, useEffect } from 'react'
import {
  ArrowUpDown,
  ShieldCheck,
  AlertTriangle,
  Pin,
  Clock,
  Music,
  Disc3,
  SlidersHorizontal,
  FileCode,
  Sparkles,
  Folder,
  FolderOpen,
  FolderTree,
  ChevronDown,
  ChevronRight,
  Edit3,
  Calendar,
  Layers,
  Table,
  Image as ImageIcon,
  Check,
  User,
  Play,
  Pause,
  Volume2,
  ArrowUpToLine,
  ListPlus,
  BookmarkPlus,
} from 'lucide-react'
import { Track, Release, AlbumDisplayMode } from '../../core/types'
import { IntegrityScanner } from '../../services/integrityScanner'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'
import { getCuratedAlbumArtwork } from '../../core/taxonomyUtils'
import { backdropAnalyzer } from '../../services/backdropAnalyzer'

const IndeterminateCheckbox: React.FC<{
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  title?: string
  className?: string
  'data-tutorial-id'?: string
}> = ({ checked, indeterminate, onChange, title, className, 'data-tutorial-id': tutorialId }) => {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = Boolean(indeterminate)
    }
  }, [indeterminate])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      title={title}
      data-tutorial-id={tutorialId}
      className={className || 'accent-[#00F5FF] w-3.5 h-3.5 rounded cursor-pointer'}
    />
  )
}

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
type LayoutMode = 'hierarchy' | 'flat'

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
  allSelected: boolean
  someSelected: boolean
  stagedCount: number
}

export const VirtualDataTable: React.FC<VirtualDataTableProps> = ({
  tracks,
  releases = [],
  albumDisplayMode = 'album_first',
  selectedTrackId,
  onSelectTrack,
  selectedTrackIds,
  onToggleTrackSelection,
  onSelectAll,
  onOpenMultiEdit,
  onOpenBatchDiff,
  onOpenBatchAi,
  onOpenSidecar,
  onCustomizeRelease,
  onInspectRelease,
  onUpdateReleaseDetails,
}) => {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('hierarchy')
  const [sortField, setSortField] = useState<SortField>('trackNumber')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [pinnedColumns, setPinnedColumns] = useState<Set<string>>(new Set(['select', 'trackNumber']))

  const { currentTrack, isPlaying, playTrack, togglePlayPause, playNext, addToQueue } = useAudioPlayer()

  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Virtualization constants for flat view
  const ROW_HEIGHT = 44
  const VISIBLE_COUNT = 25
  const BUFFER_COUNT = 8

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
  }

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
      // 1. Exact match by release ID
      let rel = releases?.find((r) => r.id === key)
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
      const selectedCount = groupTracks.filter((t) => selectedTrackIds.has(t.id)).length
      const allSelected = groupTracks.length > 0 && selectedCount === groupTracks.length
      const someSelected = selectedCount > 0 && selectedCount < groupTracks.length

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
        allSelected,
        someSelected,
        stagedCount,
      })
    })

    return groups
  }, [sortedTracks, releases, selectedTrackIds])

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

  const handleToggleGroupSelection = (group: ReleaseGroup) => {
    const shouldSelect = !group.allSelected
    group.tracks.forEach((track) => {
      const isCurrentlySelected = selectedTrackIds.has(track.id)
      if (shouldSelect && !isCurrentlySelected) {
        onToggleTrackSelection(track.id, false)
      } else if (!shouldSelect && isCurrentlySelected) {
        onToggleTrackSelection(track.id, false)
      }
    })
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

  // Virtual windowing calculations for flat view
  const totalHeight = sortedTracks.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_COUNT)
  const endIndex = Math.min(
    sortedTracks.length,
    Math.floor((scrollTop + 800) / ROW_HEIGHT) + BUFFER_COUNT
  )
  const visibleTracks = sortedTracks.slice(startIndex, endIndex)
  const offsetY = startIndex * ROW_HEIGHT

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const allSelected = sortedTracks.length > 0 && selectedTrackIds.size === sortedTracks.length

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full bg-[#0D0E12] select-none overflow-hidden">
      {/* Table Top Action Bar */}
      <div className="p-2.5 px-4 bg-[#12151D] border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
        {/* Left: View Layout Toggle (Hierarchical Folder vs Flat Table) */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
            <button
              onClick={() => setLayoutMode('hierarchy')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                layoutMode === 'hierarchy'
                  ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
              title="Hierarchical Folder & Tracks view: Work at album level for title, folder, composer, and artwork"
            >
              <FolderTree className="w-3.5 h-3.5" />
              <span>Hierarchical Folders</span>
            </button>
            <button
              onClick={() => setLayoutMode('flat')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                layoutMode === 'flat'
                  ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
              title="Flat virtual table: View and sort all individual tracks"
            >
              <Table className="w-3.5 h-3.5" />
              <span>Flat Table</span>
            </button>
          </div>

          {layoutMode === 'hierarchy' && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={expandAll}
                className="px-2 py-1 rounded text-[11px] font-mono text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors cursor-pointer"
                title="Expand all album folders"
              >
                Expand All
              </button>
              <span className="text-white/20">&bull;</span>
              <button
                onClick={collapseAll}
                className="px-2 py-1 rounded text-[11px] font-mono text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors cursor-pointer"
                title="Collapse all album folders"
              >
                Collapse All
              </button>
              <span className="text-white/20">&bull;</span>
              <span className="text-[11px] font-mono text-[#64748B]">
                {releaseGroups.length} Folders &bull; {sortedTracks.length} Tracks
              </span>
            </div>
          )}
        </div>

        {/* Right: Selected tracks & Batch Operations */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs font-mono text-[#00F5FF]">
            <span className="font-bold">{selectedTrackIds.size}</span> tracks selected
          </div>

          {(onOpenBatchDiff || onOpenBatchAi) && (
            <button
              data-tutorial-id="btn-batch-ai-grid"
              onClick={onOpenBatchDiff || onOpenBatchAi}
              disabled={selectedTrackIds.size === 0}
              title="Batch Enrich selected tracks across Apple Music, MusicBrainz, and Gemini AI"
              className="px-3 py-1 rounded bg-gradient-to-r from-[#00F5FF] via-[#8B5CF6] to-[#EC4899] text-white font-semibold text-xs hover:brightness-110 transition-all flex items-center gap-1.5 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#ADFF2F]" />
              Batch Enrich ({Math.min(25, selectedTrackIds.size || 25)} Tracks)
            </button>
          )}

          <button
            data-tutorial-id="btn-spreadsheet-multi-edit"
            onClick={onOpenMultiEdit}
            disabled={selectedTrackIds.size === 0}
            className="px-3 py-1 rounded bg-[#00F5FF] text-black font-semibold text-xs hover:bg-[#00F5FF]/90 transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Spreadsheet Multi-Edit (Alt+E)
          </button>
        </div>
      </div>

      {/* Table Header with Pinned Columns and Multi-Sort (Flat Table Mode Only) */}
      {layoutMode === 'flat' && (
        <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-[#12151D] border-b border-white/[0.08] text-xs font-mono font-medium text-[#94A3B8] items-center shrink-0">
          <div className="col-span-1 flex items-center gap-2">
            <input
              data-tutorial-id="virtual-grid-select-all"
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onSelectAll(e.target.checked)}
              className="accent-[#00F5FF] w-3.5 h-3.5 rounded cursor-pointer"
            />
            <button
              onClick={() => handleSort('trackNumber')}
              className="flex items-center gap-1 hover:text-white cursor-pointer"
            >
              <span>#</span>
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="col-span-4 flex items-center">
            <button
              onClick={() => handleSort('title')}
              className="flex items-center gap-1 hover:text-white cursor-pointer"
            >
              <span>Track Title & Work Hierarchy</span>
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="col-span-2 flex items-center">
            <button
              onClick={() => handleSort('artistCredit')}
              className="flex items-center gap-1 hover:text-white cursor-pointer"
            >
              <span>Performer / Composer</span>
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="col-span-2 flex items-center">
            <button
              onClick={() => handleSort('drScore')}
              className="flex items-center gap-1 hover:text-white cursor-pointer"
            >
              <span>DR & Dynamic Range</span>
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="col-span-2 flex items-center">
            <button
              onClick={() => handleSort('sampleRate')}
              className="flex items-center gap-1 hover:text-white cursor-pointer"
            >
              <span>Sample Format</span>
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="col-span-1 flex items-center justify-end">
            <button
              onClick={() => handleSort('sidecarStatus')}
              className="flex items-center gap-1 hover:text-white cursor-pointer"
            >
              <span>Status</span>
              <ArrowUpDown className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {layoutMode === 'hierarchy' ? (
        /* Hierarchical Folder & Tracks View with Smooth Full Vertical Scrolling */
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col p-3 gap-4 pb-28">
          {releaseGroups.map((group) => {
            const isExpanded = !collapsedGroups.has(group.id)

            return (
              <div
                key={group.id}
                className="flex flex-col relative shrink-0 overflow-hidden group/album rounded-2xl border border-white/[0.12] bg-[#0A0D14] shadow-2xl shadow-black/80 transition-all duration-300"
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
                  <div className="relative min-h-[110px] md:min-h-[125px] px-5 py-4 flex items-center justify-between gap-4 border-b border-white/[0.1] select-none">
                    {/* Left: Collapse, Checkbox, Sharp Front Artwork Thumbnail & Album Metadata */}
                    <div className="flex items-center gap-3.5 min-w-0 flex-1 z-10">
                    {/* Expand / Collapse Toggle Button */}
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className="p-1.5 rounded-lg text-[#94A3B8] hover:text-white hover:bg-white/[0.1] bg-black/40 backdrop-blur-sm border border-white/[0.1] transition-colors cursor-pointer shrink-0"
                      title={isExpanded ? 'Collapse Folder' : 'Expand Folder'}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-[#00F5FF]" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-[#64748B]" />
                      )}
                    </button>

                    {/* Folder-Wide Selection Checkbox */}
                    <IndeterminateCheckbox
                      checked={group.allSelected}
                      indeterminate={group.someSelected}
                      onChange={() => handleToggleGroupSelection(group)}
                      title={group.allSelected ? 'Deselect entire folder' : 'Select all tracks in this folder'}
                    />

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
                        className="w-14 h-14 md:w-16 md:h-16 rounded-xl overflow-hidden border border-white/[0.25] bg-black/70 shrink-0 cursor-pointer relative group/thumb hover:border-[#00F5FF] transition-all shadow-2xl ring-1 ring-white/10"
                        title="Click to edit album details & cover art (Hover for large preview)"
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
                          className="font-bold text-base md:text-xl text-white truncate hover:text-[#00F5FF] cursor-pointer drop-shadow-md tracking-tight"
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

                      {/* Secondary line: Composer Pill, Artist, Year, Formats, Avg DR */}
                      <div className="flex items-center gap-2 text-xs text-[#94A3B8] flex-wrap">
                        {/* 1-Click Composer Badge */}
                        <button
                          onClick={() => handleEditAlbum(group)}
                          className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#EC4899]/15 text-[#EC4899] hover:bg-[#EC4899]/25 border border-[#EC4899]/30 font-mono text-[11px] transition-all cursor-pointer shrink-0 font-bold backdrop-blur-sm"
                          title="Composer for this album. Click to customize."
                        >
                          <span>🎼</span>
                          <span>{group.composerName || 'Set Composer'}</span>
                        </button>

                        <span className="text-white/20">&bull;</span>
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

                        {group.avgDr > 0 && (
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

                  {/* Right: Album-Level Actions with frosted glass */}
                  <div className="flex items-center gap-2.5 shrink-0 z-10">
                    <button
                      onClick={() => {
                        if (group.tracks.length > 0) {
                          playTrack(group.tracks[0], group.tracks)
                        }
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#10B981]/20 hover:bg-[#10B981]/30 text-[#10B981] border border-[#10B981]/40 backdrop-blur-md transition-all text-xs flex items-center gap-1.5 cursor-pointer font-bold shadow-md hover:scale-[1.02] active:scale-[0.98]"
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
                      className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/20 backdrop-blur-md transition-all text-xs flex items-center gap-1.5 cursor-pointer font-medium shadow-md"
                      title="Add all album tracks to playback queue"
                    >
                      <ListPlus className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Queue</span>
                    </button>

                    <button
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent('cadence:add-tracks-playlist', { detail: group.tracks })
                        )
                      }}
                      className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/20 backdrop-blur-md transition-all text-xs flex items-center gap-1.5 cursor-pointer font-medium shadow-md"
                      title="Add all album tracks to a playlist"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5 text-amber-400" />
                      <span>Playlist</span>
                    </button>

                    <button
                      onClick={() => handleEditAlbum(group)}
                      className="px-3 py-1.5 rounded-xl bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] border border-[#00F5FF]/40 backdrop-blur-md transition-all text-xs flex items-center gap-1.5 cursor-pointer font-bold shadow-md hover:scale-[1.02] active:scale-[0.98]"
                      title="Edit Album Title, Physical Folder Name, Composer, Year & Artwork for all tracks at once"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      <span>Edit Album</span>
                    </button>

                    {onOpenBatchDiff && (
                      <button
                        onClick={() => {
                          group.tracks.forEach((t) => {
                            if (!selectedTrackIds.has(t.id)) onToggleTrackSelection(t.id, false)
                          })
                          onOpenBatchDiff()
                        }}
                        className="px-3 py-1.5 rounded-xl bg-[#ADFF2F]/15 hover:bg-[#ADFF2F]/25 text-[#ADFF2F] border border-[#ADFF2F]/40 backdrop-blur-md transition-all text-xs flex items-center gap-1.5 cursor-pointer font-bold shadow-md hover:scale-[1.02] active:scale-[0.98]"
                        title="Batch Enrich all tracks in this album across Apple Music, MusicBrainz, and AI"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-[#ADFF2F]" />
                        <span>Enrich Album</span>
                      </button>
                    )}

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
                        className="px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 hover:text-white border border-amber-500/40 backdrop-blur-md transition-all text-xs flex items-center gap-1.5 cursor-pointer font-bold shadow-md hover:scale-[1.02] active:scale-[0.98]"
                        title="Background is not properly formatted. Click to automatically generate a high-fidelity 2400×320 panoramic backdrop."
                      >
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        <span>Format Backdrop</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* 2. INDENTED CHILD TRACKS TABLE */}
                {isExpanded && (
                  <div className="flex flex-col divide-y divide-white/[0.03]">
                    {group.tracks.map((track) => {
                      const isSelected = selectedTrackId === track.id
                      const isChecked = selectedTrackIds.has(track.id)
                      const drClass = IntegrityScanner.getDrBadgeClass(track.drScore)

                      return (
                        <div
                          key={track.id}
                          onDoubleClick={() => playTrack(track, group.tracks)}
                          onClick={(e) => {
                            if (e.altKey || e.shiftKey) {
                              onToggleTrackSelection(track.id, true)
                            } else {
                              onSelectTrack(track.id)
                            }
                          }}
                          className={`grid grid-cols-12 gap-2 px-4 h-[42px] items-center text-xs border-b border-white/[0.02] transition-colors cursor-pointer text-left group/row ${
                            isSelected
                              ? 'bg-[#00F5FF]/10 text-white font-medium'
                              : isChecked
                              ? 'bg-white/[0.05] text-[#F1F5F9]'
                              : 'hover:bg-white/[0.02] text-[#CBD5E1]'
                          } ${track.isOnline === false ? 'opacity-40 hover:opacity-75' : ''}`}
                        >
                          {/* Col 1: Indented Checkbox & Track Number / Play */}
                          <div className="col-span-1 flex items-center gap-2 pl-6 font-mono text-[#64748B]">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                e.stopPropagation()
                                onToggleTrackSelection(track.id, false)
                              }}
                              className="accent-[#00F5FF] w-3.5 h-3.5 rounded cursor-pointer"
                            />
                            <div
                              className="w-5 flex items-center justify-center cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (currentTrack?.id === track.id) {
                                  togglePlayPause()
                                } else {
                                  playTrack(track, group.tracks)
                                }
                              }}
                              title="Click to play track"
                            >
                              {currentTrack?.id === track.id ? (
                                isPlaying ? (
                                  <span className="flex items-center gap-0.5">
                                    <span className="w-0.5 h-2.5 bg-[#00F5FF] animate-pulse" />
                                    <span className="w-0.5 h-3.5 bg-[#00F5FF] animate-pulse" style={{ animationDelay: '150ms' }} />
                                    <span className="w-0.5 h-2 bg-[#00F5FF] animate-pulse" style={{ animationDelay: '300ms' }} />
                                  </span>
                                ) : (
                                  <Play className="w-3 h-3 text-[#00F5FF] fill-current" />
                                )
                              ) : (
                                <>
                                  <span className="group-hover/row:hidden">{track.trackNumber.toString().padStart(2, '0')}</span>
                                  <Play className="w-3 h-3 text-white hidden group-hover/row:inline fill-current" />
                                </>
                              )}
                            </div>
                          </div>

                          {/* Col 2: Title & Work Movement */}
                          <div className="col-span-4 flex items-center gap-2 truncate pr-2">
                            {track.sidecarStatus === 'uncommitted_sidecar' && (
                              <span
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onOpenSidecar(track.id)
                                }}
                                title="Uncommitted sidecar edit staged (Raw audio file untouched)"
                                className="sidecar-badge-dot shrink-0"
                              />
                            )}
                            <div className="flex flex-col truncate">
                              <span className="truncate font-medium text-[#F1F5F9]">{track.title}</span>
                              {track.movementTitle && (
                                <span className="text-[10px] text-[#64748B] font-mono truncate">
                                  Mov {track.movementNumber}: {track.movementTitle}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Col 3: Performer / Composer */}
                          <div className="col-span-2 flex flex-col truncate pr-2">
                            <span className="truncate text-[#94A3B8]">{track.artistCredit}</span>
                            {track.composerName && track.composerName !== group.composerName && (
                              <span className="text-[10px] text-[#EC4899] font-mono truncate">
                                {track.composerName}
                              </span>
                            )}
                          </div>

                          {/* Col 4: Inline DR Score & Spectral Meter */}
                          <div className="col-span-2 flex items-center gap-2">
                            <div
                              className={`px-1.5 py-0.2 rounded border font-mono font-bold text-[10px] ${drClass.bg} ${drClass.text}`}
                            >
                              DR{track.drScore}
                            </div>
                            <div className="w-16 h-2 bg-white/[0.05] rounded-full overflow-hidden flex">
                              <div
                                className={`h-full rounded-full ${
                                  track.drScore >= 14
                                    ? 'bg-[#10B981]'
                                    : track.drScore >= 10
                                    ? 'bg-[#00F5FF]'
                                    : 'bg-[#F59E0B]'
                                }`}
                                style={{ width: `${Math.min(100, (track.drScore / 18) * 100)}%` }}
                              />
                            </div>
                          </div>

                          {/* Col 5: Sample Format */}
                          <div className="col-span-2 flex items-center gap-1.5 font-mono text-[11px] text-[#94A3B8]">
                            <span className="px-1.5 py-0.2 rounded bg-white/[0.04] text-[#CBD5E1]">
                              {track.sampleRateStr}
                            </span>
                            <span className="text-[#94A3B8] font-semibold">{track.format}</span>
                          </div>

                          {/* Col 6: Duration & Checksum Status + Quick Actions on Hover */}
                          <div
                            data-tutorial-id="grid-sidecar-status-pill"
                            className="col-span-1 flex items-center justify-end gap-1.5 text-right relative"
                          >
                            <span className="font-mono text-[11px] text-[#94A3B8] group-hover/row:hidden">
                              {formatDuration(track.durationSeconds)}
                            </span>
                            <div className="group-hover/row:hidden" title={track.checksumValid ? 'Bit-perfect audio MD5 checksum verified' : 'Bit-rot / Checksum corrupt'}>
                              {track.checksumValid ? (
                                <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
                              ) : (
                                <AlertTriangle className="w-3.5 h-3.5 text-[#F43F5E]" />
                              )}
                            </div>

                            {/* Quick Actions Revealed on Hover */}
                            <div className="hidden group-hover/row:flex items-center gap-1 animate-fadeIn">
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
                )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* Flat Virtual Scrolling Table (60fps Windowing) */
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto overflow-x-hidden relative"
        >
          <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
            <div
              style={{
                transform: `translateY(${offsetY}px)`,
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
              }}
            >
              {visibleTracks.map((track) => {
                const isSelected = selectedTrackId === track.id
                const isChecked = selectedTrackIds.has(track.id)
                const drClass = IntegrityScanner.getDrBadgeClass(track.drScore)

                return (
                  <div
                    key={track.id}
                    onDoubleClick={() => playTrack(track, tracks)}
                    onClick={(e) => {
                      if (e.altKey || e.shiftKey) {
                        onToggleTrackSelection(track.id, true)
                      } else {
                        onSelectTrack(track.id)
                      }
                    }}
                    className={`grid grid-cols-12 gap-2 px-4 h-[44px] items-center text-xs border-b border-white/[0.03] transition-colors cursor-pointer text-left group/row ${
                      isSelected
                        ? 'bg-[#00F5FF]/10 text-white font-medium'
                        : isChecked
                        ? 'bg-white/[0.05] text-[#F1F5F9]'
                        : 'hover:bg-white/[0.02] text-[#CBD5E1]'
                    } ${track.isOnline === false ? 'opacity-40 hover:opacity-75' : ''}`}
                  >
                    {/* Col 1: Checkbox & Index / Play */}
                    <div className="col-span-1 flex items-center gap-2 font-mono text-[#64748B]">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          e.stopPropagation()
                          onToggleTrackSelection(track.id, false)
                        }}
                        className="accent-[#00F5FF] w-3.5 h-3.5 rounded cursor-pointer"
                      />
                      <div
                        className="w-5 flex items-center justify-center cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (currentTrack?.id === track.id) {
                            togglePlayPause()
                          } else {
                            playTrack(track, tracks)
                          }
                        }}
                        title="Click to play track"
                      >
                        {currentTrack?.id === track.id ? (
                          isPlaying ? (
                            <span className="flex items-center gap-0.5">
                              <span className="w-0.5 h-2.5 bg-[#00F5FF] animate-pulse" />
                              <span className="w-0.5 h-3.5 bg-[#00F5FF] animate-pulse" style={{ animationDelay: '150ms' }} />
                              <span className="w-0.5 h-2 bg-[#00F5FF] animate-pulse" style={{ animationDelay: '300ms' }} />
                            </span>
                          ) : (
                            <Play className="w-3 h-3 text-[#00F5FF] fill-current" />
                          )
                        ) : (
                          <>
                            <span className="group-hover/row:hidden">{track.trackNumber.toString().padStart(2, '0')}</span>
                            <Play className="w-3 h-3 text-white hidden group-hover/row:inline fill-current" />
                          </>
                        )}
                      </div>
                    </div>

                    {/* Col 2: Title & Work Movement */}
                    <div className="col-span-4 flex items-center gap-2.5 truncate pr-2">
                      {track.sidecarStatus === 'uncommitted_sidecar' && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenSidecar(track.id)
                          }}
                          title="Uncommitted sidecar edit staged (Raw FLAC untouched)"
                          className="sidecar-badge-dot shrink-0"
                        />
                      )}

                      {(() => {
                        const rel = releases?.find((r) => r.id === track.releaseId)
                        const trkCoverUrl = track.pendingSidecarEdits?.coverArtUrl || rel?.artwork?.frontCoverUrl
                        if (!trkCoverUrl) return null
                        return (
                          <ArtworkHoverPreview
                            src={trkCoverUrl}
                            alt={track.title}
                            title={track.title}
                            subtitle={track.artistCredit}
                            composer={track.composerName}
                            audioSpec={track.sampleRateStr}
                            drScore={track.drScore}
                            provider="local"
                            previewSize={260}
                          >
                            <div className="w-6 h-6 rounded overflow-hidden border border-white/[0.1] shrink-0 bg-black/40 cursor-pointer shadow-sm">
                              <img
                                src={trkCoverUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  ;(e.target as HTMLElement).style.display = 'none'
                                }}
                              />
                            </div>
                          </ArtworkHoverPreview>
                        )
                      })()}

                      <div className="flex flex-col truncate">
                        <div className="flex items-center gap-2 truncate">
                          <span className="truncate font-medium text-[#F1F5F9]">{track.title}</span>
                          {track.folderName && (
                            <span
                              className="text-[10px] text-[#38BDF8] bg-[#38BDF8]/10 px-1.5 py-0.2 rounded border border-[#38BDF8]/20 font-mono shrink-0 truncate max-w-[140px]"
                              title={`Physical Folder: ${track.folderName}`}
                            >
                              📁 {track.folderName}
                            </span>
                          )}
                        </div>
                        {track.movementTitle && (
                          <span className="text-[10px] text-[#64748B] font-mono truncate">
                            Mov {track.movementNumber}: {track.movementTitle}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Col 3: Performer / Composer */}
                    <div className="col-span-2 flex flex-col truncate pr-2">
                      <span className="truncate text-[#94A3B8]">{track.artistCredit}</span>
                      {track.composerName && (
                        <span className="text-[10px] text-[#EC4899] font-mono truncate">
                          {track.composerName}
                        </span>
                      )}
                    </div>

                    {/* Col 4: Inline DR Score & Spectral Meter */}
                    <div className="col-span-2 flex items-center gap-2">
                      <div
                        className={`px-1.5 py-0.2 rounded border font-mono font-bold text-[10px] ${drClass.bg} ${drClass.text}`}
                      >
                        DR{track.drScore}
                      </div>
                      <div className="w-16 h-2 bg-white/[0.05] rounded-full overflow-hidden flex">
                        <div
                          className={`h-full rounded-full ${
                            track.drScore >= 14
                              ? 'bg-[#10B981]'
                              : track.drScore >= 10
                              ? 'bg-[#00F5FF]'
                              : 'bg-[#F59E0B]'
                          }`}
                          style={{ width: `${Math.min(100, (track.drScore / 18) * 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Col 5: Sample Format */}
                    <div className="col-span-2 flex items-center gap-1.5 font-mono text-[11px] text-[#94A3B8]">
                      <span className="px-1.5 py-0.2 rounded bg-white/[0.04] text-[#CBD5E1]">
                        {track.sampleRateStr}
                      </span>
                      <span className="text-[#64748B]">{track.format}</span>
                    </div>

                    {/* Col 6: Checksum & Status */}
                    <div
                      data-tutorial-id="grid-sidecar-status-pill"
                      className="col-span-1 flex items-center justify-end gap-2 text-right"
                    >
                      <span className="font-mono text-[11px] text-[#64748B]">
                        {formatDuration(track.durationSeconds)}
                      </span>
                      <div title={track.checksumValid ? 'FLAC stream MD5 bit-perfect' : 'Bit-rot / Checksum corrupt'}>
                        {track.checksumValid ? (
                          <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-[#F43F5E]" />
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
