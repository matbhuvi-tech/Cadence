import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommitQueueDrawer, buildCommitQueueDrawerModel } from './CommitQueueDrawer'
import type { CurateCommitRow } from '../../core/curateCommit'
import type { CommitTelemetryPayload } from '../../types/commit'

const baseTelemetry: CommitTelemetryPayload = {
  state: 'writing',
  pendingItems: 2,
  inflightItems: 1,
  completedItems: 1,
  failedItems: 0,
  totalItems: 4,
  percent: 25,
  throughputItemsPerSec: 1.5,
  offlineMounts: [],
  activeBatchId: 'batch-42',
  activeBatchDescription: 'Curate Tag Commit',
  currentTrackTitle: 'Track Alpha',
  currentTrackFilePath: 'E:\\Music\\Album\\01.flac',
}

describe('CommitQueueDrawer', () => {
  it('renders active batch progress and invokes Pause, Cancel Pending, Undo Batch, and Close', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onTogglePause = vi.fn()
    const onCancelPending = vi.fn()
    const onUndoBatch = vi.fn()
    const onRetryMounts = vi.fn()

    const rows: CurateCommitRow[] = [
      { id: 'r1', trackId: 't1', status: 'in_flight', payloadJson: JSON.stringify({ album: 'Kind of Blue', title: 'So What' }) },
      { id: 'r2', trackId: 't2', status: 'pending', payloadJson: JSON.stringify({ album: 'Kind of Blue', title: 'Blue in Green' }) },
    ]
    const model = buildCommitQueueDrawerModel(rows, baseTelemetry)

    render(
      <CommitQueueDrawer
        id="commit-queue"
        drawerRef={null}
        telemetry={baseTelemetry}
        model={model}
        isCurate
        onClose={onClose}
        onTogglePause={onTogglePause}
        onCancelPending={onCancelPending}
        onUndoBatch={onUndoBatch}
        onRetryMounts={onRetryMounts}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Commit Queue' })).toBeInTheDocument()
    expect(screen.getByText('1 of 4 saved (25%)')).toBeInTheDocument()
    expect(screen.getByText('So What')).toBeInTheDocument()
    expect(screen.getByText('Writing')).toBeInTheDocument()
    expect(screen.getByText('Blue in Green')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Pause/i }))
    expect(onTogglePause).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Cancel Pending/i }))
    expect(onCancelPending).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Undo Batch/i }))
    expect(onUndoBatch).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Close Commit Queue' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows Resume when user_paused and Retry Mount Connection when a mount is offline', async () => {
    const user = userEvent.setup()
    const onTogglePause = vi.fn()
    const onRetryMounts = vi.fn()

    const offlineTelemetry: CommitTelemetryPayload = {
      ...baseTelemetry,
      state: 'user_paused',
      offlineMounts: ['Z:\\NAS-Audio'],
    }
    const model = buildCommitQueueDrawerModel([], offlineTelemetry)

    render(
      <CommitQueueDrawer
        id="commit-queue"
        drawerRef={null}
        telemetry={offlineTelemetry}
        model={model}
        isCurate={false}
        onClose={vi.fn()}
        onTogglePause={onTogglePause}
        onCancelPending={vi.fn()}
        onUndoBatch={vi.fn()}
        onRetryMounts={onRetryMounts}
      />,
    )

    expect(screen.getByText('Drive Offline')).toBeInTheDocument()
    expect(screen.getByText('Z:\\NAS-Audio')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry Mount Connection' }))
    expect(onRetryMounts).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Resume/i }))
    expect(onTogglePause).toHaveBeenCalledTimes(1)
  })

  it('renders Recently Finished receipts for idle external engine and supports Clear', async () => {
    const user = userEvent.setup()
    const onClearRecent = vi.fn()

    const finishedRows: CurateCommitRow[] = [
      { id: 'j1', trackId: 't1', status: 'completed', payloadJson: JSON.stringify({ album: 'Aja', title: 'Black Cow' }) },
      { id: 'j2', trackId: 't2', status: 'failed', payloadJson: JSON.stringify({ album: 'Aja', title: 'Deacon Blues' }), errorMessage: 'Read-only mount' },
    ]
    const idleTelemetry: CommitTelemetryPayload = {
      state: 'idle',
      pendingItems: 0,
      inflightItems: 0,
      completedItems: 1,
      failedItems: 1,
      totalItems: 2,
      percent: 50,
      throughputItemsPerSec: 0,
      offlineMounts: [],
    }
    const model = buildCommitQueueDrawerModel(finishedRows, idleTelemetry)

    render(
      <CommitQueueDrawer
        id="commit-queue"
        drawerRef={null}
        telemetry={idleTelemetry}
        model={model}
        isCurate
        isExternalEngine
        onClose={vi.fn()}
        onClearRecent={onClearRecent}
        onTogglePause={vi.fn()}
        onCancelPending={vi.fn()}
        onUndoBatch={vi.fn()}
        onRetryMounts={vi.fn()}
      />,
    )

    expect(screen.getByText('Recently Finished')).toBeInTheDocument()
    expect(screen.getByText('1 saved · 1 failed')).toBeInTheDocument()
    expect(screen.getByText('Read-only mount')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pause/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClearRecent).toHaveBeenCalledTimes(1)
  })
})
