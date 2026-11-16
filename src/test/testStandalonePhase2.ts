import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CORE_PROTOCOL_VERSION_V2,
  parseCoreCatalogPage,
  parseCoreV2Descriptor,
} from '../core/coreProtocol'
import { deriveCanonicalArtistsFromCatalog } from '../core/libraryProjection'
import {
  createEngineArtworkCache,
  createEngineClient,
  stripCoreReleasePrefix,
} from '../services/engineClient'
import { submitCurateItemsToEngine } from '../services/engineCurateBridge'
import type { SavedCoreProfile } from '../services/coreControllerTransport'

const profile: SavedCoreProfile = {
  engineId: 'core_nas_01',
  libraryId: 'lib_master_01',
  label: 'Music Room Core',
  baseUrl: 'https://192.168.1.6:4040',
  pairingToken: 'tok-secret',
  certFingerprint: '0123'.repeat(16),
  musicRoots: ['/music'],
}

test('Phase 2: parseCoreV2Descriptor & enriched CatalogTrack v2 fields', () => {
  const desc = parseCoreV2Descriptor(
    {
      protocolVersion: CORE_PROTOCOL_VERSION_V2,
      engineId: profile.engineId,
      libraryId: profile.libraryId,
      label: profile.label,
      capabilities: [
        'catalog.read',
        'session.read',
        'playback.control',
        'queue.write',
        'fs.browse',
        'folders.manage',
        'playlists.manage',
        'artwork.read',
        'curate.write',
      ],
      ready: true,
    },
    { kind: 'core', engineId: profile.engineId, libraryId: profile.libraryId, label: profile.label },
  )
  assert.equal(desc.protocolVersion, 2)

  const page = parseCoreCatalogPage({
    revision: 7,
    nextCursor: null,
    tracks: [
      {
        id: 'trk_dsd_1',
        title: 'Thillana',
        artist: 'Ilaiyaraaja',
        album: 'Master Tamil DSD',
        durationSeconds: 312.5,
        releaseId: 'rel_dsd_1',
        format: 'DSF',
        sampleRate: 2_822_400,
        bitDepth: 1,
        composerName: 'Ilaiyaraaja',
        genreTags: ['Soundtrack'],
        folderName: 'Master/Tamil/Thillana',
        language: null,
        dynamicRange: null,
        hasCoverArt: true,
        provenanceStatus: 'PENDING',
        lyrics: null,
        fingerprintStatus: 'UNSUPPORTED_DSD',
      },
    ],
  })
  assert.equal(page.tracks[0].fingerprintStatus, 'UNSUPPORTED_DSD')
  assert.equal(page.tracks[0].hasCoverArt, true)
  assert.equal(page.tracks[0].composerName, 'Ilaiyaraaja')
})

test('Phase 2: EngineClient invokes v2 fs.browse, folders, playlists, split, and curate endpoints', async () => {
  const calls: Array<{ op: string; body: Record<string, unknown> }> = []
  const client = createEngineClient(profile, async (_target, body) => {
    const op = String(body.operation)
    calls.push({ op, body })
    switch (op) {
      case 'fs.browse':
        return {
          ok: true,
          data: {
            entries: [
              { name: 'Tamil', path: '/music/rajafans/Master/Tamil', isDir: true, readable: true, isWatched: false },
            ],
            cached: false,
          },
        }
      case 'folders.add':
        return { ok: true, data: { id: 'folder_1' } }
      case 'folders.scan':
        return { ok: true, data: { status: 'queued', folderId: 'folder_1', processed: 0 } }
      case 'playlists.create':
        return { ok: true, data: { id: 'pl_1', title: 'DSD Evening', description: null, trackIds: [] } }
      case 'playlists.setTracks':
        return { ok: true, data: { id: 'pl_1', title: 'DSD Evening', description: null, trackIds: body.trackIds } }
      case 'releases.split.toggle':
        assert.equal(body.releaseId, 'rel_123')
        return { ok: true, data: { split: true } }
      default:
        return { ok: true, data: {} }
    }
  })

  const browse = await client.fsBrowse('/music/rajafans/Master')
  assert.equal(browse.entries[0].path, '/music/rajafans/Master/Tamil')
  const added = await client.addFolder({ path: '/music/rajafans/Master/Tamil', scanMode: 'manual' })
  assert.equal(added.id, 'folder_1')
  const scan = await client.scanFolders({ folderId: added.id, forceFull: false })
  assert.equal(scan.status, 'queued')
  const pl = await client.createPlaylist('DSD Evening')
  await client.setPlaylistTracks(pl.id, ['trk_dsd_1'])
  const split = await client.toggleSplitRelease('core_rel_rel_123')
  assert.equal(split.split, true)
  assert.equal(stripCoreReleasePrefix('core_rel_rel_123'), 'rel_123')
  assert.deepEqual(
    calls.map((c) => c.op),
    ['fs.browse', 'folders.add', 'folders.scan', 'playlists.create', 'playlists.setTracks', 'releases.split.toggle'],
  )
})

test('Phase 2: EngineArtworkCache caps concurrency at 2 and avoids caching 503 deferred_until_idle', async () => {
  let active = 0
  let maxObserved = 0
  let calls = 0
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  let urlSeq = 0
  const revoked: string[] = []
  URL.createObjectURL = () => `blob:mock-${++urlSeq}`
  URL.revokeObjectURL = (u: string) => {
    revoked.push(u)
  }

  try {
    const cache = createEngineArtworkCache({
      maxEntries: 2,
      maxConcurrent: 2,
      fetchArtwork: async (_target, releaseId) => {
        calls++
        active++
        maxObserved = Math.max(maxObserved, active)
        await new Promise((r) => setTimeout(r, 15))
        active--
        if (releaseId === 'rel_busy') {
          return { status: 503, etag: null, contentType: 'application/json', base64: null }
        }
        return {
          status: 200,
          etag: `"art_${releaseId}"`,
          contentType: 'image/jpeg',
          base64: null,
          bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        }
      },
    })

    const [a, b, c, busy] = await Promise.all([
      cache.getOrFetch(profile, 'core_rel_rel_1', 1),
      cache.getOrFetch(profile, 'core_rel_rel_2', 1),
      cache.getOrFetch(profile, 'core_rel_rel_3', 1),
      cache.getOrFetch(profile, 'core_rel_rel_busy', 1),
    ])

    assert.equal(maxObserved <= 2, true)
    assert.equal(busy, null)
    assert.ok(a && b && c)
    // maxEntries=2 evicted the oldest ObjectURL
    assert.equal(revoked.length, 1)
    assert.equal(calls, 4)

    // 503 was not cached as permanent miss, so retrying when idle succeeds
    const callsBeforeRetry = calls
    await cache.getOrFetch(profile, 'core_rel_rel_busy', 1)
    assert.equal(calls, callsBeforeRetry + 1)
  } finally {
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  }
})

test('Phase 2: submitCurateItemsToEngine surfaces read-only dry-run blocks without approving', async () => {
  const ops: string[] = []
  const client = createEngineClient(profile, async (_target, body) => {
    const op = String(body.operation)
    ops.push(op)
    if (op === 'curate.draft.list') return { ok: true, data: { drafts: [] } }
    if (op === 'curate.draft.save') {
      assert.ok(body.draft && typeof body.draft === 'object')
      return {
        ok: true,
        data: {
          draftId: (body.draft as { draftId: string }).draftId,
          trackId: 'trk_1',
          revision: 1,
          changes: (body.draft as { changes: unknown[] }).changes,
          status: 'draft_saved',
          approvalHash: null,
          readOnlyBlockedReason: null,
        },
      }
    }
    if (op === 'curate.dry_run') {
      return {
        ok: true,
        data: {
          draftId: 'curate_trk_1',
          draftRevision: 1,
          trackId: 'trk_1',
          approvalHash: 'hash_1',
          readOnly: true,
          applyAvailable: false,
          blockReason: 'Read-only media root',
          fileSha256: 'abc',
          fileSizeBytes: 100,
          changes: [],
        },
      }
    }
    throw new Error(`Unexpected op: ${op}`)
  })

  const res = await submitCurateItemsToEngine({
    engineClient: client,
    items: [
      {
        trackId: 'trk_1',
        payloadJson: JSON.stringify({ composer: 'Ilaiyaraaja' }),
      },
    ],
    tracks: [
      {
        id: 'trk_1',
        releaseId: 'rel_1',
        recordingId: 'trk_1',
        trackNumber: 1,
        discNumber: 1,
        title: 'Song',
        artistCredit: 'Artist',
        durationSeconds: 180,
        filePath: 'trk_1',
        fileSize: 0,
        storageMountId: 'core',
        sidecarStatus: 'synced',
        modifiedTimestamp: '2026-11-16T00:00:00Z',
        checksumValid: true,
        accurateRipConfidence: 0,
        sampleRateStr: '44.1 kHz',
        format: 'FLAC',
        credits: [],
        masterReleaseId: 'rel_1',
      },
    ],
    releases: [],
  })

  assert.equal(res.submittedJobs.length, 0)
  assert.deepEqual(res.blockedReasons, ['Read-only media root'])
  assert.deepEqual(ops, ['curate.draft.list', 'curate.draft.save', 'curate.dry_run'])
})

test('Phase 2: deriveCanonicalArtistsFromCatalog works purely in-memory', () => {
  const artists = deriveCanonicalArtistsFromCatalog(
    [
      {
        id: 'core_rel_1',
        masterReleaseId: 'core_rel_1',
        title: 'Mouna Raagam',
        folderName: 'Mouna Raagam',
        folderPath: '',
        artistCredit: 'S. Janaki',
        composerName: 'Ilaiyaraaja',
        releaseYear: 1986,
        originalYear: 1986,
        label: 'Echo',
        catalogNumber: '',
        mediaFormat: 'Digital',
        country: '',
        matrixRunout: '',
        artwork: {
          frontCoverUrl: '',
          resolution: '0x0',
          width: 0,
          height: 0,
          dpi: 72,
          colorProfile: 'sRGB',
          isLowRes: false,
          hasBookletPdf: false,
        },
        variants: [],
        discsCount: 1,
        tracksCount: 1,
        genreTags: ['Soundtrack'],
        storageMountId: 'core',
      },
    ],
    [],
  )
  assert.ok(artists.some((a) => a.name === 'Ilaiyaraaja' && a.roles.includes('Composer')))
  assert.ok(artists.some((a) => a.name === 'S. Janaki'))
})
