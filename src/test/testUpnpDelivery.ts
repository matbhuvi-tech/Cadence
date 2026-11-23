import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessDelivery, parseDeliverySnapshot, type DeliverySnapshot } from '../core/upnpDelivery'
import { createDeliveryCapture } from '../services/upnpDeliveryCapture'
import { createEngineClient } from '../services/engineClient'

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
  assert.equal(result.status, 'stable')
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
    { offsetMs: 0, durationMs: 100, bytes: 280000, targetBytesPerSec: 2800000, maxGapUs: 1000, maxDelayUs: 0 },
    { offsetMs: 100, durationMs: 100, bytes: 0, targetBytesPerSec: 2800000, maxGapUs: 100000, maxDelayUs: 90000 },
  ] } })
  assert.deepEqual(parseDeliverySnapshot(raw).capture?.bins, raw.capture?.bins)
})

test('capture batches at five seconds and stops after freeze, expiry or replacement', async () => {
  const calls: Record<string, unknown>[] = []
  let timer: (() => void) | null = null
  let delay = 0
  const updates: DeliverySnapshot[] = []
  const capture = { id: 5, elapsedMs: 0, complete: false, bins: [] }
  const request = async (options: Record<string, unknown>) => { calls.push(options); return sample({ capture }) }
  const stop = createDeliveryCapture(request, s => updates.push(s), assert.fail, {
    schedule: (callback, ms) => { timer = callback; delay = ms; return () => { timer = null } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].captureAction, 'start')
  assert.equal(delay, 5000)
  assert.equal(updates.length, 1)
  const tick = timer as unknown as () => void
  tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[1].captureId, 5)
  stop()
  assert.equal(timer, null)
  assert.equal(calls.at(-1)?.captureAction, 'stop')
  assert.equal(calls.at(-1)?.captureId, 5)
})

test('closing before start resolves stops the late capture without publishing it', async () => {
  let resolve!: (value: DeliverySnapshot) => void
  const calls: Record<string, unknown>[] = []
  const pending = new Promise<DeliverySnapshot>(r => { resolve = r })
  const stop = createDeliveryCapture(options => {
    calls.push(options)
    return options.captureAction === 'start' ? pending : Promise.resolve(sample())
  }, () => assert.fail('late response published'), assert.fail)
  stop()
  resolve(sample({ capture: { id: 9, elapsedMs: 0, complete: false, bins: [] } }))
  await new Promise(r => setImmediate(r))
  assert.equal(calls[1].captureAction, 'stop')
  assert.equal(calls[1].captureId, 9)
})

test('engine API uses the selected identity and never trusts malformed telemetry', async () => {
  const calls: Record<string, unknown>[] = []
  const client = createEngineClient({ engineId: 'engine-a', libraryId: 'library-a', baseUrl: 'https://engine.invalid', label: 'Engine' },
    async (_target, body) => { calls.push(body); return { ok: true, data: body.operation === 'player.upnp_pacer' ? { pacerEnabled: false } : sample() } })
  await client.getUpnpDelivery()
  assert.equal(calls[0].engineId, 'engine-a')
  assert.equal(calls[0].operation, 'player.upnp_delivery')
  assert.equal(await client.setUpnpPacer(false), false)
  assert.equal(calls[1].enabled, false)
})

test('expired captures do not schedule more work and replacements/errors stop safely', async () => {
  for (const scenario of ['expired', 'replaced', 'failure'] as const) {
    const calls: Record<string, unknown>[] = []
    let scheduled = 0, errors = 0, updates = 0
    const stop = createDeliveryCapture(async options => {
      calls.push(options)
      if (options.captureAction === 'stop') return sample()
      if (scenario === 'failure') throw new Error('offline')
      return sample({ capture: scenario === 'replaced' ? null : { id: 3, elapsedMs: 60000, complete: true, bins: [] } })
    }, () => updates++, () => errors++, { schedule: () => { scheduled++; return () => {} } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(scheduled, 0)
    assert.equal(updates, scenario === 'expired' ? 1 : 0)
    assert.equal(errors, scenario === 'expired' ? 0 : 1)
    stop(); stop()
    assert.ok(calls.length <= 2)
  }
})

test('short, stale, reset and unknown delivery windows remain unassessed', () => {
  const prev = sample({ sampledAtMs: 0, bytesSent: 0 })
  for (const current of [sample({ sampledAtMs: 1000 }), sample({ sampledAtMs: 30000 }),
    sample({ realtimeBytesPerSec: 0 }), sample({ sampledAtMs: 0 }),
  ]) assert.equal(assessDelivery(current, prev, 0).status, 'assessing')
  assert.equal(assessDelivery(sample({ bytesSent: 10 }), sample(), 0).status, 'assessing')
  assert.match(assessDelivery(sample({ writeStalls: 1 }), prev, 0).explanation, /uncertain/i)
  assert.match(assessDelivery(sample({ bytesSent: 1000000 }), prev, 0).explanation, /buffering/i)
})

test('wire parser rejects invalid bins and the RPC client propagates errors', async () => {
  const bin = { offsetMs: 0, durationMs: 100, bytes: 10, targetBytesPerSec: 100, maxGapUs: 100, maxDelayUs: 0 }
  for (const bins of [[{ ...bin, durationMs: 0 }], [{ ...bin, maxDelayUs: NaN }], [bin, bin], [{ ...bin, offsetMs: 101 }]]) {
    assert.throws(() => parseDeliverySnapshot(sample({ capture: { id: 1, elapsedMs: 100, complete: true, bins } })))
  }
  const profile = { engineId: 'a', libraryId: 'b', baseUrl: 'https://engine.invalid', label: 'Engine' }
  for (const data of [null, {}, { pacerEnabled: 'false' }]) {
    const client = createEngineClient(profile, async () => ({ ok: true, data }))
    await assert.rejects(client.getUpnpDelivery())
    await assert.rejects(client.setUpnpPacer(false))
  }
  const offline = createEngineClient(profile, async () => ({ ok: false, error: { code: 'unavailable' } }))
  await assert.rejects(offline.getUpnpDelivery())
})

test('TCP observations alone preserve steady pacing', () => {
 const prev = sample({ sampledAtMs: 0, bytesSent: 0 })
 assert.equal(assessDelivery(sample({ retransBytes: 100 }), prev, 0).status, 'stable')
})
