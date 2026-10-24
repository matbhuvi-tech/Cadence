import { graphEngine } from '../core/graphEngine'
import {
  parseFacetTokens,
  classifySearchIntent,
  deriveFormatBadge,
  CatalogAlbumMatch,
  CatalogTrackMatch,
  CatalogArtistMatch,
  SystemCommandItem,
} from '../core/searchIntentClassifier'

async function runOmnibarIntentTests() {
  console.log('=== Cadence Omnibar Intent Engine & Workstation Search Test Matrix ===\n')

  // Seed demo catalog in graphEngine for test assertions
  graphEngine.loadDemoCatalog()
  const allReleases = graphEngine.getAllReleases()
  const allTracks = graphEngine.getAllTracks()
  const allPersons = graphEngine.getAllPersons()

  console.log(`[Setup] Loaded catalog: ${allReleases.length} releases, ${allTracks.length} tracks, ${allPersons.length} persons.`)

  const mockCommands: SystemCommandItem[] = [
    { id: 'cmd-twophase', title: 'Review Staged Metadata & Write to Disk', category: 'SAFETY', icon: null, action: () => {} },
    { id: 'cmd-toggle-mount', title: 'Toggle Storage Mount Read-Only Lock', category: 'SAFETY', icon: null, action: () => {}, isToggle: true },
    { id: 'cmd-batch-diff', title: 'Batch Enrich & Harmonize Tracks', category: 'ACTION', icon: null, action: () => {} },
    { id: 'cmd-import', title: 'Import Music Library', category: 'ACTION', icon: null, action: () => {} },
    { id: 'cmd-audit', title: 'Run Comprehensive Metadata Hygiene Audit', category: 'AUDIT', icon: null, action: () => {} },
    { id: 'cmd-copilot', title: 'Open Cadence AI Copilot', category: 'ACTION', icon: null, action: () => {} },
  ]

  // Test 1: Direct Entity Lookup for "Delhi-6" (Tier 1)
  console.log('\n--- Test 1: Direct Entity Lookup for "Delhi-6" ---')
  const t0 = performance.now()
  const memSearch = graphEngine.searchCatalog('Delhi-6', 5)
  const lookupDuration = performance.now() - t0

  console.log(`[Latency] in-memory search took ${lookupDuration.toFixed(3)} ms (Target: < 5 ms)`)
  if (lookupDuration > 15) {
    throw new Error(`In-memory search took ${lookupDuration} ms, exceeding 15ms target!`)
  }

  const albumHit = memSearch.albums.find((a) => a.title.toLowerCase().includes('delhi-6'))
  if (!albumHit) {
    throw new Error('Expected "Delhi-6" album to be found in catalog!')
  }
  console.log(`✓ Found album: "${albumHit.title}" by ${albumHit.composerName || albumHit.artistCredit} (${albumHit.releaseYear})`)

  const formatBadge = deriveFormatBadge(albumHit.mediaFormat || 'FLAC', '24/96')
  console.log(`✓ Derived format badge: "${formatBadge}"`)

  const albumMatches: CatalogAlbumMatch[] = [
    {
      type: 'album',
      id: albumHit.id,
      title: albumHit.title,
      artistCredit: albumHit.artistCredit,
      composerName: albumHit.composerName,
      releaseYear: albumHit.releaseYear,
      tracksCount: albumHit.tracksCount || 10,
      formatBadge,
      artworkUrl: albumHit.coverArtUrl,
      release: albumHit,
    },
  ]

  const classified = classifySearchIntent({
    rawQuery: 'Delhi-6',
    entityHits: { albums: albumMatches, tracks: [], artists: [] },
    facetIntent: null,
    commands: mockCommands,
    mode: 'search',
  })

  if (classified.rows.length === 0 || classified.rows[0].kind !== 'album') {
    throw new Error(`Expected #0 row to be album, got: ${classified.rows[0]?.kind}`)
  }
  if (classified.isAgentElevated) {
    throw new Error('AI Agent should NOT be elevated when direct entity matches exist!')
  }
  const bottomRow = classified.rows[classified.rows.length - 1]
  if (bottomRow.kind !== 'agent') {
    throw new Error(`Expected bottom row to be secondary AI Agent handover, got: ${bottomRow.kind}`)
  }
  console.log(`✓ Top-right intent badge: "${classified.badge.label}" (${classified.badge.variant})`)
  console.log(`✓ #0 row: ${classified.rows[0].kind} - "${(classified.rows[0] as any).entity.title}"`)
  console.log(`✓ Pinned bottom row: ${bottomRow.kind} - "${(bottomRow as any).prompt}"`)

  // Test 2: Dynamic Canonical Candidate Matching & Compound Facet Parsing (Tier 2)
  console.log('\n--- Test 2: Dynamic Facet Token Parsing for "Rahman 1990s FLAC" ---')
  const dynamicCandidates = allPersons.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.primaryRole,
  }))

  const facetParsed = parseFacetTokens('Rahman 1990s FLAC', dynamicCandidates)
  if (!facetParsed) {
    throw new Error('Expected parseFacetTokens to match tokens!')
  }
  console.log('✓ Extracted facets:', JSON.stringify(facetParsed.facets))
  console.log('✓ Filter pills:', facetParsed.pills.map((p) => `[${p.label}: ${p.value}]`).join(' '))

  if (facetParsed.facets.format !== 'FLAC') {
    throw new Error(`Expected format FLAC, got: ${facetParsed.facets.format}`)
  }
  if (facetParsed.facets.era !== '1991-2000') {
    throw new Error(`Expected era 1991-2000, got: ${facetParsed.facets.era}`)
  }
  if (!facetParsed.facets.composer?.includes('Rahman')) {
    throw new Error(`Expected composer A. R. Rahman, got: ${facetParsed.facets.composer}`)
  }

  // Test 3: Dynamic Range Token Parsing
  console.log('\n--- Test 3: Dynamic Range Token Parsing for "DSD64 High DR" ---')
  const drParsed = parseFacetTokens('DSD64 High DR', dynamicCandidates)
  if (!drParsed) throw new Error('Expected DR parsing to succeed')
  if (drParsed.facets.format !== 'DSD64') throw new Error(`Expected format DSD64, got ${drParsed.facets.format}`)
  if (!drParsed.facets.mastering?.includes('12')) throw new Error(`Expected DR >= 12, got ${drParsed.facets.mastering}`)
  console.log('✓ DR Parsed Pills:', drParsed.pills.map((p) => `[${p.label}: ${p.value}]`).join(' '))

  // Test 4: Prefix Scoping with ">" for Pure System Commands (Tier 3)
  console.log('\n--- Test 4: Prefix Scoping "> mount" ---')
  const cmdScope = classifySearchIntent({
    rawQuery: '> mount',
    entityHits: { albums: albumMatches, tracks: [], artists: [] },
    facetIntent: null,
    commands: mockCommands,
    mode: 'search',
  })
  if (!cmdScope.isCommandOnlyMode) {
    throw new Error('Expected isCommandOnlyMode to be true')
  }
  if (cmdScope.rows.some((r) => r.kind !== 'command')) {
    throw new Error('Command-only mode returned non-command rows!')
  }
  console.log(`✓ Scoped commands count: ${cmdScope.rows.length}`)
  console.log(`✓ Command badge: "${cmdScope.badge.label}"`)

  // Test 5: Explicit AI Agent Prefix "?" (Tier 4)
  console.log('\n--- Test 5: Explicit AI Prefix "? find missing covers" ---')
  const aiScope = classifySearchIntent({
    rawQuery: '? find missing covers',
    entityHits: { albums: albumMatches, tracks: [], artists: [] },
    facetIntent: null,
    commands: mockCommands,
    mode: 'search',
  })
  if (!aiScope.isAgentElevated || aiScope.rows[0].kind !== 'agent') {
    throw new Error('Expected AI Agent to be elevated to #0')
  }
  console.log(`✓ Elevated Agent #0 row: "${(aiScope.rows[0] as any).prompt}"`)
  console.log(`✓ Agent badge: "${aiScope.badge.label}" (${aiScope.badge.variant})`)

  // Test 6: Multi-word Diagnostic NL Query with 0 Entity Hits (Tier 4)
  console.log('\n--- Test 6: Multi-word Diagnostic NL "audit uncommitted sidecars" ---')
  const diagScope = classifySearchIntent({
    rawQuery: 'audit uncommitted sidecars',
    entityHits: { albums: [], tracks: [], artists: [] },
    facetIntent: null,
    commands: mockCommands,
    mode: 'search',
  })
  if (!diagScope.isAgentElevated || diagScope.rows[0].kind !== 'agent') {
    throw new Error('Expected diagnostic query to elevate AI Agent to #0 when 0 entity hits exist')
  }
  console.log(`✓ Auto-elevated Agent on diagnostic query: "${(diagScope.rows[0] as any).prompt}"`)

  console.log('\n======================================================')
  console.log('✓ ALL OMNIBAR INTENT ENGINE TESTS PASSED SUCCESSFULLY!')
  console.log('======================================================\n')
}

runOmnibarIntentTests().catch((err) => {
  console.error('\n❌ Test Failure:', err)
  process.exit(1)
})
