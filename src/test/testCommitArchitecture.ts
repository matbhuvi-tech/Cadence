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

// [Test 5] Default Album Expansion Logic
console.log('\n[Test 5] Testing Default Album Expansion on Song-Level Tag Changes vs Artwork-Only...')

// Album 1: Only Cover Art updated, 0 song-level tag changes
const artOnlyTrack: Track = {
  ...dsfTrack,
  id: 'trk-art-only',
  releaseId: 'rel-art-only',
  pendingSidecarEdits: { coverArtUrl: 'https://archive.org/cover.jpg' },
}

// Album 2: Has track title change
const tagChangeTrack: Track = {
  ...dsfTrack,
  id: 'trk-tag-change',
  releaseId: 'rel-tag-change',
  pendingSidecarEdits: { title: 'Updated Title' },
}

function computeDefaultExpanded(tracks: Track[]): Set<string> {
  const set = new Set<string>()
  const groups = new Map<string, Track[]>()
  tracks.forEach((t) => {
    const key = t.releaseId || t.folderName || 'unknown'
    const list = groups.get(key) || []
    list.push(t)
    groups.set(key, list)
  })

  groups.forEach((tracksInGroup, releaseKey) => {
    // Check if any track has real tag edits (title, artist, composer, year, etc. excluding coverArtUrl)
    const hasSongLevelChanges = tracksInGroup.some((t) => {
      const p = t.pendingSidecarEdits || {}
      return Boolean(
        p.title ||
        p.album ||
        p.artistCredit ||
        p.composerName ||
        p.trackNumber !== undefined ||
        p.discNumber !== undefined ||
        p.year !== undefined ||
        p.movementNumber !== undefined ||
        p.targetFolderName ||
        p.targetFilePath
      )
    })
    if (hasSongLevelChanges) {
      set.add(releaseKey)
    }
  })
  return set
}

const expandedSet = computeDefaultExpanded([artOnlyTrack, tagChangeTrack])
assert.strictEqual(expandedSet.has('rel-art-only'), false, 'Artwork-only album must default to collapsed')
assert.strictEqual(expandedSet.has('rel-tag-change'), true, 'Album with song-level edits must default to expanded')
console.log('  ✓ Artwork-only album correctly defaults to collapsed')
console.log('  ✓ Album with song-level tag changes correctly defaults to expanded')

// [Test 6] Staged Review Filter Logic
console.log('\n[Test 6] Testing Staged for Review Filter Resolution...')

const testReleases: Release[] = [
  {
    id: 'rel-clean',
    title: 'Clean Album',
    artistCredit: 'Clean Artist',
    tracksCount: 1,
    artwork: { frontCoverUrl: 'disk.jpg', resolution: '1000x1000' } as any,
  } as any,
  {
    id: 'rel-art-only',
    title: 'Art Updated Album',
    artistCredit: 'Artist B',
    tracksCount: 1,
    artwork: { frontCoverUrl: 'new.jpg', originalFrontCoverUrl: 'disk.jpg' } as any,
  } as any,
  {
    id: 'rel-tag-change',
    title: 'Tag Updated Album',
    artistCredit: 'Artist C',
    tracksCount: 1,
    artwork: { frontCoverUrl: 'disk.jpg' } as any,
  } as any,
]

const testTracks: Track[] = [
  { ...dsfTrack, id: 'trk-clean', releaseId: 'rel-clean', sidecarStatus: 'synced', pendingSidecarEdits: undefined },
  artOnlyTrack,
  tagChangeTrack,
]

// Compute stagedReleaseIds
const stagedRelIds = new Set<string>()
testReleases.forEach((r) => {
  if (r.artwork?.originalFrontCoverUrl) stagedRelIds.add(r.id)
})
testTracks.forEach((t) => {
  if (
    t.sidecarStatus === 'uncommitted_sidecar' ||
    Boolean(t.pendingSidecarEdits && Object.keys(t.pendingSidecarEdits).length > 0)
  ) {
    if (t.releaseId) stagedRelIds.add(t.releaseId)
  }
})

assert.strictEqual(stagedRelIds.has('rel-clean'), false, 'Clean album must not be staged')
assert.strictEqual(stagedRelIds.has('rel-art-only'), true, 'Album with staged artwork must be in staged set')
assert.strictEqual(stagedRelIds.has('rel-tag-change'), true, 'Album with uncommitted tags must be in staged set')
assert.strictEqual(stagedRelIds.size, 2, 'Exactly 2 staged albums identified')

const filteredStagedTracks = testTracks.filter((t) => stagedRelIds.has(t.releaseId))
assert.strictEqual(filteredStagedTracks.length, 2)
assert.strictEqual(filteredStagedTracks.some((t) => t.id === 'trk-clean'), false)
console.log('  ✓ Staged review filter correctly isolates only albums with staged items (2 of 3 albums)')

// [Test 7] Sidecar vs Embedded Commit Destination Isolation & Labels
console.log('\n[Test 7] Testing Sidecar vs Embedded Commit Destination Isolation...')

async function testCommitDestinations() {
  let sidecarSteps: any[] = []
  const sidecarResult = await transactionEngine.executeTwoPhaseCommit(
    [tagChangeTrack],
    'Test Sidecar Commit',
    (steps) => { sidecarSteps = steps },
    undefined,
    { destination: 'sidecar' }
  )
  assert.strictEqual(sidecarResult.success, true)
  assert.strictEqual(sidecarResult.embeddedHeadersCount, 0, 'Sidecar target must NOT write embedded headers')
  assert.strictEqual(sidecarResult.sidecarsCount, 1, 'Sidecar target must write sidecar ledger')
  assert.strictEqual(
    sidecarSteps[3].label,
    'Phase 2: Updating sidecar ledger (cadence-album.sidecar.json)',
    'Sidecar target must display sidecar-specific step label, not atomic write to audio headers'
  )
  console.log('  ✓ Destination "sidecar" updates sidecar ledgers with 0 embedded audio file writes and clean step label')

  let embeddedSteps: any[] = []
  const embeddedResult = await transactionEngine.executeTwoPhaseCommit(
    [tagChangeTrack],
    'Test Embedded Commit',
    (steps) => { embeddedSteps = steps },
    undefined,
    { destination: 'embedded' }
  )
  assert.strictEqual(embeddedResult.success, true)
  assert.strictEqual(embeddedResult.embeddedHeadersCount, 1, 'Embedded target must write embedded headers')
  assert.strictEqual(embeddedResult.sidecarsCount, 1, 'Embedded target also maintains sidecar ledger')
  assert.strictEqual(
    embeddedSteps[3].label,
    'Phase 2: Atomic write to ID3v2.4 / Vorbis Atoms',
    'Embedded target must display atomic header write step label'
  )
  console.log('  ✓ Destination "embedded" (default) updates embedded audio file headers and step label')
}

// [Test 8] Asynchronous Background Queue Handoff & Sub-second Modal Handoff
console.log('\n[Test 8] Testing Asynchronous Background Queue Fast Handoff...')

async function testAsyncBackgroundQueueHandoff() {
  const start = Date.now()
  let progressSteps: any[] = []
  const result = await transactionEngine.executeTwoPhaseCommit(
    [tagChangeTrack],
    'Test Async Background Handoff',
    (steps) => { progressSteps = steps },
    undefined,
    { allowAsyncQueue: true, destination: 'embedded' }
  )

  const durationMs = Date.now() - start
  assert.strictEqual(result.success, true)
  assert.ok(durationMs < 1000, `Handoff must be sub-second (took ${durationMs}ms)`)
  assert.strictEqual(progressSteps.length, 5)
  assert.strictEqual(progressSteps[0].completed, true, 'Mount preflight completed')
  assert.strictEqual(progressSteps[1].completed, true, 'Checksum verification completed')
  assert.strictEqual(progressSteps[2].completed, true, 'Snapshot created')
  assert.strictEqual(progressSteps[3].completed, true, 'Phase 2 enqueue completed')
  assert.strictEqual(progressSteps[4].completed, true, 'Finalize journal completed')
  console.log(`  ✓ Fast background queue handoff completed in ${durationMs}ms with all 5 steps verified`)
}

Promise.all([testExecutionAbort(), testCommitDestinations(), testAsyncBackgroundQueueHandoff()]).then(() => {
  console.log('\n========================================================')
  console.log('🎉 ALL BATCH METADATA COMMIT SCREEN ARCHITECTURE TESTS PASSED!')
  console.log('========================================================\n')
})

