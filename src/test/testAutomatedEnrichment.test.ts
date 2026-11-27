import assert from 'node:assert/strict'
import { test  } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createEngineArtworkCache,
  createEngineClient,
} from '../services/engineClient'
import type {
  CoreCatalogTrack,
  EngineEnrichmentAlbumDetail,
  EngineEnrichmentStatus,
} from '../core/coreProtocol'
import {
  cleanEditionLabel,
  mapCoreCatalogToUi,
  selectCatalogTracksForUi,
} from '../context/EngineControllerContext'
import {
  DEFAULT_PRIORITY_SETTINGS,
  evaluateCatalogProblems,
} from '../core/curatePriorities'
import {
  findRootEnrichmentProgress,
  formatEnrichmentStateLabel,
  formatRootEnrichmentHeadline,
  getRootScanState,
  humanizeScanError,
} from '../components/Modals/StorageManagerModal'
import { formatEngineDisplayName } from '../utils/enginePathDisplay'
import {
  extractCachedEnrichmentProposal,
  formatArtworkSourcePlainEnglish,
  formatEnrichmentUserAction,
  formatStripStatusBadge,
  translateVetoToPlainEnglish,
} from '../components/Curate/AutoEnrichmentPanel'
import {
  CurationDecisionTraceDrawer,
  humanizeConsensusRule,
  humanizeDecisionExplanation,
} from '../components/Curate/CurationDecisionTraceDrawer'
import { buildEngineCurateChanges } from '../services/engineCurateBridge'

test('createEngineClient sends v2 enrichment operations and strips core_rel_ prefixes', async () => {
  const sentBodies: Array<Record<string, unknown>> = []
  const client = createEngineClient(
    {
      baseUrl: 'http://127.0.0.1:19400',
      engineId: 'eng-1',
      libraryId: 'lib-1',
      label: 'Test Core',
      pairingToken: 'tok-1',
    },
    async (_target, body) => {
      sentBodies.push(body)
      switch (body.operation) {
        case 'enrichment.status':
          return {
            ok: true,
            data: {
              state: 'active',
              enabled: true,
              userPaused: false,
              cooldownRemainingSecs: null,
              currentReleaseId: 'rel_1',
              currentAlbumTitle: 'Roja',
              totalAlbums: 10,
              coveredAlbums: 6,
              coveragePercent: 60,
              autoAppliedAlbums: 4,
              needsReviewAlbums: 1,
              noMatchAlbums: 0,
              userLockedAlbums: 1,
              pendingAlbums: 4,
              failedAlbums: 0,
              artworkCoveredAlbums: 7,
              artworkCoveragePercent: 70,
              artworkPendingItems: 3,
              providerGates: [],
              roots: [],
            },
          }
        case 'enrichment.control':
          return {
            ok: true,
            data: {
              state: 'user_paused',
              enabled: true,
              userPaused: true,
              cooldownRemainingSecs: null,
              currentReleaseId: null,
              currentAlbumTitle: null,
              totalAlbums: 10,
              coveredAlbums: 6,
              coveragePercent: 60,
              autoAppliedAlbums: 4,
              needsReviewAlbums: 1,
              noMatchAlbums: 0,
              userLockedAlbums: 1,
              pendingAlbums: 4,
              failedAlbums: 0,
              artworkCoveredAlbums: 7,
              artworkCoveragePercent: 70,
              artworkPendingItems: 3,
              providerGates: [],
              roots: [],
            },
          }
        case 'enrichment.albums.list':
          return { ok: true, data: { albums: [] } }
        case 'enrichment.album.detail':
        case 'enrichment.album.action':
          return {
            ok: true,
            data: {
              releaseId: 'rel_1',
              rawTitle: 'Roja [CD Rip]',
              rawArtist: 'Unknown Artist',
              rawYear: null,
              rawComposer: null,
              rawGenre: null,
              status: 'auto_applied',
              provider: 'musicbrainz',
              externalReleaseId: 'mb-1',
              distance: 0.02,
              runnerUpDistance: 0.45,
              vetoes: [],
              proposal: null,
              overlays: [],
              tracks: [],
              artworkStatus: 'found',
              artworkSource: 'external:coverartarchive',
              artworkWidth: 1000,
              artworkHeight: 1000,
              artworkTrace: [],
              userActions: [],
            },
          }
        default:
          return { ok: false, error: { code: 'unsupported_capability' } }
      }
    },
  )

  const status = await client.getEnrichmentStatus()
  assert.equal(status.coveragePercent, 60)

  await client.controlEnrichment({ action: 'rerun_album', releaseId: 'core_rel_rel_1' })
  await client.listEnrichmentAlbums({ status: 'auto_applied', folderId: 'wf-1', limit: 50 })
  await client.getEnrichmentAlbumDetail('core_rel_rel_1')
  await client.applyEnrichmentAlbumAction({
    releaseId: 'core_rel_rel_1',
    action: 'save_overlay',
    fields: { album: 'Roja', album_artist: 'A. R. Rahman' },
    tracks: [{ trackId: 't1', artist: 'Minmini' }],
  })

  assert.equal(sentBodies.length, 5)
  assert.equal(sentBodies[1].operation, 'enrichment.control')
  assert.equal(sentBodies[1].releaseId, 'rel_1')
  assert.equal(sentBodies[3].releaseId, 'rel_1')
  assert.equal(sentBodies[4].action, 'save_overlay')
  assert.equal(sentBodies[4].releaseId, 'rel_1')
})

test('selectCatalogTracksForUi prefers hydrated v2 tracks for small libraries (<= 200 tracks)', () => {
  const snapshotTrack: CoreCatalogTrack = {
    id: 'trk_1',
    title: 'Chinna Chinna Aasai',
    artist: 'Unknown Artist',
    album: 'Roja [CD Rip]',
    durationSeconds: 300,
    hasCoverArt: false,
  }
  const hydratedTrack: CoreCatalogTrack = {
    id: 'trk_1',
    title: 'Chinna Chinna Aasai',
    artist: 'Minmini',
    album: 'Roja',
    albumArtist: 'A. R. Rahman',
    durationSeconds: 300,
    hasCoverArt: true,
    genreTags: ['Soundtrack'],
  }

  // Same length (<= 200 tracks) MUST choose hydrated v2 tracks, not snapshot tracks
  const chosen = selectCatalogTracksForUi([hydratedTrack], [snapshotTrack])
  assert.equal(chosen[0].album, 'Roja')
  assert.equal(chosen[0].hasCoverArt, true)
  assert.deepEqual(chosen[0].genreTags, ['Soundtrack'])

  // Before hydration completes, fall back to snapshot tracks
  const fallback = selectCatalogTracksForUi([], [snapshotTrack])
  assert.equal(fallback[0].album, 'Roja [CD Rip]')
})

test('Curate backlog counts stay in sync as background auto-enrichment fixes catalog', () => {
  const beforeTracks: CoreCatalogTrack[] = [
    {
      id: 'trk_1',
      releaseId: 'rel_1',
      title: 'Chinna Chinna Aasai',
      artist: 'Unknown Artist',
      album: 'Roja [CD Rip]',
      edition: 'Roja [CD Rip]',
      folderName: 'Roja [CD Rip]',
      trackNumber: 1,
      discNumber: 1,
      durationSeconds: 300,
      hasCoverArt: false,
    },
    {
      id: 'trk_2',
      releaseId: 'rel_1',
      title: 'Pudhu Vellai Mazhai',
      artist: 'Unknown Artist',
      album: 'Roja [CD Rip]',
      edition: 'Roja [CD Rip]',
      folderName: 'Roja [CD Rip]',
      trackNumber: 2,
      discNumber: 1,
      durationSeconds: 315,
      hasCoverArt: false,
    },
  ]

  const beforeUi = mapCoreCatalogToUi(beforeTracks)
  const beforeSummary = evaluateCatalogProblems(
    beforeUi.tracks,
    beforeUi.releases,
    DEFAULT_PRIORITY_SETTINGS,
  )
  assert.equal(beforeSummary.categoryCounts.cd_rip_suffix.count, 1)
  assert.equal(beforeSummary.categoryCounts.missing_artist_and_composer.count, 1)
  assert.equal(beforeSummary.categoryCounts.missing_cover_art.count, 1)
  assert.equal(beforeSummary.categoryCounts.missing_release_year.count, 1)

  // After background auto-enrichment overlay + artwork upgrade (with edition suppressed on overlaid album)
  const afterTracks: CoreCatalogTrack[] = [
    {
      id: 'trk_1',
      releaseId: 'rel_1',
      title: 'Chinna Chinna Aasai',
      artist: 'Minmini',
      album: 'Roja',
      albumArtist: 'A. R. Rahman',
      edition: undefined,
      folderName: 'Roja [CD Rip]',
      releaseYear: 1992,
      genreTags: ['Soundtrack'],
      trackNumber: 1,
      discNumber: 1,
      durationSeconds: 300,
      hasCoverArt: true,
    },
    {
      id: 'trk_2',
      releaseId: 'rel_1',
      title: 'Pudhu Vellai Mazhai',
      artist: 'Sujatha',
      album: 'Roja',
      albumArtist: 'A. R. Rahman',
      edition: undefined,
      folderName: 'Roja [CD Rip]',
      releaseYear: 1992,
      genreTags: ['Soundtrack'],
      trackNumber: 2,
      discNumber: 1,
      durationSeconds: 315,
      hasCoverArt: true,
    },
  ]

  const afterUi = mapCoreCatalogToUi(afterTracks)
  const afterSummary = evaluateCatalogProblems(
    afterUi.tracks,
    afterUi.releases,
    DEFAULT_PRIORITY_SETTINGS,
  )
  assert.equal(afterSummary.categoryCounts.cd_rip_suffix.count, 0)
  assert.equal(afterSummary.categoryCounts.missing_artist_and_composer.count, 0)
  assert.equal(afterSummary.categoryCounts.missing_cover_art.count, 0)
  assert.equal(afterSummary.categoryCounts.missing_release_year.count, 0)
  assert.equal(afterSummary.totalActionableAlbums, 0)
})

test('Watched Root enrichment progress lookup and state formatting work accurately', () => {
  const status: EngineEnrichmentStatus = {
    state: 'cooldown',
    enabled: true,
    userPaused: false,
    cooldownRemainingSecs: 24,
    currentReleaseId: null,
    currentAlbumTitle: null,
    totalAlbums: 20,
    coveredAlbums: 15,
    coveragePercent: 75,
    autoAppliedAlbums: 12,
    needsReviewAlbums: 2,
    noMatchAlbums: 0,
    userLockedAlbums: 1,
    pendingAlbums: 5,
    failedAlbums: 0,
    artworkCoveredAlbums: 16,
    artworkCoveragePercent: 80,
    artworkPendingItems: 4,
    providerGates: [],
    roots: [
      {
        folderId: 'wf_nas_flac',
        displayName: 'NAS FLAC',
        path: '\\\\nas\\music\\flac',
        totalAlbums: 10,
        coveredAlbums: 8,
        coveragePercent: 80,
        autoAppliedAlbums: 6,
        needsReviewAlbums: 1,
        noMatchAlbums: 0,
        userLockedAlbums: 1,
        pendingAlbums: 2,
        failedAlbums: 0,
        artworkCoveredAlbums: 9,
        artworkCoveragePercent: 90,
      },
    ],
  }

  assert.equal(formatEnrichmentStateLabel(status), 'Cooldown (24s)')
  const root = findRootEnrichmentProgress(status, 'wf_nas_flac')
  assert.ok(root)
  assert.equal(root.coveragePercent, 80)
  assert.equal(root.coveredAlbums, 8)
  assert.equal(root.noMatchAlbums, 0)
  assert.equal(findRootEnrichmentProgress(status, 'missing-root'), null)
})

test('extractCachedEnrichmentProposal wires cached MusicBrainz and Apple Music Review proposals to album and tracks', () => {
  const mbDetail: EngineEnrichmentAlbumDetail = {
    releaseId: 'rel_1',
    rawTitle: 'Roja (OST)',
    rawArtist: 'A. R. Rahman',
    rawYear: null,
    rawComposer: null,
    rawGenre: null,
    status: 'needs_review',
    provider: 'musicbrainz',
    externalReleaseId: 'mb-1',
    distance: 0.11,
    runnerUpDistance: 0.25,
    vetoes: [{ code: 'AMBIGUOUS_RUNNER_UP', message: 'Close alternate edition' }],
    proposal: {
      provider: 'musicbrainz',
      album: 'Roja',
      albumArtist: 'A. R. Rahman',
      composer: 'A. R. Rahman',
      year: 1992,
      genre: 'Soundtrack',
      artworkUrl: 'https://coverartarchive.org/release/mb-1/front-1200',
      reviewReleaseFields: ['album', 'album_artist'],
      tracks: [
        {
          localTrackId: 'trk_1',
          candidateTitle: 'Chinna Chinna Aasai',
          candidateArtist: 'Minmini',
          proposedArtist: 'Minmini',
          trackDistance: 0.02,
          autoApplyFields: [],
          reviewFields: ['track_artist'],
        },
      ],
    },
    overlays: [],
    tracks: [],
    artworkStatus: 'absent',
    artworkSource: null,
    artworkWidth: null,
    artworkHeight: null,
    artworkTrace: [],
    userActions: [],
  }

  const parsedMb = extractCachedEnrichmentProposal('core_rel_rel_1', mbDetail)
  assert.ok(parsedMb)
  assert.equal(parsedMb.provider, 'musicbrainz')
  assert.equal(parsedMb.albumTitle, 'Roja')
  assert.equal(parsedMb.albumArtist, 'A. R. Rahman')
  assert.equal(parsedMb.year, 1992)
  assert.equal(parsedMb.genre, 'Soundtrack')
  assert.equal(parsedMb.coverArtUrl, 'https://coverartarchive.org/release/mb-1/front-1200')
  assert.equal(parsedMb.tracksById.get('trk_1')?.artist, 'Minmini')

  const appleDetail: EngineEnrichmentAlbumDetail = {
    ...mbDetail,
    releaseId: 'rel_2',
    provider: 'apple_music',
    proposal: {
      provider: 'apple_music',
      album: 'Dil Se..',
      albumArtist: 'A. R. Rahman',
      year: 1998,
      artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/1200x1200bb.jpg',
      reviewReleaseFields: ['album'],
      tracks: [
        {
          localTrackId: 'trk_9',
          candidateTitle: 'Chaiyya Chaiyya',
          candidateArtist: 'Sukhwinder Singh & Sapna Awasthi',
          proposedTitle: 'Chaiyya Chaiyya',
          proposedArtist: 'Sukhwinder Singh & Sapna Awasthi',
          reviewFields: ['track_artist'],
        },
      ],
    },
  }

  const parsedApple = extractCachedEnrichmentProposal('rel_2', appleDetail)
  assert.ok(parsedApple)
  assert.equal(parsedApple.provider, 'apple')
  assert.equal(parsedApple.albumTitle, 'Dil Se..')
  assert.equal(parsedApple.tracksById.get('trk_9')?.title, 'Chaiyya Chaiyya')

  // Guard against stale detail bleeding into a different album
  assert.equal(extractCachedEnrichmentProposal('core_rel_other', mbDetail), null)
  assert.equal(extractCachedEnrichmentProposal('core_rel_rel_1', { ...mbDetail, proposal: null }), null)
})

test('cleanEditionLabel stops appending CD RIP suffix while keeping genuine editions', () => {
  assert.equal(cleanEditionLabel('Kizhakku Vasal CD RIP', 'Kizhakku Vasal'), '')
  assert.equal(cleanEditionLabel('Roja [CD-RIP]', 'Roja'), '')
  assert.equal(cleanEditionLabel('Kizhakku Vasal [PGGB]', 'Kizhakku Vasal'), 'PGGB')
  assert.equal(cleanEditionLabel('2015 Remaster', 'Symphony No. 5'), '2015 Remaster')
  const { releases } = mapCoreCatalogToUi([
    {
      id: 'trk_kv_1',
      releaseId: 'rel_kv',
      title: 'Veettukku Veettukku',
      artist: 'Ilaiyaraaja',
      album: 'Kizhakku Vasal',
      edition: 'Kizhakku Vasal CD RIP',
      durationSeconds: 253,
      format: 'WAV',
      sampleRate: 44100,
      bitDepth: 16,
    },
  ])
  assert.equal(releases[0].title, 'Kizhakku Vasal')
})

test('plain-English Curate helpers strip internal jargon and Drawer shows Automatic Match + Activity Log', () => {
  const vetoText = translateVetoToPlainEnglish(
    {
      code: 'DURATION_MISMATCH',
      message: 'Track duration drift exceeds safety bounds (max diff 20.4s, 1/5 outside 10s grace)',
    },
    'apple_music',
  )
  assert.doesNotMatch(vetoText, /DURATION_MISMATCH|Beets|d=/)
  assert.match(vetoText, /Apple Music/)
  assert.match(vetoText, /1\/5 tracks/)

  const artPlain = formatArtworkSourcePlainEnglish('external:apple_music', 'found', 1200, 1200)
  assert.equal(artPlain, 'Cover art from Apple Music · 1200×1200')
  assert.doesNotMatch(artPlain ?? '', /Artwork Chain|external:/)

  const actionFormatted = formatEnrichmentUserAction({
    id: 1,
    entityType: 'release',
    entityId: 'rel_1',
    fieldName: 'album',
    action: 'manual_edit',
    previousValue: 'Kizhakku Vasal CD RIP',
    newValue: 'Kizhakku Vasal',
    actor: 'user',
    createdAt: '2026-11-20 08:05:00',
  })
  assert.equal(actionFormatted.label, 'Staged in Cache')

  assert.equal(humanizeConsensusRule('consensus_apple_mb'), 'Apple Music & MusicBrainz agreement')
  assert.doesNotMatch(
    humanizeDecisionExplanation('Applied title because remote providers reached consensus_apple_mb.'),
    /consensus_apple_mb/,
  )

  const drawerHtml = renderToStaticMarkup(
    createElement(CurationDecisionTraceDrawer, {
      isOpen: true,
      onClose: () => {},
      trace: null,
      enrichmentDetail: {
        releaseId: 'rel_kv',
        rawTitle: 'Kizhakku Vasal CD RIP',
        rawArtist: 'Ilaiyaraaja',
        rawAlbumArtist: 'Ilaiyaraaja',
        rawYear: 1990,
        rawComposer: 'Ilaiyaraaja',
        rawGenre: 'Tamil Film Soundtrack',
        status: 'user_locked',
        provider: 'apple_music',
        externalReleaseId: 'am-123',
        distance: 0.24,
        runnerUpDistance: null,
        vetoes: [{ code: 'DURATION_MISMATCH', message: '1/5 outside 10s grace' }],
        proposal: {
          provider: 'apple_music',
          album: 'Kizhakku Vasal (Original Motion Picture Soundtrack)',
          albumArtist: 'Ilaiyaraaja',
          year: 1990,
          tracks: [{ localTrackId: 't1' }],
        },
        overlays: [],
        tracks: [],
        artworkStatus: 'found',
        artworkSource: 'external:apple_music',
        artworkWidth: 1200,
        artworkHeight: 1200,
        artworkTrace: [],
        userActions: [
          {
            id: 1,
            entityType: 'release',
            entityId: 'rel_kv',
            fieldName: 'album',
            action: 'commit_to_file',
            previousValue: null,
            newValue: 'Kizhakku Vasal',
            actor: 'user',
            createdAt: '2026-11-20 08:05:00',
          },
        ],
      },
    }),
  )
  assert.match(drawerHtml, /Match &amp; Activity History/)
  assert.match(drawerHtml, /Automatic Match/)
  assert.match(drawerHtml, /Apple Music/)
  assert.match(drawerHtml, /Activity Log/)
  assert.match(drawerHtml, /Written to File/)
  assert.doesNotMatch(drawerHtml, /No saved retrievals yet/)
})

test('EngineArtworkCache.invalidate evicts cached 404 misses and target releases', async () => {
  let fetches = 0
  const cache = createEngineArtworkCache({
    async fetchArtwork() {
      fetches++
      return {
        status: fetches === 1 ? 404 : 200,
        etag: fetches === 1 ? null : 'etag-2',
        contentType: 'image/png',
        base64: null,
        bytes: fetches === 1 ? undefined : new Uint8Array([137, 80, 78, 71]),
      }
    },
  })
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:mock-art'
  URL.revokeObjectURL = () => {}
  try {
    const profile = { engineId: 'eng-1', baseUrl: 'http://127.0.0.1:19400', pairingToken: 'tok' }
    assert.equal(await cache.getOrFetch(profile, 'core_rel_rel_1', 1), null)
    // Cached 404 at same revision stays null until invalidated
    assert.equal(await cache.getOrFetch(profile, 'core_rel_rel_1', 1), null)
    assert.equal(fetches, 1)

    cache.invalidate('core_rel_rel_1')
    assert.equal(await cache.getOrFetch(profile, 'core_rel_rel_1', 1), 'blob:mock-art')
    assert.equal(fetches, 2)
  } finally {
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  }
})

test('buildEngineCurateChanges diffs Staged Cache against true rawBaseline even when Listen track is overlaid', () => {
  const overlaidTrack = {
    id: 'trk_1',
    releaseId: 'core_rel_rel_1',
    title: 'Staged Title',
    artistCredit: 'Staged Artist',
    albumTitle: 'Kizhakku Vasal',
    albumArtist: 'Ilaiyaraaja',
    durationSeconds: 200,
    trackNumber: 1,
    discNumber: 1,
    filePath: 'trk_1',
    fileSize: 0,
    storageMountId: 'core',
    sidecarStatus: 'synced' as const,
    modifiedTimestamp: '2026-11-20T00:00:00Z',
    checksumValid: true,
    accurateRipConfidence: 0,
    sampleRateStr: '16-bit / 44.1 kHz',
    format: 'WAV' as const,
  }
  const payload = JSON.stringify({
    title: 'Staged Title',
    artist: 'Staged Artist',
    album: 'Kizhakku Vasal',
  })
  // Without rawBaseline, overlaid == selected -> empty
  assert.deepEqual(buildEngineCurateChanges(payload, overlaidTrack), [])
  // With rawBaseline anchored from Engine raw columns -> detects exact disk diff!
  const changes = buildEngineCurateChanges(payload, overlaidTrack, undefined, {
    release: { album: 'Kizhakku Vasal CD RIP' },
    tracksById: new Map([['trk_1', { title: 'Raw Title', artist: 'Unknown Artist' }]]),
  })
  assert.deepEqual(changes, [
    { field: 'title', before: 'Raw Title', after: 'Staged Title' },
    { field: 'artist', before: 'Unknown Artist', after: 'Staged Artist' },
    { field: 'album', before: 'Kizhakku Vasal CD RIP', after: 'Kizhakku Vasal' },
  ])
})

test('Match Strip formats downloading/retrying staged cover art and Staged in Cache badge accurately', () => {
  const artUrl = 'https://is1-ssl.mzstatic.com/image/thumb/cover.jpg/3000x3000bb.jpg'
  assert.equal(
    formatArtworkSourcePlainEnglish(null, 'absent', null, null, {
      url: artUrl,
      attempts: 0,
      error: null,
    }),
    'Downloading staged cover art…',
  )
  assert.equal(
    formatArtworkSourcePlainEnglish(null, 'absent', null, null, {
      url: artUrl,
      attempts: 2,
      error: 'operation timed out',
    }),
    'Retrying staged cover art…',
  )

  const baseDetail: EngineEnrichmentAlbumDetail = {
    releaseId: 'rel_asib',
    rawTitle: 'A Star Is Born',
    rawArtist: 'Lady Gaga & Bradley Cooper',
    rawAlbumArtist: 'Lady Gaga & Bradley Cooper',
    rawYear: 2018,
    rawComposer: null,
    rawGenre: 'Soundtrack',
    status: 'user_locked',
    provider: null,
    externalReleaseId: null,
    distance: null,
    runnerUpDistance: null,
    vetoes: [],
    proposal: null,
    overlays: [],
    tracks: [],
    artworkStatus: 'absent',
    artworkSource: null,
    artworkWidth: null,
    artworkHeight: null,
    artworkTrace: [],
    userActions: [],
  }

  assert.equal(formatStripStatusBadge(baseDetail).label, 'File Tags Locked')
  assert.equal(
    formatStripStatusBadge({ ...baseDetail, pendingArtworkUrl: artUrl }).label,
    'Staged in Cache',
  )
  assert.equal(
    formatStripStatusBadge({ ...baseDetail, artworkStatus: 'user_override' }).label,
    'Staged in Cache',
  )
})

test('Watched Root scan state and headline avoid misleading 100% (0/0 albums) during/before scan', () => {
  const emptyRoot = {
    folderId: 'wf_tamil',
    displayName: 'Tamil',
    path: '//192.168.1.6/Mathan/Music Collection/Master/Tamil',
    totalAlbums: 0,
    coveredAlbums: 0,
    coveragePercent: 0,
    autoAppliedAlbums: 0,
    needsReviewAlbums: 0,
    noMatchAlbums: 0,
    userLockedAlbums: 0,
    pendingAlbums: 0,
    failedAlbums: 0,
    artworkCoveredAlbums: 0,
    artworkCoveragePercent: 0,
  }

  assert.equal(
    getRootScanState({ id: 'wf_tamil', lastScannedAt: null }, null),
    'unscanned',
  )
  assert.equal(
    getRootScanState(
      { id: 'wf_tamil', lastScannedAt: null },
      { status: 'running', folderId: 'wf_tamil', processed: 12 },
    ),
    'scanning',
  )
  assert.equal(
    getRootScanState(
      { id: 'wf_tamil', lastScannedAt: null },
      {
        status: 'running',
        folderId: 'wf_other',
        roots: [
          { id: 'wf_other', path: '/music/other' },
          { id: 'wf_tamil', path: '/music/tamil' },
        ],
      },
    ),
    'queued',
  )
  assert.equal(
    getRootScanState(
      { id: 'wf_tamil', lastScannedAt: null },
      { status: 'running', folderId: 'wf_tamil', deferred: true },
    ),
    'deferred',
  )
  assert.equal(
    getRootScanState({ id: 'wf_tamil', lastScannedAt: '2026-11-27T12:00:00Z' }, null),
    'idle',
  )

  const scanningNoProcessed = formatRootEnrichmentHeadline(emptyRoot, 'scanning', 0)
  assert.equal(scanningNoProcessed.headline, 'Scanning subfolders… · 0 albums indexed yet')
  assert.equal(scanningNoProcessed.showArtPercent, false)
  assert.equal(scanningNoProcessed.barPercent, 0)
  assert.equal(scanningNoProcessed.barTone, 'neutral')

  const scanningWithProcessed = formatRootEnrichmentHeadline(emptyRoot, 'scanning', 142)
  assert.equal(
    scanningWithProcessed.headline,
    'Scanning subfolders… (142 items checked) · 0 albums indexed yet',
  )
  assert.equal(scanningWithProcessed.showArtPercent, false)
  assert.equal(scanningWithProcessed.barPercent, 0)
  assert.equal(scanningWithProcessed.barTone, 'neutral')

  const queued = formatRootEnrichmentHeadline(emptyRoot, 'queued')
  assert.equal(queued.headline, 'Scan queued · Waiting to index subfolders')
  assert.equal(queued.barTone, 'neutral')

  const deferred = formatRootEnrichmentHeadline(emptyRoot, 'deferred')
  assert.equal(deferred.headline, 'Scan paused during playback/cooldown · 0 albums indexed yet')
  assert.equal(deferred.barTone, 'neutral')

  const unscanned = formatRootEnrichmentHeadline(emptyRoot, 'unscanned')
  assert.equal(unscanned.headline, 'Not scanned yet · Run Quick Rescan to index subfolders')
  assert.equal(unscanned.barTone, 'neutral')

  const idleEmpty = formatRootEnrichmentHeadline(emptyRoot, 'idle')
  assert.equal(idleEmpty.headline, 'No albums indexed (0 albums)')
  assert.equal(idleEmpty.barTone, 'neutral')

  const partial = formatRootEnrichmentHeadline(
    { ...emptyRoot, totalAlbums: 10, coveredAlbums: 5, coveragePercent: 50 },
    'idle',
  )
  assert.equal(partial.headline, 'Auto-Enrich 50% (5/10 albums)')
  assert.equal(partial.showArtPercent, true)
  assert.equal(partial.barPercent, 50)
  assert.equal(partial.barTone, 'gold')

  const complete = formatRootEnrichmentHeadline(
    { ...emptyRoot, totalAlbums: 10, coveredAlbums: 10, coveragePercent: 100 },
    'idle',
  )
  assert.equal(complete.headline, 'Auto-Enrich 100% (10/10 albums)')
  assert.equal(complete.showArtPercent, true)
  assert.equal(complete.barPercent, 100)
  assert.equal(complete.barTone, 'emerald')
})

test('humanizeScanError and formatEngineDisplayName produce clear user-facing storage copy', () => {
  assert.equal(
    humanizeScanError('Encountered an invalid timestamp: Timestamp segment is too short').summary,
    'Malformed date/timestamp tag in audio file',
  )
  assert.equal(
    humanizeScanError('Wav: File does not contain a "data" chunk').summary,
    'Corrupt or incomplete WAV file (missing PCM audio data chunk) — skipped',
  )
  assert.equal(
    humanizeScanError('Symlinks are not authorized').summary,
    'Symbolic link skipped for security',
  )
  assert.deepEqual(humanizeScanError('Permission denied'), {
    summary: 'Permission denied',
    detail: '',
  })

  assert.equal(
    formatEngineDisplayName(
      '//192.168.1.6/Mathan/Music Collection/Master/Tamil',
      '//192.168.1.6/Mathan/Music Collection/Master/Tamil',
      [],
    ),
    'Tamil',
  )
})
