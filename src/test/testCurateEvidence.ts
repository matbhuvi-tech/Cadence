import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchCurateCandidate, restoreAppleTrackCandidates, type CurateEvidenceRun } from '../services/curateEvidenceService'
import { FederatedResolversService } from '../services/federatedResolvers'

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

test('looks up a known Apple release directly and records track IDs and credits', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    requests.push(new URL(input).pathname)
    return Response.json({ results: [
      { wrapperType: 'collection', collectionId: 123, collectionName: 'Album', artistName: 'Composer' },
      { wrapperType: 'track', collectionId: 123, trackId: 456, trackNumber: 1, trackName: 'Song', artistName: 'Singer' },
    ] })
  })
  const attempts: string[] = []
  const candidate = await new FederatedResolversService().fetchItunesAlbumCandidate(
    { sanitizedTitle: 'Album', sanitizedArtist: 'Composer', trackCount: 1 },
    attempt => attempts.push(attempt.outcome), undefined, 1, { appleReleaseId: '123' },
  )
  assert.deepEqual(requests, ['/lookup'])
  assert.deepEqual(attempts, ['success'])
  assert.deepEqual(candidate?.tracks, [
    { trackId: '456', trackNumber: 1, trackName: 'Song', artistName: 'Singer' },
  ])
})

test('restores Apple rows by recorded mappings and flags conflicts in saved evidence', () => {
  const run: CurateEvidenceRun = {
    id: 'run', trigger: 'user_refresh', requestedAt: '', completedAt: '', outcome: 'completed',
    context: { title: 'Album', artist: 'Artist', composer: undefined, year: 1988, tracks: [] },
    attempts: [{
      provider: 'apple', query: '', startedAt: '', completedAt: '', durationMs: 0, outcome: 'success',
      candidate: { releaseId: 'album', tracks: [
        { number: 9, title: 'Second version', artist: 'Provider credit' },
        { number: 3, title: 'First version', artist: 'Other credit' },
      ] },
    }],
    identityMappings: [
      { localTrackId: 'one', provider: 'apple', releaseId: 'album', providerTrackId: 'a',
        providerPosition: 3, method: 'title', positional: false, status: 'inferred' },
      { localTrackId: 'two', provider: 'apple', releaseId: 'album', providerTrackId: 'b',
        providerPosition: 9, method: 'title', positional: false, status: 'conflicted' },
      { localTrackId: 'elsewhere', provider: 'apple', releaseId: 'other', providerTrackId: 'b',
        providerPosition: 9, method: 'title', positional: false, status: 'inferred' },
    ],
  }
  const saved = JSON.stringify(run)
  const rows = restoreAppleTrackCandidates(JSON.parse(saved))
  assert.deepEqual([...rows], [
    ['one', { title: 'First version', artist: 'Other credit', conflicted: false }],
    ['two', { title: 'Second version', artist: 'Provider credit', conflicted: true }],
  ])
  const tracks = run.attempts[0].candidate!.tracks!
  tracks[0].providerTrackId = 'a'
  tracks[1].providerTrackId = 'b'
  assert.equal(restoreAppleTrackCandidates(run).get('one')?.title, 'Second version')
  assert.equal(restoreAppleTrackCandidates({ ...run, applicability: 'superseded' }).size, 0)
  assert.equal(restoreAppleTrackCandidates({ ...run, identityMappings: [] }).size, 0)
})
