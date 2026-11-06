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
  const saved = { ...local, fields: { ...local.fields, genre: { ...local.fields.genre, selected: 'Saved genre' } } }
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
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', { ...completed, applies: false }]])), false)
  draft.fields.genre.selected = 'New genre'
  assert.equal(isReconciledCurateDraft(draft, new Map([['one', completed]])), false)
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
