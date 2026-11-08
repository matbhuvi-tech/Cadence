import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Release, Track } from '../core/types'
import { getCurateChange, isReconciledCurateDraft, makeCurateCommitItems, prepareTier1Commit, projectCurateCommits, reconcileCurateReviewState } from '../core/curateCommit'
import type { CurateDraft } from '../core/curateDraft'

test('shows proposed replacements and additions without treating missing selections as clears', () => {
  assert.deepEqual(getCurateChange('Tamil Film Soundtrack', 'Tamil Soundtrack'), { previous: 'Tamil Film Soundtrack' })
  assert.deepEqual(getCurateChange(0, 1988), { previous: undefined })
  assert.deepEqual(getCurateChange('Song', 'song'), { previous: 'Song' })
  assert.equal(getCurateChange('Deva', 'Deva'), null)
  assert.equal(getCurateChange('Deva', ''), null)
  assert.equal(getCurateChange(1988, undefined), null)
})

test('restores confirmed queue metadata over the loaded catalog without changing the baseline', () => {
  const tracks = [{ id: 'one', releaseId: 'album', title: 'Old song' }] as Track[]
  const releases = [{ id: 'album', title: 'Old album', genreTags: ['Tamil'] }] as Release[]
  const result = projectCurateCommits(tracks, releases, [{
    id: 'item', trackId: 'one', status: 'pending',
    payloadJson: JSON.stringify({ title: 'New song', album: 'New album', genre: 'Tamil Soundtrack' }),
  }])
  assert.equal(result.tracks[0].title, 'New song')
  assert.equal(result.releases[0].title, 'New album')
  assert.deepEqual(result.releases[0].genreTags, ['Tamil Soundtrack'])
  assert.equal(tracks[0].title, 'Old song')
  assert.deepEqual(releases[0].genreTags, ['Tamil'])
})

test('Tier 1 uses saved selections and skips conflicts or tracks that already have active intent', () => {
  const local = {
    baseline: 'current tags',
    fields: {
      albumTitle: { selected: 'Album' }, albumArtist: { selected: 'Singer' },
      composer: { selected: '' }, year: { selected: 1988 }, genre: { selected: 'Generated genre' },
      coverArt: { selected: '' },
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Song' }],
  } as CurateDraft
  const saved = { ...local, fields: { ...local.fields, genre: { ...local.fields.genre, selected: 'Saved genre', userOverridden: true } } }
  const tracks = [{ id: 'one', filePath: 'song.flac', storageMountId: 'disk' }] as Track[]
  const result = prepareTier1Commit(local, saved, tracks, undefined, new Map())
  assert.equal(JSON.parse(result!.items[0].payloadJson).genre, 'Saved genre')
  assert.equal(prepareTier1Commit(local, { ...saved, baseline: 'old tags' }, tracks, undefined, new Map()), null)
  assert.equal(prepareTier1Commit(local, saved, tracks, undefined, new Map([
    ['one', { id: 'existing', trackId: 'one', payloadJson: '{}', status: 'failed' }],
  ])), null)
})

test('freezes the selected fields and their backup independently of later draft edits', () => {
  const draft = {
    fields: {
      albumTitle: { selected: 'Confirmed title' }, albumArtist: { selected: 'Album artist' },
      composer: { selected: '' }, year: { selected: 1988 }, genre: { selected: 'Tamil Soundtrack' },
      coverArt: { selected: 'cadence:cover://one' },
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Confirmed song', matchedArtists: 'Singer' }],
  } as CurateDraft
  const tracks = [{ id: 'one', title: 'Old song', filePath: 'song.flac', storageMountId: 'disk' }] as Track[]
  const [item] = makeCurateCommitItems(draft, tracks)
  draft.fields.genre.selected = 'Another edit'
  const confirmed = JSON.parse(item.payloadJson)
  assert.equal(confirmed.album, 'Confirmed title')
  assert.equal(confirmed.albumArtist, 'Album artist')
  assert.equal(confirmed.year, 1988)
  assert.equal(confirmed.genre, 'Tamil Soundtrack')
  assert.equal(confirmed.coverArtUrl, undefined)
  assert.equal(JSON.parse(item.backupJson).title, 'Old song')
})

test('keeps failed intent visible and drops completed history after the stored tags diverge', () => {
  const tracks = [{ id: 'one', releaseId: 'album', title: 'Later tag' }] as Track[]
  const row = { id: 'item', trackId: 'one', payloadJson: '{"title":"Confirmed title"}' }
  assert.equal(projectCurateCommits(tracks, [], [{ ...row, status: 'failed' }]).tracks[0].title, 'Confirmed title')
  assert.equal(projectCurateCommits(tracks, [], [{ ...row, status: 'completed', applies: false }]).tracks[0], tracks[0])
})

test('resolves only the completed confirmation and leaves a later edit open', () => {
  const draft = {
    fields: {
      albumTitle: { selected: 'Album' }, albumArtist: { selected: 'Singer' },
      composer: { selected: '' }, year: { selected: 1988 }, genre: { selected: 'Tamil Soundtrack' },
      coverArt: { selected: '' },
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Song' }],
  } as CurateDraft
  const [item] = makeCurateCommitItems(draft, [{ id: 'one', filePath: 'song.flac', storageMountId: 'disk' }] as Track[])
  const completed = { ...item, status: 'completed' as const, applies: true }
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', completed]])), true)
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', { ...completed, status: 'failed' }]])), false)
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', { ...completed, applies: false }]])), true)
  draft.fields.genre.selected = 'New genre'
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', completed]])), false)
})

test('a reopened review still recognizes its superseded completed draft', () => {
  const draft = {
    fields: {
      albumTitle: { selected: 'Album' }, albumArtist: { selected: 'Composer' },
      composer: { selected: 'Composer' }, year: { selected: 1986 },
      genre: { selected: 'Tamil Film Soundtrack' }, coverArt: { selected: '' },
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Song', matchedArtists: 'Singer' }],
  } as CurateDraft
  const [item] = makeCurateCommitItems(draft, [
    { id: 'one', filePath: 'song.flac', storageMountId: 'disk' } as Track,
  ])
  const completed = { ...item, status: 'completed' as const, applies: false }
  const ignoredForNewReview = new Set([completed.id])
  assert.equal(isReconciledCurateDraft(draft, new Map([[completed.trackId, completed]])), true)
  assert.equal(isReconciledCurateDraft(draft, new Map(
    [completed].filter(row => !ignoredForNewReview.has(row.id)).map(row => [row.trackId, row]),
  )), false)
})

test('projects the persisted cover and reconciles only a verified artwork write', () => {
  const source = 'https://example.test/cover.png'
  const persisted = 'data:image/jpeg;base64,Y292ZXI='
  const draft = {
    fields: {
      albumTitle: { selected: 'Album' }, albumArtist: { selected: 'Singer' },
      composer: { selected: '' }, year: { selected: 1988 }, genre: { selected: 'Soundtrack' },
      coverArt: { selected: source, userOverridden: true },
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Song' }],
  } as CurateDraft
  const tracks = [{ id: 'one', releaseId: 'album', filePath: 'song.wav', storageMountId: 'disk' }] as Track[]
  const releases = [{ id: 'album', title: 'Album', genreTags: [], artwork: {} }] as Release[]
  const [item] = makeCurateCommitItems(draft, tracks)
  const row = { ...item, status: 'completed' as const, applies: true }
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', row]])), false)
  const written = { ...row, artworkUrl: persisted }
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', written]])), true)
  assert.equal(projectCurateCommits(tracks, releases, [written]).releases[0].artwork.frontCoverUrl, persisted)
  assert.equal(projectCurateCommits(tracks, releases, [{ ...row, status: 'failed' }]).releases[0].artwork.frontCoverUrl, source)
  draft.fields.coverArt.selected = 'https://example.test/replacement.png'
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', written]])), false)
})

test('human commit exclusion survives changed tags, and reopening requires a fresh complete write', () => {
  const tracks = [{ id: 'one', releaseId: 'album' }, { id: 'two', releaseId: 'album' }] as Track[]
  const completed = tracks.map(track => ({
    id: 'old-' + track.id, trackId: track.id, status: 'completed' as const, applies: false,
    payloadJson: JSON.stringify({ curate: true, curateTrackCount: 2 }),
  }))
  const closed = reconcileCurateReviewState(new Map(), tracks, completed)
  assert.equal(closed.get('album'), true)
  assert.equal(reconcileCurateReviewState(closed, tracks, []).get('album'), true)
  const reopened = new Map([['album', completed.map(row => row.id)]])
  assert.deepEqual(reconcileCurateReviewState(reopened, tracks, completed), reopened)
  const fresh = completed.map(row => ({
    ...row, id: 'new-' + row.trackId,
    payloadJson: JSON.stringify({ curate: true, curateTrackCount: 2, curateReviewId: 'fresh' }),
  }))
  assert.equal(reconcileCurateReviewState(reopened, tracks, [fresh[0], completed[1]]).get('album') === true, false)
  assert.equal(reconcileCurateReviewState(reopened, tracks, [fresh[0], { ...fresh[1], status: 'failed' }]).get('album') === true, false)
  assert.equal(reconcileCurateReviewState(reopened, tracks, fresh).get('album'), true)
})

test('keeps a committed album excluded when a rescan recreates its catalog IDs', () => {
  const original = [{ id: 'old-track', releaseId: 'old-album', filePath: 'D:/Music/Album/01.flac' }] as Track[]
  const closed = reconcileCurateReviewState(new Map(), original, [{
    id: 'commit', trackId: 'old-track', status: 'completed',
    payloadJson: JSON.stringify({ curate: true, curateTrackCount: 1 }),
  }])
  const rescanned = [
    { id: 'new-track', releaseId: 'new-album', filePath: 'd:/music/album/01.flac' },
    { id: 'other-track', releaseId: 'other-album', filePath: 'D:/Music/Other/01.flac' },
  ] as Track[]
  const next = reconcileCurateReviewState(closed, rescanned, [])
  assert.equal(next.get('new-album'), true)
  assert.equal(next.get('other-album'), undefined)
})

test('only the frozen draft revision matches an identical completed selection after restart', () => {
  const draft = {
    revision: 'draft-a',
    fields: {
      albumTitle: { selected: 'Album' }, albumArtist: { selected: 'Singer' },
      composer: { selected: '' }, year: { selected: 1988 }, genre: { selected: 'Soundtrack' },
      coverArt: { selected: '' },
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Song' }],
  } as CurateDraft
  const [item] = makeCurateCommitItems(draft, [
    { id: 'one', filePath: 'song.flac', storageMountId: 'disk' } as Track,
  ])
  const rows = new Map([['one', { ...item, status: 'completed' as const }]])
  assert.equal(isReconciledCurateDraft(JSON.parse(JSON.stringify(draft)), rows), true)
  assert.equal(isReconciledCurateDraft({ ...draft, revision: 'draft-b' } as CurateDraft, rows), false)
})

test('keeps an album open when a completed write has a newer saved draft', () => {
  const tracks = [{ id: 'one', releaseId: 'album' }] as Track[]
  const row = {
    id: 'write-a', trackId: 'one', status: 'completed' as const,
    payloadJson: '{"curate":true,"curateTrackCount":1,"curateReviewId":"a"}',
  }
  const closed = reconcileCurateReviewState(new Map(), tracks, [row])
  assert.equal(closed.get('album'), true)
  assert.equal(reconcileCurateReviewState(closed, tracks, [{ ...row, hasNewerDraft: true }]).has('album'), false)
})

test('queues and confirms only tracks that differ from the physical baseline', () => {
  const draft = {
    fields: {
      albumTitle: { selected: 'Album' }, albumArtist: { selected: '' },
      composer: { selected: '' }, year: {}, genre: {}, coverArt: {},
    },
    tracks: [{ trackId: 'one', matchedTitle: 'Song' }, { trackId: 'two', matchedTitle: 'Corrected' }],
  } as CurateDraft
  const tracks = ['one', 'two'].map(id =>
    ({ id, releaseId: 'album', title: 'Song', filePath: id, storageMountId: 'disk' }) as Track)
  const release = { id: 'album', title: 'Album' } as Release
  const items = makeCurateCommitItems(draft, tracks, release)
  assert.deepEqual(items.map(item => item.trackId), ['two'])
  assert.equal(JSON.parse(items[0].payloadJson).curateTrackCount, 1)
  const completed = { ...items[0], status: 'completed' as const }
  assert.equal(isReconciledCurateDraft(draft, new Map([['two', completed]])), true)
  assert.equal(reconcileCurateReviewState(new Map(), tracks, [completed]).get('album'), true)
  draft.tracks[1].matchedTitle = 'Song'
  assert.deepEqual(makeCurateCommitItems(draft, tracks, release), [])
})

test('folds partial queue rows and cascades release year and genre to siblings', () => {
  const tracks = ['one', 'two'].map(id => ({ id, releaseId: 'album', title: 'Local' }) as Track)
  const release = { id: 'album', genreTags: [] } as unknown as Release
  const result = projectCurateCommits(tracks, [release], [
    { id: 'first', trackId: 'one', status: 'pending', payloadJson: '{"title":"Corrected","year":1995}' },
    { id: 'second', trackId: 'one', status: 'pending', payloadJson: '{"genre":"Soundtrack"}' },
  ])
  assert.equal(result.tracks[0].title, 'Corrected')
  assert.equal(result.releases[0].releaseYear, 1995)
  assert.deepEqual(result.releases[0].genreTags, ['Soundtrack'])
  assert.deepEqual(result.tracks.map(t => [t.canonicalReleaseYear, t.genre]), [[1995, 'Soundtrack'], [1995, 'Soundtrack']])
})
