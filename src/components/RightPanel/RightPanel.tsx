import React, { useState } from 'react'
import {
  Users2,
  Sparkles,
  Image,
  Activity,
  Maximize2,
  Disc3,
  X,
} from 'lucide-react'
import { Track, Release, Credit } from '../../core/types'
import { GranularCreditMatrix } from './GranularCreditMatrix'
import { SideBySideDiff } from './SideBySideDiff'
import { ArtworkMediaTray } from './ArtworkMediaTray'
import { IntegrityCard } from './IntegrityCard'

export type RightPanelTab = 'credits' | 'diff' | 'artwork' | 'integrity'

interface RightPanelProps {
  track?: Track
  release?: Release
  allReleases?: Release[]
  selectedTrackIds?: Set<string>
  onOpenBatchDiff?: () => void
  onOpenBatchAi?: () => void
  onAddCredit: (credit: Credit) => void
  onApplyMerge: (mergedFields: Record<string, string>) => void
  onReverifyChecksum: (trackId: string) => void
  activeTab?: RightPanelTab
  onTabChange?: (tab: RightPanelTab) => void
  onOpenFocusedWorkbench?: (track: Track, release?: Release) => void
  onClose?: () => void
}

export const RightPanel: React.FC<RightPanelProps> = ({
  track,
  release,
  allReleases = [],
  selectedTrackIds,
  onOpenBatchDiff,
  onOpenBatchAi,
  onAddCredit,
  onApplyMerge,
  onReverifyChecksum,
  activeTab: controlledTab,
  onTabChange,
  onOpenFocusedWorkbench,
  onClose,
}) => {
  const [internalTab, setInternalTab] = useState<RightPanelTab>('credits')
  const activeTab = controlledTab ?? internalTab
  const setActiveTab = (tab: RightPanelTab) => {
    setInternalTab(tab)
    onTabChange?.(tab)
  }

  if (!track || !release) {
    return (
      <aside className="w-[340px] shrink-0 h-full border-l border-white/[0.06] bg-[#0C0D10]/95 flex flex-col items-center justify-center p-6 text-center text-[#636366]">
        <Users2 className="w-10 h-10 mb-3 stroke-[1.2] opacity-30" />
        <span className="text-sm font-semibold text-[#8E8E93]">No Selection</span>
        <span className="text-xs text-[#636366] mt-1">
          Select an album or track to inspect its metadata, credits, and audio integrity.
        </span>
      </aside>
    )
  }

  const isMultiSelect = Boolean(selectedTrackIds && selectedTrackIds.size > 1)

  return (
    <aside className="w-[360px] shrink-0 h-full border-l border-white/[0.06] bg-[#0C0D10]/95 backdrop-blur-2xl flex flex-col overflow-hidden select-none">
      {/* Multi-Track Selection Banner */}
      {isMultiSelect && (
        <div className="px-3 py-2 bg-white/[0.04] border-b border-white/[0.06] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 truncate">
            <Sparkles className="w-4 h-4 text-[#D4AF37] shrink-0" />
            <div className="flex flex-col text-left truncate">
              <span className="text-[11px] font-semibold text-white font-mono truncate">
                {selectedTrackIds?.size} Tracks Selected
              </span>
              <span className="text-[9px] text-[#8E8E93] truncate">
                Multi-track batch actions active
              </span>
            </div>
          </div>
          {(onOpenBatchDiff || onOpenBatchAi) && (
            <button
              onClick={onOpenBatchDiff || onOpenBatchAi}
              className="px-2.5 py-1 rounded-md bg-white hover:bg-white/90 text-black font-mono font-semibold text-[10px] transition-all flex items-center gap-1 shadow-sm cursor-pointer shrink-0"
              title="Open Batch Harmonizer Matrix for all selected tracks"
            >
              <Sparkles className="w-3 h-3 text-black" />
              <span>Batch Enrich</span>
            </button>
          )}
        </div>
      )}

      {/* Contextual Entity Banner with Close and Workbench Buttons */}
      <div className="px-3 py-2.5 bg-[#121316] border-b border-white/[0.05] flex items-center justify-between gap-2 shrink-0 text-xs">
        <div className="flex items-center gap-2.5 truncate min-w-0">
          <div className="w-8 h-8 rounded-md bg-black/40 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
            {release?.coverArtUrl ? (
              <img src={release.coverArtUrl} alt={release.title} className="w-full h-full object-cover" />
            ) : (
              <Disc3 className="w-4 h-4 text-[#8E8E93]" />
            )}
          </div>
          <div className="truncate">
            <div className="font-semibold text-white text-[12px] truncate">{track.title}</div>
            <div className="text-[10px] text-[#8E8E93] truncate">{release.title} ({release.releaseYear || 'Unknown'})</div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onOpenFocusedWorkbench && (
            <button
              onClick={() => onOpenFocusedWorkbench(track, release)}
              title="Expand to Full-Stage Curate Workbench (⌘E)"
              className="px-2 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[#D4AF37] text-[10px] font-mono flex items-center gap-1 transition-all cursor-pointer border border-white/[0.06]"
            >
              <Maximize2 className="w-3 h-3" />
              <span>Full Workbench</span>
            </button>
          )}

          {onClose && (
            <button
              onClick={onClose}
              title="Close Inspector (⌘I)"
              className="p-1 rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Tab Navigation: Apple Segmented Pill Style */}
      <div className="grid grid-cols-4 p-1.5 bg-[#0C0D10] border-b border-white/[0.05] gap-1 shrink-0">
        <button
          data-tutorial-id="right-panel-tab-credits"
          data-testid="right-panel-tab-credits"
          onClick={() => setActiveTab('credits')}
          className={`flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-mono transition-all cursor-pointer ${
            activeTab === 'credits'
              ? 'bg-white/[0.1] text-white font-medium shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/[0.03]'
          }`}
        >
          <Users2 className="w-3 h-3" />
          <span>Credits</span>
        </button>

        <button
          data-tutorial-id="right-panel-tab-diff"
          data-testid="right-panel-tab-diff"
          onClick={() => setActiveTab('diff')}
          className={`flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-mono transition-all cursor-pointer ${
            activeTab === 'diff'
              ? 'bg-white/[0.1] text-white font-medium shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/[0.03]'
          }`}
          title="Smart Match: Compare local tags against Apple Music, MusicBrainz, and Gemini AI"
        >
          <Sparkles className="w-3 h-3 text-[#D4AF37]" />
          <span>Match</span>
        </button>

        <button
          data-tutorial-id="right-panel-tab-media"
          data-testid="right-panel-tab-media"
          onClick={() => setActiveTab('artwork')}
          className={`flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-mono transition-all cursor-pointer ${
            activeTab === 'artwork'
              ? 'bg-white/[0.1] text-white font-medium shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/[0.03]'
          }`}
        >
          <Image className="w-3 h-3" />
          <span>Media</span>
        </button>

        <button
          data-tutorial-id="right-panel-tab-integrity"
          data-testid="right-panel-tab-integrity"
          onClick={() => setActiveTab('integrity')}
          className={`flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-mono transition-all cursor-pointer ${
            activeTab === 'integrity'
              ? 'bg-white/[0.1] text-white font-medium shadow-sm'
              : 'text-[#8E8E93] hover:text-white hover:bg-white/[0.03]'
          }`}
        >
          <Activity className="w-3 h-3" />
          <span>Stream</span>
        </button>
      </div>

      {/* Tab Panels */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'credits' && (
          <GranularCreditMatrix track={track} onAddCredit={onAddCredit} />
        )}

        {activeTab === 'diff' && (
          <SideBySideDiff
            currentData={{
              trackTitle: track.title,
              releaseTitle: release.title,
              title: track.title,
              artist: track.artistCredit,
              composer: track.composerName || '',
              year: String(release.releaseYear),
              catalogNo: release.catalogNumber,
              label: release.label,
              barcode: release.barcodeUpc || '',
              matrix: release.matrixRunout,
              artResolution: release.artwork.resolution,
            }}
            track={track}
            release={release}
            allReleases={allReleases}
            selectedTrackIds={selectedTrackIds}
            onOpenBatchDiff={onOpenBatchDiff}
            onOpenBatchAi={onOpenBatchAi}
            onApplyMerge={onApplyMerge}
          />
        )}

        {activeTab === 'artwork' && <ArtworkMediaTray release={release} />}

        {activeTab === 'integrity' && (
          <IntegrityCard track={track} onReverifyChecksum={onReverifyChecksum} />
        )}
      </div>
    </aside>
  )
}
