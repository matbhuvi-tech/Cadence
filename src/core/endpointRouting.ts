import { emitDiag, isDebugActive } from './diagnostics'

export interface UpnpDeviceInfo {
  id: string
  friendlyName: string
  modelName?: string
  modelDescription?: string
  manufacturer?: string
  location: string
  controlUrl: string
}

export interface StreamInfoSummary {
  filePath?: string
  sampleRate?: number
  bitDepth?: number
  channels?: number
  format?: string
}

export type EndpointTransport = 'system_default' | 'wasapi' | 'upnp'

export type AudioEndpoint =
  | { transport: 'system_default' }
  | { transport: 'wasapi'; name: string }
  | { transport: 'upnp'; udn: string; friendlyName: string }

export interface AudioEndpointInfo {
  id: string
  transport: EndpointTransport
  displayName: string
  wasapiName?: string | null
  udn?: string | null
  isAvailable: boolean
  supportsDsd: boolean
  isBitPerfectCapable: boolean
}

export type SignalPathMode =
  | 'upnp_raw_stream'
  | 'wasapi_shared_purity'
  | 'wasapi_shared'
  | 'unavailable'

export interface SignalPathDescription {
  pillLabel: string
  pillSubtitle: string
  transportLabel: string
  transportDetail: string
  clockStepTitle: string
  clockStepDetail: string
  gainLabel: string
  gainIsLocked: boolean
  isProvenBitPerfect: boolean
  isRoutingMismatch: boolean
  canShowDacRate: boolean
}

export interface EndpointPlaybackStatusLike {
  activeDevice?: string | null
  deviceType?: string | null
  purityMode?: boolean
  isBitPerfect?: boolean
  outputSampleRate?: number | null
  outputChannels?: number | null
  selectedEndpoint?: AudioEndpoint | null
  activeBackendEndpoint?: AudioEndpoint | null
  signalPathMode?: string | null
  streamInfo?: StreamInfoSummary | null
}

export const SYSTEM_DEFAULT_ENDPOINT: AudioEndpoint = { transport: 'system_default' }
export const SELECTED_ENDPOINT_STORAGE_KEY = 'cadence:selected_endpoint'
export const LEGACY_ACTIVE_DEVICE_STORAGE_KEY = 'cadence:active_device'

export function normalizeBackendEndpoint(raw: any): AudioEndpoint | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.transport === 'system_default') {
    return { transport: 'system_default' }
  }
  if (raw.transport === 'wasapi' && typeof raw.name === 'string' && raw.name.length > 0) {
    return { transport: 'wasapi', name: raw.name }
  }
  if (raw.transport === 'upnp' && typeof raw.udn === 'string' && raw.udn.length > 0) {
    const friendly =
      typeof raw.friendlyName === 'string'
        ? raw.friendlyName
        : typeof raw.friendly_name === 'string'
        ? raw.friendly_name
        : raw.udn
    return { transport: 'upnp', udn: raw.udn, friendlyName: friendly }
  }
  return null
}

export function endpointFromInfo(info: AudioEndpointInfo): AudioEndpoint {
  switch (info.transport) {
    case 'system_default':
      return { transport: 'system_default' }
    case 'wasapi':
      return { transport: 'wasapi', name: info.wasapiName ?? info.displayName }
    case 'upnp':
      return {
        transport: 'upnp',
        udn: info.udn ?? info.id.replace(/^upnp:/, ''),
        friendlyName: info.displayName,
      }
  }
}

export function getEndpointId(endpoint: AudioEndpoint): string {
  switch (endpoint.transport) {
    case 'system_default':
      return 'system_default'
    case 'wasapi':
      return `wasapi:${endpoint.name}`
    case 'upnp':
      return `upnp:${endpoint.udn}`
  }
}

export function getEndpointDisplayName(endpoint: AudioEndpoint): string {
  switch (endpoint.transport) {
    case 'system_default':
      return 'Default Audio Device'
    case 'wasapi':
      return endpoint.name
    case 'upnp':
      return endpoint.friendlyName
  }
}

export function getEndpointLegacyLabel(endpoint: AudioEndpoint): string {
  switch (endpoint.transport) {
    case 'system_default':
      return 'Default Audio Device'
    case 'wasapi':
      return endpoint.name
    case 'upnp':
      return `[UPnP] ${endpoint.friendlyName}`
  }
}

export function isSameEndpoint(
  a: AudioEndpoint | null | undefined,
  b: AudioEndpoint | null | undefined
): boolean {
  if (!a || !b || a.transport !== b.transport) return false
  if (a.transport === 'system_default' && b.transport === 'system_default') return true
  if (a.transport === 'wasapi' && b.transport === 'wasapi') return a.name === b.name
  if (a.transport === 'upnp' && b.transport === 'upnp') return a.udn === b.udn
  return false
}

export function endpointFromLegacyString(
  raw: string,
  knownUpnp: Array<Pick<UpnpDeviceInfo, 'id' | 'friendlyName'>> = []
): AudioEndpoint {
  if (
    raw === 'system_default' ||
    raw === 'Default System Audio' ||
    raw.toLowerCase() === 'default audio device'
  ) {
    return { transport: 'system_default' }
  }
  if (raw.startsWith('wasapi:')) {
    return { transport: 'wasapi', name: raw.slice('wasapi:'.length) }
  }
  if (raw.startsWith('upnp:')) {
    const udn = raw.slice('upnp:'.length)
    const match = knownUpnp.find((d) => d.id === udn)
    return {
      transport: 'upnp',
      udn,
      friendlyName: match?.friendlyName ?? udn,
    }
  }
  if (raw.startsWith('uuid:')) {
    const match = knownUpnp.find((d) => d.id === raw)
    return {
      transport: 'upnp',
      udn: raw,
      friendlyName: match?.friendlyName ?? raw,
    }
  }
  if (raw.startsWith('[UPnP]')) {
    const clean = raw.slice('[UPnP]'.length).trim()
    const match = knownUpnp.find((d) => d.friendlyName === clean)
    return {
      transport: 'upnp',
      udn: match?.id ?? clean,
      friendlyName: match?.friendlyName ?? clean,
    }
  }
  return { transport: 'wasapi', name: raw }
}

export function parseStoredEndpoint(
  rawEndpointJson: string | null,
  rawLegacyDevice: string | null,
  knownUpnp: Array<Pick<UpnpDeviceInfo, 'id' | 'friendlyName'>> = []
): AudioEndpoint | null {
  if (rawEndpointJson) {
    try {
      const parsed = normalizeBackendEndpoint(JSON.parse(rawEndpointJson))
      if (parsed) return parsed
    } catch {
      // Ignore malformed stored JSON and fall back to legacy string if present
    }
  }
  if (rawLegacyDevice && rawLegacyDevice.trim().length > 0) {
    return endpointFromLegacyString(rawLegacyDevice, knownUpnp)
  }
  return null
}

export function mergeEndpointsFromLegacyAndUpnp(
  localDevices: string[],
  upnpDevices: UpnpDeviceInfo[]
): AudioEndpointInfo[] {
  const result: AudioEndpointInfo[] = [
    {
      id: 'system_default',
      transport: 'system_default',
      displayName: 'Default Audio Device',
      wasapiName: localDevices[0] ?? null,
      udn: null,
      isAvailable: localDevices.length > 0,
      supportsDsd: false,
      isBitPerfectCapable: false,
    },
  ]

  const seenWasapi = new Set<string>()
  for (const name of localDevices) {
    if (!name || name.startsWith('[UPnP]') || name.toLowerCase() === 'default audio device') continue
    if (seenWasapi.has(name)) continue
    seenWasapi.add(name)
    result.push({
      id: `wasapi:${name}`,
      transport: 'wasapi',
      displayName: name,
      wasapiName: name,
      udn: null,
      isAvailable: true,
      supportsDsd: false,
      isBitPerfectCapable: false,
    })
  }

  const seenUdn = new Set<string>()
  for (const net of upnpDevices) {
    if (!net.id || seenUdn.has(net.id)) continue
    seenUdn.add(net.id)
    result.push({
      id: `upnp:${net.id}`,
      transport: 'upnp',
      displayName: net.friendlyName,
      wasapiName: null,
      udn: net.id,
      isAvailable: true,
      supportsDsd: true,
      isBitPerfectCapable: true,
    })
  }

  return result
}

export function describeSignalPath(params: {
  selectedEndpoint: AudioEndpoint
  activeBackendEndpoint: AudioEndpoint | null
  deviceType?: string
  signalPathMode?: string
  isPurityMode: boolean
  isBitPerfect: boolean
  volume: number
  isMuted: boolean
  outputSampleRate?: number
}): SignalPathDescription {
  const {
    selectedEndpoint,
    activeBackendEndpoint,
    deviceType,
    signalPathMode,
    isPurityMode,
    isBitPerfect,
    volume,
    isMuted,
    outputSampleRate,
  } = params

  const isUnavailable =
    deviceType === 'unavailable' ||
    signalPathMode === 'unavailable' ||
    activeBackendEndpoint === null

  const isRoutingMismatch =
    activeBackendEndpoint !== null && !isSameEndpoint(selectedEndpoint, activeBackendEndpoint)

  const gainIsLocked = isPurityMode
  const gainLabel = isPurityMode
    ? '0 dB Unity Gain Locked (App)'
    : isMuted
    ? 'Muted (0% Software Gain)'
    : `${Math.round(volume * 100)}% Software Gain`

  if (isUnavailable) {
    return {
      pillLabel: 'Unavailable',
      pillSubtitle: `Selected: ${getEndpointDisplayName(selectedEndpoint)}`,
      transportLabel: 'Unavailable',
      transportDetail: `${getEndpointDisplayName(selectedEndpoint)} (Backend unavailable)`,
      clockStepTitle: 'Audio Engine Inactive',
      clockStepDetail: 'Selected output endpoint is not currently available',
      gainLabel,
      gainIsLocked,
      isProvenBitPerfect: false,
      isRoutingMismatch: false,
      canShowDacRate: false,
    }
  }

  const isUpnp =
    activeBackendEndpoint?.transport === 'upnp' ||
    deviceType === 'upnp_streamer' ||
    signalPathMode === 'upnp_raw_stream'

  if (isUpnp) {
    const activeName = activeBackendEndpoint
      ? getEndpointDisplayName(activeBackendEndpoint)
      : getEndpointDisplayName(selectedEndpoint)
    return {
      pillLabel: 'UPnP',
      pillSubtitle: activeName,
      transportLabel: 'UPnP Raw Stream',
      transportDetail: activeName,
      clockStepTitle: 'Stream Buffering & Network Delivery',
      clockStepDetail: 'VirtualLock RAM · Paced UPnP TCP Transport',
      gainLabel: 'Delegated to UPnP Renderer',
      gainIsLocked: false,
      isProvenBitPerfect: Boolean(isBitPerfect),
      isRoutingMismatch,
      canShowDacRate: false,
    }
  }

  const activeName = activeBackendEndpoint
    ? getEndpointDisplayName(activeBackendEndpoint)
    : getEndpointDisplayName(selectedEndpoint)
  const sharedModeLabel = isPurityMode ? 'WASAPI Shared · Purity' : 'WASAPI Shared'

  return {
    pillLabel: sharedModeLabel,
    pillSubtitle: activeName,
    transportLabel: 'WASAPI Shared',
    transportDetail: `${activeName}${outputSampleRate ? ` (${outputSampleRate / 1000} kHz OS Mixer)` : ''}`,
    clockStepTitle: 'Local Host Streamer',
    clockStepDetail: isPurityMode
      ? 'Shared OS Mixer · Software Unity Gain Locked (Not Bit-Perfect)'
      : 'Windows WASAPI Shared Audio Engine',
    gainLabel,
    gainIsLocked,
    isProvenBitPerfect: false,
    isRoutingMismatch,
    canShowDacRate: typeof outputSampleRate === 'number' && outputSampleRate > 0,
  }
}

export interface EndpointRoutingState {
  selectedEndpoint: AudioEndpoint
  activeBackendEndpoint: AudioEndpoint | null
  availableEndpoints: AudioEndpointInfo[]
  upnpDevices: UpnpDeviceInfo[]
  deviceType: string
  signalPathMode: string
  isBitPerfect: boolean
  outputSampleRate: number | undefined
  endpointError: string | null
  selectionEpoch: number
  inventorySeq: number
  inFlightSelections: number
}

export interface EndpointRoutingBridge {
  listAudioEndpoints: () => Promise<AudioEndpointInfo[]>
  discoverUpnpDevices: () => Promise<UpnpDeviceInfo[]>
  setAudioEndpoint: (endpoint: AudioEndpoint) => Promise<void>
  getPlaybackStatus: () => Promise<EndpointPlaybackStatusLike | null>
}

export interface EndpointStorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function createEndpointRoutingController(
  bridge: EndpointRoutingBridge,
  storage?: EndpointStorageLike | null,
  onChange?: (next: EndpointRoutingState) => void
) {
  let savedStartupEndpoint: AudioEndpoint | null = null
  try {
    savedStartupEndpoint = storage
      ? parseStoredEndpoint(
          storage.getItem(SELECTED_ENDPOINT_STORAGE_KEY),
          storage.getItem(LEGACY_ACTIVE_DEVICE_STORAGE_KEY)
        )
      : null
  } catch {
    savedStartupEndpoint = null
  }

  const state: EndpointRoutingState = {
    selectedEndpoint: savedStartupEndpoint ?? SYSTEM_DEFAULT_ENDPOINT,
    activeBackendEndpoint: savedStartupEndpoint ? null : SYSTEM_DEFAULT_ENDPOINT,
    availableEndpoints: [],
    upnpDevices: [],
    deviceType: 'wasapi_shared',
    signalPathMode: 'wasapi_shared',
    isBitPerfect: false,
    outputSampleRate: undefined,
    endpointError: null,
    selectionEpoch: 0,
    inventorySeq: 0,
    inFlightSelections: 0,
  }

  const emit = () => {
    onChange?.({ ...state })
  }

  const persistSelected = (endpoint: AudioEndpoint) => {
    try {
      storage?.setItem(SELECTED_ENDPOINT_STORAGE_KEY, JSON.stringify(endpoint))
      storage?.setItem(LEGACY_ACTIVE_DEVICE_STORAGE_KEY, getEndpointLegacyLabel(endpoint))
    } catch {
      // Ignore storage quota / security errors
    }
  }

  const applyStatusSnapshot = (status: EndpointPlaybackStatusLike, allowSelectedSync: boolean): boolean => {
    let changed = false
    const backendActive = normalizeBackendEndpoint(status.activeBackendEndpoint)
    const backendSelected = normalizeBackendEndpoint(status.selectedEndpoint)

    if (allowSelectedSync && backendSelected && !isSameEndpoint(state.selectedEndpoint, backendSelected)) {
      state.selectedEndpoint = backendSelected
      persistSelected(backendSelected)
      changed = true
    }

    if (status.activeBackendEndpoint !== undefined && !isSameEndpoint(state.activeBackendEndpoint, backendActive)) {
      state.activeBackendEndpoint = backendActive
      changed = true
    }
    if (status.deviceType && state.deviceType !== status.deviceType) {
      state.deviceType = status.deviceType
      changed = true
    }
    if (status.signalPathMode && state.signalPathMode !== status.signalPathMode) {
      state.signalPathMode = status.signalPathMode
      changed = true
    }
    if (status.isBitPerfect !== undefined) {
      const nextBitPerfect = Boolean(status.isBitPerfect)
      if (state.isBitPerfect !== nextBitPerfect) {
        state.isBitPerfect = nextBitPerfect
        changed = true
      }
    }
    const nextOutputSampleRate =
      typeof status.outputSampleRate === 'number' && status.outputSampleRate > 0
        ? status.outputSampleRate
        : undefined
    if (state.outputSampleRate !== nextOutputSampleRate) {
      state.outputSampleRate = nextOutputSampleRate
      changed = true
    }

    if (backendActive && isSameEndpoint(backendActive, state.selectedEndpoint) && state.endpointError !== null) {
      state.endpointError = null
      changed = true
    }

    return changed
  }

  return {
    getState(): EndpointRoutingState {
      return { ...state }
    },

    hasSavedStartupSelection(): boolean {
      return savedStartupEndpoint !== null
    },

    setEndpointError(message: string | null) {
      state.endpointError = message
      emit()
    },

    async selectEndpoint(endpoint: AudioEndpoint): Promise<{ ok: boolean; error?: string }> {
      const prevEndpoint = state.selectedEndpoint
      const epoch = ++state.selectionEpoch
      const t0 = isDebugActive() ? performance.now() : 0
      emitDiag(
        'device_selection',
        'frontend_select_requested',
        `epoch=${epoch} prev=${getEndpointId(prevEndpoint)} next=${getEndpointId(endpoint)}`,
        { correlationId: epoch }
      )
      state.selectedEndpoint = endpoint
      state.endpointError = null
      persistSelected(endpoint)
      state.inFlightSelections += 1
      emit()
      try {
        await bridge.setAudioEndpoint(endpoint)
        if (epoch !== state.selectionEpoch) {
          emitDiag(
            'device_selection',
            'stale_selection_ignored',
            `stale_epoch=${epoch} active_epoch=${state.selectionEpoch}`,
            { correlationId: epoch }
          )
          return { ok: true }
        }
        const status = await bridge.getPlaybackStatus()
        if (epoch === state.selectionEpoch && status) {
          applyStatusSnapshot(status, false)
          emit()
        }
        const execUs = t0 > 0 ? Math.round((performance.now() - t0) * 1000) : 0
        emitDiag(
          'device_selection',
          'frontend_select_completed',
          `epoch=${epoch} selected=${getEndpointId(endpoint)} actual=${state.activeBackendEndpoint ? getEndpointId(state.activeBackendEndpoint) : 'none'}`,
          { correlationId: epoch, execUs }
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const execUs = t0 > 0 ? Math.round((performance.now() - t0) * 1000) : 0
        if (epoch === state.selectionEpoch) {
          // Preserve user's selectedEndpoint independently of active backend state.
          state.activeBackendEndpoint = null
          state.deviceType = 'unavailable'
          state.signalPathMode = 'unavailable'
          state.isBitPerfect = false
          state.outputSampleRate = undefined
          state.endpointError = msg
          emit()
        }
        emitDiag(
          'device_selection',
          'frontend_select_failed',
          `epoch=${epoch} preserved_selected=${getEndpointId(endpoint)} err=${msg}`,
          { correlationId: epoch, execUs }
        )
        return { ok: false, error: msg }
      } finally {
        state.inFlightSelections = Math.max(0, state.inFlightSelections - 1)
      }
    },

    /**
     * Refresh device inventory (local WASAPI + UPnP SSDP) without ever modifying
     * the user's selected or active playback endpoint.
     */
    async refreshInventory(): Promise<AudioEndpointInfo[]> {
      const seq = ++state.inventorySeq
      const capturedEpoch = state.selectionEpoch
      const t0 = isDebugActive() ? performance.now() : 0
      emitDiag(
        'device_discovery',
        'inventory_refresh_started',
        `seq=${seq} selection_epoch=${capturedEpoch}`,
        { correlationId: seq }
      )
      const [endpoints, netDevices] = await Promise.all([
        bridge.listAudioEndpoints(),
        bridge.discoverUpnpDevices(),
      ])

      // Drop stale discovery results if a newer discovery request finished or started after us.
      if (seq < state.inventorySeq) {
        emitDiag(
          'device_discovery',
          'inventory_refresh_stale_dropped',
          `stale_seq=${seq} latest_seq=${state.inventorySeq}`,
          { correlationId: seq }
        )
        return state.availableEndpoints
      }

      const merged = [...endpoints]
      const seenIds = new Set(endpoints.map((e) => e.id))
      for (const net of netDevices) {
        const upnpId = `upnp:${net.id}`
        if (!seenIds.has(upnpId)) {
          seenIds.add(upnpId)
          merged.push({
            id: upnpId,
            transport: 'upnp',
            displayName: net.friendlyName,
            wasapiName: null,
            udn: net.id,
            isAvailable: true,
            supportsDsd: true,
            isBitPerfectCapable: true,
          })
        }
      }

      state.upnpDevices = netDevices
      state.availableEndpoints = merged
      const execUs = t0 > 0 ? Math.round((performance.now() - t0) * 1000) : 0
      emitDiag(
        'device_discovery',
        'inventory_refresh_completed',
        `seq=${seq} endpoints=${merged.length} upnp=${netDevices.length} selected_unchanged=${getEndpointId(state.selectedEndpoint)}`,
        { correlationId: seq, execUs }
      )
      emit()
      return merged
    },

    async initializeStartup(): Promise<void> {
      const bootEpoch = state.selectionEpoch
      if (savedStartupEndpoint) {
        state.inFlightSelections += 1
        try {
          await bridge.setAudioEndpoint(savedStartupEndpoint)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (state.selectionEpoch === bootEpoch) {
            state.activeBackendEndpoint = null
            state.deviceType = 'unavailable'
            state.signalPathMode = 'unavailable'
            state.isBitPerfect = false
            state.outputSampleRate = undefined
            state.endpointError = msg
            emit()
          }
        } finally {
          state.inFlightSelections = Math.max(0, state.inFlightSelections - 1)
        }
      }

      if (state.selectionEpoch !== bootEpoch) {
        return
      }
      const status = await bridge.getPlaybackStatus()
      if (state.selectionEpoch === bootEpoch && state.inFlightSelections === 0 && status) {
        applyStatusSnapshot(status, false)
        emit()
      }
    },

    reconcilePolledStatus(status: EndpointPlaybackStatusLike, capturedEpoch: number) {
      if (capturedEpoch === state.selectionEpoch && state.inFlightSelections === 0) {
        if (applyStatusSnapshot(status, true)) {
          emit()
        }
      } else {
        emitDiag(
          'device_selection',
          'stale_poll_ignored',
          `captured_epoch=${capturedEpoch} current_epoch=${state.selectionEpoch} inflight=${state.inFlightSelections}`,
          { correlationId: capturedEpoch }
        )
      }
    },

    async syncFromBackendPoll(): Promise<EndpointPlaybackStatusLike | null> {
      const epochBefore = state.selectionEpoch
      const status = await bridge.getPlaybackStatus()
      if (!status) return null
      this.reconcilePolledStatus(status, epochBefore)
      return status
    },
  }
}
