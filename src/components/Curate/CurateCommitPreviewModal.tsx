import React, { useEffect, useId, useMemo, useRef } from 'react'
import { getCurateCommitPreviewTracks } from '../../core/curateCommit'
import type { CurateDraft } from '../../core/curateDraft'
import type { Release, Track } from '../../core/types'

export interface CommitPreviewAlbumInput {
  albumId: string
  title: string
  draft: CurateDraft
  rawTracks: Track[]
  rawRelease?: Release
  currentBaseline: string
  lineageChanged?: boolean
}

interface PreviewAlbum {
  albumId: string
  title: string
  tracks: ReturnType<typeof getCurateCommitPreviewTracks>
  warning?: string
}

// oxlint-disable-next-line react/only-export-components
export function buildCommitPreviewSummary(
  albumsToCommit: readonly CommitPreviewAlbumInput[], isTransportBusy: boolean,
) {
  const albums = new Map<string, PreviewAlbum>()
  for (const { albumId, title, draft, rawTracks, rawRelease, currentBaseline, lineageChanged } of albumsToCommit) {
    if (!draft.staged || albums.has(albumId)) continue
    const album: PreviewAlbum = { albumId, title, tracks: [] }
    if (lineageChanged || draft.baseline !== currentBaseline) {
      album.warning = 'Local tags have changed. Review this album before committing.'
    } else {
      try {
        album.tracks = getCurateCommitPreviewTracks(draft, rawTracks, rawRelease)
      } catch (error) {
        album.warning = error instanceof Error ? error.message : 'Review this album before committing.'
      }
    }
    albums.set(albumId, album)
  }
  const previews = [...albums.values()]
  return {
    albums: previews,
    eligibleAlbumIds: previews.filter(album => album.tracks.length > 0).map(album => album.albumId),
    modifiedTrackCount: previews.reduce((count, album) => count + album.tracks.length, 0),
    transportMessage: isTransportBusy
      ? 'Playback Active — writes will wait in Commit Queue until playback stops.'
      : 'Engine Idle — writes can begin when the batch is queued.',
  }
}

interface CurateCommitPreviewModalProps {
  isOpen: boolean
  albumsToCommit: readonly CommitPreviewAlbumInput[]
  isTransportBusy: boolean
  onCancel: () => void
  onConfirm: (eligibleAlbumIds: readonly string[]) => void
}

function displayValue(value: string | number | undefined) {
  if (typeof value === 'string' && value.startsWith('data:image/')) return 'Embedded image'
  return value ?? 'No local value'
}

export function CurateCommitPreviewModal({
  isOpen, albumsToCommit, isTransportBusy, onCancel, onConfirm,
}: CurateCommitPreviewModalProps) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const summary = useMemo(
    () => isOpen ? buildCommitPreviewSummary(albumsToCommit, isTransportBusy) : null,
    [albumsToCommit, isOpen, isTransportBusy],
  )
  useEffect(() => {
    const dialog = dialogRef.current
    if (!isOpen || !dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [isOpen])
  if (!summary) return null

  return (
    <dialog ref={dialogRef} aria-labelledby={id} className="m-auto max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-white/15 bg-[#121318] p-5 text-white backdrop:bg-black/70"
      onCancel={event => {
        event.preventDefault()
        onCancel()
      }}>
      <h2 id={id} className="text-base font-semibold">Commit All Preview</h2>
      <p className="mt-1 text-xs text-zinc-300">
        {summary.eligibleAlbumIds.length} {summary.eligibleAlbumIds.length === 1 ? 'album' : 'albums'} · {summary.modifiedTrackCount} modified {summary.modifiedTrackCount === 1 ? 'track' : 'tracks'}
      </p>
      <p role="status" className="my-3 rounded-md bg-white/5 p-2 text-xs text-zinc-200">{summary.transportMessage}</p>
      {summary.albums.length === 0 && <p className="text-sm text-zinc-400">No staged albums.</p>}
      <div className="divide-y divide-white/10">
        {summary.albums.map(album => (
          <section key={album.albumId} className="py-3 text-sm">
            <h3 className="font-medium">{album.title}</h3>
            {album.warning ? (
              <p className="mt-1 text-xs text-amber-300">{album.warning}</p>
            ) : album.tracks.length === 0 ? (
              <p className="mt-1 text-xs text-zinc-400">No changes from physical tags.</p>
            ) : (
              <>
                <p className="mt-1 text-xs text-zinc-400">{album.tracks.length} modified {album.tracks.length === 1 ? 'track' : 'tracks'}</p>
                <ul className="mt-2 space-y-2">
                  {album.tracks.map(track => (
                    <li key={track.trackId} className="rounded-md bg-white/5 px-3 py-2">
                      <p className="font-medium">{track.title}</p>
                      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                        {track.changes.map(change => (
                          <React.Fragment key={change.field}>
                            <dt className="text-zinc-400">{change.field}</dt>
                            <dd className="break-words">{displayValue(change.previous)} → {displayValue(change.selected)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2 border-t border-white/10 pt-3 text-sm">
        <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 hover:bg-white/10">Cancel</button>
        <button type="button" disabled={!summary.eligibleAlbumIds.length} onClick={() => onConfirm(summary.eligibleAlbumIds)}
          className="rounded-md bg-amber-400 px-3 py-1.5 font-medium text-black disabled:opacity-50">Confirm Commit</button>
      </div>
    </dialog>
  )
}
