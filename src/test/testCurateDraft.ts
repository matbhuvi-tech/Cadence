import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MetadataFieldState, TrackCandidateState } from '../core/types'
import { captureCurateDraft, restoreCurateDraft, mergeCurateProposal, selectCurateTrackFields } from '../core/curateDraft'

const field = (selected: string): MetadataFieldState<string> => ({ selected, local: selected, source: 'local_fallback', confidence: 1 })
const track: TrackCandidateState = {
  trackId: 'track-1', trackNumber: 1, localTitle: 'Song', localArtists: 'Singer',
  matchedTitle: 'Song', matchedArtists: 'Singer', confidence: 1, source: 'local_fallback',
}
const baseline = {
  albumTitle: field('En Bommukutti Amavuku'), albumArtist: field('Ilaiyaraaja'),
  composer: field('Ilaiyaraaja'), coverArt: field(''), genre: field('Tamil Film Soundtrack'),
  year: { selected: 1988, local: 1988, source: 'local_fallback', confidence: 1 } as MetadataFieldState<number | undefined>,
  tracks: [track],
}

test('restores an unstaged manual genre after reopening the album', () => {
  const draft = captureCurateDraft({
    ...baseline,
    genre: { ...baseline.genre, selected: 'Tamil Soundtrack', userOverridden: true },
  })
  const restored = restoreCurateDraft(baseline, JSON.parse(JSON.stringify(draft)))
  assert.equal(restored.genre.selected, 'Tamil Soundtrack')
  assert.equal(restored.genre.local, 'Tamil Film Soundtrack')
  assert.equal(restored.genre.userOverridden, true)
})

test('uses fresh proposals while preserving explicit field and per-track choices', () => {
  const current = {
    ...baseline,
    genre: { ...baseline.genre, selected: 'Tamil Soundtrack', userOverridden: true },
    tracks: [{ ...track, matchedTitle: 'My title', selectedOverrides: ['matchedTitle'] as const }],
  }
  const fresh = {
    ...baseline,
    albumTitle: { ...baseline.albumTitle, selected: 'Fresh album title' },
    genre: { ...baseline.genre, local: 'Steered query genre', ai: 'Fresh genre', selected: 'Fresh genre' },
    tracks: [{ ...track, matchedTitle: 'Fresh song title', matchedArtists: 'Fresh singer' }],
  }
  const merged = mergeCurateProposal(current, fresh)
  assert.equal(merged.albumTitle.selected, 'Fresh album title')
  assert.equal(merged.genre.selected, 'Tamil Soundtrack')
  assert.equal(merged.genre.ai, 'Fresh genre')
  assert.equal(merged.genre.local, 'Tamil Film Soundtrack')
  assert.equal(merged.tracks[0].matchedTitle, 'My title')
  assert.equal(merged.tracks[0].matchedArtists, 'Fresh singer')
})

test('retains a staged empty proposal without duplicating provider evidence', () => {
  const draft = captureCurateDraft({
    ...baseline,
    userOverridden: true,
    year: { ...baseline.year, selected: undefined, apple: 1990 },
    tracks: [{ ...track, appleTitle: 'Provider song', matchedTitle: undefined }],
  })
  const stored = JSON.stringify(draft)
  assert.equal(stored.includes('Provider song'), false)
  assert.equal(stored.includes('1990'), false)
  const restored = restoreCurateDraft(baseline, JSON.parse(stored))
  assert.equal(restored.userOverridden, true)
  assert.equal(restored.year.selected, undefined)
  assert.equal(restored.tracks[0].matchedTitle, undefined)
})

test('tracks separate explicit song and provenance choices without duplicates', () => {
  const title = selectCurateTrackFields(track, 'matchedTitle')
  const withProvenance = selectCurateTrackFields({
    ...title,
    originalAlbum: 'Film',
    originalYear: undefined,
    provenanceSource: 'user_override',
  }, 'matchedTitle', 'originalAlbum', 'originalYear')
  assert.deepEqual(withProvenance.selectedOverrides, ['matchedTitle', 'originalAlbum', 'originalYear'])
  const merged = mergeCurateProposal(
    { ...baseline, tracks: [withProvenance] },
    { ...baseline, tracks: [{ ...track, originalAlbum: 'Provider film', originalYear: 1999 }] },
  )
  assert.equal(merged.tracks[0].originalAlbum, 'Film')
  assert.equal(merged.tracks[0].originalYear, undefined)
  assert.equal(merged.tracks[0].provenanceSource, 'user_override')
})

test('reopens an older draft against the current baseline by track identity', () => {
  const draft = captureCurateDraft({ ...baseline, tracks: [{ ...track, matchedTitle: 'My title' }] })
  const current = {
    ...baseline,
    tracks: [{ ...track, trackId: 'new-track' }, { ...track, localTitle: 'Changed local title' }],
  }
  const restored = restoreCurateDraft(current, draft)
  assert.equal(restored.tracks[0].matchedTitle, 'Song')
  assert.equal(restored.tracks[1].matchedTitle, 'My title')
  assert.equal(restored.tracks[1].localTitle, 'Changed local title')
  assert.notEqual(captureCurateDraft(current).baseline, draft.baseline)
})
