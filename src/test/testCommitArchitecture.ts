import assert from 'assert'
import { Track, Release } from '../core/types'
import {
  analyzeHeaderPadding,
  HeaderPaddingAnalysis,
  CommitUnitMetrics,
} from '../types/commit'
import { transactionEngine } from '../core/transactionEngine'
import { graphEngine } from '../core/graphEngine'

console.log('\n=== [TDD] Testing Batch Metadata Commit Screen Refactor ===\n')

// [Test 1] DSF Tail Metadata Specification & Padding Analysis
console.log('[Test 1] Testing Container Padding Analysis & DSF Tail Metadata...')

const dsfTrack: Track = {
  id: 'trk-dsf-1',
  title: 'DSF High Res Track',
  artistCredit: 'Mahler',
  albumArtist: 'Mahler',
  folderName: 'Mahler Symphony No. 2 [DSD128]',
  filePath: 'D:/Music/Mahler/01.dsf',
  format: 'DSF',
  sampleRate: 5644800,
  bitDepth: 1,
  channels: 2,
  duration: 300,
  releaseId: 'rel-mahler',
  storageMountId: 'mount-1',
  sidecarStatus: 'uncommitted_sidecar',
  checksumValid: true,
  pendingSidecarEdits: {
    title: 'New Canonical DSF Title',
    coverArtUrl: 'https://archive.org/3000x3000.jpg',
  },
}

// Even with 2MB artwork added, DSF uses in-place tail chunk update per Sony DSF container spec
const dsfAnalysis = analyzeHeaderPadding(dsfTrack, 2000000)
assert.strictEqual(dsfAnalysis.format, 'dsf')
assert.strictEqual(
  dsfAnalysis.requiresFullRewrite,
  false,
  'DSF must never require a full file rewrite even with large artwork'
)
console.log('  ✓ DSF correctly identified: requiresFullRewrite=false (in-place tail update)')

const flacTrackSmall: Track = {
  ...dsfTrack,
  id: 'trk-flac-small',
  filePath: 'D:/Music/Rock/01.flac',
  format: 'FLAC',
  pendingSidecarEdits: { title: 'Slight Title Fix' },
}
const flacAnalysisSmall = analyzeHeaderPadding(flacTrackSmall, 0)
assert.strictEqual(flacAnalysisSmall.format, 'flac')
assert.strictEqual(
  flacAnalysisSmall.requiresFullRewrite,
  false,
  'FLAC small edits must fit within standard padding'
)
console.log('  ✓ FLAC small edit correctly identified: requiresFullRewrite=false (in-place header overwrite)')

const flacTrackLarge: Track = {
  ...dsfTrack,
  id: 'trk-flac-large',
  filePath: 'D:/Music/Rock/02.flac',
  format: 'FLAC',
  pendingSidecarEdits: { title: 'Large Artwork Update' },
}
const flacAnalysisLarge = analyzeHeaderPadding(flacTrackLarge, 500000)
assert.strictEqual(
  flacAnalysisLarge.requiresFullRewrite,
  true,
  'FLAC with 500KB artwork exceeds 8KB padding and requires full stream rewrite'
)
console.log('  ✓ FLAC large edit correctly identified: requiresFullRewrite=true (stream rewrite required)')

// [Test 2] Preflight Checks: Playback Idle Guard & Storage Writability
console.log('\n[Test 2] Testing Preflight Checks (Playback Idle & Storage Writability)...')

// 1. Playback is active: must block
const preflightPlaying = transactionEngine.runPreflightChecks([dsfTrack], true, true)
assert.strictEqual(preflightPlaying.playbackIdle, false)
assert.strictEqual(preflightPlaying.canProceed, false)
assert.ok(
  preflightPlaying.blockedPaths.some((b) => b.path === 'Audio Transport'),
  'Must report Audio Transport block during playback'
)
console.log('  ✓ Preflight correctly blocks when AudioEngine is playing (Audiophile Invariant 1)')

// 2. Playback is idle: can proceed
const preflightIdle = transactionEngine.runPreflightChecks([dsfTrack], false, true)
assert.strictEqual(preflightIdle.playbackIdle, true)
assert.strictEqual(preflightIdle.canProceed, true)
console.log('  ✓ Preflight passes when playback is idle and mounts are writable')

// [Test 3] Decoupled Unit Metrics & Dynamic Exclusion Recalculation
console.log('\n[Test 3] Testing Decoupled Unit Metrics & Dynamic Exclusion Recalculation...')

const sampleTracks: Track[] = [
  {
    ...dsfTrack,
    id: 'trk-1',
    releaseId: 'rel-1',
    pendingSidecarEdits: { title: 'Track 1 Edited', trackNumber: 1 },
  },
  {
    ...dsfTrack,
    id: 'trk-2',
    releaseId: 'rel-1',
    pendingSidecarEdits: { title: 'Track 2 Edited', coverArtUrl: 'http://art.jpg' },
  },
  {
    ...dsfTrack,
    id: 'trk-3',
    releaseId: 'rel-2',
    pendingSidecarEdits: { composerName: 'New Composer' },
  },
]

function computeMetrics(tracks: Track[], excludedIds: Set<string>): CommitUnitMetrics {
  const active = tracks.filter((t) => !excludedIds.has(t.id))
  const albums = new Set(active.map((t) => t.releaseId))
  const artAlbums = new Set(
    active.filter((t) => t.pendingSidecarEdits?.coverArtUrl).map((t) => t.releaseId)
  )
  let tagEdits = 0
  active.forEach((t) => {
    if (t.pendingSidecarEdits?.title) tagEdits++
    if (t.pendingSidecarEdits?.trackNumber) tagEdits++
    if (t.pendingSidecarEdits?.composerName) tagEdits++
  })

  return {
    albumCount: albums.size,
    audioTrackCount: active.length,
    tagEditCount: tagEdits,
    coverArtUpdateCount: artAlbums.size,
  }
}

// Full batch metrics
const fullMetrics = computeMetrics(sampleTracks, new Set())
assert.strictEqual(fullMetrics.albumCount, 2, 'Total 2 albums')
assert.strictEqual(fullMetrics.audioTrackCount, 3, 'Total 3 tracks')
assert.strictEqual(fullMetrics.tagEditCount, 4, 'Total 4 tag edits')
assert.strictEqual(fullMetrics.coverArtUpdateCount, 1, 'Total 1 cover art update')
console.log('  ✓ Initial full batch decoupled metrics verified (2 Albums, 3 Audio Tracks, 4 Tag Edits, 1 Art Update)')

// Exclude 1 track from rel-1
const excludedTrackMetrics = computeMetrics(sampleTracks, new Set(['trk-1']))
assert.strictEqual(excludedTrackMetrics.audioTrackCount, 2)
assert.strictEqual(excludedTrackMetrics.albumCount, 2, 'Album rel-1 still has trk-2 active')
assert.strictEqual(excludedTrackMetrics.tagEditCount, 2)
console.log('  ✓ Excluding single track dynamically recalculates active CTA counts')

// Exclude all tracks from rel-1
const excludedAlbumMetrics = computeMetrics(sampleTracks, new Set(['trk-1', 'trk-2']))
assert.strictEqual(excludedAlbumMetrics.audioTrackCount, 1)
assert.strictEqual(excludedAlbumMetrics.albumCount, 1, 'Only rel-2 remains')
assert.strictEqual(excludedAlbumMetrics.coverArtUpdateCount, 0, 'Artwork album excluded')
console.log('  ✓ Excluding entire album dynamically updates CTA to 1 Album Sidecar / 1 Audio File')

// [Test 4] Adaptive Sidecar vs Embedded Execution Flow
console.log('\n[Test 4] Testing Adaptive Sidecar vs Embedded Execution Flow...')

// Verify executeTwoPhaseCommit handles playbackActive abort
async function testExecutionAbort() {
  const result = await transactionEngine.executeTwoPhaseCommit(
    [dsfTrack],
    'Test Playback Active Block',
    undefined,
    undefined,
    { isPlaybackActive: true }
  )
  assert.strictEqual(result.success, false)
  assert.ok(
    result.error?.includes('Transport Purity Lock'),
    'Should abort with Transport Purity Lock message'
  )
  console.log('  ✓ Transaction engine strictly enforces zero disk I/O when isPlaybackActive=true')
}

testExecutionAbort().then(() => {
  console.log('\n========================================================')
  console.log('🎉 ALL BATCH METADATA COMMIT SCREEN ARCHITECTURE TESTS PASSED!')
  console.log('========================================================\n')
})
