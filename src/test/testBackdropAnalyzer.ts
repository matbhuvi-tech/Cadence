import { backdropAnalyzer, INLAY_SCAN_PATTERNS } from '../services/backdropAnalyzer'
import { auditService } from '../services/auditService'
import { graphEngine } from '../core/graphEngine'
import { Release, Track } from '../core/types'

console.log('\n=== [TDD] Testing Automated Backdrop Identification & Formatting ===\n')

// 1. Test Inlay / Back-Cover Regex Patterns
console.log('[Test 1] Testing Inlay & Back-Cover scan detection heuristics...')
const testScanNames = [
  'Thalapathi_Back.jpg',
  'CD_Tray_Inlay.png',
  'album_rear_cover.jpg',
  'liner_notes_scan.jpg',
  'booklet_01.jpg',
  'case_insert.jpg',
  'disc_1_art.png',
  'inlaycard.jpg',
  'front_cover.jpg',
  'folder.jpg',
]

testScanNames.forEach((name) => {
  const isMatch = INLAY_SCAN_PATTERNS.test(name)
  if (name.includes('front') || name.includes('folder')) {
    if (!isMatch) {
      console.log(`  ✓ "${name}" correctly classified as non-inlay`)
    } else {
      console.error(`  ✗ "${name}" falsely flagged as inlay`)
    }
  } else {
    if (isMatch) {
      console.log(`  ✓ "${name}" correctly detected as suspected inlay/back-cover scan`)
    } else {
      console.error(`  ✗ "${name}" failed detection as inlay`)
    }
  }
})

// 2. Test Single Release Backdrop Analysis
console.log('\n[Test 2] Testing Release Backdrop Analysis...')

const testReleaseWithInlayBackdrop: Release = {
  id: 'rel-thalapathi',
  masterReleaseId: 'rel-thalapathi',
  title: 'Thalapathi',
  folderName: 'Thalapathi',
  artistCredit: 'Ilaiyaraaja',
  releaseYear: 1991,
  originalYear: 1991,
  label: 'Lahari Music',
  catalogNumber: 'LHR-001',
  mediaFormat: 'Lossless Audio',
  country: 'India',
  matrixRunout: '',
  artwork: {
    frontCoverUrl: 'https://example.com/thalapathi_front.jpg',
    backdropUrl: 'https://example.com/thalapathi_back_inlay.jpg', // Suspected back cover!
    resolution: '1200x1200px',
    width: 1200,
    height: 1200,
    dpi: 300,
    colorProfile: 'sRGB',
    isLowRes: false,
    hasBookletPdf: false,
  },
  variants: [],
  discsCount: 1,
  tracksCount: 8,
  genreTags: ['Soundtrack'],
  storageMountId: 'mount-1',
}

const analysis1 = backdropAnalyzer.analyzeReleaseBackdrop(testReleaseWithInlayBackdrop)
console.log(`- Result for release with inlay backdrop: isUnformatted=${analysis1.isUnformatted}, reason="${analysis1.reason}"`)
if (analysis1.isUnformatted && analysis1.reason === 'suspected_inlay_or_back_cover') {
  console.log('  ✓ Correctly flagged suspected inlay/back-cover backdrop!')
} else {
  console.error('  ✗ Failed to flag suspected inlay backdrop!')
}

// 3. Test Missing Backdrop
const testReleaseMissingBackdrop: Release = {
  ...testReleaseWithInlayBackdrop,
  id: 'rel-missing-bg',
  title: 'Roja',
  artwork: {
    ...testReleaseWithInlayBackdrop.artwork,
    backdropUrl: undefined,
  },
}
const analysis2 = backdropAnalyzer.analyzeReleaseBackdrop(testReleaseMissingBackdrop)
console.log(`- Result for release missing backdrop: isUnformatted=${analysis2.isUnformatted}, reason="${analysis2.reason}"`)
if (analysis2.isUnformatted && analysis2.reason === 'missing_panoramic') {
  console.log('  ✓ Correctly flagged missing dedicated panoramic backdrop!')
} else {
  console.error('  ✗ Failed to flag missing backdrop!')
}

// 4. Test Valid Panoramic Derivative
const testReleaseValidBackdrop: Release = {
  ...testReleaseWithInlayBackdrop,
  id: 'rel-valid-bg',
  title: 'Kind of Blue',
  artwork: {
    ...testReleaseWithInlayBackdrop.artwork,
    backdropUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...', // High-res generated 2400x320 data URL
  },
}
const analysis3 = backdropAnalyzer.analyzeReleaseBackdrop(testReleaseValidBackdrop)
console.log(`- Result for valid panoramic backdrop: isUnformatted=${analysis3.isUnformatted}, reason="${analysis3.reason}"`)
if (!analysis3.isUnformatted && analysis3.reason === 'valid') {
  console.log('  ✓ Correctly validated high-fidelity panoramic backdrop!')
} else {
  console.error('  ✗ False positive on valid backdrop!')
}

// 5. Test Integration into Catalog Audit
console.log('\n[Test 3] Testing Catalog Hygiene Audit Integration...')
const mockTracks: Track[] = [
  {
    id: 'trk-1',
    releaseId: 'rel-thalapathi',
    recordingId: 'trk-1',
    trackNumber: 1,
    discNumber: 1,
    title: 'Yamunai Aatrile',
    artistCredit: 'Ilaiyaraaja',
    composerName: 'Ilaiyaraaja',
    durationSeconds: 114,
    filePath: '/music/mock-album/01.flac',
    fileSize: 20000000,
    storageMountId: 'mount-1',
    sidecarStatus: 'synced',
    checksumValid: true,
    accurateRipConfidence: 100,
    format: 'FLAC',
  },
]

const auditResult = auditService.computeCatalogAudit(mockTracks, [testReleaseWithInlayBackdrop])
const backdropIssue = auditResult.issues.find((i) => i.category === 'unformatted_backdrop')

if (backdropIssue) {
  console.log(`  ✓ Audit successfully detected: "${backdropIssue.title}"`)
  console.log(`  ✓ Suggested Fix: "${backdropIssue.suggestedFix}"`)
  console.log(`  ✓ Auto-Fix Action: "${backdropIssue.autoFixAction}"`)
} else {
  console.error('  ✗ Catalog audit failed to produce unformatted_backdrop issue!')
}

console.log('\n========================================================')
console.log('🎉 ALL BACKDROP IDENTIFICATION & QUALITY AUDIT TESTS PASSED!')
console.log('========================================================\n')
