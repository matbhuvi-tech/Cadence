import assert from 'node:assert/strict'
import { test  } from 'vitest'
import {
  cleanCommitSummary,
  evaluateEngineCompatibility,
  formatBuildDisplay,
  formatShortBuildDate,
  type CoreBuildInfo,
} from '../core/buildInfo'
import {
  CORE_PROTOCOL_V2_REVISION,
  CORE_PROTOCOL_VERSION,
  CORE_PROTOCOL_VERSION_V2,
  CoreServiceError,
  parseCoreCatalogPage,
  parseCoreV2CatalogPage,
  parseCoreV2Descriptor,
  type CoreRequest,
} from '../core/coreProtocol'
import { createDesktopCoreControllerStore } from '../services/coreControllerTransport'
import type { AuthenticatedCoreChannel } from '../services/engineService'

const sampleBuild = (overrides: Partial<CoreBuildInfo> = {}): CoreBuildInfo => ({
  tag: 'v0.1.0-rc.2',
  commitsSinceTag: 38,
  commitSha: '8dfc87c',
  commitDate: '2026-11-20',
  commitSummary: 'curate: automated enrichment engine',
  dirty: false,
  display: 'v0.1.0-rc.2 +38 · Nov 20',
  ...overrides,
})

test('formatBuildDisplay & formatShortBuildDate format release tags, commits ahead, single-digit days, dirty and fallback', () => {
  assert.equal(formatShortBuildDate('2026-11-19'), 'Nov 19')
  assert.equal(formatShortBuildDate('2026-11-05'), 'Nov 5')
  assert.equal(formatShortBuildDate('invalid'), null)

  assert.equal(
    formatBuildDisplay({
      tag: 'v0.1.0-rc.2',
      commitsSinceTag: 0,
      commitDate: '2026-11-18',
      commitSha: '4b2d225',
      dirty: false,
    }),
    'v0.1.0-rc.2',
  )
  assert.equal(
    formatBuildDisplay({
      tag: 'v0.1.0-rc.2',
      commitsSinceTag: 0,
      commitDate: '2026-11-18',
      commitSha: '4b2d225',
      dirty: true,
    }),
    'v0.1.0-rc.2 · local',
  )
  assert.equal(
    formatBuildDisplay({
      tag: 'v0.1.0-rc.2',
      commitsSinceTag: 37,
      commitDate: '2026-11-19',
      commitSha: '66aace7',
      dirty: false,
    }),
    'v0.1.0-rc.2 +37 · Nov 19',
  )
  assert.equal(
    formatBuildDisplay({
      tag: 'v0.1.0-rc.2',
      commitsSinceTag: 5,
      commitDate: '2026-11-05',
      commitSha: '1234567',
      dirty: false,
    }),
    'v0.1.0-rc.2 +5 · Nov 5',
  )
  assert.equal(
    formatBuildDisplay({
      tag: 'v0.1.0-rc.2',
      commitsSinceTag: 38,
      commitDate: '2026-11-20',
      commitSha: '8dfc87c',
      dirty: true,
    }),
    'v0.1.0-rc.2 +38 · Nov 20 · local',
  )
  assert.equal(
    formatBuildDisplay({
      tag: '',
      commitsSinceTag: 0,
      commitDate: '2026-11-20',
      commitSha: '8dfc87c',
      dirty: false,
      pkgVersion: '0.1.0',
    }),
    'v0.1.0 (8dfc87c · Nov 20)',
  )
})

test('cleanCommitSummary formats scoped, unscoped, and long conventional commits', () => {
  assert.equal(
    cleanCommitSummary(
      'feat(curate): automated enrichment engine, unified 2-button workflow, and #49 SMB commit fixes',
    ),
    'curate: automated enrichment engine',
  )
  assert.equal(
    cleanCommitSummary('fix(artwork): restore missing album art'),
    'artwork: restore missing album art',
  )
  assert.equal(
    cleanCommitSummary('fix: recover paired Windows playback engine'),
    'recover paired Windows playback engine',
  )
  const longText =
    'feat(engine): implement deterministic high resolution streaming buffer pacing logic without any commas for truncation check'
  const cleaned = cleanCommitSummary(longText)
  assert.ok(cleaned.length <= 64)
  assert.ok(cleaned.endsWith('…'))
})

test('parseCoreV2CatalogPage ignores unknown additive fields, enforces types, and blocks forbidden keys', () => {
  const validTrack = {
    id: 'trk_1',
    title: 'Track One',
    artist: 'Artist One',
    album: 'Album One',
    durationSeconds: 210,
    releaseId: 'rel_1',
    hasCoverArt: true,
    folderPath: '//192.168.1.6/music/Album',
    fileName: '01 Track.flac',
    futureField: 'hello',
    futureNumeric: 42,
  }

  // Strict v1 rejects futureField
  assert.throws(
    () =>
      parseCoreCatalogPage({
        revision: 1,
        nextCursor: null,
        tracks: [validTrack],
      }),
    CoreServiceError,
  )

  // Forward-compatible v2 accepts & strips futureField/futureNumeric while preserving known fields
  const parsed = parseCoreV2CatalogPage({
    revision: 1,
    nextCursor: null,
    futurePageMeta: { extra: true },
    tracks: [validTrack],
  })
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.tracks[0].hasCoverArt, true)
  assert.equal(parsed.tracks[0].folderPath, '//192.168.1.6/music/Album')
  assert.equal('futureField' in parsed.tracks[0], false)
  assert.equal('futureNumeric' in parsed.tracks[0], false)

  // Forbidden wire keys are always rejected on page and track
  for (const forbidden of ['filePath', 'sql', 'password', 'token']) {
    assert.throws(
      () =>
        parseCoreV2CatalogPage({
          revision: 1,
          nextCursor: null,
          tracks: [{ ...validTrack, [forbidden]: 'bad' }],
        }),
      CoreServiceError,
    )
  }

  // Invalid known field type is still rejected
  assert.throws(
    () =>
      parseCoreV2CatalogPage({
        revision: 1,
        nextCursor: null,
        tracks: [{ ...validTrack, hasCoverArt: 'yes' }],
      }),
    CoreServiceError,
  )
})

test('parseCoreV2Descriptor accepts build & protocolRevision, strips unknown keys, and blocks forbidden keys', () => {
  const context = {
    kind: 'core',
    engineId: 'core_1',
    libraryId: 'lib_1',
    label: 'Music Room Core',
  } as const
  const build = sampleBuild()

  const desc = parseCoreV2Descriptor(
    {
      protocolVersion: CORE_PROTOCOL_VERSION_V2,
      protocolRevision: CORE_PROTOCOL_V2_REVISION,
      build,
      engineId: context.engineId,
      libraryId: context.libraryId,
      label: context.label,
      capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
      ready: true,
      futureDescriptorKey: 'ignored',
    },
    context,
  )
  assert.equal(desc.protocolVersion, 2)
  assert.equal(desc.protocolRevision, CORE_PROTOCOL_V2_REVISION)
  assert.equal(desc.build?.display, build.display)
  assert.equal('futureDescriptorKey' in desc, false)

  for (const forbidden of ['filePath', 'sql', 'password', 'token']) {
    assert.throws(
      () =>
        parseCoreV2Descriptor(
          {
            protocolVersion: CORE_PROTOCOL_VERSION_V2,
            engineId: context.engineId,
            libraryId: context.libraryId,
            label: context.label,
            capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
            ready: true,
            [forbidden]: 'leak',
          },
          context,
        ),
      CoreServiceError,
    )
  }
})

test('evaluateEngineCompatibility covers all 5 compatibility outcomes', () => {
  const coreBuild = sampleBuild({ commitsSinceTag: 38, commitSha: '8dfc87c', display: 'v0.1.0-rc.2 +38 · Nov 20' })

  // 1. v2_catalog_degraded
  const degraded = evaluateEngineCompatibility({
    coreBuild,
    coreProtocolRevision: 2,
    engineBuild: sampleBuild({ commitsSinceTag: 37, commitSha: '66aace7', display: 'v0.1.0-rc.2 +37 · Nov 19' }),
    engineProtocolVersion: 2,
    engineProtocolRevision: 2,
    v2CatalogDegraded: true,
  })
  assert.equal(degraded?.severity, 'warning')
  assert.equal(degraded?.reason, 'v2_catalog_degraded')

  // 2. core_older
  const coreOlder = evaluateEngineCompatibility({
    coreBuild,
    coreProtocolRevision: 2,
    engineBuild: sampleBuild({ commitsSinceTag: 42, commitSha: 'aaaa111', display: 'v0.1.0-rc.2 +42 · Nov 21' }),
    engineProtocolVersion: 2,
    engineProtocolRevision: 3,
  })
  assert.equal(coreOlder?.severity, 'warning')
  assert.equal(coreOlder?.reason, 'core_older')

  // 3. engine_older (both explicit lower protocolRevision and legacy unversioned v2 engine)
  const engineOlder = evaluateEngineCompatibility({
    coreBuild,
    coreProtocolRevision: 2,
    engineBuild: sampleBuild({ commitsSinceTag: 30, commitSha: 'bbbb222', display: 'v0.1.0-rc.2 +30 · Nov 17' }),
    engineProtocolVersion: 2,
    engineProtocolRevision: 1,
  })
  assert.equal(engineOlder?.severity, 'warning')
  assert.equal(engineOlder?.reason, 'engine_older')

  const legacyEngine = evaluateEngineCompatibility({
    coreBuild,
    coreProtocolRevision: 2,
    engineBuild: null,
    engineProtocolVersion: 2,
    engineProtocolRevision: null,
  })
  assert.equal(legacyEngine?.severity, 'warning')
  assert.equal(legacyEngine?.reason, 'engine_older')

  // 4. build_mismatch (same protocolRevision, different SHA)
  const mismatch = evaluateEngineCompatibility({
    coreBuild,
    coreProtocolRevision: 2,
    engineBuild: sampleBuild({ commitsSinceTag: 39, commitSha: 'cccc333', display: 'v0.1.0-rc.2 +39 · Nov 20' }),
    engineProtocolVersion: 2,
    engineProtocolRevision: 2,
  })
  assert.equal(mismatch?.severity, 'info')
  assert.equal(mismatch?.reason, 'build_mismatch')

  // 5. matched -> null
  const matched = evaluateEngineCompatibility({
    coreBuild,
    coreProtocolRevision: 2,
    engineBuild: sampleBuild({ commitsSinceTag: 38, commitSha: '8dfc87c', display: 'v0.1.0-rc.2 +38 · Nov 20' }),
    engineProtocolVersion: 2,
    engineProtocolRevision: 2,
  })
  assert.equal(matched, null)
})

function createControllerFixture(opts: {
  engineBuild?: CoreBuildInfo | null
  protocolRevision?: number
  catalogPageOverride?: unknown
  includeFutureTrackField?: boolean
}) {
  const engineId = 'core_test_01'
  const libraryId = 'lib_test_01'
  const label = 'Test Playback Engine'
  const profile = {
    engineId,
    libraryId,
    label,
    baseUrl: 'https://127.0.0.1:4040',
    musicRoots: ['/music'],
  }
  const baseTrack = {
    id: 'trk_art_1',
    title: 'Cover Track',
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 180,
  }
  const v2Track = {
    ...baseTrack,
    releaseId: 'rel_art_1',
    hasCoverArt: true,
    ...(opts.includeFutureTrackField ? { futureAdditiveTag: 'future-ok' } : {}),
  }
  const snapshot = {
    engineId,
    libraryId,
    revision: 1,
    catalog: {
      revision: 1,
      tracks: [baseTrack],
      nextCursor: null,
    },
    queue: { entries: [], currentEntryId: null, repeat: 'off', shuffle: false },
    playback: { activity: 'idle', positionSeconds: 0 },
    output: { id: 'out_1', label: 'RS130', transport: 'upnp' },
  }
  const capabilities = ['catalog.read', 'session.read', 'playback.control', 'queue.write']

  const channel: AuthenticatedCoreChannel = {
    async verifyPeer() {
      return { authenticated: true, engineId, libraryId }
    },
    async request(req: CoreRequest) {
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          data: {
            protocolVersion: CORE_PROTOCOL_VERSION,
            engineId,
            libraryId,
            label,
            capabilities,
            ready: true,
          },
        }
      }
      if (req.operation === 'session.snapshot') {
        return { ok: true, data: snapshot }
      }
      return { ok: true, data: snapshot.catalog }
    },
  }

  const store = createDesktopCoreControllerStore({
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
    channelFactory: () => channel,
    httpBridge: {
      async probeHealth() {
        return {
          ready: true,
          engineId,
          libraryId,
          label,
          protocolVersion: 2,
          ...(opts.protocolRevision !== undefined ? { protocolRevision: opts.protocolRevision } : {}),
          ...(opts.engineBuild ? { build: opts.engineBuild } : {}),
          musicReadOnly: false,
        }
      },
      async postCoreRequest(_target, body) {
        if (body.operation === 'core.hello') {
          return {
            ok: true,
            data: {
              protocolVersion: CORE_PROTOCOL_VERSION_V2,
              ...(opts.protocolRevision !== undefined ? { protocolRevision: opts.protocolRevision } : {}),
              ...(opts.engineBuild ? { build: opts.engineBuild } : {}),
              engineId,
              libraryId,
              label,
              capabilities,
              ready: true,
            },
          }
        }
        if (body.operation === 'catalog.page') {
          if (opts.catalogPageOverride !== undefined) {
            return { ok: true, data: opts.catalogPageOverride }
          }
          return {
            ok: true,
            data: {
              revision: 1,
              nextCursor: null,
              tracks: [v2Track],
            },
          }
        }
        return { ok: true, data: {} }
      },
    },
  })

  return { store, profile }
}

test('createDesktopCoreControllerStore surfaces v2_catalog_degraded warning when v2 catalog hydration fails', async () => {
  const engineBuild = sampleBuild({
    commitsSinceTag: 39,
    commitSha: '999aaaa',
    display: 'v0.1.0-rc.2 +39 · Nov 20',
  })
  const { store, profile } = createControllerFixture({
    engineBuild,
    protocolRevision: CORE_PROTOCOL_V2_REVISION,
    // Malformed v2 catalog response containing a forbidden wire key triggers parse failure
    catalogPageOverride: {
      revision: 1,
      nextCursor: null,
      tracks: [
        {
          id: 'trk_art_1',
          title: 'Cover Track',
          artist: 'Artist',
          album: 'Album',
          durationSeconds: 180,
          filePath: '/secret/path.flac',
        },
      ],
    },
  })

  try {
    const outcome = await store.switchToSavedCore(profile)
    assert.equal(outcome, 'activated')
    const state = store.getState()
    assert.equal(state.activeEngineBuild?.display, engineBuild.display)
    assert.equal(state.catalogHealth?.status, 'degraded')
    assert.equal(state.catalogHealth?.cause, 'invalid_metadata')
    assert.ok(state.catalogHealth?.reason && state.catalogHealth.reason.length > 0)
    assert.equal(/protocol v2|hydration|invalid_payload|\bv1\b/i.test(state.catalogHealth?.reason ?? ''), false)
    assert.equal(state.compatibilityWarning?.severity, 'warning')
    assert.equal(state.compatibilityWarning?.reason, 'v2_catalog_degraded')
    assert.equal(state.hydratedCatalogTracks.length, 1)
    assert.equal(state.hydratedCatalogTracks[0].hasCoverArt, undefined)
  } finally {
    store.dispose()
  }
})

test('createDesktopCoreControllerStore hydrates additive v2 tracks with hasCoverArt intact and populates health build on stage & activate', async () => {
  const engineBuild = sampleBuild({
    commitsSinceTag: 38,
    commitSha: '8dfc87c',
    display: 'v0.1.0-rc.2 +38 · Nov 20',
  })
  const { store, profile } = createControllerFixture({
    engineBuild,
    protocolRevision: CORE_PROTOCOL_V2_REVISION,
    includeFutureTrackField: true,
  })

  try {
    const staged = await store.stageCandidate(profile)
    assert.equal(staged.ok, true)
    assert.equal(store.getState().stagedCandidate?.health?.build?.display, engineBuild.display)

    const outcome = await store.activateStagedCore()
    assert.equal(outcome, 'activated')
    const state = store.getState()
    assert.equal(state.activeEngineBuild?.display, engineBuild.display)
    assert.equal(state.catalogHealth?.status, 'healthy')
    assert.equal(state.hydratedCatalogTracks.length, 1)
    assert.equal(state.hydratedCatalogTracks[0].hasCoverArt, true)
    assert.notEqual(state.compatibilityWarning?.severity, 'warning')
  } finally {
    store.dispose()
  }
})

test('parseCoreV2CatalogPage accepts multi-line lyrics and tag whitespace while still rejecting NUL control chars', () => {
  const trackWithLyrics = {
    id: 'trk_lyrics_1',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    album: 'A Night at the Opera',
    durationSeconds: 354,
    releaseId: 'rel_queen_1',
    hasCoverArt: true,
    composerName: 'Freddie Mercury\n(Arr. Queen)',
    genreTags: ['Rock\tClassic'],
    lyrics: 'Is this the real life?\r\nIs this just fantasy?\n\tCaught in a landslide',
  }

  const parsed = parseCoreV2CatalogPage({
    revision: 2,
    nextCursor: null,
    tracks: [trackWithLyrics],
  })
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.tracks[0].lyrics, trackWithLyrics.lyrics)
  assert.equal(parsed.tracks[0].hasCoverArt, true)

  // NUL / non-whitespace control characters remain rejected
  assert.throws(
    () =>
      parseCoreV2CatalogPage({
        revision: 2,
        nextCursor: null,
        tracks: [{ ...trackWithLyrics, lyrics: 'bad\u0000lyrics' }],
      }),
    CoreServiceError,
  )
})
