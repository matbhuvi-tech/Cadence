import { graphEngine } from '../core/graphEngine'
import { auditService } from '../services/auditService'
import { agentActionDispatcher, AgentActionCommand, AgentDispatcherContext } from '../services/agentActionDispatcher'
import { agentSnapshotService } from '../services/agentSnapshotService'
import { Track, Release } from '../core/types'

interface TestMetrics {
  total: number
  passed: number
  failed: number
  tierBreakdown: Record<string, { total: number; passed: number; failed: number }>
}

const metrics: TestMetrics = {
  total: 0,
  passed: 0,
  failed: 0,
  tierBreakdown: {},
}

function assert(condition: boolean, msg: string, tier = 'General') {
  metrics.total++
  if (!metrics.tierBreakdown[tier]) {
    metrics.tierBreakdown[tier] = { total: 0, passed: 0, failed: 0 }
  }
  metrics.tierBreakdown[tier].total++

  if (condition) {
    metrics.passed++
    metrics.tierBreakdown[tier].passed++
    console.log(`  ✓ [${tier}] ${msg}`)
  } else {
    metrics.failed++
    metrics.tierBreakdown[tier].failed++
    console.error(`  ❌ [${tier}] FAILED: ${msg}`)
    throw new Error(`[${tier}] Assertion Failed: ${msg}`)
  }
}

function createMockContext(stateTracker: {
  currentView?: string
  currentFacets?: any
  currentQuery?: string
  selectedTrackId?: string
  openedModal?: string
  modalPayload?: any
  refreshedCount?: number
  toasts?: string[]
}): AgentDispatcherContext {
  return {
    setViewMode: (mode) => {
      stateTracker.currentView = mode
    },
    setFacets: (facets) => {
      stateTracker.currentFacets = facets
    },
    setSearchQuery: (q) => {
      stateTracker.currentQuery = q
    },
    setSelectedTrackId: (id) => {
      stateTracker.selectedTrackId = id
    },
    openModal: (name, payload) => {
      stateTracker.openedModal = name
      stateTracker.modalPayload = payload
    },
    refreshFromEngine: () => {
      stateTracker.refreshedCount = (stateTracker.refreshedCount || 0) + 1
    },
    showToast: (msg) => {
      stateTracker.toasts = stateTracker.toasts || []
      stateTracker.toasts.push(msg)
    },
  }
}

async function runCopilotTestSuite() {
  console.log('================================================================================')
  console.log('🧪 CADENCE COPILOT (AI PILOT) COMPREHENSIVE AUTOMATED TEST MATRIX')
  console.log('================================================================================\n')

  // Setup: Reset & Load Demo Catalog
  graphEngine.loadDemoCatalog()
  auditService.runFullCatalogAudit()

  const allTracks = graphEngine.getAllTracks()
  const allReleases = graphEngine.getAllReleases()
  console.log(`Initialized Test Environment: ${allTracks.length} tracks across ${allReleases.length} releases loaded.\n`)

  // ============================================================================
  // TIER 1: ATOMIC TOOL EXECUTION
  // ============================================================================
  console.log('--- TIER 1: Atomic Tool Execution ---')
  const t1State: any = {}
  const t1Ctx = createMockContext(t1State)

  // 1.1 filter_catalog (Mastering: high_res_24bit)
  const filterHiRes = await agentActionDispatcher.executeAction(
    { tool: 'filter_catalog', args: { mastering: 'high_res_24bit' } },
    t1Ctx
  )
  assert(filterHiRes.success, 'filter_catalog (high_res_24bit) executed successfully', 'Tier 1: Atomic Tools')
  assert(t1State.currentFacets?.mastering === 'high_res_24bit', 'Facets updated with high_res_24bit', 'Tier 1: Atomic Tools')

  // 1.2 filter_catalog (Format & Composer)
  const filterFlac = await agentActionDispatcher.executeAction(
    { tool: 'filter_catalog', args: { format: 'FLAC', composer: 'Miles Davis', searchQuery: 'So What' } },
    t1Ctx
  )
  assert(filterFlac.success, 'filter_catalog (format: FLAC, composer: Miles Davis) executed', 'Tier 1: Atomic Tools')
  assert(t1State.currentFacets?.format === 'FLAC', 'Facets updated with FLAC', 'Tier 1: Atomic Tools')
  assert(t1State.currentQuery === 'So What', 'Search query updated with "So What"', 'Tier 1: Atomic Tools')

  // 1.3 reset_filters
  const resetFilters = await agentActionDispatcher.executeAction({ tool: 'reset_filters', args: {} }, t1Ctx)
  assert(resetFilters.success, 'reset_filters executed successfully', 'Tier 1: Atomic Tools')
  assert(Object.keys(t1State.currentFacets || {}).length === 0, 'Facets cleared', 'Tier 1: Atomic Tools')
  assert(t1State.currentQuery === '', 'Search query reset to empty string', 'Tier 1: Atomic Tools')

  // 1.4 switch_view (virtual_table, variant_stack, work_movement)
  for (const mode of ['virtual_table', 'variant_stack', 'work_movement'] as const) {
    const res = await agentActionDispatcher.executeAction({ tool: 'switch_view', args: { viewMode: mode } }, t1Ctx)
    assert(res.success && t1State.currentView === mode, `switch_view changed mode to "${mode}"`, 'Tier 1: Atomic Tools')
  }

  // 1.5 run_audit
  const auditRes = await agentActionDispatcher.executeAction({ tool: 'run_audit', args: {} }, t1Ctx)
  assert(auditRes.success, 'run_audit completed diagnostic scan', 'Tier 1: Atomic Tools')
  assert(Array.isArray(auditRes.data) && auditRes.data.length > 0, 'run_audit returned active audit categories', 'Tier 1: Atomic Tools')
  assert(t1State.refreshedCount > 0, 'run_audit triggered UI engine refresh', 'Tier 1: Atomic Tools')

  // 1.6 select_track
  const selectRes = await agentActionDispatcher.executeAction(
    { tool: 'select_track', args: { query: 'So What' } },
    t1Ctx
  )
  assert(selectRes.success, 'select_track found track matching "So What"', 'Tier 1: Atomic Tools')
  assert(t1State.selectedTrackId === 'trk-kob-01', 'select_track selected trk-kob-01', 'Tier 1: Atomic Tools')

  // 1.7 open_modal
  for (const modal of ['commit', 'import', 'path_rules', 'customize_album'] as const) {
    const res = await agentActionDispatcher.executeAction({ tool: 'open_modal', args: { modalName: modal } }, t1Ctx)
    assert(res.success && t1State.openedModal === modal, `open_modal opened "${modal}" modal`, 'Tier 1: Atomic Tools')
  }

  // 1.8 get_statistics
  const statsRes = await agentActionDispatcher.executeAction({ tool: 'get_statistics', args: {} }, t1Ctx)
  assert(statsRes.success, 'get_statistics executed successfully', 'Tier 1: Atomic Tools')
  assert(statsRes.data?.totalTracks > 0 && statsRes.data?.totalReleases > 0, 'get_statistics returned non-zero tracks & releases', 'Tier 1: Atomic Tools')

  // 1.9 resolve_work_hierarchy
  const workRes = await agentActionDispatcher.executeAction(
    { tool: 'resolve_work_hierarchy', args: { query: 'Dil Se' } },
    t1Ctx
  )
  assert(workRes.success, 'resolve_work_hierarchy executed successfully', 'Tier 1: Atomic Tools')

  // 1.10 compare_variant_pressings
  const variantRes = await agentActionDispatcher.executeAction(
    { tool: 'compare_variant_pressings', args: {} },
    t1Ctx
  )
  assert(variantRes.success, 'compare_variant_pressings executed successfully', 'Tier 1: Atomic Tools')
  assert(Boolean(variantRes.data?.bestVariant), 'compare_variant_pressings returned recommended variant', 'Tier 1: Atomic Tools')

  // 1.11 detect_transcode_anomalies
  const transcodeRes = await agentActionDispatcher.executeAction(
    { tool: 'detect_transcode_anomalies', args: {} },
    t1Ctx
  )
  assert(transcodeRes.success, 'detect_transcode_anomalies executed successfully', 'Tier 1: Atomic Tools')

  // 1.12 synthesize_normalization_rule
  const synthRes = await agentActionDispatcher.executeAction(
    {
      tool: 'synthesize_normalization_rule',
      args: { pattern: 'Illayaraja', canonical: 'Ilaiyaraaja', category: 'artist' },
    },
    t1Ctx
  )
  assert(synthRes.success, 'synthesize_normalization_rule executed successfully', 'Tier 1: Atomic Tools')

  // 1.13 preview_path_restructure
  const pathPrevRes = await agentActionDispatcher.executeAction(
    { tool: 'preview_path_restructure', args: { pattern: '{Composer}/{Year} - {Album}/{TrackNum} - {Title}' } },
    t1Ctx
  )
  assert(pathPrevRes.success, 'preview_path_restructure executed successfully', 'Tier 1: Atomic Tools')
  assert(Array.isArray(pathPrevRes.data?.previews) && pathPrevRes.data.previews.length > 0, 'preview_path_restructure returned previews', 'Tier 1: Atomic Tools')

  // 1.14 curate_sonic_session
  const curateRes = await agentActionDispatcher.executeAction(
    { tool: 'curate_sonic_session', args: { minDrScore: 12, durationMinutes: 30 } },
    t1Ctx
  )
  assert(curateRes.success, 'curate_sonic_session executed successfully', 'Tier 1: Atomic Tools')
  assert(curateRes.data?.sessionTracks?.length > 0, 'curate_sonic_session generated session tracks', 'Tier 1: Atomic Tools')

  // 1.15 query_graph
  const queryGraphRes = await agentActionDispatcher.executeAction(
    { tool: 'query_graph', args: { filter: { format: 'FLAC' }, limit: 5 } },
    t1Ctx
  )
  assert(queryGraphRes.success, 'query_graph executed successfully', 'Tier 1: Atomic Tools')
  assert(queryGraphRes.data?.records?.length > 0, 'query_graph returned matched records', 'Tier 1: Atomic Tools')
  console.log('')

  // ============================================================================
  // TIER 2: SINGLE REMEDIATION ACTIONS
  // ============================================================================
  console.log('--- TIER 2: Single Remediation Actions ---')
  const t2State: any = {}
  const t2Ctx = createMockContext(t2State)

  // Reload catalog to guarantee pristine baseline
  graphEngine.loadDemoCatalog()

  // 2.1 FETCH_HIRES_ART (Apple Music)
  const dilSeRel = graphEngine.getReleaseById('rel-rahman-dil-se')!
  assert(dilSeRel.artwork?.isLowRes === true, 'Baseline rel-rahman-dil-se has isLowRes: true', 'Tier 2: Remediation')

  const fetchArtApple = await agentActionDispatcher.executeAction(
    {
      tool: 'remediate_issue',
      args: { actionType: 'FETCH_HIRES_ART', provider: 'apple' },
      explanation: 'Fetch high-resolution artwork from Apple Music',
    },
    t2Ctx
  )
  assert(fetchArtApple.success, 'FETCH_HIRES_ART (provider: apple) succeeded', 'Tier 2: Remediation')

  const updatedDilSe = graphEngine.getReleaseById('rel-rahman-dil-se')!
  assert(updatedDilSe.artwork?.isLowRes === false, 'Dil Se artwork is no longer low-res', 'Tier 2: Remediation')
  assert(updatedDilSe.artwork?.frontCoverUrl?.includes('3000x3000bb.jpg') === true, 'Apple Music 3000x3000px artwork staged', 'Tier 2: Remediation')

  // Check track sidecars
  const dilSeTracks = graphEngine.getTracksByRelease('rel-rahman-dil-se')
  assert(
    dilSeTracks.every((t) => t.sidecarStatus === 'uncommitted_sidecar' && t.pendingSidecarEdits?.coverArtUrl),
    'All tracks staged with pendingSidecarEdits.coverArtUrl',
    'Tier 2: Remediation'
  )

  // 2.2 REWORK_BACKDROP
  delete (updatedDilSe.artwork as any).backdropUrl
  delete (updatedDilSe as any).backdropUrl
  graphEngine.addOrUpdateRelease(updatedDilSe)

  const reworkBackdrop = await agentActionDispatcher.executeAction(
    {
      tool: 'rework_backdrop',
      args: { composer: 'A. R. Rahman', provider: 'apple' },
      explanation: 'Rework album backdrops in Virtual Grid',
    },
    t2Ctx
  )
  assert(reworkBackdrop.success, 'rework_backdrop tool executed successfully', 'Tier 2: Remediation')

  const dilSeWithBackdrop = graphEngine.getReleaseById('rel-rahman-dil-se')!
  assert(Boolean(dilSeWithBackdrop.artwork?.backdropUrl || dilSeWithBackdrop.backdropUrl), 'Release has backdropUrl set', 'Tier 2: Remediation')
  assert(
    graphEngine.getTracksByRelease('rel-rahman-dil-se').every((t) => t.pendingSidecarEdits?.backdropUrl),
    'All tracks staged with pendingSidecarEdits.backdropUrl',
    'Tier 2: Remediation'
  )

  // 2.3 RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER
  // Add a synthetic unknown track with folder hierarchy
  const unknownTrack: Track = {
    id: 'trk-unknown-folder-test',
    releaseId: 'rel-synthetic-01',
    trackNumber: 1,
    title: 'Unknown Track 1',
    artistCredit: 'Unknown Artist',
    composerName: '',
    durationSeconds: 200,
    format: 'FLAC',
    bitDepth: 24,
    sampleRate: 96000,
    bitrateKbps: 2400,
    drScore: 14,
    sidecarStatus: 'none',
    credits: [],
    filePath: '/Lossless/Illayaraja/Thalapathi/01 - Rakkamma.flac',
    folderName: 'Thalapathi',
  }
  graphEngine.addOrUpdateTrack(unknownTrack)

  const resolveArtistRes = await auditService.remediateIssue('RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER')
  assert(resolveArtistRes.success, 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER succeeded', 'Tier 2: Remediation')
  const resolvedTrack = graphEngine.getTrackById('trk-unknown-folder-test')!
  assert(resolvedTrack.artistCredit === 'Ilaiyaraaja', `Extracted canonical artist "Ilaiyaraaja" (got: "${resolvedTrack.artistCredit}")`, 'Tier 2: Remediation')
  assert(resolvedTrack.sidecarStatus === 'uncommitted_sidecar', 'Track marked uncommitted_sidecar', 'Tier 2: Remediation')

  // 2.4 NORMALIZE_GENRES
  const messyRel: Release = {
    id: 'rel-genre-test',
    title: 'Genre Test Album',
    artistCredit: 'Various Artists',
    releaseYear: 2020,
    mediaType: 'CD',
    genreTags: ['Tamil Film', 'Tamil Film Music'],
    trackIds: [],
    variants: [],
    dynamicRangeScore: 12,
    hasSidecar: false,
  }
  graphEngine.addOrUpdateRelease(messyRel)
  const normGenreRes = await auditService.remediateIssue('NORMALIZE_GENRES')
  assert(normGenreRes.success, 'NORMALIZE_GENRES succeeded', 'Tier 2: Remediation')
  const updatedGenreRel = graphEngine.getReleaseById('rel-genre-test')!
  assert(
    updatedGenreRel.genreTags.includes('Tamil Film Music & Soundtrack') && updatedGenreRel.genreTags.length === 1,
    'Fragmented genres merged to canonical "Tamil Film Music & Soundtrack"',
    'Tier 2: Remediation'
  )

  // 2.5 Safety Rejection of Non-Autofixable Anomaly (Bit-Rot)
  const bitRotRem = await auditService.remediateIssue('audit-02')
  assert(bitRotRem.success === false, 'auditService correctly rejected 1-click auto-fix on CRC bit-rot defect', 'Tier 2: Remediation')
  console.log('')

  // ============================================================================
  // TIER 3: COMPOUND WORKFLOWS & MULTI-STEP PIPELINES
  // ============================================================================
  console.log('--- TIER 3: Compound & Multi-Step Pipelines ---')
  const t3State: any = {}
  const t3Ctx = createMockContext(t3State)

  // Reload catalog
  graphEngine.loadDemoCatalog()

  // 3.1 Compound Sequence 1: Fetch Art (Apple) + Rework Backdrop (Two-Step Visual Fix)
  // This was the exact bug reported where compound requests only did step 1 or failed!
  console.log('  [Executing Compound Sequence 1: FETCH_HIRES_ART + REWORK_BACKDROP]')
  const seq1Commands: AgentActionCommand[] = [
    {
      tool: 'remediate_issue',
      args: { actionType: 'FETCH_HIRES_ART', provider: 'apple' },
      explanation: 'Step 1: Fetch high-resolution artwork from Apple Music',
    },
    {
      tool: 'rework_backdrop',
      args: { composer: 'A. R. Rahman', provider: 'apple' },
      explanation: 'Step 2: Generate and apply cinematic panoramic backdrop',
    },
  ]

  const pipelineRes1 = await agentActionDispatcher.executePipeline(seq1Commands, t3Ctx)
  assert(pipelineRes1.success, 'executePipeline completed sequence 1 successfully', 'Tier 3: Compound Pipelines')
  assert(pipelineRes1.completedSteps === 2, 'All 2 pipeline steps completed', 'Tier 3: Compound Pipelines')
  assert(pipelineRes1.stepResults[0].tool === 'remediate_issue', 'Step 1 tool is remediate_issue', 'Tier 3: Compound Pipelines')
  assert(pipelineRes1.stepResults[1].tool === 'rework_backdrop', 'Step 2 tool is rework_backdrop', 'Tier 3: Compound Pipelines')

  const verifyDilSe = graphEngine.getReleaseById('rel-rahman-dil-se')!
  assert(verifyDilSe.artwork?.isLowRes === false, 'Dil Se cover art is high-res after pipeline', 'Tier 3: Compound Pipelines')
  assert(Boolean(verifyDilSe.artwork?.backdropUrl || verifyDilSe.backdropUrl), 'Dil Se backdropUrl is set after pipeline', 'Tier 3: Compound Pipelines')
  const verifyDilSeTracks = graphEngine.getTracksByRelease('rel-rahman-dil-se')
  assert(
    verifyDilSeTracks.every(
      (t) => t.pendingSidecarEdits?.coverArtUrl && t.pendingSidecarEdits?.backdropUrl
    ),
    'All tracks staged with BOTH coverArtUrl and backdropUrl sidecar edits',
    'Tier 3: Compound Pipelines'
  )

  // 3.2 Compound Sequence 2: Audit Catalog + Auto-Tag Unknown Artists + Open Commit Modal
  console.log('  [Executing Compound Sequence 2: run_audit + RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER + open_modal(commit)]')
  // Add track with unknown artist and clear folder hierarchy for auto-resolution
  graphEngine.addOrUpdateTrack({
    id: 'trk-seq2-unknown',
    releaseId: 'rel-rahman-dil-se',
    trackNumber: 99,
    title: 'Unknown Pipeline Track',
    artistCredit: 'Unknown Artist',
    composerName: '',
    durationSeconds: 210,
    format: 'FLAC',
    bitDepth: 24,
    sampleRate: 96000,
    bitrateKbps: 2400,
    drScore: 13,
    sidecarStatus: 'none',
    credits: [],
    filePath: '/Lossless/A. R. Rahman/Dil Se/99 - Bonus.flac',
    folderName: 'Dil Se',
  })

  const seq2Commands: AgentActionCommand[] = [
    { tool: 'run_audit', args: {}, explanation: 'Step 1: Diagnostic scan' },
    {
      tool: 'remediate_issue',
      args: { actionType: 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER' },
      explanation: 'Step 2: Auto-resolve artists from folders',
    },
    { tool: 'open_modal', args: { modalName: 'commit' }, explanation: 'Step 3: Review and stage commit' },
  ]

  const pipelineRes2 = await agentActionDispatcher.executePipeline(seq2Commands, t3Ctx)
  assert(pipelineRes2.success, 'executePipeline completed sequence 2 successfully', 'Tier 3: Compound Pipelines')
  assert(pipelineRes2.completedSteps === 3, 'All 3 pipeline steps completed', 'Tier 3: Compound Pipelines')
  assert(t3State.openedModal === 'commit', 'Commit modal was opened at the conclusion of sequence 2', 'Tier 3: Compound Pipelines')

  // 3.3 Compound Sequence 3: Filter FLAC + Switch View to Variant Stacks
  console.log('  [Executing Compound Sequence 3: filter_catalog + switch_view]')
  const seq3Commands: AgentActionCommand[] = [
    { tool: 'filter_catalog', args: { format: 'FLAC' }, explanation: 'Step 1: Filter to FLAC' },
    { tool: 'switch_view', args: { viewMode: 'variant_stack' }, explanation: 'Step 2: Switch to variant stack' },
  ]
  const pipelineRes3 = await agentActionDispatcher.executePipeline(seq3Commands, t3Ctx)
  assert(pipelineRes3.success, 'executePipeline completed sequence 3 successfully', 'Tier 3: Compound Pipelines')
  assert(t3State.currentFacets?.format === 'FLAC', 'Facets filter FLAC active', 'Tier 3: Compound Pipelines')
  assert(t3State.currentView === 'variant_stack', 'View switched to variant_stack', 'Tier 3: Compound Pipelines')

  // 3.4 Compound Dispatch via executeAction tool: 'execute_pipeline'
  console.log('  [Executing executeAction with tool "execute_pipeline"]')
  const execToolPipeline = await agentActionDispatcher.executeAction(
    {
      tool: 'execute_pipeline',
      args: {
        commands: [
          { tool: 'reset_filters', args: {} },
          { tool: 'switch_view', args: { viewMode: 'virtual_table' } },
        ],
      },
      explanation: 'Reset filters and switch view',
    },
    t3Ctx
  )
  assert(execToolPipeline.success, 'agentActionDispatcher.executeAction("execute_pipeline") succeeded', 'Tier 3: Compound Pipelines')
  assert(t3State.currentView === 'virtual_table', 'View reset to virtual_table', 'Tier 3: Compound Pipelines')

  // 3.5 Compound Staging via stage_metadata with BOTH cover art AND backdrop
  console.log('  [Executing stage_metadata with both coverArtUrl and backdropUrl]')
  const stageMetaCompound = await agentActionDispatcher.executeAction(
    {
      tool: 'stage_metadata',
      args: {
        coverArtUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/cover.jpg/3000x3000bb.jpg',
        backdropUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/cover.jpg/3000x3000bb.jpg',
        provider: 'apple',
      },
    },
    t3Ctx
  )
  assert(stageMetaCompound.success, 'stage_metadata compound execution succeeded', 'Tier 3: Compound Pipelines')
  console.log('')

  // ============================================================================
  // TIER 4: LOCAL INTENT PARSING & AUDIOPHILE VOCABULARY MATRIX
  // ============================================================================
  console.log('--- TIER 4: Local Intent Parsing & Audiophile Vocabulary Matrix ---')

  // 4.1 Compound User Prompts
  const compoundTestCases = [
    {
      prompt: 'In the albums in virtual grid, where there is no cover art, get the art from Apple music and rework the backdrops',
      expectedTools: ['remediate_issue', 'rework_backdrop'],
      expectedProvider: 'apple',
    },
    {
      prompt: 'Fetch cover art from Apple Music and rework backdrops for A. R. Rahman',
      expectedTools: ['remediate_issue', 'rework_backdrop'],
      expectedProvider: 'apple',
      expectedComposer: 'A. R. Rahman',
    },
    {
      prompt: 'Run audit scan and auto-resolve unknown artists from folder, then open commit modal',
      expectedTools: ['run_audit', 'remediate_issue', 'open_modal'],
    },
    {
      prompt: 'Filter to FLAC format and switch to variant stacks',
      expectedTools: ['filter_catalog', 'switch_view'],
    },
    {
      prompt: 'Filter to 24-bit and switch to virtual grid view',
      expectedTools: ['filter_catalog', 'switch_view'],
    },
    {
      prompt: 'Reset filters and show library stats',
      expectedTools: ['reset_filters', 'get_statistics'],
    },
  ]

  for (const tc of compoundTestCases) {
    const compoundCmds = agentActionDispatcher.parseCompoundLocalIntent(tc.prompt)
    assert(
      compoundCmds.length === tc.expectedTools.length,
      `Prompt "${tc.prompt.slice(0, 50)}..." parsed ${compoundCmds.length}/${tc.expectedTools.length} tools`,
      'Tier 4: Compound Vocabulary'
    )
    for (let i = 0; i < tc.expectedTools.length; i++) {
      assert(
        compoundCmds[i]?.tool === tc.expectedTools[i],
        `Tool [${i}] matched "${tc.expectedTools[i]}" (got: "${compoundCmds[i]?.tool}")`,
        'Tier 4: Compound Vocabulary'
      )
    }
    if (tc.expectedProvider) {
      assert(
        compoundCmds[0]?.args.provider === tc.expectedProvider,
        `Shared provider "${tc.expectedProvider}" propagated to args`,
        'Tier 4: Compound Vocabulary'
      )
    }

    // Also verify parseLocalIntent wraps it in execute_pipeline
    const wrapped = agentActionDispatcher.parseLocalIntent(tc.prompt)
    assert(
      wrapped?.tool === 'execute_pipeline',
      `parseLocalIntent wrapped compound prompt in "execute_pipeline"`,
      'Tier 4: Compound Vocabulary'
    )
    assert(
      wrapped?.args.commands?.length === tc.expectedTools.length,
      `Wrapped commands array contains ${tc.expectedTools.length} operations`,
      'Tier 4: Compound Vocabulary'
    )
  }

  // 4.2 Atomic User Prompts across Audiophile Vocabulary
  const atomicVocabCases = [
    { prompt: 'Show me library stats', expectedTool: 'get_statistics' },
    { prompt: 'What is my collection size and summary breakdown?', expectedTool: 'get_statistics' },
    { prompt: 'Run hygiene check scan on library', expectedTool: 'run_audit' },
    { prompt: 'Check health of audio files', expectedTool: 'run_audit' },
    { prompt: 'Filter to 24-bit high resolution masters', expectedTool: 'filter_catalog' },
    { prompt: 'Filter dsd audiophile tracks', expectedTool: 'filter_catalog' },
    { prompt: 'Show FLAC lossless tracks', expectedTool: 'filter_catalog' },
    { prompt: 'Show Tamil Kollywood music', expectedTool: 'filter_catalog' },
    { prompt: 'Filter Bollywood Hindi releases', expectedTool: 'filter_catalog' },
    { prompt: 'Clear all active filters', expectedTool: 'reset_filters' },
    { prompt: 'Show all tracks in catalog', expectedTool: 'reset_filters' },
    { prompt: 'Switch to virtual grid spreadsheet', expectedTool: 'switch_view' },
    { prompt: 'Show master pressing and variant stacks', expectedTool: 'switch_view' },
    { prompt: 'Switch to classical movements view', expectedTool: 'switch_view' },
    { prompt: 'Auto tag tracks from folder hierarchy', expectedTool: 'remediate_issue' },
    { prompt: 'Normalize and clean up genres across albums', expectedTool: 'remediate_issue' },
    { prompt: 'Merge and deduplicate performer authorities', expectedTool: 'remediate_issue' },
    { prompt: 'Disentangle boxset conflict and sync album names', expectedTool: 'remediate_issue' },
    { prompt: 'Open two-phase commit modal to stage sidecars', expectedTool: 'open_modal' },
    { prompt: 'Import music from new directory', expectedTool: 'open_modal' },
    { prompt: 'Configure path restructuring rules', expectedTool: 'open_modal' },
    { prompt: 'Disentangle work hierarchy and playback credits', expectedTool: 'resolve_work_hierarchy' },
    { prompt: 'Compare variant pressings and find best master', expectedTool: 'compare_variant_pressings' },
    { prompt: 'Detect transcode anomalies and fake flac cutoffs', expectedTool: 'detect_transcode_anomalies' },
    { prompt: 'Synthesize authority rule whenever you see variant canonicalize target', expectedTool: 'synthesize_normalization_rule' },
    { prompt: 'Preview path restructuring dry run', expectedTool: 'preview_path_restructure' },
    { prompt: 'Curate sonic session for listening DR 14', expectedTool: 'curate_sonic_session' },
    { prompt: 'Search graph for tracks', expectedTool: 'query_graph' },
  ]

  for (const tc of atomicVocabCases) {
    const parsed = agentActionDispatcher.parseLocalIntent(tc.prompt)
    assert(
      parsed?.tool === tc.expectedTool,
      `Vocabulary prompt "${tc.prompt.slice(0, 45)}..." matched "${tc.expectedTool}" (got: "${parsed?.tool}")`,
      'Tier 4: Atomic Vocabulary'
    )
  }
  console.log('')

  // ============================================================================
  // TIER 5: ERROR HANDLING, BOUNDARY CONDITIONS & RESILIENCE
  // ============================================================================
  console.log('--- TIER 5: Error Handling & Boundary Conditions ---')
  const t5State: any = {}
  const t5Ctx = createMockContext(t5State)

  // 5.1 Unknown tool directive
  const unknownToolRes = await agentActionDispatcher.executeAction(
    { tool: 'unknown_hallucinated_tool' as any, args: {} },
    t5Ctx
  )
  assert(unknownToolRes.success === false, 'Unknown tool directive rejected gracefully', 'Tier 5: Error Handling')
  assert(unknownToolRes.message.includes('Unknown tool directive'), 'Helpful error message returned', 'Tier 5: Error Handling')

  // 5.2 Invalid view mode
  const invalidViewRes = await agentActionDispatcher.executeAction(
    { tool: 'switch_view', args: { viewMode: 'invalid_3d_mode' as any } },
    t5Ctx
  )
  assert(invalidViewRes.success === false, 'Invalid view mode rejected', 'Tier 5: Error Handling')

  // 5.3 Non-existent track search
  const missingTrackRes = await agentActionDispatcher.executeAction(
    { tool: 'select_track', args: { query: 'Non-Existent Symphony 999' } },
    t5Ctx
  )
  assert(missingTrackRes.success === false, 'Non-existent track selection rejected gracefully', 'Tier 5: Error Handling')

  // 5.4 Empty pipeline commands array
  const emptyPipeRes = await agentActionDispatcher.executeAction(
    { tool: 'execute_pipeline', args: { commands: [] } },
    t5Ctx
  )
  assert(emptyPipeRes.success === false, 'Empty pipeline rejected', 'Tier 5: Error Handling')

  // 5.5 Partial failure in pipeline with stopOnError: true
  const failPipeRes = await agentActionDispatcher.executePipeline(
    [
      { tool: 'switch_view', args: { viewMode: 'virtual_table' } },
      { tool: 'switch_view', args: { viewMode: 'broken_mode_invalid' as any } },
      { tool: 'reset_filters', args: {} }, // Should not be reached
    ],
    t5Ctx,
    true
  )
  assert(failPipeRes.success === false, 'Pipeline with invalid step halted', 'Tier 5: Error Handling')
  assert(failPipeRes.completedSteps === 1, 'Only step 1 was marked successful', 'Tier 5: Error Handling')
  assert(failPipeRes.totalSteps === 3, 'Total steps recorded accurately', 'Tier 5: Error Handling')
  assert(failPipeRes.stepResults.length === 2, 'Execution stopped at step 2 without executing step 3', 'Tier 5: Error Handling')

  // 5.6 Unrecognized natural language query in parseLocalIntent
  const unrecognized = agentActionDispatcher.parseLocalIntent('What is the weather like in Seattle?')
  assert(unrecognized === null, 'Completely unhandled query returns null without throwing', 'Tier 5: Error Handling')
  console.log('')

  // ============================================================================
  // TIER 6: GEMINI SCHEMA & WIRE CONTRACT VALIDATION
  // ============================================================================
  console.log('--- TIER 6: Gemini Schema & Wire Contract Validation ---')
  const t6State: any = {}
  const t6Ctx = createMockContext(t6State)

  // 6.1 Valid simulated Gemini response for atomic action
  const simulatedGeminiAtomic = {
    response: 'I will filter your collection to 24-bit audiophile releases.',
    command: {
      tool: 'filter_catalog',
      args: { mastering: 'high_res_24bit' },
      explanation: 'Filter catalog to 24-bit tracks',
    },
    suggestedActions: [{ label: 'Show stats', prompt: 'Show library statistics' }],
  }

  const atomicWireRes = await agentActionDispatcher.executeAction(simulatedGeminiAtomic.command as any, t6Ctx)
  assert(atomicWireRes.success, 'Simulated Gemini atomic tool call executed successfully', 'Tier 6: Schema Wire Contract')

  // 6.2 Valid simulated Gemini response for compound pipeline
  const simulatedGeminiCompound = {
    response: 'I will fetch the missing cover art from Apple Music and rework the album backdrops.',
    command: {
      tool: 'execute_pipeline',
      args: {
        commands: [
          { tool: 'remediate_issue', args: { actionType: 'FETCH_HIRES_ART', provider: 'apple' } },
          { tool: 'rework_backdrop', args: { provider: 'apple' } },
        ],
      },
      explanation: 'Fetch art and rework backdrops',
    },
    suggestedActions: [{ label: 'Review staged changes', prompt: 'Open commit modal' }],
  }

  const compoundWireRes = await agentActionDispatcher.executeAction(simulatedGeminiCompound.command as any, t6Ctx)
  assert(compoundWireRes.success, 'Simulated Gemini execute_pipeline tool call executed successfully', 'Tier 6: Schema Wire Contract')
  console.log('')

  // ============================================================================
  // FINAL TEST METRICS SUMMARY
  // ============================================================================
  console.log('================================================================================')
  console.log('📊 CADENCE COPILOT TEST MATRIX EXECUTION SUMMARY')
  console.log('================================================================================')
  console.log(`Total Assertions Executed: ${metrics.total}`)
  console.log(`Passed:                   ${metrics.passed} (100.0%)`)
  console.log(`Failed:                   ${metrics.failed}`)
  console.log('\nBreakdown by Tier:')
  Object.entries(metrics.tierBreakdown).forEach(([tier, data]) => {
    const rate = ((data.passed / data.total) * 100).toFixed(1)
    console.log(`- ${tier.padEnd(30)}: ${data.passed}/${data.total} passed (${rate}%)`)
  })
  console.log('================================================================================')
  console.log('🎉 ALL AI PILOT & CADENCE COPILOT TESTS PASSED WITH ZERO REGRESSIONS!')
  console.log('================================================================================')
}

runCopilotTestSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED WITH UNEXPECTED EXCEPTION:')
  console.error(err)
  process.exit(1)
})
