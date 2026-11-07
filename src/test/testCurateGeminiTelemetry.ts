import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Release, Track } from '../core/types'
import type { CurateProviderAttempt } from '../services/curateEvidenceService'
import { compilationCanonicalizerService } from '../services/compilationCanonicalizerService'
import { tauriBridge } from '../services/tauriBridge'

const release = { id: 'fixture', title: 'Fixture Album', artistCredit: 'Composer' } as Release
const tracks = [{ id: 'track-1', releaseId: release.id, trackNumber: 1, title: 'Local Song' }] as Track[]

test('records Gemini HTTP errors before the resolver converts them to failed results', async t => {
  t.mock.method(tauriBridge, 'getPlaybackStatus', async () => null)
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Quota exhausted <retry>' }, { status: 429 }))
  const attempts: CurateProviderAttempt[] = []
  const result = await compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks, [], {
    selectedAlbumSignal: new AbortController().signal,
    recordAttempt: attempt => attempts.push(attempt),
  })
  assert.equal(result.success, false)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].provider, 'gemini')
  assert.equal(attempts[0].outcome, 'http_error')
  assert.equal(attempts[0].httpStatus, 429)
  assert.equal(attempts[0].errorMessage, 'Quota exhausted <retry>')
  assert.ok(attempts[0].durationMs >= 0)
  assert.ok(attempts[0].completedAt >= attempts[0].startedAt)
})

test('records actual successful AI proposals and model metadata without file paths', async t => {
  t.mock.method(tauriBridge, 'getPlaybackStatus', async () => null)
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    success: true, albumTitle: 'Fixture Album',
    results: [{
      id: 'track-1', trackNumber: 1, title: 'Canonical Song', originalAlbum: 'Original Film',
      originalYear: 1986, canonicalComposer: 'Composer', primaryVocalists: 'Singer',
      confidence: 0.85, notes: 'Track listing match', isCompilationTrack: true,
      filePath: 'private/path', ignored: 'raw response content',
    }],
    telemetry: { modelUsed: 'fixture-model', retriesAttempted: 0, pacingDelayMs: 12 },
  }))
  const attempts: CurateProviderAttempt[] = []
  await compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks, [], {
    selectedAlbumSignal: new AbortController().signal,
    recordAttempt: attempt => attempts.push(attempt),
  })
  const saved = JSON.parse(JSON.stringify(attempts[0])) as CurateProviderAttempt
  assert.equal(saved.outcome, 'success')
  assert.equal(saved.modelUsed, 'fixture-model')
  assert.equal(saved.candidate?.trackCount, 1)
  assert.deepEqual(saved.candidate?.tracks?.[0], {
    localTrackId: 'track-1', number: 1, title: 'Canonical Song',
    originalAlbum: 'Original Film', originalYear: 1986, composer: 'Composer', artist: 'Singer',
    confidence: 0.85, notes: 'Track listing match', isCompilationTrack: true,
  })
  assert.ok(!JSON.stringify(saved).includes('private/path'))
  assert.ok(!JSON.stringify(saved).includes('raw response content'))
})

test('distinguishes empty, malformed, and cancelled AI attempts', async t => {
  t.mock.method(tauriBridge, 'getPlaybackStatus', async () => null)
  const attempts: CurateProviderAttempt[] = []
  const controller = new AbortController()
  const options = { selectedAlbumSignal: controller.signal, recordAttempt: (attempt: CurateProviderAttempt) => attempts.push(attempt) }
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [] }))
  await compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks, [], options)
  fetchMock.mock.mockImplementation(async () => new Response('{broken'))
  await compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks, [], options)
  controller.abort()
  await compilationCanonicalizerService.resolveCompilationSoundtracks(release, tracks, [], options)
  assert.deepEqual(attempts.map(attempt => attempt.outcome), ['empty', 'parse_error', 'cancelled'])
  assert.equal(fetchMock.mock.callCount(), 2)
})
