import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MetadataFieldState, Release, Track, TrackCandidateState } from '../core/types'
import {
  curateReviewKeys, isReconciledCurateDraft, makeCurateCommitItems, projectCurateCommits,
  reconcileCurateReviewState, type CurateCommitRow, type CurateReviewState,
} from '../core/curateCommit'
import { captureCurateDraft, mergeCurateProposal, restoreCurateDraft } from '../core/curateDraft'
import { computeCurationQueue } from '../services/curationQueueService'
import { captureTrackDecisions, type CurateProviderAttempt } from '../services/curateEvidenceService'
import { FederatedResolversService } from '../services/federatedResolvers'

const release = {
  id: 'local-seven', title: 'Harbor Lights', artistCredit: 'Fixture Ensemble',
  composerName: 'Fixture Composer', releaseYear: 1988, genreTags: ['Local genre'],
  discsCount: 1, tracksCount: 7,
} as Release
const tracks: Track[] = Array.from({ length: 7 }, (_, i) => ({
  id: `local-${i + 1}`, releaseId: release.id, trackNumber: i + 1, discNumber: 1,
  title: `Track ${i + 1}`, artistCredit: 'Local Singer', format: 'WAV',
  storageMountId: 'fixture', filePath: `fixture/${i + 1}.wav`,
} as Track))

function field<T>(local: T): MetadataFieldState<T> {
  return { local, selected: local, source: 'local_fallback', confidence: 1 }
}

const baseline = {
  albumTitle: field(release.title), albumArtist: field(release.artistCredit),
  composer: field(release.composerName!), year: field(release.releaseYear),
  coverArt: field(''), genre: field(release.genreTags[0]),
  tracks: tracks.map((track): TrackCandidateState => ({
    trackId: track.id, trackNumber: track.trackNumber,
    localTitle: track.title, localArtists: track.artistCredit,
    matchedTitle: track.title, matchedArtists: track.artistCredit,
    confidence: 1, source: 'local_fallback',
  })),
}

function editGenre(genre: string) {
  return { ...baseline, genre: { ...baseline.genre, selected: genre, userOverridden: true } }
}

test('a stale seven-track draft retires after a full write and reopening requires new work', () => {
  const confirmed = captureCurateDraft(editGenre('Confirmed genre'))
  const stored = JSON.stringify(confirmed)
  const rows: CurateCommitRow[] = makeCurateCommitItems(confirmed, tracks, release)
    .map(item => ({ ...item, status: 'completed', applies: false }))
  const draft = JSON.parse(stored) as typeof confirmed
  const byTrack = (items: CurateCommitRow[]) => new Map(items.map(row => [row.trackId, row]))
  const actionable = (state: CurateReviewState) => computeCurationQueue(
    tracks, [release].filter(album => state.get(album.id) !== true), [],
  )

  const partial = rows.map((row, i) => i === 6 ? { ...row, status: 'failed' as const } : row)
  assert.equal(isReconciledCurateDraft(draft, byTrack(partial)), false)
  assert.equal(actionable(reconcileCurateReviewState(new Map(), tracks, partial)).length, 1)
  assert.equal(isReconciledCurateDraft(draft, byTrack(rows)), true)
  const closed = reconcileCurateReviewState(new Map(), tracks, rows)
  const restarted: CurateReviewState = new Map(JSON.parse(JSON.stringify([...closed])))
  assert.deepEqual(actionable(reconcileCurateReviewState(restarted, tracks, [])), [])
  assert.equal(projectCurateCommits(tracks, [release], rows).releases[0].genreTags[0], 'Local genre')

  const reopened = new Map(restarted)
  for (const key of curateReviewKeys(release.id, tracks)) reopened.set(key, rows.map(row => row.id))
  assert.equal(actionable(reconcileCurateReviewState(reopened, tracks, rows)).length, 1)
  assert.equal(isReconciledCurateDraft(draft, byTrack(rows)), true, 'old rows still prove this draft was written')
  assert.equal(isReconciledCurateDraft(captureCurateDraft(editGenre('Later draft')), byTrack(rows)), false)

  const fresh: CurateCommitRow[] = makeCurateCommitItems(captureCurateDraft(editGenre('Later draft')), tracks, release)
    .map(item => ({ ...item, status: 'completed' }))
  assert.equal(actionable(reconcileCurateReviewState(reopened, tracks, [...fresh.slice(0, 6), rows[6]])).length, 1)
  assert.deepEqual(actionable(reconcileCurateReviewState(reopened, tracks, fresh)), [])
})

test('seven local tracks and eight MusicBrainz tracks preserve provider evidence without selecting conflicted titles or unverified singers', async t => {
  const providerTracks = ['Overture', 'Departure', 'Crossing', 'Homeward', 'Reunion', 'Finale', 'Epilogue', 'Bonus'].map(
    (trackName, i) => ({ trackId: `mb-track-${i + 1}`, trackNumber: i + 1, trackName, artistName: 'Provider Singer' }),
  )
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    requests.push(url.pathname)
    const candidate = { success: true, releaseTitle: release.title, artistCredit: release.artistCredit }
    switch (url.pathname) {
      case '/api/itunes-search': return Response.json({ ...candidate, releaseId: 'apple-empty', tracks: [] })
      case '/api/musicbrainz-search': return Response.json({ ...candidate, releaseId: 'mb-eight', tracks: providerTracks })
      default: assert.fail(`Unexpected provider request ${url.pathname}`)
    }
  })
  const attempts: CurateProviderAttempt[] = []
  const result = await new FederatedResolversService().resolve2of3ReleaseConsensus(
    release, tracks, false, undefined, undefined, undefined, undefined,
    attempt => attempts.push(attempt), 2, 1,
  )
  assert.deepEqual(requests.sort(), ['/api/itunes-search', '/api/musicbrainz-search'])
  const archived = JSON.parse(JSON.stringify({ attempts, decision: result.decisionTrace })) as {
    attempts: CurateProviderAttempt[], decision: typeof result.decisionTrace,
  }
  const apple = archived.attempts.find(attempt => attempt.provider === 'apple')
  assert.equal(apple?.outcome, 'success')
  assert.equal(apple.candidate?.title, release.title)
  assert.equal(apple.candidate?.trackCount, 0)
  const musicbrainz = archived.attempts.find(attempt => attempt.provider === 'musicbrainz')?.candidate
  assert.equal(musicbrainz?.releaseId, 'mb-eight')
  assert.equal(musicbrainz.trackCount, 8)
  assert.equal(musicbrainz.tracks?.[7]?.title, 'Bonus')
  assert.equal(archived.decision?.candidateTelemetry?.find(item => item.provider === 'musicbrainz')?.trackCount, 8)
  assert.deepEqual(result.identityMappings?.slice(0, 2), [
    { localTrackId: tracks[0].id, provider: 'apple', releaseId: 'apple-empty',
      providerTrackId: undefined, providerPosition: undefined, method: 'none', positional: false, status: 'unmapped' },
    { localTrackId: tracks[0].id, provider: 'musicbrainz', releaseId: 'mb-eight',
      providerTrackId: 'mb-track-1', providerPosition: 1, method: 'position', positional: true, status: 'conflicted' },
  ])
  const decisions = captureTrackDecisions(result)!
  assert.deepEqual(decisions.map(track => track.trackId), tracks.map(track => track.id))
  assert.equal(decisions[0].selectedTitle, tracks[0].title)
  assert.equal(decisions[0].selectedArtists, tracks[0].artistCredit)
  assert.equal(decisions[0].requiresHumanReview, true)
  assert.equal(result.trackStates?.[0].mbTitle, 'Overture')
  assert.equal(result.trackStates?.[0].mbArtists, 'Provider Singer')
})

test('edit, confirm, refresh, and edit preserve the draft and confirmed value as separate layers', () => {
  const firstEdit = editGenre('Confirmed A')
  const items = makeCurateCommitItems(captureCurateDraft(firstEdit), tracks, release)
  const refreshed = mergeCurateProposal(firstEdit, {
    ...baseline,
    genre: { ...baseline.genre, selected: 'Refresh suggestion', ai: 'Refresh suggestion' },
    tracks: baseline.tracks.map((track, i) => i === 0 ? { ...track, matchedTitle: 'Refreshed title' } : track),
  })
  assert.equal(refreshed.genre.selected, 'Confirmed A')
  assert.equal(refreshed.genre.ai, 'Refresh suggestion')
  assert.equal(refreshed.tracks[0].matchedTitle, 'Refreshed title')
  const secondEdit = { ...refreshed, genre: { ...refreshed.genre, selected: 'Draft B' } }
  const draft = JSON.parse(JSON.stringify(captureCurateDraft(secondEdit)))
  assert.equal(restoreCurateDraft(baseline, draft).genre.selected, 'Draft B')
  for (const status of ['pending', 'in_flight', 'failed'] as const) {
    const projection = projectCurateCommits(tracks, [release], items.map(item => ({ ...item, status })))
    assert.equal(projection.releases[0].genreTags[0], 'Confirmed A')
    assert.equal(JSON.parse(items[0].payloadJson).genre, 'Confirmed A')
  }
  assert.equal(release.genreTags[0], 'Local genre')
  assert.equal(isReconciledCurateDraft(draft, new Map(
    items.map(item => [item.trackId, { ...item, status: 'completed' }]),
  )), false)
})
