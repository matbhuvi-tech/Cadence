import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import config from '../../vite.config'

async function run() {
  const handlers = new Map<string, Function>()
  const plugin = (config.plugins as any[]).find(plugin => plugin.name === 'local-library-scanner')
  plugin.configureServer({ middlewares: { use: (route: string, handler: Function) => handlers.set(route, handler) } })
  function request(route: string, query: string, body?: object) {
    const req = Object.assign(new EventEmitter(), { url: '/?' + query, headers: { host: 'localhost' }, method: body ? 'POST' : 'GET' })
    return new Promise<any>(resolve => {
      handlers.get(route)!(req, { setHeader() {}, end: (result: string) => resolve(JSON.parse(result)) })
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
      return Response.json({ results: [{ wrapperType: 'collection', collectionId: 123, collectionName: 'Found', artistName: 'Test' }] })
    }
    const result = await request('/api/itunes-search', 'album=Found&artist=Test&maxRequests=2')
    assert.equal(result.success, true)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /\/lookup\?id=123/)
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
