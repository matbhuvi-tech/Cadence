import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_PRIORITY_SETTINGS, evaluateCatalogProblems, filterAndRankCurateAlbums,
  loadDismissedProblems, loadPrioritySettings, removeDismissedProblem, resetPrioritySettings,
  resolveFilterTransition, saveDismissedProblem, savePrioritySettings,
  type CurateProblemCategoryId,
} from '../core/curatePriorities'
import type { Release, Track } from '../core/types'

const release = {
  id: 'album', title: 'Roja', artistCredit: 'A. R. Rahman', composerName: 'A. R. Rahman',
  releaseYear: 1992, genreTags: ['Soundtrack'], coverArtUrl: 'cover',
} as Release
const track = {
  id: 'track', releaseId: 'album', title: 'Chinna Chinna Aasai', artistCredit: 'Minmini',
  filePath: 'D:/Music/Roja/01.flac', originalAlbum: 'Roja',
} as Track

const cases: [CurateProblemCategoryId, Partial<Release>, Partial<Track>, Release?][] = [
  ['cd_rip_suffix', { title: 'Roja CD Rip' }, {}],
  ['artist_as_album_title', { title: 'A. R. Rahman' }, {}],
  ['placeholder_track_titles', {}, { title: 'Audio Track 01' }],
  ['missing_artist_and_composer', { artistCredit: '', composerName: '' }, {}],
  ['track_artist_copied_from_album', {}, { artistCredit: 'roja' }],
  ['featured_artist_missing_from_tag', {}, { title: 'Song (feat. Minmini & Hariharan)' }],
  ['missing_release_year', { releaseYear: 0 }, {}],
  ['missing_track_year', { releaseYear: 0 }, { canonicalReleaseYear: 1899 }],
  ['missing_cover_art', { coverArtUrl: undefined }, {}],
  ['missing_album_genre', { genreTags: ['Library Import'] }, {}],
  ['missing_track_genre', { genreTags: ['Unclassified'] }, {}],
  ['compilation_missing_original_album', { isCompilation: true }, { originalAlbum: '' }],
  ['multi_soundtrack_missing_provenance', { physicalComboTitle: 'Roja / Bombay' }, { originalAlbum: '' }],
  ['duplicate_editions_missing_note', {}, {}, { ...release, id: 'duplicate' }],
]

for (const [category, releasePatch, trackPatch, duplicate] of cases) {
  test(`detects ${category} only when its predicate is met`, () => {
    const evaluate = (tracks: Track[], releases: Release[]) =>
      evaluateCatalogProblems(tracks, releases, DEFAULT_PRIORITY_SETTINGS)
    assert.equal(evaluate([track], [release]).categoryCounts[category].count, 0)
    const summary = evaluate([{ ...track, ...trackPatch }], [
      { ...release, ...releasePatch }, ...(duplicate ? [duplicate] : []),
    ])
    assert.equal(summary.categoryCounts[category].count, duplicate ? 2 : 1)
  })
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

test('persists and removes dismissals across release ID changes', () => {
  const storage = memoryStorage()
  const rescanned = { ...release, id: 'new', title: release.artistCredit, composerName: '' }
  const tracks = [{ ...track, releaseId: 'new' }]
  const evaluate = () => evaluateCatalogProblems(tracks, [rescanned], DEFAULT_PRIORITY_SETTINGS, loadDismissedProblems(storage))
  saveDismissedProblem(release.id, 'artist_as_album_title', [track], storage)
  assert.equal(evaluate().infoExemptCount, 1)
  assert.equal(evaluate().totalActionableAlbums, 0)
  removeDismissedProblem(rescanned.id, 'artist_as_album_title', tracks, storage)
  assert.equal(evaluate().totalActionableAlbums, 1)
  assert.deepEqual(loadDismissedProblems(storage), {})
})

test('matches both filter groups on the same instance and distinguishes reset from completion', () => {
  const albums = [{ ...release, isCompilation: true }]
  const summary = evaluateCatalogProblems([{ ...track, title: 'Track 1', originalAlbum: '' }], albums, DEFAULT_PRIORITY_SETTINGS)
  assert.deepEqual(summary.priorityAlbumCounts, { P0: 1, P1: 0, P2: 1, P3: 0 })
  const filter = { priorities: ['P0'] as const, categories: ['compilation_missing_original_album'] as const }
  assert.deepEqual(filterAndRankCurateAlbums(albums, summary, filter), [])
  assert.deepEqual(filterAndRankCurateAlbums(albums, summary, { ...filter, priorities: ['P2'] }), albums)
  assert.equal(resolveFilterTransition(albums, summary, filter, 'filter_change').toastMessage, 'No albums match. Filters reset.')
  assert.equal(resolveFilterTransition(albums, summary, filter, 'batch_resolved').filterCompleted, true)
})

test('persists priority changes and ranks using the highest matching priority', () => {
  const storage = memoryStorage()
  savePrioritySettings({ ...DEFAULT_PRIORITY_SETTINGS, missing_cover_art: 'P0' }, storage)
  const albums = [{ ...release, title: 'Zebra', coverArtUrl: undefined },
    { ...release, id: 'second', title: 'Alpha', releaseYear: 0 }]
  const summary = evaluateCatalogProblems([track], albums, loadPrioritySettings(storage))
  assert.deepEqual(filterAndRankCurateAlbums(albums, summary, { priorities: [], categories: [] }), albums)
  resetPrioritySettings(storage)
  assert.deepEqual(loadPrioritySettings(storage), DEFAULT_PRIORITY_SETTINGS)
})
