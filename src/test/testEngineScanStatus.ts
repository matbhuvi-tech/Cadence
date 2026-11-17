import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatEngineScanSummary } from '../core/scanStatus'

test('scan summary labels processed items separately from failures', () => {
  assert.equal(
    formatEngineScanSummary({
      status: 'failed',
      processed: 422,
      errors: [
        { path: 'album/track.wav', message: 'Malformed RIFF INFO value' },
      ],
    }),
    'failed · 422 processed · 1 error',
  )
})

test('scan summary supports legacy string errors and pluralizes counts', () => {
  assert.equal(
    formatEngineScanSummary({
      status: 'failed',
      processed: 5,
      errors: ['first', 'second'],
    }),
    'failed · 5 processed · 2 errors',
  )
})

test('scan summary omits counts that are not present', () => {
  assert.equal(formatEngineScanSummary({ status: 'queued' }), 'queued')
})
