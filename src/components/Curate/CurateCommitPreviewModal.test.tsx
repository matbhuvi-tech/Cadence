import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CurateCommitPreviewModal, type CommitPreviewAlbumInput } from './CurateCommitPreviewModal'
import type { CurateDraft } from '../../core/curateDraft'
import type { Release, Track } from '../../core/types'

const rawRelease = { id: 'album-1', title: 'Kind of Blue' } as Release
const rawTracks = [
  { id: 'track-1', title: 'Old Title', filePath: '01.flac', storageMountId: 'mount' },
  { id: 'track-2', title: 'Unchanged', filePath: '02.flac', storageMountId: 'mount' },
] as Track[]

function makeDraft(overrides: Partial<CurateDraft> = {}): CurateDraft {
  return {
    version: 1,
    staged: true,
    baseline: 'baseline-v1',
    fields: { albumTitle: {}, albumArtist: {}, composer: {}, year: {}, coverArt: {}, genre: {} },
    tracks: [
      { trackId: 'track-1', matchedTitle: 'New Title' },
      { trackId: 'track-2', matchedTitle: 'Unchanged' },
    ],
    ...overrides,
  } as CurateDraft
}

describe('CurateCommitPreviewModal', () => {
  it('shows diffs, transport-busy advisory, skips stale albums, and confirms only eligible album IDs', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    const eligibleInput: CommitPreviewAlbumInput = {
      albumId: 'album-1',
      title: 'Kind of Blue',
      draft: makeDraft(),
      rawTracks,
      rawRelease,
      currentBaseline: 'baseline-v1',
    }
    const staleInput: CommitPreviewAlbumInput = {
      albumId: 'album-stale',
      title: 'Stale Album',
      draft: makeDraft({ baseline: 'old-baseline' }),
      rawTracks,
      rawRelease,
      currentBaseline: 'new-baseline',
    }

    render(
      <CurateCommitPreviewModal
        isOpen
        albumsToCommit={[eligibleInput, staleInput]}
        isTransportBusy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('Commit All Preview')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/Playback Active/i)
    expect(screen.getByText('Local tags have changed. Review this album before committing.')).toBeInTheDocument()
    expect(screen.getByText(/Old Title → New Title/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm Commit' }))
    expect(onConfirm).toHaveBeenCalledWith(['album-1'])

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables Confirm Commit when no staged albums are eligible', () => {
    render(
      <CurateCommitPreviewModal
        isOpen
        albumsToCommit={[]}
        isTransportBusy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(/Engine Idle/i)
    expect(screen.getByText('No staged albums.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm Commit' })).toBeDisabled()
  })
})
