import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import config from '../../vite.config'

async function run() {
  const handlers = new Map<string, Function>()
  const plugin = (config.plugins as any[]).find(plugin => plugin.name === 'local-library-scanner')
  plugin.configureServer({ middlewares: { use: (route: string, handler: Function) => handlers.set(route, handler) } })
  function request(route: string, query: string, body?: object, signal?: AbortSignal) {
    const req = Object.assign(new EventEmitter(), { url: '/?' + query, headers: { host: 'localhost' }, method: body ? 'POST' : 'GET' })
    return new Promise<any>((resolve, reject) => {
      const res = Object.assign(new EventEmitter(), {
        destroyed: false, setHeader() {}, end: (result: string) => resolve(JSON.parse(result)),
      })
      signal?.addEventListener('abort', () => {
        res.destroyed = true
        res.emit('close')
      }, { once: true })
      void Promise.resolve(handlers.get(route)!(req, res)).then(() => {
        if (res.destroyed) resolve(null)
      }, reject)
      if (body) {
        req.emit('data', JSON.stringify(body))
        req.emit('end')
      }
    })
  }

  const previousFetch = globalThis.fetch
  const realNow = Date.now
  const previousKey = process.env.GEMINI_API_KEY
  const calls: string[] = []
  process.env.GEMINI_API_KEY = 'test-key'
  globalThis.fetch = async input => {
    calls.push(String(input))
    return String(input).includes('generateContent')
      ? Response.json({ error: { message: 'Rate limit' } }, { status: 429 })
      : Response.json({})
  }
  try {
    await Promise.all([
      request('/api/itunes-search', 'album=Missing&artist=Test&maxRequests=1'),
      request('/api/musicbrainz-search', 'album=Missing&artist=Test&maxRequests=2'),
      request('/api/ai-compilation-resolver', 'singleAttempt=1', {
        albumTitle: 'Missing', tracks: [{ title: 'Song' }],
      }),
    ])
    assert.equal(calls.filter(url => url.includes('itunes.apple.com')).length, 1)
    assert.equal(calls.filter(url => url.includes('musicbrainz.org')).length, 2)
    assert.equal(calls.filter(url => url.includes('generateContent')).length, 1)
    const compilation = { albumTitle: 'Missing', tracks: [{ title: 'Song' }] }
    const firstModel = new URL(calls.find(url => url.includes('generateContent'))!).pathname
    globalThis.fetch = async input => {
      calls.push(String(input))
      return Response.json({ candidates: [{ content: { parts: [{ text: '[]' }] } }] })
    }
    const fallback = await request('/api/ai-compilation-resolver', 'singleAttempt=1', compilation)
    assert.equal(fallback.success, true)
    assert.notEqual(new URL(calls.at(-1)!).pathname, firstModel, 'skip the model throttled by the previous request')
    const quota = await request('/api/ai-quota-telemetry', '')
    assert.equal(quota.currentModel, fallback.telemetry.modelUsed)
    assert.equal(quota.models.find((model: any) => firstModel.endsWith('/' + model.model + ':generateContent')).reason, 'rate_limit')

    // Use a controlled clock for pacing and reset tests. No real Gemini calls are sent.
    let time = realNow() + 10_000
    Date.now = () => time
    process.env.GEMINI_API_KEY = 'test-daily-scope'
    calls.length = 0
    globalThis.fetch = async input => {
      calls.push(String(input))
      if (calls.length === 1) {
        time += 4000
        return Response.json({ error: { details: [{
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaValue: '20',
            quotaDimensions: { model: 'gemini-3.5-flash-lite' } }],
        }] } }, { status: 429 })
      }
      return Response.json({ modelVersion: 'fixture-actual-model', candidates: [{ content: { parts: [{ text: '[]' }] } }] })
    }
    const daily = await request('/api/ai-compilation-resolver', 'attemptBudget=2', compilation)
    assert.equal(daily.telemetry.retriesAttempted, 1)
    assert.equal(daily.telemetry.modelUsed, 'fixture-actual-model')
    assert.equal(calls.length, 2)
    assert.notEqual(new URL(calls[1]).pathname, '/v1beta/models/gemini-3.5-flash-lite:generateContent')
    const dailyQuota = await request('/api/ai-quota-telemetry', '')
    assert.equal(dailyQuota.currentModel, 'fixture-actual-model')
    const dailyBlock = dailyQuota.models.find((model: any) => model.model === 'gemini-3.5-flash-lite')
    assert.equal(dailyBlock.reason, 'daily_quota')
    assert.equal(dailyBlock.observedLimit, '20')
    assert.ok(dailyBlock.blockedUntil > time)

    process.env.GEMINI_API_KEY = 'test-shared-scope'
    time += 4000
    calls.length = 0
    globalThis.fetch = async input => {
      calls.push(String(input))
      return Response.json({ error: { details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'SpendPerProject' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' },
      ] } }, { status: 429, headers: { 'Retry-After': '120' } })
    }
    const [limitedGemini, queued] = await Promise.all([
      request('/api/ai-compilation-resolver', 'attemptBudget=3', compilation),
      request('/api/ai-compilation-resolver', 'attemptBudget=3', compilation),
    ])
    assert.equal(calls.length, 1, 'queued work must respect a project-wide 429')
    assert.equal(limitedGemini.code, 'RATE_LIMIT_429')
    assert.equal(queued.retryAt, time + 120_000)
    assert.equal((await request('/api/ai-quota-telemetry', '')).projectBlock.blockedUntil, queued.retryAt)
    time = queued.retryAt + 4000
    calls.length = 0
    let started!: () => void
    let finish!: (response: Response) => void
    const fetching = new Promise<void>(resolve => { started = resolve })
    globalThis.fetch = input => {
      calls.push(String(input))
      started()
      return new Promise(resolve => { finish = resolve })
    }
    const recovering = request('/api/ai-compilation-resolver', 'attemptBudget=2', compilation)
    await fetching
    const active = await request('/api/ai-quota-telemetry', '')
    assert.ok(active.inFlightModel)
    assert.equal(active.currentModel, active.inFlightModel)
    const cancel = new AbortController()
    const cancelled = request('/api/ai-compilation-resolver', 'attemptBudget=2', compilation, cancel.signal)
    cancel.abort()
    assert.equal(await cancelled, null)
    assert.equal(calls.length, 1, 'cancelling queued work must not send another request')
    finish(Response.json({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }))
    assert.equal((await recovering).success, true)
    const recovered = await request('/api/ai-quota-telemetry', '')
    assert.equal(recovered.inFlightModel, null)
    assert.equal(recovered.currentModel, active.currentModel)
    assert.equal(recovered.projectBlock, undefined)
    Date.now = realNow

    calls.length = 0
    globalThis.fetch = async input => {
      calls.push(String(input))
      return Response.json({ results: String(input).includes('/lookup?')
        ? [{ wrapperType: 'collection', collectionId: 123, collectionName: 'Found', artistName: 'Test' },
          { wrapperType: 'track', trackNumber: 1, trackName: 'First song', artistName: 'Singer' }]
        : [{ wrapperType: 'collection', collectionId: 123, collectionName: 'Found', artistName: 'Test' }] })
    }
    const result = await request('/api/itunes-search', 'album=Found&artist=Test&maxRequests=2')
    assert.equal(result.success, true)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /\/lookup\?id=123/)
    assert.deepEqual(result.tracks, [{ trackNumber: 1, trackName: 'First song', artistName: 'Singer' }])

    calls.length = 0
    const oneSearch = await request('/api/itunes-search', 'album=Found&artist=Test&maxRequests=1')
    assert.equal(oneSearch.tracks.length, 1)
    assert.equal(calls.length, 2, 'track lookup is required after a successful search')

    calls.length = 0
    const knownRelease = await request('/api/itunes-search', 'releaseId=123&refresh=1')
    assert.equal(knownRelease.results.filter((row: { wrapperType: string }) => row.wrapperType === 'track').length, 1)
    assert.deepEqual(calls.map(url => new URL(url).pathname), ['/lookup'])

    const successfulApple = globalThis.fetch
    let limited = false
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/lookup?') && !limited) {
        calls.push(String(input))
        limited = true
        return new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
      }
      return successfulApple(input, init)
    }
    calls.length = 0
    const refresh = await request('/api/itunes-search', 'album=Found&artist=Test&maxRequests=6&refresh=1')
    assert.equal(refresh.tracks.length, 1)
    assert.deepEqual(calls.map(url => new URL(url).pathname), ['/search', '/lookup', '/lookup'])

    const controller = new AbortController()
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/lookup?')) {
        calls.push(String(input))
        setTimeout(() => controller.abort(), 20)
        return new Response(null, { status: 429, headers: { 'Retry-After': '60' } })
      }
      return successfulApple(input, init)
    }
    calls.length = 0
    assert.equal(await request('/api/itunes-search', 'album=Found&artist=Test&maxRequests=6&refresh=1', undefined, controller.signal), null)
    assert.deepEqual(calls.map(url => new URL(url).pathname), ['/search', '/lookup'])

    globalThis.fetch = async (input, init) => String(input).includes('/lookup?')
      ? new Response(null, { status: 503 })
      : successfulApple(input, init)
    const incomplete = await request('/api/itunes-search', 'album=Found&artist=Test&maxRequests=6&refresh=1')
    assert.equal(incomplete.success, false)
    assert.match(incomplete.message, /track lookup/)
  } finally {
    Date.now = realNow
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousKey
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
