import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommitStatusPill, buildCommitQueueDrawerModel } from '../components/CommandBar/CommitStatusPill'
import { CommitQueueDrawer } from '../components/CommandBar/CommitQueueDrawer'
import type { CurateCommitRow } from '../core/curateCommit'

test('Curate can keep the idle queue visible', () => {
  assert.equal(renderToStaticMarkup(createElement(CommitStatusPill, {})), '')
  assert.match(renderToStaticMarkup(createElement(CommitStatusPill, { alwaysVisible: true })), /Commit Queue \(0\)/)
})

test('queue groups only queued and writing tracks by album identity', () => {
  const rows = (['pending', 'in_flight', 'completed', 'failed'] as const).map((status, index): CurateCommitRow => ({
    id: String(index), trackId: String(index), status, payloadJson: JSON.stringify({
      album: 'Album', title: 'Track ' + index,
    }),
  }))
  const catalog = new Map(rows.map(row => [row.trackId, {
    albumId: row.id === '1' ? 'edition-2' : 'edition-1', albumTitle: 'Album', trackTitle: 'Track ' + row.id,
  }]))
  const model = buildCommitQueueDrawerModel(rows, null, catalog)
  assert.deepEqual(model.albums.map(album => album.tracks.map(track => track.statusLabel)), [
    ['Queued'], ['Writing'],
  ])
  assert.equal(model.activeCount, 2)
})

test('pending tracks explain why they are waiting during playback', () => {
  const row: CurateCommitRow = { id: 'row', trackId: 'track', status: 'pending', payloadJson: '{}' }
  const model = buildCommitQueueDrawerModel([row], {
    state: 'paused_playback', pendingItems: 1, inflightItems: 0, completedItems: 0, failedItems: 0,
    totalItems: 1, percent: 0, throughputItemsPerSec: 0, offlineMounts: [],
  })
  assert.equal(model.albums[0].tracks[0].statusLabel, 'Queued — waiting for playback')
})

test('an idle Curate drawer omits the previous batch and its controls', () => {
  const telemetry = {
    state: 'idle' as const, pendingItems: 0, inflightItems: 0, completedItems: 74, failedItems: 3,
    totalItems: 77, percent: 96, throughputItemsPerSec: 0.2, offlineMounts: [],
    activeBatchId: 'previous', activeBatchDescription: 'Previous batch',
  }
  const noop = () => {}
  const html = renderToStaticMarkup(createElement(CommitQueueDrawer, {
    id: 'queue', drawerRef: null, telemetry, model: buildCommitQueueDrawerModel([], telemetry), isCurate: true,
    onClose: noop, onTogglePause: noop, onCancelPending: noop, onUndoBatch: noop, onRetryMounts: noop,
  }))
  assert.match(html, /The queue is empty/)
  assert.doesNotMatch(html, /Previous batch|74 of 77|3 failed|Undo Batch/)
})
