import assert from 'assert'
import { AuditIssue, Track, Release } from '../core/types'
import { auditService } from '../services/auditService'
import { normalizationService } from '../services/normalizationService'
import {
  getIssueCanonicalTarget,
  getIssueDetectedValue,
  getIssueProposedAction,
  getIssueTagBadge,
} from '../components/Maintain/MaintainCockpit'

console.log('\n=== [TDD] Testing Audit & Hygiene Clustered Data-Binding Precision ===\n')

// 1. Inverted Grouping Logic Test
console.log('[Test 1] Testing Canonical Authority Grouping vs Detected Variant Subject...')

const mockTracks: Track[] = [
  {
    id: 'trk-blue-01',
    releaseId: 'rel-blue',
    recordingId: 'rec-chiggy',
    trackNumber: 1,
    discNumber: 1,
    title: 'Chiggy Wiggy',
    artistCredit: 'Kylie Minogue, Sonu Nigam',
    composerName: 'A. R. Rahman',
    durationSeconds: 310,
    filePath: '/music/Blue/01 - Chiggy Wiggy.flac',
    fileSize: 34000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: new Date().toISOString(),
    checksumValid: true,
    accurateRipConfidence: 10,
    drScore: 12,
  },
  {
    id: 'trk-dilse-01',
    releaseId: 'rel-dilse',
    recordingId: 'rec-chaiyya',
    trackNumber: 1,
    discNumber: 1,
    title: 'Chaiyya Chaiyya',
    artistCredit: 'Sukhwinder Singh, Sapna Awasthi',
    composerName: 'A.R. Rahman',
    durationSeconds: 395,
    filePath: '/music/Dil Se/01 - Chaiyya.flac',
    fileSize: 45000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: new Date().toISOString(),
    checksumValid: true,
    accurateRipConfidence: 12,
    drScore: 14,
  },
]

const mockReleases: Release[] = [
  {
    id: 'rel-blue',
    title: 'Blue',
    artistCredit: 'A. R. Rahman',
    releaseYear: 2009,
    tracksCount: 8,
    discsCount: 1,
    format: 'FLAC 24/96',
    qualityLevel: 'hi_res',
    dynamicRangeScore: 12,
    sidecarStatus: 'synced',
    hasLosslessFlac: true,
    hasHighResAudio: true,
    hasSurroundAudio: false,
    allTracksAccurateRip: true,
    drRating: 'great',
    storageMountId: 'mount-1',
  },
]

// Simulate an artist name variant issue where sample track has singer "Kylie Minogue, Sonu Nigam"
const variantIssue: AuditIssue = {
  id: 'audit-name-arrahman',
  category: 'inconsistent_name',
  severity: 'warning',
  title: 'Inconsistent Artist Name: "A. R. Rahman" vs "A.R. Rahman"',
  description: 'Discovered 31 track(s) with conflicting spellings (A. R. Rahman vs A.R. Rahman).',
  affectedCount: 31,
  sampleTrackIds: ['trk-blue-01'],
  suggestedFix: 'Normalize all affected tracks to canonical authority "A. R. Rahman".',
  tagField: 'ALBUMARTIST',
  detectedValue: 'A.R. Rahman',
  currentValue: 'A.R. Rahman',
  targetValue: 'A. R. Rahman',
  proposedAction: 'ALBUMARTIST = "A. R. Rahman"',
  canonicalTarget: 'A. R. Rahman',
  parentEntity: 'A. R. Rahman',
}

// Simulate performer vs composer conflict
const roleIssue: AuditIssue = {
  id: 'audit-role-blue-kylie',
  category: 'compilation_conflict',
  severity: 'info',
  title: 'Performer vs. Composer: "Kylie Minogue, Sonu Nigam"',
  description: 'Discovered 1 track(s) performed by "Kylie Minogue, Sonu Nigam" under album authority "A. R. Rahman".',
  affectedCount: 1,
  sampleTrackIds: ['trk-blue-01'],
  suggestedFix: 'Keep as Track Artist to preserve playback singer credits.',
  tagField: 'ARTIST',
  detectedValue: 'Kylie Minogue, Sonu Nigam',
  currentValue: 'Kylie Minogue, Sonu Nigam',
  targetValue: 'Kylie Minogue, Sonu Nigam',
  proposedAction: 'ARTIST = "Kylie Minogue, Sonu Nigam" (Keep Singer)',
  canonicalTarget: 'A. R. Rahman',
  parentEntity: 'A. R. Rahman',
  isRoleConflict: true,
}

// Test canonical target resolution
const canonicalTarget1 = getIssueCanonicalTarget(variantIssue)
const canonicalTarget2 = getIssueCanonicalTarget(roleIssue)

assert.strictEqual(
  canonicalTarget1,
  'A. R. Rahman',
  'Variant issue canonical target must resolve to "A. R. Rahman"'
)
assert.strictEqual(
  canonicalTarget2,
  'A. R. Rahman',
  'Role conflict canonical target must resolve to parent authority "A. R. Rahman", NOT singer!'
)
console.log('  ✓ Both variant and role conflicts correctly resolve parent authority to "A. R. Rahman"')

// [Test 2] Testing Detected Value binding vs Issue Title
console.log('\n[Test 2] Testing Raw Detected Tag Value vs Summary Issue Title...')

const detectedVal1 = getIssueDetectedValue(variantIssue, 'A. R. Rahman')
const detectedVal2 = getIssueDetectedValue(roleIssue, 'A. R. Rahman')

assert.strictEqual(
  detectedVal1,
  'A.R. Rahman',
  `Detected value must be raw tag "A.R. Rahman", got: "${detectedVal1}"`
)
assert(
  !detectedVal1.includes('Inconsistent Artist Name'),
  'Detected value must NOT be the old summary issue title!'
)

assert.strictEqual(
  detectedVal2,
  'Kylie Minogue, Sonu Nigam',
  `Detected value must be raw singer string "Kylie Minogue, Sonu Nigam", got: "${detectedVal2}"`
)
console.log('  ✓ Detected value column binds strictly to raw tag value in file')

// [Test 3] Testing Clean Proposed Action Tag
console.log('\n[Test 3] Testing Clean Proposed Action Tag (Dropping verbose sentences)...')

const action1 = getIssueProposedAction(variantIssue, 'A. R. Rahman')
const action2 = getIssueProposedAction(roleIssue, 'A. R. Rahman')

assert.strictEqual(
  action1,
  'ALBUMARTIST = "A. R. Rahman"',
  `Proposed action must be concise tag "ALBUMARTIST = "A. R. Rahman"", got: "${action1}"`
)
assert(
  !action1.includes('matching remembered normalization authority'),
  'Proposed action must drop verbose sentence fragments!'
)

assert.strictEqual(
  action2,
  'ARTIST = "Kylie Minogue, Sonu Nigam" (Keep Singer)',
  `Proposed action for singer must be "ARTIST = "Kylie Minogue, Sonu Nigam" (Keep Singer)", got: "${action2}"`
)
console.log('  ✓ Proposed action displays clean target tag assignment')

// [Test 4] Testing Dynamic Tag Field Badge
console.log('\n[Test 4] Testing Dynamic Domain Tag Field Badge...')

const backdropIssue: AuditIssue = {
  id: 'audit-unformatted-backdrops',
  category: 'unformatted_backdrop',
  severity: 'warning',
  title: 'Unformatted Album Backdrops (3 albums)',
  description: 'Missing 2400x320 derivatives',
  affectedCount: 3,
  sampleTrackIds: [],
  suggestedFix: 'Generate 2400x320 panoramic backdrops',
  tagField: 'BACKDROP',
  detectedValue: 'Unformatted (Square / Text Scans)',
  currentValue: 'Missing Panoramic Derivatives',
  targetValue: '2400×320 Panoramic Backdrop',
  proposedAction: 'BACKDROP = 2400×320 Panoramic Derivative',
  canonicalTarget: 'Artwork & Media Integrity',
}

const coverArtIssue: AuditIssue = {
  id: 'audit-low-res-art',
  category: 'low_res_art',
  severity: 'warning',
  title: 'Missing / Low-Resolution Cover Artwork (< 800px)',
  description: 'Low-res artwork',
  affectedCount: 6,
  sampleTrackIds: [],
  suggestedFix: 'Fetch high-res front scan',
  tagField: 'COVER_ART',
  detectedValue: '400x400px (72 DPI)',
  currentValue: '400x400px',
  targetValue: 'Archival High-Res (Front)',
  proposedAction: 'COVER = Archival Front Scan',
  canonicalTarget: 'Artwork & Media Integrity',
}

const trackNumIssue: AuditIssue = {
  id: 'audit-missing-track-num',
  category: 'missing_track_num',
  severity: 'warning',
  title: 'Missing Sequential Track Numbers',
  description: 'Missing track numbers',
  affectedCount: 4,
  sampleTrackIds: [],
  suggestedFix: 'Auto-sequence track numbers',
  tagField: 'TRACK_NUMBER',
  detectedValue: '0 / Null',
  currentValue: '0 / Null',
  targetValue: 'Sequential (01..N)',
  proposedAction: 'TRACKNUMBER = Sequential (01..N)',
  canonicalTarget: 'Sequential Track Indexing',
}

const badgeBackdrop = getIssueTagBadge(backdropIssue)
const badgeCoverArt = getIssueTagBadge(coverArtIssue)
const badgeTrackNum = getIssueTagBadge(trackNumIssue)
const badgeNorm = getIssueTagBadge(variantIssue)
const badgeSinger = getIssueTagBadge(roleIssue)

assert.strictEqual(badgeBackdrop.label, 'ARTWORK / BACKDROP', 'Backdrop issue must have ARTWORK / BACKDROP badge')
assert.strictEqual(badgeCoverArt.label, 'COVER ART', 'Cover art issue must have COVER ART badge')
assert.strictEqual(badgeTrackNum.label, 'TRACK NUM', 'Track num issue must have TRACK NUM badge')
assert.strictEqual(badgeNorm.label, 'ALBUMARTIST', 'Norm issue must have ALBUMARTIST badge')
assert.strictEqual(badgeSinger.label, 'ARTIST', 'Singer conflict must have ARTIST badge')

console.log('  ✓ Tag field dynamically maps to domain (BACKDROP, COVER ART, TRACK NUM, ALBUMARTIST, ARTIST)')

// [Test 5] Dynamic Library Health Pill Text
console.log('\n[Test 5] Testing Dynamic Library Health Pill Text Thresholds...')

const getHealthBadgeText = (healthScore: number, affectedTracksCount: number) => {
  return healthScore >= 90
    ? `${healthScore}% Library Health · Optimal`
    : healthScore >= 70
    ? `${healthScore}% Library Health · Minor Attention`
    : affectedTracksCount > 0
    ? `${affectedTracksCount} Tracks Need Triage`
    : `${healthScore}% Health · Needs Triage`
}

assert.strictEqual(getHealthBadgeText(95, 0), '95% Library Health · Optimal')
assert.strictEqual(getHealthBadgeText(75, 10), '75% Library Health · Minor Attention')
assert.strictEqual(getHealthBadgeText(10, 376), '376 Tracks Need Triage')
assert(!getHealthBadgeText(10, 376).includes('Optimal'), '10% health badge must NEVER say Optimal!')

console.log('  ✓ 10% health score displays "376 Tracks Need Triage" without contradictory "Optimal"')

// [Test 6] Safeguarding Playback Singers & Multi-Artist Collaborations from Erasure
console.log('\n[Test 6] Testing Multi-Artist Collaborative Singers Safeguard...')

const multiPerformer1 = 'A. R. Rahman, Anuradha Sriram & Anupama'
const multiPerformer2 = 'Madhushree & A. R. Rahman'
const canonicalComposer = 'A. R. Rahman'

// 1. isPlausibleVariant must reject treating multi-artist credits as single-artist typos
assert.strictEqual(
  normalizationService.isPlausibleVariant(multiPerformer1, canonicalComposer),
  false,
  'Multi-artist credit "A. R. Rahman, Anuradha Sriram & Anupama" must NEVER be a plausible typo of "A. R. Rahman"'
)
assert.strictEqual(
  normalizationService.isPlausibleVariant(multiPerformer2, canonicalComposer),
  false,
  'Multi-artist credit "Madhushree & A. R. Rahman" must NEVER be a plausible typo of "A. R. Rahman"'
)
console.log('  ✓ Multi-artist credits are strictly rejected from single-artist variant matching')

// 2. Audit engine classification check
const testTracks: Track[] = [
  {
    id: 'trk-collab-01',
    releaseId: 'rel-test-rahman',
    recordingId: 'rec-01',
    trackNumber: 1,
    discNumber: 1,
    title: 'Anbendra Mazhaiyile',
    artistCredit: multiPerformer1,
    composerName: canonicalComposer,
    durationSeconds: 300,
    filePath: '/music/test/01.flac',
    fileSize: 30000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    modifiedTimestamp: new Date().toISOString(),
    checksumValid: true,
  },
]
const testReleases: Release[] = [
  {
    id: 'rel-test-rahman',
    title: 'Minsaara Poove',
    artistCredit: canonicalComposer,
    releaseYear: 1999,
    tracksCount: 1,
    discsCount: 1,
    format: 'FLAC 24/96',
    qualityLevel: 'hi_res',
    dynamicRangeScore: 12,
    sidecarStatus: 'synced',
    hasLosslessFlac: true,
    hasHighResAudio: true,
    hasSurroundAudio: false,
    allTracksAccurateRip: true,
    drRating: 'great',
    storageMountId: 'mount-1',
  },
]

const { issues: evaluatedIssues } = auditService.computeCatalogAudit(testTracks, testReleases)

// Must NOT be classified as inconsistent_name
const typoIssue = evaluatedIssues.find((i) => i.category === 'inconsistent_name')
assert.strictEqual(typoIssue, undefined, 'Collaborative singers must NEVER be flagged as inconsistent_name typo')

// Must be classified as compilation_conflict with role review
const roleConflict = evaluatedIssues.find((i) => i.category === 'compilation_conflict' && i.isRoleConflict)
assert(roleConflict !== undefined, 'Collaborative singers must be classified as role conflict under parent authority')
assert.strictEqual(roleConflict?.tagField, 'ARTIST', 'Tag field must be ARTIST (preserving singers), NOT ALBUMARTIST')
assert.strictEqual(roleConflict?.autoFixAction, 'KEEP_TRACK_ARTIST', 'Action must be KEEP_TRACK_ARTIST')
assert.strictEqual(roleConflict?.fixActionLabel, 'Keep Singer', 'Action label must be "Keep Singer"')

console.log('  ✓ Collaborative tracks accurately route to "Keep Singer" without risking artist overwrite')

// 7. Missing and Low-Resolution Cover Artwork Audit Detection
console.log('\n[Test 7] Testing Missing and Low-Resolution Cover Artwork Audit Detection...')

const mockNoArtRelease: Release = {
  id: 'rel-no-art',
  masterReleaseId: 'rel-no-art',
  title: 'Enga Ooru Pattukaran',
  artistCredit: 'Ilaiyaraaja',
  releaseYear: 1987,
  originalYear: 1987,
  label: 'Echo',
  catalogNumber: 'CAT-1987',
  mediaFormat: 'Lossless Audio',
  country: 'India',
  matrixRunout: '',
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
  variants: [],
  discsCount: 1,
  tracksCount: 1,
  genreTags: ['Soundtrack'],
  storageMountId: 'mount-1',
}

const mockNoArtTrack: Track = {
  id: 'trk-no-art-01',
  releaseId: 'rel-no-art',
  recordingId: 'rec-no-art-01',
  trackNumber: 1,
  discNumber: 1,
  title: 'Madhura Marikozhundhu',
  artistCredit: 'Mano, K. S. Chithra',
  composerName: 'Ilaiyaraaja',
  durationSeconds: 280,
  filePath: '/music/Enga Ooru Pattukaran/01.flac',
  fileSize: 30000000,
  storageMountId: 'mount-1',
  sidecarStatus: 'synced',
  modifiedTimestamp: new Date().toISOString(),
  checksumValid: true,
}

const { issues: artAuditIssues } = auditService.computeCatalogAudit([mockNoArtTrack], [mockNoArtRelease])
const missingCoverIssue = artAuditIssues.find((i) => i.category === 'low_res_art')

assert(missingCoverIssue !== undefined, 'Audit engine must report missing cover art as an issue')
assert.strictEqual(missingCoverIssue?.id, 'audit-low-res-art', 'Issue id must be audit-low-res-art')
assert.strictEqual(missingCoverIssue?.tagField, 'COVER_ART', 'Tag field must be COVER_ART')
assert.strictEqual(missingCoverIssue?.canonicalTarget, 'Artwork & Media Integrity', 'Canonical target must be Artwork & Media Integrity')
assert.strictEqual(missingCoverIssue?.detectedValue, 'Missing Cover Artwork', 'Detected value must specify Missing Cover Artwork')
assert.strictEqual(missingCoverIssue?.currentValue, 'No Cover Art', 'Current value must be No Cover Art')
assert.strictEqual(missingCoverIssue?.autoFixAction, 'FETCH_HIRES_ART', 'Auto fix action must be FETCH_HIRES_ART')

const detectedDisplay = getIssueDetectedValue(missingCoverIssue, 'Artwork & Media Integrity')
assert.strictEqual(detectedDisplay, 'No Cover Art', 'MaintainCockpit detected value must display "No Cover Art"')

const proposedArtAction = getIssueProposedAction(missingCoverIssue, 'Artwork & Media Integrity')
assert.strictEqual(proposedArtAction, 'Fetch Archival Artwork (Apple Music / MusicBrainz)', 'Proposed action must be "Fetch Archival Artwork (Apple Music / MusicBrainz)"')

// Test Folder Extraction action text
const mockEmptyComposerIssue: AuditIssue = {
  id: 'audit-missing-artists',
  category: 'empty_composer',
  severity: 'critical',
  title: 'Untagged Audio Files',
  description: 'Missing artists',
  affectedCount: 1,
  sampleTrackIds: [],
  tagField: 'ALBUMARTIST',
  detectedValue: 'Unknown Artist',
  currentValue: 'Unknown Artist',
  targetValue: 'Parse from Folder Structure',
  proposedAction: 'Parse Artist & Composer from Folder Hierarchy',
  canonicalTarget: 'Untagged Audio Standards',
}
const proposedFolderAction = getIssueProposedAction(mockEmptyComposerIssue, 'Untagged Audio Standards')
assert.strictEqual(proposedFolderAction, 'Parse Artist & Composer from Folder Hierarchy', 'Folder extraction action must be clear and not wrapped in quotes')

console.log('  ✓ Missing cover art is accurately reported and flagged with "Missing Cover Artwork"')
console.log('  ✓ Proposed actions display clean action descriptions without misleading quotes')

console.log('\n========================================================')
console.log('🎉 ALL AUDIT & HYGIENE DATA-BINDING TESTS PASSED!')
console.log('========================================================\n')
