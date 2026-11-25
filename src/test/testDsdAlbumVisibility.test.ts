import { test } from 'vitest'
import assert from 'assert'
import { Release, Track } from '../core/types'
import {
  extractAlbumComposers,
  matchesComposer,
  matchesSearchText,
  resolveKnownComposer,
} from '../core/taxonomyUtils'
import { graphEngine } from '../core/graphEngine'
import { groupAlbumReleases } from '../services/albumGroupingService'
import { resolveMediaUrl } from '../services/tauriBridge'

test('testDsdAlbumVisibility', () => {

console.log('\n=== Testing DSD Album Visibility & Multi-Edition Regressions ===\n')

function makeRelease(overrides: Partial<Release>): Release {
  return {
    id: 'rel-1',
    masterReleaseId: 'mr-1',
    title: 'Sample',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2000,
    originalYear: 2000,
    label: 'Sony Music',
    catalogNumber: 'CAT-1',
    mediaFormat: 'DSF',
    country: 'IN',
    matrixRunout: '',
    artwork: {
      frontCoverUrl: '',
      resolution: '1000x1000',
      width: 1000,
      height: 1000,
      dpi: 300,
      colorProfile: 'sRGB',
      isLowRes: false,
      hasBookletPdf: false,
    },
    variants: [],
    discsCount: 1,
    tracksCount: 1,
    genreTags: ['Soundtrack'],
    storageMountId: 'mount-1',
    ...overrides,
  }
}

function makeTrack(overrides: Partial<Track>): Track {
  return {
    id: 'trk-1',
    releaseId: 'rel-1',
    recordingId: 'rec-1',
    trackNumber: 1,
    discNumber: 1,
    title: 'Sample Track',
    artistCredit: 'Vocalist',
    durationSeconds: 240,
    filePath: '\\\\server\\music\\sample.dsf',
    fileSize: 1024,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: '2026-01-01T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 0,
    sampleRateStr: 'DSD256',
    format: 'DSD',
    credits: [],
    masterReleaseId: 'mr-1',
    ...overrides,
  }
}

console.log('[Test 1] Verifying resolveMediaUrl for local artwork cache paths and web URLs...')
assert.strictEqual(resolveMediaUrl(null), '')
assert.strictEqual(resolveMediaUrl(undefined), '')
assert.strictEqual(resolveMediaUrl('   '), '')
assert.strictEqual(resolveMediaUrl('https://example.com/cover.jpg'), 'https://example.com/cover.jpg')
assert.strictEqual(resolveMediaUrl('http://127.0.0.1:8080/cover.jpg'), 'http://127.0.0.1:8080/cover.jpg')
assert.strictEqual(resolveMediaUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA')
assert.strictEqual(resolveMediaUrl('asset://localhost/cover.jpg'), 'asset://localhost/cover.jpg')
const localCover = 'C:\\Users\\Mathan\\AppData\\Roaming\\com.cadence.core\\cache\\artwork\\rel-c824.jpg'
// Non-Tauri fallback preserves raw path
assert.strictEqual(resolveMediaUrl(localCover), localCover)
// Simulated Tauri WebView2 runtime converts local path via convertFileSrc
const prevWindow = (globalThis as any).window
;(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    convertFileSrc: (filePath: string, protocol = 'asset') =>
      `http://${protocol}.localhost/${encodeURIComponent(filePath)}`,
  },
}
try {
  const winArtwork = resolveMediaUrl(localCover)
  assert.ok(
    winArtwork.startsWith('http://asset.localhost/'),
    `Expected Tauri asset URL conversion, got: ${winArtwork}`
  )
} finally {
  if (prevWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = prevWindow
}
console.log('  ✓ resolveMediaUrl converts local artwork paths and preserves remote/data URLs')

console.log('[Test 2] Verifying resolveKnownComposer and matchesComposer for albumArtist fallback (I Sony)...')
const rahmanKnown = resolveKnownComposer('A.R. Rahman')
assert.deepStrictEqual(rahmanKnown, { canonicalName: 'A. R. Rahman', key: 'ar-rahman' })
assert.strictEqual(resolveKnownComposer('Sid Sriram'), null)

const iSonyTrack = makeTrack({
  id: 'trk-i-sony-1',
  releaseId: 'rel-c824',
  title: 'Mersalaayitten',
  artistCredit: 'Anirudh Ravichander, Neeti Mohan',
  albumArtist: 'A. R. Rahman',
  composerName: undefined,
})
assert.strictEqual(matchesComposer(iSonyTrack, 'A. R. Rahman'), true)
assert.strictEqual(matchesComposer(iSonyTrack, 'Ilaiyaraaja'), false)
console.log('  ✓ Composer matching detects known composer from albumArtist when composerName is omitted')

console.log('[Test 3] Verifying multi-edition DSD stacks keep discCount=1 instead of mislabeling editions as discs...')
const variantA = {
  id: 'var-a',
  releaseId: 'rel-fd50',
  masterReleaseId: 'mr-alaipayuthey',
  releaseName: 'Alaipayuthay CD Rip [PGGB]',
  variantName: 'CD Rip',
  releaseYear: 2000,
  sampleRateStr: 'DSD256',
  formatStr: 'DSF',
  matrixRunout: '',
  catalogNumber: '',
  label: '',
  isCurrentMaster: true,
  country: 'IN',
}
const variantB = {
  ...variantA,
  id: 'var-b',
  releaseId: 'rel-a172',
  releaseName: 'Alaipayuthey ',
  variantName: 'DSF Edition',
  isCurrentMaster: false,
}
const relE = makeRelease({
  id: 'rel-fd50',
  masterReleaseId: 'mr-alaipayuthey',
  title: 'Alaipayuthay CD Rip [PGGB]',
  variants: [variantA, variantB],
})
const relNas = makeRelease({
  id: 'rel-a172',
  masterReleaseId: 'mr-alaipayuthey',
  title: 'Alaipayuthey ',
  variants: [variantA, variantB],
})

const grouped = groupAlbumReleases([relE, relNas])
assert.strictEqual(grouped.length, 1, 'Expected both editions to group into 1 master card')
assert.strictEqual(grouped[0].discCount, 1, 'Expected 2 editions without disc indicators to report discCount=1')
assert.strictEqual(grouped[0].masterRelease.variants.length, 2, 'Expected variantsCount=2 on stacked master card')
console.log('  ✓ Multi-edition stack preserves discCount=1 and variants.length=2')

console.log('[Test 4] Verifying extractAlbumComposers 1:1 parity for Core tracks without composerName...')
const coreArrTrack = makeTrack({
  id: 'trk-core-arr',
  releaseId: 'rel-core-arr',
  title: 'Dil Se',
  artistCredit: 'A.R. Rahman',
  albumArtist: 'A. R. Rahman',
  composerName: undefined,
  format: 'WAV',
  sampleRateStr: '44.1 kHz',
})
const coreComposers = extractAlbumComposers({
  composerName: undefined,
  artistCredit: 'A.R. Rahman',
  tracks: [coreArrTrack],
})
assert.deepStrictEqual(coreComposers, [
  { key: 'ar-rahman', canonicalName: 'A. R. Rahman', count: 1 },
])

const mixedComposerPunctuation = extractAlbumComposers({
  composerName: 'A.R. Rahman',
  artistCredit: 'A. R. Rahman',
  tracks: [
    makeTrack({ id: 't-1', composerName: 'A. R. Rahman' }),
    makeTrack({ id: 't-2', composerName: 'A.R. Rahman' }),
  ],
})
assert.deepStrictEqual(mixedComposerPunctuation, [
  { key: 'ar-rahman', canonicalName: 'A. R. Rahman', count: 2 },
])

const msvTrack = makeTrack({
  id: 'trk-msv',
  releaseId: 'rel-msv',
  title: 'Ninaithale Inikkum',
  artistCredit: 'S. P. Balasubrahmanyam',
  albumArtist: 'M.S.V',
  composerName: undefined,
})
assert.strictEqual(matchesComposer(msvTrack, 'M. S. Viswanathan (M.S.V)'), true)
console.log('  ✓ extractAlbumComposers & matchesComposer unify punctuation and Core fallbacks cleanly')

console.log('[Test 5] Verifying punctuation-insensitive search matching ("A.R.Rahman" -> "A. R. Rahman")...')
assert.strictEqual(matchesSearchText('A. R. Rahman', 'A.R.Rahman'), true)
assert.strictEqual(matchesSearchText('A.R. Rahman', 'a r rahman'), true)
assert.strictEqual(matchesSearchText('I (Sony)', 'i sony'), true)
assert.strictEqual(matchesSearchText('Ilaiyaraaja', 'A.R.Rahman'), false)

const coreFilteredArr = graphEngine.filterTracks(
  {
    searchQuery: 'A.R.Rahman',
    selectedComposer: '',
    selectedEra: '',
    selectedFormat: '',
    selectedLanguage: '',
    selectedAlbumCategory: '',
    selectedResolution: '',
    showFavoritesOnly: false,
  },
  [coreArrTrack, msvTrack],
  [
    makeRelease({ id: 'rel-core-arr', title: 'Dil Se', artistCredit: 'A. R. Rahman', composerName: undefined }),
    makeRelease({ id: 'rel-msv', title: 'Ninaithale Inikkum', artistCredit: 'M.S.V', composerName: undefined }),
  ]
)
assert.strictEqual(coreFilteredArr.length, 1, 'Expected "A.R.Rahman" query to match "A. R. Rahman" Core track')
assert.strictEqual(coreFilteredArr[0].id, 'trk-core-arr')
console.log('  ✓ filterTracks & matchesSearchText match separator/spacing variants accurately')

console.log('\n=== ALL DSD ALBUM VISIBILITY TESTS PASSED ===\n')

})
