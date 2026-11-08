import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildCommitPreviewSummary, CurateCommitPreviewModal } from '../components/Curate/CurateCommitPreviewModal'
import type { CurateDraft } from '../core/curateDraft'
import type { Release, Track } from '../core/types'

const rawRelease = { id: 'a', title: 'Harbor' } as Release
const rawTracks = ['Old', 'Unchanged'].map((title, i) => ({
  id: String(i), title, filePath: title + '.wav', storageMountId: 'mount',
})) as Track[]
const draft = {
  version: 1, staged: true, baseline: 'fixture',
  fields: { albumTitle: {}, albumArtist: {}, composer: {}, year: {}, coverArt: {}, genre: {} },
  tracks: [{ trackId: '0', matchedTitle: 'New' }, { trackId: '1', matchedTitle: 'Unchanged' }],
} as CurateDraft
const input = { albumId: 'a', title: rawRelease.title, draft, rawTracks, rawRelease, currentBaseline: 'fixture' }

test('only physically modified tracks are eligible and conflicts stay visible', () => {
  const summary = buildCommitPreviewSummary([
    input, { ...input, albumId: 'b', currentBaseline: 'new baseline' },
    { ...input, albumId: 'c', lineageChanged: true },
    { ...input, albumId: 'd', draft: { ...draft, staged: false } },
  ], false)
  assert.deepEqual(summary.eligibleAlbumIds, ['a'])
  assert.equal(summary.modifiedTrackCount, 1)
  assert.deepEqual(summary.albums[0].tracks[0].changes, [{ field: 'Track title', previous: 'Old', selected: 'New' }])
  assert.equal(summary.albums.length, 3)
  assert.ok(summary.albums[1].warning && summary.albums[2].warning)
})

test('preview explains transport state and prevents confirming an empty batch', () => {
  const props = { isOpen: true, onCancel: () => {}, onConfirm: () => {} }
  const render = (isTransportBusy: boolean) => renderToStaticMarkup(createElement(CurateCommitPreviewModal, {
    ...props, albumsToCommit: [], isTransportBusy,
  }))
  assert.match(render(false), /Engine Idle/)
  assert.match(render(true), /Playback Active.*Commit Queue/)
  assert.match(render(true), /disabled[^>]*>Confirm Commit/)
})
