import {
  computePlaylistFormatBreakdown,
  generatePlaylist4GridArtwork,
  SqliteLibraryService,
} from '../services/sqliteLibraryService'
import { computeSampleRateTransition } from '../context/AudioPlayerContext'
import { Track, Release } from '../core/types'

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`)
    throw new Error(`Assertion failed: ${message}`)
  }
  console.log(`✅ Passed: ${message}`)
}

async function runTestSuite() {
  console.log('=====================================================')
  console.log('Cadence Queue & Playlist Architecture Test Suite')
  console.log('=====================================================\n')

  // --- TEST 1: computePlaylistFormatBreakdown ---
  console.log('--- Test 1: computePlaylistFormatBreakdown ---')
  const dsdTrack1: Track = {
    id: 't-dsd-1',
    releaseId: 'r-1',
    title: 'Autumn Leaves',
    format: 'DSF',
    sampleRateStr: 'DSD256 11.2MHz',
    sampleRate: 11289600,
    bitDepth: 1,
    durationSeconds: 320,
    folderPath: '/music',
    trackNumber: 1,
  }

  const dsdTrack2: Track = {
    id: 't-dsd-2',
    releaseId: 'r-1',
    title: 'Blue in Green',
    format: 'DSD',
    sampleRateStr: 'DSD64 2.8MHz',
    sampleRate: 2822400,
    bitDepth: 1,
    durationSeconds: 280,
    folderPath: '/music',
    trackNumber: 2,
  }

  const flacTrack1: Track = {
    id: 't-flac-1',
    releaseId: 'r-2',
    title: 'Kind of Blue',
    format: 'FLAC',
    sampleRateStr: '24-bit / 192 kHz',
    sampleRate: 192000,
    bitDepth: 24,
    isHighRes: true,
    durationSeconds: 560,
    folderPath: '/music',
    trackNumber: 1,
  }

  const flacTrack2: Track = {
    id: 't-flac-2',
    releaseId: 'r-2',
    title: 'So What',
    format: 'FLAC',
    sampleRateStr: '16-bit / 44.1 kHz',
    sampleRate: 44100,
    bitDepth: 16,
    isHighRes: false,
    durationSeconds: 540,
    folderPath: '/music',
    trackNumber: 2,
  }

  const wavTrack: Track = {
    id: 't-wav-1',
    releaseId: 'r-3',
    title: 'Take Five',
    format: 'WAV',
    sampleRateStr: '24-bit / 96 kHz',
    sampleRate: 96000,
    bitDepth: 24,
    isHighRes: true,
    durationSeconds: 324,
    folderPath: '/music',
    trackNumber: 1,
  }

  assert(computePlaylistFormatBreakdown([]) === '0 tracks • Empty', 'Empty track list breakdown')
  assert(
    computePlaylistFormatBreakdown([dsdTrack1, dsdTrack2]) === '2 tracks • Pure DSD256',
    'Pure DSD breakdown'
  )
  assert(
    computePlaylistFormatBreakdown([dsdTrack1, flacTrack1]) === '2 tracks • DSD/FLAC hybrid',
    'Hybrid DSD/FLAC breakdown'
  )
  assert(
    computePlaylistFormatBreakdown([flacTrack1, flacTrack2]) === '2 tracks • Hi-Res FLAC',
    'Hi-Res FLAC breakdown'
  )
  assert(
    computePlaylistFormatBreakdown([wavTrack]) === '1 tracks • Pure WAV',
    'Pure WAV breakdown'
  )

  // --- TEST 2: generatePlaylist4GridArtwork ---
  console.log('\n--- Test 2: generatePlaylist4GridArtwork ---')
  const releases: Release[] = [
    { id: 'r-1', title: 'Album 1', artistCredit: 'Artist 1', coverArtUrl: 'art-1.jpg' } as any,
    { id: 'r-2', title: 'Album 2', artistCredit: 'Artist 2', coverArtUrl: 'art-2.jpg' } as any,
    { id: 'r-3', title: 'Album 3', artistCredit: 'Artist 3', coverArtUrl: 'art-3.jpg' } as any,
    { id: 'r-4', title: 'Album 4', artistCredit: 'Artist 4', coverArtUrl: 'art-4.jpg' } as any,
    { id: 'r-5', title: 'Album 5', artistCredit: 'Artist 5', coverArtUrl: 'art-5.jpg' } as any,
  ]

  const gridTracks = [
    { ...dsdTrack1, releaseId: 'r-1' },
    { ...dsdTrack2, releaseId: 'r-1' }, // duplicate release art
    { ...flacTrack1, releaseId: 'r-2' },
    { ...wavTrack, releaseId: 'r-3' },
    { id: 't-4', releaseId: 'r-4' } as any,
    { id: 't-5', releaseId: 'r-5' } as any,
  ]

  const grid = generatePlaylist4GridArtwork(gridTracks, releases)
  assert(grid.length === 4, 'Grid extracts exactly 4 unique artworks')
  assert(grid[0] === 'art-1.jpg' && grid[1] === 'art-2.jpg' && grid[2] === 'art-3.jpg' && grid[3] === 'art-4.jpg', 'Deduplication works properly across releases')

  // --- TEST 3: computeSampleRateTransition ---
  console.log('\n--- Test 3: computeSampleRateTransition ---')
  // Same rate: no transition
  const transSame = computeSampleRateTransition(flacTrack1, flacTrack1, 350)
  assert(transSame === null, 'Identical sample rate returns null transition')

  // Same-family clock multiplier (44.1kHz -> 88.2kHz)
  const track88k: Track = { ...flacTrack2, sampleRate: 88200, sampleRateStr: '88.2 kHz' }
  const transSameFam = computeSampleRateTransition(flacTrack2, track88k, 350)
  assert(transSameFam !== null, '44.1kHz -> 88.2kHz produces transition')
  assert(transSameFam?.isSameFamily === true, '44.1kHz and 88.2kHz are in the same 44.1 family')
  assert(transSameFam?.settlingDelayMs === 200, 'Same family fast-lock delay is capped at 200ms')

  // Cross-family clock switch (44.1kHz -> 96kHz or 48kHz)
  const transCrossFam = computeSampleRateTransition(flacTrack2, wavTrack, 350)
  assert(transCrossFam !== null, '44.1kHz -> 96kHz produces transition')
  assert(transCrossFam?.isSameFamily === false, '44.1kHz and 96kHz are cross-family (44.1 vs 48)')
  assert(transCrossFam?.settlingDelayMs === 350, 'Cross-family uses default 350ms settling delay')

  // Cross-domain (PCM -> DSD)
  const transCrossDomain = computeSampleRateTransition(flacTrack1, dsdTrack1, 350)
  assert(transCrossDomain !== null, 'PCM -> DSD produces cross-domain transition')
  assert(transCrossDomain?.isSameFamily === false, 'PCM and DSD are cross-domain')
  assert(transCrossDomain?.settlingDelayMs === 500, 'Cross-domain hardware relay switch enforces at least 500ms delay')

  // --- TEST 4: SqliteLibraryService Playlist In-Memory CRUD ---
  console.log('\n--- Test 4: SqliteLibraryService Playlist CRUD ---')
  const service = new SqliteLibraryService()

  // 1. Create Playlist
  const createdPl = await service.createPlaylist({
    title: 'Reference DSD & Jazz',
    description: 'Acoustic recordings for DAC testing',
    tags: ['DSD', 'Reference', 'Jazz'],
    listeningNotes: 'Holo Audio May NOS Mode recommended',
    tracks: [dsdTrack1, flacTrack1],
  })

  assert(createdPl.title === 'Reference DSD & Jazz', 'Playlist created with title')
  assert(createdPl.tracksCount === 2, 'Initial tracksCount is 2')
  assert(createdPl.formatBreakdown === '2 tracks • DSD/FLAC hybrid', 'Format breakdown calculated')
  assert(createdPl.totalDurationSecs === 320 + 560, 'Total duration sum is correct')

  // 2. Get Playlists
  const allPlaylists = await service.getPlaylists()
  assert(allPlaylists.length === 1, 'getPlaylists returns 1 playlist')
  assert(allPlaylists[0].id === createdPl.id, 'Playlist ID matches')

  // 3. Get Playlist Details
  const details = await service.getPlaylistDetails(createdPl.id)
  assert(details !== null && details.id === createdPl.id, 'getPlaylistDetails returns playlist')
  assert(details?.tracks?.length === 2, 'getPlaylistDetails returns 2 tracks')

  // 4. Add Tracks to Playlist
  await service.addTracksToPlaylist(createdPl.id, [wavTrack])
  const updatedDetails = await service.getPlaylistDetails(createdPl.id)
  assert(updatedDetails?.tracks?.length === 3, 'addTracksToPlaylist increased track count to 3')
  assert(updatedDetails?.tracksCount === 3, 'tracksCount updated in playlist metadata')

  // 5. Reorder Playlist Tracks
  const reorderedIds = [wavTrack.id, dsdTrack1.id, flacTrack1.id]
  await service.reorderPlaylistTracks(createdPl.id, reorderedIds)
  const reorderedDetails = await service.getPlaylistDetails(createdPl.id)
  assert(reorderedDetails?.tracks?.[0].id === wavTrack.id, 'Track 0 is now wavTrack')
  assert(reorderedDetails?.tracks?.[1].id === dsdTrack1.id, 'Track 1 is now dsdTrack1')
  assert(reorderedDetails?.tracks?.[2].id === flacTrack1.id, 'Track 2 is now flacTrack1')

  // 6. Remove Track from Playlist
  await service.removeTrackFromPlaylist(createdPl.id, 0)
  const afterRemoveDetails = await service.getPlaylistDetails(createdPl.id)
  assert(afterRemoveDetails?.tracks?.length === 2, 'removeTrackFromPlaylist reduced count to 2')
  assert(afterRemoveDetails?.tracks?.[0].id === dsdTrack1.id, 'Track at index 0 removed, dsdTrack1 now at 0')

  // 7. Update Playlist Metadata
  await service.updatePlaylist(createdPl.id, {
    title: 'Updated Reference Collection',
    listeningNotes: 'Updated listening notes',
  })
  const afterUpdate = await service.getPlaylistDetails(createdPl.id)
  assert(afterUpdate?.title === 'Updated Reference Collection', 'Playlist title updated')
  assert(afterUpdate?.listeningNotes === 'Updated listening notes', 'Listening notes updated')

  // 8. Delete Playlist
  await service.deletePlaylist(createdPl.id)
  const remaining = await service.getPlaylists()
  assert(remaining.length === 0, 'deletePlaylist successfully removed playlist')

  console.log('\n=====================================================')
  console.log('All Cadence Queue & Playlist Architecture Tests Passed! 🚀')
  console.log('=====================================================')
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
