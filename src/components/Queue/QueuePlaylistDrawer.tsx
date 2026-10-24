import React, { useState, useEffect, useRef } from 'react'
import {
  X,
  ListMusic,
  Play,
  Pause,
  Shuffle,
  Trash2,
  GripVertical,
  ArrowUpToLine,
  ChevronUp,
  ChevronDown,
  Plus,
  Edit3,
  Clock,
  Sparkles,
  Zap,
  ShieldCheck,
  Disc3,
  Sliders,
  MoreVertical,
  BookmarkPlus,
  FolderPlus,
  Radio,
  ExternalLink,
} from 'lucide-react'
import { Track, Playlist, Release, SampleRateTransition } from '../../core/types'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { sqliteLibraryService, generatePlaylist4GridArtwork } from '../../services/sqliteLibraryService'

interface QueuePlaylistDrawerProps {
  isOpen: boolean
  onClose: () => void
  allReleases?: Release[]
  onOpenCreatePlaylist: (tracks?: Track[]) => void
  onOpenEditPlaylist: (playlist: Playlist) => void
  onOpenAddTracksModal: (tracks: Track[]) => void
  onSelectPlaylistDetail?: (playlist: Playlist) => void
  showToast?: (msg: string) => void
}

export const QueuePlaylistDrawer: React.FC<QueuePlaylistDrawerProps> = ({
  isOpen,
  onClose,
  allReleases = [],
  onOpenCreatePlaylist,
  onOpenEditPlaylist,
  onOpenAddTracksModal,
  onSelectPlaylistDetail,
  showToast,
}) => {
  const {
    currentTrack,
    currentRelease,
    queue,
    queueIndex,
    isPlaying,
    isPaused,
    upcomingTracks,
    nextTrackTransition,
    playTrack,
    togglePlayPause,
    addToQueue,
    playNext,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    saveQueueAsPlaylist,
    queueDrawerTab,
    setQueueDrawerTab,
    isGapless,
    toggleGapless,
    settlingDelayMs,
    setSettlingDelay,
    isBitPerfect,
  } = useAudioPlayer()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false)
  const [isConfirmingClear, setIsConfirmingClear] = useState(false)
  const dragSourceIndexRef = useRef<number | null>(null)
  const [showSettingsPopover, setShowSettingsPopover] = useState(false)

  // Load playlists when switching to playlists tab or when drawer opens
  useEffect(() => {
    if (isOpen && queueDrawerTab === 'playlists') {
      loadPlaylists()
    }
  }, [isOpen, queueDrawerTab])

  const loadPlaylists = async () => {
    setIsLoadingPlaylists(true)
    try {
      const data = await sqliteLibraryService.getPlaylists()
      setPlaylists(data)
    } catch (err) {
      console.error('[QueuePlaylistDrawer] Failed to load playlists:', err)
    } finally {
      setIsLoadingPlaylists(false)
    }
  }

  if (!isOpen) return null

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

  // Drag and Drop handlers for Queue Reordering (Ref-based to prevent React re-renders from cancelling Chromium drag)
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

  // Play entire playlist
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
      console.error('[QueuePlaylistDrawer] Play playlist failed:', err)
      showToast?.(`Failed to play playlist: ${err?.message || err}`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden pointer-events-none">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto transition-opacity"
        onClick={onClose}
      />

      {/* Sliding Drawer Container */}
      <div className="absolute inset-y-0 right-0 flex max-w-full pl-10 pointer-events-auto">
        <div className="w-screen max-w-[420px] bg-[#0c0d10] border-l border-white/10 shadow-2xl flex flex-col h-full overflow-hidden text-neutral-200">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 bg-[#090a0c]">
            {/* Dual Tabs: Queue | Playlists */}
            <div className="flex items-center gap-1 rounded-xl bg-white/[0.04] p-1 border border-white/5">
              <button
                type="button"
                onClick={() => setQueueDrawerTab('queue')}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all ${
                  queueDrawerTab === 'queue'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <ListMusic className="h-3.5 w-3.5" />
                Queue
                {upcomingTracks.length > 0 && (
                  <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-mono text-emerald-300">
                    {upcomingTracks.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setQueueDrawerTab('playlists')}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all ${
                  queueDrawerTab === 'playlists'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Disc3 className="h-3.5 w-3.5" />
                Playlists
              </button>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/5 hover:text-white transition-colors"
              title="Close Drawer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* TAB 1: NOW PLAYING QUEUE */}
          {queueDrawerTab === 'queue' && (
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {/* SECTION 1: NOW PLAYING */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                    Now Playing
                  </span>
                  {isBitPerfect && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      <ShieldCheck className="h-3 w-3" />
                      Bit-Perfect Lock
                    </span>
                  )}
                </div>

                {currentTrack ? (
                  <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-lg group">
                    <div className="flex items-center gap-3.5">
                      {/* Album Art Thumbnail or Wave Visualizer */}
                      <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl bg-neutral-900 border border-white/10">
                        {currentRelease?.coverArtUrl || currentTrack.releaseId ? (
                          <img
                            src={currentRelease?.coverArtUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-neutral-600">
                            <Disc3 className="h-6 w-6" />
                          </div>
                        )}

                        {/* Animated Equalizer Overlay when Playing */}
                        {isPlaying && !isPaused && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
                            <div className="flex items-end gap-1 h-4">
                              <span className="w-1 bg-emerald-400 rounded-full animate-bounce h-3" />
                              <span className="w-1 bg-emerald-400 rounded-full animate-bounce h-4 animation-delay-200" />
                              <span className="w-1 bg-emerald-400 rounded-full animate-bounce h-2 animation-delay-400" />
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Track Metadata */}
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-serif font-medium text-white truncate">
                          {currentTrack.title}
                        </h3>
                        <p className="text-xs text-neutral-400 truncate mt-0.5">
                          {currentTrack.artistCredit || 'Unknown Artist'}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-400 border border-emerald-500/20">
                            {currentTrack.sampleRateStr || currentTrack.format || 'PCM'}
                          </span>
                          <span className="text-[10px] text-neutral-500 font-mono">
                            {formatTime(currentTrack.durationSeconds || currentTrack.duration || 0)}
                          </span>
                        </div>
                      </div>

                      {/* Play / Pause Toggle */}
                      <button
                        type="button"
                        onClick={togglePlayPause}
                        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-black hover:bg-emerald-400 transition-colors shadow-md shadow-emerald-500/20"
                      >
                        {isPlaying && !isPaused ? (
                          <Pause className="h-4 w-4 fill-black" />
                        ) : (
                          <Play className="h-4 w-4 fill-black ml-0.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.01] p-6 text-center text-xs text-neutral-500">
                    No track currently playing
                  </div>
                )}
              </div>

              {/* AUDIOPHILE DAC CLOCK RESYNC WARNING */}
              {nextTrackTransition && (
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs text-amber-300">
                  <Zap className="h-4 w-4 flex-shrink-0 text-amber-400 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-amber-200">Hardware Clock Resync</p>
                    <p className="text-[11px] text-amber-300/80 mt-0.5">
                      {nextTrackTransition.warningLabel}
                    </p>
                  </div>
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-400 border border-amber-500/20">
                    {nextTrackTransition.settlingDelayMs}ms
                  </span>
                </div>
              )}

              {/* SECTION 2: UP NEXT QUEUE */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                      Up Next
                    </span>
                    <span className="text-xs text-neutral-500 font-mono">
                      ({upcomingTracks.length})
                    </span>
                  </div>

                  {upcomingTracks.length > 0 && (
                    <div className="flex items-center gap-2">
                      {isConfirmingClear ? (
                        <div className="flex items-center gap-1.5 animate-fadeIn">
                          <button
                            type="button"
                            onClick={() => {
                              clearQueue()
                              setIsConfirmingClear(false)
                              showToast?.('Cleared upcoming queue')
                            }}
                            className="rounded px-2 py-0.5 text-[11px] font-medium bg-rose-500/20 text-rose-400 hover:bg-rose-500/30 transition-colors"
                          >
                            Confirm Clear
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsConfirmingClear(false)}
                            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-white"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setIsConfirmingClear(true)}
                          className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-rose-400 transition-colors"
                          title="Clear upcoming queue"
                        >
                          <Trash2 className="h-3 w-3" />
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Upcoming Tracks Draggable List */}
                {upcomingTracks.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/5 bg-white/[0.01] p-8 text-center text-xs text-neutral-500">
                    Queue is empty. Right-click tracks or albums to "Play Next" or "Add to Queue".
                  </div>
                ) : (
                  <div className="space-y-1.5">
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
                        className="group relative flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] p-2.5 transition-all cursor-grab active:cursor-grabbing hover:border-white/10 hover:bg-white/[0.04]"
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1 select-none">
                          {/* Drag Handle */}
                          <div className="flex-shrink-0 text-neutral-600 group-hover:text-neutral-300 transition-colors cursor-grab active:cursor-grabbing select-none">
                            <GripVertical className="h-4 w-4" />
                          </div>

                          {/* Index */}
                          <span className="w-5 text-right text-[11px] font-mono text-neutral-500 select-none">
                            {idx + 1}
                          </span>

                          {/* Track Details */}
                          <div className="min-w-0 flex-1 select-none pointer-events-none">
                            <p className="text-xs font-medium text-white truncate">
                              {trk.title}
                            </p>
                            <p className="text-[11px] text-neutral-400 truncate mt-0.5">
                              {trk.artistCredit || 'Unknown Artist'}
                            </p>
                          </div>
                        </div>

                        {/* Format & Actions */}
                        <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-mono text-neutral-400 border border-white/5 select-none pointer-events-none">
                            {trk.sampleRateStr?.split(' ')[0] || trk.format || 'PCM'}
                          </span>
                          <span className="text-[10px] text-neutral-500 font-mono w-9 text-right select-none pointer-events-none">
                            {formatTime(trk.durationSeconds || trk.duration || 0)}
                          </span>

                          {/* Hover Actions */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                              className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
                              title="Add to Playlist"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeFromQueue(idx)}
                              className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-rose-400 transition-colors"
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

          {/* TAB 2: PLAYLISTS VIEW */}
          {queueDrawerTab === 'playlists' && (
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Top Action */}
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-serif font-semibold text-white">Your Playlists</h3>
                  <p className="text-xs text-neutral-400">Curated audiophile sequences</p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenCreatePlaylist(queue.length > 0 ? queue : undefined)}
                  className="flex items-center gap-1.5 rounded-xl bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all shadow-sm"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Playlist
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
                <div className="space-y-2.5">
                  {playlists.map((pl) => (
                    <div
                      key={pl.id}
                      className="group relative flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] p-3 hover:border-emerald-500/30 hover:bg-white/[0.04] transition-all"
                    >
                      <div
                        className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                        onClick={() => {
                          onSelectPlaylistDetail?.(pl)
                          onClose()
                        }}
                      >
                        {/* 4-Grid Thumbnail or Icon */}
                        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 border border-white/10 text-neutral-400 group-hover:text-emerald-400 group-hover:border-emerald-500/30 transition-colors overflow-hidden">
                          {pl.coverArtUrl ? (
                            <img src={pl.coverArtUrl} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Disc3 className="h-5 w-5" />
                          )}
                        </div>

                        {/* Title & Stats */}
                        <div className="min-w-0 flex-1">
                          <h4 className="text-xs font-medium text-white truncate group-hover:text-emerald-400 transition-colors">
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
                      <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => handlePlayPlaylist(pl, false)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all shadow-sm"
                          title="Play Playlist"
                        >
                          <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePlayPlaylist(pl, true)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
                          title="Shuffle Playlist"
                        >
                          <Shuffle className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenEditPlaylist(pl)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-white transition-colors"
                          title="Edit Playlist Metadata"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FOOTER: QUEUE CONTROLS & GAPLESS SETTINGS */}
          {queueDrawerTab === 'queue' && (
            <div className="border-t border-white/10 bg-[#090a0c] p-4 space-y-3">
              {/* Gapless & Settling Delay Toolbar */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-400">Gapless Playback:</span>
                  <button
                    type="button"
                    onClick={() => toggleGapless()}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      isGapless ? 'bg-emerald-500' : 'bg-neutral-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-black shadow transition duration-200 ease-in-out ${
                        isGapless ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-neutral-400">DAC Lock:</span>
                  <select
                    value={settlingDelayMs}
                    onChange={(e) => setSettlingDelay(parseInt(e.target.value, 10))}
                    className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white focus:outline-none focus:border-emerald-500/50"
                  >
                    <option value="0" className="bg-neutral-900">0ms (Instant)</option>
                    <option value="150" className="bg-neutral-900">150ms (Same-Clock)</option>
                    <option value="350" className="bg-neutral-900">350ms (Default)</option>
                    <option value="500" className="bg-neutral-900">500ms (R2R / FPGA)</option>
                    <option value="1000" className="bg-neutral-900">1000ms (Master Clock)</option>
                    <option value="1500" className="bg-neutral-900">1500ms (Relay Lock)</option>
                  </select>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onOpenCreatePlaylist(queue.length > 0 ? queue : undefined)}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-white/5 py-2 text-xs font-medium text-white hover:bg-white/10 border border-white/10 transition-colors"
                >
                  <BookmarkPlus className="h-4 w-4 text-emerald-400" />
                  Save Queue as Playlist
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
