import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CurateCommitOutcomes } from '../components/Curate/CurateCommitOutcomes'
import type { CurateCommitRow } from '../core/curateCommit'

const tracks = ['Written song', 'Waiting song', 'Writing song', 'Failed song', 'Unqueued song']
  .map((localTitle, index) => ({ trackId: String(index), localTitle }))
const rows: CurateCommitRow[] = ['completed', 'pending', 'in_flight', 'failed'].map((status, index) => ({
  id: `item-${index}`, trackId: String(index), status: status as CurateCommitRow['status'],
  payloadJson: '{}', errorMessage: status === 'failed' ? 'Disk unavailable <retry>' : null,
}))

test('shows individual mixed outcomes and preserves every failure reason safely', () => {
  const html = renderToStaticMarkup(createElement(CurateCommitOutcomes, { tracks, rows }))
  for (const label of ['1 complete', '1 waiting', '1 writing', '1 failed', '1 without a current commit',
    'Written song', 'Waiting song', 'Writing song', 'Failed song', 'Unqueued song',
    'Complete', 'Waiting', 'Writing', 'Failed', 'No current commit', 'Disk unavailable &lt;retry&gt;']) {
    assert.ok(html.includes(label), `Missing ${label}`)
  }
})

test('does not show another album or invent cancellation for tracks missing queue records', () => {
  assert.equal(renderToStaticMarkup(createElement(CurateCommitOutcomes, {
    tracks, rows: [{ ...rows[0], trackId: 'other-album' }],
  })), '')
})

test('shows the latest projected outcome once per track', () => {
  const html = renderToStaticMarkup(createElement(CurateCommitOutcomes, {
    tracks: [tracks[0]], rows: [rows[0], { ...rows[0], id: 'replacement', status: 'pending' }],
  }))
  assert.ok(html.includes('1 waiting'))
  assert.ok(!html.includes('1 complete'))
  assert.equal(html.split('Written song').length - 1, 1)
})
