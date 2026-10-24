import React, { useState } from 'react'
import { X, ListMusic, Tag, FileText, Music, Sparkles } from 'lucide-react'
import { Track, Playlist, Release } from '../../core/types'
import { sqliteLibraryService, generatePlaylist4GridArtwork, computePlaylistFormatBreakdown } from '../../services/sqliteLibraryService'

interface CreatePlaylistModalProps {
  isOpen: boolean
  onClose: () => void
  initialTracks?: Track[]
  allReleases?: Release[]
  onPlaylistCreated?: (playlist: Playlist) => void
  showToast?: (msg: string) => void
}

export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
  isOpen,
  onClose,
  initialTracks = [],
  allReleases = [],
  onPlaylistCreated,
  showToast,
}) => {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [listeningNotes, setListeningNotes] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!isOpen) return null

  const gridArtwork = generatePlaylist4GridArtwork(initialTracks, allReleases)
  const formatBreakdown = computePlaylistFormatBreakdown(initialTracks)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || isSubmitting) return

    setIsSubmitting(true)
    try {
      const parsedTags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const trackIds = initialTracks.map((t) => t.id)
      const coverArtUrl = gridArtwork.length > 0 ? gridArtwork[0] : undefined

      const newPlaylist = await sqliteLibraryService.createPlaylist({
        title: title.trim(),
        description: description.trim() || undefined,
        coverArtUrl,
        tags: parsedTags,
        listeningNotes: listeningNotes.trim() || undefined,
        trackIds,
        tracks: initialTracks,
      })

      showToast?.(`Created playlist "${newPlaylist.title}" with ${initialTracks.length} tracks`)
      onPlaylistCreated?.(newPlaylist)
      onClose()
      setTitle('')
      setDescription('')
      setTagsInput('')
      setListeningNotes('')
    } catch (err: any) {
      console.error('[CreatePlaylistModal] Failed to create playlist:', err)
      showToast?.(`Failed to create playlist: ${err?.message || err}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fadeIn">
      <div
        className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0c0d10] p-6 shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <ListMusic className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-serif font-semibold text-white">Create New Playlist</h2>
              <p className="text-xs text-neutral-400">Curate bit-perfect albums and tracks for targeted listening</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* Cover Art & Breakdown Preview */}
          {initialTracks.length > 0 && (
            <div className="flex items-center gap-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
              {/* 4-Grid Thumbnail */}
              <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-neutral-900 border border-white/10 grid grid-cols-2 grid-rows-2">
                {gridArtwork.length >= 4 ? (
                  gridArtwork.slice(0, 4).map((art, idx) => (
                    <img key={idx} src={art} alt="" className="h-full w-full object-cover" />
                  ))
                ) : gridArtwork.length > 0 ? (
                  <img src={gridArtwork[0]} alt="" className="col-span-2 row-span-2 h-full w-full object-cover" />
                ) : (
                  <div className="col-span-2 row-span-2 flex items-center justify-center text-neutral-600">
                    <Music className="h-6 w-6" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-emerald-400 uppercase tracking-wider">
                    {formatBreakdown}
                  </span>
                </div>
                <p className="text-xs text-neutral-400 truncate mt-0.5">
                  Pre-staging {initialTracks.length} track{initialTracks.length === 1 ? '' : 's'} from queue/selection
                </p>
              </div>
            </div>
          )}

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">
              Playlist Title <span className="text-emerald-400">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              placeholder="e.g. Late Night DSD Sessions"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">Description (Optional)</label>
            <input
              type="text"
              placeholder="e.g. Uncompressed acoustic and chamber jazz recordings"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
            />
          </div>

          {/* Tags */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300 mb-1.5">
              <Tag className="h-3.5 w-3.5 text-neutral-400" /> Tags (Comma separated)
            </label>
            <input
              type="text"
              placeholder="e.g. DSD, Reference, Acoustic, Night"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
            />
          </div>

          {/* Listening Notes */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300 mb-1.5">
              <FileText className="h-3.5 w-3.5 text-neutral-400" /> Audiophile Listening Notes & DAC Recommendations
            </label>
            <textarea
              rows={3}
              placeholder="e.g. Best experienced via WASAPI Exclusive on Holo Audio May (NOS Mode). Zero software volume attenuation."
              value={listeningNotes}
              onChange={(e) => setListeningNotes(e.target.value)}
              className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
            />
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-sm text-neutral-400 hover:bg-white/5 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || isSubmitting}
              className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-emerald-500/20"
            >
              <Sparkles className="h-4 w-4" />
              {isSubmitting ? 'Creating...' : 'Create Playlist'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
