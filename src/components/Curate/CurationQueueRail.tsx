/**
 * src/components/Curate/CurationQueueRail.tsx
 * Left Pane of Master-Detail Curation Workbench (280px)
 *
 * Hosts Album-Hierarchical queue cards with defect categorization badges,
 * active steppers, and keyboard shortcut navigation.
 */

import React, { useMemo } from 'react'
import {
  CheckCircle2,
  Disc,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { AlbumCurationQueueItem } from '../../services/curationQueueService'

export type CurationFilter = 'all' | 'soundtracks' | 'artwork' | 'staged'

export interface CurationQueueRailProps {
  queue: AlbumCurationQueueItem[]
  selectedAlbumId: string | null
  onSelectAlbum: (albumId: string) => void
  activeFilter: CurationFilter
  onFilterChange: (filter: CurationFilter) => void
}

export const CurationQueueRail: React.FC<CurationQueueRailProps> = ({
  queue,
  selectedAlbumId,
  onSelectAlbum,
  activeFilter,
  onFilterChange,
}) => {
  // Filter queue
  const filteredQueue = useMemo(() => {
    switch (activeFilter) {
      case 'soundtracks':
        return queue.filter((item) => item.primaryIssueType === 'compilation_conflict')
      case 'artwork':
        return queue.filter((item) => item.primaryIssueType === 'missing_artwork')
      case 'staged':
        return queue.filter((item) => item.isStaged)
      default:
        return queue
    }
  }, [queue, activeFilter])

  // Counts for filter pills
  const counts = useMemo(() => {
    return {
      all: queue.length,
      soundtracks: queue.filter((i) => i.primaryIssueType === 'compilation_conflict').length,
      artwork: queue.filter((i) => i.primaryIssueType === 'missing_artwork').length,
      staged: queue.filter((i) => i.isStaged).length,
    }
  }, [queue])

  const currentIndex = selectedAlbumId
    ? filteredQueue.findIndex((i) => i.albumId === selectedAlbumId)
    : -1

  const handlePrev = () => {
    if (currentIndex > 0) {
      onSelectAlbum(filteredQueue[currentIndex - 1].albumId)
    }
  }

  const handleNext = () => {
    if (currentIndex < filteredQueue.length - 1) {
      onSelectAlbum(filteredQueue[currentIndex + 1].albumId)
    }
  }

  return (
    <aside className="w-[280px] shrink-0 h-full flex flex-col border-r border-white/[0.08] bg-[#0E0F12] select-none text-xs">
      {/* 1. Header with Stepper & Item Counter */}
      <div className="p-3 border-b border-white/[0.06] space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-white tracking-wide">
            <Disc className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Curation Queue</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrev}
              disabled={currentIndex <= 0}
              title="Previous Album (⌘[)"
              className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent text-[#8E8E93] hover:text-white transition-all cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono text-[#A1A1AA] px-1">
              {currentIndex >= 0 ? `${currentIndex + 1}/${filteredQueue.length}` : `0/${filteredQueue.length}`}
            </span>
            <button
              onClick={handleNext}
              disabled={currentIndex < 0 || currentIndex >= filteredQueue.length - 1}
              title="Next Album (⌘])"
              className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent text-[#8E8E93] hover:text-white transition-all cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 2. Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 no-scrollbar text-[10px]">
          {(
            [
              { id: 'all', label: `All (${counts.all})` },
              { id: 'soundtracks', label: `Soundtracks (${counts.soundtracks})` },
              { id: 'artwork', label: `Artwork (${counts.artwork})` },
              { id: 'staged', label: `Staged (${counts.staged})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => onFilterChange(tab.id)}
              className={`px-2 py-0.5 rounded-full font-medium transition-all shrink-0 cursor-pointer ${
                activeFilter === tab.id
                  ? 'bg-white/[0.16] text-white shadow-sm'
                  : 'bg-white/[0.04] text-[#8E8E93] hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Queue Item Cards List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {filteredQueue.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center text-[#8E8E93]">
            <CheckCircle2 className="w-8 h-8 text-[#10B981] mb-2 opacity-80" />
            <span className="font-medium text-white text-xs">No Pending Items</span>
            <span className="text-[11px] text-[#636366] mt-1">
              All items in this filter conform to hygiene standards.
            </span>
          </div>
        ) : (
          filteredQueue.map((item) => {
            const isSelected = selectedAlbumId === item.albumId

            return (
              <button
                key={item.albumId}
                onClick={() => onSelectAlbum(item.albumId)}
                className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer flex gap-2.5 items-start ${
                  isSelected
                    ? 'bg-white/[0.1] border-[#D4AF37]/50 shadow-md ring-1 ring-[#D4AF37]/20 text-white'
                    : 'bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.06] hover:border-white/[0.08] text-[#D1D1D6]'
                }`}
              >
                {/* Thumbnail / Fallback */}
                <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-neutral-900 border border-white/10 relative">
                  {item.coverArtUrl ? (
                    <img
                      src={item.coverArtUrl}
                      alt={item.albumTitle}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[#636366]">
                      <Disc className="w-5 h-5 opacity-40" />
                    </div>
                  )}
                  {item.isStaged && (
                    <div className="absolute bottom-0 right-0 p-0.5 bg-black/60 backdrop-blur-sm rounded-tl">
                      <CheckCircle2 className="w-3 h-3 text-[#10B981]" />
                    </div>
                  )}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-xs truncate leading-snug">
                      {item.albumTitle}
                    </span>
                  </div>

                  <span className="text-[11px] text-[#8E8E93] truncate block mt-0.5">
                    {item.artistCredit}
                  </span>

                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-medium ${
                        item.defectSeverity === 'critical'
                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/20'
                          : item.defectSeverity === 'high'
                          ? 'bg-amber-500/15 text-amber-300 border border-amber-500/20'
                          : 'bg-blue-500/15 text-blue-300 border border-blue-500/20'
                      }`}
                    >
                      {item.issueBadgeLabel}
                    </span>

                    <span className="text-[10px] font-mono text-[#636366]">
                      {item.affectedTrackCount}/{item.totalTracks} trk
                    </span>
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </aside>
  )
}
