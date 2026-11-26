import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRemoteSocket } from './useRemoteSocket'
import { CoreClientError, createPwaCoreClient, type CoreSnapshot } from '../services/coreRemoteClient'
import { saveActiveServerProfile } from '../services/serverProfiles'

vi.mock('../services/coreRemoteClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/coreRemoteClient')>(),
  createPwaCoreClient: vi.fn(),
}))

const profile = {
  id: 'core', baseUrl: 'http://localhost:4040', port: 4040, token: '',
  label: 'Core', engineKind: 'core' as const, engineId: 'engine', libraryId: 'library',
}
const descriptor = {
  protocolVersion: 1, engineId: 'engine', libraryId: 'library', label: 'Core',
  capabilities: ['queue.coordinate'], ready: true,
}
const snapshot: CoreSnapshot = {
  engineId: 'engine', libraryId: 'library', revision: 1,
  catalog: { revision: 1, tracks: [], nextCursor: null },
  playback: { activity: 'playing', positionSeconds: 1 },
  queue: {
    entries: ['a', 'b', 'c'].map((entryId) => ({ entryId, trackId: 'same-track' })),
    currentEntryId: 'a', repeat: 'off', shuffle: false,
  },
  output: { id: 'renderer', label: 'Renderer', transport: 'upnp' },
}

function setup() {
  saveActiveServerProfile({ ...profile, outputLabel: 'Renderer' })
  const client = {
    prepare: vi.fn().mockResolvedValue({ descriptor, snapshot }),
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    execute: vi.fn(),
    listOutputs: vi.fn().mockResolvedValue(null),
    setOutput: vi.fn(),
    setVolume: vi.fn(),
    setPurity: vi.fn(),
  }
  vi.mocked(createPwaCoreClient).mockReturnValue(client)
  return { client, ...renderHook(useRemoteSocket) }
}

afterEach(() => {
  saveActiveServerProfile(null)
  vi.useRealTimers()
})

it('keeps the confirmed output when the engine does not expose an output list', async () => {
  const { result } = setup()
  await waitFor(() => expect(result.current.isLoadingDevices).toBe(false))
  expect(result.current.outputDevices).toEqual(['Renderer'])
  expect(result.current.deviceError).toBeNull()
})

it('keeps the queue connected through one failed sync and advances on the next snapshot', async () => {
  vi.useFakeTimers()
  const { client, result } = setup()
  await act(async () => {})
  const next = { ...snapshot, revision: 2, queue: { ...snapshot.queue, currentEntryId: 'b' } }
  client.getSnapshot.mockRejectedValueOnce(new CoreClientError('unavailable')).mockResolvedValue(next)
  await act(() => vi.advanceTimersByTimeAsync(5000))
  expect(client.getSnapshot).toHaveBeenCalledTimes(1)
  expect(result.current.isConnected).toBe(true)
  expect(result.current.queue.currentQueueEntryId).toBe('a')
  await act(() => vi.advanceTimersByTimeAsync(5000))
  expect(result.current.isConnected).toBe(true)
  expect(result.current.queue.currentQueueEntryId).toBe('b')
  client.getSnapshot.mockRejectedValue(new CoreClientError('unavailable'))
  await act(() => vi.advanceTimersByTimeAsync(10000))
  expect(result.current.isConnected).toBe(false)
  expect(result.current.queue.currentQueueEntryId).toBe('b')
})

it('coalesces quick taps and retries the latest entry by ID after a revision conflict', async () => {
  const { client, result } = setup()
  await waitFor(() => expect(result.current.isConnected).toBe(true))
  const afterFirst = { ...snapshot, revision: 2, queue: { ...snapshot.queue, currentEntryId: 'b' } }
  const reordered = {
    ...afterFirst, revision: 3,
    queue: { ...afterFirst.queue, entries: [...snapshot.queue.entries].reverse() },
  }
  let finishFirst!: (value: CoreSnapshot) => void
  client.execute.mockReturnValueOnce(new Promise<CoreSnapshot>((resolve) => { finishFirst = resolve }))
    .mockRejectedValueOnce(new CoreClientError('stale_revision', undefined, reordered))
    .mockResolvedValueOnce({ ...reordered, revision: 4, queue: { ...reordered.queue, currentEntryId: 'c' } })

  await act(async () => {
    void result.current.jumpToQueueIndex(1, 'b')
    await Promise.resolve()
    void result.current.jumpToQueueIndex(0, 'a')
    void result.current.jumpToQueueIndex(2, 'c')
    finishFirst(afterFirst)
  })
  expect(client.execute.mock.calls.map(([command]) => [command.entryId, command.expectedRevision]))
    .toEqual([['b', 1], ['c', 2], ['c', 3]])
  expect(result.current.queue.currentQueueEntryId).toBe('c')
  expect(result.current.conflictEvent).toBeNull()
})
