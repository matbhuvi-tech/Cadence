import React, { useState } from 'react'
import {
  Layers,
  Table,
  FolderTree,
  Search,
  Sparkles,
  ShieldCheck,
  HardDrive,
  Cpu,
  Wand2,
  FileCode,
  FolderPlus,
  Upload,
  RotateCcw,
  Folder,
  Music,
  ShieldAlert,
  X,
  ChevronsDown,
  ChevronsUp,
  LayoutGrid,
} from 'lucide-react'
import { Work, Track, Release, AlbumDisplayMode, AuditIssue, CanvasViewMode } from '../../core/types'
import { AlbumCoverGrid } from './AlbumCoverGrid'
import { WorkMovementView } from './WorkMovementView'
import { VariantStackCard } from './VariantStackCard'
import { VirtualDataTable } from './VirtualDataTable'
import { SpreadsheetMultiEdit } from './SpreadsheetMultiEdit'
import { FolderTreeExplorer } from './FolderTreeExplorer'

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

  onTriggerTwoPhaseCommit: () => void
  onOpenBatchRuleModal: () => void
  onOpenImportModal: () => void
  onOpenBatchDiff?: () => void
  onOpenBatchAi?: () => void
  totalLibraryTracksCount?: number
  onResetFilters?: () => void

  activeTriageIssue?: AuditIssue
  onClearTriageFilter?: () => void
  onRemediateTriageIssue?: (issueId: string) => void
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
  onTriggerTwoPhaseCommit,
  onOpenBatchRuleModal,
  onOpenImportModal,
  onOpenBatchDiff,
  onOpenBatchAi,
  totalLibraryTracksCount = 0,
  onResetFilters,
  activeTriageIssue,
  onClearTriageFilter,
  onRemediateTriageIssue,
}) => {
  const [isMultiEditOpen, setIsMultiEditOpen] = useState(false)
  const [expandedReleaseIds, setExpandedReleaseIds] = useState<Set<string>>(new Set())
  const isAllExpanded = releases.length > 0 && releases.every((r) => expandedReleaseIds.has(r.id))

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

  const handleToggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedReleaseIds(new Set())
    } else {
      setExpandedReleaseIds(new Set(releases.map((r) => r.id)))
    }
  }

  const selectedTracksList = tracks.filter((t) => selectedTrackIds.has(t.id))
  const uncommittedTracks = tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar')

  return (
    <main className="flex-1 min-h-0 flex flex-col h-full overflow-hidden bg-[#0D0E12]">
      {/* Invisible/Glassmorphic Header & Toolbar */}
      <header className="px-6 py-3 border-b border-white/[0.07] bg-[#12151D]/60 backdrop-blur-xl flex items-center justify-between gap-4 shrink-0">
        {/* Left: View Switcher */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-white/[0.04] border border-white/[0.06]">
          <button
            data-tutorial-id="btn-view-cover-grid"
            onClick={() => onViewModeChange('cover_grid')}
            title="Rich visual Cover-Art album grid (Mockup style)"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'cover_grid'
                ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Cover Grid</span>
          </button>

          <button
            data-tutorial-id="btn-view-work-movement"
            onClick={() => onViewModeChange('work_movement')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'work_movement'
                ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5" />
            <span>Classical Works & Movements</span>
          </button>

          <button
            data-tutorial-id="btn-view-variant-stacks"
            onClick={() => onViewModeChange('variant_stack')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'variant_stack'
                ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Variant Stacks</span>
          </button>

          <button
            data-tutorial-id="btn-view-virtual-grid"
            onClick={() => onViewModeChange('virtual_table')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'virtual_table'
                ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Table className="w-3.5 h-3.5" />
            <span>Virtual Grid</span>
          </button>

          <button
            onClick={() => onViewModeChange('folder_tree')}
            title="Browse physical 1:1 on-disk directory hierarchy"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'folder_tree'
                ? 'bg-[#00F5FF] text-black font-semibold shadow-sm'
                : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Folder className="w-3.5 h-3.5" />
            <span>Folder Tree</span>
          </button>
        </div>

        {/* Center: Search / Filter input */}
        <div className="flex-1 max-w-md relative">
          <Search className="w-4 h-4 text-white/30 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            data-tutorial-id="canvas-search-input"
            type="text"
            placeholder="Filter by composer, opus, key, matrix runout, variant..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-4 py-1.5 rounded-xl bg-white/[0.03] border border-white/[0.08] text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#00F5FF]/50 transition-all"
          />
        </div>

        {/* Right: Operational Tool Triggers */}
        <div className="flex items-center gap-2">
          {/* Display Mode Toggle */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.06]">
            <button
              data-tutorial-id="btn-display-album-first"
              onClick={() => onAlbumDisplayModeChange?.('album_first')}
              title="Show Metadata Album Name prominently, Physical Folder as subtitle badge"
              className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                albumDisplayMode === 'album_first'
                  ? 'bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/40 font-bold'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              <Music className="w-3 h-3 text-[#ADFF2F]" />
              <span className="hidden xl:inline">Album First</span>
            </button>

            <button
              data-tutorial-id="btn-display-folder-first"
              onClick={() => onAlbumDisplayModeChange?.('folder_first')}
              title="Show Physical Folder Name prominently, Metadata Album as subtitle tag"
              className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                albumDisplayMode === 'folder_first'
                  ? 'bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/40 font-bold'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              <Folder className="w-3 h-3 text-[#38BDF8]" />
              <span className="hidden xl:inline">Folder First</span>
            </button>
          </div>

          {/* Variant Stack Expand/Collapse All Action */}
          {viewMode === 'variant_stack' && (
            <button
              onClick={handleToggleExpandAll}
              className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-mono text-[#CBD5E1] hover:text-[#00F5FF] transition-all flex items-center gap-1.5 cursor-pointer"
              title={isAllExpanded ? 'Collapse all variant cards to compact summary rows' : 'Expand all variant cards to full master cockpits'}
            >
              {isAllExpanded ? (
                <>
                  <ChevronsUp className="w-3.5 h-3.5 text-[#00F5FF]" />
                  <span className="hidden xl:inline">Collapse All</span>
                </>
              ) : (
                <>
                  <ChevronsDown className="w-3.5 h-3.5 text-[#00F5FF]" />
                  <span className="hidden xl:inline">Expand All</span>
                </>
              )}
            </button>
          )}

          {/* Path Templating Action */}
          <button
            data-tutorial-id="btn-toolbar-path-rules"
            onClick={onOpenBatchRuleModal}
            className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-mono text-[#CBD5E1] hover:text-[#00F5FF] transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <Wand2 className="w-3.5 h-3.5 text-[#ADFF2F]" />
            <span>Path Rules</span>
          </button>

          {/* Staged for Commit Trigger */}
          <button
            data-tutorial-id="btn-toolbar-staged-commit"
            onClick={onTriggerTwoPhaseCommit}
            disabled={uncommittedTracks.length === 0}
            className="px-3.5 py-1.5 rounded-lg bg-[#10B981]/20 hover:bg-[#10B981]/30 border border-[#10B981]/40 text-xs font-semibold text-[#10B981] transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title="Preview and commit staged sidecar edits into audio file headers"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Staged for Commit ({uncommittedTracks.length})</span>
          </button>
        </div>
      </header>

      {/* Active Triage Anomaly Banner */}
      {activeTriageIssue && (
        <div
          data-testid="active-triage-banner"
          className="px-6 py-2 bg-gradient-to-r from-[#F59E0B]/15 via-[#12151D] to-[#12151D] border-b border-[#F59E0B]/30 flex items-center justify-between gap-4 text-xs shrink-0"
        >
          <div className="flex items-center gap-2.5">
            <div className="p-1 rounded bg-[#F59E0B]/20 text-[#F59E0B]">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div className="flex items-center flex-wrap gap-x-2">
              <span className="font-bold text-white">{activeTriageIssue.title}</span>
              <span className="text-[#00F5FF] font-mono text-[11px] font-semibold">
                &bull; {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} isolated
              </span>
              <span className="text-[#94A3B8] text-[11px] hidden lg:inline">
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
                  title={activeTriageIssue.suggestedFix || "Apply 1-Click Auto Fix to all isolated tracks"}
                  className="px-3 py-1 rounded-lg bg-[#00F5FF]/20 text-[#00F5FF] hover:bg-[#00F5FF]/30 border border-[#00F5FF]/40 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{activeTriageIssue.fixActionLabel || 'Auto-Fix'}</span>
                </button>
            )}
            {activeTriageIssue.affectedCount > 0 &&
              (activeTriageIssue.isAutoFixable === false || !activeTriageIssue.autoFixAction) && (
                <div
                  className="px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-[11px] text-[#94A3B8] flex items-center gap-1.5"
                  title={activeTriageIssue.manualActionHint}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" />
                  <span>Manual Triage Required</span>
                </div>
            )}
            {onClearTriageFilter && (
              <button
                onClick={onClearTriageFilter}
                title="Clear Triage Filter & Return to Full Grid View"
                className="p-1 rounded text-[#94A3B8] hover:text-white hover:bg-white/[0.06] transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Canvas Workspace */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {tracks.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center p-8 text-center select-none overflow-y-auto">
            <div className="max-w-xl w-full flex flex-col items-center bg-[#12151D]/60 border border-white/[0.08] rounded-2xl p-10 backdrop-blur-xl shadow-2xl relative overflow-hidden">
              {/* Background ambient glow */}
              <div className="absolute -top-24 -left-24 w-64 h-64 bg-[#00F5FF]/10 rounded-full blur-3xl pointer-events-none" />
              <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-[#ADFF2F]/10 rounded-full blur-3xl pointer-events-none" />

              {totalLibraryTracksCount > 0 ? (
                <>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[10px] font-mono tracking-widest text-[#F59E0B] uppercase mb-6">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] animate-pulse" />
                    Filtered View &bull; 0 Matching Tracks
                  </div>

                  <h2 className="text-xl font-bold text-white tracking-tight mb-2">
                    No Tracks Match Current Filter
                  </h2>
                  <p className="text-xs text-[#94A3B8] leading-relaxed max-w-md mb-8">
                    Your collection contains {totalLibraryTracksCount} audio tracks across {releases.length} albums, but none match the currently active search query, storage mount, or taxonomy filter.
                  </p>

                  {onResetFilters && (
                    <button
                      onClick={onResetFilters}
                      className="px-6 py-2.5 rounded-xl bg-[#00F5FF] hover:bg-[#33F7FF] text-black font-semibold text-xs shadow-xl shadow-[#00F5FF]/20 transition-all flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Clear All Filters & Show Full Collection</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  {/* Status pill */}
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.1] text-[10px] font-mono tracking-widest text-[#00F5FF] uppercase mb-6">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00F5FF] animate-pulse" />
                    Library Empty &bull; Clean Ingestion Engine
                  </div>

                  {/* Large Icon Box */}
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#00F5FF]/20 to-[#ADFF2F]/10 border border-[#00F5FF]/30 flex items-center justify-center mb-6 shadow-lg shadow-[#00F5FF]/5 group">
                    <FolderPlus className="w-10 h-10 text-[#00F5FF] group-hover:scale-110 transition-transform duration-300" />
                  </div>

                  {/* Title & Description */}
                  <h2 className="text-xl font-bold text-white tracking-tight mb-2">
                    No Music Ingested Yet
                  </h2>
                  <p className="text-xs text-[#94A3B8] leading-relaxed max-w-md mb-8">
                    Connect your local high-resolution audio directory to parse DSD (up to DSD1024), FLAC, ALAC, and WAV files with bit-accurate metadata, DR metering, and sidecar safety.
                  </p>

                  {/* Main Action Trigger */}
                  <button
                    onClick={onOpenImportModal}
                    className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-gradient-to-r from-[#00F5FF] to-[#00C2FF] hover:from-[#33F7FF] hover:to-[#1AD1FF] text-black font-semibold text-sm shadow-xl shadow-[#00F5FF]/20 transition-all flex items-center justify-center gap-3 active:scale-[0.98]"
                  >
                    <FolderPlus className="w-5 h-5 text-black" />
                    <span>Import Music Folder</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/20 text-black/80">⌘O</span>
                  </button>
                </>
              )}

              {/* Supported Tech Badges */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-8 w-full pt-8 border-t border-white/[0.06] text-[11px] font-mono text-[#64748B]">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#ADFF2F]" />
                  <span>DSD64 &ndash; DSD1024</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#00F5FF]" />
                  <span>Real DR Metering</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" />
                  <span>Safe Staged Commits</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6]" />
                  <span>Work / Movement Graph</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#EC4899]" />
                  <span>Variant Pressing Stacks</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                  <span>Stream MD5 Verification</span>
                </div>
              </div>
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
