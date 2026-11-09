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
  currentTrack?: Track | null
  isPlaying?: boolean
  isPaused?: boolean
}

export function reconcileActiveTrack(
  file: string | null | undefined,
  queue: Track[],
  currentTrack: Track | null | undefined
): { matchedTrack: Track | null; matchedIndex: number } {
  if (!file) return { matchedTrack: null, matchedIndex: -1 }
  const normalizedFile = file.replace(/\\/g, '/').toLowerCase()

  const foundIdx = queue.findIndex((t) => {
    const p = (t.filePath || t.folderPath || '').replace(/\\/g, '/').toLowerCase()
    return p === normalizedFile || t.id === file
  })

  if (foundIdx >= 0) {
    return { matchedTrack: queue[foundIdx], matchedIndex: foundIdx }
  }
  return { matchedTrack: null, matchedIndex: -1 }
}

export function handleRemoteStateEvent(
  data: any,
  state: RemoteQueueSyncState
) {
  if (!data) return
  const isPlaying = data.isPlaying ?? data.is_playing
  const isPaused = data.isPaused ?? data.is_paused
  const currentFile = data.currentFile ?? data.current_file

  if (isPlaying !== undefined) state.isPlaying = Boolean(isPlaying)
  if (isPaused !== undefined) state.isPaused = Boolean(isPaused)

  if (currentFile) {
    const { matchedTrack, matchedIndex } = reconcileActiveTrack(currentFile, state.queue, state.currentTrack)
    if (matchedTrack && matchedIndex >= 0) {
      state.currentTrack = matchedTrack
      state.queueIndex = matchedIndex
    }
  }
}

export async function handleRemoteQueueEvent(
  payload: {
    items: Array<{ id: string; title: string; filePath?: string; file_path?: string; queueEntryId?: string; queue_entry_id?: string }>
    currentIndex?: number
    current_index?: number
    revision: number
  },
  state: RemoteQueueSyncState,
  fetchTracksFromDb: (ids: string[]) => Promise<Track[]>,
  commitState: (tracks: Track[], index: number) => void
) {
  const { items, revision } = payload
  const effectiveIndex = typeof payload.currentIndex === 'number'
    ? payload.currentIndex
    : typeof payload.current_index === 'number'
    ? payload.current_index
    : 0

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
    const fp = item.filePath || item.file_path || ''
    return {
      id: item.id,
      title: item.title,
      folderPath: fp,
      filePath: fp,
      format: 'FLAC',
      durationSeconds: 180,
    } as Track
  })

  commitState(orderedTracks, effectiveIndex)
  state.queue = orderedTracks
  state.queueIndex = effectiveIndex
  if (effectiveIndex >= 0 && effectiveIndex < orderedTracks.length) {
    state.currentTrack = orderedTracks[effectiveIndex]
  }
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

  // --- TEST 4: Snake_Case Remote Event Normalization & Active Track Update ---
  console.log('\n--- Test 4: Snake_case remote event normalization & active track update ---')
  // Setup multi-track queue: [Track 1 (Adho Mega Oorvalam), Track 2 (Kalakalakum), Track 3 (Thendral Kaatre), Track 4 (Vaa Vaa Anbe)]
  const albumTracks = [
    { id: 'trk-1', title: 'Adho Mega Oorvalam', file_path: 'D:/Music/01.flac' },
    { id: 'trk-2', title: 'Kalakalakum Maniosai', file_path: 'D:/Music/02.flac' },
    { id: 'trk-3', title: 'Thendral Kaatre', file_path: 'D:/Music/03.flac' },
    { id: 'trk-4', title: 'Vaa Vaa Anbe', file_path: 'D:/Music/04.flac' },
  ]
  await handleRemoteQueueEvent(
    { items: albumTracks, current_index: 0, revision: 4 },
    state,
    async () => [],
    () => {}
  )
  assert(state.queue.length === 4, 'Queue has 4 tracks loaded')
  assert(state.queueIndex === 0, 'Initial queue index is 0')
  assert(state.currentTrack?.title === 'Adho Mega Oorvalam', 'Current track initialized to Track 1')

  // Native backend sends snake_case state change advancing to Track 3 (Thendral Kaatre)
  handleRemoteStateEvent(
    {
      type: 'STATE_CHANGE',
      is_playing: true,
      is_paused: false,
      current_file: 'D:/Music/03.flac',
      position_secs: 12.5,
      duration_secs: 304.0,
    },
    state
  )
  assert(state.queueIndex === 2, 'Queue index reconciled to Track 3 (index 2)')
  assert(state.currentTrack?.title === 'Thendral Kaatre', 'Now Playing updated to Thendral Kaatre')
  assert(state.isPlaying === true, 'Playback state is playing')

  // --- TEST 5: Native Backend advances to Track 4 (Vaa Vaa Anbe) ---
  console.log('\n--- Test 5: Reconciling Track 4 (Vaa Vaa Anbe) from current_file ---')
  handleRemoteStateEvent(
    {
      type: 'STATE_CHANGE',
      is_playing: true,
      is_paused: false,
      current_file: 'D:/Music/04.flac',
      position_secs: 0.0,
      duration_secs: 291.0,
    },
    state
  )
  assert(state.queueIndex === 3, 'Queue index reconciled to Track 4 (index 3)')
  assert(state.currentTrack?.title === 'Vaa Vaa Anbe', 'Now Playing updated to Vaa Vaa Anbe')

  console.log('\n=====================================================')
  console.log('All Remote Queue Sync tests passed successfully!')
  console.log('=====================================================')
}

runTestSuite().catch((e) => {
  console.error(e)
  process.exit(1)
})

