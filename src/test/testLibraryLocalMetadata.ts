import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { SqliteLibraryService } from '../services/sqliteLibraryService'
import { tauriBridge } from '../services/tauriBridge'
import { captureCurateDraft, restoreCurateDraft } from '../core/curateDraft'
import type { Track, MetadataFieldState } from '../core/types'

const original = {
  id: 'track-1', releaseId: 'album-1', title: 'Kuyile Kuyile Kuyilakka',
  artistCredit: 'K. J. Yesudas, K. S. Chithra', composer: 'Ilaiyaraaja',
  albumArtist: 'Ilaiyaraaja', albumTitle: 'En Bommukutti Amavuku',
  trackNumber: 1, mtime: 1, format: 'WAV', sampleRate: 44100, bitDepth: 16,
  filePath: 'C:/fixture/song.wav', folderName: 'En Bommukutti Amavuku',
}
const pending = {
  artistCredit: 'Ilaiyaraaja, K. J. Yesudas & K. S. Chithra',
  composerName: 'Proposed composer', albumArtist: 'Proposed album artist',
  title: 'Kuyile Kuyile',
}

async function loadTrack(t: TestContext, row: typeof original & { sidecarEditsJson?: string; sidecarStatus?: string }) {
  t.mock.method(tauriBridge, 'isTauri', () => true)
  t.mock.method(tauriBridge, 'checkStorageMountsAccessibility', async () => [])
  t.mock.method(tauriBridge, 'dbGetStorageMounts', async () => [])
  t.mock.method(tauriBridge, 'dbGetWatchedFolders', async () => [])
  t.mock.method(tauriBridge, 'dbGetTracks', async () => [row])
  t.mock.method(tauriBridge, 'dbGetReleases', async () => [])
  t.mock.method(tauriBridge, 'dbGetSkippedFiles', async () => [])
  t.mock.method(tauriBridge, 'dbGetOfflineCounts', async () => [0, 0])
  const library = await new SqliteLibraryService().loadLibraryFromDb()
  assert.ok(library)
  return library.tracks[0]
}

const field = (value: string): MetadataFieldState<string> => ({
  local: value, selected: value, source: 'local_fallback', confidence: 1,
})
function proposal(track: Track) {
  return {
    albumTitle: field(track.albumTitle!), albumArtist: field(track.albumArtist || ''),
    composer: field(track.composerName || ''), genre: field('Soundtrack'), coverArt: field(''),
    year: { local: 1988, selected: 1988, source: 'local_fallback', confidence: 1 } as MetadataFieldState<number | undefined>,
    tracks: [{
      trackId: track.id, trackNumber: track.trackNumber, localTitle: track.title,
      localArtists: track.artistCredit, matchedTitle: pending.title,
      matchedArtists: pending.artistCredit, source: 'user_override', confidence: 1,
    }],
  }
}

test('library reload keeps pending credits separate from original catalog metadata', async t => {
  const loaded = await loadTrack(t, {
    ...original, sidecarStatus: 'uncommitted_sidecar', sidecarEditsJson: JSON.stringify(pending),
  })
  assert.equal(loaded.artistCredit, original.artistCredit)
  assert.equal(loaded.composerName, original.composer)
  assert.equal(loaded.albumArtist, original.albumArtist)
  assert.equal(loaded.title, original.title)
  assert.deepEqual(loaded.pendingSidecarEdits, pending)
  assert.equal(loaded.sidecarStatus, 'uncommitted_sidecar')
})

test('reopening a draft after reload preserves selections without a false baseline conflict', async t => {
  const before = await loadTrack(t, original)
  const draft = JSON.parse(JSON.stringify(captureCurateDraft(proposal(before))))
  const after = await loadTrack(t, { ...original, sidecarEditsJson: JSON.stringify(pending) })
  const current = proposal(after)
  assert.equal(captureCurateDraft(current).baseline, draft.baseline)
  const restored = restoreCurateDraft(current, draft)
  assert.equal(restored.tracks[0].matchedArtists, pending.artistCredit)
  assert.equal(restored.tracks[0].localArtists, original.artistCredit)
})

for (const key of ['artistCredit', 'composer', 'albumArtist'] as const) {
  test(`a genuine catalog ${key} change still invalidates the saved draft`, async t => {
    const before = await loadTrack(t, original)
    const draft = captureCurateDraft(proposal(before))
    const after = await loadTrack(t, {
      ...original, [key]: 'Changed on disk', sidecarEditsJson: JSON.stringify(pending),
    })
    const current = proposal(after)
    assert.notEqual(captureCurateDraft(current).baseline, draft.baseline)
    const restored = restoreCurateDraft(current, draft)
    assert.equal(restored.tracks[0].matchedArtists, pending.artistCredit)
  })
}

test('pending credits do not fill missing original credits', async t => {
  const loaded = await loadTrack(t, {
    ...original, artistCredit: '', composer: '', albumArtist: '',
    sidecarEditsJson: JSON.stringify(pending),
  })
  assert.equal(loaded.artistCredit, '')
  assert.equal(loaded.composerName, '')
  assert.equal(loaded.albumArtist, undefined)
  assert.deepEqual(loaded.pendingSidecarEdits, pending)
})
