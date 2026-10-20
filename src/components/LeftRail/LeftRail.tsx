import React, { useState } from 'react'
import {
  Music4,
  Disc3,
  Layers,
  FolderTree,
  FolderPlus,
  Sparkles,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Flame,
  Volume2,
  Clock,
  HardDrive,
  LayoutGrid,
} from 'lucide-react'
import { FacetedFilters, FacetSelections } from './FacetedFilters'
import { AuditIssue, StorageMount, Track, Release, WatchedFolder, CanvasViewMode } from '../../core/types'

interface LeftRailProps {
  auditIssues: AuditIssue[]
  activeTriageFilter?: string
  onSelectTriageFilter: (filterId?: string) => void
  onRemediateAudit: (issueId: string) => void
  healthScore?: number
  isFilteredScope?: boolean
  scopeTrackCount?: number
  totalTrackCount?: number
  onRefreshAudit?: () => void
  onOpenNormalizationRules?: () => void

  facets: FacetSelections
  onFacetChange: (facets: FacetSelections) => void
  onResetFacets: () => void

  storageMounts: StorageMount[]
  onToggleReadOnly: (mountId: string) => void
  selectedMountId?: string
  onSelectMount: (mountId?: string) => void
  selectedFolderFilter?: string
  onSelectFolderFilter?: (folderPath?: string) => void
  onOpenStorageManager?: () => void
  onOpenImportModal?: () => void
  watchedFolders?: WatchedFolder[]

  tracks: Track[]
  releases: Release[]

  viewMode?: CanvasViewMode
  onViewModeChange?: (mode: CanvasViewMode) => void
}

export const LeftRail: React.FC<LeftRailProps> = ({
  auditIssues,
  facets,
  onFacetChange,
  onResetFacets,
  tracks,
  releases,
  viewMode = 'virtual_table',
  onViewModeChange,
  watchedFolders = [],
  onOpenImportModal,
  onOpenStorageManager,
}) => {
  const [isFiltersOpen, setIsFiltersOpen] = useState(true)
  const [activeSmartView, setActiveSmartView] = useState<string | null>(null)

  // Smart View Quick Filter Handlers
  const handleSmartViewClick = (type: string) => {
    if (activeSmartView === type) {
      setActiveSmartView(null)
      onResetFacets()
      return
    }
    setActiveSmartView(type)
    if (type === 'highres') {
      onFacetChange({ mastering: 'high_res_24bit' })
    } else if (type === 'dsd') {
      onFacetChange({ format: 'DSD256' })
    } else if (type === 'dr') {
      onFacetChange({ mastering: 'audiophile_dr14' })
    }
  }

  return (
    <aside className="w-[280px] shrink-0 h-full overflow-y-auto flex flex-col justify-between p-3 border-r border-white/[0.07] bg-[#0A0C10] select-none text-xs">
      <div className="space-y-4">
        {/* 0. PRIMARY INGESTION ACTION (Always Discoverable) */}
        <div className="pb-2 border-b border-white/[0.08]">
          <button
            onClick={onOpenImportModal}
            title="Add audio folder or files to library (⌘O)"
            className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-cyan-500/20 via-cyan-400/10 to-transparent hover:from-cyan-500/30 hover:via-cyan-400/20 border border-cyan-500/40 hover:border-cyan-400 text-cyan-300 hover:text-white font-semibold text-xs transition-all flex items-center justify-between shadow-lg shadow-cyan-500/10 cursor-pointer group"
          >
            <div className="flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform" />
              <span>Add Music / Folders</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-cyan-400/80 border border-cyan-500/30">
              ⌘O
            </span>
          </button>
        </div>

        {/* 1. PRIMARY NAVIGATION (Where to Go / Entity Lens) */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-500 font-bold px-2 py-1 tracking-wider">
            Library Views
          </div>

          <button
            onClick={() => onViewModeChange?.('cover_grid')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-semibold flex items-center gap-2 transition-all cursor-pointer ${
              viewMode === 'cover_grid'
                ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <LayoutGrid className="w-4 h-4 text-cyan-400" />
            <span>Cover-Art Library</span>
          </button>

          <button
            onClick={() => onViewModeChange?.('virtual_table')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-semibold flex items-center gap-2 transition-all cursor-pointer ${
              viewMode === 'virtual_table'
                ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Music4 className="w-4 h-4 text-cyan-400" />
            <span>All Tracks (Data Table)</span>
          </button>

          <button
            onClick={() => onViewModeChange?.('variant_stack')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-semibold flex items-center gap-2 transition-all cursor-pointer ${
              viewMode === 'variant_stack'
                ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Disc3 className="w-4 h-4 text-[#ADFF2F]" />
            <span>Albums & Pressing Stacks</span>
          </button>

          <button
            onClick={() => onViewModeChange?.('work_movement')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-semibold flex items-center gap-2 transition-all cursor-pointer ${
              viewMode === 'work_movement'
                ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Layers className="w-4 h-4 text-[#8B5CF6]" />
            <span>Classical Works & Movements</span>
          </button>

          <button
            onClick={() => onViewModeChange?.('folder_tree')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-semibold flex items-center gap-2 transition-all cursor-pointer ${
              viewMode === 'folder_tree'
                ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <FolderTree className="w-4 h-4 text-amber-400" />
            <span>Physical Folder Tree</span>
          </button>

          <button
            onClick={onOpenStorageManager}
            className="w-full px-2.5 py-1.5 rounded-xl font-semibold flex items-center justify-between text-slate-400 hover:text-white hover:bg-white/[0.04] transition-all cursor-pointer"
            title="Manage Storage Mounts & Watched Folders"
          >
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-emerald-400" />
              <span>Watched Folders</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              {watchedFolders.length}
            </span>
          </button>
        </div>

        {/* 2. SMART CURATION VIEWS */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-500 font-bold px-2 py-1 tracking-wider">
            Smart Views
          </div>

          <button
            onClick={() => handleSmartViewClick('highres')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-medium flex items-center justify-between transition-all cursor-pointer ${
              activeSmartView === 'highres'
                ? 'bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30 font-semibold'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-[#00F5FF]" />
              <span>Audiophile High-Res</span>
            </div>
            <span className="text-[10px] font-mono text-cyan-400/80">24/96+</span>
          </button>

          <button
            onClick={() => handleSmartViewClick('dsd')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-medium flex items-center justify-between transition-all cursor-pointer ${
              activeSmartView === 'dsd'
                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <Flame className="w-3.5 h-3.5 text-amber-400" />
              <span>Direct Stream Digital</span>
            </div>
            <span className="text-[10px] font-mono text-amber-400/80">DSD</span>
          </button>

          <button
            onClick={() => handleSmartViewClick('dr')}
            className={`w-full px-2.5 py-1.5 rounded-xl font-medium flex items-center justify-between transition-all cursor-pointer ${
              activeSmartView === 'dr'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>High Dynamic Range</span>
            </div>
            <span className="text-[10px] font-mono text-emerald-400/80">DR12+</span>
          </button>
        </div>

        {/* 3. FACETED FILTERS (Narrowing the Current View) */}
        <div className="pt-2 border-t border-white/[0.06] space-y-2">
          <div
            onClick={() => setIsFiltersOpen((prev) => !prev)}
            className="flex items-center justify-between px-2 py-1 text-slate-400 hover:text-white cursor-pointer"
          >
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase font-bold tracking-wider">
              <SlidersHorizontal className="w-3 h-3 text-[#00F5FF]" />
              <span>Narrow by Facets</span>
            </div>
            {isFiltersOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </div>

          {isFiltersOpen && (
            <div className="p-1 rounded-xl bg-black/30 border border-white/[0.04]">
              <FacetedFilters
                facets={facets}
                onFacetChange={onFacetChange}
                onReset={onResetFacets}
                tracks={tracks}
                releases={releases}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer Stats */}
      <div className="pt-3 border-t border-white/10 text-[11px] font-mono text-slate-500 flex items-center justify-between px-1">
        <span>{releases.length} Releases</span>
        <span>{tracks.length} Tracks</span>
      </div>
    </aside>
  )
}
