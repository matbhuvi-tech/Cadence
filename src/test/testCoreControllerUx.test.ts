import assert from 'node:assert/strict'
import { test  } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CORE_PROTOCOL_VERSION,
  type CoreCatalogTrack,
  type CoreCommand,
  type CoreRequest,
  type CoreSnapshot,
} from '../core/coreProtocol'
import type { EngineActivity, EngineContext } from '../core/engineSession'
import type { AuthenticatedCoreChannel } from '../services/engineService'

// Ensure SSR globals exist before importing UI modules
if (typeof globalThis.window === 'undefined') {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { href: 'http://localhost:5173', search: '', pathname: '/' },
    localStorage: storage,
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    __TAURI_INTERNALS__: undefined,
  }
  ;(globalThis as Record<string, unknown>).document = {
    getElementById: () => ({ innerHTML: '', appendChild: () => {} }),
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {}, classList: { add: () => {}, remove: () => {} } },
  }
  ;(globalThis as Record<string, unknown>).localStorage = storage
}

function createFakeCoreNode(options?: {
  engineId?: string
  libraryId?: string
  label?: string
  tracks?: CoreCatalogTrack[]
  initialActivity?: EngineActivity
  initialQueueTrackId?: string
  ready?: boolean
  authenticated?: boolean
  protocolVersion?: number
  capabilities?: string[]
  output?: CoreSnapshot['output']
}) {
  const engineId = options?.engineId ?? 'core_living_room'
  const libraryId = options?.libraryId ?? 'lib_nas_master'
  const label = options?.label ?? 'Music Room Core'
  const tracks: CoreCatalogTrack[] = options?.tracks ?? [
    { id: 'trk_1', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', durationSeconds: 545 },
    { id: 'trk_2', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', durationSeconds: 327 },
  ]
  let revision = options?.initialActivity && options.initialActivity !== 'idle' ? 3 : 0
  let activity: EngineActivity = options?.initialActivity ?? 'idle'
  let positionSeconds = activity === 'playing' ? 42 : 0
  let entries = options?.initialQueueTrackId
    ? [{ entryId: 'entry_1', trackId: options.initialQueueTrackId }]
    : []
  let currentEntryId: string | null = entries[0]?.entryId ?? null
  let repeat: 'off' | 'one' | 'all' = 'off'
  let shuffle = false
  let disconnected = false
  const receivedCommands: CoreCommand[] = []
  const seenCommands = new Map<string, CoreSnapshot>()

  const snapshot = (): CoreSnapshot => ({
    engineId,
    libraryId,
    revision,
    catalog: {
      revision: 0,
      tracks: tracks.slice(0, 200),
      nextCursor: tracks.length > 200 ? 'page_200' : null,
    },
    queue: {
      entries: structuredClone(entries),
      currentEntryId,
      repeat,
      shuffle,
    },
    playback: {
      activity,
      positionSeconds,
    },
    output: options?.output === undefined
      ? { id: 'rs130_udn', label: 'RS130', transport: 'upnp' }
      : options.output,
  })

  const channel: AuthenticatedCoreChannel = {
    async verifyPeer() {
      if (disconnected) throw new Error('network down')
      return {
        authenticated: options?.authenticated ?? true,
        engineId,
        libraryId,
      }
    },
    async request(req: CoreRequest) {
      if (disconnected) throw new Error('network down')
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          data: {
            protocolVersion: options?.protocolVersion ?? CORE_PROTOCOL_VERSION,
            engineId,
            libraryId,
            label,
            capabilities: options?.capabilities ?? [
              'catalog.read',
              'session.read',
              'playback.control',
              'queue.write',
              'queue.coordinate',
            ],
            ready: options?.ready ?? true,
          },
        }
      }
      if (req.operation === 'session.snapshot') {
        return { ok: true, data: snapshot() }
      }
      if (req.operation === 'catalog.page') {
        const start = req.cursor?.startsWith('page_') ? Number(req.cursor.slice(5)) || 0 : 0
        const pageTracks = tracks.slice(start, start + req.limit)
        const nextOffset = start + pageTracks.length
        return {
          ok: true,
          data: {
            revision: 0,
            tracks: pageTracks,
            nextCursor: nextOffset < tracks.length ? `page_${nextOffset}` : null,
          },
        }
      }
      if (seenCommands.has(req.commandId)) {
        return { ok: true, data: seenCommands.get(req.commandId)! }
      }
      if (req.expectedRevision !== revision) {
        return {
          ok: false,
          error: { code: 'stale_revision', snapshot: snapshot() },
        }
      }
      receivedCommands.push(req)
      if (req.operation === 'playback.control') {
        if (req.action === 'play') {
          const existing = entries.find((e) => e.trackId === req.trackId)
          if (existing) {
            currentEntryId = existing.entryId
          } else {
            const entry = { entryId: `entry_${revision + 1}`, trackId: req.trackId }
            entries = [...entries, entry]
            currentEntryId = entry.entryId
          }
          activity = 'playing'
          positionSeconds = 0
        } else if (req.action === 'pause') {
          activity = 'paused'
        } else if (req.action === 'resume') {
          activity = 'playing'
        } else if (req.action === 'stop') {
          activity = 'idle'
          positionSeconds = 0
        } else if (req.action === 'seek') {
          positionSeconds = req.positionSeconds
        }
      } else if (req.operation === 'queue.replace') {
        entries = req.entries.map((e) => ({ ...e }))
        currentEntryId = entries[0]?.entryId ?? null
      } else if (req.operation === 'queue.control') {
        if (req.action === 'modes') {
          repeat = req.repeat
          shuffle = req.shuffle
        } else if (req.action === 'jump') {
          currentEntryId = req.entryId
          activity = 'playing'
          positionSeconds = 0
        } else if (req.action === 'next' && entries.length > 0) {
          const idx = entries.findIndex((e) => e.entryId === currentEntryId)
          currentEntryId = entries[(idx + 1) % entries.length].entryId
          activity = 'playing'
        } else if (req.action === 'previous' && entries.length > 0) {
          const idx = entries.findIndex((e) => e.entryId === currentEntryId)
          currentEntryId = entries[Math.max(0, idx - 1)].entryId
          activity = 'playing'
        }
      }
      revision += 1
      const snap = snapshot()
      seenCommands.set(req.commandId, snap)
      return { ok: true, data: snap }
    },
  }

  return {
    context: { kind: 'core', engineId, libraryId, label } satisfies EngineContext,
    channel,
    setDisconnected: (value: boolean) => {
      disconnected = value
    },
    getActivity: () => activity,
    getCommands: () => [...receivedCommands],
  }
}

test('Phase 7 controller store defaults to This PC with zero startup Core I/O', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  let discoveryCalls = 0
  let localStopCalls = 0
  let localPlayCalls = 0

  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => {
        localStopCalls++
        return true
      },
      request: async () => ({ ok: true, data: {} }),
      onLocalAutoPlayCheck: () => {
        localPlayCalls++
      },
    },
    discoverNodes: async () => {
      discoveryCalls++
      return []
    },
  })

  const state = store.getState()
  assert.equal(state.view.session.active.kind, 'local')
  assert.equal(state.view.session.active.label, 'This PC')
  assert.equal(state.view.session.connected, true)
  assert.equal(discoveryCalls, 0)
  assert.equal(localStopCalls, 0)
  assert.equal(localPlayCalls, 0)
})

test('startup recovers a saved LAN profile over pinned loopback HTTPS once ready', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const node = createFakeCoreNode()
  const certFingerprint = 'ab'.repeat(32)
  const profile = { ...node.context, baseUrl: 'https://127.0.0.1:4040', certFingerprint, musicRoots: [] }
  let probes = 0
  let activations = 0
  const store = createDesktopCoreControllerStore({
    storage: {
      getItem: () => JSON.stringify([{ ...profile, baseUrl: 'https://192.168.1.42:4040' }]),
      setItem: () => {},
    },
    readLocalPairingEndpoint: async () => profile,
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    httpBridge: {
      async probeHealth(target) {
        assert.equal(target.baseUrl, profile.baseUrl)
        assert.equal(target.certFingerprint, certFingerprint)
        assert.equal(target.trustInsecure, false)
        return { ...node.context, ready: ++probes > 1, tlsFingerprintSha256: certFingerprint }
      },
      postCoreRequest: (_target, request) => node.channel.request(request),
    },
    channelFactory: () => {
      activations++
      return node.channel
    },
  })

  try {
    const startup = store.bootstrapStartupConnection()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(store.getState().startupConnection?.phase, 'waiting')
    assert.equal(activations, 0)
    await startup
    assert.equal(store.getState().view.session.active.kind, 'core')
    assert.equal(store.getState().activeProfile?.baseUrl, profile.baseUrl)
    assert.equal(store.getState().startupConnection?.phase, 'ready')
    assert.equal(activations, 1)
  } finally {
    store.dispose()
  }
})

test('startup prefers active readLocalPairingEndpoint profile when both Tray and Service loopback profiles are saved', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const trayNode = createFakeCoreNode({ engineId: 'core_tray', libraryId: 'lib_tray', label: 'Tray Engine' })
  const svcNode = createFakeCoreNode({ engineId: 'core_svc', libraryId: 'lib_svc', label: 'Service Engine' })
  const trayFp = '11'.repeat(32)
  const svcFp = '22'.repeat(32)
  const trayProfile = { ...trayNode.context, baseUrl: 'https://127.0.0.1:4040', certFingerprint: trayFp, musicRoots: [] }
  const svcProfile = { ...svcNode.context, baseUrl: 'https://127.0.0.1:4040', certFingerprint: svcFp, musicRoots: [] }
  const probedEngines: string[] = []

  const store = createDesktopCoreControllerStore({
    storage: {
      getItem: () => JSON.stringify([trayProfile, svcProfile]),
      setItem: () => {},
    },
    readLocalPairingEndpoint: async () => svcProfile,
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    httpBridge: {
      async probeHealth(target) {
        probedEngines.push(target.engineId)
        assert.equal(target.engineId, svcProfile.engineId)
        assert.equal(target.certFingerprint, svcFp)
        return { ...svcNode.context, ready: true, tlsFingerprintSha256: svcFp }
      },
      postCoreRequest: (_target, request) => svcNode.channel.request(request),
    },
    channelFactory: () => svcNode.channel,
  })

  try {
    await store.bootstrapStartupConnection()
    assert.deepEqual(probedEngines, ['core_svc', 'core_svc'])
    assert.equal(store.getState().view.session.active.kind, 'core')
    assert.equal(store.getState().activeProfile?.engineId, 'core_svc')
    assert.equal(store.getState().startupConnection?.phase, 'ready')
  } finally {
    store.dispose()
  }
})

test('startup falls back to discoverNodes when stale Tray loopback profile fails with untrusted_peer', async () => {
  const { createDesktopCoreControllerStore, CoreServiceError } = await import('../services/coreControllerTransport')
  const trayNode = createFakeCoreNode({ engineId: 'core_tray', libraryId: 'lib_tray', label: 'Tray Engine' })
  const svcNode = createFakeCoreNode({ engineId: 'core_svc', libraryId: 'lib_svc', label: 'Service Engine' })
  const trayFp = '11'.repeat(32)
  const svcFp = '22'.repeat(32)
  const trayProfile = { ...trayNode.context, baseUrl: 'https://127.0.0.1:4040', certFingerprint: trayFp, musicRoots: [] }
  const svcDiscovered = {
    ...svcNode.context,
    baseUrl: 'https://127.0.0.1:4040',
    certFingerprint: svcFp,
    pairingToken: 'svc-token',
  }
  let discoverCalls = 0

  const store = createDesktopCoreControllerStore({
    storage: {
      getItem: () => JSON.stringify([trayProfile]),
      setItem: () => {},
    },
    readLocalPairingEndpoint: async () => svcDiscovered,
    discoverNodes: async () => {
      discoverCalls++
      return [svcDiscovered]
    },
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    httpBridge: {
      async probeHealth() {
        throw new CoreServiceError('untrusted_peer')
      },
      postCoreRequest: (_target, request) => trayNode.channel.request(request),
    },
  })

  try {
    await store.bootstrapStartupConnection()
    assert.equal(store.getState().startupConnection?.phase, 'failed')
    assert.equal(discoverCalls, 1)
    assert.equal(store.getState().discoveredCores.length, 1)
    assert.equal(store.getState().discoveredCores[0].engineId, 'core_svc')
  } finally {
    store.dispose()
  }
})

test('Phase 7 Add/Cancel/Fail/Prepare/Activate Core preserves prior state on cancel or failure and commits atomically without auto-play', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')

  const emptyCore = createFakeCoreNode({ engineId: 'core_empty', tracks: [] })
  const readyCore = createFakeCoreNode()
  const untrustedCore = createFakeCoreNode({ engineId: 'core_untrusted', authenticated: false })
  const incompatibleCore = createFakeCoreNode({ engineId: 'core_v99', protocolVersion: 99 })

  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    channelFactory: (profile) => {
      if (profile.engineId === 'core_empty') return emptyCore.channel
      if (profile.engineId === 'core_untrusted') return untrustedCore.channel
      if (profile.engineId === 'core_v99') return incompatibleCore.channel
      return readyCore.channel
    },
  })

  // 1. Prepare empty Core -> stays on This PC until user clicks Use this Core
  const prepEmpty = await store.stageCandidate({
    engineId: 'core_empty',
    libraryId: 'lib_nas_master',
    label: 'Empty Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: [],
  })
  assert.equal(prepEmpty.ok, true)
  assert.equal(store.getState().view.session.active.kind, 'local')
  assert.equal(store.getState().stagedCandidate?.needsMusicRoots, true)

  // Cancel staging retains This PC cleanly
  store.cancelStaging()
  assert.equal(store.getState().stagedCandidate, null)
  assert.equal(store.getState().view.session.active.kind, 'local')

  // 2. Fail untrusted & incompatible protocol -> retains previous session with safe error
  const failUntrusted = await store.stageCandidate({
    engineId: 'core_untrusted',
    libraryId: 'lib_nas_master',
    label: 'Untrusted Core',
    baseUrl: 'https://192.168.1.51:4040',
    musicRoots: ['/music'],
  })
  assert.equal(failUntrusted.ok, false)
  assert.equal(store.getState().view.session.active.kind, 'local')

  const failProtocol = await store.stageCandidate({
    engineId: 'core_v99',
    libraryId: 'lib_nas_master',
    label: 'Future Core',
    baseUrl: 'https://192.168.1.52:4040',
    musicRoots: ['/music'],
  })
  assert.equal(failProtocol.ok, false)
  assert.equal(store.getState().view.session.active.kind, 'local')

  // 3. Stage & activate ready Core -> atomic commit, zero auto-play
  const staged = await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  })
  assert.equal(staged.ok, true)
  assert.equal(store.getState().view.session.active.kind, 'local')

  const activated = await store.activateStagedCore()
  assert.equal(activated, 'activated')
  const after = store.getState()
  assert.equal(after.view.session.active.kind, 'core')
  assert.equal(after.view.session.active.label, 'Music Room Core')
  assert.equal(after.view.snapshot?.output?.label, 'RS130')
  assert.equal(after.view.snapshot?.catalog.tracks.length, 2)
  assert.equal(readyCore.getCommands().length, 0)
})

test('Phase 7 Switch Guard & Leave Core enforce explicit stop/keep choices with no auto-local audio and leave Core running on close', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  let localActivity: EngineActivity = 'playing'
  let localStopCount = 0
  let localPlayTriggered = false
  const playingCore = createFakeCoreNode({
    initialActivity: 'playing',
    initialQueueTrackId: 'trk_1',
  })

  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => localActivity,
      stopAndAcknowledge: async () => {
        localStopCount++
        localActivity = 'idle'
        return true
      },
      request: async () => ({ ok: true, data: {} }),
      onLocalAutoPlayCheck: () => {
        localPlayTriggered = true
      },
    },
    channelFactory: () => playingCore.channel,
  })

  const profile = {
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  }

  // Attempting to switch while This PC is playing requires explicit stop choice
  await store.stageCandidate(profile)
  const outcome = await store.activateStagedCore()
  assert.equal(outcome, 'requires_stop')
  assert.equal(store.getState().switchPrompt?.kind, 'local_to_core')
  assert.equal(store.getState().view.session.active.kind, 'local')

  // Keep listening here cancels switch cleanly
  store.dismissSwitchPrompt()
  assert.equal(store.getState().switchPrompt, null)
  assert.equal(localStopCount, 0)

  // Stop this PC and use Core waits for acknowledged stop and preserves Core's active session
  await store.stageCandidate(profile)
  await store.activateStagedCore()
  const confirmed = await store.confirmLocalToCoreSwitch()
  assert.equal(confirmed, 'activated')
  assert.equal(localStopCount, 1)
  assert.equal(localActivity, 'idle')
  assert.equal(store.getState().view.session.active.kind, 'core')
  assert.equal(store.getState().view.snapshot?.playback.activity, 'playing')
  assert.equal(store.getState().view.snapshot?.queue.currentEntryId, 'entry_1')

  // Leaving Core while Core is playing requires explicit choice
  const leaveOutcome = await store.requestSwitchToLocal()
  assert.equal(leaveOutcome, 'requires_stop')
  assert.equal(store.getState().switchPrompt?.kind, 'core_to_local')

  // Keep Core playing and switch restores This PC without auto-playing local audio
  const left = await store.confirmLeaveCore('leave_core_playing')
  assert.equal(left, 'activated')
  assert.equal(store.getState().view.session.active.kind, 'local')
  assert.equal(playingCore.getActivity(), 'playing')
  assert.equal(localPlayTriggered, false)

  // Re-join Core, then dispose/close controller -> Core session stays playing with no Stop sent
  await store.switchToSavedCore(profile)
  store.dispose()
  assert.equal(playingCore.getActivity(), 'playing')
  assert.equal(
    playingCore.getCommands().some((c) => c.operation === 'playback.control' && c.action === 'stop'),
    false,
  )
})

test('Phase 7 Disconnect retains Core context without auto-fallback or stale replay and Reconnect fetches authoritative snapshot', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const core = createFakeCoreNode({
    initialActivity: 'playing',
    initialQueueTrackId: 'trk_1',
  })

  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    channelFactory: () => core.channel,
  })

  await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  })
  await store.activateStagedCore()
  assert.equal(store.getState().view.session.connected, true)

  // Drop connection and issue command -> no fallback to This PC, no stale replay on reconnect
  core.setDisconnected(true)
  const cmdsBefore = core.getCommands().length
  await assert.rejects(() => store.executeCoreCommand({ operation: 'playback.control', action: 'pause' }))

  const disconnectedState = store.getState()
  assert.equal(disconnectedState.view.session.active.kind, 'core')
  assert.equal(disconnectedState.view.session.connected, false)
  assert.match(disconnectedState.statusAnnouncement, /Connection lost\. Playback may still be continuing\./)

  // Reconnect restores authoritative snapshot without replaying failed pause command
  core.setDisconnected(false)
  const refreshOutcome = await store.reconnect()
  assert.equal(refreshOutcome, 'updated')
  assert.equal(store.getState().view.session.connected, true)
  assert.equal(core.getCommands().length, cmdsBefore)
})

test('Phase 7 Settings modal includes Playback Engine tab with keyboard-accessible tablist and non-animated Core status', async () => {
  const { CadenceSettingsModal } = await import('../components/Modals/CadenceSettingsModal')
  const { DEFAULT_PRIORITY_SETTINGS, evaluateCatalogProblems } = await import('../core/curatePriorities')
  const summary = evaluateCatalogProblems([], [], DEFAULT_PRIORITY_SETTINGS)

  const html = renderToStaticMarkup(
    createElement(CadenceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      initialTab: 'engine',
      prioritySettings: DEFAULT_PRIORITY_SETTINGS,
      prioritySummary: summary,
      onSavePrioritySettings: () => {},
    }),
  )

  assert.equal(html.match(/role="tab"/g)?.length, 4)
  assert.equal(html.match(/role="tabpanel"/g)?.length, 4)
  assert.match(html, /Playback Engine/)
  assert.match(html, /Connect to Cadence Core/)
  assert.match(html, /This PC/)
  assert.doesNotMatch(html, /animate-pulse|animate-ping/)
})

test('Phase 7 RS130 UPnP takeover guard requires explicit confirmation before This PC claims a Core-associated renderer', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const core = createFakeCoreNode({
    output: { id: 'rs130_udn', label: 'RS130', transport: 'upnp' },
  })
  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    channelFactory: () => core.channel,
  })

  await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  })
  await store.activateStagedCore()
  await store.confirmLeaveCore('leave_core_playing')

  let claimedCount = 0
  const endpoint = { transport: 'upnp' as const, udn: 'rs130_udn', friendlyName: 'RS130' }
  const intercepted = store.requestRs130TakeoverIfControlledByCore(endpoint, async () => {
    claimedCount++
  })

  assert.equal(intercepted, true)
  assert.equal(store.getState().switchPrompt?.kind, 'rs130_takeover')
  assert.equal(claimedCount, 0)

  await store.confirmRs130Takeover()
  assert.equal(claimedCount, 1)
  assert.equal(store.getState().switchPrompt, null)
})

test('Phase 7 Per-controller independence: Windows returning to This PC leaves Core playing for Android controller, and closing both sends no Stop', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const { createPwaCoreClient } = await import('../../pwa/src/services/coreRemoteClient')

  const core = createFakeCoreNode({
    initialActivity: 'playing',
    initialQueueTrackId: 'trk_1',
  })

  const desktopStore = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    channelFactory: () => core.channel,
  })

  const profile = {
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  }

  await desktopStore.switchToSavedCore(profile)
  assert.equal(desktopStore.getState().view.session.active.kind, 'core')

  const pwaClient = createPwaCoreClient(
    {
      id: 'https://192.168.1.50:4040',
      label: 'Music Room Core',
      baseUrl: 'https://192.168.1.50:4040',
      port: 4040,
      token: 'core-token',
      engineKind: 'core',
      engineId: 'core_living_room',
      libraryId: 'lib_nas_master',
    },
    async (_url, body) => {
      const req = JSON.parse(body) as CoreRequest
      const reply = await core.channel.request(req)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        errorKind: 'ok',
        body: JSON.stringify(reply),
      }
    },
  )

  const pwaPrepared = await pwaClient.prepare()
  assert.equal(pwaPrepared.snapshot.playback.activity, 'playing')

  // Windows leaves Core playing and returns to This PC -> Android/Core playback unaffected
  await desktopStore.confirmLeaveCore('leave_core_playing')
  assert.equal(desktopStore.getState().view.session.active.kind, 'local')

  const pwaSnapAfterWindowsSwitch = await pwaClient.getSnapshot()
  assert.equal(pwaSnapAfterWindowsSwitch.playback.activity, 'playing')

  // Closing Windows controller sends zero Stop commands
  desktopStore.dispose()
  assert.equal(core.getActivity(), 'playing')
  assert.equal(
    core.getCommands().some((c) => c.operation === 'playback.control' && c.action === 'stop'),
    false,
  )
})

test('Phase 10 catalog hydration paginates beyond the initial 200-track snapshot page', async () => {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const largeTracks: CoreCatalogTrack[] = Array.from({ length: 450 }, (_, idx) => ({
    id: `trk_${idx + 1}`,
    title: `Track ${idx + 1}`,
    artist: 'Orchestra',
    album: `Album ${(idx % 12) + 1}`,
    durationSeconds: 180 + (idx % 60),
  }))
  const core = createFakeCoreNode({ tracks: largeTracks })
  const store = createDesktopCoreControllerStore({
    channelFactory: () => core.channel,
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
  })

  await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: [],
  })
  const outcome = await store.activateStagedCore()
  assert.equal(outcome, 'activated')
  assert.equal(store.getState().hydratedCatalogTracks.length, 450)
  assert.equal(store.getState().hydratedCatalogTracks.at(-1)?.id, 'trk_450')

  await store.requestSwitchToLocal()
  assert.equal(store.getState().hydratedCatalogTracks.length, 0)
  store.dispose()
})

test('Issues #38 and #39: mapCoreCatalogToUi maps WAV/DSD formats & executeCoreCommand preserves connection on not_ready', async () => {
  const { mapCoreCatalogToUi } = await import('../context/EngineControllerContext')
  const { CoreServiceError } = await import('../core/coreProtocol')
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')

  const { tracks, releases } = mapCoreCatalogToUi([
    {
      id: 'trk-wav-1',
      title: 'Masakali',
      artist: 'Mohit Chauhan',
      album: 'Delhi - 6',
      durationSeconds: 290,
      format: 'WAV',
      sampleRate: 44100,
      bitDepth: 16,
      trackNumber: 4,
      discNumber: 1,
      releaseYear: 2009,
    },
    {
      id: 'trk-dsf-1',
      title: 'Blue Rondo',
      artist: 'Dave Brubeck',
      album: 'Time Out',
      durationSeconds: 400,
      format: 'DSF',
      sampleRate: 11289600,
      bitDepth: 1,
      trackNumber: 1,
      discNumber: 1,
      releaseYear: 1959,
    },
  ])
  assert.equal(tracks[0].format, 'WAV')
  assert.equal(tracks[0].sampleRateStr, '16-bit / 44.1 kHz')
  assert.equal(tracks[0].trackNumber, 4)
  assert.equal(tracks[0].isHighRes, false)
  assert.equal(releases[0].releaseYear, 2009)

  assert.equal(tracks[1].format, 'DSD')
  assert.equal(tracks[1].sampleRateStr, 'DSD256 (11.3 MHz)')
  assert.equal(tracks[1].isHighRes, true)
  assert.equal(releases[1].releaseYear, 1959)

  const core = createFakeCoreNode()
  const store = createDesktopCoreControllerStore({
    channelFactory: () => ({
      ...core.channel,
      async request(req) {
        if (req.operation === 'queue.replace') {
          throw new CoreServiceError('not_ready')
        }
        return core.channel.request(req)
      },
    }),
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
  })

  await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: [],
  })
  await store.activateStagedCore()
  await assert.rejects(
    () =>
      store.executeCoreCommand({
        operation: 'queue.replace',
        entries: [{ entryId: 'e1', trackId: 'trk_1' }],
      }),
    /not ready/i,
  )
  assert.equal(store.getState().view.session.connected, true)
  assert.equal(store.getState().lastError?.includes('Connection lost'), false)
  store.dispose()
})

test('Stage P1: mapCoreCatalogToUi separates editions by releaseId and serialized executeCoreCommand prevents stale_revision & gates external RS130 takeover', async () => {
  const { mapCoreCatalogToUi } = await import('../context/EngineControllerContext')
  const { CoreServiceError } = await import('../core/coreProtocol')
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')

  const { tracks, releases } = mapCoreCatalogToUi([
    {
      id: 'trk_sym_1988',
      title: 'Allegro Con Brio',
      artist: 'Berlin Phil',
      album: 'Symphony No. 5',
      releaseId: 'rel_1988',
      edition: '1988',
      durationSeconds: 420,
      format: 'WAV',
      sampleRate: 44100,
      bitDepth: 16,
      trackNumber: 1,
      discNumber: 1,
    },
    {
      id: 'trk_sym_2015',
      title: 'Allegro Con Brio',
      artist: 'Berlin Phil',
      album: 'Symphony No. 5',
      releaseId: 'rel_2015',
      edition: '2015 Remaster',
      durationSeconds: 425,
      format: 'FLAC',
      sampleRate: 192000,
      bitDepth: 24,
      trackNumber: 1,
      discNumber: 1,
    },
    {
      id: 'trk_comp_1',
      title: 'Dawn Raga',
      artist: 'Artist Alpha',
      album: 'A World Of Music',
      albumArtist: 'Various Artists',
      releaseId: 'rel_comp',
      isCompilation: true,
      durationSeconds: 240,
      format: 'FLAC',
      sampleRate: 96000,
      bitDepth: 24,
      trackNumber: 1,
      discNumber: 1,
    },
  ])

  assert.equal(releases.length, 3)
  assert.equal(releases[0].id, 'core_rel_rel_1988')
  assert.equal(releases[0].title, 'Symphony No. 5 (1988)')
  assert.equal(releases[1].id, 'core_rel_rel_2015')
  assert.equal(releases[1].title, 'Symphony No. 5 (2015 Remaster)')
  assert.equal(tracks[2].releaseId, 'core_rel_rel_comp')
  assert.equal(releases[2].artistCredit, 'Various Artists')
  assert.equal(releases[2].isCompilation, true)

  const seenExpectedRevisions: Array<number | undefined> = []
  const core = createFakeCoreNode()
  let throwTakeoverOnce = true
  const baseChannel = core.channel
  const store = createDesktopCoreControllerStore({
    channelFactory: () => ({
      ...baseChannel,
      async request(req) {
        if (req.operation === 'queue.replace' || req.operation === 'playback.control') {
          seenExpectedRevisions.push(req.expectedRevision)
          if (req.operation === 'playback.control' && req.action === 'play' && throwTakeoverOnce) {
            throwTakeoverOnce = false
            const snapReply = await baseChannel.request({ ...req, operation: 'session.snapshot' })
            const snap = snapReply.data as CoreSnapshot
            throw new CoreServiceError('takeover_required', {
              ...snap,
              playback: {
                activity: 'idle',
                positionSeconds: 42,
                owner: 'external',
                takeoverRequired: true,
              },
            })
          }
        }
        return baseChannel.request(req)
      },
    }),
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
  })

  await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  })
  await store.activateStagedCore()

  // Rapid concurrent queue replacements must serialize cleanly with monotonically advancing revisions
  const r1 = store.executeCoreCommand({
    operation: 'queue.replace',
    entries: [{ entryId: 'e1', trackId: 'trk_1' }],
  })
  const r2 = store.executeCoreCommand({
    operation: 'queue.replace',
    entries: [{ entryId: 'e2', trackId: 'trk_2' }],
  })
  await Promise.all([r1, r2])
  assert.equal(seenExpectedRevisions.length, 2)
  assert.equal(seenExpectedRevisions[1], (seenExpectedRevisions[0] ?? 0) + 1)

  // takeover_required opens external_rs130_takeover prompt; dismissing leaves Core undisturbed
  await assert.rejects(
    () =>
      store.executeCoreCommand({
        operation: 'playback.control',
        action: 'play',
        trackId: 'trk_1',
      }),
    /RS130 is currently playing|external/i,
  )
  assert.equal(store.getState().switchPrompt?.kind, 'external_rs130_takeover')
  store.dismissSwitchPrompt()
  assert.equal(store.getState().switchPrompt, null)

  // Confirming external takeover issues forceTakeover play via onConfirm callback
  let callbackInvoked = false
  store.requestExternalRs130Takeover('trk_1', async () => {
    callbackInvoked = true
    await store.executeCoreCommand({
      operation: 'playback.control',
      action: 'play',
      trackId: 'trk_1',
      forceTakeover: true,
    })
  })
  assert.equal(store.getState().switchPrompt?.kind, 'external_rs130_takeover')
  await store.confirmRs130Takeover()
  assert.equal(callbackInvoked, true)
  assert.equal(store.getState().view.snapshot?.playback.activity, 'playing')

  store.dispose()
})

test('graphEngine.filterTracks keeps explicit Core and empty This PC catalogs isolated without leaking', async () => {
  const { graphEngine } = await import('../core/graphEngine')
  const { mapCoreCatalogToUi } = await import('../context/EngineControllerContext')
  graphEngine.loadCustomLibrary({
    tracks: [],
    releases: [],
    works: [],
    auditIssues: [],
    storageMounts: [],
  })

  const { tracks: coreTracks, releases: coreReleases } = mapCoreCatalogToUi([
    {
      id: 'trk_core_iso_1',
      title: 'Core Isolation Track',
      artist: 'Core Artist',
      album: 'Core Album',
      durationSeconds: 180,
      format: 'FLAC',
      sampleRate: 96000,
      bitDepth: 24,
      trackNumber: 1,
      discNumber: 1,
    },
  ])
  const coreFiltered = graphEngine.filterTracks(
    { searchQuery: 'Core Album' },
    coreTracks,
    coreReleases,
  )
  assert.equal(coreFiltered.length, 1)
  assert.equal(graphEngine.getAllTracks().length, 0)
  assert.equal(graphEngine.getAllReleases().length, 0)

  const localEmptyFiltered = graphEngine.filterTracks({ searchQuery: '' }, [], [])
  assert.equal(localEmptyFiltered.length, 0)
})

test('Issue #40 computeCoreDisplayPosition advances monotonically at 1 Hz and loading settle check refreshes loading -> playing', async () => {
  const { computeCoreDisplayPosition } = await import('../hooks/useCorePlaybackClock')
  assert.equal(computeCoreDisplayPosition(0, 1000, 3600, true, true, 180), 2.6)
  // Paused or disconnected freezes at authoritative position
  assert.equal(computeCoreDisplayPosition(14, 1000, 5000, false, true, 180), 14)
  assert.equal(computeCoreDisplayPosition(14, 1000, 5000, true, false, 180), 14)
  // Clamps to durationSeconds when positive
  assert.equal(computeCoreDisplayPosition(178, 1000, 8000, true, true, 180), 180)

  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const settleCore = createFakeCoreNode()
  const baseChannel = settleCore.channel
  let snapshotReadsAfterCommand = 0
  let commandIssued = false

  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    channelFactory: () => ({
      ...baseChannel,
      async request(req) {
        if (req.operation === 'playback.control') {
          commandIssued = true
          const snapReply = await baseChannel.request({ ...req, operation: 'session.snapshot' })
          const snap = snapReply.data as CoreSnapshot
          return {
            ok: true,
            data: {
              ...snap,
              revision: snap.revision + 1,
              queue: {
                ...snap.queue,
                entries: [{ entryId: 'entry_1', trackId: 'trk_1' }],
                currentEntryId: 'entry_1',
              },
              playback: {
                activity: 'loading',
                positionSeconds: 0,
                owner: 'core',
              },
            },
          }
        }
        if (req.operation === 'session.snapshot' && commandIssued) {
          snapshotReadsAfterCommand += 1
          const snapReply = await baseChannel.request(req)
          const snap = snapReply.data as CoreSnapshot
          const settled = snapshotReadsAfterCommand >= 2
          return {
            ok: true,
            data: {
              ...snap,
              revision: snap.revision + 1 + snapshotReadsAfterCommand,
              queue: {
                ...snap.queue,
                entries: [{ entryId: 'entry_1', trackId: 'trk_1' }],
                currentEntryId: 'entry_1',
              },
              playback: {
                activity: settled ? 'playing' : 'loading',
                positionSeconds: settled ? 1 : 0,
                owner: 'core',
              },
            },
          }
        }
        return baseChannel.request(req)
      },
    }),
  })

  await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_nas_master',
    label: 'Music Room Core',
    baseUrl: 'https://192.168.1.50:4040',
    musicRoots: ['/music'],
  })
  assert.equal(await store.activateStagedCore(), 'activated')

  await store.executeCoreCommand({
    operation: 'playback.control',
    action: 'play',
    trackId: 'trk_1',
  })
  assert.equal(store.getState().view.snapshot?.playback.activity, 'loading')

  // Wait ~1.1s for the single-shot 900ms loading settle check (well under 5000ms passive sync)
  await new Promise((resolve) => setTimeout(resolve, 1150))
  assert.equal(snapshotReadsAfterCommand >= 2, true)
  assert.equal(store.getState().view.snapshot?.playback.activity, 'playing')
  assert.equal(store.getState().view.snapshot?.playback.positionSeconds, 1)

  store.dispose()
})
