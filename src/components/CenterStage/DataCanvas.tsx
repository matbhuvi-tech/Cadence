import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Layers,
  Table,
  FolderTree,
  Search,
  Sparkles,
  ShieldAlert,
  X,
  ChevronsDown,
  ChevronsUp,
  LayoutGrid,
  Music,
  Folder,
  SlidersHorizontal,
  RotateCcw,
  FolderPlus,
  Filter,
} from 'lucide-react'
import { Work, Track, Release, AlbumDisplayMode, AuditIssue, CanvasViewMode } from '../../core/types'
import { AlbumCoverGrid, EntityTab, SortBy, CardSize } from './AlbumCoverGrid'
import { WorkMovementView } from './WorkMovementView'
import { VariantStackCard } from './VariantStackCard'
import { VirtualDataTable } from './VirtualDataTable'
import { SpreadsheetMultiEdit } from './SpreadsheetMultiEdit'
import { FolderTreeExplorer } from './FolderTreeExplorer'
import { FacetSelections } from '../LeftRail/FacetedFilters'
import { splitMultiArtistCredits } from '../../core/taxonomyUtils'

export type { CanvasViewMode }

interface DataCanvasProps {
  viewMode: CanvasViewMode
  onViewModeChange: (mode: CanvasViewMode) => void
  albumDisplayMode?: AlbumDisplayMode
  onAlbumDisplayModeChange?: (mode: AlbumDisplayMode) => void
  searchQuery: string
  onSearchChange: (q: string) => void

  works: Work[]
  releases: Release[]
  tracks: Track[]

  selectedTrackId?: string
  onSelectTrack: (trackId: string) => void
  selectedTrackIds: Set<string>
  onToggleTrackSelection: (trackId: string, isMulti: boolean) => void
  onSelectAllTracks: (selectAll: boolean) => void

  onSelectVariant: (releaseId: string, variantId: string) => void
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
    }
  ) => void
  onOpenSidecar: (trackId: string) => void
  onApplyBatchEdits: (editsMap: Record<string, Partial<Track>>) => void

  onTriggerTwoPhaseCommit?: () => void
  onOpenBatchRuleModal?: () => void
  onOpenImportModal: () => void
  onOpenBatchDiff?: () => void
  onOpenBatchAi?: () => void
  totalLibraryTracksCount?: number
  onResetFilters?: () => void

  activeTriageIssue?: AuditIssue
  onClearTriageFilter?: () => void
  onRemediateTriageIssue?: (issueId: string) => void

  facets?: FacetSelections
  onFacetChange?: (facets: FacetSelections) => void

  activeCoverTab?: EntityTab
  onActiveCoverTabChange?: (tab: EntityTab) => void
  selectedAlbumId?: string | null
  onSelectAlbumId?: (albumId: string | null) => void
  selectedArtist?: string | null
  onSelectArtist?: (artist: string | null) => void
  selectedComposer?: string | null
  onSelectComposer?: (composer: string | null) => void
}

export const DataCanvas: React.FC<DataCanvasProps> = ({
  viewMode,
  onViewModeChange,
  albumDisplayMode = 'album_first',
  onAlbumDisplayModeChange,
  searchQuery,
  onSearchChange,
  works,
  releases,
  tracks,
  selectedTrackId,
  onSelectTrack,
  selectedTrackIds,
  onToggleTrackSelection,
  onSelectAllTracks,
  onSelectVariant,
  onInspectRelease,
  onCustomizeRelease,
  onUpdateReleaseDetails,
  onOpenSidecar,
  onApplyBatchEdits,
  onOpenImportModal,
  onOpenBatchDiff,
  onOpenBatchAi,
  totalLibraryTracksCount = 0,
  onResetFilters,
  activeTriageIssue,
  onClearTriageFilter,
  onRemediateTriageIssue,
  facets = {},
  onFacetChange,
  activeCoverTab: propActiveCoverTab,
  onActiveCoverTabChange,
  selectedAlbumId,
  onSelectAlbumId,
  selectedArtist,
  onSelectArtist,
  selectedComposer,
  onSelectComposer,
}) => {
  const [isMultiEditOpen, setIsMultiEditOpen] = useState(false)
  const [expandedReleaseIds, setExpandedReleaseIds] = useState<Set<string>>(new Set())
  const [isFilterShelfOpen, setIsFilterShelfOpen] = useState(false)

  // Cover grid unified toolbar state (lifted or internal fallback)
  const [internalActiveCoverTab, setInternalActiveCoverTab] = useState<EntityTab>('albums')
  const activeCoverTab = propActiveCoverTab ?? internalActiveCoverTab
  const setActiveCoverTab = onActiveCoverTabChange ?? setInternalActiveCoverTab

  const [coverSortBy, setCoverSortBy] = useState<SortBy>('year_desc')
  const [coverCardSize, setCoverCardSize] = useState<CardSize>('standard')
  const inlineSearchInputRef = useRef<HTMLInputElement>(null)

  // Derive distinct canonical artist and composer counts
  const artistCount = useMemo(() => {
    const set = new Set<string>()
    releases.forEach((r) => {
      if (r.composerName) set.add(r.composerName.trim().toLowerCase())
      if (r.artistCredit) {
        splitMultiArtistCredits(r.artistCredit).forEach((c) => set.add(c.name.trim().toLowerCase()))
      }
    })
    tracks.forEach((t) => {
      if (t.composerName) set.add(t.composerName.trim().toLowerCase())
      if (t.artistCredit) {
        splitMultiArtistCredits(t.artistCredit).forEach((c) => set.add(c.name.trim().toLowerCase()))
      }
    })
    return set.size
  }, [releases, tracks])

  const composerCount = useMemo(() => {
    const set = new Set<string>()
    releases.forEach((r) => r.composerName && set.add(r.composerName))
    tracks.forEach((t) => t.composerName && set.add(t.composerName))
    return set.size
  }, [releases, tracks])

  const isAllExpanded = releases.length > 0 && releases.every((r) => expandedReleaseIds.has(r.id))

  // Keyboard shortcut listener for Filter Shelf / Inline Filter (⌘F / Ctrl+F)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) {
          return
        }
        e.preventDefault()
        inlineSearchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleToggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedReleaseIds(new Set())
    } else {
      setExpandedReleaseIds(new Set(releases.map((r) => r.id)))
    }
  }

  const handleToggleExpand = (releaseId: string) => {
    setExpandedReleaseIds((prev) => {
      const next = new Set(prev)
      if (next.has(releaseId)) {
        next.delete(releaseId)
      } else {
        next.add(releaseId)
      }
      return next
    })
  }

  // Active filter count and tokens
  const activeTokens = useMemo(() => {
    const tokens: { key: keyof FacetSelections | 'search'; label: string; value: string }[] = []
    if (searchQuery.trim()) {
      tokens.push({ key: 'search', label: 'Search', value: searchQuery.trim() })
    }
    if (facets.era) {
      tokens.push({ key: 'era', label: 'Era', value: facets.era })
    }
    if (facets.format) {
      tokens.push({ key: 'format', label: 'Format', value: facets.format })
    }
    if (facets.mastering) {
      tokens.push({ key: 'mastering', label: 'Tier', value: facets.mastering === 'audiophile_dr14' ? 'DR14+' : facets.mastering === 'high_res_24bit' ? '24-bit Hi-Res' : facets.mastering })
    }
    if (facets.composer) {
      tokens.push({ key: 'composer', label: 'Composer', value: facets.composer })
    }
    if (facets.language) {
      tokens.push({ key: 'language', label: 'Language', value: facets.language })
    }
    if (facets.genre) {
      tokens.push({ key: 'genre', label: 'Genre', value: facets.genre })
    }
    if (facets.ensemble) {
      tokens.push({ key: 'ensemble', label: 'Performer', value: facets.ensemble })
    }
    return tokens
  }, [searchQuery, facets])

  const handleRemoveToken = (tokenKey: keyof FacetSelections | 'search') => {
    if (tokenKey === 'search') {
      onSearchChange('')
    } else if (onFacetChange) {
      const next = { ...facets }
      delete next[tokenKey]
      onFacetChange(next)
    }
  }

  const selectedTracksList = tracks.filter((t) => selectedTrackIds.has(t.id))

  // View title label
  const viewTitle = useMemo(() => {
    switch (viewMode) {
      case 'cover_grid':
        return `Albums (${releases.length})`
      case 'virtual_table':
        return `All Tracks (${tracks.length})`
      case 'work_movement':
        return `Classical Works & Movements (${works.length})`
      case 'variant_stack':
        return `Pressing Stacks (${releases.length})`
      case 'folder_tree':
        return 'Physical Folder Tree'
      default:
        return 'Library'
    }
  }, [viewMode, releases.length, tracks.length, works.length])

  return (
    <main className="flex-1 min-h-0 flex flex-col h-full overflow-hidden bg-[#0C0D10] select-none">
      {/* 1. Sleek macOS Sub-Toolbar */}
      <header className="px-6 py-2.5 border-b border-white/[0.05] bg-[#121316]/70 backdrop-blur-2xl flex items-center justify-between gap-4 shrink-0 z-20">
        {/* Left: View Title or Translucent Entity Switcher & Active Filter Tokens */}
        <div className="flex items-center gap-3 min-w-0">
          {viewMode === 'cover_grid' ? (
            <div className="flex items-center gap-1 p-0.5 rounded-xl bg-white/[0.04] border border-white/[0.08] shrink-0">
              <button
                onClick={() => {
                  setActiveCoverTab('albums')
                  onSelectAlbumId?.(null)
                  onSelectArtist?.(null)
                  onSelectComposer?.(null)
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  activeCoverTab === 'albums'
                    ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                    : 'text-[#8E8E93] hover:text-[#F5F5F7]'
                }`}
              >
                Albums ({releases.length})
              </button>
              <button
                onClick={() => {
                  setActiveCoverTab('artists')
                  onSelectAlbumId?.(null)
                  onSelectArtist?.(null)
                  onSelectComposer?.(null)
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  activeCoverTab === 'artists'
                    ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                    : 'text-[#8E8E93] hover:text-[#F5F5F7]'
                }`}
              >
                Artists ({artistCount})
              </button>
              <button
                onClick={() => {
                  setActiveCoverTab('composers')
                  onSelectAlbumId?.(null)
                  onSelectArtist?.(null)
                  onSelectComposer?.(null)
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  activeCoverTab === 'composers'
                    ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                    : 'text-[#8E8E93] hover:text-[#F5F5F7]'
                }`}
              >
                Composers ({composerCount})
              </button>
            </div>
          ) : (
            <span className="font-semibold text-xs tracking-tight text-white whitespace-nowrap">
              {viewTitle}
            </span>
          )}

          {/* Decoupled In-Place Filter Input (⌘F) */}
          <div className="relative flex items-center shrink-0">
            <Search className="w-3.5 h-3.5 text-[#8E8E93] absolute left-2.5 pointer-events-none" />
            <input
              ref={inlineSearchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter in-place (⌘F)..."
              className="pl-8 pr-7 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08] focus:border-[#D4AF37]/50 text-xs text-white placeholder:text-[#636366] focus:outline-none w-36 sm:w-44 transition-all font-sans"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute right-2 text-[#8E8E93] hover:text-white p-0.5 cursor-pointer"
                title="Clear inline filter"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {activeTokens.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 max-w-xl">
              <span className="text-[10px] text-[#8E8E93] font-mono whitespace-nowrap">Filtered:</span>
              {activeTokens.map((tok) => (
                <span
                  key={tok.key}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-[#F5F5F7]"
                >
                  <span className="text-[#8E8E93]">{tok.label}:</span>
                  <span className="font-semibold">{tok.value}</span>
                  <button
                    onClick={() => handleRemoveToken(tok.key)}
                    className="hover:text-rose-400 p-0.5 transition-colors cursor-pointer"
                    title={`Remove ${tok.label} filter`}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}

              {onResetFilters && (
                <button
                  onClick={onResetFilters}
                  className="text-[10px] font-mono text-[#D4AF37] hover:underline px-1.5 py-0.5 whitespace-nowrap cursor-pointer"
                >
                  Clear All
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right: Operational Tool Triggers & Filter Shelf Toggle */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Filter Shelf Toggle (⌘F) */}
          <button
            onClick={() => setIsFilterShelfOpen((prev) => !prev)}
            title="Filter by Era, Format, Dynamic Range, Composer (⌘F)"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
              isFilterShelfOpen || activeTokens.length > 0
                ? 'bg-[#D4AF37]/20 border border-[#D4AF37]/40 text-[#D4AF37] font-semibold'
                : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[#8E8E93] hover:text-[#F5F5F7]'
            }`}
          >
            <Filter className="w-3 h-3 text-[#D4AF37]" />
            <span>Filter</span>
            {activeTokens.length > 0 && (
              <span className="text-[10px] px-1 py-0.2 rounded-full bg-[#D4AF37] text-black font-bold">
                {activeTokens.length}
              </span>
            )}
            <span className="text-[9px] text-[#636366] font-mono hidden sm:inline">⌘F</span>
          </button>

          {/* Sort & Grid Size when in Cover Grid Mode */}
          {viewMode === 'cover_grid' && (
            <>
              {/* Sort By Dropdown */}
              <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
                <span className="text-[11px] font-mono text-[#8E8E93]">Sort:</span>
                <select
                  value={coverSortBy}
                  onChange={(e) => setCoverSortBy(e.target.value as SortBy)}
                  className="bg-black/40 border border-white/[0.1] rounded-lg px-2.5 py-1 text-xs text-[#EDEDED] focus:border-[#D4AF37] focus:outline-none cursor-pointer"
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
                    onClick={() => setCoverCardSize(size)}
                    className={`px-2 py-0.5 rounded capitalize transition-all cursor-pointer ${
                      coverCardSize === size ? 'bg-white/10 text-white font-bold' : 'hover:text-white'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Display Mode Toggle (Album First vs Folder First) */}
          {(viewMode === 'virtual_table' || viewMode === 'work_movement' || viewMode === 'variant_stack') && (
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <button
                onClick={() => onAlbumDisplayModeChange?.('album_first')}
                title="Show Metadata Album Name prominently"
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition-all cursor-pointer flex items-center gap-1 ${
                  albumDisplayMode === 'album_first'
                    ? 'bg-white/[0.1] text-white font-medium'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                <Music className="w-3 h-3 text-[#D4AF37]" />
                <span className="hidden xl:inline">Album First</span>
              </button>

              <button
                onClick={() => onAlbumDisplayModeChange?.('folder_first')}
                title="Show Physical Folder Name prominently"
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition-all cursor-pointer flex items-center gap-1 ${
                  albumDisplayMode === 'folder_first'
                    ? 'bg-white/[0.1] text-white font-medium'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                <Folder className="w-3 h-3 text-cyan-400" />
                <span className="hidden xl:inline">Folder First</span>
              </button>
            </div>
          )}

          {/* Variant Stack Expand/Collapse All Action */}
          {viewMode === 'variant_stack' && (
            <button
              onClick={handleToggleExpandAll}
              className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs font-mono text-[#8E8E93] hover:text-white transition-all flex items-center gap-1.5 cursor-pointer"
            >
              {isAllExpanded ? (
                <>
                  <ChevronsUp className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span className="hidden xl:inline">Collapse All</span>
                </>
              ) : (
                <>
                  <ChevronsDown className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span className="hidden xl:inline">Expand All</span>
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {/* 2. Slide-down Horizontal Filter Token Shelf (Finder / Lightroom Style) */}
      {isFilterShelfOpen && (
        <div className="px-6 py-3 bg-[#16171D] border-b border-white/[0.06] space-y-2.5 animate-in slide-in-from-top-2 duration-150 z-10 text-xs">
          {/* Era Row */}
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="w-16 font-mono text-[10px] uppercase text-[#8E8E93] font-semibold shrink-0">
              Era:
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {['1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'].map((era) => (
                <button
                  key={era}
                  onClick={() => onFacetChange?.({ ...facets, era: facets.era === era ? undefined : era })}
                  className={`px-2.5 py-1 rounded-full text-xs font-mono transition-all cursor-pointer ${
                    facets.era === era
                      ? 'bg-[#D4AF37] text-black font-semibold shadow-sm'
                      : 'bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white border border-white/[0.05]'
                  }`}
                >
                  {era}
                </button>
              ))}
            </div>
          </div>

          {/* Format Row */}
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="w-16 font-mono text-[10px] uppercase text-[#8E8E93] font-semibold shrink-0">
              Format:
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {[
                { label: 'Native DSD', val: 'DSD', color: 'text-[#818CF8]' },
                { label: 'WAV', val: 'WAV', color: 'text-[#38BDF8]' },
                { label: 'FLAC', val: 'FLAC', color: 'text-[#F59E0B]' },
                { label: 'AIFF', val: 'AIFF' },
                { label: 'ALAC', val: 'ALAC' },
              ].map((f) => {
                const isFormatActive =
                  facets.format === f.val ||
                  (f.val === 'DSD' && (facets.format === 'DSD256' || facets.format === 'Native DSD'))
                return (
                  <button
                    key={f.val}
                    onClick={() => onFacetChange?.({ ...facets, format: isFormatActive ? undefined : f.val })}
                    className={`px-2.5 py-1 rounded-full text-xs font-mono transition-all cursor-pointer ${
                      isFormatActive
                        ? 'bg-white text-black font-semibold shadow-sm'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white border border-white/[0.05]'
                    }`}
                  >
                    <span className={f.color}>{f.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Audiophile Dynamic Range Tier Row */}
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="w-16 font-mono text-[10px] uppercase text-[#8E8E93] font-semibold shrink-0">
              Dynamics:
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {[
                { label: '24-bit Hi-Res', val: 'high_res_24bit' },
                { label: 'DR14+ (Reference Grade)', val: 'audiophile_dr14' },
                { label: 'DR12+ (Audiophile)', val: 'audiophile_dr12' },
                { label: 'DR10+ (Standard)', val: 'standard_dr10' },
              ].map((dr) => (
                <button
                  key={dr.val}
                  onClick={() => onFacetChange?.({ ...facets, mastering: facets.mastering === dr.val ? undefined : dr.val })}
                  className={`px-2.5 py-1 rounded-full text-xs font-mono transition-all cursor-pointer ${
                    facets.mastering === dr.val
                      ? 'bg-[#10B981] text-black font-semibold shadow-sm'
                      : 'bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white border border-white/[0.05]'
                  }`}
                >
                  {dr.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. Active Triage Anomaly Banner */}
      {activeTriageIssue && (
        <div
          data-testid="active-triage-banner"
          className="px-6 py-2 bg-[#F59E0B]/10 border-b border-[#F59E0B]/30 flex items-center justify-between gap-4 text-xs shrink-0"
        >
          <div className="flex items-center gap-2.5">
            <div className="p-1 rounded bg-[#F59E0B]/20 text-[#F59E0B]">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div className="flex items-center flex-wrap gap-x-2">
              <span className="font-bold text-white">{activeTriageIssue.title}</span>
              <span className="text-[#D4AF37] font-mono text-[11px] font-semibold">
                &bull; {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} isolated
              </span>
              <span className="text-[#8E8E93] text-[11px] hidden lg:inline">
                ({activeTriageIssue.suggestedFix})
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onRemediateTriageIssue &&
              activeTriageIssue.affectedCount > 0 &&
              activeTriageIssue.isAutoFixable !== false &&
              Boolean(activeTriageIssue.autoFixAction) && (
                <button
                  onClick={() => onRemediateTriageIssue(activeTriageIssue.id)}
                  title={activeTriageIssue.suggestedFix || 'Apply 1-Click Auto Fix to all isolated tracks'}
                  className="px-3 py-1 rounded-lg bg-[#D4AF37]/20 text-[#D4AF37] hover:bg-[#D4AF37]/30 border border-[#D4AF37]/40 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{activeTriageIssue.fixActionLabel || 'Auto-Fix'}</span>
                </button>
              )}
            {onClearTriageFilter && (
              <button
                onClick={onClearTriageFilter}
                title="Clear Triage Filter & Return to Full Grid View"
                className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4. Main Canvas Workspace */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {tracks.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center p-8 text-center select-none overflow-y-auto">
            <div className="max-w-xl w-full flex flex-col items-center bg-[#131418] border border-white/[0.06] rounded-2xl p-10 shadow-2xl relative overflow-hidden">
              {totalLibraryTracksCount > 0 ? (
                <>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[10px] font-mono tracking-widest text-[#F59E0B] uppercase mb-6">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] animate-pulse" />
                    Filtered View &bull; 0 Matching Tracks
                  </div>

                  <h2 className="text-xl font-bold text-white tracking-tight mb-2">
                    No Tracks Match Current Filter
                  </h2>
                  <p className="text-xs text-[#8E8E93] leading-relaxed max-w-md mb-8">
                    Your collection contains {totalLibraryTracksCount} audio tracks across {releases.length} albums, but none match the currently active search query or taxonomy filter.
                  </p>

                  {onResetFilters && (
                    <button
                      onClick={() => {
                        onResetFilters()
                        onSearchChange('')
                        if (onFacetChange) onFacetChange({})
                      }}
                      className="px-6 py-2.5 rounded-xl bg-white text-black font-semibold text-xs shadow-xl transition-all flex items-center justify-center gap-2 cursor-pointer hover:bg-white/90"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Clear All Filters</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-[10px] font-mono tracking-widest text-[#D4AF37] uppercase mb-6">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37] animate-pulse" />
                    Audiophile Library Ready
                  </div>

                  <div className="w-20 h-20 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-6 shadow-inner">
                    <FolderPlus className="w-10 h-10 text-[#D4AF37]" />
                  </div>

                  <h2 className="text-xl font-bold text-white tracking-tight mb-2">
                    No Music Ingested Yet
                  </h2>
                  <p className="text-xs text-[#8E8E93] leading-relaxed max-w-md mb-8">
                    Connect your local high-resolution audio directory to parse DSD, FLAC, ALAC, and WAV files with bit-accurate metadata, DR metering, and sidecar safety.
                  </p>

                  <button
                    onClick={onOpenImportModal}
                    className="w-full sm:w-auto px-8 py-3 rounded-xl bg-white hover:bg-white/90 text-black font-semibold text-xs shadow-xl transition-all flex items-center justify-center gap-3 cursor-pointer"
                  >
                    <FolderPlus className="w-4 h-4 text-black" />
                    <span>Import Music Folder</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/10 text-black/80">⌘O</span>
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {viewMode === 'cover_grid' && (
              <AlbumCoverGrid
                releases={releases}
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                onSelectTrack={onSelectTrack}
                onInspectRelease={onInspectRelease}
                onCustomizeRelease={onCustomizeRelease}
                onUpdateReleaseDetails={onUpdateReleaseDetails}
                onOpenBatchDiff={onOpenBatchDiff}
                activeTab={activeCoverTab}
                onActiveTabChange={setActiveCoverTab}
                sortBy={coverSortBy}
                onSortByChange={setCoverSortBy}
                cardSize={coverCardSize}
                onCardSizeChange={setCoverCardSize}
                hideSubHeader={true}
                selectedAlbumId={selectedAlbumId}
                onSelectAlbumId={onSelectAlbumId}
                selectedArtist={selectedArtist}
                onSelectArtist={onSelectArtist}
                selectedComposer={selectedComposer}
                onSelectComposer={onSelectComposer}
              />
            )}

            {viewMode === 'work_movement' && (
              <WorkMovementView
                works={works}
                tracks={tracks}
                releases={releases}
                displayMode={albumDisplayMode}
                selectedTrackId={selectedTrackId}
                onSelectTrack={onSelectTrack}
                onOpenSidecar={onOpenSidecar}
                onCustomizeRelease={onCustomizeRelease}
              />
            )}

            {viewMode === 'variant_stack' && (
              <div className="flex flex-col gap-3 p-6 overflow-y-auto h-full">
                {releases.map((release) => {
                  const activeReleaseId = tracks.find((t) => t.id === selectedTrackId)?.releaseId
                  const isSelected = activeReleaseId === release.id
                  const isExpanded = expandedReleaseIds.has(release.id) || isSelected
                  return (
                    <VariantStackCard
                      key={release.id}
                      release={release}
                      isSelected={isSelected}
                      isExpanded={isExpanded}
                      onToggleExpand={handleToggleExpand}
                      displayMode={albumDisplayMode}
                      onSelectVariant={onSelectVariant}
                      onInspectRelease={onInspectRelease}
                      onCustomizeRelease={onCustomizeRelease}
                    />
                  )
                })}
              </div>
            )}

            {viewMode === 'virtual_table' && (
              <VirtualDataTable
                tracks={tracks}
                releases={releases}
                albumDisplayMode={albumDisplayMode}
                selectedTrackId={selectedTrackId}
                onSelectTrack={onSelectTrack}
                selectedTrackIds={selectedTrackIds}
                onToggleTrackSelection={onToggleTrackSelection}
                onSelectAll={onSelectAllTracks}
                onOpenMultiEdit={() => setIsMultiEditOpen(true)}
                onOpenBatchDiff={onOpenBatchDiff}
                onOpenBatchAi={onOpenBatchAi}
                onOpenSidecar={onOpenSidecar}
                onCustomizeRelease={onCustomizeRelease}
                onInspectRelease={onInspectRelease}
                onUpdateReleaseDetails={onUpdateReleaseDetails}
              />
            )}

            {viewMode === 'folder_tree' && (
              <FolderTreeExplorer
                tracks={tracks}
                releases={releases}
                selectedTrackId={selectedTrackId}
                onSelectTrack={onSelectTrack}
              />
            )}
          </>
        )}
      </div>

      {/* Spreadsheet Multi-Edit Modal */}
      {isMultiEditOpen && (
        <SpreadsheetMultiEdit
          selectedTracks={selectedTracksList}
          onClose={() => setIsMultiEditOpen(false)}
          onApplyEdits={onApplyBatchEdits}
        />
      )}
    </main>
  )
}
