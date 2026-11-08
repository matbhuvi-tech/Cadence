import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCurateCockpitCatalogProps } from '../core/curateWorkflow'
import { DEFAULT_PRIORITY_SETTINGS } from '../core/curatePriorities'
import type { Track, Release } from '../core/types'

test('Curate keeps raw catalog references alongside projected catalog and badge', () => {
  const tracks = [{ id: 'track', releaseId: 'album', title: 'Song' }] as Track[]
  const releases = [{ id: 'album', title: 'Film' }] as Release[]
  const result = buildCurateCockpitCatalogProps(tracks, releases, [], DEFAULT_PRIORITY_SETTINGS, {})
  assert.equal(result.rawTracks, tracks)
  assert.equal(result.rawReleases, releases)
  assert.equal(result.curateBadgeCount, 1)
})

test('a queued artist repair updates the badge while retaining the original album tags', () => {
  const release = {
    id: 'album', title: 'Film', artistCredit: '', releaseYear: 1990,
    genreTags: ['Rock'], coverArtUrl: 'cover.jpg',
  } as Release
  const track = {
    id: 'track', releaseId: 'album', title: 'Song', artistCredit: 'Singer',
    albumArtist: '', canonicalReleaseYear: 1990, genre: 'Rock',
  } as Track
  const before = buildCurateCockpitCatalogProps([track], [release], [], DEFAULT_PRIORITY_SETTINGS, {})
  const after = buildCurateCockpitCatalogProps([track], [release], [{
    id: 'commit', trackId: track.id, status: 'pending', payloadJson: JSON.stringify({ albumArtist: 'Album Artist' }),
  }], DEFAULT_PRIORITY_SETTINGS, {})
  assert.equal(before.curateBadgeCount, 1)
  assert.equal(after.curateBadgeCount, 0)
  assert.equal(after.rawTracks[0].albumArtist, '')
  assert.equal(after.tracks[0].albumArtist, 'Album Artist')
})
