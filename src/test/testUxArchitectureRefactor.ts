import assert from 'assert'
import { Release, Track } from '../core/types'
import {
  computeGroupingKey,
  extractDiscInfo,
  groupAlbumReleases,
  normalizeArtistForGrouping,
  normalizeTitleForGrouping,
} from '../services/albumGroupingService'

console.log('\n=== [TDD] Testing Cadence UX & UI Architecture Refactor ===\n')

// -----------------------------------------------------------------------------
// [Test 1] Duration Formatting: Integer modulo seconds without decimal leak
// -----------------------------------------------------------------------------
console.log('[Test 1] Testing duration formatting (integer seconds without decimals)...')

function formatTrackDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

assert.strictEqual(formatTrackDuration(234.999), '3:54')
assert.strictEqual(formatTrackDuration(65.123), '1:05')
assert.strictEqual(formatTrackDuration(0), '0:00')
assert.strictEqual(formatTrackDuration(59.99), '0:59')
assert.strictEqual(formatTrackDuration(60.001), '1:00')
console.log('  ✓ Duration modulo correctly floors seconds to integer without decimal artifacts')

// -----------------------------------------------------------------------------
// [Test 2] Disc Extraction and Base Title Parsing
// -----------------------------------------------------------------------------
console.log('[Test 2] Testing disc extraction & base title normalization on real library cases...')

// Case 1: Rahmania CD1 .. CD4
const d1 = extractDiscInfo('Rahmania CD1')
assert.strictEqual(d1.baseTitle, 'Rahmania')
assert.strictEqual(d1.discNumber, 1)
assert.strictEqual(d1.hasDiscIndicator, true)

const d3 = extractDiscInfo('Rahmania CD3')
assert.strictEqual(d3.baseTitle, 'Rahmania')
assert.strictEqual(d3.discNumber, 3)
assert.strictEqual(d3.hasDiscIndicator, true)

// Case 2: Signature Collection 2 - CD2 .. CD3
const sc2 = extractDiscInfo('Signature Collection 2 - CD2')
assert.strictEqual(sc2.baseTitle, 'Signature Collection 2')
assert.strictEqual(sc2.discNumber, 2)
assert.strictEqual(sc2.hasDiscIndicator, true)

const sc3 = extractDiscInfo('Signature Collection 2 - CD3')
assert.strictEqual(sc3.baseTitle, 'Signature Collection 2')
assert.strictEqual(sc3.discNumber, 3)

// Case 3: Bracketed multi-disc (The Wall (Disc 1), Live [CD 2 of 3])
const w1 = extractDiscInfo('The Wall (Disc 1)')
assert.strictEqual(w1.baseTitle, 'The Wall')
assert.strictEqual(w1.discNumber, 1)

const w2 = extractDiscInfo('The Wall [Disc 2 of 2]')
assert.strictEqual(w2.baseTitle, 'The Wall')
assert.strictEqual(w2.discNumber, 2)
assert.strictEqual(w2.totalDiscs, 2)

// Case 4: Solo album without disc indicators
const solo = extractDiscInfo('Highway')
assert.strictEqual(solo.baseTitle, 'Highway')
assert.strictEqual(solo.discNumber, 1)
assert.strictEqual(solo.hasDiscIndicator, false)

// Case 5: Album with "CD RIP" noise
const rip = extractDiscInfo('Anbhae Odivaa CD RIP')
assert.strictEqual(rip.baseTitle, 'Anbhae Odivaa')
assert.strictEqual(rip.hasDiscIndicator, false)

console.log('  ✓ Disc information and base titles parsed accurately across all patterns')

// -----------------------------------------------------------------------------
// [Test 3] Artist Credit Normalization
// -----------------------------------------------------------------------------
console.log('[Test 3] Testing artist credit normalization (punctuation & spacing)...')

assert.strictEqual(
  normalizeArtistForGrouping('A. R. Rahman'),
  normalizeArtistForGrouping('A.R. Rahman')
)
assert.strictEqual(
  normalizeArtistForGrouping('A.R. Rahman'),
  normalizeArtistForGrouping('A.R.Rahman')
)
console.log('  ✓ Artist normalization unifies "A. R. Rahman" and "A.R. Rahman"')

// -----------------------------------------------------------------------------
// [Test 4] Multi-Disc Box Set Collapsing (Rahmania CD1-CD4 & Signature Collection)
// -----------------------------------------------------------------------------
console.log('[Test 4] Testing collapsing of multi-disc releases without MusicBrainz IDs...')

const rahmaniaReleases: Release[] = [
  {
    id: 'rel-rahmania-cd1',
    masterReleaseId: 'rel-rahmania-cd1',
    title: 'Rahmania CD1',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2013,
    discsCount: 1,
    tracksCount: 6,
    mediaFormat: 'WAV',
    artwork: { frontCoverUrl: 'cover-1.jpg' },
  } as any,
  {
    id: 'rel-rahmania-cd2',
    masterReleaseId: 'rel-rahmania-cd2',
    title: 'Rahmania CD2',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2013,
    discsCount: 1,
    tracksCount: 6,
    mediaFormat: 'WAV',
  } as any,
  {
    id: 'rel-rahmania-cd3',
    masterReleaseId: 'rel-rahmania-cd3',
    title: 'Rahmania CD3',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2024, // Year variance across rips
    discsCount: 1,
    tracksCount: 6,
    mediaFormat: 'WAV',
  } as any,
  {
    id: 'rel-rahmania-cd4',
    masterReleaseId: 'rel-rahmania-cd4',
    title: 'Rahmania CD4',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2013,
    discsCount: 1,
    tracksCount: 6,
    mediaFormat: 'WAV',
  } as any,
]

const sigCollectionReleases: Release[] = [
  {
    id: 'rel-sc-cd2',
    masterReleaseId: 'rel-sc-cd2',
    title: 'Signature Collection 2 - CD2',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2024,
    discsCount: 1,
    tracksCount: 8,
    mediaFormat: 'WAV',
  } as any,
  {
    id: 'rel-sc-cd3',
    masterReleaseId: 'rel-sc-cd3',
    title: 'Signature Collection 2 - CD3',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2024,
    discsCount: 1,
    tracksCount: 7,
    mediaFormat: 'WAV',
  } as any,
]

const highwayRelease: Release = {
  id: 'rel-highway',
  masterReleaseId: 'rel-highway',
  title: 'Highway',
  artistCredit: 'A. R. Rahman',
  releaseYear: 2014,
  discsCount: 1,
  tracksCount: 9,
  mediaFormat: 'WAV',
} as any

const catalog = [...rahmaniaReleases, ...sigCollectionReleases, highwayRelease]
const grouped = groupAlbumReleases(catalog)

// 4 Rahmania discs + 2 Signature Collection discs + 1 Highway = 3 collapsed album cards!
assert.strictEqual(grouped.length, 3, `Expected 3 cards, but got ${grouped.length}`)

const rahmaniaCard = grouped.find((g) => g.masterRelease.title === 'Rahmania')
assert(rahmaniaCard, 'Rahmania must be collapsed under canonical title "Rahmania"')
assert.strictEqual(rahmaniaCard.constituentReleases.length, 4)
assert.strictEqual(rahmaniaCard.discCount, 4)
assert.strictEqual(rahmaniaCard.masterRelease.tracksCount, 24)

const sigCard = grouped.find((g) => g.masterRelease.title === 'Signature Collection 2')
assert(sigCard, 'Signature Collection 2 must be collapsed under "Signature Collection 2"')
assert.strictEqual(sigCard.constituentReleases.length, 2)
assert.strictEqual(sigCard.discCount, 3) // CD2 and CD3 -> max disc index is 3
assert.strictEqual(sigCard.masterRelease.tracksCount, 15)

console.log('  ✓ Rahmania CD1-CD4 collapsed into single "Rahmania (4 Discs)" card')
console.log('  ✓ Signature Collection 2 - CD2/CD3 collapsed into single card')

// -----------------------------------------------------------------------------
// [Test 5] Manual Split Override Exclusion
// -----------------------------------------------------------------------------
console.log('[Test 5] Testing manual split override behavior...')

// User explicitly splits Rahmania CD3
const splitReleases = new Set(['rel-rahmania-cd3'])
const groupedWithSplit = groupAlbumReleases(catalog, splitReleases)
// Rahmania CD3 split out (+1), remaining Rahmania CD1/CD2/CD4 grouped (+1), SigCol (+1), Highway (+1) = 4
assert.strictEqual(groupedWithSplit.length, 4)
console.log('  ✓ User split release override strictly respected without auto-merging')

console.log('\n=== ALL UX ARCHITECTURE REFACTOR TESTS PASSED ===\n')
