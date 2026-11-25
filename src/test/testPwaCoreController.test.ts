import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'
import {
  buildProfileCacheKey,
  normalizeBaseUrl,
  parsePairingInput,
} from '../../pwa/src/services/serverProfiles'

// Note: TopHeader, PairingView, DiagnosticsSheet use standard TSX jsx runtime resolving pwa/node_modules/react
// so dynamic import happens after globals are configured.

// Minimal browser globals for importing PWA React components in Node test runner
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
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    location: { href: 'http://localhost:5174', search: '', pathname: '/', origin: 'http://localhost:5174' },
    localStorage: storage,
  }
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
  ;(globalThis as Record<string, unknown>).localStorage = storage
}

test('PWA serverProfiles parses and scopes Cadence Core host profiles separately from desktop', () => {
  const parsed = parsePairingInput(
    'https://192.168.1.50:4040/?token=9182&kind=core&engineId=core_room&libraryId=lib_master&label=Music%20Room%20Core&fp=abcd1234',
  )
  assert.ok(parsed)
  assert.equal(parsed.engineKind, 'core')
  assert.equal(parsed.engineId, 'core_room')
  assert.equal(parsed.libraryId, 'lib_master')
  assert.equal(parsed.label, 'Music Room Core')
  assert.equal(normalizeBaseUrl('192.168.1.50'), 'https://192.168.1.50:4040')
  assert.notEqual(
    buildProfileCacheKey('https://192.168.1.50:4040', '9182', { kind: 'core', engineId: 'core_room', libraryId: 'lib_master' }),
    buildProfileCacheKey('https://192.168.1.50:4040', '9182', { kind: 'local', engineId: 'local', libraryId: 'local' }),
  )
})

test('PWA Core client validates v1 hello, snapshot, commands and rejects mismatched identities', async () => {
  const { createPwaCoreClient } = await import('../../pwa/src/services/coreRemoteClient')
  let currentRevision = 2
  let activity: 'idle' | 'playing' | 'paused' | 'loading' = 'playing'
  const stopCommands: unknown[] = []

  const client = createPwaCoreClient(
    {
      id: 'https://192.168.1.50:4040',
      label: 'Music Room Core',
      baseUrl: 'https://192.168.1.50:4040',
      port: 4040,
      token: 'core-token',
      engineKind: 'core',
      engineId: 'core_room',
      libraryId: 'lib_master',
    },
    async (_url, body) => {
      const req = JSON.parse(body)
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: true,
            data: {
              protocolVersion: 1,
              engineId: 'core_room',
              libraryId: 'lib_master',
              label: 'Music Room Core',
              capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write', 'queue.coordinate'],
              ready: true,
            },
          }),
        }
      }
      if (req.operation === 'playback.control' && req.action === 'stop') {
        stopCommands.push(req)
        activity = 'idle'
        currentRevision++
      } else if (req.operation === 'playback.control' && req.action === 'pause') {
        activity = 'paused'
        currentRevision++
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        errorKind: 'ok',
        body: JSON.stringify({
          ok: true,
          data: {
            engineId: 'core_room',
            libraryId: 'lib_master',
            revision: currentRevision,
            catalog: {
              revision: 0,
              tracks: [{ id: 'trk_1', title: 'Track 1', artist: 'Artist', album: 'Album', durationSeconds: 200 }],
              nextCursor: null,
            },
            queue: {
              entries: [{ entryId: 'e1', trackId: 'trk_1' }],
              currentEntryId: 'e1',
              repeat: 'off',
              shuffle: false,
            },
            playback: { activity, positionSeconds: 18 },
            output: { id: 'rs130', label: 'RS130', transport: 'upnp' },
          },
        }),
      }
    },
  )

  const prepared = await client.prepare()
  assert.equal(prepared.descriptor.label, 'Music Room Core')
  assert.equal(prepared.snapshot.output?.label, 'RS130')

  const paused = await client.execute({
    operation: 'playback.control',
    action: 'pause',
    commandId: 'cmd_pause_1',
    expectedRevision: prepared.snapshot.revision,
  })
  assert.equal(paused.playback.activity, 'paused')
  assert.equal(stopCommands.length, 0)

  // Mismatched Core identity is rejected cleanly
  const mismatchClient = createPwaCoreClient(
    {
      id: 'https://192.168.1.50:4040',
      label: 'Other Core',
      baseUrl: 'https://192.168.1.50:4040',
      port: 4040,
      token: 'core-token',
      engineKind: 'core',
      engineId: 'wrong_engine',
      libraryId: 'lib_master',
    },
    async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      errorKind: 'ok',
      body: JSON.stringify({
        ok: true,
        data: {
          protocolVersion: 1,
          engineId: 'core_room',
          libraryId: 'lib_master',
          label: 'Music Room Core',
          capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
          ready: true,
        },
      }),
    }),
  )
  await assert.rejects(() => mismatchClient.prepare(), { code: 'identity_mismatch' })

  // Stale revision returns authoritative snapshot without silently replaying
  const staleClient = createPwaCoreClient(
    {
      id: 'https://192.168.1.50:4040',
      label: 'Music Room Core',
      baseUrl: 'https://192.168.1.50:4040',
      port: 4040,
      token: 'core-token',
      engineKind: 'core',
      engineId: 'core_room',
      libraryId: 'lib_master',
    },
    async (_url, body) => {
      const req = JSON.parse(body)
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: true,
            data: {
              protocolVersion: 1,
              engineId: 'core_room',
              libraryId: 'lib_master',
              label: 'Music Room Core',
              capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
              ready: true,
            },
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        errorKind: 'ok',
        body: JSON.stringify({
          ok: false,
          error: {
            code: 'stale_revision',
            snapshot: {
              engineId: 'core_room',
              libraryId: 'lib_master',
              revision: 9,
              catalog: { revision: 0, tracks: [], nextCursor: null },
              queue: { entries: [], currentEntryId: null, repeat: 'off', shuffle: false },
              playback: { activity: 'paused', positionSeconds: 18 },
              output: { id: 'rs130', label: 'RS130', transport: 'upnp' },
            },
          },
        }),
      }
    },
  )
  await assert.rejects(
    () =>
      staleClient.execute({
        operation: 'playback.control',
        action: 'play',
        trackId: 'trk_1',
        commandId: 'cmd_stale',
        expectedRevision: 1,
      }),
    (err: unknown) =>
      err instanceof Error &&
      'code' in err &&
      (err as { code: string; snapshot?: { revision: number } }).code === 'stale_revision' &&
      (err as { snapshot?: { revision: number } }).snapshot?.revision === 9,
  )
})

test('PWA TopHeader, PairingView, and DiagnosticsSheet render Core engine/output separation, trust paths, and non-animated status', async () => {
  const { TopHeader } = await import('../../pwa/src/components/Navigation/TopHeader')
  const { PairingView } = await import('../../pwa/src/components/Connection/PairingView')
  const { DiagnosticsSheet } = await import('../../pwa/src/components/Connection/DiagnosticsSheet')

  const headerHtml = renderToStaticMarkup(
    createElement(TopHeader, {
      status: {
        isPlaying: true,
        isPaused: false,
        positionSecs: 10,
        durationSecs: 200,
        volume: 1,
        purityMode: true,
        isBitPerfect: true,
        activeDevice: 'RS130',
        streamInfo: null,
      },
      isConnected: false,
      isConnecting: false,
      serverLabel: 'Music Room Core',
      engineKind: 'core',
      outputLabel: 'RS130',
    }),
  )
  assert.match(headerHtml, /Playback engine: Music Room Core/)
  assert.match(headerHtml, /Audio output: RS130/)
  assert.match(headerHtml, /role="status"/)
  assert.doesNotMatch(headerHtml, /animate-pulse|animate-ping/)

  const pairingHtml = renderToStaticMarkup(
    createElement(PairingView, {
      onPaired: () => {},
      activeEngineLabel: 'Music Room Core',
      activeEngineKind: 'core',
      isActivePlaybackRunning: true,
    }),
  )
  assert.match(pairingHtml, /Cadence Core/)
  assert.match(pairingHtml, /Native Android certificate pinning|Browser PWA trust/)

  const diagHtml = renderToStaticMarkup(
    createElement(DiagnosticsSheet, {
      isOpen: true,
      onClose: () => {},
      activeProfile: {
        id: 'https://192.168.1.50:4040',
        label: 'Music Room Core',
        baseUrl: 'https://192.168.1.50:4040',
        port: 4040,
        token: '9182',
        engineKind: 'core',
        engineId: 'core_room',
        libraryId: 'lib_master',
        outputLabel: 'RS130',
      },
      isConnected: false,
      isConnecting: false,
      connectionDiagnostic: null,
      lockScreenControls: true,
      onToggleLockScreenControls: () => {},
      onRunDiagnostics: async () => ({
        network: {
          hasWifi: true,
          wifiIp: '192.168.1.10',
          vpnActive: false,
          activeTransport: 'wifi',
          isMetered: false,
        },
        probe: null,
        diagnostic: null,
      }),
      onProbeAlternateEndpoints: async () => false,
      onRetryConnection: () => {},
      onUpdatePin: () => {},
      onTrustFingerprint: () => {},
      onSwitchDesktop: () => {},
      onDisconnectDesktop: () => {},
    }),
  )
  assert.match(diagHtml, /Connection lost\. Playback may still be continuing\./)
  assert.match(diagHtml, /Reconnect/)
  assert.match(diagHtml, /Choose engine/)
})

test('Phase 10 PWA Core client paginates catalog.page cursors across multi-page libraries', async () => {
  const { createPwaCoreClient } = await import('../../pwa/src/services/coreRemoteClient')
  const allTracks = Array.from({ length: 410 }, (_, idx) => ({
    id: `trk_${idx + 1}`,
    title: `Song ${idx + 1}`,
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 200,
  }))
  const client = createPwaCoreClient(
    {
      id: 'https://192.168.1.6:4040',
      label: 'Music Room Core',
      baseUrl: 'https://192.168.1.6:4040',
      port: 4040,
      token: 'core-token',
      engineKind: 'core',
      engineId: 'core_room',
      libraryId: 'lib_master',
    },
    async (_url, body) => {
      const req = JSON.parse(body) as { operation: string; cursor?: string | null; limit?: number }
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: true,
            data: {
              protocolVersion: 1,
              engineId: 'core_room',
              libraryId: 'lib_master',
              label: 'Music Room Core',
              capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
              ready: true,
            },
          }),
        }
      }
      if (req.operation === 'catalog.page') {
        const start = req.cursor?.startsWith('page_') ? Number(req.cursor.slice(5)) || 0 : 0
        const limit = req.limit ?? 200
        const slice = allTracks.slice(start, start + limit)
        const end = start + slice.length
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: true,
            data: {
              revision: 0,
              tracks: slice,
              nextCursor: end < allTracks.length ? `page_${end}` : null,
            },
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        errorKind: 'ok',
        body: JSON.stringify({
          ok: true,
          data: {
            engineId: 'core_room',
            libraryId: 'lib_master',
            revision: 0,
            catalog: {
              revision: 0,
              tracks: allTracks.slice(0, 200),
              nextCursor: 'page_200',
            },
            queue: { entries: [], currentEntryId: null, repeat: 'off', shuffle: false },
            playback: { activity: 'idle', positionSeconds: 0 },
            output: { id: 'rs130', label: 'RS130', transport: 'upnp' },
          },
        }),
      }
    },
  )

  const prepared = await client.prepare()
  assert.equal(prepared.snapshot.catalog.tracks.length, 410)
  assert.equal(prepared.snapshot.catalog.nextCursor, null)
  assert.equal(prepared.snapshot.catalog.tracks.at(-1)?.id, 'trk_410')
})

test('Stage P1: PWA Core client preserves format metadata across >200 pages, emits real format in streamInfo, and surfaces takeover_required & forceTakeover', async () => {
  const { createPwaCoreClient, mapCoreSnapshotToPwa } = await import('../../pwa/src/services/coreRemoteClient')
  const { probeCadenceServer } = await import('../../pwa/src/platform/cadenceBridge')

  const originalFetch = globalThis.fetch
  const probedUrls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input)
    probedUrls.push(u)
    if (u.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ ready: true, label: 'E2E Core', engineId: 'core_room', libraryId: 'lib_master' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          protocolVersion: 1,
          engineId: 'core_room',
          libraryId: 'lib_master',
          label: 'E2E Core',
          capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
          ready: true,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const probeRes = await probeCadenceServer('http://127.0.0.1:4040', '4829', undefined, true, 3500, 'core')
    assert.equal(probeRes.reachable, true)
    assert.equal(probedUrls.some((u) => u.includes('/api/remote/')), false)
    assert.equal(probedUrls.some((u) => u.endsWith('/healthz')), true)
    assert.equal(probedUrls.some((u) => u.endsWith('/v1/core')), true)
  } finally {
    globalThis.fetch = originalFetch
  }

  const pagedTracks = Array.from({ length: 205 }, (_, i) => ({
    id: `trk_${i + 1}`,
    title: `Track ${i + 1}`,
    artist: 'Glenn Gould',
    album: 'Goldberg Variations',
    releaseId: 'rel_goldberg',
    durationSeconds: 210,
    format: i >= 200 ? 'DSF' : 'FLAC',
    sampleRate: i >= 200 ? 2822400 : 96000,
    bitDepth: i >= 200 ? 1 : 24,
    discNumber: i >= 200 ? 2 : 1,
    trackNumber: i + 1,
  }))

  let takeoverForced = false
  const client = createPwaCoreClient(
    {
      id: 'http://127.0.0.1:4040',
      label: 'E2E Core',
      baseUrl: 'http://127.0.0.1:4040',
      port: 4040,
      token: '4829',
      engineKind: 'core',
      engineId: 'core_room',
      libraryId: 'lib_master',
    },
    async (_url, body) => {
      const req = JSON.parse(body) as {
        operation: string
        cursor?: string | null
        limit?: number
        forceTakeover?: boolean
      }
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: true,
            data: {
              protocolVersion: 1,
              engineId: 'core_room',
              libraryId: 'lib_master',
              label: 'E2E Core',
              capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
              ready: true,
            },
          }),
        }
      }
      if (req.operation === 'catalog.page') {
        const start = req.cursor === 'p2' ? 200 : 0
        const slice = pagedTracks.slice(start, start + 200)
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: true,
            data: { revision: 3, tracks: slice, nextCursor: start === 0 ? 'p2' : null },
          }),
        }
      }
      if (req.operation === 'playback.control' && !req.forceTakeover) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          errorKind: 'ok',
          body: JSON.stringify({
            ok: false,
            error: {
              code: 'takeover_required',
              message: 'External HiFi ROSE playback active',
              snapshot: {
                engineId: 'core_room',
                libraryId: 'lib_master',
                revision: 5,
                catalog: { revision: 3, tracks: pagedTracks.slice(0, 200), nextCursor: 'p2' },
                queue: { entries: [{ entryId: 'e1', trackId: 'trk_205' }], currentEntryId: 'e1', repeat: 'off', shuffle: false },
                playback: { activity: 'idle', owner: 'external', takeoverRequired: true, positionSeconds: 42 },
                output: { id: 'rs130', label: 'RS130', transport: 'upnp' },
              },
            },
          }),
        }
      }
      if (req.operation === 'playback.control' && req.forceTakeover) {
        takeoverForced = true
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        errorKind: 'ok',
        body: JSON.stringify({
          ok: true,
          data: {
            engineId: 'core_room',
            libraryId: 'lib_master',
            revision: 6,
            catalog: { revision: 3, tracks: pagedTracks.slice(0, 200), nextCursor: 'p2' },
            queue: { entries: [{ entryId: 'e1', trackId: 'trk_205' }], currentEntryId: 'e1', repeat: 'off', shuffle: false },
            playback: {
              activity: 'playing',
              trackId: 'trk_205',
              owner: 'core',
              takeoverRequired: false,
              positionSeconds: 0,
            },
            output: { id: 'rs130', label: 'RS130', transport: 'upnp' },
          },
        }),
      }
    },
  )

  const prepared = await client.prepare()
  const page2Track = prepared.snapshot.catalog.tracks.find((t) => t.id === 'trk_205')
  assert.equal(page2Track?.format, 'DSF')
  assert.equal(page2Track?.sampleRate, 2822400)
  assert.equal(page2Track?.releaseId, 'rel_goldberg')

  await assert.rejects(
    () => client.execute({ operation: 'playback.control', action: 'play', expectedRevision: 5 }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'takeover_required',
  )

  const afterForce = await client.execute({
    operation: 'playback.control',
    action: 'play',
    expectedRevision: 5,
    forceTakeover: true,
  })
  assert.equal(takeoverForced, true)
  const { status: remoteStatus } = mapCoreSnapshotToPwa(afterForce)
  assert.equal(remoteStatus.streamInfo?.format, 'DSD')
  assert.equal(remoteStatus.streamInfo?.sampleRate, 2822400)
  assert.equal(remoteStatus.streamInfo?.isHighRes, true)
})

test('Issue #40 hasCoreSnapshotChanged triggers passive sync updates on timer/activity changes without idle churn', async () => {
  const { hasCoreSnapshotChanged } = await import('../../pwa/src/hooks/useRemoteSocket')
  const base = {
    engineId: 'core_room',
    libraryId: 'lib_master',
    revision: 10,
    catalog: { revision: 3, tracks: [], nextCursor: null },
    queue: { entries: [{ entryId: 'e1', trackId: 'trk_1' }], currentEntryId: 'e1', repeat: 'off' as const, shuffle: false },
    playback: {
      activity: 'loading' as const,
      trackId: 'trk_1',
      owner: 'core' as const,
      takeoverRequired: false,
      positionSeconds: 0,
      durationSeconds: 185,
    },
    output: { id: 'rs130', label: 'RS130', transport: 'upnp' },
  }
  assert.equal(hasCoreSnapshotChanged(null, base), true)
  assert.equal(hasCoreSnapshotChanged(base, { ...base }), false)
  assert.equal(
    hasCoreSnapshotChanged(base, {
      ...base,
      playback: { ...base.playback, activity: 'playing' },
    }),
    true,
  )
  assert.equal(
    hasCoreSnapshotChanged(base, {
      ...base,
      playback: { ...base.playback, positionSeconds: 5 },
    }),
    true,
  )
})
