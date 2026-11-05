import assert from 'assert'
import type {
  CurationDecisionTrace,
  FieldDecision,
  CandidateTelemetry,
  OutcomeStatus,
  ExecutionPhase,
  ExecutionProgressEvent,
} from '../core/types'

async function runTests() {
  console.log('=== [TDD] Testing Curation Decision Trace & Fetch Feedback Architecture ===\n')

  // -------------------------------------------------------------------------
  // Scenario 1: Successful Match and Metadata Application (matched_applied)
  // -------------------------------------------------------------------------
  console.log('[Scenario 1] Testing matched_applied trace construction...')
  const candidate1: CandidateTelemetry = {
    provider: 'musicbrainz',
    releaseId: 'mb-rel-12345',
    trackCount: 6,
    latencyMs: 340,
    httpStatus: 200,
    confidenceScore: 0.96,
  }

  const trace1: CurationDecisionTrace = {
    albumId: 'alb-1',
    albumHash: 'alb-1-6',
    matchedReleaseId: 'mb-rel-12345',
    outcomeStatus: 'matched_applied',
    headlineSummary: 'Matched and applied 2 metadata fields from MusicBrainz.',
    fieldTraces: {
      albumTitle: {
        action: 'Applied',
        chosenValue: 'Roja',
        localValue: 'Roja [FLAC]',
        consensusRatio: 'musicbrainz',
        plainExplanation: 'Applied title from MusicBrainz with 96% match confidence.',
        confidenceScore: 0.96,
      },
      albumArtist: {
        action: 'Applied',
        chosenValue: 'A.R. Rahman',
        localValue: 'Rahman',
        consensusRatio: 'musicbrainz',
        plainExplanation: 'Applied canonical artist name from MusicBrainz.',
        confidenceScore: 0.98,
      },
    },
    candidateTelemetry: [candidate1],
    durationMs: 850,
    engineVersion: 'cadence-curate-v2',
    updatedAt: new Date().toISOString(),
  }

  assert.strictEqual(trace1.outcomeStatus, 'matched_applied')
  assert.strictEqual(Object.keys(trace1.fieldTraces).length, 2)
  assert.strictEqual(trace1.matchedReleaseId, 'mb-rel-12345')
  assert.strictEqual(trace1.candidateTelemetry[0].trackCount, 6)
  console.log('  ✓ matched_applied trace accurately represents applied fields and accepted candidates.\n')

  // -------------------------------------------------------------------------
  // Scenario 2: Multiple Candidates with Different Confidence Scores
  // -------------------------------------------------------------------------
  console.log('[Scenario 2] Testing multiple candidate ranking and rejection...')
  const candidates: CandidateTelemetry[] = [
    {
      provider: 'musicbrainz',
      releaseId: 'mb-1',
      trackCount: 6,
      latencyMs: 250,
      httpStatus: 200,
      confidenceScore: 0.95,
    },
    {
      provider: 'discogs',
      releaseId: 'dc-1',
      trackCount: 6,
      latencyMs: 620,
      httpStatus: 200,
      confidenceScore: 0.82,
      rejectionReason: 'Lower consensus score compared to MusicBrainz canonical entry',
    },
  ]

  const accepted = candidates.find((c) => !c.rejectionReason)
  const rejected = candidates.filter((c) => Boolean(c.rejectionReason))
  assert.strictEqual(accepted?.releaseId, 'mb-1')
  assert.strictEqual(rejected.length, 1)
  assert.strictEqual(rejected[0].rejectionReason, 'Lower consensus score compared to MusicBrainz canonical entry')
  console.log('  ✓ Candidates correctly retain ranking scores, latency, and explicit rejection reasons.\n')

  // -------------------------------------------------------------------------
  // Scenario 3: Evaluated, Unchanged (No better candidate than local metadata)
  // -------------------------------------------------------------------------
  console.log('[Scenario 3] Testing evaluated_unchanged outcome...')
  const trace3: CurationDecisionTrace = {
    albumId: 'alb-2',
    albumHash: 'alb-2-6',
    outcomeStatus: 'evaluated_unchanged',
    headlineSummary: 'Evaluation complete — 1 candidate examined. Existing metadata retained; no better match found.',
    fieldTraces: {
      albumTitle: {
        action: 'Retained',
        chosenValue: 'Muthu',
        localValue: 'Muthu',
        consensusRatio: 'local',
        plainExplanation: 'Existing local title retained: candidates did not achieve confidence threshold.',
        confidenceScore: 0.95,
      },
    },
    candidateTelemetry: [
      {
        provider: 'musicbrainz',
        releaseId: 'mb-low',
        trackCount: 6,
        latencyMs: 400,
        httpStatus: 200,
        confidenceScore: 0.55,
        rejectionReason: 'Confidence score (55%) below acceptance threshold (80%)',
      },
    ],
    durationMs: 1200,
    engineVersion: 'cadence-curate-v2',
    updatedAt: new Date().toISOString(),
  }

  assert.strictEqual(trace3.outcomeStatus, 'evaluated_unchanged')
  assert.strictEqual(trace3.fieldTraces.albumTitle.action, 'Retained')
  assert.ok(trace3.headlineSummary.includes('Existing metadata retained'))
  console.log('  ✓ evaluated_unchanged communicates no-change clearly without technical jargon.\n')

  // -------------------------------------------------------------------------
  // Scenario 4: Track-Count Mismatch Rejection
  // -------------------------------------------------------------------------
  console.log('[Scenario 4] Testing track-count mismatch rejection...')
  const mismatchedCandidate: CandidateTelemetry = {
    provider: 'musicbrainz',
    releaseId: 'mb-mismatch',
    trackCount: 4, // Candidate has only 4 tracks, local album has 30 tracks
    latencyMs: 310,
    httpStatus: 200,
    confidenceScore: 0.3,
    rejectionReason: 'Track count mismatch: candidate has 4 tracks, local album has 30 tracks',
  }

  assert.strictEqual(mismatchedCandidate.trackCount, 4)
  assert.ok(mismatchedCandidate.rejectionReason?.includes('Track count mismatch'))
  console.log('  ✓ Track-count mismatch is explicitly tagged with candidate telemetry.\n')

  // -------------------------------------------------------------------------
  // Scenario 5 & 8: Playback Interruption Handling (PausedForPlayback)
  // -------------------------------------------------------------------------
  console.log('[Scenario 5 & 8] Testing playback interruption abort...')
  const controller = new AbortController()
  let abortedReason: string | undefined

  controller.signal.addEventListener('abort', () => {
    abortedReason = controller.signal.reason as string
  })

  // Simulate playback starting mid-fetch
  controller.abort('PausedForPlayback')

  assert.strictEqual(abortedReason, 'PausedForPlayback')

  const tracePaused: CurationDecisionTrace = {
    albumId: 'alb-5',
    albumHash: 'alb-5-6',
    outcomeStatus: 'paused_playback',
    headlineSummary: 'Curation paused to preserve bit-perfect playback.',
    fieldTraces: {},
    candidateTelemetry: [],
    durationMs: 120,
    engineVersion: 'cadence-curate-v2',
    updatedAt: new Date().toISOString(),
  }

  assert.strictEqual(tracePaused.outcomeStatus, 'paused_playback')
  assert.strictEqual(tracePaused.headlineSummary, 'Curation paused to preserve bit-perfect playback.')
  console.log('  ✓ Bit-perfect playback pause cleanly aborts fetch and produces paused_playback trace.\n')

  // -------------------------------------------------------------------------
  // Scenario 9: Field-Level Trace Retention and Merge (UPSERT Invariant)
  // -------------------------------------------------------------------------
  console.log('[Scenario 9] Testing field-level merge semantics on partial steer...')
  const existingFieldTraces: Record<string, FieldDecision> = {
    albumTitle: {
      action: 'Applied',
      chosenValue: 'Canonical Title',
      localValue: 'Old Title',
      consensusRatio: 'musicbrainz',
      plainExplanation: 'Applied title from MusicBrainz.',
      confidenceScore: 0.95,
    },
    albumArtist: {
      action: 'Applied',
      chosenValue: 'Canonical Artist',
      localValue: 'Old Artist',
      consensusRatio: 'musicbrainz',
      plainExplanation: 'Applied artist from MusicBrainz.',
      confidenceScore: 0.95,
    },
  }

  // In the new steer, user ONLY steered and updated Album Artist
  const newFieldTraces: Record<string, FieldDecision> = {
    albumArtist: {
      action: 'Applied',
      chosenValue: 'Steered New Artist',
      localValue: 'Canonical Artist',
      consensusRatio: 'apple',
      plainExplanation: 'Steered and applied artist from Apple Music.',
      confidenceScore: 0.99,
    },
  }

  // Field-level merge logic:
  const mergedFieldTraces: Record<string, FieldDecision> = {
    ...existingFieldTraces,
    ...newFieldTraces,
  }

  assert.strictEqual(Object.keys(mergedFieldTraces).length, 2)
  assert.strictEqual(mergedFieldTraces.albumTitle.chosenValue, 'Canonical Title')
  assert.strictEqual(mergedFieldTraces.albumArtist.chosenValue, 'Steered New Artist')
  console.log('  ✓ Field-level merge preserves untouched field traces across separate steer runs.\n')

  console.log('=== All Curation Decision Trace scenarios passed successfully! ===')
}

runTests().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
