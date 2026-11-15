import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CORE_PROTOCOL_VERSION,
  CoreServiceError,
  engineScopeKey,
  parseCoreRequest,
  parseCoreSnapshot,
  type CoreDescriptor,
  type CoreRequest,
  type CoreSnapshot,
} from '../core/coreProtocol'
import { createLocalEngineService, createRemoteEngineService } from '../services/engineService'
import { createEngineServiceController } from '../services/engineServiceController'

const local = { kind: 'local', engineId: 'local', libraryId: 'local', label: 'This PC' } as const
const core = { kind: 'core', engineId: 'room-core', libraryId: 'music-library', label: 'Room Core' } as const
const other = { ...core, engineId: 'other-core' }
const capabilities = ['catalog.read', 'session.read', 'playback.control', 'queue.write'] as const

function snapshot(context = core as typeof core | typeof local, revision = 4): CoreSnapshot {
  return {
    engineId: context.engineId, libraryId: context.libraryId, revision,
    catalog: { revision: 2, tracks: [{ id: 'track-1', title: 'Song', artist: 'Artist', album: 'Album', durationSeconds: 120 }], nextCursor: null },
    queue: { entries: [{ entryId: 'entry-1', trackId: 'track-1' }], currentEntryId: 'entry-1', repeat: 'off', shuffle: false },
    playback: { activity: 'paused', positionSeconds: 12 },
    output: { id: 'rose-130', label: 'RS130', transport: 'upnp' },
  }
}

function descriptor(context = core as typeof core | typeof local): CoreDescriptor {
  return { protocolVersion: CORE_PROTOCOL_VERSION, engineId: context.engineId, libraryId: context.libraryId, label: context.label, capabilities: [...capabilities], ready: true }
}

function fixture(context = core as typeof core | typeof local) {
  const calls: CoreRequest[] = []
  let hello: unknown = descriptor(context)
  let response: unknown = { ok: true, data: snapshot(context) }
  let trusted = true
  let peer = { engineId: context.engineId as string, libraryId: context.libraryId as string }
  let checks = 0
  const owner = {
    async request(request: CoreRequest): Promise<unknown> {
      calls.push(structuredClone(request))
      return request.operation === 'core.hello' ? { ok: true, data: hello } : response
    },
  }
  const channel = {
    async verifyPeer() { checks++; return { authenticated: trusted, ...peer } },
    request: owner.request,
  }
  return {
    calls, owner, channel,
    setHello(value: unknown) { hello = value },
    setResponse(value: unknown) { response = value },
    setTrusted(value: boolean) { trusted = value },
    setPeer(value: typeof peer) { peer = value },
    get checks() { return checks },
  }
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof CoreServiceError && error.code === code
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('constructing adapters and controller defaults to This PC without I/O', () => {
  const f = fixture(local)
  const service = createLocalEngineService(f.owner)
  const controller = createEngineServiceController(service)
  assert.deepEqual(controller.getView().session.active, local)
  assert.equal(controller.getView().snapshot, null)
  assert.deepEqual(f.calls, [])
  assert.equal(f.checks, 0)
})

for (const kind of ['local', 'remote'] as const) {
  test(`${kind} adapter negotiates and returns the same path-free session projection`, async () => {
    const context = kind === 'local' ? local : core
    const f = fixture(context)
    const service = kind === 'local' ? createLocalEngineService(f.owner) : createRemoteEngineService(core, f.channel)
    const prepared = await service.prepare()
    assert.deepEqual(prepared.context, context)
    assert.deepEqual(prepared.snapshot, snapshot(context))
    assert.deepEqual(f.calls.map(call => call.operation), ['core.hello', 'session.snapshot'])
    assert.equal(f.checks, kind === 'local' ? 0 : 1)
    f.setResponse({ ok: true, data: snapshot(context).catalog })
    assert.deepEqual(await service.catalogPage(null, 20), snapshot(context).catalog)
    assert.deepEqual(f.calls.at(-1), { protocolVersion: 1, engineId: context.engineId, libraryId: context.libraryId, operation: 'catalog.page', cursor: null, limit: 20 })
  })
}

test('remote trust is checked before even the negotiation request', async () => {
  const f = fixture(); f.setTrusted(false)
  await assert.rejects(createRemoteEngineService(core, f.channel).prepare(), errorCode('untrusted_peer'))
  assert.deepEqual(f.calls, [])
})

test('authenticated peer identity must match the selected engine and library', async () => {
  for (const peer of [{ engineId: 'other-core', libraryId: core.libraryId }, { engineId: core.engineId, libraryId: 'other-library' }]) {
    const f = fixture(); f.setPeer(peer)
    await assert.rejects(createRemoteEngineService(core, f.channel).prepare(), errorCode('identity_mismatch'))
    assert.deepEqual(f.calls, [])
  }
})

test('remote identity cannot impersonate the reserved local namespace or use paths', () => {
  for (const context of [{ ...core, engineId: 'local' }, { ...core, libraryId: 'local' }, { ...core, engineId: '../room' }, { ...core, libraryId: 'E:\\Music' }, local]) {
    assert.throws(() => createRemoteEngineService(context, fixture().channel), errorCode('invalid_payload'))
  }
  assert.notEqual(engineScopeKey(core), engineScopeKey(other))
  assert.notEqual(engineScopeKey(core), engineScopeKey({ ...core, libraryId: 'other-library' }))
})

test('version, capabilities, readiness and advertised identity reject activation', async () => {
  const cases = [
    [{ ...descriptor(), protocolVersion: 2 }, 'incompatible_protocol'],
    [{ ...descriptor(), capabilities: ['session.read'] }, 'unsupported_capability'],
    [{ ...descriptor(), ready: false }, 'not_ready'],
    [{ ...descriptor(), engineId: 'other-core' }, 'identity_mismatch'],
    [{ ...descriptor(), libraryId: 'other-library' }, 'identity_mismatch'],
    [{ ...descriptor(), sql: 'SELECT * FROM tracks' }, 'invalid_payload'],
    [{ ...descriptor(), capabilities: [...capabilities, 'future.feature'] }, null],
  ] as const
  for (const [hello, code] of cases) {
    const f = fixture(); f.setHello(hello)
    const preparation = createRemoteEngineService(core, f.channel).prepare()
    if (code) {
      await assert.rejects(preparation, errorCode(code))
      assert.equal(f.calls.length, 1)
    } else await preparation
  }
})

test('failed negotiation is never cached as authorized', async () => {
  const f = fixture(); f.setHello({ ...descriptor(), ready: false })
  const service = createRemoteEngineService(core, f.channel)
  await assert.rejects(service.prepare(), errorCode('not_ready'))
  f.setHello(descriptor())
  await service.prepare()
  assert.equal(f.checks, 2)
})

test('snapshot validation rejects mixed identities, malformed fields and file-path leakage', () => {
  const valid = snapshot()
  const invalid = [
    { ...valid, engineId: 'other-core' }, { ...valid, libraryId: 'other-library' },
    { ...valid, revision: -1 }, { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, output: undefined }, { ...valid, output: { ...valid.output, transport: 'alsa' } },
    { ...valid, playback: { activity: 'playing', positionSeconds: -2 } },
    { ...valid, playback: { activity: 'mystery', positionSeconds: 0 } },
    { ...valid, catalog: { ...valid.catalog, tracks: [{ ...valid.catalog.tracks[0], filePath: '/music/song.flac' }] } },
    { ...valid, queue: { ...valid.queue, entries: [...valid.queue.entries, valid.queue.entries[0]] } },
    { ...valid, queue: { ...valid.queue, currentEntryId: 'missing-entry' } },
    { ...valid, queue: { ...valid.queue, shuffle: 'false' } },
    { ...valid, queue: { ...valid.queue, repeat: 'sometimes' } },
    { ...valid, catalog: { ...valid.catalog, nextCursor: '../../music' } },
    { ...valid, catalog: { ...valid.catalog, tracks: [valid.catalog.tracks[0], valid.catalog.tracks[0]] } },
  ]
  for (const value of invalid) assert.throws(() => parseCoreSnapshot(value, core), CoreServiceError)
})

test('duplicate tracks keep distinct queue-entry identities; empty library/output is valid', () => {
  const value = snapshot()
  value.queue.entries.push({ entryId: 'entry-2', trackId: 'track-1' })
  assert.equal(parseCoreSnapshot(value, core).queue.entries.length, 2)
  value.queue = { entries: [], currentEntryId: null, repeat: 'all', shuffle: true }
  value.catalog = { revision: 0, tracks: [], nextCursor: null }
  value.playback = { activity: 'idle', positionSeconds: 0 }
  value.output = null
  assert.deepEqual(parseCoreSnapshot(value, core), value)
})

test('typed operations reject arbitrary invoke, SQL, paths, invalid revisions and oversized payloads', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  const invalid = [
    { operation: 'invoke', command: 'play_track', filePath: '/music/song.flac' },
    { operation: 'playback.control', action: 'play', commandId: 'cmd-1', expectedRevision: 4, trackId: '../song' },
    { operation: 'playback.control', action: 'seek', commandId: 'cmd-1', expectedRevision: 4, positionSeconds: -1 },
    { operation: 'playback.control', action: 'pause', commandId: 'cmd-1', expectedRevision: -1 },
    { operation: 'playback.control', action: 'pause', commandId: '', expectedRevision: 4 },
    { operation: 'playback.control', action: 'pause', commandId: 'cmd-1', expectedRevision: 4, sql: 'SELECT * FROM tracks' },
    { operation: 'queue.replace', commandId: 'cmd-1', expectedRevision: 4, entries: [{ entryId: 'a', trackId: '/song.flac' }] },
    { operation: 'queue.replace', commandId: 'cmd-1', expectedRevision: 4, entries: Array.from({ length: 4097 }, (_, index) => ({ entryId: `e-${index}`, trackId: 'track-1' })) },
    { operation: 'queue.replace', commandId: 'x'.repeat(1_100_000), expectedRevision: 4, entries: [] },
  ]
  for (const command of invalid) await assert.rejects(service.execute(command as never), errorCode('invalid_payload'))
  assert.equal(f.calls.length, 0)
  assert.equal(f.checks, 0)
})

test('catalog paging and wire protocol are bounded and identity-scoped', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  for (const [cursor, limit] of [[null, 0], [null, 201], ['../music', 20]] as const) {
    await assert.rejects(service.catalogPage(cursor, limit), errorCode('invalid_payload'))
  }
  const request = { protocolVersion: 1, engineId: core.engineId, libraryId: core.libraryId, operation: 'session.snapshot' }
  assert.deepEqual(parseCoreRequest(request, core), request)
  assert.throws(() => parseCoreRequest({ ...request, engineId: 'other-core' }, core), errorCode('identity_mismatch'))
  assert.throws(() => parseCoreRequest({ ...request, protocolVersion: 2 }, core), errorCode('incompatible_protocol'))
  assert.equal(f.calls.length, 0)
})

test('play, seek, pause and queue replacement transmit IDs and preconditions unchanged', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  const commands = [
    { operation: 'playback.control', action: 'play', trackId: 'track-1', commandId: 'play-1', expectedRevision: 4 },
    { operation: 'playback.control', action: 'seek', positionSeconds: 30, commandId: 'seek-1', expectedRevision: 4 },
    ...(['pause', 'resume', 'stop'] as const).map(action => ({ operation: 'playback.control', action, commandId: `${action}-1`, expectedRevision: 4 } as const)),
    { operation: 'queue.replace', entries: [{ entryId: 'entry-1', trackId: 'track-1' }, { entryId: 'entry-2', trackId: 'track-1' }], commandId: 'queue-1', expectedRevision: 4 },
  ] as const
  for (const command of commands) {
    assert.deepEqual(await service.execute(command), snapshot())
    assert.deepEqual(f.calls.at(-1), { protocolVersion: 1, engineId: core.engineId, libraryId: core.libraryId, ...command })
  }
})

test('remote failures are typed and sanitized; stale revision includes a validated fresh snapshot', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  await service.prepare()
  f.setResponse({ ok: false, error: { code: 'stale_revision', message: '/private/db.sqlite SQL secret', snapshot: snapshot(core, 5) } })
  await assert.rejects(service.execute({ operation: 'playback.control', action: 'pause', commandId: 'cmd-1', expectedRevision: 4 }), (error: unknown) => {
    assert.ok(error instanceof CoreServiceError)
    assert.equal(error.code, 'stale_revision')
    assert.deepEqual(error.snapshot, snapshot(core, 5))
    assert.equal(error.message.includes('secret'), false)
    return true
  })
  f.setResponse({ ok: false, error: { code: 'unauthorized', message: 'sensitive path' } })
  await assert.rejects(service.getSnapshot(), errorCode('unauthorized'))
  f.setResponse({ ok: false, error: { code: 'stale_revision' } })
  await assert.rejects(service.getSnapshot(), errorCode('invalid_payload'))
  f.setResponse({ ok: false, error: { code: 'unknown-code' } })
  await assert.rejects(service.getSnapshot(), errorCode('invalid_payload'))
  f.setResponse({ ok: true, data: { ...snapshot(), extra: 'x'.repeat(1_100_000) } })
  await assert.rejects(service.getSnapshot(), errorCode('invalid_payload'))
})

test('network rejection fails without local fallback or automatic mutation replay', async () => {
  let count = 0
  const service = createRemoteEngineService(core, {
    async verifyPeer() { return { authenticated: true, engineId: core.engineId, libraryId: core.libraryId } },
    async request() { count++; throw new Error('private address / music path') },
  })
  await assert.rejects(service.getSnapshot(), errorCode('unavailable'))
  assert.equal(count, 1)
})

test('activation stages catalog, queue and output together and never issues playback commands', async () => {
  const f = fixture(); const wait = deferred<unknown>()
  const service = createRemoteEngineService(core, { ...f.channel, request: request => request.operation === 'session.snapshot' ? wait.promise : f.owner.request(request) })
  const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
  const switching = controller.select(service, 'idle')
  assert.deepEqual(controller.getView().session.active, local)
  assert.equal(controller.getView().snapshot, null)
  wait.resolve({ ok: true, data: snapshot() })
  assert.equal(await switching, 'activated')
  assert.deepEqual(controller.getView().session.active, core)
  assert.deepEqual(controller.getView().snapshot, snapshot())
  assert.equal(controller.getView().snapshot?.playback.activity, 'paused')
  assert.deepEqual(f.calls.map(call => call.operation), ['core.hello'])
})

test('all active source activities require an acknowledged stop; explicit leave-Core-playing is allowed', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
  for (const activity of ['playing', 'paused', 'loading'] as const) assert.equal(await controller.select(service, activity), 'requires_stop')
  assert.equal(f.checks, 0)
  assert.equal(await controller.select(service, 'idle'), 'activated')
  const localService = createLocalEngineService(fixture(local).owner)
  assert.equal(await controller.select(localService, 'playing'), 'requires_stop')
  assert.equal(await controller.select(localService, 'playing', 'leave_core_playing'), 'activated')
  assert.deepEqual(controller.getView().session.active, local)
})

test('failed preparation retains the complete old view and connection events remain observable', async () => {
  const f = fixture(); f.setHello({ ...descriptor(), ready: false })
  const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
  await controller.refresh()
  const before = controller.getView()
  const switching = controller.select(createRemoteEngineService(core, f.channel), 'idle')
  controller.setConnection(before.session.activeEpoch, local, false)
  assert.equal(await switching, 'failed')
  assert.deepEqual(controller.getView().snapshot, before.snapshot)
  assert.deepEqual(controller.getView().session.active, local)
  assert.equal(controller.getView().session.connected, false)
  controller.setConnection(before.session.activeEpoch, local, true)
  assert.equal(controller.getView().session.connected, false)
  await controller.refresh()
  assert.equal(controller.getView().session.connected, true)
})

for (const fails of [false, true]) {
  test(`late ${fails ? 'failure' : 'success'} cannot overwrite a newer engine activation`, async () => {
    const f = fixture(); const wait = deferred<unknown>()
    const slow = createRemoteEngineService(core, { ...f.channel, request: request => request.operation === 'session.snapshot' ? wait.promise : f.owner.request(request) })
    const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
    const first = controller.select(slow, 'idle')
    const newer = createRemoteEngineService(other, fixture(other as typeof core).channel)
    assert.equal(await controller.select(newer, 'idle'), 'activated')
    if (fails) wait.reject(new Error('old failure'))
    else wait.resolve({ ok: true, data: snapshot() })
    assert.equal(await first, 'stale')
    assert.deepEqual(controller.getView().session.active, other)
    assert.equal(controller.getView().snapshot?.engineId, other.engineId)
    assert.equal(controller.getView().session.error, null)
  })
}

test('cancellation invalidates late activation; external mutation cannot corrupt staged snapshots', async () => {
  const f = fixture(); const wait = deferred<unknown>()
  const service = createRemoteEngineService(core, { ...f.channel, request: request => request.operation === 'session.snapshot' ? wait.promise : f.owner.request(request) })
  const localService = createLocalEngineService(fixture(local).owner)
  const controller = createEngineServiceController(localService)
  const switching = controller.select(service, 'idle')
  assert.equal(await controller.select(localService, 'idle'), 'unchanged')
  wait.resolve({ ok: true, data: snapshot() })
  assert.equal(await switching, 'stale')
  await controller.select(service, 'idle')
  const view = controller.getView()
  view.snapshot!.queue.entries.length = 0
  view.session.active.label = 'corrupt'
  assert.equal(controller.getView().snapshot?.queue.entries.length, 1)
  assert.equal(controller.getView().session.active.label, core.label)
})

test('disconnect never falls back and reconnect requires a fresh authoritative snapshot', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
  await controller.select(service, 'idle')
  const active = controller.getView().session
  controller.setConnection(active.activeEpoch, core, false)
  assert.equal(controller.getView().session.connected, false)
  controller.setConnection(active.activeEpoch, core, true)
  assert.equal(controller.getView().session.connected, false)
  f.setResponse({ ok: true, data: snapshot(core, 8) })
  assert.equal(await controller.refresh(), 'updated')
  assert.equal(controller.getView().session.connected, true)
  assert.equal(controller.getView().snapshot?.revision, 8)
  controller.setConnection(active.activeEpoch - 1, core, false)
  assert.equal(controller.getView().session.connected, true)
})

test('refresh rejects older revisions and late responses after switching away', async () => {
  const f = fixture(); const wait = deferred<unknown>(); let delay = false
  const service = createRemoteEngineService(core, { ...f.channel, request: request => delay && request.operation === 'session.snapshot' ? wait.promise : f.owner.request(request) })
  const localService = createLocalEngineService(fixture(local).owner)
  const controller = createEngineServiceController(localService)
  await controller.select(service, 'idle')
  f.setResponse({ ok: true, data: snapshot(core, 3) })
  assert.equal(await controller.refresh(), 'stale')
  assert.equal(controller.getView().snapshot?.revision, 4)
  delay = true
  const refresh = controller.refresh()
  await controller.select(localService, 'idle')
  wait.resolve({ ok: true, data: snapshot(core, 10) })
  assert.equal(await refresh, 'stale')
  assert.equal(controller.getView().snapshot?.engineId, 'local')
})

test('revoked trust blocks every subsequent operation before any request', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  await service.prepare()
  const count = f.calls.length
  f.setTrusted(false)
  await assert.rejects(service.getSnapshot(), errorCode('untrusted_peer'))
  await assert.rejects(service.catalogPage(null, 20), errorCode('untrusted_peer'))
  await assert.rejects(service.execute({ operation: 'playback.control', action: 'stop', commandId: 'cmd-1', expectedRevision: 4 }), errorCode('untrusted_peer'))
  assert.equal(f.calls.length, count)
})

test('standalone mutations use the in-process owner port, without channel verification', async () => {
  const f = fixture(local); const service = createLocalEngineService(f.owner)
  const command = { operation: 'playback.control', action: 'pause', commandId: 'local-1', expectedRevision: 4 } as const
  assert.deepEqual(await service.execute(command), snapshot(local))
  assert.equal(f.checks, 0)
  assert.deepEqual(f.calls.at(-1), { ...command, protocolVersion: 1, engineId: 'local', libraryId: 'local' })
})

test('a lost mutation acknowledgement is not retried and unknown outcomes stay unavailable', async () => {
  const f = fixture(); let applied = 0
  const service = createRemoteEngineService(core, { ...f.channel, async request(request) {
    if (request.operation === 'playback.control') { applied++; throw new Error('acknowledgement lost') }
    return f.owner.request(request)
  } })
  await assert.rejects(service.execute({ operation: 'playback.control', action: 'pause', commandId: 'cmd-1', expectedRevision: 4 }), errorCode('unavailable'))
  assert.equal(applied, 1)
})

test('refresh races reject old success/failure and disconnect invalidates in-flight responses', async () => {
  for (const completion of ['success', 'failure', 'disconnect'] as const) {
    const f = fixture(); const wait = deferred<unknown>(); let count = 0
    const service = createRemoteEngineService(core, { ...f.channel, request: request => {
      if (request.operation === 'session.snapshot' && ++count === 2) return wait.promise
      return f.owner.request(request)
    } })
    const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
    await controller.select(service, 'idle')
    const older = controller.refresh()
    // Let authorize complete so the old snapshot request is actually in flight.
    await new Promise<void>(resolve => queueMicrotask(resolve))
    if (completion === 'disconnect') {
      const session = controller.getView().session
      controller.setConnection(session.activeEpoch, core, false)
    } else {
      f.setResponse({ ok: true, data: snapshot(core, 6) })
      assert.equal(await controller.refresh(), 'updated')
    }
    if (completion === 'failure') wait.reject(new Error('old refresh failed'))
    else wait.resolve({ ok: true, data: snapshot(core, 5) })
    assert.equal(await older, 'stale')
    assert.equal(controller.getView().session.connected, completion !== 'disconnect')
    assert.equal(controller.getView().snapshot?.revision, completion === 'disconnect' ? 4 : 6)
  }
})

test('refresh failure retains the selected catalog and exposes a sanitized error', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
  await controller.select(service, 'idle')
  f.setResponse({ ok: false, error: { code: 'unauthorized', message: 'secret' } })
  assert.equal(await controller.refresh(), 'failed')
  assert.equal(controller.getView().session.active.engineId, core.engineId)
  assert.equal(controller.getView().snapshot?.revision, 4)
  assert.equal(controller.getView().session.connected, false)
  assert.equal(controller.getView().session.error?.includes('secret'), false)
})

test('staging rejects a service that returns a mixed-library snapshot', async () => {
  const service = createRemoteEngineService(core, fixture().channel)
  const controller = createEngineServiceController(createLocalEngineService(fixture(local).owner))
  const mixed = { ...service, async prepare() { return { context: core, descriptor: descriptor(), snapshot: snapshot(local) } } }
  assert.equal(await controller.select(mixed, 'idle'), 'failed')
  assert.equal(controller.getView().session.active.kind, 'local')
  assert.equal(controller.getView().snapshot, null)
})

test('malformed response envelopes, cycles, oversized pages and regression acknowledgements reject', async () => {
  const f = fixture(); const service = createRemoteEngineService(core, f.channel)
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  for (const response of [null, [], { ok: 'yes' }, { ok: true }, { ok: false, error: { code: 'unauthorized', snapshot: snapshot() } }, cycle]) {
    f.setResponse(response)
    await assert.rejects(service.getSnapshot(), errorCode('invalid_payload'))
  }
  const page = snapshot().catalog
  page.tracks.push({ ...page.tracks[0], id: 'track-2' })
  f.setResponse({ ok: true, data: page })
  await assert.rejects(service.catalogPage(null, 1), errorCode('invalid_payload'))
  f.setResponse({ ok: true, data: snapshot(core, 3) })
  await assert.rejects(service.execute({ operation: 'queue.replace', entries: [], commandId: 'cmd-1', expectedRevision: 4 }), errorCode('invalid_payload'))
})
