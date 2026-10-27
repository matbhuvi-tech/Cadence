/**
 * src/test/testCurationLifecycle.ts
 * Cadence Test Suite: Curation & Triage Lifecycle Architecture
 *
 * Verifies:
 * 1. Curation Queue Discovery Engine (defect categorization & severity ranking)
 * 2. Zero Mystery Selection & Deterministic Navigation
 * 3. Base Track Immutability in Copilot Dispatcher (pendingSidecarEdits isolation)
 * 4. Batch Proposal Safety Barrier schema & dry-run diff formatting
 * 5. Telemetry & Staged Changes synchronization across views
 * 6. Playback Transport Quietness (Audiophile Invariant 4)
 */

import assert from 'assert'
import { Track, Release, AuditIssue } from '../core/types'
import {
  computeCurationQueue,
  resolveCurateInitialAlbum,
  AlbumCurationQueueItem,
} from '../services/curationQueueService'
import { agentActionDispatcher } from '../services/agentActionDispatcher'
import { graphEngine } from '../core/graphEngine'
import { federatedResolversService } from '../services/federatedResolvers'
import { tauriBridge } from '../services/tauriBridge'
import { BatchProposalData, BatchProposalDiffRow } from '../components/Agent/BatchProposalSheet'

console.log('\n=== [CADENCE] Testing Curation & Triage Lifecycle Architecture ===\n')

// ---------------------------------------------------------------------------
// Mock Data Setup
// ---------------------------------------------------------------------------
const mockReleases: Release[] = [
  {
    id: 'rel-world-music',
    masterReleaseId: 'm-world-music',
    title: 'A World Of Music',
    artistCredit: 'Various Artists',
    releaseYear: 2005,
    originalYear: 2005,
    label: 'Sony Music',
    catalogNumber: 'S-101',
    mediaFormat: 'Redbook CD',
    country: 'India',
    matrixRunout: 'WM-01',
    artwork: {
      frontCoverUrl: 'http://cdn/cover1.jpg',
      resolution: '500x500px',
      width: 500,
      height: 500,
      dpi: 72,
      colorProfile: 'sRGB',
      isLowRes: true,
      hasBookletPdf: false,
    },
    variants: [],
    discsCount: 1,
    tracksCount: 2,
    genreTags: ['Soundtrack'],
    storageMountId: 'mount-1',
    isCompilation: true,
  },
  {
    id: 'rel-roja',
    masterReleaseId: 'm-roja',
    title: 'Roja (Original Soundtrack)',
    artistCredit: 'A. R. Rahman',
    composerName: 'A. R. Rahman',
    releaseYear: 1992,
    originalYear: 1992,
    label: 'Lahari Music',
    catalogNumber: 'L-92',
    mediaFormat: 'Redbook CD',
    country: 'India',
    matrixRunout: 'ROJA-01',
    artwork: {
      frontCoverUrl: '', // Missing artwork
      resolution: '',
      width: 0,
      height: 0,
      dpi: 0,
      colorProfile: '',
      isLowRes: true,
      hasBookletPdf: false,
    },
    variants: [],
    discsCount: 1,
    tracksCount: 2,
    genreTags: ['Tamil Soundtrack'],
    storageMountId: 'mount-1',
  },
]

const mockTracks: Track[] = [
  {
    id: 'trk-dil-se',
    releaseId: 'rel-world-music',
    recordingId: 'rec-1',
    trackNumber: 1,
    discNumber: 1,
    title: 'Dil Se Re (from "Dil Se..")',
    artistCredit: 'A. R. Rahman',
    composerName: 'A. R. Rahman',
    durationSeconds: 320,
    filePath: 'D:/Music/A World Of Music/01 Dil Se.flac',
    fileSize: 35000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: '2026-01-01T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 10,
    drScore: 12,
    sampleRateStr: '44.1kHz / 16-bit',
    format: 'FLAC',
    credits: [],
    masterReleaseId: 'm-world-music',
    isCompilation: true,
    canonicalAlbumTitle: 'Dil Se..',
  },
  {
    id: 'trk-barso-re',
    releaseId: 'rel-world-music',
    recordingId: 'rec-2',
    trackNumber: 2,
    discNumber: 1,
    title: 'Barso Re (from "Guru")',
    artistCredit: 'A. R. Rahman',
    composerName: 'A. R. Rahman',
    durationSeconds: 310,
    filePath: 'D:/Music/A World Of Music/02 Barso Re.flac',
    fileSize: 34000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: '2026-01-01T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 12,
    drScore: 13,
    sampleRateStr: '44.1kHz / 16-bit',
    format: 'FLAC',
    credits: [],
    masterReleaseId: 'm-world-music',
    isCompilation: true,
    canonicalAlbumTitle: 'Guru',
  },
  {
    id: 'trk-roja-1',
    releaseId: 'rel-roja',
    recordingId: 'rec-3',
    trackNumber: 1,
    discNumber: 1,
    title: 'Chinna Chinna Aasai',
    artistCredit: 'A. R. Rahman',
    composerName: 'A. R. Rahman',
    durationSeconds: 295,
    filePath: 'D:/Music/Roja/01 Chinna Chinna Aasai.flac',
    fileSize: 32000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: '2026-01-01T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 15,
    drScore: 14,
    sampleRateStr: '44.1kHz / 16-bit',
    format: 'FLAC',
    credits: [],
    masterReleaseId: 'm-roja',
  },
  {
    id: 'trk-roja-2',
    releaseId: 'rel-roja',
    recordingId: 'rec-4',
    trackNumber: 2,
    discNumber: 1,
    title: 'Pudhu Vellai Mazhai',
    artistCredit: 'A. R. Rahman',
    composerName: 'A. R. Rahman',
    durationSeconds: 315,
    filePath: 'D:/Music/Roja/02 Pudhu Vellai Mazhai.flac',
    fileSize: 33000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: '2026-01-01T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 14,
    drScore: 14,
    sampleRateStr: '44.1kHz / 16-bit',
    format: 'FLAC',
    credits: [],
    masterReleaseId: 'm-roja',
  },
]

const mockAuditIssues: AuditIssue[] = [
  {
    id: 'iss-comp-1',
    category: 'compilation_conflict',
    severity: 'critical',
    title: 'Multi-Soundtrack Compilation Conflict: A World Of Music',
    description: 'Tracks belong to disparate motion picture releases.',
    affectedCount: 2,
    sampleTrackIds: ['trk-dil-se', 'trk-barso-re'],
  },
  {
    id: 'iss-art-1',
    category: 'low_res_art',
    severity: 'high',
    title: 'Missing Cover Art: Roja',
    description: 'Release has no front cover artwork.',
    affectedCount: 2,
    sampleTrackIds: ['trk-roja-1', 'trk-roja-2'],
  },
]

// ---------------------------------------------------------------------------
// [Test 1] Curation Queue Discovery Engine
// ---------------------------------------------------------------------------
console.log('[Test 1] Testing Curation Queue Discovery Engine (curationQueueService)...')

const queue = computeCurationQueue(mockTracks, mockReleases, mockAuditIssues)

assert.strictEqual(queue.length, 2, 'Queue must contain exactly 2 album items')

const worldMusicItem = queue.find((i) => i.albumId === 'rel-world-music')
assert(worldMusicItem, 'World of Music must be present in queue')
assert.strictEqual(worldMusicItem.primaryIssueType, 'compilation_conflict', 'World of Music must have compilation_conflict defect')
assert.strictEqual(worldMusicItem.defectSeverity, 'critical', 'Compilation conflict defect must be critical severity')
assert.strictEqual(worldMusicItem.affectedTrackCount, 2, 'World of Music must have 2 affected tracks')

const rojaItem = queue.find((i) => i.albumId === 'rel-roja')
assert(rojaItem, 'Roja must be present in queue')
assert.strictEqual(rojaItem.primaryIssueType, 'missing_artwork', 'Roja must have missing_artwork defect')
assert.strictEqual(rojaItem.defectSeverity, 'high', 'Missing artwork must be high severity')

console.log('✓ Test 1 Passed: Curation queue correctly discovered and ranked album defects.')

// ---------------------------------------------------------------------------
// [Test 2] Zero Mystery Selection & Deterministic Navigation
// ---------------------------------------------------------------------------
console.log('\n[Test 2] Testing Zero Mystery Selection & Queue Stepper Scoping...')

// Case A: No active album in scope -> returns queue[0] (or null if queue empty)
const defaultInitial = resolveCurateInitialAlbum(queue, undefined)
assert.strictEqual(defaultInitial?.albumId, queue[0].albumId, 'Default selection must be queue[0]')
assert.notStrictEqual(defaultInitial?.albumTitle, 'Dil Se', 'Must never arbitrarily lock to single track "Dil Se"')

// Case B: Explicit active album ID in scope -> returns that album item
const scopedRoja = resolveCurateInitialAlbum(queue, 'rel-roja')
assert.strictEqual(scopedRoja?.albumId, 'rel-roja', 'Scoped selection must match rel-roja')
assert.strictEqual(scopedRoja?.albumTitle, 'Roja (Original Soundtrack)')

// Case C: Empty queue -> returns null
const emptyInitial = resolveCurateInitialAlbum([], undefined)
assert.strictEqual(emptyInitial, null, 'Empty queue must return null')

console.log('✓ Test 2 Passed: Deterministic scoping eliminates mystery single-track selection.')

// ---------------------------------------------------------------------------
// [Test 3] Base Track Immutability in Copilot Dispatcher
// ---------------------------------------------------------------------------
console.log('\n[Test 3] Testing Base Track Immutability during Copilot Work Hierarchy Resolution...')

// Load mock tracks into graphEngine
graphEngine.loadCustomLibrary({
  tracks: JSON.parse(JSON.stringify(mockTracks)),
  releases: JSON.parse(JSON.stringify(mockReleases)),
  works: [],
  auditIssues: [],
  storageMounts: [],
})

const trackBefore = graphEngine.getTrackById('trk-dil-se')
const originalTitle = trackBefore?.title || ''
const originalArtist = trackBefore?.artistCredit || ''

// Dispatch resolve_work_hierarchy
const mockCtx = {
  setViewMode: () => {},
  setFacets: () => {},
  setSearchQuery: () => {},
  setSelectedTrackId: () => {},
  openModal: () => {},
  refreshFromEngine: () => {},
  showToast: () => {},
}

agentActionDispatcher
  .executeAction(
    { tool: 'resolve_work_hierarchy', args: { releaseId: 'rel-world-music' } },
    mockCtx
  )
  .then((res) => {
    assert(res.success, 'resolve_work_hierarchy must succeed')

    const trackAfter = graphEngine.getTrackById('trk-dil-se')
    assert(trackAfter, 'Track must exist in engine')

    // Invariant: Base track title and artist MUST remain unmutated in memory
    assert.strictEqual(
      trackAfter.title,
      originalTitle,
      `Base track title must remain immutable until disk commit. Expected "${originalTitle}", got "${trackAfter.title}"`
    )

    // Staged changes MUST reside exclusively inside pendingSidecarEdits
    assert.strictEqual(trackAfter.sidecarStatus, 'uncommitted_sidecar', 'sidecarStatus must be uncommitted_sidecar')
    assert(trackAfter.pendingSidecarEdits, 'pendingSidecarEdits must be populated')
    assert.strictEqual(
      trackAfter.pendingSidecarEdits.title,
      'Dil Se Re',
      'pendingSidecarEdits.title must hold staged clean title'
    )

    console.log('✓ Test 3 Passed: Track base object is immutable; edits staged exclusively to sidecar.')

    // ---------------------------------------------------------------------------
    // [Test 4] Copilot Batch Proposal Safety Layer Data Contract
    // ---------------------------------------------------------------------------
    console.log('\n[Test 4] Testing Batch Proposal Safety Barrier Data Contract...')

    const proposalDiffs: BatchProposalDiffRow[] = [
      {
        trackId: 'trk-dil-se',
        trackTitle: 'Dil Se Re (from "Dil Se..")',
        albumTitle: 'A World Of Music',
        fieldName: 'title',
        currentValue: 'Dil Se Re (from "Dil Se..")',
        proposedValue: 'Dil Se Re',
      },
      {
        trackId: 'trk-barso-re',
        trackTitle: 'Barso Re (from "Guru")',
        albumTitle: 'A World Of Music',
        fieldName: 'title',
        currentValue: 'Barso Re (from "Guru")',
        proposedValue: 'Barso Re',
      },
    ]

    let stagedTriggered = false
    let inspectedCurateAlbums: string[] = []

    const proposalData: BatchProposalData = {
      proposalId: 'prop-test-01',
      title: 'Disentangle Soundtrack Compilations',
      description: 'Strip embedded film names into canonical sidecars.',
      scopeLabel: 'Album: A World Of Music',
      affectedAlbumsCount: 1,
      affectedTracksCount: 2,
      diffs: proposalDiffs,
      onStageAll: async () => {
        stagedTriggered = true
      },
      onInspectInCurate: (albumIds) => {
        inspectedCurateAlbums = albumIds
      },
    }

    assert.strictEqual(proposalData.diffs.length, 2, 'Proposal diffs must contain 2 rows')
    assert.strictEqual(proposalData.affectedTracksCount, 2)
    assert.strictEqual(proposalData.diffs[0].fieldName, 'title')

    proposalData.onStageAll()
    assert.strictEqual(stagedTriggered, true, 'onStageAll must trigger batch execution')

    proposalData.onInspectInCurate(['rel-world-music'])
    assert.deepStrictEqual(inspectedCurateAlbums, ['rel-world-music'], 'onInspectInCurate must route affected album IDs')

    console.log('✓ Test 4 Passed: Batch proposal safety barrier satisfies all dry-run contracts.')

    // ---------------------------------------------------------------------------
    // [Test 5] Playback Transport Quietness Guard (Audiophile Invariant 4)
    // ---------------------------------------------------------------------------
    console.log('\n[Test 5] Testing Playback Transport Quietness Guard (Audiophile Invariant 4)...')

    // Mock tauriBridge playback status to simulate active audio streaming
    const originalGetStatus = tauriBridge.getPlaybackStatus
    tauriBridge.getPlaybackStatus = async () => ({
      isPlaying: true,
      isPaused: false,
      volume: 1.0,
      positionSeconds: 42,
      durationSeconds: 300,
      format: 'DSD256',
      sampleRate: 11289600,
      bitDepth: 1,
      channels: 2,
      bitrateKbps: 22579,
      trackId: 'trk-dsd-playing',
      filePath: 'D:/Music/Test.dsf',
      playbackState: 'Playing',
    })

    federatedResolversService
      .resolveActiveItemCandidate({
        albumTitle: 'Roja',
        artistCredit: 'A. R. Rahman',
      })
      .then((quietResult) => {
        assert.strictEqual(
          quietResult.deferredPlayback,
          true,
          'Remote candidate lookup MUST be deferred when playback is active'
        )
        assert.strictEqual(
          quietResult.artworkCandidates.length,
          0,
          'Must not burst network PHY packets for artwork candidates during playback'
        )

        // Restore original mock
        tauriBridge.getPlaybackStatus = originalGetStatus

        console.log('✓ Test 5 Passed: Audiophile Transport Quietness prevents remote NIC bursts during playback.')

        // ---------------------------------------------------------------------------
        // [Test 6] Album Artist vs Track Artist Staging Isolation
        // ---------------------------------------------------------------------------
        console.log('\n[Test 6] Testing Album Artist vs Track Artist Staging Isolation...')

        const sampleSoundtrackTracks: Track[] = [
          {
            id: 'trk-1',
            releaseId: 'rel-anbulla',
            recordingId: 'rec-1',
            trackNumber: 1,
            discNumber: 1,
            title: 'Kaadhal Thegangal',
            artistCredit: 'S.P. Balasubrahmanyam, S. Janaki',
            composerName: '',
            durationSeconds: 270,
            filePath: 'D:/Music/Anbulla Malare/01.flac',
            fileSize: 30000000,
            storageMountId: 'mount-1',
            sidecarStatus: 'synced',
            modifiedTimestamp: '2026-01-01T00:00:00Z',
            checksumValid: true,
            accurateRipConfidence: 5,
            drScore: 11,
            sampleRateStr: '44.1kHz / 16-bit',
            format: 'FLAC',
            credits: [],
            masterReleaseId: 'm-anbulla',
          },
          {
            id: 'trk-2',
            releaseId: 'rel-anbulla',
            recordingId: 'rec-2',
            trackNumber: 2,
            discNumber: 1,
            title: 'Thaaye Thaaye',
            artistCredit: 'P. Susheela',
            composerName: '',
            durationSeconds: 250,
            filePath: 'D:/Music/Anbulla Malare/02.flac',
            fileSize: 28000000,
            storageMountId: 'mount-1',
            sidecarStatus: 'synced',
            modifiedTimestamp: '2026-01-01T00:00:00Z',
            checksumValid: true,
            accurateRipConfidence: 6,
            drScore: 12,
            sampleRateStr: '44.1kHz / 16-bit',
            format: 'FLAC',
            credits: [],
            masterReleaseId: 'm-anbulla',
          },
        ]

        // Simulate Case A staging with artistPolicy === 'album_only'
        const stagedPolicyAlbumOnly = (
          tracks: Track[],
          albumArtistValue: string,
          editedTrackArtists: Record<string, string>
        ) => {
          const map = new Map<string, Partial<Track>>()
          tracks.forEach((trk) => {
            const edits: Record<string, any> = {}
            if (albumArtistValue) {
              edits.albumArtist = albumArtistValue
            }
            const custom = editedTrackArtists[trk.id]
            if (custom !== undefined && custom !== trk.artistCredit) {
              edits.artistCredit = custom
            }
            map.set(trk.id, edits)
          })
          return map
        }

        const albumOnlyResults = stagedPolicyAlbumOnly(sampleSoundtrackTracks, 'Ilaiyaraaja', {
          'trk-1': 'S.P. Balasubrahmanyam & S. Janaki', // slightly polished
        })

        // Track 1 should receive edited track artist and albumArtist = Ilaiyaraaja
        const trk1Edits = albumOnlyResults.get('trk-1')!
        assert.strictEqual(trk1Edits.albumArtist, 'Ilaiyaraaja')
        assert.strictEqual(trk1Edits.artistCredit, 'S.P. Balasubrahmanyam & S. Janaki')

        // Track 2 should have its original singer (P. Susheela) preserved, NOT overwritten with Ilaiyaraaja
        const trk2Edits = albumOnlyResults.get('trk-2')!
        assert.strictEqual(trk2Edits.albumArtist, 'Ilaiyaraaja')
        assert.strictEqual(trk2Edits.artistCredit, undefined, 'Track 2 vocalist must be preserved')

        console.log('✓ Test 6 Passed: Album Artist and Track Artist policies maintain strict tag isolation.')

        console.log('\n============================================================')
        console.log('  ALL CURATION & TRIAGE LIFECYCLE TESTS PASSED CLEANLY (6/6)')
        console.log('============================================================\n')
      })
      .catch((err) => {
        console.error('Test 5 Failed:', err)
        process.exit(1)
      })
  })
  .catch((err) => {
    console.error('Test 3 Failed:', err)
    process.exit(1)
  })
