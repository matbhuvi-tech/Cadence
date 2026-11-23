import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatTrackSizeLabel,
  isDuplicatePendingPlay,
  resolveLoadingPillLabel,
  resolveLoadingSubLabel,
  shouldClearPendingPlayFromSnapshot,
  type PendingPlayTarget,
} from '../core/pendingPlayState.ts'
import type { Track } from '../core/types.ts'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: overrides.id ?? 'trk_1',
    releaseId: overrides.releaseId ?? 'rel_1',
    recordingId: overrides.recordingId ?? 'rec_1',
    trackNumber: 1,
    discNumber: 1,
    title: overrides.title ?? 'Sample Track',
    artistCredit: overrides.artistCredit ?? 'Sample Artist',
    durationSeconds: 240,
    filePath: '/music/sample.flac',
    fileSize: overrides.fileSize ?? 45 * 1024 * 1024,
    storageMountId: 'mount_1',
    sidecarStatus: 'synced',
    modifiedTimestamp: '2026-11-23T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 0,
    sampleRateStr: '24-bit / 96.0 kHz',
    format: 'FLAC',
    isHighRes: true,
    credits: [],
    masterReleaseId: 'rel_1',
  }
}

function makePending(overrides: Partial<PendingPlayTarget> = {}): PendingPlayTarget {
  return {
    requestId: overrides.requestId ?? 1,
    track: overrides.track ?? makeTrack(),
    release: overrides.release ?? null,
    releaseId: overrides.releaseId ?? 'rel_1',
    queueEntryId: overrides.queueEntryId ?? null,
    startedAtMs: overrides.startedAtMs ?? 1000,
    showSpinner: overrides.showSpinner ?? false,
    isSlowStorage: overrides.isSlowStorage ?? false,
  }
}

test('isDuplicatePendingPlay ignores repeat clicks on the same loading track or queue entry', () => {
  assert.equal(isDuplicatePendingPlay(null, 'trk_1'), false)

  const localPending = makePending({ track: makeTrack({ id: 'trk_1' }), queueEntryId: null })
  assert.equal(isDuplicatePendingPlay(localPending, 'trk_1'), true)
  assert.equal(isDuplicatePendingPlay(localPending, 'trk_2'), false)

  const corePending = makePending({ track: makeTrack({ id: 'trk_1' }), queueEntryId: 'qe_10' })
  assert.equal(isDuplicatePendingPlay(corePending, 'trk_1', 'qe_10'), true)
  assert.equal(isDuplicatePendingPlay(corePending, 'trk_1', 'qe_11'), false)
  assert.equal(isDuplicatePendingPlay(corePending, 'trk_1', null), false)
})

test('formatTrackSizeLabel formats KB, MB, and GB boundaries cleanly', () => {
  assert.equal(formatTrackSizeLabel(undefined), null)
  assert.equal(formatTrackSizeLabel(0), null)
  assert.equal(formatTrackSizeLabel(512 * 1024), '512 KB')
  assert.equal(formatTrackSizeLabel(342 * 1024 * 1024), '342 MB')
  assert.equal(formatTrackSizeLabel(1.5 * 1024 * 1024 * 1024), '1.50 GB')
})

test('loading labels reflect fast RAM load vs >5s slow storage escape hatch', () => {
  assert.equal(resolveLoadingPillLabel(null, false), null)
  assert.equal(resolveLoadingPillLabel(null, true), 'Loading…')

  const normalPending = makePending({ track: makeTrack({ fileSize: 342 * 1024 * 1024 }) })
  assert.equal(resolveLoadingPillLabel(normalPending, true), 'Loading…')
  assert.equal(resolveLoadingSubLabel(normalPending), 'Loading to RAM · 342 MB')

  const unknownSizePending = makePending({ track: makeTrack({ fileSize: 0 }) })
  assert.equal(resolveLoadingSubLabel(unknownSizePending), 'Loading to RAM…')

  const slowPending = makePending({ isSlowStorage: true })
  assert.equal(resolveLoadingPillLabel(slowPending, true), 'Reading from storage…')
  assert.equal(resolveLoadingSubLabel(slowPending), 'Reading from storage…')
})

test('shouldClearPendingPlayFromSnapshot clears only when snapshot enters playing/paused for the pending track', () => {
  const pending = makePending({ track: makeTrack({ id: 'trk_target' }) })
  assert.equal(shouldClearPendingPlayFromSnapshot(null, 'playing', 'trk_target'), false)
  assert.equal(shouldClearPendingPlayFromSnapshot(pending, 'loading', 'trk_target'), false)
  assert.equal(shouldClearPendingPlayFromSnapshot(pending, 'idle', 'trk_target'), false)
  assert.equal(shouldClearPendingPlayFromSnapshot(pending, 'playing', 'trk_previous'), false)
  assert.equal(shouldClearPendingPlayFromSnapshot(pending, 'playing', 'trk_target'), true)
  assert.equal(shouldClearPendingPlayFromSnapshot(pending, 'paused', 'trk_target'), true)
})
