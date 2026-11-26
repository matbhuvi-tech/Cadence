import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { QueueView } from './QueueView'
import type { PlaybackStatus, RemoteQueue } from '../../types/remote'

const stoppedStatus: PlaybackStatus = {
  isPlaying: false,
  isPaused: false,
  positionSecs: 0,
  durationSecs: 0,
  volume: 100,
  purityMode: true,
  isBitPerfect: true,
  activeDevice: 'Chord Hugo 2',
  currentFile: '',
} as PlaybackStatus

const sampleQueue: RemoteQueue = {
  currentIndex: 0,
  repeatMode: 'off',
  isShuffle: false,
  revision: 1,
  items: [
    {
      id: 't1',
      queueEntryId: 'qe-1',
      title: 'So What',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      durationSecs: 562,
      isHighRes: true,
    },
    {
      id: 't2',
      queueEntryId: 'qe-2',
      title: 'Freddie Freeloader',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      durationSecs: 586,
      isHighRes: false,
    },
  ],
} as RemoteQueue

describe('QueueView', () => {
  it('renders empty state when queue has no items', () => {
    render(
      <QueueView
        queue={{ currentIndex: 0, repeatMode: 'off', isShuffle: false, revision: 0, items: [] }}
        status={stoppedStatus}
        onJumpToIndex={vi.fn()}
        onRemoveFromQueue={vi.fn()}
        onClearQueue={vi.fn()}
      />,
    )

    expect(screen.getByText('Queue is empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Clear/i })).not.toBeInTheDocument()
  })

  it('supports jumping to a track, removing a track, clearing the queue, resuming stopped playback, and dismissing conflicts', async () => {
    const user = userEvent.setup()
    const onJumpToIndex = vi.fn()
    const onRemoveFromQueue = vi.fn()
    const onClearQueue = vi.fn()
    const onResumePlayback = vi.fn()
    const onClearConflict = vi.fn()

    render(
      <QueueView
        queue={sampleQueue}
        status={stoppedStatus}
        conflictMessage="Queue modified by Desktop controller"
        onClearConflict={onClearConflict}
        onResumePlayback={onResumePlayback}
        onJumpToIndex={onJumpToIndex}
        onRemoveFromQueue={onRemoveFromQueue}
        onClearQueue={onClearQueue}
      />,
    )

    expect(screen.getByText('HI-RES')).toBeInTheDocument()
    expect(screen.getByText('Queue modified by Desktop controller')).toBeInTheDocument()

    await user.click(screen.getByText('Freddie Freeloader'))
    expect(onJumpToIndex).toHaveBeenCalledWith(1, 'qe-2')

    const removeButtons = screen.getAllByTitle('Remove from queue')
    await user.click(removeButtons[0])
    expect(onRemoveFromQueue).toHaveBeenCalledWith(0, 't1', 'qe-1')

    await user.click(screen.getByRole('button', { name: /Resume/i }))
    expect(onResumePlayback).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClearConflict).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Clear/i }))
    expect(onClearQueue).toHaveBeenCalledTimes(1)
  })
})
