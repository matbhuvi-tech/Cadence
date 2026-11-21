import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessDelivery, parseDeliverySnapshot, type DeliverySnapshot } from '../core/upnpDelivery'

const sample = (overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  streamId: 1, sampledAtMs: 10000, pacerEnabled: true, state: 'steady_maintain',
  bytesSent: 28000000, realtimeBytesPerSec: 2800000, multiplier: 1,
  writeStalls: 0, scheduleStalls: 0, congestionEvents: 0, flowControlEvents: 0,
  tcpSamples: 10, rttUs: 500, retransBytes: 0,
  capture: null, ...overrides,
})

test('quiet status needs observations; off, stale and stream changes never show healthy', () => {
  assert.equal(assessDelivery(null, null, 0).status, 'assessing')
  assert.equal(assessDelivery(sample(), null, 0).status, 'assessing')
  assert.equal(assessDelivery(sample({ pacerEnabled: false }), null, 0).status, 'off')
  assert.equal(assessDelivery(sample(), sample({ streamId: 2 }), 0).status, 'assessing')
  assert.equal(assessDelivery(sample(), sample({ sampledAtMs: 0, bytesSent: 0 }), 0).status, 'stable')
  assert.equal(assessDelivery(sample({ state: 'initial_fill' }), sample({ sampledAtMs: 0 }), 0).status, 'assessing')
})

test('receiver pressure alone is not congestion or falling behind', () => {
  const result = assessDelivery(sample({ bytesSent: 14000000, flowControlEvents: 4 }), sample({ sampledAtMs: 0, bytesSent: 0 }), 3)
  assert.notEqual(result.status, 'falling_behind')
  assert.match(result.explanation, /receiver/i)
})

test('separates uneven delivery, repeated deficit and local scheduling', () => {
  const previous = sample({ sampledAtMs: 0, bytesSent: 0 })
  assert.equal(assessDelivery(sample({ scheduleStalls: 1 }), previous, 0).status, 'uneven')
  assert.match(assessDelivery(sample({ scheduleStalls: 1 }), previous, 0).explanation, /schedul/i)
  const low = sample({ bytesSent: 14000000, congestionEvents: 2, writeStalls: 2 })
  assert.equal(assessDelivery(low, previous, 0).status, 'uneven')
  assert.equal(assessDelivery(low, previous, 1).status, 'falling_behind')
  assert.equal(assessDelivery(sample({ bytesSent: 0 }), previous, 2).status, 'assessing')
})

test('wire parser rejects malformed, oversized, nonfinite and unsupported snapshots', () => {
  assert.deepEqual(parseDeliverySnapshot(sample()), sample())
  for (const raw of [null, {}, sample({ bytesSent: -1 }), sample({ multiplier: Infinity }),
    sample({ capture: { id: 1, elapsedMs: 60001, complete: false, bins: [] } }),
    sample({ capture: { id: 1, elapsedMs: 1, complete: false, bins: Array(601).fill({}) } }),
  ]) assert.throws(() => parseDeliverySnapshot(raw))
})

test('capture preserves zero-rate gaps and sender timing markers', () => {
  const raw = sample({ capture: { id: 1, elapsedMs: 200, complete: false, bins: [
    { offsetMs: 0, durationMs: 100, bytes: 280000, targetBytesPerSec: 2800000, maxGapUs: 1000 },
    { offsetMs: 100, durationMs: 100, bytes: 0, targetBytesPerSec: 2800000, maxGapUs: 100000 },
  ] } })
  assert.deepEqual(parseDeliverySnapshot(raw).capture?.bins, raw.capture?.bins)
})
