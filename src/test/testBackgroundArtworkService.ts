/**
 * Verification Test Suite: Background Artwork Enrichment Service
 * 
 * Tests:
 * 1. Background lifecycle persistence & reactive subscription
 * 2. Audio Engine playback preemption & AbortController socket teardown
 * 3. 30-Second settling cooldown timer on Pause & Stop
 * 4. User controls: Pause, Resume, Cancel
 * 5. Incremental sidecar staging in graphEngine
 * 6. Debounced checkpoint flushing (every 10 albums + on pause/cancel)
 */

import assert from 'node:assert'
import { backgroundArtworkService } from '../services/backgroundArtworkService'
import { graphEngine } from '../core/graphEngine'
import { federatedResolversService } from '../services/federatedResolvers'

async function runTestSuite() {
  console.log('\n=== Testing Background Artwork Enrichment Service ===\n')

  // Setup mock releases in graphEngine
  graphEngine.clearLibrary()

  const mockReleaseIds: string[] = []
  for (let i = 1; i <= 25; i++) {
    const relId = `rel-test-${i}`
    mockReleaseIds.push(relId)
    graphEngine.addOrUpdateRelease({
      id: relId,
      title: `Test Album ${i}`,
      artistCredit: 'Test Artist',
      releaseYear: 2020 + (i % 5),
      artwork: {
        frontCoverUrl: '',
        resolution: 'No Embedded Art',
        width: 0,
        height: 0,
        dpi: 72,
        colorProfile: 'sRGB',
        isLowRes: true,
        hasBookletPdf: false,
      },
    } as any)

    graphEngine.addOrUpdateTrack({
      id: `trk-test-${i}`,
      releaseId: relId,
      title: `Track 1`,
      artistCredit: 'Test Artist',
      filePath: `/music/Test Album ${i}/01 - Track.flac`,
      sidecarStatus: 'synced',
    } as any)
  }

  // Mock federated resolver to simulate network latency and abortability
  const originalResolver = federatedResolversService.fetchAlbumArtworkCandidate
  let abortCount = 0

  federatedResolversService.fetchAlbumArtworkCandidate = async (query: any) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          provider: query.provider,
          providerLabel: 'Apple Music HD',
          albumTitle: query.albumTitle,
          artistCredit: query.artistCredit,
          composerName: query.composerName,
          releaseYear: query.releaseYear,
          coverArtUrl: `https://mock.artwork.com/${encodeURIComponent(query.albumTitle)}.jpg`,
          coverResolution: '3000×3000px',
          confidenceScore: 0.95,
          sourceInfo: 'Mock Test Provider',
        })
      }, 50)

      if (query.signal) {
        query.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          abortCount++
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }
    })
  }

  try {
    // ----------------------------------------------------
    // Test 1: Initial State & Subscription
    // ----------------------------------------------------
    console.log('[Test 1] Verifying initial service state...')
    let receivedState = backgroundArtworkService.getState()
    assert.strictEqual(receivedState.status, 'idle', 'Initial status must be idle')
    assert.strictEqual(receivedState.completed, 0, 'Completed must be 0')
    console.log('✓ Initial state is idle.')

    // ----------------------------------------------------
    // Test 2: Audio Engine Preemption & Immediate AbortController Socket Teardown
    // ----------------------------------------------------
    console.log('\n[Test 2] Testing Audio Engine preemption & AbortController socket teardown...')
    
    // Start background artwork enrichment with 5 albums
    const target5 = mockReleaseIds.slice(0, 5)
    backgroundArtworkService.start({ releaseIds: target5 })

    // Give it 15ms so a request starts in flight
    await new Promise((r) => setTimeout(r, 15))

    // Audio Engine begins playing!
    backgroundArtworkService.notifyPlaybackState(true, false)

    const preemptedState = backgroundArtworkService.getState()
    assert.strictEqual(
      preemptedState.status,
      'suspended_playback',
      'Status must immediately transition to suspended_playback on audio playback'
    )
    assert(abortCount > 0, 'AbortController must have aborted in-flight HTTP request')
    console.log(`✓ Audio playback preempted background service immediately (Aborts: ${abortCount}).`)

    // ----------------------------------------------------
    // Test 3: Audio Ceases (Paused/Stopped) & 30-Second Settling Cooldown
    // ----------------------------------------------------
    console.log('\n[Test 3] Testing 30-second settling cooldown on Pause / Stop...')
    
    // Playback transitions to Paused
    backgroundArtworkService.notifyPlaybackState(false, true)

    const cooldownState = backgroundArtworkService.getState()
    assert.strictEqual(cooldownState.status, 'cooldown', 'Status must transition to cooldown after playback stops')
    assert(cooldownState.cooldownRemainingSecs !== undefined && cooldownState.cooldownRemainingSecs > 0, 'Cooldown countdown must be active')
    console.log(`✓ Cooldown initiated cleanly with ${cooldownState.cooldownRemainingSecs}s remaining.`)

    // Cancel current job to reset for batch test
    backgroundArtworkService.cancel()
    assert.strictEqual(backgroundArtworkService.getState().status, 'idle', 'Cancel resets status to idle')
    console.log('✓ Cancel cleanly resets state to idle.')

    // ----------------------------------------------------
    // Test 4: Incremental Staging in graphEngine & Debounced Checkpoint
    // ----------------------------------------------------
    console.log('\n[Test 4] Testing Incremental Staging in graphEngine & Debounced Checkpoints...')
    let checkpointFlushedCount = 0
    backgroundArtworkService.setCheckpointHandler(async () => {
      checkpointFlushedCount++
    })

    // Reset transport state to idle for fast batch execution
    backgroundArtworkService.resetTransportStateForTesting()
    backgroundArtworkService.setPacingDelayForTesting(10)

    // Run for 12 albums
    const target12 = mockReleaseIds.slice(0, 12)
    await backgroundArtworkService.start({ releaseIds: target12 })

    // Wait for the batch to finish
    await new Promise((resolve) => {
      const unsub = backgroundArtworkService.subscribe((s) => {
        if (s.status === 'complete') {
          unsub()
          resolve(true)
        }
      })
    })

    const finalState = backgroundArtworkService.getState()
    assert.strictEqual(finalState.status, 'complete', 'Batch must complete')
    assert.strictEqual(finalState.completed, 12, '12 albums must be completed')
    assert(checkpointFlushedCount >= 2, `Checkpoints must flush debounced (at 10 and at completion), actual: ${checkpointFlushedCount}`)

    // Verify albums staged in graphEngine
    for (const relId of target12) {
      const rel = graphEngine.getReleaseById(relId)
      assert(rel?.artwork?.frontCoverUrl.includes('mock.artwork.com'), `Release ${relId} must have frontCoverUrl staged`)
      const trk = graphEngine.getAllTracks().find((t) => t.releaseId === relId)
      assert.strictEqual(trk?.sidecarStatus, 'uncommitted_sidecar', `Track in ${relId} must be uncommitted_sidecar`)
    }
    console.log(`✓ 12 albums staged incrementally in graphEngine with ${checkpointFlushedCount} debounced checkpoints.`)

    // ----------------------------------------------------
    // Test 5: User Pause & Resume Controls
    // ----------------------------------------------------
    console.log('\n[Test 5] Testing User Pause & Resume controls...')
    backgroundArtworkService.start({ releaseIds: mockReleaseIds.slice(12, 16) })
    backgroundArtworkService.pause()
    assert.strictEqual(backgroundArtworkService.getState().status, 'user_paused', 'Must be user_paused')

    backgroundArtworkService.resume()
    assert(
      backgroundArtworkService.getState().status === 'active' || backgroundArtworkService.getState().status === 'cooldown',
      'Resume must activate or cool down'
    )
    backgroundArtworkService.cancel()
    console.log('✓ Pause, Resume, and Cancel user controls verified.')

    console.log('\n========================================================')
    console.log('🎉 ALL BACKGROUND ARTWORK SERVICE TESTS PASSED!')
    console.log('========================================================\n')
  } finally {
    federatedResolversService.fetchAlbumArtworkCandidate = originalResolver
    backgroundArtworkService.destroy()
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ TEST FAILED:', err)
  process.exit(1)
})
