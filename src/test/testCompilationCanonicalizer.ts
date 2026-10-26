/**
 * src/test/testCompilationCanonicalizer.ts
 * Comprehensive test suite for Phase 3: Cadence Semantic AI Engine (Compilation Canonicalization).
 * Validates:
 * 1. Audiophile Transport Purity lock during active/paused playback.
 * 2. Cross-referencing AI resolved soundtracks against local library releases.
 * 3. Batch application to SQLite and in-memory track models.
 * 4. Copilot agent tool definition and dispatch routing.
 */

import { compilationCanonicalizerService, ProposedTrackCanonicalization } from '../services/compilationCanonicalizerService'
import { AGENT_TOOL_DEFINITIONS } from '../services/agentToolRegistry'
import { agentActionDispatcher } from '../services/agentActionDispatcher'
import { Track, Release } from '../core/types'
import { tauriBridge } from '../services/tauriBridge'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function runTests() {
  console.log('=== RUNNING COMPILATION CANONICALIZER TEST SUITE ===\n')

  // 1. Verify Copilot Tool Registration
  console.log('[1] Verifying Copilot Tool Registry...')
  const toolDef = AGENT_TOOL_DEFINITIONS.find((t) => t.name === 'canonicalize_compilation_soundtracks')
  assert(Boolean(toolDef), 'Tool "canonicalize_compilation_soundtracks" must be registered in AGENT_TOOL_DEFINITIONS')
  assert(Boolean(toolDef?.parameters.properties.releaseId), 'Tool must define "releaseId" property')
  assert(Boolean(toolDef?.parameters.properties.albumTitle), 'Tool must define "albumTitle" property')
  console.log('✓ Copilot tool registration verified.\n')

  // 2. Verify Audiophile Transport Purity Lock during active playback
  console.log('[2] Verifying Audiophile Playback Guard...')
  // Mock active playback status on tauriBridge
  const originalGetPlaybackStatus = tauriBridge.getPlaybackStatus
  tauriBridge.getPlaybackStatus = async () => ({
    isPlaying: true,
    isPaused: false,
    volume: 1.0,
    isMuted: false,
    currentFile: 'test.flac',
    playbackState: 'Playing',
  })

  const dummyRelease: Release = {
    id: 'rel-comp-1',
    title: 'World of Rahmania',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2006,
    genreTags: ['Compilation'],
    trackCount: 2,
    variants: [],
    artwork: { resolution: '1000x1000' },
  }

  const dummyTracks: Track[] = [
    {
      id: 'trk-1',
      releaseId: 'rel-comp-1',
      recordingId: 'rec-1',
      trackNumber: 1,
      discNumber: 1,
      title: 'Khalbali',
      artistCredit: 'A. R. Rahman, Mohammed Aslam',
      composerName: 'A. R. Rahman',
      durationSeconds: 379,
      filePath: '/music/Khalbali.flac',
      fileSize: 30000000,
      storageMountId: 'mount-1',
      sidecarStatus: 'synced',
      modifiedTimestamp: new Date().toISOString(),
      checksumValid: true,
      accurateRipConfidence: 100,
      drScore: 12,
      sampleRateStr: '24/96',
      format: 'FLAC',
      credits: [],
      masterReleaseId: 'rel-comp-1',
    },
    {
      id: 'trk-2',
      releaseId: 'rel-comp-1',
      recordingId: 'rec-2',
      trackNumber: 2,
      discNumber: 1,
      title: 'Chinna Chinna Aasai',
      artistCredit: 'Minmini',
      composerName: 'A. R. Rahman',
      durationSeconds: 295,
      filePath: '/music/Chinna Chinna Aasai.flac',
      fileSize: 25000000,
      storageMountId: 'mount-1',
      sidecarStatus: 'synced',
      modifiedTimestamp: new Date().toISOString(),
      checksumValid: true,
      accurateRipConfidence: 100,
      drScore: 14,
      sampleRateStr: '16/44.1',
      format: 'FLAC',
      credits: [],
      masterReleaseId: 'rel-comp-1',
    },
  ]

  const guardResult = await compilationCanonicalizerService.resolveCompilationSoundtracks(
    dummyRelease,
    dummyTracks
  )

  assert(guardResult.deferredPlayback === true, 'Resolution must be deferred when playback is active')
  assert(guardResult.success === false, 'Result must be marked success: false during playback')
  console.log('✓ Audiophile Transport Purity lock correctly deferred resolution during playback.\n')

  // Restore playback status to idle
  tauriBridge.getPlaybackStatus = async () => ({
    isPlaying: false,
    isPaused: false,
    volume: 1.0,
    isMuted: false,
    playbackState: 'Stopped',
  })

  // 3. Verify Batch Application to SQLite & In-Memory Models
  console.log('[3] Verifying Batch Application to Database and In-Memory Models...')
  const proposedItems: ProposedTrackCanonicalization[] = [
    {
      trackId: 'trk-1',
      trackNumber: 1,
      title: 'Khalbali',
      proposedOriginalAlbum: 'Rang De Basanti',
      proposedOriginalYear: 2006,
      composer: 'A. R. Rahman',
      primaryVocalists: 'A. R. Rahman, Mohammed Aslam, Nacim',
      isCompilationTrack: true,
      confidence: 0.99,
      notes: 'From original motion picture soundtrack Rang De Basanti (2006)',
      matchedInLibrary: true,
      matchedReleaseId: 'rel-rdb-local',
      matchedReleaseTitle: 'Rang De Basanti',
      selected: true,
    },
    {
      trackId: 'trk-2',
      trackNumber: 2,
      title: 'Chinna Chinna Aasai',
      proposedOriginalAlbum: 'Roja',
      proposedOriginalYear: 1992,
      composer: 'A. R. Rahman',
      primaryVocalists: 'Minmini',
      isCompilationTrack: true,
      confidence: 0.99,
      notes: 'From original motion picture soundtrack Roja (1992)',
      matchedInLibrary: false,
      selected: true,
    },
  ]

  const localReleases: Release[] = [
    {
      id: 'rel-rdb-local',
      title: 'Rang De Basanti',
      artistCredit: 'A. R. Rahman',
      releaseYear: 2006,
      trackCount: 10,
      variants: [],
      artwork: { resolution: '1000x1000' },
    },
  ]

  let dbUpdateCallCount = 0
  const originalDbUpdate = tauriBridge.dbUpdateTrackProvenance
  tauriBridge.dbUpdateTrackProvenance = async (trackId, _mbid, origAlbum, origYear) => {
    dbUpdateCallCount++
    if (trackId === 'trk-1') {
      assert(origAlbum === 'Rang De Basanti', 'Track 1 originalAlbum must be Rang De Basanti')
      assert(origYear === 2006, 'Track 1 originalYear must be 2006')
    } else if (trackId === 'trk-2') {
      assert(origAlbum === 'Roja', 'Track 2 originalAlbum must be Roja')
      assert(origYear === 1992, 'Track 2 originalYear must be 1992')
    }
  }

  const { updatedCount } = await compilationCanonicalizerService.applyBatchCanonicalization(
    proposedItems,
    dummyTracks,
    localReleases
  )

  assert(updatedCount === 2, `Expected 2 tracks updated, got ${updatedCount}`)
  assert(dbUpdateCallCount === 2, `Expected 2 database updates, got ${dbUpdateCallCount}`)

  // Verify in-memory track mutations
  const t1 = dummyTracks[0]
  assert(t1.originalAlbum === 'Rang De Basanti', 'Track 1 in-memory originalAlbum updated')
  assert(t1.originalYear === 2006, 'Track 1 in-memory originalYear updated')
  assert(t1.canonicalAlbumTitle === 'Rang De Basanti', 'Track 1 canonicalAlbumTitle updated')
  assert(t1.canonicalReleaseId === 'rel-rdb-local', 'Track 1 canonicalReleaseId linked to local release')
  assert(t1.isCanonicalAlbumTrack === false, 'Track 1 marked as provenance track')

  const t2 = dummyTracks[1]
  assert(t2.originalAlbum === 'Roja', 'Track 2 in-memory originalAlbum updated')
  assert(t2.originalYear === 1992, 'Track 2 in-memory originalYear updated')
  assert(t2.canonicalAlbumTitle === 'Roja', 'Track 2 canonicalAlbumTitle updated')
  assert(!t2.canonicalReleaseId, 'Track 2 canonicalReleaseId undefined for external master')

  console.log('✓ Batch application to SQLite and in-memory models verified successfully.\n')

  // 4. Verify Dispatcher Routing for Copilot Tool
  console.log('[4] Verifying Dispatcher Execution for canonicalize_compilation_soundtracks...')
  const mockContext = {
    refreshFromEngine: () => {},
    showToast: () => {},
    setViewMode: () => {},
    selectTrack: () => {},
    openModal: () => {},
    currentRelease: dummyRelease,
    currentTrack: dummyTracks[0],
    gridScopedTracks: dummyTracks,
    allTracks: dummyTracks,
    allReleases: [dummyRelease, ...localReleases],
  }

  let eventFired = false
  if (typeof window !== 'undefined') {
    window.addEventListener('cadence:open-compilation-provenance', ((e: CustomEvent) => {
      eventFired = true
      assert(e.detail?.releaseId === dummyRelease.id, 'Dispatched event must target dummyRelease.id')
    }) as EventListener)
  }

  const dispatchResult = await agentActionDispatcher.executeAction(
    {
      tool: 'canonicalize_compilation_soundtracks',
      args: { releaseId: dummyRelease.id },
    },
    mockContext as any
  )

  assert(dispatchResult.success === true, 'Dispatcher execution must succeed')
  assert(
    dispatchResult.message.includes('Opened Canonical Soundtrack Resolver'),
    `Expected success message, got: ${dispatchResult.message}`
  )
  console.log('✓ Dispatcher tool execution verified.\n')

  // Clean up
  tauriBridge.getPlaybackStatus = originalGetPlaybackStatus
  tauriBridge.dbUpdateTrackProvenance = originalDbUpdate

  console.log('====================================================')
  console.log('🎉 ALL COMPILATION CANONICALIZER TESTS PASSED 100%!')
  console.log('====================================================')
}

runTests().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
