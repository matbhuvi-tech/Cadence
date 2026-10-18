import { normalizationService } from '../services/normalizationService'
import { canonicalizeComposer, splitAndCanonicalizePerformers } from '../core/taxonomyUtils'
import { federatedResolversService, ProviderResult } from '../services/federatedResolvers'
import { auditService } from '../services/auditService'
import { graphEngine } from '../core/graphEngine'
import { mockTracks, mockReleases } from '../core/mockCatalog'

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`)
    throw new Error(`Assertion failed: ${msg}`)
  }
  console.log(`  ✓ ${msg}`)
}

async function runNormalizationTests() {
  console.log('\n=== [TDD] Testing Remembered Normalizations & Enrichment Precedence ===\n')

  // Setup: clear any leftover rules
  normalizationService.clearRules()
  assert(normalizationService.getRules().length === 0, 'Initial rules store is empty')

  // Test 1: Record normalization rule: "A. R. Rahman" -> "A.R.Rahman"
  console.log('\n[Test 1] Recording normalization rule: "A. R. Rahman" -> "A.R.Rahman"...')
  const rule = normalizationService.recordNormalization('A. R. Rahman', 'A.R.Rahman', 'artist')
  assert(rule.sourcePattern === 'A. R. Rahman', 'Rule source pattern matches')
  assert(rule.targetValue === 'A.R.Rahman', 'Rule target value matches')
  assert(rule.isEnabled === true, 'Rule is active by default')
  assert(normalizationService.getRules().length === 1, 'Rule stored successfully')

  // Test 2: Smart matching and text application
  console.log('\n[Test 2] Testing text normalization and loose phonetic matching...')
  assert(
    normalizationService.applyToText('A. R. Rahman', 'artist') === 'A.R.Rahman',
    'Direct match "A. R. Rahman" normalized to "A.R.Rahman"'
  )
  assert(
    normalizationService.applyToText('a. r. rahman', 'artist') === 'A.R.Rahman',
    'Case-insensitive "a. r. rahman" normalized to "A.R.Rahman"'
  )
  assert(
    normalizationService.applyToText('A.R. Rahman', 'artist') === 'A.R.Rahman',
    'Punctuation variant "A.R. Rahman" normalized to "A.R.Rahman"'
  )
  assert(
    normalizationService.applyToText('AR Rahman', 'artist') === 'A.R.Rahman',
    'Phonetic/unpunctuated "AR Rahman" normalized to "A.R.Rahman"'
  )
  assert(
    normalizationService.applyToText('A.R.Rahman', 'artist') === 'A.R.Rahman',
    'Already canonical "A.R.Rahman" preserved intact'
  )
  assert(
    normalizationService.applyToText('A. R. Rahman & Hariharan', 'artist') === 'A.R.Rahman & Hariharan',
    'Delimited composite performer string normalized accurately'
  )

  // Test 3: Precedence in external enrichment candidates
  console.log('\n[Test 3] Testing enrichment precedence over Apple Music, MusicBrainz, and Gemini AI...')
  const rawMusicBrainzCandidate: ProviderResult = {
    provider: 'musicbrainz',
    confidenceScore: 0.96,
    releaseTitle: 'Dil Se..',
    trackTitle: 'Dil Se Re',
    artistCredit: 'A. R. Rahman', // Raw external string
    composer: 'A. R. Rahman',     // Raw external string
    releaseYear: 1998,
    catalogNumber: 'VCD-1002',
    label: 'Venus Records',
    barcodeUpc: '8901112223334',
    coverArtUrl: 'https://example.com/art.jpg',
    coverResolution: '3000x3000px',
  }

  const normalizedMbCandidate = normalizationService.applyToCandidate(rawMusicBrainzCandidate)
  assert(
    normalizedMbCandidate.artistCredit === 'A.R.Rahman',
    'MusicBrainz candidate artist normalized to "A.R.Rahman"'
  )
  assert(
    normalizedMbCandidate.composer === 'A.R.Rahman',
    'MusicBrainz candidate composer normalized to "A.R.Rahman"'
  )

  // Test 4: Taxonomy utilities canonical resolution
  console.log('\n[Test 4] Testing taxonomy canonicalization precedence...')
  const composerRes = canonicalizeComposer('A. R. Rahman')
  assert(
    composerRes.canonicalName === 'A.R.Rahman',
    `canonicalizeComposer("A. R. Rahman") returns remembered canonical "${composerRes.canonicalName}"`
  )

  const performers = splitAndCanonicalizePerformers('A. R. Rahman & S. P. Balasubrahmanyam')
  assert(
    performers.includes('A.R.Rahman'),
    'splitAndCanonicalizePerformers returns remembered canonical "A.R.Rahman"'
  )

  // Test 5: Diff field generation preserves user canonical without false mutation
  console.log('\n[Test 5] Testing diff fields generation with remembered normalization...')
  const currentTrackState = {
    trackTitle: 'Dil Se Re',
    releaseTitle: 'Dil Se..',
    artist: 'A.R.Rahman', // User already normalized this track
    composer: 'A.R.Rahman',
    year: '1998',
    catalogNo: 'VCD-1002',
    label: 'Venus Records',
    barcode: '8901112223334',
    matrix: '',
    artResolution: '3000x3000px',
  }

  const diffFields = federatedResolversService.generateDiffFields(
    currentTrackState,
    [normalizedMbCandidate]
  )
  const artistField = diffFields.find((f) => f.fieldName === 'artist' || f.fieldName === 'artistCredit')
  assert(artistField !== undefined, 'Artist field exists in diff')
  assert(
    artistField?.status === 'identical',
    `Artist diff status is "${artistField?.status}" (no false mutation reported against external data)`
  )
  assert(
    artistField?.musicbrainzValue === 'A.R.Rahman',
    `Candidate diff displays remembered canonical "${artistField?.musicbrainzValue}"`
  )

  // Test 6: Audit service cluster canonical authority precedence
  console.log('\n[Test 6] Testing audit service canonical authority from remembered rule...')
  // Load demo catalog into graphEngine for audit inspection
  graphEngine.loadDemoCatalog()


  // Set sample track to have "A. R. Rahman"
  const t0 = graphEngine.getAllTracks()[0]
  if (t0) {
    t0.artistCredit = 'A. R. Rahman'
    t0.composerName = 'A. R. Rahman'
  }

  const issues = auditService.runFullCatalogAudit()
  const nameIssue = issues.find(
    (i) =>
      i.id.includes('arrahman') ||
      i.title.toLowerCase().includes('rahman') ||
      i.description.toLowerCase().includes('rahman')
  )

  if (nameIssue) {
    assert(
      nameIssue.suggestedFix.includes('A.R.Rahman'),
      `Audit suggestedFix recommends remembered canonical: "${nameIssue.suggestedFix}"`
    )
  }

  // Test 7: Apply remembered normalizations across catalog
  console.log('\n[Test 7] Testing graphEngine.applyRememberedNormalizations()...')
  const modifiedCount = graphEngine.applyRememberedNormalizations()
  assert(modifiedCount >= 1, `applyRememberedNormalizations updated ${modifiedCount} track(s)`)

  const updatedTrack = graphEngine.getTrackById(t0.id)
  assert(
    updatedTrack?.artistCredit === 'A.R.Rahman',
    `Track artist is now "${updatedTrack?.artistCredit}"`
  )
  assert(
    updatedTrack?.composerName === 'A.R.Rahman',
    `Track composer is now "${updatedTrack?.composerName}"`
  )
  assert(
    updatedTrack?.sidecarStatus === 'uncommitted_sidecar',
    'Track is marked uncommitted_sidecar for safe 2-phase commit'
  )

  // Test 8: Remediate issue records normalization rule
  console.log('\n[Test 8] Testing remediateIssue records new normalization rules...')
  normalizationService.clearRules()
  assert(normalizationService.getRules().length === 0, 'Rules cleared for test')

  // Run normalizeArtistNames
  graphEngine.normalizeArtistNames('Ilaiyaraaja', 'Ilaiyaraaja Master')
  const newRule = normalizationService.getRules().find((r) => r.targetValue === 'Ilaiyaraaja Master')
  assert(newRule !== undefined, 'normalizeArtistNames automatically created persistent rule')
  assert(newRule?.sourcePattern === 'Ilaiyaraaja', 'Rule source pattern is Ilaiyaraaja')

  console.log('\n========================================================')
  console.log('🎉 ALL NORMALIZATION & ENRICHMENT PRECEDENCE TESTS PASSED!')
  console.log('========================================================\n')
}

runNormalizationTests().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
