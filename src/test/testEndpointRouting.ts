import assert from 'node:assert/strict'
import {
  AudioEndpoint,
  AudioEndpointInfo,
  EndpointPlaybackStatusLike,
  EndpointRoutingBridge,
  EndpointStorageLike,
  UpnpDeviceInfo,
  createEndpointRoutingController,
  describeSignalPath,
  endpointFromLegacyString,
  isSameEndpoint,
  parseStoredEndpoint,
} from '../core/endpointRouting'

function deferred<T>() {
  let resolve!: (val: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createMemoryStorage(initial: Record<string, string> = {}): EndpointStorageLike {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => {
      map.set(key, val)
    },
  }
}

const SAMPLE_UPNP: UpnpDeviceInfo[] = [
  {
    id: 'uuid:rose-130-udn',
    friendlyName: 'ROSE-67',
    modelName: 'RS130',
    modelDescription: 'HiFi ROSE',
    manufacturer: 'CITECH',
    location: 'http://192.0.2.10:34042/desc',
    controlUrl: 'http://192.0.2.10:34042/action',
  },
  {
    id: 'uuid:samsung-oled-udn',
    friendlyName: '34" Odyssey OLED G8',
    modelName: 'Odyssey OLED G8',
    modelDescription: 'Samsung OLED Monitor',
    manufacturer: 'Samsung',
    location: 'http://192.0.2.30:9197/dmr',
    controlUrl: 'http://192.0.2.30:9197/action',
  },
]

const SAMPLE_LOCAL_ENDPOINTS: AudioEndpointInfo[] = [
  {
    id: 'system_default',
    transport: 'system_default',
    displayName: 'Default Audio Device',
    wasapiName: 'Speakers (Game-Audeze Maxwell)',
    udn: null,
    isAvailable: true,
    supportsDsd: false,
    isBitPerfectCapable: false,
  },
  {
    id: 'wasapi:Speakers (Game-Audeze Maxwell)',
    transport: 'wasapi',
    displayName: 'Speakers (Game-Audeze Maxwell)',
    wasapiName: 'Speakers (Game-Audeze Maxwell)',
    udn: null,
    isAvailable: true,
    supportsDsd: false,
    isBitPerfectCapable: false,
  },
  {
    id: 'wasapi:Odyssey G85SB (NVIDIA High Definition Audio)',
    transport: 'wasapi',
    displayName: 'Odyssey G85SB (NVIDIA High Definition Audio)',
    wasapiName: 'Odyssey G85SB (NVIDIA High Definition Audio)',
    udn: null,
    isAvailable: true,
    supportsDsd: false,
    isBitPerfectCapable: false,
  },
]

async function testStartupDiscoveryRaceDoesNotOverrideWasapiSelection() {
  const ssdpDeferred = deferred<UpnpDeviceInfo[]>()
  const setCalls: AudioEndpoint[] = []
  let currentBackendSelected: AudioEndpoint = { transport: 'system_default' }
  let currentBackendActive: AudioEndpoint | null = { transport: 'system_default' }

  const bridge: EndpointRoutingBridge = {
    async listAudioEndpoints() {
      return SAMPLE_LOCAL_ENDPOINTS
    },
    async discoverUpnpDevices() {
      return ssdpDeferred.promise
    },
    async setAudioEndpoint(ep) {
      setCalls.push(ep)
      currentBackendSelected = ep
      currentBackendActive = ep
    },
    async getPlaybackStatus(): Promise<EndpointPlaybackStatusLike> {
      return {
        selectedEndpoint: currentBackendSelected,
        activeBackendEndpoint: currentBackendActive,
        deviceType: currentBackendActive?.transport === 'upnp' ? 'upnp_streamer' : 'wasapi_shared',
        signalPathMode: currentBackendActive?.transport === 'upnp' ? 'upnp_raw_stream' : 'wasapi_shared',
        isBitPerfect: currentBackendActive?.transport === 'upnp',
        outputSampleRate: currentBackendActive?.transport === 'upnp' ? null : 44100,
      }
    },
  }

  const storage = createMemoryStorage()
  const controller = createEndpointRoutingController(bridge, storage)

  const inventoryPromise = controller.refreshInventory()
  const maxwell: AudioEndpoint = {
    transport: 'wasapi',
    name: 'Speakers (Game-Audeze Maxwell)',
  }
  const selectRes = await controller.selectEndpoint(maxwell)
  assert.equal(selectRes.ok, true)

  // SSDP finishes AFTER user selected WASAPI
  ssdpDeferred.resolve(SAMPLE_UPNP)
  await inventoryPromise

  const state = controller.getState()
  assert.equal(isSameEndpoint(state.selectedEndpoint, maxwell), true)
  assert.equal(isSameEndpoint(state.activeBackendEndpoint, maxwell), true)
  assert.equal(state.deviceType, 'wasapi_shared')
  assert.equal(state.upnpDevices.length, 2)
  assert.equal(
    state.availableEndpoints.some((e) => e.id === 'upnp:uuid:rose-130-udn'),
    true
  )
  // Discovery must NEVER call setAudioEndpoint with ROSE-67
  assert.deepEqual(setCalls, [maxwell])
}

async function testStaleAsyncDiscoveryAndBootDoNotOverwriteNewerSelection() {
  const firstDiscovery = deferred<UpnpDeviceInfo[]>()
  const secondDiscovery = deferred<UpnpDeviceInfo[]>()
  const bootSet = deferred<void>()
  let discoveryCall = 0
  let currentSelected: AudioEndpoint = { transport: 'system_default' }

  const bridge: EndpointRoutingBridge = {
    async listAudioEndpoints() {
      return SAMPLE_LOCAL_ENDPOINTS
    },
    async discoverUpnpDevices() {
      discoveryCall += 1
      return discoveryCall === 1 ? firstDiscovery.promise : secondDiscovery.promise
    },
    async setAudioEndpoint(ep) {
      if (ep.transport === 'wasapi' && ep.name === 'Old Saved DAC') {
        await bootSet.promise
        throw new Error("Audio device 'Old Saved DAC' is unavailable.")
      }
      currentSelected = ep
    },
    async getPlaybackStatus() {
      return {
        selectedEndpoint: currentSelected,
        activeBackendEndpoint: currentSelected,
        deviceType: 'wasapi_shared',
        signalPathMode: 'wasapi_shared',
        isBitPerfect: false,
        outputSampleRate: 48000,
      }
    },
  }

  const storage = createMemoryStorage({
    'cadence:selected_endpoint': JSON.stringify({ transport: 'wasapi', name: 'Old Saved DAC' }),
  })
  const controller = createEndpointRoutingController(bridge, storage)

  const bootPromise = controller.initializeStartup()
  const maxwell: AudioEndpoint = {
    transport: 'wasapi',
    name: 'Speakers (Game-Audeze Maxwell)',
  }

  // Capture a stale poll epoch before the newer user selection
  const stalePollEpoch = controller.getState().selectionEpoch
  await controller.selectEndpoint(maxwell)

  // Stale boot call fails late: must NOT overwrite Maxwell with unavailable/error!
  bootSet.resolve()
  await bootPromise

  // Stale poll captured before user selection must NOT overwrite newer selection!
  controller.reconcilePolledStatus(
    {
      selectedEndpoint: { transport: 'upnp', udn: 'uuid:rose-130-udn', friendlyName: 'ROSE-67' },
      activeBackendEndpoint: { transport: 'upnp', udn: 'uuid:rose-130-udn', friendlyName: 'ROSE-67' },
      deviceType: 'upnp_streamer',
      signalPathMode: 'upnp_raw_stream',
      isBitPerfect: true,
    },
    stalePollEpoch
  )

  let state = controller.getState()
  assert.equal(isSameEndpoint(state.selectedEndpoint, maxwell), true)
  assert.equal(isSameEndpoint(state.activeBackendEndpoint, maxwell), true)
  assert.equal(state.endpointError, null)

  // Stale async discovery resolving out of order must not overwrite newer inventory
  const d1 = controller.refreshInventory()
  const d2 = controller.refreshInventory()
  secondDiscovery.resolve([SAMPLE_UPNP[0]])
  await d2
  firstDiscovery.resolve([SAMPLE_UPNP[1]])
  await d1

  state = controller.getState()
  assert.deepEqual(
    state.upnpDevices.map((d) => d.id),
    ['uuid:rose-130-udn']
  )
}

async function testUnavailableEndpointPreservesSelectionAndAutoAdvanceError() {
  const bridge: EndpointRoutingBridge = {
    async listAudioEndpoints() {
      return SAMPLE_LOCAL_ENDPOINTS
    },
    async discoverUpnpDevices() {
      return SAMPLE_UPNP
    },
    async setAudioEndpoint(ep) {
      if (ep.transport === 'wasapi' && ep.name === 'Unplugged Headphone') {
        throw new Error("Audio device 'Unplugged Headphone' is unavailable.")
      }
    },
    async getPlaybackStatus() {
      return {
        selectedEndpoint: { transport: 'wasapi', name: 'Unplugged Headphone' },
        activeBackendEndpoint: null,
        deviceType: 'unavailable',
        signalPathMode: 'unavailable',
        isBitPerfect: false,
        outputSampleRate: null,
      }
    },
  }

  const storage = createMemoryStorage()
  const controller = createEndpointRoutingController(bridge, storage)
  const unplugged: AudioEndpoint = { transport: 'wasapi', name: 'Unplugged Headphone' }
  const res = await controller.selectEndpoint(unplugged)

  assert.equal(res.ok, false)
  assert.match(res.error || '', /unavailable/)

  const state = controller.getState()
  assert.equal(isSameEndpoint(state.selectedEndpoint, unplugged), true)
  assert.equal(state.activeBackendEndpoint, null)
  assert.equal(state.deviceType, 'unavailable')
  assert.equal(state.signalPathMode, 'unavailable')
  assert.equal(state.isBitPerfect, false)
  assert.equal(state.outputSampleRate, undefined)
  assert.equal(
    parseStoredEndpoint(
      storage.getItem('cadence:selected_endpoint'),
      storage.getItem('cadence:active_device')
    )?.transport,
    'wasapi'
  )

  // Simulated auto-advance / DSD failure while WASAPI selected keeps WASAPI selection untouched
  const maxwell: AudioEndpoint = { transport: 'wasapi', name: 'Speakers (Game-Audeze Maxwell)' }
  const okRes = await controller.selectEndpoint(maxwell)
  assert.equal(okRes.ok, true)
  controller.setEndpointError(
    "Selected output 'Speakers (Game-Audeze Maxwell)' (WASAPI Shared) does not support native DSD (.dsf/.dff) playback."
  )
  await controller.reconcilePolledStatus(
    {
      selectedEndpoint: maxwell,
      activeBackendEndpoint: maxwell,
      deviceType: 'wasapi_shared',
      signalPathMode: 'wasapi_shared_purity',
      purityMode: true,
      isBitPerfect: false,
      outputSampleRate: 44100,
    },
    controller.getState().selectionEpoch
  )
  assert.equal(isSameEndpoint(controller.getState().selectedEndpoint, maxwell), true)
  assert.equal(controller.getState().deviceType, 'wasapi_shared')
  assert.equal(controller.getState().isBitPerfect, false)
}

function testIdentityParsingAndSignalPathTelemetry() {
  // Never infer UPnP from friendly-name substrings
  const hdmiMonitor = endpointFromLegacyString(
    'Odyssey G85SB (NVIDIA High Definition Audio)',
    SAMPLE_UPNP
  )
  assert.deepEqual(hdmiMonitor, {
    transport: 'wasapi',
    name: 'Odyssey G85SB (NVIDIA High Definition Audio)',
  })

  const fuzzyBrand = endpointFromLegacyString('HiFi Rose', SAMPLE_UPNP)
  assert.deepEqual(fuzzyBrand, { transport: 'wasapi', name: 'HiFi Rose' })

  const exactUpnp = endpointFromLegacyString('upnp:uuid:rose-130-udn', SAMPLE_UPNP)
  assert.deepEqual(exactUpnp, {
    transport: 'upnp',
    udn: 'uuid:rose-130-udn',
    friendlyName: 'ROSE-67',
  })

  // Purity Mode on WASAPI must NOT claim proven bit-perfect or WASAPI Exclusive
  const maxwell: AudioEndpoint = { transport: 'wasapi', name: 'Speakers (Game-Audeze Maxwell)' }
  const wasapiPurityDesc = describeSignalPath({
    selectedEndpoint: maxwell,
    activeBackendEndpoint: maxwell,
    deviceType: 'wasapi_shared',
    signalPathMode: 'wasapi_shared_purity',
    isPurityMode: true,
    isBitPerfect: false,
    volume: 1,
    isMuted: false,
    outputSampleRate: 44100,
  })
  assert.equal(wasapiPurityDesc.pillLabel, 'WASAPI Shared · Purity')
  assert.equal(wasapiPurityDesc.transportLabel, 'WASAPI Shared')
  assert.equal(wasapiPurityDesc.isProvenBitPerfect, false)
  assert.equal(wasapiPurityDesc.gainIsLocked, true)
  assert.equal(wasapiPurityDesc.canShowDacRate, true)

  // UPnP telemetry must not show stale local DAC sample rate
  const rose: AudioEndpoint = {
    transport: 'upnp',
    udn: 'uuid:rose-130-udn',
    friendlyName: 'ROSE-67',
  }
  const upnpDesc = describeSignalPath({
    selectedEndpoint: rose,
    activeBackendEndpoint: rose,
    deviceType: 'upnp_streamer',
    signalPathMode: 'upnp_raw_stream',
    isPurityMode: false,
    isBitPerfect: true,
    volume: 0.7,
    isMuted: false,
    outputSampleRate: undefined,
  })
  assert.equal(upnpDesc.pillLabel, 'UPnP')
  assert.equal(upnpDesc.canShowDacRate, false)
  assert.equal(upnpDesc.isProvenBitPerfect, true)

  // Unavailable endpoint reports unavailable honestly
  const unavailableDesc = describeSignalPath({
    selectedEndpoint: maxwell,
    activeBackendEndpoint: null,
    deviceType: 'unavailable',
    signalPathMode: 'unavailable',
    isPurityMode: false,
    isBitPerfect: false,
    volume: 1,
    isMuted: false,
    outputSampleRate: undefined,
  })
  assert.equal(unavailableDesc.pillLabel, 'Unavailable')
  assert.equal(unavailableDesc.transportLabel, 'Unavailable')
  assert.equal(unavailableDesc.isProvenBitPerfect, false)
  assert.equal(unavailableDesc.canShowDacRate, false)
}

async function testNoopPollSkipsEmitAndStorageWrite() {
  const rose: AudioEndpoint = {
    transport: 'upnp',
    udn: 'uuid:rose-130-udn',
    friendlyName: 'ROSE-67',
  }
  const bridge: EndpointRoutingBridge = {
    async listAudioEndpoints() {
      return SAMPLE_LOCAL_ENDPOINTS
    },
    async discoverUpnpDevices() {
      return SAMPLE_UPNP
    },
    async setAudioEndpoint() {},
    async getPlaybackStatus() {
      return {
        selectedEndpoint: rose,
        activeBackendEndpoint: rose,
        deviceType: 'upnp_streamer',
        signalPathMode: 'upnp_raw_stream',
        isBitPerfect: true,
        outputSampleRate: 11289600,
      }
    },
  }

  let storageWrites = 0
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageWrites += 1
      data.set(key, value)
    },
  }

  let emissions = 0
  const controller = createEndpointRoutingController(bridge, storage, () => {
    emissions += 1
  })
  await controller.selectEndpoint(rose)
  const snapshot: EndpointPlaybackStatusLike = {
    selectedEndpoint: rose,
    activeBackendEndpoint: rose,
    deviceType: 'upnp_streamer',
    signalPathMode: 'upnp_raw_stream',
    isBitPerfect: true,
    outputSampleRate: 11289600,
  }
  controller.reconcilePolledStatus(snapshot, controller.getState().selectionEpoch)

  const baselineEmissions = emissions
  const baselineWrites = storageWrites
  for (let i = 0; i < 10; i++) {
    controller.reconcilePolledStatus(snapshot, controller.getState().selectionEpoch)
  }
  assert.equal(emissions, baselineEmissions, 'unchanged poll must not trigger onChange')
  assert.equal(storageWrites, baselineWrites, 'unchanged poll must not rewrite localStorage')

  // Changed sample rate emits once and does not rewrite storage
  controller.reconcilePolledStatus(
    { ...snapshot, outputSampleRate: 44100 },
    controller.getState().selectionEpoch
  )
  assert.equal(emissions, baselineEmissions + 1)
  assert.equal(storageWrites, baselineWrites)
}

async function main() {
  await testStartupDiscoveryRaceDoesNotOverrideWasapiSelection()
  await testStaleAsyncDiscoveryAndBootDoNotOverwriteNewerSelection()
  await testUnavailableEndpointPreservesSelectionAndAutoAdvanceError()
  testIdentityParsingAndSignalPathTelemetry()
  await testNoopPollSkipsEmitAndStorageWrite()
  console.log('ALL ENDPOINT ROUTING REGRESSION TESTS PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

