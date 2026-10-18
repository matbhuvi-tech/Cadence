import { graphEngine } from '../core/graphEngine'
import { auditService } from '../services/auditService'
import { agentActionDispatcher } from '../services/agentActionDispatcher'

async function runReworkBackdropReproductionTest() {
  console.log('=================================================================')
  console.log('🧪 [REPRODUCTION TEST] Agent Rework Backdrop in Virtual Grid')
  console.log('=================================================================\n')

  // Setup: Load catalog containing an album with missing backdrop
  graphEngine.loadDemoCatalog()
  auditService.runFullCatalogAudit()

  const targetRelease = graphEngine.getReleaseById('rel-rahman-dil-se')
  if (!targetRelease) {
    throw new Error('Test setup failed: rel-rahman-dil-se release not found in demo catalog')
  }

  // Ensure initial state has no backdrop
  if (targetRelease.artwork) {
    delete (targetRelease.artwork as any).backdropUrl
  }
  delete (targetRelease as any).backdropUrl
  graphEngine.addOrUpdateRelease(targetRelease)

  console.log('Initial state of "Dil Se..":')
  console.log(`- Front Cover URL: ${targetRelease.artwork?.frontCoverUrl}`)
  console.log(`- Artwork Backdrop URL: ${targetRelease.artwork?.backdropUrl || '(none)'}`)
  console.log(`- Release Backdrop URL: ${targetRelease.backdropUrl || '(none)'}`)

  // 1. Test parseLocalIntent with user prompt for reworking backdrop:
  const userPrompt = 'Rework backdrop to map retrieved artwork as album backdrops for A. R. Rahman collection'
  console.log(`\n[Test 1] Parsing local intent for prompt: "${userPrompt}"`)
  const parsedCommand = agentActionDispatcher.parseLocalIntent(userPrompt)
  console.log('Parsed Command:', parsedCommand)

  if (!parsedCommand) {
    throw new Error(`FAIL: parseLocalIntent returned null for prompt: "${userPrompt}"`)
  }
  if (parsedCommand.tool !== 'rework_backdrop' && parsedCommand.tool !== 'remediate_issue') {
    throw new Error(`FAIL: Expected tool 'rework_backdrop' or 'remediate_issue', got '${parsedCommand.tool}'`)
  }
  console.log('✓ Test 1 Passed: parseLocalIntent recognized backdrop rework prompt.')

  // 2. Test executeAction with rework_backdrop tool directive
  console.log('\n[Test 2] Executing rework_backdrop via agentActionDispatcher...')
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
      tool: 'rework_backdrop',
      args: { composer: 'A. R. Rahman' },
      explanation: 'Initiating high-resolution cover art retrieval and applying it as the album backdrop to resolve the visual deficiency in the Virtual Grid.',
    },
    mockContext
  )
  console.log('Dispatcher Result:', execResult)

  if (!execResult.success) {
    throw new Error(`FAIL: agentActionDispatcher.executeAction failed: ${execResult.message}`)
  }
  console.log('✓ Test 2 Passed: agentActionDispatcher.executeAction succeeded.')

  // 3. Test auditService.remediateIssue('REWORK_BACKDROP')
  console.log('\n[Test 3] Calling auditService.remediateIssue("REWORK_BACKDROP")...')
  const remediateResult = await auditService.remediateIssue('REWORK_BACKDROP', { composer: 'A. R. Rahman' })
  console.log('Remediate Result:', remediateResult)

  if (!remediateResult.success) {
    throw new Error(`FAIL: auditService.remediateIssue("REWORK_BACKDROP") failed: ${remediateResult.message}`)
  }
  console.log('✓ Test 3 Passed: auditService.remediateIssue("REWORK_BACKDROP") succeeded.')

  // 4. Verify that backdropUrl is set on release and staged on tracks
  console.log('\n[Test 4] Verifying applied backdrop on release and staged sidecars...')
  const updatedRelease = graphEngine.getReleaseById('rel-rahman-dil-se')
  if (!updatedRelease) {
    throw new Error('Could not find updated release rel-rahman-dil-se')
  }

  const effectiveBackdrop = updatedRelease.artwork?.backdropUrl || updatedRelease.backdropUrl
  console.log(`- Updated Artwork Backdrop URL: ${updatedRelease.artwork?.backdropUrl}`)
  console.log(`- Updated Release Backdrop URL: ${updatedRelease.backdropUrl}`)

  if (!effectiveBackdrop) {
    throw new Error('FAIL: Release backdropUrl was not applied!')
  }

  const relTracks = graphEngine.getTracksByRelease('rel-rahman-dil-se')
  for (const trk of relTracks) {
    if (trk.sidecarStatus !== 'uncommitted_sidecar') {
      throw new Error(`FAIL: Track ${trk.id} sidecarStatus is '${trk.sidecarStatus}', expected 'uncommitted_sidecar'`)
    }
    if (!trk.pendingSidecarEdits?.backdropUrl) {
      throw new Error(`FAIL: Track ${trk.id} missing pendingSidecarEdits.backdropUrl`)
    }
  }

  console.log(`✓ Test 4 Passed: All ${relTracks.length} tracks have staged uncommitted sidecars with backdropUrl!`)
  console.log('\n🎉 ALL REWORK BACKDROP VERIFICATION CHECKS PASSED!')
}

runReworkBackdropReproductionTest().catch((err) => {
  console.error('\n❌ REPRODUCTION TEST FAILED AS EXPECTED:')
  console.error(err.message)
  process.exit(1)
})
