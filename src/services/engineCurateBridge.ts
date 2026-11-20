import type { EngineEnrichmentAlbumDetail } from '../core/coreProtocol'
import type { CurateDraft } from '../core/curateDraft'
import type { CurateCommitRow } from '../core/curateCommit'
import type { RemoteCurateFieldChange } from '../core/remoteCurate'
import type { CurationDecisionTrace, Release, Track } from '../core/types'
import type { NewCommitItemPayload } from '../types/commit'
import type { CurateEvidenceRun } from './curateEvidenceService'
import { stripCoreReleasePrefix, type EngineClient } from './engineClient'

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

export function deleteUiCurateDraft(
  albumId: string,
  engineId?: string,
  libraryId?: string,
): void {
  const key = `${DRAFT_STORAGE_PREFIX}${scopeKey(engineId, libraryId)}`
  const map = readJsonMap<CurateDraft>(key)
  if (!(albumId in map)) return
  delete map[albumId]
  writeJsonMap(key, map)
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

export interface EngineRawBaseline {
  release?: {
    album?: string
    albumArtist?: string
    composer?: string
    genre?: string
    year?: number | null
  }
  tracksById?: ReadonlyMap<
    string,
    {
      title?: string
      artist?: string
      albumArtist?: string
      year?: number | null
    }
  >
}

export function rawBaselineFromEnrichmentDetail(
  detail: EngineEnrichmentAlbumDetail | null | undefined,
): EngineRawBaseline | undefined {
  if (!detail) return undefined
  const tracksById = new Map<
    string,
    { title?: string; artist?: string; albumArtist?: string; year?: number | null }
  >()
  for (const t of detail.tracks) {
    tracksById.set(t.trackId, {
      title: t.title,
      artist: t.artist,
      albumArtist: t.albumArtist ?? undefined,
      year: t.releaseYear ?? null,
    })
  }
  return {
    release: {
      album: detail.rawTitle,
      albumArtist: detail.rawAlbumArtist ?? detail.rawArtist,
      composer: detail.rawComposer ?? undefined,
      genre: detail.rawGenre ?? undefined,
      year: detail.rawYear ?? null,
    },
    tracksById,
  }
}

const ENGINE_TAG_FIELD_MAP: Array<{
  payloadKey: string
  engineField: string
  getBefore: (track?: Track, release?: Release, rawBaseline?: EngineRawBaseline) => string
}> = [
  {
    payloadKey: 'title',
    engineField: 'title',
    getBefore: (t, _r, raw) => (t ? raw?.tracksById?.get(t.id)?.title : undefined) ?? t?.title ?? '',
  },
  {
    payloadKey: 'artist',
    engineField: 'artist',
    getBefore: (t, _r, raw) =>
      (t ? raw?.tracksById?.get(t.id)?.artist : undefined) ?? t?.artistCredit ?? '',
  },
  {
    payloadKey: 'album',
    engineField: 'album',
    getBefore: (t, r, raw) => raw?.release?.album ?? r?.title ?? t?.albumTitle ?? '',
  },
  {
    payloadKey: 'albumArtist',
    engineField: 'albumArtist',
    getBefore: (t, r, raw) =>
      (t ? raw?.tracksById?.get(t.id)?.albumArtist : undefined) ??
      raw?.release?.albumArtist ??
      t?.albumArtist ??
      r?.artistCredit ??
      '',
  },
  {
    payloadKey: 'composer',
    engineField: 'composer',
    getBefore: (t, r, raw) => raw?.release?.composer ?? t?.composerName ?? r?.composerName ?? '',
  },
  {
    payloadKey: 'genre',
    engineField: 'genre',
    getBefore: (t, r, raw) => raw?.release?.genre ?? t?.genre ?? r?.genreTags?.[0] ?? '',
  },
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
  rawBaseline?: EngineRawBaseline,
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
    const before = mapping.getBefore(track, release, rawBaseline)
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
  rawBaseline?: EngineRawBaseline
  rawBaselineByRelease?: ReadonlyMap<string, EngineRawBaseline>
  onProgress?: (current: number, total: number) => void
}): Promise<{
  submittedJobs: Array<{ jobId: string; draftId: string; trackId: string; payloadJson: string; status: string }>
  blockedReasons: string[]
}> {
  const {
    engineClient,
    items,
    tracks,
    releases,
    rawBaseline,
    rawBaselineByRelease,
    onProgress,
  } = options
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

  const planned = items.flatMap((item) => {
    const trk = trackMap.get(item.trackId)
    const rel = trk ? releaseMap.get(trk.releaseId) : undefined
    const trackRawBaseline =
      rawBaseline ??
      (trk
        ? rawBaselineByRelease?.get(trk.releaseId) ??
          rawBaselineByRelease?.get(stripCoreReleasePrefix(trk.releaseId))
        : undefined)
    const changes = buildEngineCurateChanges(item.payloadJson, trk, rel, trackRawBaseline)
    return changes.length > 0 ? [{ item, trk, changes }] : []
  })

  for (let i = 0; i < planned.length; i++) {
    const { item, trk, changes } = planned[i]
    onProgress?.(i + 1, planned.length)

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
