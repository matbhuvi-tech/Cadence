import {
  CORE_MAX_PAGE_TRACKS,
  CORE_PROTOCOL_VERSION_V2,
  CoreServiceError,
  parseCoreCatalogPage,
  parseCoreV2Descriptor,
  type CoreCatalogTrack,
  type CoreDescriptor,
  type CoreErrorCode,
  type EngineCurateDraftSummary,
  type EngineEventRecord,
  type EngineFolderRecord,
  type EngineFsBrowseResult,
  type EnginePlaylistDetail,
  type EnginePlaylistSummary,
  type EngineScanStatus,
} from '../core/coreProtocol'
import type {
  RemoteCurateApprovalReceipt,
  RemoteCurateDraftState,
  RemoteCurateDryRunReport,
  RemoteCurateFieldChange,
  RemoteCurateTransport,
} from '../core/remoteCurate'

export interface EngineRpcTarget {
  baseUrl: string
  pairingToken?: string
  certFingerprint?: string
  trustInsecure?: boolean
}

export interface EngineClientProfile extends EngineRpcTarget {
  engineId: string
  libraryId: string
  label: string
}

export type EnginePostFn = (target: EngineRpcTarget, body: Record<string, unknown>) => Promise<unknown>

export interface EngineArtworkFetchResult {
  status: number
  etag: string | null
  contentType: string
  base64: string | null
  bytes?: Uint8Array
}

export type EngineArtworkFetchFn = (
  target: EngineRpcTarget,
  releaseId: string,
  ifNoneMatch?: string,
) => Promise<EngineArtworkFetchResult>

export interface EngineClient {
  readonly profile: EngineClientProfile
  hello(): Promise<CoreDescriptor>
  fetchEnrichedCatalog(): Promise<{ revision: number; tracks: CoreCatalogTrack[] }>
  fsBrowse(path?: string): Promise<EngineFsBrowseResult>
  listFolders(): Promise<EngineFolderRecord[]>
  addFolder(input: {
    path: string
    displayName?: string
    scanMode?: 'manual' | 'startup'
  }): Promise<{ id: string }>
  removeFolder(folderId: string): Promise<void>
  scanFolders(input?: { folderId?: string; forceFull?: boolean }): Promise<EngineScanStatus>
  getScanStatus(): Promise<EngineScanStatus>
  listPlaylists(): Promise<EnginePlaylistSummary[]>
  getPlaylist(playlistId: string): Promise<EnginePlaylistDetail>
  createPlaylist(title: string, description?: string): Promise<EnginePlaylistDetail>
  updatePlaylist(playlistId: string, title: string, description?: string): Promise<EnginePlaylistDetail>
  deletePlaylist(playlistId: string): Promise<void>
  setPlaylistTracks(playlistId: string, trackIds: string[]): Promise<EnginePlaylistDetail>
  listSplitReleases(): Promise<string[]>
  toggleSplitRelease(releaseId: string): Promise<{ split: boolean }>
  listCurateDrafts(): Promise<EngineCurateDraftSummary[]>
  saveCurateDraft(draft: {
    draftId: string
    trackId: string
    expectedRevision: number | null
    changes: RemoteCurateFieldChange[]
    updatedBy: string
  }): Promise<RemoteCurateDraftState>
  dryRunCurateDraft(draftId: string): Promise<RemoteCurateDryRunReport>
  approveCurateDraft(
    draftId: string,
    approvalHash: string,
    commandId: string,
  ): Promise<RemoteCurateApprovalReceipt>
  getCurateJobStatus(jobId: string): Promise<{
    jobId: string
    draftId: string
    status: string
    errorMessage?: string | null
  }>
  fetchEvents(): Promise<EngineEventRecord[]>
  readonly curateTransport: RemoteCurateTransport
}

const KNOWN_ERROR_CODES = new Set<string>([
  'untrusted_peer',
  'incompatible_protocol',
  'unsupported_capability',
  'not_ready',
  'takeover_required',
  'invalid_payload',
  'identity_mismatch',
  'unauthorized',
  'stale_revision',
  'unavailable',
  'deferred_until_idle',
  'unauthorized_path',
  'not_found',
  'read_only_root',
  'external_file_changed',
  'duplicate_approval',
  'root_leased',
])

export function stripCoreReleasePrefix(releaseId: string): string {
  return releaseId.startsWith('core_rel_') ? releaseId.slice('core_rel_'.length) : releaseId
}

function unwrapV2Envelope<T>(raw: unknown): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoreServiceError('invalid_payload')
  }
  const obj = raw as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } }
  if (obj.ok === true) {
    return obj.data as T
  }
  const code = typeof obj.error?.code === 'string' && KNOWN_ERROR_CODES.has(obj.error.code)
    ? (obj.error.code as CoreErrorCode)
    : 'invalid_payload'
  const err = new CoreServiceError(code)
  if (typeof obj.error?.message === 'string' && obj.error.message.trim()) {
    err.message = obj.error.message
  }
  throw err
}

export function createEngineClient(
  profile: EngineClientProfile,
  postRequest: EnginePostFn,
): EngineClient {
  const target: EngineRpcTarget = {
    baseUrl: profile.baseUrl,
    pairingToken: profile.pairingToken,
    certFingerprint: profile.certFingerprint,
    trustInsecure: profile.trustInsecure,
  }

  async function call<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
    const raw = await postRequest(target, {
      protocolVersion: CORE_PROTOCOL_VERSION_V2,
      engineId: profile.engineId,
      libraryId: profile.libraryId,
      operation,
      ...payload,
    })
    return unwrapV2Envelope<T>(raw)
  }

  const curateTransport: RemoteCurateTransport = {
    async request(operation, payload) {
      const raw = await postRequest(target, {
        protocolVersion: CORE_PROTOCOL_VERSION_V2,
        engineId: profile.engineId,
        libraryId: profile.libraryId,
        operation,
        ...payload,
      })
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: { code: 'invalid_payload' } }
      }
      return raw as { ok: boolean; data?: unknown; error?: { code?: string } }
    },
  }

  return {
    profile,

    async hello() {
      const data = await call<unknown>('core.hello')
      return parseCoreV2Descriptor(data, {
        kind: 'core',
        engineId: profile.engineId,
        libraryId: profile.libraryId,
        label: profile.label,
      })
    },

    async fetchEnrichedCatalog() {
      const merged: CoreCatalogTrack[] = []
      const seen = new Set<string>()
      let cursor: string | null = null
      let revision = 0
      for (let pageIndex = 0; pageIndex < 150; pageIndex++) {
        const rawPage = await call<unknown>('catalog.page', {
          cursor,
          limit: CORE_MAX_PAGE_TRACKS,
        })
        const page = parseCoreCatalogPage(rawPage)
        revision = page.revision
        for (const trk of page.tracks) {
          if (!seen.has(trk.id)) {
            seen.add(trk.id)
            merged.push(trk)
          }
        }
        if (!page.nextCursor || page.nextCursor === cursor) {
          break
        }
        cursor = page.nextCursor
      }
      return { revision, tracks: merged }
    },

    fsBrowse: (path) => call<EngineFsBrowseResult>('fs.browse', path ? { path } : {}),

    listFolders: async () => {
      const res = await call<{ folders: EngineFolderRecord[] }>('folders.list')
      return res.folders ?? []
    },

    addFolder: (input) =>
      call<{ id: string }>('folders.add', {
        path: input.path,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        scanMode: input.scanMode ?? 'manual',
      }),

    removeFolder: async (folderId) => {
      await call<{ removed: boolean }>('folders.remove', { folderId })
    },

    scanFolders: (input) =>
      call<EngineScanStatus>('folders.scan', {
        ...(input?.folderId ? { folderId: input.folderId } : {}),
        forceFull: Boolean(input?.forceFull),
      }),

    getScanStatus: () => call<EngineScanStatus>('folders.scan.status'),

    listPlaylists: async () => {
      const res = await call<{ playlists: EnginePlaylistSummary[] }>('playlists.list')
      return res.playlists ?? []
    },

    getPlaylist: (playlistId) => call<EnginePlaylistDetail>('playlists.get', { playlistId }),

    createPlaylist: (title, description) =>
      call<EnginePlaylistDetail>('playlists.create', {
        title,
        ...(description ? { description } : {}),
      }),

    updatePlaylist: (playlistId, title, description) =>
      call<EnginePlaylistDetail>('playlists.update', {
        playlistId,
        title,
        description: description ?? null,
      }),

    deletePlaylist: async (playlistId) => {
      await call<{ deleted: boolean }>('playlists.delete', { playlistId })
    },

    setPlaylistTracks: (playlistId, trackIds) =>
      call<EnginePlaylistDetail>('playlists.setTracks', { playlistId, trackIds }),

    listSplitReleases: async () => {
      const res = await call<{ releaseIds: string[] }>('releases.split.list')
      return res.releaseIds ?? []
    },

    toggleSplitRelease: (releaseId) =>
      call<{ split: boolean }>('releases.split.toggle', {
        releaseId: stripCoreReleasePrefix(releaseId),
      }),

    listCurateDrafts: async () => {
      const res = await call<{ drafts: EngineCurateDraftSummary[] }>('curate.draft.list')
      return res.drafts ?? []
    },

    saveCurateDraft: (draft) =>
      call<RemoteCurateDraftState>('curate.draft.save', { draft }),

    dryRunCurateDraft: (draftId) =>
      call<RemoteCurateDryRunReport>('curate.dry_run', { draftId }),

    approveCurateDraft: (draftId, approvalHash, commandId) =>
      call<RemoteCurateApprovalReceipt>('curate.approve', {
        draftId,
        approvalHash,
        commandId,
      }),

    getCurateJobStatus: (jobId) =>
      call<{
        jobId: string
        draftId: string
        status: string
        errorMessage?: string | null
      }>('curate.job.status', { jobId }),

    fetchEvents: async () => {
      const res = await call<{ events: EngineEventRecord[] }>('engine.events')
      return res.events ?? []
    },

    curateTransport,
  }
}

export interface EngineArtworkCache {
  getOrFetch(
    profile: EngineClientProfile,
    rawReleaseId: string,
    revision: number,
  ): Promise<string | null>
  getCached(engineId: string, rawReleaseId: string, revision: number): string | null
  clear(): void
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function createBrowserArtworkFetch(): EngineArtworkFetchFn {
  return async (target, releaseId, ifNoneMatch) => {
    const cleanBase = target.baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (target.pairingToken) {
      headers['x-cadence-token'] = target.pairingToken
    }
    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch
    }
    const res = await fetch(`${cleanBase}/v1/artwork/${encodeURIComponent(releaseId)}`, {
      method: 'GET',
      headers,
      redirect: 'error',
    })
    const etag = res.headers.get('etag')
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    if (res.status === 304 || res.status === 404 || res.status === 503) {
      return { status: res.status, etag, contentType, base64: null }
    }
    if (!res.ok) {
      throw new CoreServiceError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'unavailable')
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, etag, contentType, base64: null, bytes: buf }
  }
}

export function createEngineArtworkCache(options: {
  fetchArtwork: EngineArtworkFetchFn
  maxEntries?: number
  maxConcurrent?: number
}): EngineArtworkCache {
  const maxEntries = options.maxEntries ?? 256
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2)
  const cache = new Map<string, { objectUrl: string | null; etag: string | null; miss?: boolean }>()
  const inFlight = new Map<string, Promise<string | null>>()
  const waitQueue: Array<() => void> = []
  let active = 0

  function makeKey(engineId: string, releaseId: string, revision: number): string {
    return `${engineId}::${releaseId}::${revision}`
  }

  function touchEntry(
    key: string,
    value: { objectUrl: string | null; etag: string | null; miss?: boolean },
  ) {
    if (cache.has(key)) {
      cache.delete(key)
    }
    cache.set(key, value)
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value
      if (!oldestKey) break
      const evicted = cache.get(oldestKey)
      cache.delete(oldestKey)
      if (evicted?.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(evicted.objectUrl)
      }
    }
  }

  async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => {
        waitQueue.push(resolve)
      })
    }
    active++
    try {
      return await task()
    } finally {
      active--
      const next = waitQueue.shift()
      next?.()
    }
  }

  return {
    getCached(engineId, rawReleaseId, revision) {
      const cleanId = stripCoreReleasePrefix(rawReleaseId)
      const entry = cache.get(makeKey(engineId, cleanId, revision))
      return entry?.objectUrl ?? null
    },

    async getOrFetch(profile, rawReleaseId, revision) {
      const cleanId = stripCoreReleasePrefix(rawReleaseId)
      if (!cleanId) return null
      const key = makeKey(profile.engineId, cleanId, revision)
      const existing = cache.get(key)
      if (existing) {
        if (existing.miss) return null
        if (existing.objectUrl) {
          touchEntry(key, existing)
          return existing.objectUrl
        }
      }
      const pending = inFlight.get(key)
      if (pending) return pending

      const promise = withSlot(async (): Promise<string | null> => {
        try {
          const res = await options.fetchArtwork(
            {
              baseUrl: profile.baseUrl,
              pairingToken: profile.pairingToken,
              certFingerprint: profile.certFingerprint,
              trustInsecure: profile.trustInsecure,
            },
            cleanId,
            existing?.etag ?? undefined,
          )
          if (res.status === 304 && existing?.objectUrl) {
            return existing.objectUrl
          }
          if (res.status === 404) {
            touchEntry(key, { objectUrl: null, etag: res.etag, miss: true })
            return null
          }
          if (res.status === 503) {
            // Playback/cooldown active on Engine — do not cache as permanent miss
            return null
          }
          const rawBytes = res.bytes ?? (res.base64 ? base64ToUint8Array(res.base64) : null)
          if (!rawBytes || rawBytes.byteLength === 0) {
            return null
          }
          if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            return null
          }
          const arrayBuffer = rawBytes.slice().buffer
          const blob = new Blob([arrayBuffer], { type: res.contentType || 'image/jpeg' })
          const objectUrl = URL.createObjectURL(blob)
          touchEntry(key, { objectUrl, etag: res.etag })
          return objectUrl
        } catch {
          return null
        } finally {
          inFlight.delete(key)
        }
      })

      inFlight.set(key, promise)
      return promise
    },

    clear() {
      for (const entry of cache.values()) {
        if (entry.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(entry.objectUrl)
        }
      }
      cache.clear()
      inFlight.clear()
    },
  }
}
