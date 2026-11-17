import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatEngineScanSummary } from '../core/scanStatus'

test('scan summary labels processed items separately from failures', () => {
  assert.equal(
    formatEngineScanSummary({
      status: 'failed',
      processed: 422,
      errorCount: 1,
      errors: [
        { path: 'album/track.wav', message: 'Malformed RIFF INFO value' },
      ],
    }),
    'failed · 422 items processed · 1 error',
  )
})

test('scan summary uses the full error count when retained details are capped', () => {
  assert.equal(
    formatEngineScanSummary({
      status: 'failed',
      processed: 422,
      errorCount: 137,
      errors: Array.from({ length: 100 }, (_, index) => `error ${index}`),
    }),
    'failed · 422 items processed · 137 errors',
  )
})

test('scan summary supports legacy string errors and pluralizes counts', () => {
  assert.equal(
    formatEngineScanSummary({
      status: 'failed',
      processed: 5,
      errors: ['first', 'second'],
    }),
    'failed · 5 items processed · 2 errors',
  )
})

test('scan summary omits counts that are not present', () => {
  assert.equal(formatEngineScanSummary({ status: 'queued' }), 'queued')
})
