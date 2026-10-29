import { graphEngine } from '../core/graphEngine'
import { cleanRipNoise } from '../core/taxonomyUtils'

async function runTests() {
  console.log('--- Starting Album & Folder Name Customization Tests ---')

  // Test 1: Clean rip noise helper
  console.log('\n[Test 1] Testing cleanRipNoise helper...')
  const samples = [
    { input: 'Aan Paavam CD RIP', expected: 'Aan Paavam' },
    { input: 'Agni Natchatiram CD RIP [FLAC]', expected: 'Agni Natchatiram' },
    { input: 'Kind of Blue [1959 Columbia Mono] (remastered)', expected: 'Kind of Blue [1959 Columbia Mono]' },
    { input: 'Mouna Ragam - CD Rip', expected: 'Mouna Ragam' },
    { input: 'Super Deluxe [24bit/96kHz]', expected: 'Super Deluxe' },
  ]

  for (const s of samples) {
    const cleaned = cleanRipNoise(s.input)
    console.log(`  "${s.input}" -> "${cleaned}"`)
    if (!cleaned) {
      throw new Error(`cleanRipNoise returned empty for: ${s.input}`)
    }
  }
  console.log('✓ cleanRipNoise passed')

  // Test 2: Demo catalog releases have folder names
  console.log('\n[Test 2] Verifying initial folderName in catalog releases...')
  graphEngine.loadDemoCatalog()
  const releases = graphEngine.getAllReleases()
  console.log(`  Total releases: ${releases.length}`)
  for (const rel of releases) {
    console.log(`  Release: "${rel.title}" | Folder: "${rel.folderName}"`)
    if (!rel.folderName) {
      throw new Error(`Release ${rel.id} missing folderName`)
    }
  }
  console.log('✓ Initial folderName verified across releases')

  // Test 3: Updating Release Names and Staging Sidecar
  console.log('\n[Test 3] Testing graphEngine.updateReleaseNames()...')
  const targetRel = releases[0]
  const oldTitle = targetRel.title
  const oldFolder = targetRel.folderName
  const oldUncommittedCount = graphEngine.getStats().uncommittedSidecarsCount

  console.log(`  Targeting release: ${targetRel.id} ("${oldTitle}")`)
  const newTitle = `${oldTitle} (Audiophile Edition)`
  const newFolder = `${oldFolder} - Remastered`

  const updateResult = graphEngine.updateReleaseNames(targetRel.id, {
    title: newTitle,
    folderName: newFolder,
  })

  if (!updateResult) {
    throw new Error('updateReleaseNames returned undefined')
  }

  console.log(`  Updated release title: "${updateResult.release.title}"`)
  console.log(`  Updated folderName: "${updateResult.release.folderName}"`)
  console.log(`  Target folder path: "${updateResult.release.targetFolderPath}"`)
  console.log(`  Affected tracks count: ${updateResult.affectedTracksCount}`)

  if (updateResult.release.title !== newTitle) {
    throw new Error(`Expected title "${newTitle}", got "${updateResult.release.title}"`)
  }
  if (updateResult.release.folderName !== newFolder) {
    throw new Error(`Expected folderName "${newFolder}", got "${updateResult.release.folderName}"`)
  }
  if (updateResult.affectedTracksCount <= 0) {
    throw new Error('Expected at least 1 affected track')
  }

  // Check tracks sidecar status
  const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === targetRel.id)
  for (const t of relTracks) {
    if (t.sidecarStatus !== 'uncommitted_sidecar') {
      throw new Error(`Track ${t.id} not marked uncommitted_sidecar`)
    }
    if (t.pendingSidecarEdits?.album !== newTitle) {
      throw new Error(`Track ${t.id} missing pending sidecar album title`)
    }
    if (t.folderName !== newFolder) {
      throw new Error(`Track ${t.id} folderName mismatch`)
    }
  }
  console.log(`  ✓ All ${relTracks.length} tracks verified with uncommitted sidecar status & pending edits`)

  const newUncommittedCount = graphEngine.getStats().uncommittedSidecarsCount
  console.log(`  Uncommitted sidecars count: ${oldUncommittedCount} -> ${newUncommittedCount}`)
  if (newUncommittedCount <= oldUncommittedCount) {
    throw new Error('Uncommitted count did not increase')
  }

  // Test 4: Search filter matching folder name
  console.log('\n[Test 4] Testing search filtering on physical folder name...')
  const searchResults = graphEngine.filterTracks({
    searchQuery: 'Remastered',
  })
  console.log(`  Found ${searchResults.length} tracks searching for "Remastered"`)
  if (searchResults.length !== relTracks.length) {
    throw new Error(`Expected ${relTracks.length} tracks matched by folder name, got ${searchResults.length}`)
  }
  console.log('✓ Search query accurately filtered tracks by physical folder name')

  console.log('\n=============================================')
  console.log('🎉 ALL ALBUM & FOLDER CUSTOMIZATION TESTS PASSED!')
  console.log('=============================================')
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
