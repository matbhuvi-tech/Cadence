import type { CurateDraft } from '../core/curateDraft'
import type { CurateCommitRow } from '../core/curateCommit'
import type { RemoteCurateFieldChange } from '../core/remoteCurate'
import type { CurationDecisionTrace, Release, Track } from '../core/types'
import type { NewCommitItemPayload } from '../types/commit'
import type { CurateEvidenceRun } from './curateEvidenceService'
import type { EngineClient } from './engineClient'

const DRAFT_STORAGE_PREFIX = 'cadence:curate_ui_drafts:v1:'
const TRACE_STORAGE_PREFIX = 'cadence:curate_ui_traces:v1:'
const EVIDENCE_STORAGE_PREFIX = 'cadence:curate_ui_evidence:v1:'

function scopeKey(engineId = 'default', libraryId = 'default'): string {
  return `${engineId}::${libraryId}`
}

function readJsonMap<T>(key: string): Record<string, T> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeJsonMap<T>(key: string, value: Record<string, T>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore storage quota errors
  }
}

export function loadUiCurateDraft(
  albumId: string,
  engineId?: string,
  libraryId?: string,
): CurateDraft | null {
  const map = readJsonMap<CurateDraft>(`${DRAFT_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`)
  return map[albumId] ?? null
}

export function saveUiCurateDraft(
  albumId: string,
  draft: CurateDraft,
  engineId?: string,
  libraryId?: string,
): void {
  const key = `${DRAFT_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`
  const map = readJsonMap<CurateDraft>(key)
  map[albumId] = draft
  writeJsonMap(key, map)
}

export function listUiCurateDrafts(
  engineId?: string,
  libraryId?: string,
): Record<string, CurateDraft> {
  return readJsonMap<CurateDraft>(`${DRAFT_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`)
}

export function loadUiCurationTrace(
  albumId: string,
  engineId?: string,
  libraryId?: string,
): CurationDecisionTrace | null {
  const map = readJsonMap<CurationDecisionTrace>(`${TRACE_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`)
  return map[albumId] ?? null
}

interface StoredEvidenceEntry {
  run: CurateEvidenceRun
  current: boolean
}

export function saveUiCurationEvidence(
  albumId: string,
  run: CurateEvidenceRun,
  engineId?: string,
  libraryId?: string,
): boolean {
  const evKey = `${EVIDENCE_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`
  const evMap = readJsonMap<StoredEvidenceEntry[]>(evKey)
  const existing = (evMap[albumId] ?? []).map((entry) => ({ ...entry, current: false }))
  evMap[albumId] = [{ run, current: true }, ...existing].slice(0, 6)
  writeJsonMap(evKey, evMap)

  if (run.decision) {
    const trKey = `${TRACE_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`
    const trMap = readJsonMap<CurationDecisionTrace>(trKey)
    trMap[albumId] = run.decision
    writeJsonMap(trKey, trMap)
  }
  return true
}

export function listUiCurationEvidence(
  albumId: string,
  engineId?: string,
  libraryId?: string,
): Array<{
  id: string
  current: boolean
  trigger: CurateEvidenceRun['trigger']
  requestedAt: string
  completedAt: string
  outcome: CurateEvidenceRun['outcome']
  applicability?: CurateEvidenceRun['applicability']
}> {
  const evMap = readJsonMap<StoredEvidenceEntry[]>(`${EVIDENCE_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`)
  return (evMap[albumId] ?? []).map((entry) => ({
    id: entry.run.id,
    current: Boolean(entry.current),
    trigger: entry.run.trigger,
    requestedAt: entry.run.requestedAt,
    completedAt: entry.run.completedAt,
    outcome: entry.run.outcome,
    applicability: entry.run.applicability,
  }))
}

export function getUiCurationEvidence(
  albumId: string,
  evidenceId: string,
  engineId?: string,
  libraryId?: string,
): CurateEvidenceRun | null {
  const evMap = readJsonMap<StoredEvidenceEntry[]>(`${EVIDENCE_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`)
  return (evMap[albumId] ?? []).find((entry) => entry.run.id === evidenceId)?.run ?? null
}

const ENGINE_TAG_FIELD_MAP: Array<{
  payloadKey: string
  engineField: string
  getBefore: (track?: Track, release?: Release) => string
}> = [
  { payloadKey: 'title', engineField: 'title', getBefore: (t) => t?.title ?? '' },
  { payloadKey: 'artist', engineField: 'artist', getBefore: (t) => t?.artistCredit ?? '' },
  { payloadKey: 'album', engineField: 'album', getBefore: (t, r) => r?.title ?? t?.albumTitle ?? '' },
  { payloadKey: 'albumArtist', engineField: 'albumArtist', getBefore: (t, r) => t?.albumArtist ?? r?.artistCredit ?? '' },
  { payloadKey: 'composer', engineField: 'composer', getBefore: (t, r) => t?.composerName ?? r?.composerName ?? '' },
  { payloadKey: 'genre', engineField: 'genre', getBefore: (t, r) => t?.genre ?? r?.genreTags?.[0] ?? '' },
  { payloadKey: 'originalAlbum', engineField: 'originalAlbum', getBefore: (t) => t?.originalAlbum ?? '' },
  {
    payloadKey: 'originalYear',
    engineField: 'originalYear',
    getBefore: (t) => (t?.originalYear ? String(t.originalYear) : ''),
  },
  { payloadKey: 'lyrics', engineField: 'lyrics', getBefore: (t) => t?.lyrics ?? '' },
]

export function buildEngineCurateChanges(
  payloadJson: string,
  track?: Track,
  release?: Release,
): RemoteCurateFieldChange[] {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(payloadJson) as Record<string, unknown>
  } catch {
    return []
  }
  const changes: RemoteCurateFieldChange[] = []
  for (const mapping of ENGINE_TAG_FIELD_MAP) {
    const rawVal = parsed[mapping.payloadKey]
    if (rawVal === undefined || rawVal === null) continue
    const after = String(rawVal).trim()
    if (!after) continue
    const before = mapping.getBefore(track, release)
    if (before === after) continue
    changes.push({
      field: mapping.engineField,
      before,
      after,
    })
  }
  return changes
}

export async function submitCurateItemsToEngine(options: {
  engineClient: EngineClient
  items: readonly NewCommitItemPayload[]
  tracks: readonly Track[]
  releases: readonly Release[]
}): Promise<{
  submittedJobs: Array<{ jobId: string; draftId: string; trackId: string; payloadJson: string; status: string }>
  blockedReasons: string[]
}> {
  const { engineClient, items, tracks, releases } = options
  const trackMap = new Map(tracks.map((t) => [t.id, t]))
  const releaseMap = new Map(releases.map((r) => [r.id, r]))
  const existingDrafts = await engineClient.listCurateDrafts().catch(() => [])
  const revisionByDraftId = new Map(existingDrafts.map((d) => [d.draftId, d.revision]))

  const submittedJobs: Array<{
    jobId: string
    draftId: string
    trackId: string
    payloadJson: string
    status: string
  }> = []
  const blockedReasons: string[] = []

  for (const item of items) {
    const trk = trackMap.get(item.trackId)
    const rel = trk ? releaseMap.get(trk.releaseId) : undefined
    const changes = buildEngineCurateChanges(item.payloadJson, trk, rel)
    if (changes.length === 0) continue

    const draftId = `curate_${item.trackId}`
    const expectedRevision = revisionByDraftId.get(draftId) ?? null
    const saved = await engineClient.saveCurateDraft({
      draftId,
      trackId: item.trackId,
      expectedRevision,
      changes,
      updatedBy: 'cadence-desktop',
    })
    revisionByDraftId.set(draftId, saved.revision)

    const dryRun = await engineClient.dryRunCurateDraft(draftId)
    if (!dryRun.applyAvailable || dryRun.readOnly) {
      blockedReasons.push(
        dryRun.blockReason || `${trk?.title || item.trackId}: tag write unavailable on this Engine.`,
      )
      continue
    }

    const commandId = `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const receipt = await engineClient.approveCurateDraft(draftId, dryRun.approvalHash, commandId)
    submittedJobs.push({
      jobId: receipt.jobId,
      draftId: receipt.draftId,
      trackId: item.trackId,
      payloadJson: item.payloadJson,
      status: receipt.status,
    })
  }

  return { submittedJobs, blockedReasons }
}

export function mapEngineJobStatusToCommitStatus(
  status: string,
): CurateCommitRow['status'] {
  switch (status) {
    case 'verified':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'applying':
      return 'in_flight'
    default:
      return 'pending'
  }
}
