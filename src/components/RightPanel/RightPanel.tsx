import React, { useState } from 'react'
import {
  Users2,
  Sparkles,
  Image,
  Activity,
  Maximize2,
  FileCode,
  ShieldAlert,
  Disc3,
  Layers,
  AlertTriangle,
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
}) => {
  const [internalTab, setInternalTab] = useState<RightPanelTab>('credits')
  const activeTab = controlledTab ?? internalTab
  const setActiveTab = (tab: RightPanelTab) => {
    setInternalTab(tab)
    onTabChange?.(tab)
  }

  if (!track || !release) {
    return (
      <aside className="w-[360px] shrink-0 h-full border-l border-white/[0.07] bg-[#0D0E12]/80 flex flex-col items-center justify-center p-6 text-center text-[#64748B]">
        <Users2 className="w-12 h-12 mb-3 stroke-[1.2] opacity-30" />
        <span className="text-sm font-semibold text-[#94A3B8]">No Selection</span>
        <span className="text-xs text-[#64748B] mt-1">
          Select a track, work, or master release to inspect its relational graph.
        </span>
      </aside>
    )
  }

  const isMultiSelect = Boolean(selectedTrackIds && selectedTrackIds.size > 1)

  return (
    <aside className="w-[380px] shrink-0 h-full border-l border-white/[0.07] bg-[#0D0E12]/90 flex flex-col overflow-hidden select-none">
      {/* Multi-Track Selection Banner */}
      {isMultiSelect && (
        <div className="px-3 py-2 bg-gradient-to-r from-[#8B5CF6]/25 via-[#00F5FF]/15 to-[#ADFF2F]/15 border-b border-[#00F5FF]/30 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 truncate">
            <Sparkles className="w-4 h-4 text-[#ADFF2F] shrink-0" />
            <div className="flex flex-col text-left truncate">
              <span className="text-[11px] font-bold text-white font-mono truncate">
                {selectedTrackIds?.size} Tracks Selected
              </span>
              <span className="text-[9px] text-[#94A3B8] truncate">
                Multi-track batch actions active
              </span>
            </div>
          </div>
          {(onOpenBatchDiff || onOpenBatchAi) && (
            <button
              onClick={onOpenBatchDiff || onOpenBatchAi}
              className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-[#00F5FF] to-[#ADFF2F] text-black font-mono font-bold text-[10px] hover:brightness-110 transition-all flex items-center gap-1 shadow-md shadow-[#00F5FF]/20 cursor-pointer shrink-0"
              title="Open Batch Harmonizer Matrix for all selected tracks"
            >
              <Sparkles className="w-3 h-3 text-black" />
              <span>Batch Enrich</span>
            </button>
          )}
        </div>
      )}

      {/* Contextual Entity Banner with Expand to Workbench Action */}
      <div className="px-3 py-2 bg-[#0E1118] border-b border-white/[0.06] flex items-center justify-between gap-2 shrink-0 text-xs">
        <div className="flex items-center gap-2 truncate">
          <div className="w-8 h-8 rounded-lg bg-black/40 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
            {release?.coverArtUrl ? (
              <img src={release.coverArtUrl} alt={release.title} className="w-full h-full object-cover" />
            ) : (
              <Disc3 className="w-4 h-4 text-cyan-400" />
            )}
          </div>
          <div className="truncate">
            <div className="font-bold text-white text-[11px] truncate">{track.title}</div>
            <div className="text-[10px] text-slate-400 truncate">{release.title} ({release.releaseYear || 'Unknown'})</div>
          </div>
        </div>

        {onOpenFocusedWorkbench && (
          <button
            onClick={() => onOpenFocusedWorkbench(track, release)}
            title="Expand to Full-Width Center Stage Workbench (⛶)"
            className="px-2 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-[10px] font-mono flex items-center gap-1 transition-all cursor-pointer shrink-0"
          >
            <Maximize2 className="w-3 h-3" />
            <span>Workbench</span>
          </button>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="grid grid-cols-4 p-2 bg-[#12151D] border-b border-white/[0.07] gap-1 shrink-0">
        <button
          data-tutorial-id="right-panel-tab-credits"
          data-testid="right-panel-tab-credits"
          onClick={() => setActiveTab('credits')}
          className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-mono transition-all ${
            activeTab === 'credits'
              ? 'bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/40 font-bold'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Users2 className="w-3.5 h-3.5" />
          <span>Credits</span>
        </button>

        <button
          data-tutorial-id="right-panel-tab-diff"
          data-testid="right-panel-tab-diff"
          onClick={() => setActiveTab('diff')}
          className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-mono transition-all ${
            activeTab === 'diff'
              ? 'bg-[#ADFF2F]/15 text-[#ADFF2F] border border-[#ADFF2F]/40 font-bold'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
          title="Smart Match: Compare local tags against Apple Music, MusicBrainz, and Gemini AI"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Smart Match</span>
        </button>

        <button
          data-tutorial-id="right-panel-tab-media"
          data-testid="right-panel-tab-media"
          onClick={() => setActiveTab('artwork')}
          className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-mono transition-all ${
            activeTab === 'artwork'
              ? 'bg-[#EC4899]/15 text-[#EC4899] border border-[#EC4899]/40 font-bold'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Image className="w-3.5 h-3.5" />
          <span>Media</span>
        </button>

        <button
          data-tutorial-id="right-panel-tab-integrity"
          data-testid="right-panel-tab-integrity"
          onClick={() => setActiveTab('integrity')}
          className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-mono transition-all ${
            activeTab === 'integrity'
              ? 'bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/40 font-bold'
              : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Stream</span>
        </button>
      </div>

      {/* Sticky Active Target Banner */}
      <div className="px-3.5 py-2.5 bg-[#141824] border-b border-white/[0.08] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5 truncate min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[#00F5FF]/10 border border-[#00F5FF]/30 flex items-center justify-center shrink-0 text-[#00F5FF]">
            <Disc3 className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col truncate min-w-0 text-left">
            <div className="flex items-center gap-1.5 truncate">
              <span className="text-[11px] font-bold text-white truncate font-mono">
                {track.trackNumber ? `#${String(track.trackNumber).padStart(2, '0')} ` : ''}{track.title}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-[#94A3B8] truncate">
              <span className="truncate">{release.title}</span>
              {release.folderName && (
                <span
                  className="text-[9px] px-1.5 py-0.2 rounded bg-[#00F5FF]/10 text-[#00F5FF] font-mono shrink-0 truncate max-w-[130px] border border-[#00F5FF]/20"
                  title={`Physical Folder: ${release.folderName}`}
                >
                  📁 {release.folderName}
                </span>
              )}
            </div>
          </div>
        </div>
        <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#ADFF2F]/15 text-[#ADFF2F] border border-[#ADFF2F]/30 uppercase shrink-0">
          Inspecting
        </span>
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
