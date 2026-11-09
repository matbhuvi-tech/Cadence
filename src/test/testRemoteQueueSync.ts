import { Track } from '../core/types'

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`)
    throw new Error(`Assertion failed: ${message}`)
  }
  console.log(`✅ Passed: ${message}`)
}

export interface RemoteQueueSyncState {
  appliedServerRevision: number
  latestHydrationRevision: number
  queue: Track[]
  queueIndex: number
}

export async function handleRemoteQueueEvent(
  payload: {
    items: Array<{ id: string; title: string; filePath: string }>
    currentIndex: number
    revision: number
  },
  state: RemoteQueueSyncState,
  fetchTracksFromDb: (ids: string[]) => Promise<Track[]>,
  commitState: (tracks: Track[], index: number) => void
) {
  const { items, currentIndex, revision } = payload
  if (revision <= state.appliedServerRevision) {
    return false // Ignore stale or echo revision
  }
  state.appliedServerRevision = revision
  state.latestHydrationRevision = revision

  const trackIds = items.map((i) => i.id)
  const hydrated = await fetchTracksFromDb(trackIds)

  // Guard against async race: if a newer revision arrived while awaiting DB, drop stale result
  if (state.latestHydrationRevision !== revision) {
    return false
  }

  const orderedTracks = items.map((item) => {
    const found = hydrated.find((t) => t.id === item.id)
    if (found) return found
    return {
      id: item.id,
      title: item.title,
      folderPath: item.filePath,
      format: 'FLAC',
      durationSeconds: 180,
    } as Track
  })

  commitState(orderedTracks, currentIndex)
  state.queue = orderedTracks
  state.queueIndex = currentIndex
  return true
}

async function runTestSuite() {
  console.log('=====================================================')
  console.log('Cadence Remote Queue Revision & Hydration Test Suite')
  console.log('=====================================================\n')

  const state: RemoteQueueSyncState = {
    appliedServerRevision: 0,
    latestHydrationRevision: 0,
    queue: [],
    queueIndex: -1,
  }

  // --- TEST 1: Normal In-Order Revision commits ---
  console.log('--- Test 1: Normal in-order revision commits ---')
  const mockDb1 = async (ids: string[]) => [
    { id: ids[0], title: 'Track 1 Full', format: 'FLAC', folderPath: '/a.flac', durationSeconds: 200 } as Track,
  ]
  let committed = false
  await handleRemoteQueueEvent(
    { items: [{ id: 't1', title: 'T1', filePath: '/a.flac' }], currentIndex: 0, revision: 1 },
    state,
    mockDb1,
    () => { committed = true }
  )
  assert(committed, 'Revision 1 committed successfully')
  assert(state.appliedServerRevision === 1, 'Applied server revision updated to 1')
  assert(state.queue[0].title === 'Track 1 Full', 'Track domain entity hydrated from DB')

  // --- TEST 2: Stale/Echo Revision is Ignored ---
  console.log('\n--- Test 2: Stale or duplicate revision ignored ---')
  committed = false
  const ignored = await handleRemoteQueueEvent(
    { items: [{ id: 't1', title: 'T1', filePath: '/a.flac' }], currentIndex: 0, revision: 1 },
    state,
    mockDb1,
    () => { committed = true }
  )
  assert(!ignored && !committed, 'Duplicate revision 1 was ignored')

  const staleIgnored = await handleRemoteQueueEvent(
    { items: [], currentIndex: -1, revision: 0 },
    state,
    mockDb1,
    () => { committed = true }
  )
  assert(!staleIgnored && !committed, 'Stale revision 0 was ignored')

  // --- TEST 3: Async Hydration Race Protection ---
  console.log('\n--- Test 3: Async Hydration Race Protection ---')
  let rev2Committed = false
  let rev3Committed = false

  // Revision 2 is slow (takes 40ms)
  const slowDbRev2 = async (ids: string[]) => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    return [{ id: ids[0], title: 'Slow Rev 2', format: 'FLAC', folderPath: '/rev2.flac', durationSeconds: 200 } as Track]
  }

  // Revision 3 is fast (takes 10ms)
  const fastDbRev3 = async (ids: string[]) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return [{ id: ids[0], title: 'Fast Rev 3', format: 'FLAC', folderPath: '/rev3.flac', durationSeconds: 300 } as Track]
  }

  // Dispatch Rev 2 then immediately Rev 3
  const pRev2 = handleRemoteQueueEvent(
    { items: [{ id: 'rev2', title: 'R2', filePath: '/rev2.flac' }], currentIndex: 0, revision: 2 },
    state,
    slowDbRev2,
    () => { rev2Committed = true }
  )

  // Wait 5ms then dispatch Rev 3
  await new Promise((r) => setTimeout(r, 5))
  const pRev3 = handleRemoteQueueEvent(
    { items: [{ id: 'rev3', title: 'R3', filePath: '/rev3.flac' }], currentIndex: 0, revision: 3 },
    state,
    fastDbRev3,
    () => { rev3Committed = true }
  )

  await Promise.all([pRev2, pRev3])

  assert(!rev2Committed, 'Stale slow revision 2 hydration was discarded!')
  assert(rev3Committed, 'Newer revision 3 hydration was committed!')
  assert(state.queue[0].title === 'Fast Rev 3', 'State contains revision 3 data')
  assert(state.appliedServerRevision === 3, 'Applied server revision is 3')

  console.log('\n=====================================================')
  console.log('All Remote Queue Sync tests passed successfully!')
  console.log('=====================================================')
}

runTestSuite().catch((e) => {
  console.error(e)
  process.exit(1)
})
