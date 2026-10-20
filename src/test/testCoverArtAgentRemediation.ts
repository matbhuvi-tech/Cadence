import { graphEngine } from '../core/graphEngine'
import { auditService } from '../services/auditService'
import { agentActionDispatcher } from '../services/agentActionDispatcher'

async function runCoverArtReproductionTest() {
  console.log('=================================================================')
  console.log('🧪 [REPRODUCTION TEST] Agent Auto-Remediate Cover Art from Apple Music')
  console.log('=================================================================\n')

  // Setup: Load catalog containing an album with missing/low-res artwork (Dil Se..)
  graphEngine.loadDemoCatalog()
  auditService.runFullCatalogAudit()

  const targetRelease = graphEngine.getReleaseById('rel-rahman-dil-se')
  if (!targetRelease) {
    throw new Error('Test setup failed: rel-rahman-dil-se release not found in demo catalog')
  }

  console.log('Initial state of "Dil Se..":')
  console.log(`- Front Cover URL: ${targetRelease.artwork?.frontCoverUrl}`)
  console.log(`- Resolution: ${targetRelease.artwork?.resolution}`)
  console.log(`- isLowRes: ${targetRelease.artwork?.isLowRes}`)

  // Verify it is indeed low-res before remediation
  if (!targetRelease.artwork?.isLowRes) {
    throw new Error('Test setup failed: rel-dil-se should have isLowRes: true initially')
  }

  // 1. Test parseLocalIntent with the exact user prompt from the screenshot:
  const userPrompt = 'In the albums in virtual grid, where there is no cover art, get the art from Apple music and stage it'
  console.log(`\n[Test 1] Parsing local intent for prompt: "${userPrompt}"`)
  const parsedCommand = agentActionDispatcher.parseLocalIntent(userPrompt)
  console.log('Parsed Command:', parsedCommand)

  if (!parsedCommand) {
    throw new Error(`FAIL: parseLocalIntent returned null for prompt: "${userPrompt}"`)
  }
  if (parsedCommand.tool !== 'remediate_issue') {
    throw new Error(`FAIL: Expected tool 'remediate_issue', got '${parsedCommand.tool}'`)
  }
  if (parsedCommand.args.actionType !== 'FETCH_HIRES_ART') {
    throw new Error(`FAIL: Expected actionType 'FETCH_HIRES_ART', got '${parsedCommand.args.actionType}'`)
  }
  console.log('✓ Test 1 Passed: parseLocalIntent recognized prompt successfully.')

  // 2. Test auditService.remediateIssue('FETCH_HIRES_ART')
  console.log('\n[Test 2] Calling auditService.remediateIssue("FETCH_HIRES_ART")...')
  const remediateResult = await auditService.remediateIssue('FETCH_HIRES_ART', { provider: 'apple' })
  console.log('Remediate Result:', remediateResult)

  if (!remediateResult.success) {
    throw new Error(`FAIL: auditService.remediateIssue("FETCH_HIRES_ART") failed: ${remediateResult.message}`)
  }
  console.log('✓ Test 2 Passed: auditService.remediateIssue succeeded.')

  // 3. Test agentActionDispatcher.executeAction with FETCH_HIRES_ART and provider: 'apple'
  console.log('\n[Test 3] Executing action through agentActionDispatcher...')
  let refreshed = false
  let toastMsg = ''
  const mockContext = {
    setViewMode: () => {},
    setFacets: () => {},
    setSearchQuery: () => {},
    setSelectedTrackId: () => {},
    openModal: () => {},
    refreshFromEngine: () => {
      refreshed = true
    },
    showToast: (msg: string) => {
      toastMsg = msg
    },
  }

  const execResult = await agentActionDispatcher.executeAction(
    {
      tool: 'remediate_issue',
      args: { actionType: 'FETCH_HIRES_ART', provider: 'apple' },
      explanation: 'Triggering the automated fetch process to resolve missing/low-res cover art across the library.',
    },
    mockContext
  )
  console.log('Dispatcher Result:', execResult)

  if (!execResult.success) {
    throw new Error(`FAIL: agentActionDispatcher.executeAction failed: ${execResult.message}`)
  }

  // 4. Verify artwork resolution & staged sidecars
  console.log('\n[Test 4] Verifying staged cover art and sidecars...')
  const updatedRelease = graphEngine.getReleaseById('rel-rahman-dil-se')
  if (!updatedRelease) {
    throw new Error('Could not find updated release rel-rahman-dil-se')
  }

  console.log(`- Updated Front Cover URL: ${updatedRelease.artwork?.frontCoverUrl}`)
  console.log(`- Updated Resolution: ${updatedRelease.artwork?.resolution}`)
  console.log(`- Updated isLowRes: ${updatedRelease.artwork?.isLowRes}`)

  if (updatedRelease.artwork?.isLowRes) {
    throw new Error('FAIL: Release artwork is still marked isLowRes: true')
  }
  if (!updatedRelease.artwork?.frontCoverUrl?.includes('mzstatic.com') && !updatedRelease.artwork?.frontCoverUrl?.includes('3000x3000bb.jpg')) {
    throw new Error(`FAIL: Expected Apple Music master URL, got: "${updatedRelease.artwork?.frontCoverUrl}"`)
  }

  // Verify associated tracks have uncommitted sidecars
  const relTracks = graphEngine.getTracksByRelease('rel-rahman-dil-se')
  for (const trk of relTracks) {
    if (trk.sidecarStatus !== 'uncommitted_sidecar') {
      throw new Error(`FAIL: Track ${trk.id} sidecarStatus is '${trk.sidecarStatus}', expected 'uncommitted_sidecar'`)
    }
    if (!trk.pendingSidecarEdits?.coverArtUrl) {
      throw new Error(`FAIL: Track ${trk.id} missing pendingSidecarEdits.coverArtUrl`)
    }
  }

  console.log(`✓ Test 4 Passed: All ${relTracks.length} tracks have staged uncommitted sidecars with Apple Music art!`)
  console.log('\n🎉 ALL REPRODUCTION & TDD VERIFICATION CHECKS PASSED!')
}

runCoverArtReproductionTest().catch((err) => {
  console.error('\n❌ REPRODUCTION TEST FAILED AS EXPECTED:');
  console.error(err.message);
  process.exit(1);
})
