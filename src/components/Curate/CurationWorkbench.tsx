/**
 * src/components/Curate/CurationWorkbench.tsx
 * Container Component for Curate Mode (⌘2)
 *
 * Combines CurationQueueRail (280px) and CurationReconciliationStage into
 * a master-detail curation workbench. Manages active queue selection,
 * keyboard shortcuts (⌘[, ⌘], Esc, ⌘4), and staging to graphEngine.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { CheckCircle2, Disc, ArrowLeft } from 'lucide-react'
import { Track, Release, AuditIssue } from '../../core/types'
import { graphEngine } from '../../core/graphEngine'
import {
  curationQueueService,
  AlbumCurationQueueItem,
} from '../../services/curationQueueService'
import { CurationQueueRail, CurationFilter } from './CurationQueueRail'
import { CurationReconciliationStage } from './CurationReconciliationStage'

export interface CurationWorkbenchProps {
  tracks: Track[]
  releases: Release[]
  auditIssues?: AuditIssue[]
  initialSelectedAlbumId?: string | null
  onOpenCommitModal: () => void
  onBackToLibrary: () => void
  showToast: (msg: string) => void
  onRefreshLibrary?: () => void
}

export const CurationWorkbench: React.FC<CurationWorkbenchProps> = ({
  tracks,
  releases,
  auditIssues = [],
  initialSelectedAlbumId,
  onOpenCommitModal,
  onBackToLibrary,
  showToast,
  onRefreshLibrary,
}) => {
  // 1. Compute dynamic Curation Queue (<10ms)
  const queue = useMemo(() => {
    return curationQueueService.computeCurationQueue(tracks, releases, auditIssues)
  }, [tracks, releases, auditIssues])

  // 2. Active filter state
  const [activeFilter, setActiveFilter] = useState<CurationFilter>('all')

  // Filtered queue items
  const filteredQueue: AlbumCurationQueueItem[] = useMemo(() => {
    switch (activeFilter) {
      case 'soundtracks':
        return queue.filter((item: AlbumCurationQueueItem) => item.primaryIssueType === 'compilation_conflict')
      case 'artwork':
        return queue.filter((item: AlbumCurationQueueItem) => item.primaryIssueType === 'missing_artwork')
      case 'staged':
        return queue.filter((item: AlbumCurationQueueItem) => item.isStaged)
      default:
        return queue
    }
  }, [queue, activeFilter])

  // 3. Selected Album ID
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(() => {
    const initialItem = curationQueueService.resolveCurateInitialAlbum(queue, initialSelectedAlbumId || undefined)
    return initialItem?.albumId || null
  })

  const [isQueueCleared, setIsQueueCleared] = useState(false)

  // Sync selection if current selected album drops out of queue
  useEffect(() => {
    if (filteredQueue.length > 0) {
      if (!selectedAlbumId || !filteredQueue.some((i: AlbumCurationQueueItem) => i.albumId === selectedAlbumId)) {
        setSelectedAlbumId(filteredQueue[0].albumId)
        setIsQueueCleared(false)
      }
    } else {
      setSelectedAlbumId(null)
    }
  }, [filteredQueue, selectedAlbumId])

  // Current queue item & details
  const currentItemIndex = useMemo(() => {
    if (!selectedAlbumId) return -1
    return filteredQueue.findIndex((i: AlbumCurationQueueItem) => i.albumId === selectedAlbumId)
  }, [filteredQueue, selectedAlbumId])

  const currentItem = useMemo(() => {
    if (currentItemIndex >= 0 && currentItemIndex < filteredQueue.length) {
      return filteredQueue[currentItemIndex]
    }
    return null
  }, [filteredQueue, currentItemIndex])

  // Tracks for the currently selected album
  const currentAlbumTracks = useMemo(() => {
    if (!currentItem) return []
    return tracks.filter(
      (t) =>
        t.releaseId === currentItem.albumId ||
        (t.canonicalAlbumTitle && t.canonicalAlbumTitle.toLowerCase().trim() === currentItem.albumTitle.toLowerCase().trim()) ||
        (t.albumTitle && t.albumTitle.toLowerCase().trim() === currentItem.albumTitle.toLowerCase().trim())
    )
  }, [tracks, currentItem])

  const currentRelease = useMemo(() => {
    if (!currentItem) return undefined
    return releases.find((r) => r.id === currentItem.albumId)
  }, [releases, currentItem])

  // Navigation handlers
  const handlePrev = useCallback(() => {
    if (currentItemIndex > 0) {
      setSelectedAlbumId(filteredQueue[currentItemIndex - 1].albumId)
      setIsQueueCleared(false)
    }
  }, [currentItemIndex, filteredQueue])

  const handleNext = useCallback(() => {
    if (currentItemIndex >= 0 && currentItemIndex < filteredQueue.length - 1) {
      setSelectedAlbumId(filteredQueue[currentItemIndex + 1].albumId)
      setIsQueueCleared(false)
    } else if (currentItemIndex === filteredQueue.length - 1) {
      setIsQueueCleared(true)
    }
  }, [currentItemIndex, filteredQueue])

  // Staging handler: applies edits to graphEngine and advances queue
  const handleStageAndNext = useCallback(
    (stagedEditsMap: Map<string, Partial<Track>>) => {
      stagedEditsMap.forEach((edits, trackId) => {
        graphEngine.updateTrackSidecar(trackId, edits)
      })

      onRefreshLibrary?.()

      // Advance to next album or display cleared screen
      handleNext()
    },
    [handleNext, onRefreshLibrary]
  )

  // Global Keyboard shortcuts for Curate Workbench
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘[ for Previous
      if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.code === 'BracketLeft')) {
        e.preventDefault()
        handlePrev()
      }
      // ⌘] for Next
      else if ((e.metaKey || e.ctrlKey) && (e.key === ']' || e.code === 'BracketRight')) {
        e.preventDefault()
        handleNext()
      }
      // ⌘4 for Commit Modal
      else if ((e.metaKey || e.ctrlKey) && e.key === '4') {
        e.preventDefault()
        onOpenCommitModal()
      }
      // Esc to return to library
      else if (e.key === 'Escape') {
        onBackToLibrary()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext, onOpenCommitModal, onBackToLibrary])

  // Global Empty State (No hygiene issues anywhere in catalog)
  if (queue.length === 0) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center p-8 bg-[#0B0D13] text-center select-none">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4 shadow-xl shadow-emerald-500/10">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Catalog Fully Curated</h2>
        <p className="text-sm text-[#8E8E93] max-w-md mt-1 mb-6 leading-relaxed">
          All catalog items conform to bit-perfect hygiene standards. No compilation conflicts,
          missing cover art, or untagged albums detected.
        </p>

        <button
          onClick={onBackToLibrary}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-white font-medium text-xs border border-white/[0.08] transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Library (⌘1)</span>
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 h-full flex overflow-hidden bg-[#0B0D13]">
      {/* Left Pane: 280px Fixed-Width Curation Queue Rail */}
      <CurationQueueRail
        queue={queue}
        selectedAlbumId={selectedAlbumId}
        onSelectAlbum={(id) => {
          setSelectedAlbumId(id)
          setIsQueueCleared(false)
        }}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />

      {/* Center-Right Pane: Reconciliation Canvas */}
      <CurationReconciliationStage
        albumItem={currentItem}
        release={currentRelease}
        tracks={currentAlbumTracks}
        allReleases={releases}
        currentIndex={currentItemIndex >= 0 ? currentItemIndex : 0}
        totalCount={filteredQueue.length}
        onPrev={handlePrev}
        onNext={handleNext}
        onStageAndNext={handleStageAndNext}
        onOpenCommitModal={onOpenCommitModal}
        onBackToLibrary={onBackToLibrary}
        showToast={showToast}
        isQueueCleared={isQueueCleared}
      />
    </div>
  )
}
