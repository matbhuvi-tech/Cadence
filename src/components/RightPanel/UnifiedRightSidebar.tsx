import React, { useState, useEffect, useRef, useMemo } from 'react'
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
import { Track, Playlist, Release } from '../../core/types'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'

interface UnifiedRightSidebarProps {
  allReleases?: Release[]
  onOpenCreatePlaylist: (tracks?: Track[]) => void
  onOpenEditPlaylist: (playlist: Playlist) => void
  onOpenAddTracksModal: (tracks: Track[]) => void
  onSelectPlaylistDetail?: (playlist: Playlist) => void
  onClose?: () => void
  showToast?: (msg: string) => void
}

export const UnifiedRightSidebar: React.FC<UnifiedRightSidebarProps> = ({
  allReleases = [],
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
    currentTime,
    duration,
    seek,
    isShuffle,
    toggleShuffle,
    upcomingTracks,
    playTrack,
    addToQueue,
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
  const [activeMenuIndex, setActiveMenuIndex] = useState<number | null>(null)

  // Close menus on outside click
  useEffect(() => {
    if (activeMenuIndex === null && !isNowPlayingMenuOpen) return
    const handleDocClick = () => {
      setActiveMenuIndex(null)
      setIsNowPlayingMenuOpen(false)
    }
    document.addEventListener('click', handleDocClick)
    return () => document.removeEventListener('click', handleDocClick)
  }, [activeMenuIndex, isNowPlayingMenuOpen])

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

  // Release lookup map
  const releaseMap = useMemo(() => {
    const map = new Map<string, Release>()
    for (const r of allReleases) {
      map.set(r.id, r)
    }
    return map
  }, [allReleases])

  // Resolve cover art for a track
  const getTrackCoverArt = (t: Track) => {
    if ((t as any).coverArtUrl) return (t as any).coverArtUrl
    if (currentRelease && currentRelease.id === t.releaseId) {
      return currentRelease.coverArtUrl || currentRelease.artwork?.frontCoverUrl
    }
    const rel = releaseMap.get(t.releaseId)
    if (rel) {
      return rel.coverArtUrl || rel.artwork?.frontCoverUrl
    }
    return undefined
  }

  // Resolve album title for a track
  const getTrackAlbumTitle = (t: Track) => {
    if (t.releaseTitle) return t.releaseTitle
    if (t.albumTitle) return t.albumTitle
    if (t.canonicalAlbumTitle) return t.canonicalAlbumTitle
    if (t.originalAlbum) return t.originalAlbum
    if (currentRelease && currentRelease.id === t.releaseId) return currentRelease.title
    const rel = releaseMap.get(t.releaseId)
    if (rel) return rel.title
    return undefined
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
    if (hours > 0) return `${hours}h ${mins}m`
    return `${mins}m`
  }

  // Durations
  const totalUpcomingSecs = useMemo(() => {
    return upcomingTracks.reduce((acc, t) => acc + (t.durationSeconds || t.duration || 0), 0)
  }, [upcomingTracks])

  const totalRemainingSecs = useMemo(() => {
    const currentRemaining = Math.max(0, (duration || currentTrack?.durationSeconds || 0) - currentTime)
    return currentRemaining + totalUpcomingSecs
  }, [duration, currentTrack, currentTime, totalUpcomingSecs])

  // Drag and drop for Queue reordering
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    dragSourceIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
    e.dataTransfer.setData('cadence/queue-index', index.toString())
  }

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault()
    if (dragSourceIndexRef.current !== null && dragSourceIndexRef.current !== index) {
      e.currentTarget.classList.add('border-[#D4AF37]/50', 'bg-[#D4AF37]/10')
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.classList.remove('border-[#D4AF37]/50', 'bg-[#D4AF37]/10')
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetIndex: number) => {
    e.preventDefault()
    e.currentTarget.classList.remove('border-[#D4AF37]/50', 'bg-[#D4AF37]/10')

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
      rows.forEach((r) => r.classList.remove('border-[#D4AF37]/50', 'bg-[#D4AF37]/10'))
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
    <aside className="w-[380px] shrink-0 h-full border-l border-white/[0.08] bg-[#0c0d10] flex flex-col overflow-hidden select-none z-30 text-neutral-200">
      {/* Top Header: 2-Way Segmented Tabs (Queue | Playlists) & Quick Controls */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5 bg-[#090a0c] shrink-0">
        <div className="flex items-center gap-1 rounded-xl bg-white/[0.04] p-1 border border-white/5">
          {/* Tab 1: Queue */}
          <button
            type="button"
            onClick={() => setRightSidebarTab('queue')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              rightSidebarTab === 'queue'
                ? 'bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 shadow-sm'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <ListMusic className="h-3.5 w-3.5 text-[#D4AF37]" />
            <span>Queue</span>
            {upcomingTracks.length > 0 && (
              <span className="rounded-full bg-[#D4AF37]/20 px-1.5 py-0.2 text-[10px] font-mono text-[#D4AF37]">
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
                ? 'bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 shadow-sm'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Disc3 className="h-3.5 w-3.5 text-[#D4AF37]" />
            <span>Playlists</span>
          </button>
        </div>

        {/* Right Header Actions */}
        <div className="flex items-center gap-1">
          {rightSidebarTab === 'queue' && (
            <button
              type="button"
              onClick={toggleShuffle}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                isShuffle
                  ? 'text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/30'
                  : 'text-neutral-400 hover:text-white hover:bg-white/5'
              }`}
              title={isShuffle ? 'Shuffle is On' : 'Shuffle is Off'}
            >
              <Shuffle className="h-4 w-4" />
            </button>
          )}

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
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: NOW PLAYING QUEUE                                                  */}
      {/* ========================================================================= */}
      {rightSidebarTab === 'queue' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Section: Currently Playing Track Card */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              Now Playing
            </span>

            {currentTrack ? (
              <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 shadow-lg group">
                <div className="flex gap-3">
                  {/* Artwork with Equalizer Indicator */}
                  <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl bg-neutral-900 border border-white/10 flex items-center justify-center shadow-md">
                    {getTrackCoverArt(currentTrack) ? (
                      <img
                        src={getTrackCoverArt(currentTrack)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Music2 className="h-6 w-6 text-neutral-600" />
                    )}

                    {/* Equalizer animation when playing */}
                    {isPlaying && !isPaused && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
                        <div className="flex items-end gap-0.5 h-4">
                          <span className="w-1 bg-[#D4AF37] rounded-full animate-bounce h-2.5" />
                          <span className="w-1 bg-[#D4AF37] rounded-full animate-bounce h-4 animation-delay-200" />
                          <span className="w-1 bg-[#D4AF37] rounded-full animate-bounce h-2 animation-delay-400" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="flex-1 min-w-0 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1.5">
                        <h4 className="text-sm font-semibold text-white truncate">
                          {currentTrack.title}
                        </h4>
                        <span className="flex items-center gap-1 rounded-full bg-[#D4AF37]/20 px-2 py-0.5 text-[9px] font-mono text-[#D4AF37] border border-[#D4AF37]/30 shrink-0">
                          <span
                            className={`w-1.5 h-1.5 rounded-full bg-[#D4AF37] ${
                              isPlaying && !isPaused ? 'animate-pulse' : ''
                            }`}
                          />
                          {isPlaying && !isPaused ? 'Playing' : 'Paused'}
                        </span>
                      </div>

                      <p className="text-xs text-neutral-300 truncate mt-0.5">
                        {currentTrack.artistCredit || 'Unknown Artist'}
                      </p>

                      {getTrackAlbumTitle(currentTrack) && (
                        <p className="text-[11px] text-neutral-500 truncate mt-0.5 flex items-center gap-1">
                          <Disc3 className="h-3 w-3 text-[#D4AF37]/70 shrink-0" />
                          <span>{getTrackAlbumTitle(currentTrack)}</span>
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-1 text-[10px] font-mono text-neutral-400">
                      <span className="rounded bg-[#D4AF37]/10 px-1.5 py-0.2 text-[9px] font-mono text-[#D4AF37] border border-[#D4AF37]/20">
                        {currentTrack.sampleRateStr?.split(' ')[0] || currentTrack.format || 'PCM'}
                      </span>
                      <span>{formatTime(duration || currentTrack.durationSeconds || 0)}</span>
                    </div>
                  </div>

                  {/* Context Menu Trigger */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setIsNowPlayingMenuOpen((prev) => !prev)
                      }}
                      className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>

                    {isNowPlayingMenuOpen && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-7 w-40 rounded-xl bg-[#14151a] border border-white/10 shadow-2xl p-1 z-50 text-xs font-sans animate-fadeIn"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            addToQueue(currentTrack)
                            setIsNowPlayingMenuOpen(false)
                            showToast?.('Added duplicate to end of queue')
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer flex items-center gap-2"
                        >
                          <Plus className="h-3.5 w-3.5 text-[#D4AF37]" />
                          <span>Add to Queue</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenAddTracksModal([currentTrack])
                            setIsNowPlayingMenuOpen(false)
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer flex items-center gap-2"
                        >
                          <BookmarkPlus className="h-3.5 w-3.5 text-neutral-400" />
                          <span>Add to Playlist</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Scrubber / Progress Bar */}
                <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/5">
                  <span className="text-[10px] text-neutral-400 font-mono w-7 text-left select-none">
                    {formatTime(currentTime)}
                  </span>
                  <div
                    onClick={(e) => {
                      if (!duration || duration <= 0) return
                      const rect = e.currentTarget.getBoundingClientRect()
                      const clickX = e.clientX - rect.left
                      const ratio = Math.max(0, Math.min(1, clickX / rect.width))
                      seek(ratio * duration)
                    }}
                    className="relative flex-1 h-1.5 bg-white/10 hover:bg-white/20 rounded-full cursor-pointer overflow-hidden transition-all group/bar"
                    title="Click to seek"
                  >
                    <div
                      className="absolute left-0 top-0 bottom-0 bg-[#D4AF37] rounded-full group-hover/bar:bg-[#F5D061] transition-all"
                      style={{
                        width: `${
                          duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0
                        }%`,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-neutral-400 font-mono w-7 text-right select-none">
                    {formatTime(duration || currentTrack.durationSeconds || 0)}
                  </span>
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
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Up Next
                </span>
                <span className="text-xs text-neutral-500 font-mono">
                  ({upcomingTracks.length})
                </span>
              </div>

              <div className="flex items-center gap-2">
                {upcomingTracks.length > 0 && (
                  <span className="text-[10px] text-neutral-400 font-mono">
                    {formatTotalTime(totalRemainingSecs)} remaining
                  </span>
                )}

                {/* Save Queue as Playlist */}
                <button
                  type="button"
                  onClick={handleSaveQueue}
                  className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                  title="Save Queue as a new Playlist"
                >
                  <BookmarkPlus className="h-3.5 w-3.5 text-[#D4AF37]" />
                </button>

                {/* Clear Queue Button */}
                {upcomingTracks.length > 0 && (
                  <div>
                    {isConfirmingClear ? (
                      <div className="flex items-center gap-1 animate-fadeIn">
                        <button
                          type="button"
                          onClick={() => {
                            clearQueue()
                            setIsConfirmingClear(false)
                            showToast?.('Cleared upcoming queue')
                          }}
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 transition-colors cursor-pointer"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsConfirmingClear(false)}
                          className="rounded px-1 py-0.5 text-[10px] text-neutral-400 hover:text-white cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setIsConfirmingClear(true)}
                        className="p-1 rounded-lg text-neutral-400 hover:text-rose-400 hover:bg-white/5 transition-colors cursor-pointer"
                        title="Clear upcoming queue"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {upcomingTracks.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/5 bg-white/[0.01] p-8 text-center text-xs text-neutral-500 flex-1 flex items-center justify-center">
                <span>Queue is empty. Right-click tracks or albums in your library to "Play Next" or "Add to Queue".</span>
              </div>
            ) : (
              <div className="space-y-1.5 overflow-y-auto flex-1 pr-0.5 pb-2">
                {upcomingTracks.map((trk, idx) => {
                  const coverArt = getTrackCoverArt(trk)
                  const albumTitle = getTrackAlbumTitle(trk)
                  const isMenuOpen = activeMenuIndex === idx
                  const isNearBottom = idx >= Math.max(0, upcomingTracks.length - 2)

                  return (
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
                      {/* Left: Drag Handle, Index, Thumbnail, Track Details */}
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        {/* Drag Handle */}
                        <div className="flex-shrink-0 text-neutral-600 group-hover:text-neutral-300 transition-colors cursor-grab active:cursor-grabbing select-none">
                          <GripVertical className="h-3.5 w-3.5" />
                        </div>

                        {/* Number Index */}
                        <span className="w-3 text-right text-[11px] font-mono text-neutral-500 shrink-0 select-none">
                          {idx + 1}
                        </span>

                        {/* Artwork Thumbnail */}
                        <div className="w-8 h-8 rounded-lg bg-neutral-900 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center pointer-events-none select-none shadow-sm">
                          {coverArt ? (
                            <img
                              src={coverArt}
                              alt=""
                              className="w-full h-full object-cover pointer-events-none select-none"
                              draggable={false}
                            />
                          ) : (
                            <Music2 className="w-4 h-4 text-neutral-600" />
                          )}
                        </div>

                        {/* Track Details */}
                        <div className="min-w-0 flex-1 select-none pointer-events-none">
                          <p className="text-xs font-semibold text-white truncate leading-tight">
                            {trk.title}
                          </p>
                          <p className="text-[11px] text-neutral-400 truncate mt-0.5 leading-tight">
                            {trk.artistCredit || 'Unknown Artist'}
                          </p>
                          {albumTitle && (
                            <p className="text-[10px] text-neutral-500 truncate mt-0.5 leading-tight flex items-center gap-1">
                              <Disc3 className="h-2.5 w-2.5 text-[#D4AF37]/70 shrink-0" />
                              <span>{albumTitle}</span>
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Right: Duration, Quick Remove on Hover, Context Menu */}
                      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                        <span className="text-[11px] text-neutral-400 font-mono w-10 text-right select-none pointer-events-none">
                          {formatTime(trk.durationSeconds || trk.duration || 0)}
                        </span>

                        {/* Quick Remove on Hover */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeFromQueue(idx)
                            showToast?.(`Removed "${trk.title}" from queue`)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-neutral-400 hover:text-rose-400 hover:bg-white/10 transition-all cursor-pointer"
                          title="Remove from Queue"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>

                        {/* Overflow Menu Trigger */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setActiveMenuIndex(isMenuOpen ? null : idx)
                            }}
                            className={`p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer ${
                              isMenuOpen ? 'text-[#D4AF37] bg-white/10' : ''
                            }`}
                            title="More options"
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </button>

                          {/* Context Menu Dropdown */}
                          {isMenuOpen && (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className={`absolute right-0 w-44 rounded-xl bg-[#14151a] border border-white/10 shadow-2xl p-1 z-50 text-xs font-sans animate-fadeIn ${
                                isNearBottom ? 'bottom-full mb-1' : 'top-full mt-1'
                              }`}
                            >
                              {/* Tier 1: Playback Actions */}
                              <button
                                type="button"
                                onClick={() => {
                                  playTrack(trk, queue)
                                  setActiveMenuIndex(null)
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-neutral-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                              >
                                <Play className="h-3.5 w-3.5 text-[#D4AF37]" />
                                <span>Play Now</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  reorderQueue(idx, 0)
                                  setActiveMenuIndex(null)
                                  showToast?.(`"${trk.title}" will play next`)
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-neutral-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                              >
                                <ArrowUpToLine className="h-3.5 w-3.5 text-[#D4AF37]" />
                                <span>Play Next</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  onOpenAddTracksModal([trk])
                                  setActiveMenuIndex(null)
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-neutral-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                              >
                                <Plus className="h-3.5 w-3.5 text-neutral-400" />
                                <span>Add to Playlist</span>
                              </button>

                              {/* Divider */}
                              <div className="border-t border-white/10 my-1" />

                              {/* Tier 2: Queue Positioning */}
                              {idx > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    reorderQueue(idx, 0)
                                    setActiveMenuIndex(null)
                                  }}
                                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                                >
                                  <ArrowUpToLine className="h-3.5 w-3.5 text-neutral-400" />
                                  <span>Move to Top</span>
                                </button>
                              )}

                              {idx > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    reorderQueue(idx, idx - 1)
                                    setActiveMenuIndex(null)
                                  }}
                                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                                >
                                  <ChevronUp className="h-3.5 w-3.5 text-neutral-400" />
                                  <span>Move Up</span>
                                </button>
                              )}

                              {idx < upcomingTracks.length - 1 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    reorderQueue(idx, idx + 1)
                                    setActiveMenuIndex(null)
                                  }}
                                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                                >
                                  <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
                                  <span>Move Down</span>
                                </button>
                              )}

                              {/* Divider */}
                              <div className="border-t border-white/10 my-1" />

                              {/* Tier 3: Destructive Action */}
                              <button
                                type="button"
                                onClick={() => {
                                  removeFromQueue(idx)
                                  setActiveMenuIndex(null)
                                  showToast?.(`Removed "${trk.title}" from queue`)
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                                <span>Remove</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
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
              className="flex items-center gap-1.5 rounded-xl bg-[#D4AF37]/10 px-3 py-1.5 text-xs font-medium text-[#D4AF37] border border-[#D4AF37]/20 hover:bg-[#D4AF37]/20 transition-all shadow-sm cursor-pointer"
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
                  className="group relative flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] p-2.5 hover:border-[#D4AF37]/30 hover:bg-white/[0.04] transition-all"
                >
                  <div
                    className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                    onClick={() => onSelectPlaylistDetail?.(pl)}
                    title="View Playlist Details in Center Stage"
                  >
                    {/* 4-Grid Thumbnail or Fallback Icon */}
                    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 border border-white/10 text-neutral-400 group-hover:text-[#D4AF37] group-hover:border-[#D4AF37]/30 transition-colors overflow-hidden">
                      {pl.coverArtUrl ? (
                        <img src={pl.coverArtUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Disc3 className="h-5 w-5" />
                      )}
                    </div>

                    {/* Metadata */}
                    <div className="min-w-0 flex-1">
                      <h4 className="text-xs font-semibold text-white truncate group-hover:text-[#D4AF37] transition-colors">
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
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#D4AF37]/10 text-[#D4AF37] hover:bg-[#D4AF37] hover:text-black transition-all shadow-sm cursor-pointer"
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

      {/* Bottom Status Bar */}
      <div className="flex items-center justify-between border-t border-white/[0.08] px-4 py-2.5 bg-[#090a0c] text-xs text-neutral-400 shrink-0">
        <span className="font-mono text-[11px]">
          {upcomingTracks.length} tracks • {formatTotalTime(totalUpcomingSecs)}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              showToast?.('Drag any row using the grab handle to reorder')
            }}
            className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-[#D4AF37] transition-colors cursor-pointer"
            title="Drag items in the list to reorder"
          >
            <GripVertical className="h-3 w-3" />
            <span>Reorder</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
