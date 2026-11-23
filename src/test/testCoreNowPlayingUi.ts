import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { createElement } from 'react'

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      return { format: 'module', shortCircuit: true, source: 'export default {}' }
    }
    return nextLoad(url, context)
  },
})
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CORE_PROTOCOL_VERSION,
  type CoreCatalogTrack,
  type CoreRequest,
  type CoreSnapshot,
} from '../core/coreProtocol'
import type { AuthenticatedCoreChannel } from '../services/engineService'

// Ensure SSR globals exist before importing UI modules
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
    location: { href: 'http://localhost:5173', search: '', pathname: '/' },
    localStorage: storage,
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    __TAURI_INTERNALS__: undefined,
  }
  ;(globalThis as Record<string, unknown>).document = {
    getElementById: () => ({ innerHTML: '', appendChild: () => {} }),
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {}, classList: { add: () => {}, remove: () => {} } },
  }
  ;(globalThis as Record<string, unknown>).localStorage = storage
}

async function createActiveCoreStore() {
  const { createDesktopCoreControllerStore } = await import('../services/coreControllerTransport')
  const tracks: CoreCatalogTrack[] = [
    {
      id: 'trk_1',
      title: 'Patakha Guddi (Female Version)',
      artist: 'Sultana Nooran & Jyoti Nooran',
      album: 'Highway',
      releaseId: 'rel_highway',
      releaseYear: 2014,
      durationSeconds: 287,
      format: 'WAV',
      sampleRate: 44100,
      bitDepth: 16,
      trackNumber: 1,
      discNumber: 1,
      hasCoverArt: true,
    },
    {
      id: 'trk_2',
      title: 'Kahaan Hoon Main',
      artist: 'Jonita Gandhi',
      album: 'Highway',
      releaseId: 'rel_highway',
      releaseYear: 2014,
      durationSeconds: 329,
      format: 'WAV',
      sampleRate: 44100,
      bitDepth: 16,
      trackNumber: 2,
      discNumber: 1,
      hasCoverArt: true,
    },
    {
      id: 'trk_3',
      title: 'Wanna Mash Up?',
      artist: 'Kash, Krissy & Suvi Suresh',
      album: 'Highway',
      releaseId: 'rel_highway',
      releaseYear: 2014,
      durationSeconds: 222,
      format: 'WAV',
      sampleRate: 44100,
      bitDepth: 16,
      trackNumber: 3,
      discNumber: 1,
      hasCoverArt: true,
    },
  ]

  const snapshot: CoreSnapshot = {
    engineId: 'core_living_room',
    libraryId: 'lib_master',
    revision: 5,
    catalog: {
      revision: 1,
      tracks,
      nextCursor: null,
    },
    queue: {
      entries: [
        { entryId: 'qe_1', trackId: 'trk_1' },
        { entryId: 'qe_2', trackId: 'trk_2' },
        { entryId: 'qe_3', trackId: 'trk_3' },
      ],
      currentEntryId: 'qe_1',
      repeat: 'off',
      shuffle: false,
    },
    playback: {
      activity: 'playing',
      positionSeconds: 42,
      owner: 'core',
    },
    output: {
      id: 'wasapi_odyssey',
      label: 'Odyssey G85SB',
      transport: 'wasapi',
    },
  }

  const channel: AuthenticatedCoreChannel = {
    async verifyPeer() {
      return {
        authenticated: true,
        engineId: 'core_living_room',
        libraryId: 'lib_master',
      }
    },
    async request(req: CoreRequest) {
      if (req.operation === 'core.hello') {
        return {
          ok: true,
          data: {
            protocolVersion: CORE_PROTOCOL_VERSION,
            engineId: 'core_living_room',
            libraryId: 'lib_master',
            label: 'MATHUVI-DTP',
            capabilities: [
              'catalog.read',
              'session.read',
              'playback.control',
              'queue.write',
              'queue.coordinate',
            ],
            ready: true,
          },
        }
      }
      if (req.operation === 'session.snapshot') {
        return { ok: true, data: snapshot }
      }
      if (req.operation === 'catalog.page') {
        return {
          ok: true,
          data: {
            revision: 1,
            tracks,
            nextCursor: null,
          },
        }
      }
      return { ok: true, data: snapshot }
    },
  }

  const store = createDesktopCoreControllerStore({
    channelFactory: () => channel,
    localOwner: {
      getActivity: () => 'idle',
      stopAndAcknowledge: async () => true,
      request: async () => ({ ok: true, data: {} }),
    },
  })

  const staged = await store.stageCandidate({
    engineId: 'core_living_room',
    libraryId: 'lib_master',
    label: 'MATHUVI-DTP',
    baseUrl: 'https://127.0.0.1:4040',
    musicRoots: ['/music'],
  })
  assert.equal(staged.ok, true, staged.ok ? '' : staged.error)
  assert.equal(await store.activateStagedCore(), 'activated')
  return store
}

test('Issue #54: Core Engine mode renders Left Rail artwork dock, Sanctuary Now Playing, Queue badge count, and safe Up Next artwork', async () => {
  const store = await createActiveCoreStore()
  const { AudioPlayerProvider } = await import('../context/AudioPlayerContext')
  const { EngineControllerProvider, mapCoreCatalogToUi } = await import('../context/EngineControllerContext')
  const { LeftRail } = await import('../components/LeftRail/LeftRail')
  const { SanctuaryListeningLounge } = await import('../components/AudioPlayer/SanctuaryListeningLounge')
  const { NowPlayingBar } = await import('../components/AudioPlayer/NowPlayingBar')
  const { UnifiedRightSidebar } = await import('../components/RightPanel/UnifiedRightSidebar')

  const snap = store.getState().view.snapshot!
  const { tracks, releases } = mapCoreCatalogToUi(snap.catalog.tracks)

  const wrap = (child: React.ReactElement) =>
    createElement(
      AudioPlayerProvider,
      null,
      createElement(EngineControllerProvider, { storeOverride: store }, child),
    )

  // 1. Left Rail renders bottom-left artwork dock trigger for the Core playing track
  const leftRailHtml = renderToStaticMarkup(
    wrap(
      createElement(LeftRail, {
        facets: { formats: [], eras: [], genres: [], labels: [], roles: [] },
        onFacetChange: () => {},
        onResetFacets: () => {},
        storageMounts: [],
        tracks,
        releases,
        isArtworkDockExpanded: true,
        onOpenSanctuary: () => {},
      }),
    ),
  )
  assert.match(leftRailHtml, /Open Now Playing for Patakha Guddi \(Female Version\)/)
  assert.doesNotMatch(leftRailHtml, /src="cadence-art:\/\//)

  // 2. SanctuaryListeningLounge renders active Core track, release, elapsed time, and connected output
  const sanctuaryHtml = renderToStaticMarkup(
    wrap(
      createElement(SanctuaryListeningLounge, {
        isOpen: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(sanctuaryHtml, /Patakha Guddi \(Female Version\)/)
  assert.match(sanctuaryHtml, /Sultana Nooran &amp; Jyoti Nooran/)
  assert.match(sanctuaryHtml, /Highway \(2014\)/)
  assert.match(sanctuaryHtml, /WAV · 44\.1 kHz · 16-bit/)
  assert.match(sanctuaryHtml, /00:42/)
  assert.match(sanctuaryHtml, /04:47/)
  assert.match(sanctuaryHtml, /Odyssey G85SB/)
  assert.doesNotMatch(sanctuaryHtml, /No Track Selected/)
  assert.doesNotMatch(sanctuaryHtml, /Output Unavailable/)
  assert.doesNotMatch(sanctuaryHtml, /src="cadence-art:\/\//)

  // 3. NowPlayingBar renders the green Queue badge count matching Core upcoming entries (2)
  const barHtml = renderToStaticMarkup(
    wrap(
      createElement(NowPlayingBar, {
        onOpenSanctuary: () => {},
        isArtworkDockExpanded: true,
      }),
    ),
  )
  assert.match(barHtml, /Now Playing Queue \(⌘U \/ Q\) • 2 upcoming/)
  assert.match(barHtml, />2<\/span>/)

  // 4. UnifiedRightSidebar Up Next rows use EngineArtworkImg instead of raw cadence-art:// <img> URLs
  const sidebarHtml = renderToStaticMarkup(
    wrap(
      createElement(UnifiedRightSidebar, {
        allReleases: releases,
        onOpenCreatePlaylist: () => {},
        onOpenEditPlaylist: () => {},
        onOpenAddTracksModal: () => {},
      }),
    ),
  )
  assert.match(sidebarHtml, /Up Next.*\(2\)/)
  assert.match(sidebarHtml, /Kahaan Hoon Main/)
  assert.match(sidebarHtml, /Wanna Mash Up\?/)
  assert.doesNotMatch(sidebarHtml, /src="cadence-art:\/\//)

  store.dispose()
})
