/**
 * src/test/testSequenceOffsetAndConsensus.ts
 * Test suite for 2-Tier Curation, Sequence Offset Alignment, Consensus Empty-State,
 * and Behavioral Learning Normalization.
 */

import {
  detectSequenceOffset,
  applyConsensusEmptyStateRule,
  matchTrackArtistFromProviderList,
  ProviderTrackItem,
} from '../core/taxonomyUtils'
import { behavioralLearningService } from '../services/behavioralLearningService'
import { CurateTier, Release, Track } from '../core/types'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`[Assertion Failed] ${message}`)
  }
}

async function runTests() {
  console.log('=== RUNNING 2-TIER SEQUENCE OFFSET & CONSENSUS ENGINE TESTS ===\n')

  // --------------------------------------------------------------------------
  // 1. Sequence Offset Alignment (Ranga 1982 Case: Tracks #6-#10 -> #1-#5)
  // --------------------------------------------------------------------------
  console.log('[1] Testing Sequence Offset Alignment...')

  const localRangaTracks: Array<{ id: string; trackNumber: number; title: string; duration?: number }> = [
    { id: 't-6', trackNumber: 6, title: '06 - Pattukottai Ammalu.wav' },
    { id: 't-7', trackNumber: 7, title: '07 - Azhagana Pattu Poochi.wav' },
    { id: 't-8', trackNumber: 8, title: '08 - Purushanthan Enakku.wav' },
    { id: 't-9', trackNumber: 9, title: '09 - Tooth Paste.wav' },
    { id: 't-10', trackNumber: 10, title: '10 - Oru Maina.wav' },
  ]

  const providerRangaTracks: ProviderTrackItem[] = [
    { trackNumber: 1, trackName: 'Pattukotta Ammalu', artistName: 'S. P. Balasubrahmanyam & S. Janaki' },
    { trackNumber: 2, trackName: 'Azhagana Pattu Poochi', artistName: 'K. J. Yesudas & Vani Jairam' },
    { trackNumber: 3, trackName: 'Purushanthan Enakku', artistName: 'Vani Jairam' },
    { trackNumber: 4, trackName: 'Tooth Paste', artistName: 'Malaysia Vasudevan' },
    { trackNumber: 5, trackName: 'Oru Maina', artistName: 'S. P. Balasubrahmanyam' },
  ]

  const offsetResult = detectSequenceOffset(localRangaTracks, providerRangaTracks)
  console.log('  Detected Offset:', offsetResult.detectedOffset, 'Confidence:', offsetResult.confidence.toFixed(2), 'Matched count:', offsetResult.matchedTrackCount)

  assert(offsetResult.detectedOffset === 5, `Expected offset = 5 (6 - 1 = 5), got ${offsetResult.detectedOffset}`)
  assert(offsetResult.isConfidentOffset, 'Expected isConfidentOffset to be true')
  assert(offsetResult.matchedTrackCount >= 4, `Expected at least 4 matched tracks, got ${offsetResult.matchedTrackCount}`)

  // Verify alignment with sequence offset awareness
  const effectiveLocalTrack6AppleNum = localRangaTracks[0].trackNumber - offsetResult.detectedOffset // 6 - 5 = 1
  assert(effectiveLocalTrack6AppleNum === 1, 'Local track 6 must map to provider track 1')
  const matched = providerRangaTracks.find(pt => pt.trackNumber === effectiveLocalTrack6AppleNum)
  assert(matched?.artistName === 'S. P. Balasubrahmanyam & S. Janaki', 'Must match correct vocalist rather than Devi Sri Prasad')

  // --------------------------------------------------------------------------
  // 2. Consensus Empty-State Invariant (No local value + split provider votes)
  // --------------------------------------------------------------------------
  console.log('\n[2] Testing Consensus Empty-State Invariant...')

  // Case A: Missing local tag with split external votes -> MUST LEAVE EMPTY
  const splitCheck = applyConsensusEmptyStateRule('', {
    apple: 'Deva',
    musicbrainz: 'Shankar Ganesh',
    ai: 'Bloodnut',
  })
  console.log('  Split external votes result selected:', JSON.stringify(splitCheck.selected), 'requiresHumanReview:', splitCheck.requiresHumanReview)
  assert(splitCheck.selected === '', 'Selected value must be empty string when external providers split and local tag is absent')
  assert(!splitCheck.hasConsensus, 'hasConsensus must be false on split votes')
  assert(splitCheck.requiresHumanReview, 'requiresHumanReview must be true')

  // Case B: Missing local tag with quorum (2+ agreeing external providers) -> POPULATES
  const quorumCheck = applyConsensusEmptyStateRule('', {
    apple: 'Ilaiyaraaja',
    musicbrainz: 'Ilaiyaraaja',
    ai: 'Deva',
  })
  console.log('  Quorum external votes result selected:', splitCheck.selected || quorumCheck.selected)
  assert(quorumCheck.selected === 'Ilaiyaraaja', 'Selected must populate when 2 external providers agree')
  assert(quorumCheck.hasConsensus, 'hasConsensus must be true on quorum')
  assert(!quorumCheck.requiresHumanReview, 'requiresHumanReview must be false on quorum')

  // Case C: Local tag present with matching provider -> POPULATES LOCAL
  const localMatchCheck = applyConsensusEmptyStateRule('Ilaiyaraaja', {
    apple: 'Ilaiyaraaja',
    musicbrainz: 'Ilaiyaraaja (The Maestro)',
  })
  assert(localMatchCheck.selected === 'Ilaiyaraaja', 'Selected must keep local value when matching')

  // --------------------------------------------------------------------------
  // 3. Behavioral Learning Engine (Spelling / Delimiter Generalization)
  // --------------------------------------------------------------------------
  console.log('\n[3] Testing Behavioral Learning Engine...')

  // Teach user correction: "A.R. Rahman" -> "A. R. Rahman"
  const createdRules = behavioralLearningService.teachRule('A.R. Rahman', 'A. R. Rahman', 'artist')
  console.log('  Taught rule variants generated:', createdRules.map(r => r.pattern))

  assert(createdRules.length > 0, 'Must create learning rules for variations')

  // Test automatic normalization of variants
  const testInput1 = 'A.R.Rahman'
  const normResult1 = behavioralLearningService.applyLearnedRules(testInput1, 'artist')
  console.log(`  Applied rule on "${testInput1}" -> "${normResult1.value}"`)
  assert(normResult1.value === 'A. R. Rahman', `Expected "A. R. Rahman", got "${normResult1.value}"`)

  const testInput2 = 'AR Rahman'
  const normResult2 = behavioralLearningService.applyLearnedRules(testInput2, 'artist')
  console.log(`  Applied rule on "${testInput2}" -> "${normResult2.value}"`)
  assert(normResult2.value === 'A. R. Rahman', `Expected "A. R. Rahman", got "${normResult2.value}"`)

  // Test sub-string multiple artist delimiter
  const testCombo = 'K.J. Yesudas & S.P.B.'
  const normCombo = behavioralLearningService.applyLearnedRules(testCombo, 'artist')
  console.log(`  Applied delimiter/token rules on "${testCombo}" -> "${normCombo.value}"`)
  assert(normCombo.value.includes('K. J. Yesudas') || normCombo.value.includes('S. P. Balasubrahmanyam'), 'Should expand abbreviations')

  console.log('\n=== ALL 2-TIER TESTS PASSED SUCCESSFULLY! ===')
}

runTests().catch(err => {
  console.error('\n❌ Test suite failed:', err)
  process.exit(1)
})

