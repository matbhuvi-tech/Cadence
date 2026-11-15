export type RemoteCurateStatus =
  | 'waiting_to_save'
  | 'draft_saved'
  | 'approved_waiting_idle'
  | 'cooling_down'
  | 'applying'
  | 'verified'
  | 'failed'

export interface RemoteCurateFieldChange {
  field: string
  before: string
  after: string
}

export interface RemoteCurateDraftState {
  draftId: string
  trackId: string
  revision: number
  changes: RemoteCurateFieldChange[]
  status: RemoteCurateStatus
  durable: boolean
  approvalHash: string | null
  readOnlyBlockedReason: string | null
}

export interface RemoteCurateDryRunReport {
  draftId: string
  draftRevision: number
  trackId: string
  approvalHash: string
  readOnly: boolean
  applyAvailable: boolean
  blockReason: string | null
  fileSha256: string
  fileSizeBytes: number
  changes: RemoteCurateFieldChange[]
}

export interface RemoteCurateApprovalReceipt {
  jobId: string
  draftId: string
  approvalHash: string
  status: RemoteCurateStatus
}

export interface CoreRootLease {
  rootPath: string
  engineId: string
  label: string
}

export interface RemoteCurateTransport {
  request(
    operation:
      | 'curate.draft.save'
      | 'curate.dry_run'
      | 'curate.approve'
      | 'curate.job.status',
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: { code?: string } }>
}

export function formatRemoteCurateStatusLabel(status: RemoteCurateStatus): string {
  switch (status) {
    case 'waiting_to_save':
      return 'Waiting to save'
    case 'draft_saved':
      return 'Draft saved'
    case 'approved_waiting_idle':
      return 'Approved / Waiting for playback to stop'
    case 'cooling_down':
      return 'Cooling down'
    case 'applying':
      return 'Applying'
    case 'verified':
      return 'Verified'
    case 'failed':
      return 'Failed'
  }
}

function normalizeRootPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function assertWindowsRootNotLeasedToCore(
  targetPath: string,
  leases: readonly CoreRootLease[],
): void {
  const normalizedTarget = normalizeRootPath(targetPath)
  for (const lease of leases) {
    const normalizedLease = normalizeRootPath(lease.rootPath)
    if (!normalizedLease) continue
    if (
      normalizedTarget === normalizedLease ||
      normalizedTarget.startsWith(`${normalizedLease}/`)
    ) {
      throw new Error(
        `Shared-root writer exclusion: '${targetPath}' is leased to ${lease.label} (${lease.engineId}). Commit through Core instead of standalone Windows writes.`,
      )
    }
  }
}

export function createRemoteCurateController(options: {
  engineId: string
  libraryId: string
  transport: RemoteCurateTransport
}) {
  const drafts = new Map<string, RemoteCurateDraftState>()

  return {
    getDraftState(draftId: string): RemoteCurateDraftState | undefined {
      return drafts.get(draftId)
    },

    bufferEdit(
      draftId: string,
      trackId: string,
      changes: RemoteCurateFieldChange[],
    ): RemoteCurateDraftState {
      const existing = drafts.get(draftId)
      const next: RemoteCurateDraftState = {
        draftId,
        trackId,
        revision: existing?.revision ?? 0,
        changes: [...changes],
        status: 'waiting_to_save',
        durable: false,
        approvalHash: null,
        readOnlyBlockedReason: null,
      }
      drafts.set(draftId, next)
      return next
    },

    async saveBufferedDraft(
      draftId: string,
      updatedBy: string,
    ): Promise<RemoteCurateDraftState> {
      const buffered = drafts.get(draftId)
      if (!buffered) {
        throw new Error(`No buffered draft found for ${draftId}`)
      }
      const res = await options.transport.request('curate.draft.save', {
        engineId: options.engineId,
        libraryId: options.libraryId,
        draftId: buffered.draftId,
        trackId: buffered.trackId,
        expectedRevision: buffered.revision > 0 ? buffered.revision : null,
        changes: buffered.changes,
        updatedBy,
      })
      if (!res.ok || !res.data || typeof res.data !== 'object') {
        throw new Error(res.error?.code ?? 'curate_save_failed')
      }
      const data = res.data as {
        revision: number
        status: RemoteCurateStatus
        approvalHash: string | null
        readOnlyBlockedReason: string | null
      }
      const saved: RemoteCurateDraftState = {
        ...buffered,
        revision: data.revision,
        status: data.status ?? 'draft_saved',
        durable: true,
        approvalHash: data.approvalHash ?? null,
        readOnlyBlockedReason: data.readOnlyBlockedReason ?? null,
      }
      drafts.set(draftId, saved)
      return saved
    },

    async dryRun(draftId: string): Promise<RemoteCurateDryRunReport> {
      const res = await options.transport.request('curate.dry_run', {
        engineId: options.engineId,
        libraryId: options.libraryId,
        draftId,
      })
      if (!res.ok || !res.data) {
        throw new Error(res.error?.code ?? 'curate_dry_run_failed')
      }
      const report = res.data as RemoteCurateDryRunReport
      const current = drafts.get(draftId)
      if (current && report.blockReason) {
        drafts.set(draftId, {
          ...current,
          readOnlyBlockedReason: report.blockReason,
        })
      }
      return report
    },

    async approve(
      draftId: string,
      approvalHash: string,
      commandId: string,
    ): Promise<RemoteCurateApprovalReceipt> {
      const res = await options.transport.request('curate.approve', {
        engineId: options.engineId,
        libraryId: options.libraryId,
        draftId,
        approvalHash,
        commandId,
      })
      if (!res.ok || !res.data) {
        throw new Error(res.error?.code ?? 'curate_approve_failed')
      }
      const receipt = res.data as RemoteCurateApprovalReceipt
      const current = drafts.get(draftId)
      if (current) {
        drafts.set(draftId, {
          ...current,
          status: receipt.status,
          approvalHash: receipt.approvalHash,
        })
      }
      return receipt
    },

    async pollJobStatus(jobId: string): Promise<RemoteCurateApprovalReceipt> {
      const res = await options.transport.request('curate.job.status', {
        engineId: options.engineId,
        libraryId: options.libraryId,
        jobId,
      })
      if (!res.ok || !res.data) {
        throw new Error(res.error?.code ?? 'curate_job_status_failed')
      }
      return res.data as RemoteCurateApprovalReceipt
    },
  }
}
