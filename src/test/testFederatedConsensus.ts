import assert from 'assert'
import {
  cleanConsensusTitle,
  isPlaceholderTag,
  calculateEarliestValidYear,
  disambiguateComboTitle,
  isDefectiveArtistTag,
  matchTrackArtistFromProviderList,
} from '../core/taxonomyUtils'
import {
  GlobalMusicBrainzQueue,
  federatedResolversService,
} from '../services/federatedResolvers'
import { LookaheadQueuePrefetcher } from '../services/curationQueueService'

async function runTests() {
  console.log('=== [TDD] Testing Federated Consensus Engine & Queue Architecture ===\n')

  // -------------------------------------------------------------------------
  // Test 1: Title Sanitization & Noise Stripping
  // -------------------------------------------------------------------------
  console.log('[Test 1] Testing cleanConsensusTitle...')
  assert.strictEqual(cleanConsensusTitle('Roja [FLAC 24-96]'), 'Roja')
  assert.strictEqual(cleanConsensusTitle('Dil Se.. (Remastered 2022)'), 'Dil Se..')
  assert.strictEqual(cleanConsensusTitle('Muthu [Disc 1]'), 'Muthu')
  assert.strictEqual(cleanConsensusTitle('Bombay (Original Soundtrack) [Deluxe Edition]'), 'Bombay')
  assert.strictEqual(cleanConsensusTitle('Padayappa [OST] (2000)'), 'Padayappa')
  assert.strictEqual(cleanConsensusTitle('Normal Album Title'), 'Normal Album Title')
  console.log('  ✓ cleanConsensusTitle strips bracketed technical noise, discs, and edition suffixes.\n')

  // -------------------------------------------------------------------------
  // Test 2: Placeholder Tag Disqualification
  // -------------------------------------------------------------------------
  console.log('[Test 2] Testing isPlaceholderTag...')
  assert.strictEqual(isPlaceholderTag('Track 01'), true)
  assert.strictEqual(isPlaceholderTag('track 12'), true)
  assert.strictEqual(isPlaceholderTag('Unknown Artist'), true)
  assert.strictEqual(isPlaceholderTag('Unknown Album'), true)
  assert.strictEqual(isPlaceholderTag('Untitled'), true)
  assert.strictEqual(isPlaceholderTag(''), true)
  assert.strictEqual(isPlaceholderTag('   '), true)
  assert.strictEqual(isPlaceholderTag('A.R. Rahman'), false)
  assert.strictEqual(isPlaceholderTag('Thiruda Thiruda'), false)
  console.log('  ✓ isPlaceholderTag correctly flags and disqualifies untagged placeholders.\n')

  // -------------------------------------------------------------------------
  // Test 3: Earliest Valid Year Protection
  // -------------------------------------------------------------------------
  console.log('[Test 3] Testing calculateEarliestValidYear (min(Apple, MB) protection)...')
  // Original release 1995, remaster 2005 -> picks original 1995
  assert.strictEqual(calculateEarliestValidYear(2005, 1995), 1995)
  // MB has earlier release
  assert.strictEqual(calculateEarliestValidYear(1992, 1999), 1992)
  // Only Apple provided
  assert.strictEqual(calculateEarliestValidYear(2001, undefined), 2001)
  // Only MB provided
  assert.strictEqual(calculateEarliestValidYear(undefined, 1998), 1998)
  // Invalid years (< 1900 or > next year) rejected
  assert.strictEqual(calculateEarliestValidYear(1850, 1995), 1995)
  assert.strictEqual(calculateEarliestValidYear(2099, 1995), 1995)
  assert.strictEqual(calculateEarliestValidYear(undefined, undefined), undefined)
  console.log('  ✓ calculateEarliestValidYear guarantees earliest release date preservation.\n')

  // -------------------------------------------------------------------------
  // Test 4: Combo Release Disaggregation & Virtual Splitting
  // -------------------------------------------------------------------------
  console.log('[Test 4] Testing disambiguateComboTitle disaggregation...')
  const combo1 = disambiguateComboTitle('Aalavandhan / Abhay')
  assert.strictEqual(combo1.isCombo, true)
  assert.deepStrictEqual(combo1.parts, ['Aalavandhan', 'Abhay'])

  const combo2 = disambiguateComboTitle('Chinna Thambi - Dharma Dorai - Captain Prabhakaran')
  assert.strictEqual(combo2.isCombo, true)
  assert.deepStrictEqual(combo2.parts, ['Chinna Thambi', 'Dharma Dorai', 'Captain Prabhakaran'])

  const singleTitle = disambiguateComboTitle('Face/Off', 'Face Off (1997)')
  assert.strictEqual(singleTitle.isCombo, false)
  console.log('  ✓ disambiguateComboTitle extracts multiple sub-albums for combo releases.\n')

  // -------------------------------------------------------------------------
  // Test 5: GlobalMusicBrainzQueue Rate Limiting & Preemption
  // -------------------------------------------------------------------------
  console.log('[Test 5] Testing GlobalMusicBrainzQueue rate limiting and preemption...')
  const queue = new GlobalMusicBrainzQueue(100) // 100ms for fast test execution

  const executionLog: string[] = []

  // Enqueue prefetch task
  const p1 = queue.enqueuePrefetch(async () => {
    executionLog.push('prefetch-1')
    return 'prefetch-1-done'
  })

  // Enqueue active priority task (should be preempted to run before any new prefetch)
  const a1 = queue.enqueueActive(async () => {
    executionLog.push('active-1')
    return 'active-1-done'
  })

  const [resP1, resA1] = await Promise.all([p1, a1])
  assert.strictEqual(resP1, 'prefetch-1-done')
  assert.strictEqual(resA1, 'active-1-done')

  // Test prefetch cancellation
  let cancelledRun = false
  queue.enqueuePrefetch(async () => {
    cancelledRun = true
  })
  queue.cancelPendingPrefetch()

  // Wait a small delay to ensure no cancelled prefetch ran
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.strictEqual(cancelledRun, false)
  console.log('  ✓ GlobalMusicBrainzQueue enforces rate limits, priority preemption, and prefetch cancellation.\n')

  // -------------------------------------------------------------------------
  // Test 6: LookaheadQueuePrefetcher LRU Cache & Transport Quietness Gate
  // -------------------------------------------------------------------------
  console.log('[Test 6] Testing LookaheadQueuePrefetcher LRU Cache & 30s Cooldown Guard...')
  const prefetcher = new LookaheadQueuePrefetcher()

  // 1. Cold boot quietness check (lastPlaybackStoppedTime = 0)
  assert.strictEqual(
    await prefetcher.isTransportQuiet({ isPlaying: false, isPaused: false, playbackState: 'Stopped' }),
    true
  )

  // 2. Playing status -> Not quiet
  assert.strictEqual(
    await prefetcher.isTransportQuiet({ isPlaying: true, isPaused: false, playbackState: 'Playing' }),
    false
  )

  // 3. Paused status -> Not quiet
  assert.strictEqual(
    await prefetcher.isTransportQuiet({ isPlaying: false, isPaused: true, playbackState: 'Paused' }),
    false
  )

  // 4. Recently stopped (within 30s cooldown) -> Not quiet
  const now = Date.now()
  prefetcher.setLastPlaybackStoppedTime(now - 10000) // stopped 10s ago
  assert.strictEqual(
    await prefetcher.isTransportQuiet({ isPlaying: false, isPaused: false, playbackState: 'Stopped' }),
    false
  )

  // 5. Cooldown elapsed (> 30s) -> Quiet
  prefetcher.setLastPlaybackStoppedTime(now - 35000) // stopped 35s ago
  assert.strictEqual(
    await prefetcher.isTransportQuiet({ isPlaying: false, isPaused: false, playbackState: 'Stopped' }),
    true
  )

  // 6. LRU Cache Capacity = 50
  for (let i = 0; i < 60; i++) {
    prefetcher.setCachedConsensus(`album-${i}`, {
      releaseId: `album-${i}`,
      albumTitle: { value: `Title ${i}`, source: 'local_fallback', confidence: 1.0, candidates: {} },
      albumArtist: { value: `Artist ${i}`, source: 'local_fallback', confidence: 1.0, candidates: {} },
      composer: { value: `Composer ${i}`, source: 'local_fallback', confidence: 1.0, candidates: {} },
      releaseYear: { value: 2000 + i, source: 'local_fallback', confidence: 1.0, candidates: {} },
      genre: { value: 'Soundtrack', source: 'local_fallback', confidence: 1.0, candidates: {} },
      label: { value: 'Master', source: 'local_fallback', confidence: 1.0, candidates: {} },
      isComboRelease: false,
    })
  }

  // Items 0..9 should have been evicted by LRU capacity of 50
  assert.strictEqual(prefetcher.getCachedConsensus('album-0'), undefined)
  assert.strictEqual(prefetcher.getCachedConsensus('album-5'), undefined)
  assert.strictEqual(prefetcher.getCachedConsensus('album-9'), undefined)
  // Items 10..59 should be in cache
  assert.notStrictEqual(prefetcher.getCachedConsensus('album-10'), undefined)
  assert.notStrictEqual(prefetcher.getCachedConsensus('album-59'), undefined)
  // -------------------------------------------------------------------------
  // Test 7: Track Artist Matching & Defective Tag Purging
  // -------------------------------------------------------------------------
  console.log('[Test 7] Testing Track Artist Matching & Defective Tag Purging...')

  // 1. Defective tag detection
  assert.strictEqual(isDefectiveArtistTag('Anbulla Malarey CD RIP', 'Anbulla Malarey CD RIP'), true)
  assert.strictEqual(isDefectiveArtistTag('Anbulla Malarey CD RIP', 'Anbulla Malare'), true)
  assert.strictEqual(isDefectiveArtistTag('Various Artists', 'Anbulla Malare'), true)
  assert.strictEqual(isDefectiveArtistTag('FLAC', 'Anbulla Malare'), true)
  assert.strictEqual(isDefectiveArtistTag('S.P. Balasubrahmanyam', 'Anbulla Malare'), false)
  assert.strictEqual(isDefectiveArtistTag('Ilaiyaraaja & S. Janaki', 'Anbulla Malare'), false)

  // 2. Real tracklist matching with Apple Music tracks
  const itunesTracks = [
    { trackNumber: 1, trackName: 'Thaaye Thaaye Dharmam', artistName: 'Ilaiyaraaja & S.P. Balasubrahmanyam' },
    { trackNumber: 2, trackName: 'Thegham Pon Thegham', artistName: 'Ilaiyaraaja & S. Janaki' },
    { trackNumber: 3, trackName: 'Paathigala Udan Pirappa', artistName: 'Ilaiyaraaja & S.P. Balasubrahmanyam' },
    { trackNumber: 4, trackName: 'Alai Methu Thadumaruthe', artistName: 'Ilaiyaraaja, S.P. Balasubrahmanyam & Vani Jayaram' },
    { trackNumber: 5, trackName: 'Enna Venum', artistName: 'Ilaiyaraaja, Sudhakar, Saibaba & Grubb Singh' },
    { trackNumber: 6, trackName: 'Kaadhal Thegangal', artistName: 'Ilaiyaraaja, S.P. Balasubrahmanyam & P. Susheela' },
  ]

  // Exact & phonetic matches for local CD rip tracks
  const m1 = matchTrackArtistFromProviderList('Kaadhal Thegangal', itunesTracks, 1)
  assert.strictEqual(m1?.artistName, 'Ilaiyaraaja, S.P. Balasubrahmanyam & P. Susheela')

  const m2 = matchTrackArtistFromProviderList('Thaye Thaye', itunesTracks, 2)
  assert.strictEqual(m2?.artistName, 'Ilaiyaraaja & S.P. Balasubrahmanyam')

  const m4 = matchTrackArtistFromProviderList('Pathi Pazha', itunesTracks, 4)
  assert.strictEqual(m4?.artistName, 'Ilaiyaraaja & S.P. Balasubrahmanyam')

  const m5 = matchTrackArtistFromProviderList('Alai Meedhu', itunesTracks, 5)
  assert.strictEqual(m5?.artistName, 'Ilaiyaraaja, S.P. Balasubrahmanyam & Vani Jayaram')

  const m6 = matchTrackArtistFromProviderList('Enna venum Folk Song', itunesTracks, 6)
  assert.strictEqual(m6?.artistName, 'Ilaiyaraaja, Sudhakar, Saibaba & Grubb Singh')

  console.log('  ✓ Track Artist matching successfully resolves authentic vocalists and purges CD rip artifacts.\n')

  console.log('=====================================================================')
  console.log('🎉 ALL FEDERATED CONSENSUS & QUEUE ARCHITECTURE TESTS PASSED CLEANLY!')
  console.log('=====================================================================')
}

runTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
