import React, { useState, useEffect } from 'react'
import { X, Plus, Check, ListPlus, Music, Sparkles } from 'lucide-react'
import { Track, Playlist } from '../../core/types'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'

interface AddTracksToPlaylistModalProps {
  isOpen: boolean
  onClose: () => void
  tracksToAdd: Track[]
  onOpenCreateNew?: () => void
  showToast?: (msg: string) => void
}

export const AddTracksToPlaylistModal: React.FC<AddTracksToPlaylistModalProps> = ({
  isOpen,
  onClose,
  tracksToAdd,
  onOpenCreateNew,
  showToast,
}) => {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [addingToId, setAddingToId] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      loadPlaylists()
    }
  }, [isOpen])

  const loadPlaylists = async () => {
    setIsLoading(true)
    try {
      const data = await sqliteLibraryService.getPlaylists()
      setPlaylists(data)
    } catch (err) {
      console.error('[AddTracksToPlaylistModal] Failed to load playlists:', err)
    } finally {
      setIsLoading(false)
    }
  }

  if (!isOpen) return null

  const handleSelectPlaylist = async (playlist: Playlist) => {
    if (tracksToAdd.length === 0 || addingToId) return

    setAddingToId(playlist.id)
    try {
      await sqliteLibraryService.addTracksToPlaylist(playlist.id, tracksToAdd)
      showToast?.(`Added ${tracksToAdd.length} track${tracksToAdd.length === 1 ? '' : 's'} to "${playlist.title}"`)
      onClose()
    } catch (err: any) {
      console.error('[AddTracksToPlaylistModal] Failed to add tracks:', err)
      showToast?.(`Failed to add tracks: ${err?.message || err}`)
    } finally {
      setAddingToId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fadeIn">
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c0d10] p-6 shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <ListPlus className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-serif font-semibold text-white">Add to Playlist</h2>
              <p className="text-xs text-neutral-400">
                {tracksToAdd.length} track{tracksToAdd.length === 1 ? '' : 's'} selected
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action: Create New Playlist */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => {
              onClose()
              onOpenCreateNew?.()
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 py-2.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/50 transition-all"
          >
            <Plus className="h-4 w-4" />
            Create New Playlist With Selected Tracks
          </button>
        </div>

        {/* Existing Playlists List */}
        <div className="mt-4 max-h-72 overflow-y-auto space-y-2 pr-1">
          {isLoading ? (
            <div className="py-8 text-center text-xs text-neutral-500">Loading playlists...</div>
          ) : playlists.length === 0 ? (
            <div className="py-8 text-center text-xs text-neutral-500">
              No playlists found. Create your first playlist above!
            </div>
          ) : (
            playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => handleSelectPlaylist(pl)}
                disabled={addingToId === pl.id}
                className="group flex w-full items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] p-3 text-left hover:border-emerald-500/30 hover:bg-white/[0.05] transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 border border-white/10 text-neutral-400 group-hover:text-emerald-400 group-hover:border-emerald-500/30 transition-colors">
                    {pl.coverArtUrl ? (
                      <img src={pl.coverArtUrl} alt="" className="h-full w-full rounded-lg object-cover" />
                    ) : (
                      <Music className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate group-hover:text-emerald-400 transition-colors">
                      {pl.title}
                    </p>
                    <p className="text-xs text-neutral-400 truncate">
                      {pl.tracksCount} tracks • {pl.formatBreakdown}
                    </p>
                  </div>
                </div>

                <div className="flex-shrink-0 ml-3">
                  {addingToId === pl.id ? (
                    <span className="text-xs text-emerald-400 animate-pulse">Adding...</span>
                  ) : (
                    <Plus className="h-4 w-4 text-neutral-500 group-hover:text-emerald-400 transition-colors" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end pt-4 mt-4 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs text-neutral-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
