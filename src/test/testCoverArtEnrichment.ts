import { federatedResolversService, CoverArtCandidate } from '../services/federatedResolvers'
import { cleanRipNoise } from '../core/taxonomyUtils'

async function runCoverArtEnrichmentTests() {
  console.log('=== [TDD] Testing Cover Art Enrichment Assistance (AI, MB, Apple) ===\n')

  // Test 1: Clean term helper verification for soundtrack search
  console.log('[Test 1] Verifying search query hygiene...')
  const rawFolder = 'Fiza CD RIP [FLAC]'
  const cleanedTitle = cleanRipNoise(rawFolder)
  if (cleanedTitle !== 'Fiza') {
    throw new Error(`Expected "Fiza", got "${cleanedTitle}"`)
  }
  console.log('  ✓ Query cleaned correctly:', cleanedTitle)

  // Test 2: Apple Music Album Artwork Candidate Resolution
  console.log('\n[Test 2] Testing Apple Music high-resolution 3000x3000px artwork resolution...')
  const appleCandidate = await federatedResolversService.fetchAlbumArtworkCandidate({
    albumTitle: 'Fiza',
    composerName: 'A. R. Rahman',
    artistCredit: 'Udit Narayan & Alka Yagnik',
    provider: 'apple',
  })

  console.log('  Apple Candidate result:', appleCandidate)
  if (!appleCandidate) {
    throw new Error('Expected Apple Music candidate for "Fiza", received null')
  }
  if (!appleCandidate.coverArtUrl.includes('mzstatic.com') || !appleCandidate.coverArtUrl.includes('3000x3000bb.jpg')) {
    throw new Error(`Expected 3000x3000bb.jpg Apple Music master artwork URL, got "${appleCandidate.coverArtUrl}"`)
  }
  if (appleCandidate.provider !== 'apple') {
    throw new Error(`Expected provider 'apple', got '${appleCandidate.provider}'`)
  }
  console.log('  ✓ Apple Music 3000x3000px master candidate verified!')

  // Test 3: MusicBrainz Cover Art Archive Candidate Resolution
  console.log('\n[Test 3] Testing MusicBrainz CAA archival front cover resolution...')
  const mbCandidate = await federatedResolversService.fetchAlbumArtworkCandidate({
    albumTitle: 'Fiza',
    composerName: 'A. R. Rahman',
    artistCredit: 'Udit Narayan & Alka Yagnik',
    provider: 'musicbrainz',
  })

  console.log('  MusicBrainz Candidate result:', mbCandidate)
  if (!mbCandidate) {
    throw new Error('Expected MusicBrainz candidate for "Fiza", received null')
  }
  if (!mbCandidate.coverArtUrl.includes('coverartarchive.org')) {
    throw new Error(`Expected coverartarchive.org URL, got "${mbCandidate.coverArtUrl}"`)
  }
  if (mbCandidate.provider !== 'musicbrainz') {
    throw new Error(`Expected provider 'musicbrainz', got '${mbCandidate.provider}'`)
  }
  console.log('  ✓ MusicBrainz CAA candidate verified!')

  // Test 4: Gemini AI Canonical Cover Art Resolution
  console.log('\n[Test 4] Testing Gemini AI canonical artwork resolution & recommendations...')
  const aiCandidate = await federatedResolversService.fetchAlbumArtworkCandidate({
    albumTitle: 'Fiza',
    composerName: 'A. R. Rahman',
    artistCredit: 'Udit Narayan & Alka Yagnik',
    releaseYear: 2000,
    provider: 'ai',
  })

  console.log('  Gemini AI Candidate result:', aiCandidate)
  if (!aiCandidate) {
    throw new Error('Expected Gemini AI candidate for "Fiza", received null')
  }
  if (!aiCandidate.coverArtUrl) {
    throw new Error('Expected non-empty coverArtUrl for Gemini AI candidate')
  }
  if (aiCandidate.provider !== 'ai') {
    throw new Error(`Expected provider 'ai', got '${aiCandidate.provider}'`)
  }
  console.log('  ✓ Gemini AI candidate verified!')

  // Test 5: Federated Concurrent Multi-Provider Artwork Resolution
  console.log('\n[Test 5] Testing fetchAllAlbumCoverArtCandidates (Concurrent Apple, MB, AI)...')
  const allCandidates = await federatedResolversService.fetchAllAlbumCoverArtCandidates({
    albumTitle: 'Fiza',
    composerName: 'A. R. Rahman',
    artistCredit: 'Udit Narayan & Alka Yagnik',
    releaseYear: 2000,
  })

  console.log(`  Fetched ${allCandidates.length} total candidate(s):`)
  allCandidates.forEach((c) => {
    console.log(`    * [${c.providerLabel}] ${c.albumTitle} (${c.coverResolution}) -> ${c.coverArtUrl.slice(0, 60)}...`)
  })

  const hasApple = allCandidates.some((c) => c.provider === 'apple')
  const hasMB = allCandidates.some((c) => c.provider === 'musicbrainz')
  const hasAi = allCandidates.some((c) => c.provider === 'ai')

  if (!hasApple || !hasMB || !hasAi) {
    throw new Error(`Expected candidates from apple, musicbrainz, and ai. Found: apple=${hasApple}, mb=${hasMB}, ai=${hasAi}`)
  }

  console.log('  ✓ Multi-provider concurrent resolution successfully fetched all 3 providers!')
  console.log('\n=============================================')
  console.log('🎉 ALL COVER ART ENRICHMENT TDD TESTS PASSED!')
  console.log('=============================================')
}

runCoverArtEnrichmentTests().catch((err) => {
  console.error('❌ TDD Test Failed:', err)
  process.exit(1)
})
