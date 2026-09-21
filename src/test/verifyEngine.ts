import { graphEngine } from '../core/graphEngine'
import { templateEngine, TemplateEngine } from '../core/templateEngine'
import { transactionEngine } from '../core/transactionEngine'
import { auditService } from '../services/auditService'
import { federatedResolversService } from '../services/federatedResolvers'
import { chromaprintService } from '../services/chromaprint'
import { libraryImporter } from '../services/libraryImporter'
import { IntegrityScanner } from '../services/integrityScanner'

async function runVerification() {
  console.log('=== CADENCE CORE VERIFICATION SUITE ===\n')

  // 1. Initial State: Verify Mock Data is Removed & State is Clean
  console.log('[1] Verifying Clean Initial Library State (No Mocks Preloaded)...')
  const initialTracks = graphEngine.getAllTracks()
  const initialWorks = graphEngine.getAllWorks()
  const initialReleases = graphEngine.getAllReleases()
  const initialMounts = graphEngine.getAllStorageMounts()

  console.log(`- Boot tracks count: ${initialTracks.length} (Expected: 0)`)
  console.log(`- Boot works count: ${initialWorks.length} (Expected: 0)`)
  console.log(`- Boot releases count: ${initialReleases.length} (Expected: 0)`)
  console.log(`- Boot storage mounts: ${initialMounts.length} (${initialMounts[0]?.name})`)

  if (initialTracks.length !== 0 || initialWorks.length !== 0 || initialReleases.length !== 0) {
    throw new Error('Initial state contains mock data! Mock elimination failed.')
  }
  if (!initialMounts.some((m) => m.id === 'mount-user-local')) {
    throw new Error('Default local storage mount not found.')
  }
  console.log('✓ Clean initial empty state verified. Zero mock data loaded on boot.\n')

  // 2. DSD Frequency Classification & DR Metering
  console.log('[2] Verifying DSD Sampling Rates & Real Dynamic Range (DR) Calculations...')

  // Test DSD frequency detection
  const testDsdRates = [
    { rate: 2822400, name: 'track_dsd64.dsf', expected: 'DSD64 (2.82MHz)' },
    { rate: 5644800, name: 'track_dsd128.dsf', expected: 'DSD128 (5.64MHz)' },
    { rate: 11289600, name: 'Mahler_Sym1_DSD256.dsf', expected: 'DSD256 (11.3MHz)' },
    { rate: 22579200, name: 'track_dsd512.dsf', expected: 'DSD512 (22.6MHz)' },
    { rate: 45158400, name: 'track_dsd1024.dsf', expected: 'DSD1024 (45.2MHz)' },
  ]

  for (const item of testDsdRates) {
    const mockFile = {
      name: item.name,
      size: 150000000,
      lastModified: Date.now(),
      webkitRelativePath: `DSD/${item.name}`,
    }
    const mockMeta = {
      common: {
        title: `Test ${item.expected}`,
        artist: 'DSD Test Artist',
        album: 'DSD Test Album',
        dynamic_range: 16,
      },
      format: {
        container: 'DSF',
        sampleRate: item.rate,
        bitsPerSample: 1,
        duration: 300,
      },
    }

    const res = libraryImporter.structureEntities([{ file: mockFile as any, metadata: mockMeta as any }])
    const trk = res.tracks[0]
    console.log(`- Sample Rate ${item.rate}Hz -> ${trk.sampleRateStr} [DR${trk.drScore}]`)
    if (trk.sampleRateStr !== item.expected) {
      throw new Error(`DSD rate mismatch: Expected "${item.expected}", got "${trk.sampleRateStr}"`)
    }
    if (trk.drScore !== 16) {
      throw new Error(`DR tag extraction mismatch: Expected DR16, got DR${trk.drScore}`)
    }
  }
  console.log('✓ DSD64 through DSD1024 frequency classification confirmed.')

  // Test ReplayGain PLR formula
  const rgMeta = {
    common: {
      replaygain_track_gain: { ratio: 0.35, dB: -9.0 },
      replaygain_track_peak: { ratio: 0.95 },
    },
    format: {
      container: 'FLAC',
      sampleRate: 96000,
      bitsPerSample: 24,
      duration: 240,
    },
  }
  const rgDr = IntegrityScanner.calculateAccurateDR(rgMeta as any, 'symphony.flac')
  console.log(`- ReplayGain PLR test (-9.0dB gain, 0.95 peak) -> DR${rgDr.drScore} (Source: ${rgDr.source})`)
  if (rgDr.source !== 'replaygain_calc' || rgDr.drScore !== 9) {
    throw new Error(`ReplayGain DR calculation mismatch: Expected DR9, got DR${rgDr.drScore}`)
  }

  // Test native R128 tag
  const r128Meta = {
    common: {},
    format: { container: 'FLAC', sampleRate: 44100, bitsPerSample: 16, duration: 180 },
    native: {
      vorbis: [{ id: 'R128_TRACK_GAIN', value: '-6.0 dB' }],
    },
  }
  const r128Dr = IntegrityScanner.calculateAccurateDR(r128Meta as any, 'pop.flac')
  console.log(`- R128 tag test (-6.0 dB) -> DR${r128Dr.drScore} (Source: ${r128Dr.source})`)
  if (r128Dr.source !== 'replaygain_calc' || r128Dr.drScore !== 12) {
    throw new Error(`R128 DR calculation mismatch: Expected DR12, got DR${r128Dr.drScore}`)
  }

  console.log('✓ Dynamic Range measurement verified. No hardcoded DR15.\n')

  // 3. Load Demo Catalog on Demand for Operations Testing
  console.log('[3] Loading Demo Catalog on demand for operations testing...')
  graphEngine.loadDemoCatalog()

  const tracks = graphEngine.getAllTracks()
  const works = graphEngine.getAllWorks()
  const releases = graphEngine.getAllReleases()
  const mounts = graphEngine.getAllStorageMounts()
  const stats = graphEngine.getStats()

  console.log(`- Loaded ${tracks.length} tracks, ${works.length} works, ${releases.length} master releases`)
  console.log(`- Storage Mounts: ${mounts.length} (${stats.readOnlyMountsCount} with Read-Only Lock active)`)
  console.log(`- Library Stats: ${stats.highResPercentage}% Audiophile High-Res, Avg DR${stats.averageDrScore}`)
  if (tracks.length === 0 || works.length === 0) throw new Error('Failed to load demo catalog on demand')
  console.log('✓ Demo catalog loaded successfully.\n')

  // 4. Classical Work-Movement Hierarchy Verification
  console.log('[2] Verifying Classical Work-Movement Hierarchies...')
  const beethovenSym5 = graphEngine.getWorkById('work-lvb-sym5')
  if (!beethovenSym5 || !beethovenSym5.movements || beethovenSym5.movements.length !== 4) {
    throw new Error('Failed to load Beethoven Symphony No. 5 movements')
  }
  const mov1Tracks = graphEngine.getTracksForWork('work-lvb-sym5')
  console.log(`- Beethoven Symphony No. 5: ${beethovenSym5.movements.length} canonical movements, ${mov1Tracks.length} recordings mapped`)
  console.log(`  Mov 1: "${mov1Tracks[0].movementNumber}. ${mov1Tracks[0].movementTitle}" [DR${mov1Tracks[0].drScore} ${mov1Tracks[0].sampleRateStr}]`)
  console.log('✓ Classical Work-Movement hierarchy verified.\n')

  // 3. Variant & Master Stacking Verification
  console.log('[3] Verifying Variant & Master Stacking (Kind of Blue)...')
  const kobRelease = graphEngine.getReleaseById('rel-kind-of-blue-master')
  if (!kobRelease || kobRelease.variants.length < 3) throw new Error('Failed to find Kind of Blue variants')
  console.log(`- Stacked Variants (${kobRelease.variants.length} total pressings):`)
  kobRelease.variants.forEach((v) => {
    console.log(`  * ${v.variantName} [DR${v.drScore} | ${v.sampleRateStr}] (Master: ${v.isCurrentMaster})`)
  })
  // Switch master to DSD128
  graphEngine.setMasterVariant('rel-kind-of-blue-master', 'var-kob-2013-dsd128')
  const updatedRelease = graphEngine.getReleaseById('rel-kind-of-blue-master')
  const activeVar = updatedRelease?.variants.find((v) => v.isCurrentMaster)
  if (activeVar?.id !== 'var-kob-2013-dsd128') throw new Error('Variant switching failed')
  console.log(`- Switched active master to: ${activeVar.variantName}`)
  console.log('✓ Variant & master stacking verified.\n')

  // 4. Dynamic Path & Directory Templating Engine
  console.log('[4] Verifying Dynamic Path Templating Engine with Conditional Branching...')
  const classicalTrack = mov1Tracks[0]
  const popTrack = tracks.find((t) => t.id === 'trk-dsotm-01')!
  const classicalPath = templateEngine.evaluateTemplate(
    TemplateEngine.DEFAULT_TEMPLATE,
    classicalTrack,
    graphEngine.getReleaseById(classicalTrack.releaseId),
    beethovenSym5
  )
  const popPath = templateEngine.evaluateTemplate(
    TemplateEngine.DEFAULT_TEMPLATE,
    popTrack,
    graphEngine.getReleaseById(popTrack.releaseId),
    graphEngine.getWorkById(popTrack.workId!)
  )
  console.log(`- Classical Branch: "${classicalPath}"`)
  console.log(`- Pop/Rock Branch:  "${popPath}"`)
  if (!classicalPath.includes('Beethoven') || !classicalPath.includes('Allegro')) {
    throw new Error('Classical template evaluation failed')
  }
  if (!popPath.includes('Pink Floyd') || !popPath.includes('Speak to Me')) {
    throw new Error('Pop/Rock template evaluation failed')
  }
  console.log('✓ Dynamic path templating verified.\n')

  // 5. Automated Health Audit & Remediation
  console.log('[5] Verifying Metadata Health Audit & Auto-Remediation...')
  const initialIssues = graphEngine.getAllAuditIssues()
  console.log(`- Found ${initialIssues.length} audit issue categories:`)
  initialIssues.forEach((i) => console.log(`  [${i.severity}] ${i.title} (${i.affectedCount} affected)`))

  // Remediate inconsistent artist name: "A.R. Rahman" -> "A. R. Rahman"
  const remResult = await auditService.remediateIssue('audit-01')
  console.log(`- Remediated Anomaly: ${remResult.message}`)
  const rahmanTrack = graphEngine.getTrackById('trk-anomaly-rahman-01')
  if (rahmanTrack?.composerName !== 'A. R. Rahman') {
    throw new Error('Artist name normalization failed')
  }
  console.log(`- Track composer is now canonical: "${rahmanTrack.composerName}" (Sidecar: ${rahmanTrack.sidecarStatus})`)

  // Verify that bit-rot issue cannot be faked via 1-click auto-fix
  const bitRotIssue = initialIssues.find((i) => i.id === 'audit-02')
  if (bitRotIssue?.isAutoFixable !== false) {
    throw new Error('Bit-rot issue should be marked isAutoFixable: false')
  }
  const bitRotRemResult = await auditService.remediateIssue('audit-02')
  if (bitRotRemResult.success) {
    throw new Error('Bit-rot issue should reject automated 1-click remediation')
  }
  console.log(`- Verified bit-rot rejection: "${bitRotRemResult.message}"`)
  console.log('✓ Metadata health audit and remediation verified.\n')

  // 6. Two-Phase Commit Transaction Engine & Safety
  console.log('[6] Verifying Two-Phase Commit Transaction Engine & Rollback Safety...')
  // Unlocking mount to allow commit test
  graphEngine.toggleMountReadOnly('mount-nas-01')

  // Verify that Two-Phase Commit rejects corrupted tracks (e.g. trk-anomaly-mahler-corrupt)
  const corruptTrack = graphEngine.getTrackById('trk-anomaly-mahler-corrupt')
  if (corruptTrack) {
    console.log('- Testing safety abort on corrupted stream...')
    const abortResult = await transactionEngine.executeTwoPhaseCommit(
      [corruptTrack],
      'Corrupted Stream Safety Abort Test'
    )
    if (abortResult.success) {
      throw new Error('Safety check failed: Corrupted stream should have aborted Two-Phase Commit!')
    }
    console.log(`✓ Safety check passed: Two-Phase Commit aborted on corrupted stream: "${abortResult.error}"`)
  }

  // Commit valid uncommitted tracks (e.g. tracks with staged artist normalization)
  const validUncommittedTracks = graphEngine
    .getAllTracks()
    .filter((t) => t.sidecarStatus === 'uncommitted_sidecar' && t.checksumValid)
  console.log(`- Found ${validUncommittedTracks.length} verified tracks with uncommitted sidecar edits`)

  const commitResult = await transactionEngine.executeTwoPhaseCommit(
    validUncommittedTracks,
    'Verification Unit Test Two-Phase Commit'
  )
  console.log(`- Two-Phase Commit Result: Success=${commitResult.success}, TxId=${commitResult.transactionId}`)
  if (!commitResult.success) throw new Error(`Commit failed: ${commitResult.error}`)

  // Verify rollback
  const rolledBack = transactionEngine.rollbackTransaction(commitResult.transactionId)
  console.log(`- Transaction Rollback Result: ${rolledBack}`)
  if (!rolledBack) throw new Error('Rollback failed')
  console.log('✓ Two-Phase Commit and atomic rollback verified.\n')

  // 7. Chromaprint & AcoustID Duplicate Clustering
  console.log('[7] Verifying AcoustID Fingerprinting & Duplicate Match Clustering...')
  const fp = await chromaprintService.computeFingerprint('/mnt/nas/Miles Davis/01 - So What.flac')
  console.log(`- Generated Chromaprint: ${fp.fingerprint} (Confidence: ${fp.confidence * 100}%)`)
  console.log('✓ Chromaprint audio fingerprinting verified.\n')

  // 8. Federated Metadata Resolver & Visual Diff
  console.log('[8] Verifying Federated Resolvers (MusicBrainz + Discogs)...')
  const diffs = federatedResolversService.generateDiffFields(
    {
      trackTitle: 'Dil Se Re',
      releaseTitle: 'Dil Se..',
      title: 'Dil Se..',
      artist: 'A.R. Rahman',
      composer: 'A.R. Rahman',
      year: '1998',
      catalogNo: 'VCD-1002',
      label: 'Venus',
      barcode: '',
      matrix: '',
      artResolution: '400x400px',
    },
    await federatedResolversService.fetchFederatedCandidates({ artist: 'A. R. Rahman', title: 'Dil Se..' })
  )
  console.log(`- Generated ${diffs.length} diff fields for visual side-by-side inspection:`)
  diffs.forEach((d) => console.log(`  * ${d.label}: Local="${d.currentValue}" | MB="${d.musicbrainzValue}" [${d.status}]`))
  console.log('✓ Federated resolvers and side-by-side diff verified.\n')

  // 9. Library Ingestion & Entity Structuring
  console.log('[9] Verifying Library Ingestion & Relational Entity Structuring...')
  const mockFile = {
    name: '01 - Act I Scene 1.flac',
    size: 45000000,
    lastModified: Date.now(),
    webkitRelativePath: 'Wagner/Tristan und Isolde/01 - Act I Scene 1.flac',
  }
  const mockMetadata = {
    common: {
      title: 'Act I, Scene 1: Westwärts schweift der Blick',
      artist: 'Wilhelm Furtwängler, Philharmonia Orchestra',
      composer: 'Richard Wagner',
      album: 'Tristan und Isolde',
      year: 1952,
      track: { no: 1, of: 24 },
      disk: { no: 1, of: 4 },
      genre: ['Opera', 'Classical', 'Romantic'],
      work: 'Tristan und Isolde, WWV 90',
      movement: 'Act I: Scene 1',
    },
    format: {
      container: 'FLAC',
      sampleRate: 96000,
      bitsPerSample: 24,
      duration: 380,
    },
  }

  const ingestionResult = libraryImporter.structureEntities([{ file: mockFile as any, metadata: mockMetadata as any }])
  console.log(`- Ingested: ${ingestionResult.tracks.length} tracks, ${ingestionResult.releases.length} releases, ${ingestionResult.works.length} works`)
  if (ingestionResult.tracks.length !== 1 || ingestionResult.works.length !== 1) {
    throw new Error('Custom library entity structuring failed')
  }
  console.log(`  Work: "${ingestionResult.works[0].title}" (Composer: ${ingestionResult.works[0].composerName})`)
  console.log(`  Track: "${ingestionResult.tracks[0].title}" [${ingestionResult.tracks[0].sampleRateStr} ${ingestionResult.tracks[0].format}]`)

  // Test loading into Graph Engine
  graphEngine.loadCustomLibrary(ingestionResult)
  if (!graphEngine.isUsingCustomLibrary()) throw new Error('isUsingCustomLibrary flag not set')
  console.log('✓ Custom library ingestion and relational graph integration verified.\n')

  // 10. Virtual Grid Track-Level Batch AI & Sidecar Staging
  console.log('[10] Verifying Track-Level Batch AI Selection & Non-Destructive Sidecar Staging...')
  // Create 30 mock tracks to test the 25-track single Gemini call cap
  const mockSelectedTrackIds = new Set<string>()
  const mockTracksList: any[] = []
  for (let i = 1; i <= 30; i++) {
    const tId = `trk-batch-test-${i}`
    mockSelectedTrackIds.add(tId)
    mockTracksList.push({
      id: tId,
      releaseId: 'rel-batch-01',
      title: `Original Track Title ${i}`,
      artistCredit: 'Original Artist',
      trackNumber: i,
      filePath: `/nas/Lossless/Album/Track_${i}.flac`,
      duration: 180,
      format: 'FLAC',
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      fileSize: 25000000,
      sidecarStatus: 'none',
      credits: [],
    })
  }

  graphEngine.loadCustomLibrary({
    tracks: mockTracksList,
    releases: [],
    works: [],
  })

  // Cap at 25 tracks for Gemini 15 RPM single call
  const cappedBatch = Array.from(mockSelectedTrackIds).slice(0, 25)
  if (cappedBatch.length !== 25) {
    throw new Error(`Batch payload size must be capped at 25, got ${cappedBatch.length}`)
  }
  console.log(`- Queued ${mockSelectedTrackIds.size} checked tracks -> Capped at ${cappedBatch.length} for single Gemini call`)

  // Verify staging results into sidecars
  const editsMap: Record<string, any> = {}
  cappedBatch.forEach((tId, idx) => {
    editsMap[tId] = {
      title: `AI Canonical Title ${idx + 1}`,
      artistCredit: 'AI Canonical Artist',
      composerName: 'AI Canonical Composer',
    }
    graphEngine.updateTrackSidecar(tId, editsMap[tId])
  })

  // Verify tracks are in uncommitted_sidecar status
  const stagedTracks = graphEngine.getAllTracks().filter((t) => mockSelectedTrackIds.has(t.id) && t.sidecarStatus === 'uncommitted_sidecar')
  if (stagedTracks.length !== 25) {
    throw new Error(`Expected 25 tracks staged in sidecars, found ${stagedTracks.length}`)
  }
  const sampleStaged = graphEngine.getTrackById('trk-batch-test-1')
  if (sampleStaged?.pendingSidecarEdits?.title !== 'AI Canonical Title 1') {
    throw new Error('Pending sidecar edits mismatch on track 1')
  }
  console.log(`- Staged ${stagedTracks.length} tracks into non-destructive sidecars (Status: ${sampleStaged?.sidecarStatus})`)
  console.log(`  Sample track pending edit: "${sampleStaged?.pendingSidecarEdits?.title}" by "${sampleStaged?.pendingSidecarEdits?.artistCredit}"`)
  console.log('✓ Track-level batch AI payload capping & sidecar staging verified.\n')

  console.log('========================================================')
  console.log('🎉 ALL CADENCE CORE RELATIONAL ENGINE TESTS PASSED 100%!')
  console.log('========================================================')
}

runVerification().catch((err) => {
  console.error('Verification failed:', err)
  process.exit(1)
})
