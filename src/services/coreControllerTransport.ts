import {
  CORE_MAX_MESSAGE_BYTES,
  CORE_MAX_PAGE_TRACKS,
  CORE_PROTOCOL_VERSION,
  CoreServiceError,
  parseCoreSnapshot,
  type CoreCatalogPage,
  type CoreCatalogTrack,
  type CoreCommand,
  type CoreDescriptor,
  type CoreRequest,
  type CoreSnapshot,
} from '../core/coreProtocol'
import { createEngineClient } from './engineClient'
import type { EngineActivity, EngineContext } from '../core/engineSession'
import type { AudioEndpoint } from '../core/endpointRouting'
import {
  createLocalEngineService,
  createRemoteEngineService,
  type AuthenticatedCoreChannel,
  type EngineService,
  type LocalEngineOwner,
} from './engineService'
import { createEngineServiceController, type EngineServiceView } from './engineServiceController'

export interface SavedCoreProfile {
  engineId: string
  libraryId: string
  label: string
  baseUrl: string
  certFingerprint?: string
  pairingToken?: string
  trustInsecure?: boolean
  musicRoots: string[]
  pinnedOutputId?: string
  pinnedOutputLabel?: string
}

export interface CoreHealthMetadata {
  ready?: boolean
  engineId?: string
  libraryId?: string
  label?: string
  tlsFingerprintSha256?: string
  pinnedRs130Udn?: string | null
  musicReadOnly?: boolean
}

export interface DiscoveredCoreNode {
  engineId: string
  libraryId: string
  label: string
  baseUrl: string
  certFingerprint?: string
  pinnedRs130Udn?: string | null
  pairingToken?: string
}

export interface StagedCoreCandidate {
  profile: SavedCoreProfile
  descriptor: CoreDescriptor
  snapshot: CoreSnapshot
  health: CoreHealthMetadata | null
  needsMusicRoots: boolean
}

export type CoreSwitchPrompt =
  | {
      kind: 'local_to_core'
      target: SavedCoreProfile
      sourceActivity: EngineActivity
    }
  | {
      kind: 'core_to_local'
      sourceActivity: EngineActivity
      coreLabel: string
    }
  | {
      kind: 'rs130_takeover'
      endpoint: AudioEndpoint
      coreLabel: string
      onConfirm: () => Promise<void>
    }
  | {
      kind: 'external_rs130_takeover'
      coreLabel: string
      trackId: string
      onConfirm: () => Promise<void>
    }

export interface CoreControllerState {
  view: EngineServiceView
  hydratedCatalogTracks: CoreCatalogTrack[]
  savedCores: SavedCoreProfile[]
  discoveredCores: DiscoveredCoreNode[]
  isDiscovering: boolean
  isBusy: boolean
  activeProfile: SavedCoreProfile | null
  activeDescriptor: CoreDescriptor | null
  musicReadOnly: boolean | null
  stagedCandidate: StagedCoreCandidate | null
  stagingError: string | null
  switchPrompt: CoreSwitchPrompt | null
  statusAnnouncement: string
  lastError: string | null
  startupConnection?: {
    profile: SavedCoreProfile
    attempt: number
    phase: 'checking' | 'waiting' | 'ready' | 'failed'
    error?: string
  }
}

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface LocalOwnerPort extends LocalEngineOwner {
  getActivity: () => EngineActivity
  stopAndAcknowledge: () => Promise<boolean>
  onLocalAutoPlayCheck?: () => void
}

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
export type CoreCommandInput = DistributiveOmit<CoreCommand, 'commandId' | 'expectedRevision'>

const normalizeFingerprint = (value: string) => value.replace(/[^0-9a-f]/gi, '').toLowerCase()

export function isLoopbackEngineUrl(url: string): boolean {
  return /^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i.test(url)
}

const SAVED_CORES_STORAGE_KEY = 'cadence:core_profiles:v1'

export function normalizeCoreBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new CoreServiceError('invalid_payload')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new CoreServiceError('invalid_payload')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CoreServiceError('invalid_payload')
  }
  const port = parsed.port || '4040'
  return `${parsed.protocol}//${parsed.hostname}:${port}`
}

export function formatCoreFingerprint(fp?: string): string {
  if (!fp) return ''
  const clean = fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  return clean.match(/.{1,4}/g)?.join(' ') ?? clean
}

export function loadSavedCoreProfiles(storage?: StorageLike | null): SavedCoreProfile[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(SAVED_CORES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is SavedCoreProfile =>
        Boolean(item) &&
        typeof item.engineId === 'string' &&
        typeof item.libraryId === 'string' &&
        typeof item.label === 'string' &&
        typeof item.baseUrl === 'string' &&
        Array.isArray(item.musicRoots),
    )
  } catch {
    return []
  }
}

export function saveCoreProfiles(storage: StorageLike | null | undefined, profiles: SavedCoreProfile[]): void {
  if (!storage) return
  try {
    storage.setItem(SAVED_CORES_STORAGE_KEY, JSON.stringify(profiles))
  } catch {
    // Restricted WebView2 storage must never crash the controller UI
  }
}

export function buildCoreContextFromProfile(profile: SavedCoreProfile): EngineContext {
  return {
    kind: 'core',
    engineId: profile.engineId,
    libraryId: profile.libraryId,
    label: profile.label,
  }
}

export interface HttpCoreTransportBridge {
  probeHealth: (profile: Pick<SavedCoreProfile, 'baseUrl' | 'certFingerprint' | 'pairingToken' | 'trustInsecure'>) => Promise<CoreHealthMetadata>
  postCoreRequest: (
    profile: Pick<SavedCoreProfile, 'baseUrl' | 'certFingerprint' | 'pairingToken' | 'trustInsecure'>,
    request: CoreRequest | Record<string, unknown>,
  ) => Promise<unknown>
}

export function createFetchHttpCoreBridge(): HttpCoreTransportBridge {
  async function readBoundedJson(response: Response): Promise<unknown> {
    if (response.redirected) {
      throw new CoreServiceError('untrusted_peer')
    }
    const contentLengthHeader = response.headers.get('content-length')
    if (contentLengthHeader) {
      const len = Number(contentLengthHeader)
      if (Number.isFinite(len) && len > CORE_MAX_MESSAGE_BYTES) {
        throw new CoreServiceError('invalid_payload')
      }
    }
    const buf = await response.arrayBuffer()
    if (buf.byteLength > CORE_MAX_MESSAGE_BYTES) {
      throw new CoreServiceError('invalid_payload')
    }
    const text = new TextDecoder().decode(buf)
    try {
      return JSON.parse(text)
    } catch {
      throw new CoreServiceError('invalid_payload')
    }
  }

  return {
    async probeHealth(profile) {
      const base = normalizeCoreBaseUrl(profile.baseUrl)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const headers: Record<string, string> = {}
        if (profile.pairingToken) {
          headers['x-cadence-token'] = profile.pairingToken
        }
        const res = await fetch(`${base}/healthz`, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: controller.signal,
        })
        if (res.status === 401 || res.status === 403) {
          throw new CoreServiceError('unauthorized')
        }
        if (!res.ok) {
          throw new CoreServiceError('unavailable')
        }
        const parsed = await readBoundedJson(res)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new CoreServiceError('invalid_payload')
        }
        return parsed as CoreHealthMetadata
      } catch (err) {
        if (err instanceof CoreServiceError) throw err
        throw new CoreServiceError('unavailable')
      } finally {
        clearTimeout(timer)
      }
    },

    async postCoreRequest(profile, req) {
      const base = normalizeCoreBaseUrl(profile.baseUrl)
      const controller = new AbortController()
      const op = typeof req.operation === 'string' ? req.operation : ''
      const admitsTrack =
        req.operation === 'queue.replace' ||
        (req.operation === 'playback.control' && req.action === 'play') ||
        (req.operation === 'queue.control' && req.action !== 'modes')
      const timeoutMs = admitsTrack ? 180_000 : op.startsWith('curate.') ? 90_000 : 15_000
      // The Windows engine can synchronously admit large DSD files from NAS while idle.
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (profile.pairingToken) {
          headers['x-cadence-token'] = profile.pairingToken
        }
        const res = await fetch(`${base}/v1/core`, {
          method: 'POST',
          headers,
          body: JSON.stringify(req),
          redirect: 'error',
          signal: controller.signal,
        })
        if (res.status === 401 || res.status === 403) {
          throw new CoreServiceError('unauthorized')
        }
        if (!res.ok) {
          throw new CoreServiceError('unavailable')
        }
        return await readBoundedJson(res)
      } catch (err) {
        if (err instanceof CoreServiceError) throw err
        throw new CoreServiceError('unavailable')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function createAuthenticatedHttpChannel(
  profile: SavedCoreProfile,
  bridge: HttpCoreTransportBridge,
): AuthenticatedCoreChannel {
  let cachedHealth: CoreHealthMetadata | null = null
  return {
    async verifyPeer() {
      const health = cachedHealth ?? (await bridge.probeHealth(profile))
      cachedHealth = health
      if (profile.certFingerprint && health.tlsFingerprintSha256) {
        const expectedFp = profile.certFingerprint.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
        const observedFp = health.tlsFingerprintSha256.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
        if (expectedFp && observedFp && expectedFp !== observedFp) {
          throw new CoreServiceError('untrusted_peer')
        }
      }
      if (
        (health.engineId && health.engineId !== profile.engineId) ||
        (health.libraryId && health.libraryId !== profile.libraryId)
      ) {
        throw new CoreServiceError('identity_mismatch')
      }
      if (health.ready === false) {
        throw new CoreServiceError('not_ready')
      }
      return {
        authenticated: true,
        engineId: health.engineId || profile.engineId,
        libraryId: health.libraryId || profile.libraryId,
      }
    },
    async request(req: CoreRequest) {
      cachedHealth = null
      return bridge.postCoreRequest(profile, req)
    },
  }
}

export async function probeCoreNodeAddress(
  rawUrl: string,
  options: {
    label?: string
    pairingToken?: string
    certFingerprint?: string
    trustInsecure?: boolean
    musicRoots?: string[]
  },
  bridge: HttpCoreTransportBridge,
): Promise<{ profile: SavedCoreProfile; health: CoreHealthMetadata }> {
  const baseUrl = normalizeCoreBaseUrl(rawUrl)
  const health = await bridge.probeHealth({
    baseUrl,
    certFingerprint: options.certFingerprint,
    pairingToken: options.pairingToken,
    trustInsecure: options.trustInsecure,
  })
  if (
    options.certFingerprint &&
    health.tlsFingerprintSha256 &&
    options.certFingerprint.replace(/[^0-9a-fA-F]/g, '').toLowerCase() !==
      health.tlsFingerprintSha256.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  ) {
    throw new CoreServiceError('untrusted_peer')
  }
  const engineId = health.engineId || ''
  const libraryId = health.libraryId || ''
  if (!engineId || !libraryId) {
    throw new CoreServiceError('invalid_payload')
  }
  return {
    profile: {
      engineId,
      libraryId,
      label: options.label?.trim() || health.label?.trim() || 'Cadence Core',
      baseUrl,
      certFingerprint: health.tlsFingerprintSha256 || options.certFingerprint,
      pairingToken: options.pairingToken?.trim() || undefined,
      trustInsecure: Boolean(options.trustInsecure),
      musicRoots: options.musicRoots ?? [],
      pinnedOutputId: health.pinnedRs130Udn ?? undefined,
      pinnedOutputLabel: health.pinnedRs130Udn ? 'RS130' : undefined,
    },
    health,
  }
}

export interface DesktopCoreControllerStoreOptions {
  localOwner: LocalOwnerPort
  storage?: StorageLike | null
  channelFactory?: (profile: SavedCoreProfile) => AuthenticatedCoreChannel
  httpBridge?: HttpCoreTransportBridge
  readLocalPairingEndpoint?: () => Promise<DiscoveredCoreNode | null>
  discoverNodes?: () => Promise<DiscoveredCoreNode[]>
  generateCommandId?: () => string
}

export function createDesktopCoreControllerStore(options: DesktopCoreControllerStoreOptions) {
  const httpBridge = options.httpBridge ?? createFetchHttpCoreBridge()
  const channelFactory =
    options.channelFactory ?? ((profile: SavedCoreProfile) => createAuthenticatedHttpChannel(profile, httpBridge))
  const wrappedLocalOwner: LocalOwnerPort = {
    ...options.localOwner,
    async request(req: CoreRequest): Promise<unknown> {
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          data: {
            protocolVersion: CORE_PROTOCOL_VERSION,
            engineId: 'local',
            libraryId: 'local',
            label: 'This PC',
            capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
            ready: true,
          },
        }
      }
      if (req.operation === 'session.snapshot') {
        return {
          ok: true,
          data: {
            engineId: 'local',
            libraryId: 'local',
            revision: 0,
            catalog: { revision: 0, tracks: [], nextCursor: null },
            queue: { entries: [], currentEntryId: null, repeat: 'off', shuffle: false },
            playback: { activity: options.localOwner.getActivity(), positionSeconds: 0 },
            output: null,
          },
        }
      }
      return options.localOwner.request(req)
    },
  }
  let startupGeneration = 0
  let startupRunning = false
  const localService = createLocalEngineService(wrappedLocalOwner)
  const controller = createEngineServiceController(localService)
  const storage = options.storage ?? null
  const generateCommandId =
    options.generateCommandId ??
    (() => `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`)

  let activeCoreService: EngineService | null = null
  let activeCoreProfile: SavedCoreProfile | null = null
  let disposed = false
  let commandQueue: Promise<void> = Promise.resolve()
  let commandInFlight = false
  let passiveSyncTimer: ReturnType<typeof setInterval> | null = null
  let passiveSyncInFlight = false
  let loadingSettleTimer: ReturnType<typeof setTimeout> | null = null
  const PASSIVE_SYNC_INTERVAL_MS = 5000
  const LOADING_SETTLE_DELAY_MS = 700
  const MAX_LOADING_SETTLE_ATTEMPTS = 8
  const listeners = new Set<(state: CoreControllerState) => void>()

  function clearLoadingSettleTimer() {
    if (loadingSettleTimer !== null) {
      clearTimeout(loadingSettleTimer)
      loadingSettleTimer = null
    }
  }

  function scheduleLoadingSettleCheck(attempt = 1) {
    clearLoadingSettleTimer()
    if (disposed || attempt > MAX_LOADING_SETTLE_ATTEMPTS || typeof setTimeout !== 'function') return
    loadingSettleTimer = setTimeout(() => {
      loadingSettleTimer = null
      if (disposed || commandInFlight || !activeCoreService) return
      const currentView = controller.getView()
      if (
        currentView.session.active.kind !== 'core' ||
        currentView.snapshot?.playback.activity !== 'loading'
      ) {
        return
      }
      void controller
        .refresh()
        .then((outcome) => {
          if (disposed) return
          const nextView = controller.getView()
          if (outcome === 'updated' && nextView.snapshot) {
            state = { ...state, view: nextView, lastError: null }
            emit()
          }
          if (nextView.session.active.kind === 'core' && nextView.snapshot?.playback.activity === 'loading') {
            scheduleLoadingSettleCheck(attempt + 1)
          }
        })
        .catch(() => {})
    }, LOADING_SETTLE_DELAY_MS)
    ;(loadingSettleTimer as { unref?: () => void }).unref?.()
  }

  function stopPassiveSync() {
    clearLoadingSettleTimer()
    if (passiveSyncTimer !== null) {
      clearInterval(passiveSyncTimer)
      passiveSyncTimer = null
    }
  }

  function startPassiveSync() {
    stopPassiveSync()
    if (disposed || typeof setInterval !== 'function') return
    passiveSyncTimer = setInterval(() => {
      if (disposed || commandInFlight || passiveSyncInFlight || !activeCoreService) return
      const currentView = controller.getView()
      if (currentView.session.active.kind !== 'core') {
        stopPassiveSync()
        return
      }
      passiveSyncInFlight = true
      void controller
        .refresh()
        .then((outcome) => {
          if (disposed) return
          const nextView = controller.getView()
          if (outcome === 'updated') {
            const prevSnap = currentView.snapshot
            const nextSnap = nextView.snapshot
            const changed =
              !prevSnap ||
              !nextSnap ||
              prevSnap.revision !== nextSnap.revision ||
              prevSnap.playback.activity !== nextSnap.playback.activity ||
              Math.floor(prevSnap.playback.positionSeconds) !==
                Math.floor(nextSnap.playback.positionSeconds) ||
              prevSnap.playback.owner !== nextSnap.playback.owner ||
              prevSnap.playback.takeoverRequired !== nextSnap.playback.takeoverRequired ||
              prevSnap.playback.externalPlayback?.active !==
                nextSnap.playback.externalPlayback?.active ||
              prevSnap.playback.externalPlayback?.transportState !==
                nextSnap.playback.externalPlayback?.transportState ||
              prevSnap.catalog.revision !== nextSnap.catalog.revision
            if (changed) {
              state = { ...state, view: nextView, lastError: null }
              emit()
              if (prevSnap && nextSnap && prevSnap.catalog.revision !== nextSnap.catalog.revision && activeCoreService) {
                void hydrateCatalogTracks(activeCoreService, nextSnap, activeCoreProfile)
                  .then((hydrated) => {
                    if (disposed) return
                    state = {
                      ...state,
                      hydratedCatalogTracks: hydrated.tracks,
                      activeDescriptor: hydrated.descriptor ?? state.activeDescriptor,
                    }
                    emit()
                  })
                  .catch(() => {})
              }
            }
          } else if (outcome === 'failed' && currentView.session.connected) {
            state = {
              ...state,
              view: nextView,
              lastError: 'Connection lost. Playback may still be continuing.',
              statusAnnouncement: 'Connection lost. Playback may still be continuing.',
            }
            emit()
          }
        })
        .finally(() => {
          passiveSyncInFlight = false
        })
    }, PASSIVE_SYNC_INTERVAL_MS)
    ;(passiveSyncTimer as { unref?: () => void }).unref?.()
  }

  let state: CoreControllerState = {
    view: controller.getView(),
    hydratedCatalogTracks: [],
    savedCores: loadSavedCoreProfiles(storage),
    discoveredCores: [],
    isDiscovering: false,
    isBusy: false,
    activeProfile: null,
    activeDescriptor: null,
    musicReadOnly: null,
    stagedCandidate: null,
    stagingError: null,
    switchPrompt: null,
    statusAnnouncement: 'No Playback Engine connected.',
    lastError: null,
  }

  function emit() {
    if (disposed) return
    const snapshotState: CoreControllerState = {
      ...state,
      view: controller.getView(),
    }
    state = snapshotState
    for (const listener of listeners) {
      listener(snapshotState)
    }
  }

  function upsertSavedProfile(profile: SavedCoreProfile, snapshot?: CoreSnapshot | null) {
    const updated: SavedCoreProfile = {
      ...profile,
      pinnedOutputId: snapshot?.output?.id ?? profile.pinnedOutputId,
      pinnedOutputLabel: snapshot?.output?.label ?? profile.pinnedOutputLabel,
    }
    const filtered = state.savedCores.filter(
      (p) => !(p.engineId === updated.engineId && p.libraryId === updated.libraryId),
    )
    const nextSaved = [updated, ...filtered].slice(0, 8)
    state = { ...state, savedCores: nextSaved }
    saveCoreProfiles(storage, nextSaved)
  }

  function buildCandidateService(profile: SavedCoreProfile): EngineService {
    const context = buildCoreContextFromProfile(profile)
    const channel = channelFactory(profile)
    return createRemoteEngineService(context, channel)
  }

  async function stageCandidate(profile: SavedCoreProfile): Promise<
    { ok: true; candidate: StagedCoreCandidate } | { ok: false; error: string }
  > {
    state = { ...state, isBusy: true, stagingError: null }
    emit()
    try {
      const normalizedProfile: SavedCoreProfile = {
        ...profile,
        baseUrl: normalizeCoreBaseUrl(profile.baseUrl),
        label: profile.label.trim() || 'Cadence Core',
        musicRoots: [...(profile.musicRoots || [])],
      }
      const remoteService = buildCandidateService(normalizedProfile)
      const prepared = await remoteService.prepare()
      const candidate: StagedCoreCandidate = {
        profile: {
          ...normalizedProfile,
          label: prepared.descriptor.label || normalizedProfile.label,
          pinnedOutputId: prepared.snapshot.output?.id ?? normalizedProfile.pinnedOutputId,
          pinnedOutputLabel: prepared.snapshot.output?.label ?? normalizedProfile.pinnedOutputLabel,
        },
        descriptor: prepared.descriptor,
        snapshot: prepared.snapshot,
        health: null,
        needsMusicRoots:
          prepared.snapshot.catalog.tracks.length === 0 && normalizedProfile.musicRoots.length === 0,
      }
      state = {
        ...state,
        isBusy: false,
        stagedCandidate: candidate,
        stagingError: null,
      }
      emit()
      return { ok: true, candidate }
    } catch (err) {
      const message =
        err instanceof CoreServiceError ? err.message : new CoreServiceError('unavailable').message
      state = {
        ...state,
        isBusy: false,
        stagedCandidate: null,
        stagingError: message,
        lastError: message,
      }
      emit()
      return { ok: false, error: message }
    }
  }

  async function hydrateCatalogTracks(
    service: EngineService,
    snapshot: CoreSnapshot | null,
    profile?: SavedCoreProfile | null,
  ): Promise<{ tracks: CoreCatalogTrack[]; descriptor: CoreDescriptor | null }> {
    if (!snapshot) return { tracks: [], descriptor: null }
    if (profile && options.httpBridge) {
      try {
        const client = createEngineClient(profile, (target, body) =>
          httpBridge.postCoreRequest(target, body),
        )
        const hello = await client.hello()
        if (hello.protocolVersion === 2) {
          const enriched = await client.fetchEnrichedCatalog()
          return { tracks: enriched.tracks, descriptor: hello }
        }
      } catch {
        // Fallback cleanly to v1 catalog pagination if peer is v1-only
      }
    }
    const merged: CoreCatalogTrack[] = [...snapshot.catalog.tracks]
    const seen = new Set(merged.map((t) => t.id))
    let cursor = snapshot.catalog.nextCursor
    let pages = 0
    while (cursor && pages < 100) {
      pages++
      const page = await service.catalogPage(cursor, CORE_MAX_PAGE_TRACKS)
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
    return { tracks: merged, descriptor: null }
  }

  async function probeProfileHealthSafe(profile: SavedCoreProfile): Promise<CoreHealthMetadata | null> {
    if (!options.httpBridge) return null
    try {
      return await httpBridge.probeHealth(profile)
    } catch {
      return null
    }
  }

  async function activateProfileInternal(
    profile: SavedCoreProfile,
    sourceActivity: EngineActivity,
  ): Promise<'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'> {
    const remoteService = buildCandidateService(profile)
    state = { ...state, isBusy: true, lastError: null }
    emit()

    const outcome = await controller.select(remoteService, sourceActivity, 'stop_before_switch')
    const view = controller.getView()

    if (outcome === 'requires_stop') {
      state = {
        ...state,
        view,
        isBusy: false,
        switchPrompt: {
          kind: 'local_to_core',
          target: profile,
          sourceActivity,
        },
      }
      emit()
      return 'requires_stop'
    }

    if (outcome === 'activated') {
      activeCoreService = remoteService
      activeCoreProfile = profile
      upsertSavedProfile(profile, view.snapshot)
      const [hydrated, health] = await Promise.all([
        hydrateCatalogTracks(remoteService, view.snapshot, profile).catch(() => ({
          tracks: view.snapshot?.catalog.tracks ?? [],
          descriptor: null,
        })),
        probeProfileHealthSafe(profile),
      ])
      const outLabel = view.snapshot?.output?.label ?? 'Unassigned'
      state = {
        ...state,
        view,
        hydratedCatalogTracks: hydrated.tracks,
        activeProfile: profile,
        activeDescriptor: hydrated.descriptor,
        musicReadOnly: typeof health?.musicReadOnly === 'boolean' ? health.musicReadOnly : state.musicReadOnly,
        isBusy: false,
        stagedCandidate: null,
        stagingError: null,
        switchPrompt: null,
        lastError: null,
        statusAnnouncement: `Playback engine: ${profile.label}. Audio output: ${outLabel}.`,
      }
      emit()
      startPassiveSync()
      return 'activated'
    }

    const errMsg = view.session.error || new CoreServiceError('unavailable').message
    state = {
      ...state,
      view,
      isBusy: false,
      lastError: errMsg,
      stagingError: outcome === 'failed' ? errMsg : state.stagingError,
    }
    emit()
    return outcome
  }

  async function runSerializedCoreCommand(commandInput: CoreCommandInput): Promise<CoreSnapshot> {
    const preflightView = controller.getView()
    if (preflightView.session.active.kind !== 'core' || !activeCoreService || !preflightView.snapshot) {
      throw new CoreServiceError('not_ready')
    }
    let releaseLock!: () => void
    const prevLock = commandQueue
    commandQueue = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    await prevLock
    commandInFlight = true
    try {
      const sendWithCurrentRevision = async (): Promise<CoreSnapshot> => {
        const beforeView = controller.getView()
        if (beforeView.session.active.kind !== 'core' || !activeCoreService || !beforeView.snapshot) {
          throw new CoreServiceError('not_ready')
        }
        const command: CoreCommand = {
          ...commandInput,
          commandId: generateCommandId(),
          expectedRevision: beforeView.snapshot.revision,
        } as CoreCommand
        await activeCoreService.execute(command)
        await controller.refresh()
        const afterView = controller.getView()
        const parsed = parseCoreSnapshot(afterView.snapshot, beforeView.session.active)
        state = {
          ...state,
          view: afterView,
          lastError: null,
        }
        emit()
        if (parsed.playback.activity === 'loading') {
          scheduleLoadingSettleCheck()
        } else {
          clearLoadingSettleTimer()
        }
        return parsed
      }

      try {
        return await sendWithCurrentRevision()
      } catch (err) {
        if (err instanceof CoreServiceError && err.code === 'stale_revision') {
          await controller.refresh().catch(() => {})
          const refreshed = controller.getView()
          if (refreshed.session.active.kind === 'core' && refreshed.snapshot) {
            return await sendWithCurrentRevision()
          }
        }
        throw err
      }
    } catch (err) {
      const latestView = controller.getView()
      if (err instanceof CoreServiceError && err.code === 'takeover_required') {
        await controller.refresh().catch(() => {})
        const refreshedView = controller.getView()
        const pendingTrackId =
          commandInput.operation === 'playback.control' && commandInput.action === 'play'
            ? commandInput.trackId
            : ''
        state = {
          ...state,
          view: refreshedView,
          lastError: err.message,
          statusAnnouncement: err.message,
          switchPrompt: pendingTrackId
            ? {
                kind: 'external_rs130_takeover',
                coreLabel: refreshedView.session.active.label,
                trackId: pendingTrackId,
                onConfirm: async () => {
                  await runSerializedCoreCommand({
                    operation: 'playback.control',
                    action: 'play',
                    trackId: pendingTrackId,
                    forceTakeover: true,
                  })
                },
              }
            : state.switchPrompt,
        }
        emit()
        throw err
      }
      if (err instanceof CoreServiceError && err.code === 'stale_revision' && err.snapshot) {
        await controller.refresh()
        state = {
          ...state,
          view: controller.getView(),
          lastError: err.message,
          statusAnnouncement: err.message,
        }
        emit()
        throw err
      }
      if (
        err instanceof CoreServiceError &&
        (err.code === 'not_ready' ||
          err.code === 'invalid_payload' ||
          err.code === 'unsupported_capability')
      ) {
        state = {
          ...state,
          view: latestView,
          lastError: err.message,
          statusAnnouncement: err.message,
        }
        emit()
        throw err
      }
      controller.setConnection(
        latestView.session.activeEpoch,
        latestView.session.active,
        false,
        latestView.connectionGeneration,
      )
      state = {
        ...state,
        view: controller.getView(),
        lastError: 'Connection lost. Playback may still be continuing.',
        statusAnnouncement: 'Connection lost. Playback may still be continuing.',
      }
      emit()
      throw err
    } finally {
      commandInFlight = false
      releaseLock()
    }
  }

  return {
    getState: (): CoreControllerState => ({
      ...state,
      view: controller.getView(),
    }),

    subscribe(listener: (next: CoreControllerState) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async discoverOnDemand(): Promise<DiscoveredCoreNode[]> {
      if (!options.discoverNodes) {
        return state.discoveredCores
      }
      state = { ...state, isDiscovering: true, stagingError: null }
      emit()
      try {
        const nodes = await options.discoverNodes()
        state = { ...state, isDiscovering: false, discoveredCores: nodes }
        emit()
        return nodes
      } catch {
        state = {
          ...state,
          isDiscovering: false,
          stagingError: 'On-demand Core discovery did not complete. Enter the Core address manually.',
        }
        emit()
        return []
      }
    },

    stageCandidate,

    updateStagedMusicRoots(roots: string[]): void {
      if (!state.stagedCandidate) return
      const cleaned = roots.map((r) => r.trim()).filter(Boolean)
      state = {
        ...state,
        stagedCandidate: {
          ...state.stagedCandidate,
          profile: {
            ...state.stagedCandidate.profile,
            musicRoots: cleaned,
          },
          needsMusicRoots:
            state.stagedCandidate.snapshot.catalog.tracks.length === 0 && cleaned.length === 0,
        },
      }
      emit()
    },

    cancelStaging(): void {
      state = {
        ...state,
        stagedCandidate: null,
        stagingError: null,
      }
      emit()
    },

    dismissSwitchPrompt(): void {
      state = {
        ...state,
        switchPrompt: null,
      }
      emit()
    },

    async activateStagedCore(): Promise<'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'> {
      if (!state.stagedCandidate) return 'unchanged'
      return activateProfileInternal(state.stagedCandidate.profile, options.localOwner.getActivity())
    },

    async switchToSavedCore(
      profile: SavedCoreProfile,
    ): Promise<'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'> {
      return activateProfileInternal(profile, options.localOwner.getActivity())
    },

    async confirmLocalToCoreSwitch(): Promise<'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'> {
      const prompt = state.switchPrompt
      if (!prompt || prompt.kind !== 'local_to_core') return 'unchanged'
      state = { ...state, isBusy: true }
      emit()
      const stopped = await options.localOwner.stopAndAcknowledge()
      if (!stopped || options.localOwner.getActivity() !== 'idle') {
        state = {
          ...state,
          isBusy: false,
          lastError: 'Local playback did not stop before switching. Keeping This PC active.',
        }
        emit()
        return 'failed'
      }
      return activateProfileInternal(prompt.target, 'idle')
    },

    async requestSwitchToLocal(): Promise<'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'> {
      const currentView = controller.getView()
      if (currentView.session.active.kind === 'local') {
        return 'unchanged'
      }
      const coreActivity: EngineActivity = currentView.snapshot?.playback.activity ?? 'idle'
      if (coreActivity !== 'idle' && currentView.session.connected) {
        state = {
          ...state,
          switchPrompt: {
            kind: 'core_to_local',
            sourceActivity: coreActivity,
            coreLabel: currentView.session.active.label,
          },
        }
        emit()
        return 'requires_stop'
      }
      const outcome = await controller.select(localService, 'idle', 'leave_core_playing')
      if (outcome === 'activated') {
        stopPassiveSync()
        activeCoreService = null
        activeCoreProfile = null
        state = {
          ...state,
          view: controller.getView(),
          hydratedCatalogTracks: [],
          activeProfile: null,
          activeDescriptor: null,
          musicReadOnly: null,
          switchPrompt: null,
          lastError: null,
          statusAnnouncement: 'Playback engine: This PC. Local playback remains stopped.',
        }
        emit()
      }
      return outcome
    },

    async confirmLeaveCore(
      disposition: 'leave_core_playing' | 'stop_before_switch',
    ): Promise<'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'> {
      const currentView = controller.getView()
      if (currentView.session.active.kind !== 'core') return 'unchanged'
      const coreActivity = currentView.snapshot?.playback.activity ?? 'idle'

      state = { ...state, isBusy: true }
      emit()

      if (disposition === 'stop_before_switch' && activeCoreService && currentView.snapshot) {
        try {
          await activeCoreService.execute({
            operation: 'playback.control',
            action: 'stop',
            commandId: generateCommandId(),
            expectedRevision: currentView.snapshot.revision,
          })
        } catch {
          // If Core became unreachable while attempting stop, retain Core context rather than silently pretending it stopped
          controller.setConnection(
            currentView.session.activeEpoch,
            currentView.session.active,
            false,
            currentView.connectionGeneration,
          )
          state = {
            ...state,
            view: controller.getView(),
            isBusy: false,
            switchPrompt: null,
            lastError: 'Connection lost. Playback may still be continuing.',
            statusAnnouncement: 'Connection lost. Playback may still be continuing.',
          }
          emit()
          return 'failed'
        }
      }

      const effectiveSourceActivity: EngineActivity =
        disposition === 'stop_before_switch' ? 'idle' : coreActivity
      const outcome = await controller.select(localService, effectiveSourceActivity, disposition)
      if (outcome === 'activated') {
        stopPassiveSync()
        activeCoreService = null
        activeCoreProfile = null
        state = {
          ...state,
          view: controller.getView(),
          hydratedCatalogTracks: [],
          activeProfile: null,
          activeDescriptor: null,
          musicReadOnly: null,
          isBusy: false,
          switchPrompt: null,
          lastError: null,
          statusAnnouncement:
            disposition === 'leave_core_playing'
              ? 'Switched to This PC while Core keeps playing. Local playback remains stopped.'
              : 'Stopped Core playback and switched to This PC. Local playback remains stopped.',
        }
        emit()
      } else {
        state = { ...state, isBusy: false, view: controller.getView() }
        emit()
      }
      return outcome
    },

    async reconnect(): Promise<'updated' | 'failed' | 'stale'> {
      const currentView = controller.getView()
      if (currentView.session.active.kind !== 'core') return 'stale'
      state = { ...state, isBusy: true, lastError: null }
      emit()
      const outcome = await controller.refresh()
      const nextView = controller.getView()
      if (outcome === 'updated') {
        let hydratedCatalogTracks = state.hydratedCatalogTracks
        let activeDescriptor = state.activeDescriptor
        if (activeCoreService) {
          try {
            const hydrated = await hydrateCatalogTracks(activeCoreService, nextView.snapshot, activeCoreProfile)
            hydratedCatalogTracks = hydrated.tracks
            if (hydrated.descriptor) activeDescriptor = hydrated.descriptor
          } catch {
            // Preserve previously hydrated catalog on transient failure
          }
        }
        const health = activeCoreProfile ? await probeProfileHealthSafe(activeCoreProfile) : null
        state = {
          ...state,
          view: nextView,
          hydratedCatalogTracks,
          activeDescriptor,
          musicReadOnly: typeof health?.musicReadOnly === 'boolean' ? health.musicReadOnly : state.musicReadOnly,
          isBusy: false,
          lastError: null,
          statusAnnouncement: `Reconnected to ${nextView.session.active.label}.`,
        }
      } else if (outcome === 'failed') {
        state = {
          ...state,
          view: nextView,
          isBusy: false,
          lastError: 'Connection lost. Playback may still be continuing.',
          statusAnnouncement: 'Connection lost. Playback may still be continuing.',
        }
      } else {
        state = { ...state, view: nextView, isBusy: false }
      }
      emit()
      if (outcome === 'updated') {
        startPassiveSync()
      }
      return outcome
    },

    async executeCoreCommand(commandInput: CoreCommandInput): Promise<CoreSnapshot> {
      return runSerializedCoreCommand(commandInput)
    },

    async refreshSnapshot(): Promise<CoreSnapshot | null> {
      const beforeView = controller.getView()
      if (beforeView.session.active.kind !== 'core' || !activeCoreService) {
        return null
      }
      const outcome = await controller.refresh()
      const afterView = controller.getView()
      if (outcome === 'updated') {
        state = { ...state, view: afterView, lastError: null }
        emit()
        return afterView.snapshot ?? null
      }
      if (outcome === 'failed') {
        state = {
          ...state,
          view: afterView,
          lastError: 'Connection lost. Playback may still be continuing.',
          statusAnnouncement: 'Connection lost. Playback may still be continuing.',
        }
        emit()
      }
      return afterView.snapshot ?? null
    },

    async loadCatalogPage(cursor: string | null, limit = 200): Promise<CoreCatalogPage> {
      const beforeView = controller.getView()
      if (beforeView.session.active.kind !== 'core' || !activeCoreService) {
        throw new CoreServiceError('not_ready')
      }
      try {
        return await activeCoreService.catalogPage(cursor, limit)
      } catch (err) {
        controller.setConnection(
          beforeView.session.activeEpoch,
          beforeView.session.active,
          false,
          beforeView.connectionGeneration,
        )
        state = {
          ...state,
          view: controller.getView(),
          lastError: 'Connection lost. Playback may still be continuing.',
          statusAnnouncement: 'Connection lost. Playback may still be continuing.',
        }
        emit()
        throw err
      }
    },

    requestRs130TakeoverIfControlledByCore(endpoint: AudioEndpoint, onConfirm: () => Promise<void>): boolean {
      if (endpoint.transport !== 'upnp') return false
      const knownCore =
        (activeCoreProfile && activeCoreProfile.pinnedOutputId === endpoint.udn ? activeCoreProfile : null) ??
        state.savedCores.find((c) => c.pinnedOutputId === endpoint.udn)
      if (!knownCore) return false
      state = {
        ...state,
        switchPrompt: {
          kind: 'rs130_takeover',
          endpoint,
          coreLabel: knownCore.label,
          onConfirm,
        },
      }
      emit()
      return true
    },

    async confirmRs130Takeover(): Promise<void> {
      const prompt = state.switchPrompt
      if (!prompt || (prompt.kind !== 'rs130_takeover' && prompt.kind !== 'external_rs130_takeover')) return
      state = { ...state, switchPrompt: null, isBusy: true }
      emit()
      try {
        await prompt.onConfirm()
      } finally {
        state = { ...state, isBusy: false }
        emit()
      }
    },

    requestExternalRs130Takeover(trackId: string, onConfirm: () => Promise<void>): void {
      const currentView = controller.getView()
      if (currentView.session.active.kind !== 'core') return
      state = {
        ...state,
        switchPrompt: {
          kind: 'external_rs130_takeover',
          coreLabel: currentView.session.active.label,
          trackId,
          onConfirm,
        },
      }
      emit()
    },

    removeSavedCore(engineId: string, libraryId: string): void {
      const next = state.savedCores.filter(
        (p) => !(p.engineId === engineId && p.libraryId === libraryId),
      )
      state = { ...state, savedCores: next }
      saveCoreProfiles(storage, next)
      emit()
    },

    async refreshCatalog(): Promise<CoreCatalogTrack[]> {
      const currentView = controller.getView()
      if (currentView.session.active.kind !== 'core' || !activeCoreService) {
        return state.hydratedCatalogTracks
      }
      await controller.refresh().catch(() => {})
      const latestView = controller.getView()
      const hydrated = await hydrateCatalogTracks(
        activeCoreService,
        latestView.snapshot ?? currentView.snapshot,
        activeCoreProfile,
      )
      state = {
        ...state,
        view: latestView,
        hydratedCatalogTracks: hydrated.tracks,
        activeDescriptor: hydrated.descriptor ?? state.activeDescriptor,
      }
      emit()
      return hydrated.tracks
    },

    async bootstrapStartupConnection(): Promise<void> {
      if (disposed || state.isBusy || startupRunning || controller.getView().session.active.kind === 'core') return
      startupRunning = true
      const generation = ++startupGeneration
      const current = () => !disposed && generation === startupGeneration
      try {
        let local = state.savedCores.find((profile) =>
          isLoopbackEngineUrl(profile.baseUrl) &&
          Boolean(profile.certFingerprint),
        )
        if (!local && options.readLocalPairingEndpoint && state.savedCores.some((profile) => profile.certFingerprint)) {
          const pairing = await options.readLocalPairingEndpoint().catch(() => null)
          if (!current()) return
          if (pairing?.certFingerprint && isLoopbackEngineUrl(pairing.baseUrl)) {
            const fingerprint = normalizeFingerprint(pairing.certFingerprint)
            const saved = state.savedCores.find((profile) =>
              profile.engineId === pairing.engineId &&
              profile.libraryId === pairing.libraryId &&
              normalizeFingerprint(profile.certFingerprint ?? '') === fingerprint,
            )
            if (saved) local = { ...saved, baseUrl: pairing.baseUrl }
          }
        }
        if (local) {
          let failure: string | undefined
          const profile = { ...local, certFingerprint: local.certFingerprint!, trustInsecure: false }
          for (let attempt = 1; attempt <= 4 && current(); attempt++) {
            state = { ...state, stagingError: null, lastError: null,
              startupConnection: { profile, attempt, phase: 'checking' } }
            emit()
            try {
              const health = await httpBridge.probeHealth(profile)
              if (!current()) return
              if (health.engineId !== profile.engineId || health.libraryId !== profile.libraryId) {
                throw new CoreServiceError('identity_mismatch')
              }
              if (health.tlsFingerprintSha256 &&
                  normalizeFingerprint(health.tlsFingerprintSha256) !== normalizeFingerprint(profile.certFingerprint)) {
                throw new CoreServiceError('untrusted_peer')
              }
              if (health.ready !== true) throw new CoreServiceError('not_ready')
              state = { ...state, startupConnection: { profile, attempt, phase: 'ready' } }
              emit()
              if (await activateProfileInternal(profile, options.localOwner.getActivity()) === 'activated') return
              break
            } catch (error) {
              if (!current()) return
              if (error instanceof CoreServiceError && !['unavailable', 'not_ready'].includes(error.code)) {
                failure = error.message
                break
              }
            }
            if (attempt < 4) {
              state = { ...state, startupConnection: { profile, attempt, phase: 'waiting' } }
              emit()
              await new Promise<void>((resolve) => setTimeout(resolve, attempt * 750))
            }
          }
          if (!current()) return
          state = { ...state, startupConnection: { ...state.startupConnection!, phase: 'failed', error: failure } }
          emit()
          return
        }
        for (const profile of state.savedCores) {
          if (!current()) return
          if (await activateProfileInternal(profile, options.localOwner.getActivity()) === 'activated') return
        }
        if (current()) await this.discoverOnDemand()
      } finally {
        if (generation === startupGeneration) startupRunning = false
      }
    },

    cancelStartupConnection(): void {
      startupGeneration++
      startupRunning = false
      state = { ...state, startupConnection: undefined }
      emit()
    },

    /** Closing the controller never sends Stop to Core; the Core session continues independently. */
    dispose(): void {
      disposed = true
      stopPassiveSync()
      listeners.clear()
    },
  }
}

export type DesktopCoreControllerStore = ReturnType<typeof createDesktopCoreControllerStore>
export { CORE_PROTOCOL_VERSION }
