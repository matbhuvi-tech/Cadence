import React, { useState, useEffect } from 'react'
import { X, Edit3, Tag, FileText, Trash2, Check } from 'lucide-react'
import { Playlist } from '../../core/types'
import { sqliteLibraryService } from '../../services/sqliteLibraryService'

interface EditPlaylistModalProps {
  isOpen: boolean
  onClose: () => void
  playlist: Playlist | null
  onPlaylistUpdated?: (updated: Playlist) => void
  onPlaylistDeleted?: (id: string) => void
  showToast?: (msg: string) => void
}

export const EditPlaylistModal: React.FC<EditPlaylistModalProps> = ({
  isOpen,
  onClose,
  playlist,
  onPlaylistUpdated,
  onPlaylistDeleted,
  showToast,
}) => {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [listeningNotes, setListeningNotes] = useState('')
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (playlist) {
      setTitle(playlist.title || '')
      setDescription(playlist.description || '')
      setTagsInput(playlist.tags ? playlist.tags.join(', ') : '')
      setListeningNotes(playlist.listeningNotes || '')
      setIsConfirmingDelete(false)
    }
  }, [playlist])

  if (!isOpen || !playlist) return null

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || isSubmitting) return

    setIsSubmitting(true)
    try {
      const parsedTags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const updates: Partial<Playlist> = {
        title: title.trim(),
        description: description.trim() || undefined,
        tags: parsedTags,
        listeningNotes: listeningNotes.trim() || undefined,
      }

      await sqliteLibraryService.updatePlaylist(playlist.id, updates)
      showToast?.(`Updated playlist "${title.trim()}"`)
      onPlaylistUpdated?.({ ...playlist, ...updates })
      onClose()
    } catch (err: any) {
      console.error('[EditPlaylistModal] Failed to update playlist:', err)
      showToast?.(`Failed to update: ${err?.message || err}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!isConfirmingDelete) {
      setIsConfirmingDelete(true)
      return
    }

    try {
      await sqliteLibraryService.deletePlaylist(playlist.id)
      showToast?.(`Deleted playlist "${playlist.title}"`)
      onPlaylistDeleted?.(playlist.id)
      onClose()
    } catch (err: any) {
      console.error('[EditPlaylistModal] Failed to delete playlist:', err)
      showToast?.(`Failed to delete: ${err?.message || err}`)
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
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-800 text-white border border-white/10">
              <Edit3 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-serif font-semibold text-white">Edit Playlist</h2>
              <p className="text-xs text-neutral-400">
                {playlist.tracksCount} tracks • {playlist.formatBreakdown}
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

        {/* Content Form */}
        <form onSubmit={handleSave} className="mt-5 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">
              Playlist Title <span className="text-emerald-400">*</span>
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">Description</label>
            <input
              type="text"
              placeholder="Playlist notes or curation background..."
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
              value={listeningNotes}
              onChange={(e) => setListeningNotes(e.target.value)}
              className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm text-white placeholder-neutral-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
            />
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-white/10">
            <div>
              {isConfirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-rose-400 font-medium">Delete playlist permanently?</span>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="rounded-lg bg-rose-500/20 px-2.5 py-1 text-xs font-medium text-rose-400 hover:bg-rose-500/30 transition-colors"
                  >
                    Confirm Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsConfirmingDelete(false)}
                    className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsConfirmingDelete(true)}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete Playlist
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
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
                className="flex items-center gap-2 rounded-xl bg-white px-5 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
              >
                <Check className="h-4 w-4" />
                {isSubmitting ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
