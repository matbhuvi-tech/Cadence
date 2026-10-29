import React, { useState, useEffect, useRef } from 'react'
import {
  ListMusic,
  Disc3,
  X,
  Play,
  Shuffle,
  Trash2,
  GripVertical,
  ArrowUpToLine,
  ChevronUp,
  ChevronDown,
  Plus,
  Edit3,
  BookmarkPlus,
  MoreVertical,
  Music2,
} from 'lucide-react'
import { Track, Playlist } from '../../core/types'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'

interface UnifiedRightSidebarProps {
  onOpenCreatePlaylist: (tracks?: Track[]) => void
  onOpenEditPlaylist: (playlist: Playlist) => void
  onOpenAddTracksModal: (tracks: Track[]) => void
  onSelectPlaylistDetail?: (playlist: Playlist) => void
  onClose?: () => void
  showToast?: (msg: string) => void
}

export const UnifiedRightSidebar: React.FC<UnifiedRightSidebarProps> = ({
  onOpenCreatePlaylist,
  onOpenEditPlaylist,
  onOpenAddTracksModal,
  onSelectPlaylistDetail,
  onClose,
  showToast,
}) => {
  const {
    currentTrack,
    currentRelease,
    queue,
    isPlaying,
    isPaused,
    upcomingTracks,
    playTrack,
    addToQueue,
    playNext,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    rightSidebarTab,
    setRightSidebarTab,
  } = useAudioPlayer()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false)
  const [isConfirmingClear, setIsConfirmingClear] = useState(false)
  const dragSourceIndexRef = useRef<number | null>(null)
  const [isNowPlayingMenuOpen, setIsNowPlayingMenuOpen] = useState(false)

  // Load playlists on mount or tab switch
  useEffect(() => {
    if (rightSidebarTab === 'playlists') {
      loadPlaylists()
    }
  }, [rightSidebarTab])

  const loadPlaylists = async () => {
    setIsLoadingPlaylists(true)
    try {
      const data = await sqliteLibraryService.getPlaylists()
      setPlaylists(data)
    } catch (err) {
      console.error('[UnifiedRightSidebar] Failed to load playlists:', err)
    } finally {
      setIsLoadingPlaylists(false)
    }
  }

  // Format seconds to mm:ss
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  // Format total seconds to hours & minutes
  const formatTotalTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '0 min'
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours} hr ${mins} min`
    return `${mins} min`
  }

  // Resolve cover art for a track
  const getTrackCoverArt = (t: Track) => {
    if ((t as any).coverArtUrl) return (t as any).coverArtUrl
    if (currentRelease && currentRelease.id === t.releaseId) {
      return currentRelease.coverArtUrl || currentRelease.artwork?.frontCoverUrl
    }
    return undefined
  }

  // Drag and drop for Queue reordering (Ref-based to prevent React re-renders from cancelling Chromium drag)
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    dragSourceIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
    e.dataTransfer.setData('cadence/queue-index', index.toString())
  }

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault()
    if (dragSourceIndexRef.current !== null && dragSourceIndexRef.current !== index) {
      e.currentTarget.classList.add('border-emerald-500/50', 'bg-emerald-500/10')
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.classList.remove('border-emerald-500/50', 'bg-emerald-500/10')
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetIndex: number) => {
    e.preventDefault()
    e.currentTarget.classList.remove('border-emerald-500/50', 'bg-emerald-500/10')

    let sourceIndex = dragSourceIndexRef.current
    if (sourceIndex === null) {
      const raw = e.dataTransfer.getData('cadence/queue-index') || e.dataTransfer.getData('text/plain')
      if (raw) {
        const parsed = parseInt(raw, 10)
        if (!isNaN(parsed)) sourceIndex = parsed
      }
    }

    if (sourceIndex !== null && sourceIndex !== undefined && sourceIndex !== targetIndex) {
      reorderQueue(sourceIndex, targetIndex)
    }
    dragSourceIndexRef.current = null
  }

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    dragSourceIndexRef.current = null
    const list = e.currentTarget.parentElement
    if (list) {
      const rows = list.querySelectorAll<HTMLElement>('[data-queue-row]')
      rows.forEach((r) => r.classList.remove('border-emerald-500/50', 'bg-emerald-500/10'))
    }
  }

  // Play playlist
  const handlePlayPlaylist = async (pl: Playlist, shuffle: boolean = false) => {
    try {
      const details = await sqliteLibraryService.getPlaylistDetails(pl.id)
      const tracks = details?.tracks || []
      if (tracks.length === 0) {
        showToast?.('Playlist is empty')
        return
      }

      let toPlay = [...tracks]
      if (shuffle) {
        for (let i = toPlay.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[toPlay[i], toPlay[j]] = [toPlay[j], toPlay[i]]
        }
      }

      await playTrack(toPlay[0], toPlay)
      showToast?.(`Playing playlist "${pl.title}" (${tracks.length} tracks)`)
    } catch (err: any) {
      console.error('[UnifiedRightSidebar] Play playlist failed:', err)
      showToast?.(`Failed to play playlist: ${err?.message || err}`)
    }
  }

  // Quick Save Queue as Playlist
  const handleSaveQueue = async () => {
    onOpenCreatePlaylist(queue.length > 0 ? queue : currentTrack ? [currentTrack] : undefined)
  }

  return (
    <aside className="w-[360px] shrink-0 h-full border-l border-white/[0.08] bg-[#0c0d10] flex flex-col overflow-hidden select-none z-30 text-neutral-200">
      {/* Top Header: 2-Way Segmented Tabs (Queue | Playlists) & Close */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5 bg-[#090a0c] shrink-0">
        <div className="flex items-center gap-1 rounded-xl bg-white/[0.04] p-1 border border-white/5">
          {/* Tab 1: Queue */}
          <button
            type="button"
            onClick={() => setRightSidebarTab('queue')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              rightSidebarTab === 'queue'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <ListMusic className="h-3.5 w-3.5 text-emerald-400" />
            <span>Queue</span>
            {upcomingTracks.length > 0 && (
              <span className="rounded-full bg-emerald-500/25 px-1.5 py-0.2 text-[10px] font-mono text-emerald-300">
                {upcomingTracks.length}
              </span>
            )}
          </button>

          {/* Tab 2: Playlists */}
          <button
            type="button"
            onClick={() => setRightSidebarTab('playlists')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              rightSidebarTab === 'playlists'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Disc3 className="h-3.5 w-3.5 text-emerald-400" />
            <span>Playlists</span>
          </button>
        </div>

        {/* Close Button */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
            title="Collapse Sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: NOW PLAYING QUEUE                                                  */}
      {/* ========================================================================= */}
      {rightSidebarTab === 'queue' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Sub-header with Title and Actions */}
          <div className="flex items-center justify-between pb-1">
            <div>
              <h3 className="text-base font-semibold text-white tracking-tight">Now Playing Queue</h3>
              <p className="text-[11px] text-neutral-400">Play Queue & Up Next</p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveQueue}
                className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] px-2.5 py-1 text-xs font-medium text-neutral-300 hover:text-white border border-white/10 transition-colors cursor-pointer"
                title="Save Queue as a new Playlist"
              >
                <BookmarkPlus className="h-3.5 w-3.5 text-emerald-400" />
                <span>Save as Playlist</span>
              </button>

              {upcomingTracks.length > 0 && (
                <div>
                  {isConfirmingClear ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          clearQueue()
                          setIsConfirmingClear(false)
                          showToast?.('Cleared upcoming queue')
                        }}
                        className="rounded px-2 py-0.5 text-[11px] font-medium bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 transition-colors cursor-pointer"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsConfirmingClear(false)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-white cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsConfirmingClear(true)}
                      className="flex items-center gap-1 text-xs text-neutral-400 hover:text-rose-400 px-2 py-1 rounded-lg hover:bg-white/[0.04] transition-colors cursor-pointer"
                      title="Clear upcoming queue"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Clear Queue</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Section: Currently Playing Track Card (Mockup Style) */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              Play Queue
            </span>

            {currentTrack ? (
              <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 shadow-lg group">
                <div className="flex items-center gap-3">
                  {/* Visualizer Wave & Artwork */}
                  <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl bg-neutral-900 border border-white/10 flex items-center justify-center">
                    {currentRelease?.coverArtUrl || currentTrack.releaseId ? (
                      <img
                        src={currentRelease?.coverArtUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Music2 className="h-5 w-5 text-neutral-600" />
                    )}

                    {/* Animated Equalizer Wave Overlay when Playing */}
                    {isPlaying && !isPaused && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[1px]">
                        <div className="flex items-end gap-0.5 h-4">
                          <span className="w-1 bg-emerald-400 rounded-full animate-bounce h-2.5" />
                          <span className="w-1 bg-emerald-400 rounded-full animate-bounce h-4 animation-delay-200" />
                          <span className="w-1 bg-emerald-400 rounded-full animate-bounce h-2 animation-delay-400" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <h4 className="text-xs font-semibold text-white truncate">
                        {currentTrack.title}
                      </h4>
                      <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[9px] font-mono text-emerald-300 border border-emerald-500/30">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Active
                      </span>
                    </div>

                    <p className="text-[11px] text-neutral-400 truncate mt-0.5">
                      {currentTrack.artistCredit || 'Unknown Artist'}
                    </p>

                    <div className="flex items-center justify-between mt-1">
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.2 text-[10px] font-mono text-emerald-400 border border-emerald-500/20">
                        {currentTrack.sampleRateStr?.split(' ')[0] || currentTrack.format || 'PCM'}
                      </span>
                      <span className="text-[11px] text-neutral-400 font-mono">
                        {formatTime(currentTrack.durationSeconds || currentTrack.duration || 0)}
                      </span>
                    </div>
                  </div>

                  {/* Context Menu Trigger */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setIsNowPlayingMenuOpen((prev) => !prev)}
                      className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>

                    {isNowPlayingMenuOpen && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-7 w-36 rounded-xl bg-[#14151a] border border-white/10 shadow-2xl p-1 z-50 text-xs font-sans"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            addToQueue(currentTrack)
                            setIsNowPlayingMenuOpen(false)
                            showToast?.('Added duplicate to end of queue')
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                        >
                          Add to Queue
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenAddTracksModal([currentTrack])
                            setIsNowPlayingMenuOpen(false)
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                        >
                          Add to Playlist
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.01] p-5 text-center text-xs text-neutral-500">
                No track currently playing
              </div>
            )}
          </div>

          {/* Section: Up Next Draggable List */}
          <div className="space-y-2 flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                Up Next {upcomingTracks.length > 0 && `(${upcomingTracks.length})`}
              </span>
              <span className="text-[10px] text-neutral-500 font-mono">
                Drag to Reorder
              </span>
            </div>

            {upcomingTracks.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/5 bg-white/[0.01] p-8 text-center text-xs text-neutral-500 flex-1 flex items-center justify-center">
                <span>Queue is empty. Right-click tracks or albums in your library to "Play Next" or "Add to Queue".</span>
              </div>
            ) : (
              <div className="space-y-1 overflow-y-auto flex-1 pr-0.5">
                {upcomingTracks.map((trk, idx) => (
                  <div
                    key={`${trk.id}-${idx}`}
                    data-queue-row
                    draggable
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragEnter={(e) => handleDragEnter(e, idx)}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, idx)}
                    onDragEnd={handleDragEnd}
                    className="group relative flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] p-2 transition-all cursor-grab active:cursor-grabbing hover:border-white/10 hover:bg-white/[0.04]"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {/* Drag Handle */}
                      <div className="flex-shrink-0 text-neutral-600 group-hover:text-neutral-300 transition-colors cursor-grab active:cursor-grabbing select-none">
                        <GripVertical className="h-3.5 w-3.5" />
                      </div>

                      {/* Number Index */}
                      <span className="w-4 text-right text-[11px] font-mono text-neutral-500 shrink-0 select-none">
                        {idx + 1}
                      </span>

                      {/* Artwork Thumbnail */}
                      <div className="w-7 h-7 rounded-md bg-neutral-900 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center pointer-events-none select-none">
                        {getTrackCoverArt(trk) ? (
                          <img
                            src={getTrackCoverArt(trk)}
                            alt=""
                            className="w-full h-full object-cover pointer-events-none select-none"
                            draggable={false}
                          />
                        ) : (
                          <Music2 className="w-3.5 h-3.5 text-neutral-600" />
                        )}
                      </div>

                      {/* Track Details */}
                      <div className="min-w-0 flex-1 select-none pointer-events-none">
                        <p className="text-xs font-medium text-white truncate leading-tight">
                          {trk.title}
                        </p>
                        <p className="text-[11px] text-neutral-400 truncate mt-0.5 leading-tight">
                          {trk.artistCredit || 'Unknown Artist'}
                        </p>
                      </div>
                    </div>

                    {/* Format, Duration & Actions */}
                    <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                      <span className="rounded bg-white/5 px-1.5 py-0.2 text-[9px] font-mono text-neutral-400 border border-white/5 select-none pointer-events-none">
                        {trk.sampleRateStr?.split(' ')[0] || trk.format || 'PCM'}
                      </span>
                      <span className="text-[10px] text-neutral-400 font-mono w-9 text-right select-none pointer-events-none">
                        {formatTime(trk.durationSeconds || trk.duration || 0)}
                      </span>

                      {/* Hover Actions */}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {idx > 0 && (
                          <button
                            type="button"
                            onClick={() => reorderQueue(idx, 0)}
                            className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-emerald-400 transition-colors cursor-pointer"
                            title="Move to Immediate Next"
                          >
                            <ArrowUpToLine className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {idx > 0 && (
                          <button
                            type="button"
                            onClick={() => reorderQueue(idx, idx - 1)}
                            className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-emerald-400 transition-colors cursor-pointer"
                            title="Move Up"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {idx < upcomingTracks.length - 1 && (
                          <button
                            type="button"
                            onClick={() => reorderQueue(idx, idx + 1)}
                            className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-emerald-400 transition-colors cursor-pointer"
                            title="Move Down"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenAddTracksModal([trk])}
                          className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                          title="Add to Playlist"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromQueue(idx)}
                          className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-rose-400 transition-colors cursor-pointer"
                          title="Remove from Queue"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: PLAYLISTS VIEW                                                     */}
      {/* ========================================================================= */}
      {rightSidebarTab === 'playlists' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Top Header */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white tracking-tight">Your Playlists</h3>
              <p className="text-[11px] text-neutral-400">Curated audiophile sequences</p>
            </div>
            <button
              type="button"
              onClick={() => onOpenCreatePlaylist(queue.length > 0 ? queue : undefined)}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all shadow-sm cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Playlist</span>
            </button>
          </div>

          {/* Playlists List */}
          {isLoadingPlaylists ? (
            <div className="py-12 text-center text-xs text-neutral-500">Loading playlists...</div>
          ) : playlists.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.01] p-8 text-center text-xs text-neutral-500">
              No playlists created yet. Click "+ New Playlist" to start your first curated collection.
            </div>
          ) : (
            <div className="space-y-2 overflow-y-auto flex-1 pr-0.5">
              {playlists.map((pl) => (
                <div
                  key={pl.id}
                  className="group relative flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] p-2.5 hover:border-emerald-500/30 hover:bg-white/[0.04] transition-all"
                >
                  <div
                    className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                    onClick={() => onSelectPlaylistDetail?.(pl)}
                    title="View Playlist Details in Center Stage"
                  >
                    {/* 4-Grid Thumbnail or Fallback Icon */}
                    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 border border-white/10 text-neutral-400 group-hover:text-emerald-400 group-hover:border-emerald-500/30 transition-colors overflow-hidden">
                      {pl.coverArtUrl ? (
                        <img src={pl.coverArtUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Disc3 className="h-5 w-5" />
                      )}
                    </div>

                    {/* Metadata */}
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-semibold text-white truncate group-hover:text-emerald-300 transition-colors">
                        {pl.title}
                      </h4>
                      <p className="text-[11px] text-neutral-400 truncate mt-0.5">
                        {pl.formatBreakdown}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-neutral-500 font-mono">
                          {formatTotalTime(pl.totalDurationSecs)}
                        </span>
                        {pl.tags && pl.tags.length > 0 && (
                          <span className="rounded bg-white/5 px-1 py-0.2 text-[9px] text-neutral-400">
                            {pl.tags[0]}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Play & Menu Actions */}
                  <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePlayPlaylist(pl, false)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all shadow-sm cursor-pointer"
                      title="Play Playlist"
                    >
                      <Play className="h-3 w-3 fill-current ml-0.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePlayPlaylist(pl, true)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                      title="Shuffle Playlist"
                    >
                      <Shuffle className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenEditPlaylist(pl)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                      title="Edit Playlist Metadata"
                    >
                      <Edit3 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

