import React, { useState, useEffect } from 'react'
import {
  Play,
  Pause,
  Shuffle,
  Edit3,
  Trash2,
  Plus,
  Clock,
  Music,
  GripVertical,
  ArrowLeft,
  FileText,
  Tag,
  ShieldCheck,
  Disc3,
  X,
  ListPlus,
} from 'lucide-react'
import { Playlist, Track, Release } from '../../core/types'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { sqliteLibraryService, generatePlaylist4GridArtwork } from '../../services/sqliteLibraryService'

interface PlaylistDetailViewProps {
  playlist: Playlist
  allTracks?: Track[]
  allReleases?: Release[]
  onBackToLibrary: () => void
  onOpenEditPlaylist: (playlist: Playlist) => void
  onOpenAddTracksModal: (tracks: Track[]) => void
  showToast?: (msg: string) => void
}

export const PlaylistDetailView: React.FC<PlaylistDetailViewProps> = ({
  playlist,
  allTracks = [],
  allReleases = [],
  onBackToLibrary,
  onOpenEditPlaylist,
  onOpenAddTracksModal,
  showToast,
}) => {
  const { currentTrack, isPlaying, isPaused, playTrack, addToQueue, playNext } = useAudioPlayer()

  const [tracks, setTracks] = useState<Track[]>(playlist.tracks || [])
  const [isLoading, setIsLoading] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  useEffect(() => {
    loadPlaylistTracks()
  }, [playlist.id])

  const loadPlaylistTracks = async () => {
    setIsLoading(true)
    try {
      const details = await sqliteLibraryService.getPlaylistDetails(playlist.id)
      if (details?.tracks) {
        setTracks(details.tracks)
      }
    } catch (err) {
      console.error('[PlaylistDetailView] Failed to load tracks:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const formatTotalTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '0 min'
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours} hr ${mins} min`
    return `${mins} min`
  }

  const handlePlayAll = async (shuffle: boolean = false) => {
    if (tracks.length === 0) return
    let toPlay = [...tracks]
    if (shuffle) {
      for (let i = toPlay.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[toPlay[i], toPlay[j]] = [toPlay[j], toPlay[i]]
      }
    }
    await playTrack(toPlay[0], toPlay)
    showToast?.(`Playing playlist "${playlist.title}" (${tracks.length} tracks)`)
  }

  const handleRemoveTrack = async (position: number, trkTitle: string) => {
    try {
      await sqliteLibraryService.removeTrackFromPlaylist(playlist.id, position)
      setTracks((prev) => prev.filter((_, idx) => idx !== position))
      showToast?.(`Removed "${trkTitle}" from playlist`)
    } catch (err: any) {
      console.error('[PlaylistDetailView] Failed to remove track:', err)
      showToast?.(`Failed to remove: ${err?.message || err}`)
    }
  }

  // HTML5 Drag and Drop Reordering
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverIndex !== index) {
      setDragOverIndex(index)
    }
  }

  const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      const updated = [...tracks]
      const [moved] = updated.splice(draggedIndex, 1)
      updated.splice(targetIndex, 0, moved)
      setTracks(updated)

      try {
        await sqliteLibraryService.reorderPlaylistTracks(
          playlist.id,
          updated.map((t) => t.id)
        )
        showToast?.('Updated track sequence')
      } catch (err) {
        console.error('[PlaylistDetailView] Reorder failed:', err)
      }
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const gridArtwork = generatePlaylist4GridArtwork(tracks, allReleases)
  const totalDuration = tracks.reduce((acc, t) => acc + (t.durationSeconds || t.duration || 0), 0)

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0c0d10] overflow-y-auto text-neutral-200">
      {/* Top Banner Navigation */}
      <div className="border-b border-white/5 bg-[#090a0c]/80 backdrop-blur-md px-8 py-3.5 flex items-center justify-between sticky top-0 z-20">
        <button
          type="button"
          onClick={onBackToLibrary}
          className="flex items-center gap-2 text-xs font-medium text-neutral-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Library
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenEditPlaylist(playlist)}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Edit3 className="h-3.5 w-3.5" />
            Edit Metadata
          </button>
        </div>
      </div>

      {/* Playlist Hero Section */}
      <div className="p-8 pb-6 border-b border-white/5 bg-gradient-to-b from-white/[0.03] to-transparent">
        <div className="flex flex-col md:flex-row items-start md:items-end gap-6 max-w-6xl">
          {/* 4-Grid Composite Artwork */}
          <div className="h-44 w-44 flex-shrink-0 overflow-hidden rounded-2xl bg-neutral-900 border border-white/10 shadow-2xl grid grid-cols-2 grid-rows-2">
            {gridArtwork.length >= 4 ? (
              gridArtwork.slice(0, 4).map((art, idx) => (
                <img key={idx} src={art} alt="" className="h-full w-full object-cover" />
              ))
            ) : gridArtwork.length > 0 ? (
              <img src={gridArtwork[0]} alt="" className="col-span-2 row-span-2 h-full w-full object-cover" />
            ) : (
              <div className="col-span-2 row-span-2 flex items-center justify-center text-neutral-600">
                <Disc3 className="h-12 w-12" />
              </div>
            )}
          </div>

          {/* Details */}
          <div className="flex-1 min-w-0 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider font-semibold text-emerald-400">
                Curated Playlist
              </span>
              <span className="text-xs text-neutral-500">•</span>
              <span className="text-xs font-mono text-neutral-400">{playlist.formatBreakdown}</span>
            </div>

            <h1 className="text-3xl lg:text-4xl font-serif font-bold text-white tracking-tight">
              {playlist.title}
            </h1>

            {playlist.description && (
              <p className="text-sm text-neutral-300 max-w-2xl leading-relaxed">
                {playlist.description}
              </p>
            )}

            {/* Tags & Listening Notes */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {playlist.tags &&
                playlist.tags.map((tag) => (
                  <span
                    key={tag}
                    className="flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-neutral-300 border border-white/5 font-mono"
                  >
                    <Tag className="h-3 w-3 text-neutral-400" />
                    {tag}
                  </span>
                ))}
            </div>

            {playlist.listeningNotes && (
              <div className="flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 text-xs text-emerald-300/90 max-w-2xl mt-2">
                <FileText className="h-4 w-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  <span className="font-semibold text-emerald-300">Listening Notes: </span>
                  {playlist.listeningNotes}
                </p>
              </div>
            )}

            {/* Stats & Playback Actions */}
            <div className="flex items-center gap-4 pt-3">
              <button
                type="button"
                onClick={() => handlePlayAll(false)}
                disabled={tracks.length === 0}
                className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-black hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50"
              >
                <Play className="h-4 w-4 fill-black" />
                Play All
              </button>
              <button
                type="button"
                onClick={() => handlePlayAll(true)}
                disabled={tracks.length === 0}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                <Shuffle className="h-4 w-4" />
                Shuffle
              </button>

              <span className="text-xs text-neutral-400 font-mono pl-2">
                {tracks.length} tracks • {formatTotalTime(totalDuration)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabular Tracks View */}
      <div className="p-8 pt-4 max-w-6xl">
        {isLoading ? (
          <div className="py-20 text-center text-xs text-neutral-500">Loading playlist tracks...</div>
        ) : tracks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.01] p-12 text-center text-xs text-neutral-500">
            This playlist has no tracks yet. Browse your albums and click "Add to Playlist" to populate this sequence.
          </div>
        ) : (
          <div className="space-y-1">
            {/* Table Header */}
            <div className="grid grid-cols-12 gap-4 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 border-b border-white/5">
              <div className="col-span-1 text-center">#</div>
              <div className="col-span-5">Title & Artist</div>
              <div className="col-span-3">Format / Specs</div>
              <div className="col-span-1 text-center">DR</div>
              <div className="col-span-1 text-right">Time</div>
              <div className="col-span-1 text-right">Actions</div>
            </div>

            {/* Track Rows */}
            {tracks.map((trk, idx) => {
              const isCurrentPlaying = currentTrack?.id === trk.id

              return (
                <div
                  key={`${trk.id}-${idx}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDrop={(e) => handleDrop(e, idx)}
                  className={`group grid grid-cols-12 gap-4 items-center px-3 py-2.5 rounded-xl border transition-all cursor-grab active:cursor-grabbing ${
                    dragOverIndex === idx
                      ? 'border-emerald-500/50 bg-emerald-500/10'
                      : isCurrentPlaying
                      ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                      : 'border-transparent hover:border-white/10 hover:bg-white/[0.03]'
                  }`}
                >
                  {/* Position & Play Status */}
                  <div className="col-span-1 flex items-center justify-center gap-1.5">
                    <GripVertical className="h-3.5 w-3.5 text-neutral-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    {isCurrentPlaying ? (
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    ) : (
                      <span className="text-xs font-mono text-neutral-500 group-hover:hidden">
                        {idx + 1}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => playTrack(trk, tracks)}
                      className="hidden group-hover:block text-neutral-300 hover:text-emerald-400"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                    </button>
                  </div>

                  {/* Title & Artist */}
                  <div className="col-span-5 min-w-0 pr-2">
                    <p
                      className={`text-xs font-medium truncate ${
                        isCurrentPlaying ? 'text-emerald-400 font-semibold' : 'text-white'
                      }`}
                    >
                      {trk.title}
                    </p>
                    <p className="text-[11px] text-neutral-400 truncate mt-0.5">
                      {trk.artistCredit || 'Unknown Artist'}
                    </p>
                  </div>

                  {/* Format & Sample Rate */}
                  <div className="col-span-3 min-w-0 flex items-center gap-2">
                    <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-mono text-neutral-300 border border-white/5 truncate">
                      {trk.sampleRateStr || trk.format || 'PCM'}
                    </span>
                    {trk.isHighRes && (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono text-emerald-400 border border-emerald-500/20">
                        Hi-Res
                      </span>
                    )}
                  </div>

                  {/* DR Score */}
                  <div className="col-span-1 text-center">
                    {trk.drScore != null ? (
                      <span
                        className={`text-[11px] font-mono font-semibold ${
                          trk.drScore >= 14
                            ? 'text-emerald-400'
                            : trk.drScore >= 10
                            ? 'text-amber-400'
                            : 'text-neutral-400'
                        }`}
                      >
                        DR{trk.drScore}
                      </span>
                    ) : (
                      <span className="text-neutral-600 font-mono text-xs">-</span>
                    )}
                  </div>

                  {/* Duration */}
                  <div className="col-span-1 text-right text-xs font-mono text-neutral-400">
                    {formatTime(trk.durationSeconds || trk.duration || 0)}
                  </div>

                  {/* Actions */}
                  <div className="col-span-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => {
                        playNext(trk)
                        showToast?.(`Queued "${trk.title}" as next track`)
                      }}
                      className="p-1 text-neutral-400 hover:text-emerald-400 rounded hover:bg-white/5 transition-colors"
                      title="Play Next"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveTrack(idx, trk.title)}
                      className="p-1 text-neutral-400 hover:text-rose-400 rounded hover:bg-white/5 transition-colors"
                      title="Remove from Playlist"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
