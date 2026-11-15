import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CoreServiceError, parseCoreRequest, type CoreCommand, type CoreDescriptor } from '../core/coreProtocol'
import { createRemoteEngineService } from '../services/engineService'

const core = { kind: 'core', engineId: 'room-core', libraryId: 'music-library', label: 'Room Core' } as const
const base = { protocolVersion: 1, engineId: core.engineId, libraryId: core.libraryId, commandId: 'command-1', expectedRevision: 3 }

test('v1 queue coordination uses entry IDs and validates every action strictly', () => {
  for (const command of [
    { operation: 'queue.control', action: 'next' },
    { operation: 'queue.control', action: 'previous' },
    { operation: 'queue.control', action: 'jump', entryId: 'duplicate-entry-2' },
    { operation: 'queue.control', action: 'modes', repeat: 'all', shuffle: true },
  ]) assert.deepEqual(parseCoreRequest({ ...base, ...command }, core), { ...base, ...command })
  for (const command of [
    { action: 'jump', entryId: '../path' }, { action: 'jump', trackId: 'song-a' },
    { action: 'next', entryId: 'extra' }, { action: 'advance-completed' },
    { action: 'modes', repeat: 'forever', shuffle: true },
    { action: 'modes', repeat: 'one', shuffle: 1 },
  ]) assert.throws(() => parseCoreRequest({ ...base, operation: 'queue.control', ...command }, core), CoreServiceError)
})

test('queue coordination requires its negotiated capability before sending mutations', async () => {
  const calls: unknown[] = []
  const hello: CoreDescriptor = {
    protocolVersion: 1, engineId: core.engineId, libraryId: core.libraryId, label: core.label,
    capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'], ready: true,
  }
  const state = {
    engineId: core.engineId, libraryId: core.libraryId, revision: 4,
    catalog: { revision: 0, tracks: [], nextCursor: null },
    queue: { entries: [], currentEntryId: null, repeat: 'off', shuffle: false },
    playback: { activity: 'idle', positionSeconds: 0 }, output: null,
  }
  const service = createRemoteEngineService(core, {
    async verifyPeer() { return { authenticated: true, engineId: core.engineId, libraryId: core.libraryId } },
    async request(request) {
      calls.push(request)
      return { ok: true, data: request.operation === 'core.hello' ? hello : state }
    },
  })
  const command = { operation: 'queue.control', action: 'next', commandId: 'next', expectedRevision: 3 } as unknown as CoreCommand
  await assert.rejects(service.execute(command), (error: unknown) => error instanceof CoreServiceError && error.code === 'unsupported_capability')
  assert.equal(calls.length, 1)
  hello.capabilities.push('queue.coordinate')
  assert.deepEqual(await service.execute(command), state)
  assert.equal(calls.length, 3)
})
