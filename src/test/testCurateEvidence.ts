import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchCurateCandidate } from '../services/curateEvidenceService'

test('records real outcomes and excludes provider response bodies from the history payload', async () => {
  const attempts: Array<{ outcome: string; httpStatus?: number; durationMs: number }> = []
  const record = (attempt: typeof attempts[number]) => attempts.push(attempt)
  const lookup = (response: Response) => fetchCurateCandidate(
    'musicbrainz', 'Album', async () => response, data => data.success ? data.title : null, record,
  )
  assert.equal(await lookup(new Response('{"success":true,"title":"Match","secret":"sample"}')), 'Match')
  assert.equal(await lookup(new Response('unavailable', { status: 503 })), null)
  assert.equal(await lookup(new Response('{"success":false}')), null)
  assert.equal(await lookup(new Response('<html>')), null)
  assert.deepEqual(attempts.map(a => [a.outcome, a.httpStatus]),
    [['success', 200], ['http_error', 503], ['empty', 200], ['parse_error', 200]])
  assert.ok(attempts.every(a => a.durationMs >= 0))
  assert.ok(!JSON.stringify(attempts).includes('secret'))
})

test('records a cancelled attempt without starting the provider request', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  let outcome: string | undefined
  const result = await fetchCurateCandidate('apple', 'Album', async () => {
    called = true
    return new Response('{}')
  }, () => null, attempt => { outcome = attempt.outcome }, controller.signal)
  assert.equal(called, false)
  assert.equal(result, null)
  assert.equal(outcome, 'cancelled')
})
