import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  assertWindowsRootNotLeasedToCore,
  createRemoteCurateController,
  formatRemoteCurateStatusLabel,
  type CoreRootLease,
  type RemoteCurateTransport,
} from '../core/remoteCurate'

test('distinguishes buffered Waiting to save from durable Draft saved and execution states', () => {
  assert.equal(formatRemoteCurateStatusLabel('waiting_to_save'), 'Waiting to save')
  assert.equal(formatRemoteCurateStatusLabel('draft_saved'), 'Draft saved')
  assert.equal(
    formatRemoteCurateStatusLabel('approved_waiting_idle'),
    'Approved / Waiting for playback to stop',
  )
  assert.equal(formatRemoteCurateStatusLabel('cooling_down'), 'Cooling down')
  assert.equal(formatRemoteCurateStatusLabel('applying'), 'Applying')
  assert.equal(formatRemoteCurateStatusLabel('verified'), 'Verified')
  assert.equal(formatRemoteCurateStatusLabel('failed'), 'Failed')
})

test('buffered edits stay Waiting to save until Core confirms durable Draft saved', async () => {
  const calls: string[] = []
  const transport: RemoteCurateTransport = {
    async request(op, payload) {
      calls.push(op)
      if (op === 'curate.draft.save') {
        return {
          ok: true,
          data: {
            draftId: String(payload.draftId ?? 'd1'),
            trackId: 'trk-1',
            revision: 1,
            changes: [],
            status: 'draft_saved',
            approvalHash: null,
            readOnlyBlockedReason: null,
          },
        }
      }
      return { ok: false, error: { code: 'unsupported_capability' } }
    },
  }

  const ctrl = createRemoteCurateController({
    engineId: 'core-1',
    libraryId: 'lib-1',
    transport,
  })

  ctrl.bufferEdit('d1', 'trk-1', [{ field: 'title', before: 'Old', after: 'New' }])
  assert.equal(ctrl.getDraftState('d1')?.status, 'waiting_to_save')
  assert.equal(ctrl.getDraftState('d1')?.durable, false)

  const saved = await ctrl.saveBufferedDraft('d1', 'windows')
  assert.equal(saved.status, 'draft_saved')
  assert.equal(saved.durable, true)
  assert.equal(saved.revision, 1)
  assert.deepEqual(calls, ['curate.draft.save'])
})

test('read-only Core root retains Draft saved and exposes dry-run block reason without approving', async () => {
  const transport: RemoteCurateTransport = {
    async request(op) {
      if (op === 'curate.draft.save') {
        return {
          ok: true,
          data: {
            draftId: 'd-ro',
            trackId: 'trk-1',
            revision: 1,
            changes: [{ field: 'title', before: 'A', after: 'B' }],
            status: 'draft_saved',
            approvalHash: null,
            readOnlyBlockedReason: null,
          },
        }
      }
      if (op === 'curate.dry_run') {
        return {
          ok: true,
          data: {
            draftId: 'd-ro',
            draftRevision: 1,
            trackId: 'trk-1',
            approvalHash: 'hash-ro',
            readOnly: true,
            applyAvailable: false,
            blockReason: 'Apply is unavailable because /music is mounted read-only.',
            fileSha256: 'abc',
            fileSizeBytes: 128,
            changes: [{ field: 'title', before: 'A', after: 'B' }],
          },
        }
      }
      return { ok: false, error: { code: 'read_only_root' } }
    },
  }

  const ctrl = createRemoteCurateController({
    engineId: 'core-1',
    libraryId: 'lib-1',
    transport,
  })

  ctrl.bufferEdit('d-ro', 'trk-1', [{ field: 'title', before: 'A', after: 'B' }])
  await ctrl.saveBufferedDraft('d-ro', 'windows')
  const report = await ctrl.dryRun('d-ro')
  assert.equal(report.readOnly, true)
  assert.equal(report.applyAvailable, false)
  assert.match(report.blockReason ?? '', /read-only/i)

  await assert.rejects(() => ctrl.approve('d-ro', report.approvalHash, 'cmd-ro'), /read_only_root/)
  assert.equal(ctrl.getDraftState('d-ro')?.status, 'draft_saved')
})

test('shared-root writer exclusion blocks Windows local commits on Core-leased paths', () => {
  const leases: CoreRootLease[] = [
    {
      rootPath: '\\\\192.168.1.6\\Mathan\\Music Collection',
      engineId: 'core_13858f53085d46e3',
      label: 'Music Room Core',
    },
  ]

  assert.throws(
    () =>
      assertWindowsRootNotLeasedToCore(
        '\\\\192.168.1.6\\Mathan\\Music Collection\\Master\\Hindi\\Track.flac',
        leases,
      ),
    /Music Room Core/,
  )

  assert.doesNotThrow(() =>
    assertWindowsRootNotLeasedToCore('E:\\Mathan\\Music\\DSD\\Track.dsf', leases),
  )
})
