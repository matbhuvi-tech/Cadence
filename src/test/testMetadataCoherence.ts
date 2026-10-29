/**
 * src/test/testMetadataCoherence.ts
 * Comprehensive verification test suite for Unified Metadata Management and Catalog Coherence.
 * Validates:
 * 1. Film Soundtrack Composer Authority Inference (Agni Natchathiram case)
 * 2. Classical / Carnatic / Performer Authority Inference (M. S. Subbulakshmi case)
 * 3. Manual Authority Override Precedence
 * 4. Noise Stripping & Bounded Fuzzy Agglomerative Edition Stacking (Captain Prabhakaran & Poovilangu cases)
 * 5. Dynamic Range (DR) Feature Flagging & Safe Nullability
 */

import { creditInferenceService } from '../services/creditInferenceService'
import { cleanRipNoise, jaroWinklerSimilarity, groupAlbumReleases } from '../services/albumGroupingService'
import { IntegrityScanner } from '../services/integrityScanner'
import { FEATURES } from '../config/features'
import { Release, Track } from '../core/types'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`[Assertion Failed] ${message}`)
  }
}

async function runTests() {
  console.log('=== RUNNING METADATA COHERENCE & CATALOG INFERENCE SUITE ===\n')

  // -------------------------------------------------------------
  // Test 1: Agni Natchathiram Soundtrack (Issue 1 & Issue 2)
  // -------------------------------------------------------------
  console.log('[Test 1] Verifying Composer Authority inference for film soundtracks...')
  const agniRelease: Release = {
    id: 'rel-agni-1',
    title: 'Agni Natchathiram (Original Motion Picture Soundtrack)',
    artistCredit: 'K. S. Chithra, Malaysia Vasudevan, S. Janaki',
    composerName: 'Ilaiyaraaja',
    releaseYear: 1988,
    genre: 'Soundtrack',
    genreTags: ['Tamil Soundtrack', 'Film Score'],
    trackCount: 3,
    variants: [],
    artwork: { resolution: '1000x1000' } as any,
  }

  const agniTracks: Track[] = [
    {
      id: 'trk-agni-1',
      releaseId: 'rel-agni-1',
      recordingId: 'rec-1',
      trackNumber: 1,
      discNumber: 1,
      title: 'Ninnukori Varanam',
      artistCredit: 'K. S. Chithra',
      composerName: 'Ilaiyaraaja',
      durationSeconds: 275,
      filePath: '/music/Agni/01.flac',
      fileSize: 30000000,
      storageMountId: 'mount-1',
      sidecarStatus: 'synced',
      modifiedTimestamp: new Date().toISOString(),
      checksumValid: true,
      accurateRipConfidence: 12,
      sampleRateStr: '24/96',
      format: 'FLAC',
      credits: [],
      masterReleaseId: 'rel-agni-1',
    },
    {
      id: 'trk-agni-2',
      releaseId: 'rel-agni-1',
      recordingId: 'rec-2',
      trackNumber: 2,
      discNumber: 1,
      title: 'Raja Rajadhi Rajan',
      artistCredit: 'Malaysia Vasudevan',
      composerName: 'Ilaiyaraaja',
      durationSeconds: 280,
      filePath: '/music/Agni/02.flac',
      fileSize: 31000000,
      storageMountId: 'mount-1',
      sidecarStatus: 'synced',
      modifiedTimestamp: new Date().toISOString(),
      checksumValid: true,
      accurateRipConfidence: 10,
      sampleRateStr: '24/96',
      format: 'FLAC',
      credits: [],
      masterReleaseId: 'rel-agni-1',
    },
    {
      id: 'trk-agni-3',
      releaseId: 'rel-agni-1',
      recordingId: 'rec-3',
      trackNumber: 3,
      discNumber: 1,
      title: 'Oru Poongaavanam',
      artistCredit: 'S. Janaki',
      composerName: 'Ilaiyaraaja',
      durationSeconds: 260,
      filePath: '/music/Agni/03.flac',
      fileSize: 29000000,
      storageMountId: 'mount-1',
      sidecarStatus: 'synced',
      modifiedTimestamp: new Date().toISOString(),
      checksumValid: true,
      accurateRipConfidence: 8,
      sampleRateStr: '24/96',
      format: 'FLAC',
      credits: [],
      masterReleaseId: 'rel-agni-1',
    },
  ]

  const inference = creditInferenceService.inferReleaseAuthority(agniRelease, agniTracks)
  console.log('Inference result:', inference)
  assert(inference.authority === 'composer', 'Agni Natchathiram must infer composer authority')
  assert(inference.score >= 70, `Score must be >= 70 for clear soundtrack (got ${inference.score})`)

  const displayArtist = creditInferenceService.resolveDisplayArtist(agniRelease, agniTracks)
  const detailedArtist = creditInferenceService.resolveDetailedDisplayArtist(agniRelease, agniTracks)
  console.log('Display artist result:', displayArtist)
  console.log('Detailed artist result:', detailedArtist)
  assert(displayArtist === 'Ilaiyaraaja', 'Display artist string must be Ilaiyaraaja')
  assert(detailedArtist.primary === 'Ilaiyaraaja', 'Primary artist must be Ilaiyaraaja')
  assert(detailedArtist.secondary?.includes('Chithra') === true, 'Secondary must contain vocalist credits')
  assert(detailedArtist.authority === 'composer', 'Authority must be composer')
  console.log('✓ Agni Natchathiram soundtrack inference passed.\n')

  // -------------------------------------------------------------
  // Test 2: Carnatic / Devotional Album (Performer Authority)
  // -------------------------------------------------------------
  console.log('[Test 2] Verifying Performer Authority for classical/devotional albums...')
  const mssRelease: Release = {
    id: 'rel-mss-1',
    title: 'Thyagaraja Krithis Live',
    artistCredit: 'M. S. Subbulakshmi',
    composerName: 'Thyagaraja',
    releaseYear: 1970,
    genre: 'Carnatic Classical',
    genreTags: ['Devotional', 'Carnatic Vocal'],
    trackCount: 2,
    variants: [],
    artwork: { resolution: '1000x1000' } as any,
  }

  const mssTracks: Track[] = [
    {
      id: 'trk-mss-1',
      releaseId: 'rel-mss-1',
      recordingId: 'rec-m1',
      trackNumber: 1,
      discNumber: 1,
      title: 'Endaro Mahanubhavulu',
      artistCredit: 'M. S. Subbulakshmi',
      composerName: 'Thyagaraja',
      durationSeconds: 520,
      filePath: '/music/MSS/01.flac',
      fileSize: 50000000,
      storageMountId: 'mount-1',
      sidecarStatus: 'synced',
      modifiedTimestamp: new Date().toISOString(),
      checksumValid: true,
      accurateRipConfidence: 5,
      sampleRateStr: '16/44.1',
      format: 'FLAC',
      credits: [],
      masterReleaseId: 'rel-mss-1',
    },
  ]

  const mssInference = creditInferenceService.inferReleaseAuthority(mssRelease, mssTracks)
  console.log('MSS Inference result:', mssInference)
  assert(mssInference.authority === 'performer', 'Carnatic vocal album must infer performer authority')
  assert(mssInference.score < 50, `Score must be < 50 for performer authority (got ${mssInference.score})`)

  const mssDisplay = creditInferenceService.resolveDisplayArtist(mssRelease, mssTracks)
  const mssDetailed = creditInferenceService.resolveDetailedDisplayArtist(mssRelease, mssTracks)
  assert(mssDisplay === 'M. S. Subbulakshmi', 'Display artist string must be performer M. S. Subbulakshmi')
  assert(mssDetailed.primary === 'M. S. Subbulakshmi', 'Primary artist must be performer M. S. Subbulakshmi')
  assert(mssDetailed.secondary === 'Thyagaraja', 'Secondary must display composer Thyagaraja')
  console.log('✓ Carnatic / Devotional performer authority passed.\n')

  // -------------------------------------------------------------
  // Test 3: Manual Override Precedence
  // -------------------------------------------------------------
  console.log('[Test 3] Verifying explicit user metadataAuthorityOverride...')
  const overriddenRelease: Release = {
    ...agniRelease,
    metadataAuthorityOverride: 'performer',
  }
  const overrideDisplay = creditInferenceService.resolveDisplayArtist(overriddenRelease, agniTracks)
  const overrideDetailed = creditInferenceService.resolveDetailedDisplayArtist(overriddenRelease, agniTracks)
  assert(overrideDetailed.authority === 'performer', 'Explicit override must force performer authority')
  assert(overrideDetailed.primary === 'K. S. Chithra, Malaysia Vasudevan, S. Janaki', 'Primary must be performers under override')
  assert(overrideDisplay === 'K. S. Chithra, Malaysia Vasudevan, S. Janaki', 'Display string must be performers under override')
  console.log('✓ Manual authority override passed.\n')

  // -------------------------------------------------------------
  // Test 4: Noise Stripping & Bounded Fuzzy Agglomerative Stacking
  // -------------------------------------------------------------
  console.log('[Test 4] Verifying cleanRipNoise and fuzzy edition clustering...')
  assert(cleanRipNoise('Poovilangu CD RIP') === 'Poovilangu', 'cleanRipNoise must strip CD RIP')
  assert(cleanRipNoise('Captain Prabhakaran [24-96 Hi-Res FLAC]') === 'Captain Prabhakaran', 'cleanRipNoise must strip Hi-Res tags')
  assert(cleanRipNoise('Agni Natchathiram (1988 Remastered WEB-DL)') === 'Agni Natchathiram', 'cleanRipNoise must strip Remastered WEB-DL')

  const jaroSim = jaroWinklerSimilarity('Captain Prabhakaran', 'Captian Prabhakaran')
  console.log('Jaro-Winkler similarity (Captain vs Captian):', jaroSim)
  assert(jaroSim >= 0.90, `Typo similarity should exceed 0.90 (got ${jaroSim})`)

  const releaseVariants: Release[] = [
    {
      id: 'rel-cp-1',
      title: 'Captain Prabhakaran CD RIP',
      artistCredit: 'Ilaiyaraaja',
      composerName: 'Ilaiyaraaja',
      releaseYear: 1991,
      trackCount: 6,
      variants: [],
      storageMountId: 'mount-1',
      genreTags: ['Soundtrack'],
      artwork: { resolution: '1000x1000' } as any,
    },
    {
      id: 'rel-cp-2',
      title: 'Captian Prabhakaran [FLAC 16-44]',
      artistCredit: 'Ilaiyaraaja',
      composerName: 'Ilaiyaraaja',
      releaseYear: 1991,
      trackCount: 6,
      variants: [],
      storageMountId: 'mount-1',
      genreTags: ['Soundtrack'],
      artwork: { resolution: '1000x1000' } as any,
    },
    {
      id: 'rel-nilavu',
      title: 'Nilavae Oru Sangeetham CD RIP',
      artistCredit: 'Ilaiyaraaja',
      composerName: 'Ilaiyaraaja',
      releaseYear: 1989,
      trackCount: 5,
      variants: [],
      storageMountId: 'mount-1',
      genreTags: ['Soundtrack'],
      artwork: { resolution: '1000x1000' } as any,
    },
  ]

  const grouped = groupAlbumReleases(releaseVariants)
  console.log(`Grouped ${releaseVariants.length} releases into ${grouped.length} master release groups.`)
  assert(grouped.length === 2, `Expected 2 groups (Captain Prabhakaran stack and Nilavae Oru Sangeetham), got ${grouped.length}`)
  const cpGroup = grouped.find((g) => g.masterRelease.title.toLowerCase().includes('prabhakaran'))
  assert(Boolean(cpGroup), 'Captain Prabhakaran group must be formed')
  assert(cpGroup!.constituentReleases.length === 2, `Captain Prabhakaran should have 2 variants stacked (got ${cpGroup?.constituentReleases.length})`)
  console.log('✓ Rip noise stripping & bounded agglomerative fuzzy stacking passed.\n')

  // -------------------------------------------------------------
  // Test 5: Dynamic Range (DR) Feature Flag & Nullable Integrity
  // -------------------------------------------------------------
  console.log('[Test 5] Verifying DR feature flag and safe null handling...')
  assert(FEATURES.DYNAMIC_RANGE === false, 'FEATURES.DYNAMIC_RANGE must be disabled by default')

  const badgeClassNull = IntegrityScanner.getDrBadgeClass(null)
  assert(badgeClassNull.label === 'Bypassed', `DR badge class for null must return Bypassed (got ${badgeClassNull.label})`)

  const drMeasurement = IntegrityScanner.calculateAccurateDR({}, 'sample.flac')
  assert(drMeasurement.drScore === null, 'Bypassed scanner must return null drScore')
  assert(drMeasurement.source === 'bypassed', 'Bypassed scanner must return "bypassed" drSource')
  console.log('✓ Dynamic Range feature flag and safe nullability passed.\n')

  console.log('===========================================================')
  console.log('ALL METADATA COHERENCE & CATALOG TESTS PASSED CLEANLY (5/5)')
  console.log('===========================================================')
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err)
  process.exit(1)
})
