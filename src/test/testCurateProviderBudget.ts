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
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousKey
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
