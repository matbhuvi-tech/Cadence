import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Track, Release } from '../core/types'
import { useAudioPlayer } from './AudioPlayerContext'
import { tauriBridge } from '../services/tauriBridge'
import {
  createAuthenticatedHttpChannel,
  createDesktopCoreControllerStore,
  createFetchHttpCoreBridge,
  probeCoreNodeAddress,
  type CoreCommandInput,
  type CoreControllerState,
  type DesktopCoreControllerStore,
  type DiscoveredCoreNode,
  type HttpCoreTransportBridge,
  type SavedCoreProfile,
  type StorageLike,
} from '../services/coreControllerTransport'
import {
  createBrowserArtworkFetch,
  createEngineArtworkCache,
  createEngineClient,
  stripCoreReleasePrefix,
  type EngineArtworkCache,
  type EngineClient,
} from '../services/engineClient'
import {
  CoreServiceError,
  type CoreCatalogTrack,
  type CoreRequest,
  type CoreSnapshot,
  type EngineEventRecord,
} from '../core/coreProtocol'
import type { EngineActivity } from '../core/engineSession'
import type { AudioEndpoint } from '../core/endpointRouting'

export interface CoreQueueEntryProjection {
  entryId: string
  track: Track
}

export interface EngineControllerContextValue {
  state: CoreControllerState
  isCoreActive: boolean
  isBootstrapping: boolean
  activeCoreSnapshot: CoreSnapshot | null
  engineClient: EngineClient | null
  coreCatalogTracks: Track[]
  coreCatalogReleases: Release[]
  coreNowPlayingTrack: Track | null
  coreQueueEntries: CoreQueueEntryProjection[]
  coreCurrentEntryIndex: number
  coreUpcomingEntries: CoreQueueEntryProjection[]
  probeAndStageAddress: (input: {
    baseUrl: string
    label?: string
    pairingToken?: string
    certFingerprint?: string
    trustInsecure?: boolean
    musicRoots?: string[]
  }) => Promise<{ ok: boolean; error?: string }>
  stageSavedProfile: (profile: SavedCoreProfile) => Promise<{ ok: boolean; error?: string }>
  discoverCores: () => Promise<DiscoveredCoreNode[]>
  updateStagedMusicRoots: (roots: string[]) => void
  cancelStaging: () => void
  activateStagedCore: () => Promise<void>
  switchToSavedCore: (profile: SavedCoreProfile) => Promise<void>
  confirmLocalToCoreSwitch: () => Promise<void>
  requestSwitchToLocal: () => Promise<void>
  confirmLeaveCore: (disposition: 'leave_core_playing' | 'stop_before_switch') => Promise<void>
  dismissSwitchPrompt: () => void
  reconnectCore: () => Promise<void>
  removeSavedCore: (engineId: string, libraryId: string) => void
  corePlayTrack: (trackId: string, queueTrackIds?: string[]) => Promise<void>
  coreTogglePlayPause: () => Promise<void>
  coreStop: () => Promise<void>
  coreNextTrack: () => Promise<void>
  corePrevTrack: () => Promise<void>
  coreSeek: (seconds: number) => Promise<void>
  coreJumpToEntry: (entryId: string) => Promise<void>
  coreRemoveQueueEntry: (entryId: string) => Promise<void>
  coreClearUpcomingQueue: () => Promise<void>
  coreReorderQueueEntry: (fromIndex: number, toIndex: number) => Promise<void>
  coreSetModes: (repeat: 'off' | 'one' | 'all', shuffle: boolean) => Promise<void>
  coreRefreshSnapshot: () => Promise<CoreSnapshot | null>
  coreRefreshCatalog: () => Promise<void>
  resolveCoreArtworkUrl: (rawReleaseId: string) => Promise<string | null>
  getCachedCoreArtworkUrl: (rawReleaseId: string) => string | null
  subscribeEngineEvents: (listener: (event: EngineEventRecord) => void) => () => void
  selectLocalEndpointWithCoreGuard: (endpoint: AudioEndpoint) => Promise<void>
  confirmRs130Takeover: () => Promise<void>
}

const EngineControllerContext = createContext<EngineControllerContextValue | null>(null)

function createSafeLocalStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return {
      getItem: (k: string) => {
        try {
          return window.localStorage.getItem(k)
        } catch {
          return null
        }
      },
      setItem: (k: string, v: string) => {
        try {
          window.localStorage.setItem(k, v)
        } catch {
          // ignore restricted storage
        }
      },
    }
  } catch {
    return null
  }
}

function createDesktopHttpBridge(): HttpCoreTransportBridge {
  const fetchBridge = createFetchHttpCoreBridge()
  if (!tauriBridge.isTauri()) {
    return fetchBridge
  }
  return {
    async probeHealth(profile) {
      return tauriBridge.coreProbeEndpoint(profile)
    },
    async postCoreRequest(profile, req) {
      return tauriBridge.coreControlRequest(profile, req)
    },
  }
}

function normalizeCoreFormat(rawFormat?: string): Track['format'] {
  const upper = (rawFormat || '').trim().toUpperCase()
  switch (upper) {
    case 'DSD':
    case 'DSF':
    case 'DFF':
      return 'DSD'
    case 'WAV':
    case 'AIFF':
    case 'AIF':
      return 'WAV'
    case 'ALAC':
    case 'M4A':
      return 'ALAC'
    case 'AAC':
      return 'AAC'
    case 'MP3':
    case 'OGG':
      return 'MP3'
    case 'FLAC':
    default:
      return 'FLAC'
  }
}

function formatCoreSampleRateStr(
  format: Track['format'],
  sampleRate?: number,
  bitDepth?: number,
  rawFormat?: string,
): string {
  if (format === 'DSD') {
    if (sampleRate && sampleRate >= 22_000_000) return 'DSD512 (22.6 MHz)'
    if (sampleRate && sampleRate >= 11_000_000) return 'DSD256 (11.3 MHz)'
    if (sampleRate && sampleRate >= 5_500_000) return 'DSD128 (5.6 MHz)'
    if (sampleRate && sampleRate >= 2_700_000) return 'DSD64 (2.8 MHz)'
    return '1-bit DSD'
  }
  const khz = sampleRate ? `${Number((sampleRate / 1000).toFixed(1))} kHz` : ''
  const bits = bitDepth ? `${bitDepth}-bit` : ''
  const combined = [bits, khz].filter(Boolean).join(' / ')
  if (combined) return combined
  return rawFormat ? 'Core Stream' : 'Core Stream'
}

export function mapCoreCatalogToUi(tracks: readonly CoreCatalogTrack[]): {
  tracks: Track[]
  releases: Release[]
} {
  const nowIso = '2026-11-15T00:00:00Z'
  const releaseMap = new Map<string, { release: Release; tracks: Track[] }>()
  const uiTracks: Track[] = []

  tracks.forEach((ct) => {
    const releaseId = ct.releaseId
      ? `core_rel_${ct.releaseId}`
      : `core_rel_${ct.album.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'album'}`
    const existing = releaseMap.get(releaseId)
    const fallbackTrackNo = existing ? existing.tracks.length + 1 : 1
    const format = normalizeCoreFormat(ct.format)
    const sampleRateStr = formatCoreSampleRateStr(format, ct.sampleRate, ct.bitDepth, ct.format)
    const isHighRes =
      format === 'DSD' || (ct.sampleRate ?? 0) > 48_000 || (ct.bitDepth ?? 0) > 16
    const discNumber = ct.discNumber ?? 1
    const releaseYear = ct.releaseYear ?? 0
    const editionLabel = ct.edition?.trim() || ''
    const displayAlbumTitle =
      editionLabel && !ct.album.toLowerCase().includes(editionLabel.toLowerCase())
        ? `${ct.album} (${editionLabel})`
        : ct.album
    const displayAlbumArtist = ct.isCompilation
      ? 'Various Artists'
      : ct.albumArtist?.trim() || ct.artist

    const uiTrack: Track = {
      id: ct.id,
      releaseId,
      recordingId: ct.id,
      trackNumber: ct.trackNumber ?? fallbackTrackNo,
      discNumber,
      title: ct.title,
      artistCredit: ct.artist,
      albumArtist: ct.albumArtist,
      composerName: ct.composerName ?? undefined,
      genre: ct.genreTags?.[0],
      folderName: ct.folderName ?? undefined,
      language: ct.language ?? undefined,
      drScore: ct.dynamicRange ?? undefined,
      lyrics: ct.lyrics ?? undefined,
      hasEmbeddedArt: ct.hasCoverArt,
      fingerprintStatus: ct.fingerprintStatus ?? undefined,
      provenanceStatus: ct.provenanceStatus ?? undefined,
      canonicalReleaseYear: ct.releaseYear,
      durationSeconds: ct.durationSeconds,
      duration: ct.durationSeconds,
      filePath: ct.id,
      fileSize: 0,
      storageMountId: 'core',
      sidecarStatus: 'synced',
      modifiedTimestamp: nowIso,
      checksumValid: true,
      accurateRipConfidence: 0,
      sampleRateStr,
      format,
      sampleRate: ct.sampleRate,
      bitDepth: ct.bitDepth,
      isHighRes,
      credits: [],
      masterReleaseId: releaseId,
      isOnline: true,
      albumTitle: displayAlbumTitle,
      releaseTitle: displayAlbumTitle,
    }
    uiTracks.push(uiTrack)

    const coreArtworkSentinel =
      ct.hasCoverArt && ct.releaseId ? `cadence-art://${ct.releaseId}` : ''

    if (existing) {
      existing.tracks.push(uiTrack)
      existing.release.tracksCount = existing.tracks.length
      if (discNumber > existing.release.discsCount) {
        existing.release.discsCount = discNumber
      }
      if (existing.release.releaseYear === 0 && releaseYear > 0) {
        existing.release.releaseYear = releaseYear
        existing.release.originalYear = releaseYear
      }
      if (!existing.release.composerName && ct.composerName) {
        existing.release.composerName = ct.composerName
      }
      if ((!existing.release.genreTags || existing.release.genreTags.length === 0) && ct.genreTags?.length) {
        existing.release.genreTags = ct.genreTags
      }
      if (!existing.release.artwork.frontCoverUrl && coreArtworkSentinel) {
        existing.release.artwork.frontCoverUrl = coreArtworkSentinel
        existing.release.coverArtUrl = coreArtworkSentinel
      }
      if (ct.isCompilation) {
        existing.release.isCompilation = true
        existing.release.artistCredit = 'Various Artists'
      }
    } else {
      releaseMap.set(releaseId, {
        release: {
          id: releaseId,
          masterReleaseId: releaseId,
          title: displayAlbumTitle,
          folderName: ct.folderName?.trim() || editionLabel || ct.album,
          folderPath: '',
          artistCredit: displayAlbumArtist,
          composerName: ct.composerName ?? undefined,
          releaseYear,
          originalYear: releaseYear,
          label: 'Cadence Core',
          catalogNumber: editionLabel,
          mediaFormat: 'Digital',
          country: '',
          matrixRunout: '',
          coverArtUrl: coreArtworkSentinel || undefined,
          artwork: {
            frontCoverUrl: coreArtworkSentinel,
            resolution: coreArtworkSentinel ? 'Engine Artwork' : '0x0',
            width: 0,
            height: 0,
            dpi: 72,
            colorProfile: 'sRGB',
            isLowRes: false,
            hasBookletPdf: false,
          },
          variants: [],
          discsCount: discNumber,
          tracksCount: 1,
          genreTags: ct.genreTags ?? [],
          storageMountId: 'core',
          isCompilation: Boolean(ct.isCompilation),
        },
        tracks: [uiTrack],
      })
    }
  })

  return {
    tracks: uiTracks,
    releases: Array.from(releaseMap.values()).map((entry) => entry.release),
  }
}

export const EngineControllerProvider: React.FC<{
  children: React.ReactNode
  storeOverride?: DesktopCoreControllerStore
}> = ({ children, storeOverride }) => {
  const { isPlaying, isPaused, stop, selectEndpoint, registerExternalPlaybackDelegate } = useAudioPlayer()

  const activityRef = useRef<EngineActivity>('idle')
  activityRef.current = isPlaying && !isPaused ? 'playing' : isPaused ? 'paused' : 'idle'

  const stopRef = useRef(stop)
  stopRef.current = stop

  const bridgeRef = useRef<HttpCoreTransportBridge | null>(null)
  if (!bridgeRef.current) {
    bridgeRef.current = createDesktopHttpBridge()
  }

  const storeRef = useRef<DesktopCoreControllerStore | null>(storeOverride ?? null)
  if (!storeRef.current) {
    const httpBridge = bridgeRef.current
    storeRef.current = createDesktopCoreControllerStore({
      storage: createSafeLocalStorage(),
      httpBridge,
      channelFactory: (profile) => createAuthenticatedHttpChannel(profile, httpBridge),
      discoverNodes: () => tauriBridge.discoverCoreNodes(),
      localOwner: {
        getActivity: () => activityRef.current,
        stopAndAcknowledge: async () => {
          await stopRef.current()
          activityRef.current = 'idle'
          return true
        },
        request: async (_req: CoreRequest) => ({ ok: true, data: {} }),
      },
    })
  }

  const store = storeRef.current
  const [state, setState] = useState<CoreControllerState>(() => store.getState())
  const [isBootstrapping, setIsBootstrapping] = useState<boolean>(() => !storeOverride)
  const eventListenersRef = useRef(new Set<(event: EngineEventRecord) => void>())
  const artworkCacheRef = useRef<EngineArtworkCache | null>(null)
  if (!artworkCacheRef.current) {
    artworkCacheRef.current = createEngineArtworkCache({
      fetchArtwork: tauriBridge.isTauri()
        ? (target, releaseId, ifNoneMatch) =>
            tauriBridge.coreFetchArtwork(target, releaseId, ifNoneMatch)
        : createBrowserArtworkFetch(),
      maxEntries: 256,
      maxConcurrent: 2,
    })
  }

  useEffect(() => {
    setState(store.getState())
    const unsub = store.subscribe((next) => setState(next))
    return () => {
      unsub()
    }
  }, [store])

  useEffect(() => {
    if (storeOverride) {
      setIsBootstrapping(false)
      return
    }
    let mounted = true
    void store
      .bootstrapStartupConnection()
      .catch(() => {})
      .finally(() => {
        if (mounted) setIsBootstrapping(false)
      })
    return () => {
      mounted = false
    }
  }, [store, storeOverride])

  const isCoreActive = state.view.session.active.kind === 'core'
  const activeCoreSnapshot = isCoreActive ? state.view.snapshot : null
  const activeProfile = isCoreActive ? state.activeProfile : null
  const catalogRevision = activeCoreSnapshot?.catalog.revision ?? 0

  const engineClient = useMemo(() => {
    if (!isCoreActive || !activeProfile || !bridgeRef.current) return null
    const bridge = bridgeRef.current
    return createEngineClient(activeProfile, (target, body) =>
      bridge.postCoreRequest(target, body),
    )
  }, [isCoreActive, activeProfile])

  useEffect(() => {
    if (!isCoreActive || !activeProfile) {
      artworkCacheRef.current?.clear()
      void tauriBridge.coreDisconnectEvents()
      return
    }
    if (!tauriBridge.isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleSseReconnect = () => {
      if (cancelled || reconnectTimer !== null) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (cancelled) return
        void tauriBridge
          .coreConnectEvents(activeProfile, activeProfile.engineId)
          .then(() => {
            if (!cancelled) {
              void store.refreshCatalog().catch(() => {})
            }
          })
          .catch(() => {
            scheduleSseReconnect()
          })
      }, 5000)
    }

    void tauriBridge
      .listenCoreEvents((ev) => {
        if (cancelled || ev.engineId !== activeProfile.engineId) return
        const payload = ev.payload as EngineEventRecord | null
        if (!payload || typeof payload.event !== 'string') return
        if (payload.event === 'catalog.changed') {
          void store.refreshCatalog().catch(() => {})
        } else if (payload.event === 'stream.disconnected') {
          scheduleSseReconnect()
        }
        for (const fn of eventListenersRef.current) {
          try {
            fn(payload)
          } catch {
            // ignore subscriber error
          }
        }
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })

    void tauriBridge
      .coreConnectEvents(activeProfile, activeProfile.engineId)
      .catch(() => {
        scheduleSseReconnect()
      })

    return () => {
      cancelled = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      unlisten?.()
      void tauriBridge.coreDisconnectEvents()
    }
  }, [isCoreActive, activeProfile, store])

  useEffect(() => {
    return () => {
      artworkCacheRef.current?.clear()
    }
  }, [])

  const playIntentRef = useRef(0)

  const commitCoreQueueAndPlayRef = useRef<
    (trackId: string, queueTrackIds?: string[], forceTakeover?: boolean) => Promise<void>
  >(async () => {})

  commitCoreQueueAndPlayRef.current = async (trackId, queueTrackIds, forceTakeover = false) => {
    const intentId = ++playIntentRef.current
    const executeSequence = async (useForceTakeover: boolean) => {
      if (playIntentRef.current !== intentId) return
      const validIds = queueTrackIds && queueTrackIds.length > 0 ? queueTrackIds : null

      if (useForceTakeover) {
        const afterPlay = await store.executeCoreCommand({
          operation: 'playback.control',
          action: 'play',
          trackId,
          forceTakeover: true,
        })
        if (playIntentRef.current !== intentId || !validIds) return
        let preserved = false
        const baseTs = Date.now().toString(36)
        const entries = validIds.map((id, i) => {
          if (!preserved && id === trackId && afterPlay.queue.currentEntryId) {
            preserved = true
            return { entryId: afterPlay.queue.currentEntryId, trackId: id }
          }
          return { entryId: `qe_${baseTs}_${i}`, trackId: id }
        })
        await store.executeCoreCommand({ operation: 'queue.replace', entries })
        return
      }

      if (validIds) {
        const baseTs = Date.now().toString(36)
        const entries = validIds.map((id, i) => ({
          entryId: `qe_${baseTs}_${i}`,
          trackId: id,
        }))
        await store.executeCoreCommand({ operation: 'queue.replace', entries })
        if (playIntentRef.current !== intentId) return
      }

      await store.executeCoreCommand({
        operation: 'playback.control',
        action: 'play',
        trackId,
      })
    }

    if (!forceTakeover && store.getState().view.snapshot?.playback.takeoverRequired) {
      store.requestExternalRs130Takeover(trackId, () =>
        commitCoreQueueAndPlayRef.current(trackId, queueTrackIds, true),
      )
      return
    }

    try {
      await executeSequence(forceTakeover)
    } catch (err) {
      if (err instanceof CoreServiceError && err.code === 'takeover_required') {
        store.requestExternalRs130Takeover(trackId, () =>
          commitCoreQueueAndPlayRef.current(trackId, queueTrackIds, true),
        )
        return
      }
      throw err
    }
  }

  useEffect(() => {
    if (typeof registerExternalPlaybackDelegate !== 'function') return
    if (!isCoreActive) {
      registerExternalPlaybackDelegate(null)
      return
    }
    registerExternalPlaybackDelegate({
      playTrack: async (track, queueContext) => {
        const queueIds =
          queueContext && queueContext.length > 0 ? queueContext.map((t) => t.id) : undefined
        await commitCoreQueueAndPlayRef.current(track.id, queueIds, false)
      },
      addToQueue: async (tracksInput) => {
        const items = Array.isArray(tracksInput) ? tracksInput : [tracksInput]
        if (items.length === 0) return
        const snap = store.getState().view.snapshot
        const baseEntries = snap?.queue.entries ?? []
        const entries = [
          ...baseEntries,
          ...items.map((t, i) => ({
            entryId: `qe_${Date.now().toString(36)}_${i}`,
            trackId: t.id,
          })),
        ]
        await store.executeCoreCommand({ operation: 'queue.replace', entries })
      },
      playNext: async (tracksInput) => {
        const items = Array.isArray(tracksInput) ? tracksInput : [tracksInput]
        if (items.length === 0) return
        const snap = store.getState().view.snapshot
        const baseEntries = snap?.queue.entries ?? []
        const curIdx = baseEntries.findIndex((e) => e.entryId === snap?.queue.currentEntryId)
        const insertIdx = curIdx >= 0 ? curIdx + 1 : 0
        const added = items.map((t, i) => ({
          entryId: `qe_${Date.now().toString(36)}_next_${i}`,
          trackId: t.id,
        }))
        const entries = [
          ...baseEntries.slice(0, insertIdx),
          ...added,
          ...baseEntries.slice(insertIdx),
        ]
        await store.executeCoreCommand({ operation: 'queue.replace', entries })
      },
    })
    return () => {
      registerExternalPlaybackDelegate(null)
    }
  }, [isCoreActive, registerExternalPlaybackDelegate, store])

  const { tracks: coreCatalogTracks, releases: coreCatalogReleases } = useMemo(() => {
    if (!isCoreActive || !activeCoreSnapshot) return { tracks: [], releases: [] }
    const allTracks =
      state.hydratedCatalogTracks.length > activeCoreSnapshot.catalog.tracks.length
        ? state.hydratedCatalogTracks
        : activeCoreSnapshot.catalog.tracks
    return mapCoreCatalogToUi(allTracks)
  }, [isCoreActive, activeCoreSnapshot?.catalog.tracks, state.hydratedCatalogTracks])

  const {
    coreNowPlayingTrack,
    coreQueueEntries,
    coreCurrentEntryIndex,
    coreUpcomingEntries,
  } = useMemo(() => {
    if (!isCoreActive || !activeCoreSnapshot) {
      return {
        coreNowPlayingTrack: null,
        coreQueueEntries: [] as CoreQueueEntryProjection[],
        coreCurrentEntryIndex: -1,
        coreUpcomingEntries: [] as CoreQueueEntryProjection[],
      }
    }
    const trackMap = new Map(coreCatalogTracks.map((t) => [t.id, t]))
    const entries: CoreQueueEntryProjection[] = []
    for (const qe of activeCoreSnapshot.queue.entries) {
      const trk = trackMap.get(qe.trackId)
      if (trk) {
        entries.push({ entryId: qe.entryId, track: trk })
      }
    }
    const curIdx = activeCoreSnapshot.queue.currentEntryId
      ? entries.findIndex((e) => e.entryId === activeCoreSnapshot.queue.currentEntryId)
      : -1
    const nowTrack = curIdx >= 0 ? entries[curIdx].track : null
    const upcoming = curIdx >= 0 ? entries.slice(curIdx + 1) : entries
    return {
      coreNowPlayingTrack: nowTrack,
      coreQueueEntries: entries,
      coreCurrentEntryIndex: curIdx,
      coreUpcomingEntries: upcoming,
    }
  }, [isCoreActive, activeCoreSnapshot?.queue.entries, activeCoreSnapshot?.queue.currentEntryId, coreCatalogTracks])

  const resolveCoreArtworkUrl = useCallback(
    async (rawReleaseId: string): Promise<string | null> => {
      if (!isCoreActive || !activeProfile || !artworkCacheRef.current) return null
      return artworkCacheRef.current.getOrFetch(
        activeProfile,
        stripCoreReleasePrefix(rawReleaseId),
        catalogRevision,
      )
    },
    [isCoreActive, activeProfile, catalogRevision],
  )

  const getCachedCoreArtworkUrl = useCallback(
    (rawReleaseId: string): string | null => {
      if (!isCoreActive || !activeProfile || !artworkCacheRef.current) return null
      return artworkCacheRef.current.getCached(
        activeProfile.engineId,
        stripCoreReleasePrefix(rawReleaseId),
        catalogRevision,
      )
    },
    [isCoreActive, activeProfile, catalogRevision],
  )

  const subscribeEngineEvents = useCallback(
    (listener: (event: EngineEventRecord) => void) => {
      eventListenersRef.current.add(listener)
      return () => {
        eventListenersRef.current.delete(listener)
      }
    },
    [],
  )

  const value = useMemo<EngineControllerContextValue>(() => {
    const exec = async (cmd: CoreCommandInput) => {
      await store.executeCoreCommand(cmd)
    }

    return {
      state,
      isCoreActive,
      isBootstrapping,
      activeCoreSnapshot,
      engineClient,
      coreCatalogTracks,
      coreCatalogReleases,
      coreNowPlayingTrack,
      coreQueueEntries,
      coreCurrentEntryIndex,
      coreUpcomingEntries,
      async probeAndStageAddress(input) {
        try {
          const { profile } = await probeCoreNodeAddress(
            input.baseUrl,
            {
              label: input.label,
              pairingToken: input.pairingToken,
              certFingerprint: input.certFingerprint,
              trustInsecure: input.trustInsecure,
              musicRoots: input.musicRoots,
            },
            bridgeRef.current!,
          )
          return await store.stageCandidate(profile)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unable to reach Cadence Core.'
          return { ok: false, error: msg }
        }
      },
      stageSavedProfile: (profile) => store.stageCandidate(profile),
      discoverCores: () => store.discoverOnDemand(),
      updateStagedMusicRoots: (roots) => store.updateStagedMusicRoots(roots),
      cancelStaging: () => store.cancelStaging(),
      activateStagedCore: async () => {
        await store.activateStagedCore()
      },
      switchToSavedCore: async (profile) => {
        await store.switchToSavedCore(profile)
      },
      confirmLocalToCoreSwitch: async () => {
        await store.confirmLocalToCoreSwitch()
      },
      requestSwitchToLocal: async () => {
        await store.requestSwitchToLocal()
      },
      confirmLeaveCore: async (disposition) => {
        await store.confirmLeaveCore(disposition)
      },
      dismissSwitchPrompt: () => store.dismissSwitchPrompt(),
      reconnectCore: async () => {
        await store.reconnect()
      },
      removeSavedCore: (engineId, libraryId) => store.removeSavedCore(engineId, libraryId),
      corePlayTrack: async (trackId, queueTrackIds) => {
        await commitCoreQueueAndPlayRef.current(trackId, queueTrackIds, false)
      },
      coreTogglePlayPause: async () => {
        const snap = store.getState().view.snapshot
        if (!snap) return
        if (snap.playback.activity === 'playing') {
          await exec({ operation: 'playback.control', action: 'pause' })
        } else if (snap.playback.activity === 'paused') {
          await exec({ operation: 'playback.control', action: 'resume' })
        } else if (snap.queue.currentEntryId) {
          const entry = snap.queue.entries.find((e) => e.entryId === snap.queue.currentEntryId)
          if (entry) {
            await commitCoreQueueAndPlayRef.current(entry.trackId, undefined, false)
          }
        } else if (snap.catalog.tracks[0]) {
          await commitCoreQueueAndPlayRef.current(snap.catalog.tracks[0].id, undefined, false)
        }
      },
      coreStop: () => exec({ operation: 'playback.control', action: 'stop' }),
      coreNextTrack: () => exec({ operation: 'queue.control', action: 'next' }),
      corePrevTrack: () => exec({ operation: 'queue.control', action: 'previous' }),
      coreSeek: (positionSeconds) =>
        exec({ operation: 'playback.control', action: 'seek', positionSeconds }),
      coreJumpToEntry: (entryId) =>
        exec({ operation: 'queue.control', action: 'jump', entryId }),
      coreRemoveQueueEntry: async (entryId) => {
        const snap = store.getState().view.snapshot
        if (!snap) return
        const entries = snap.queue.entries.filter((e) => e.entryId !== entryId)
        await exec({ operation: 'queue.replace', entries })
      },
      coreClearUpcomingQueue: async () => {
        const snap = store.getState().view.snapshot
        if (!snap) return
        const curIdx = snap.queue.currentEntryId
          ? snap.queue.entries.findIndex((e) => e.entryId === snap.queue.currentEntryId)
          : -1
        const kept = curIdx >= 0 ? snap.queue.entries.slice(0, curIdx + 1) : []
        await exec({ operation: 'queue.replace', entries: kept })
      },
      coreReorderQueueEntry: async (fromIndex, toIndex) => {
        const snap = store.getState().view.snapshot
        if (!snap) return
        const entries = [...snap.queue.entries]
        if (
          fromIndex < 0 ||
          fromIndex >= entries.length ||
          toIndex < 0 ||
          toIndex >= entries.length ||
          fromIndex === toIndex
        ) {
          return
        }
        const [moved] = entries.splice(fromIndex, 1)
        entries.splice(toIndex, 0, moved)
        await exec({ operation: 'queue.replace', entries })
      },
      coreSetModes: (repeat, shuffle) =>
        exec({ operation: 'queue.control', action: 'modes', repeat, shuffle }),
      coreRefreshSnapshot: () => store.refreshSnapshot(),
      coreRefreshCatalog: async () => {
        await store.refreshCatalog()
      },
      resolveCoreArtworkUrl,
      getCachedCoreArtworkUrl,
      subscribeEngineEvents,
      selectLocalEndpointWithCoreGuard: async (endpoint) => {
        const intercepted = store.requestRs130TakeoverIfControlledByCore(endpoint, () =>
          selectEndpoint(endpoint),
        )
        if (!intercepted) {
          await selectEndpoint(endpoint)
        }
      },
      confirmRs130Takeover: () => store.confirmRs130Takeover(),
    }
  }, [
    state,
    isCoreActive,
    isBootstrapping,
    activeCoreSnapshot,
    engineClient,
    coreCatalogTracks,
    coreCatalogReleases,
    coreNowPlayingTrack,
    coreQueueEntries,
    coreCurrentEntryIndex,
    coreUpcomingEntries,
    store,
    selectEndpoint,
    resolveCoreArtworkUrl,
    getCachedCoreArtworkUrl,
    subscribeEngineEvents,
  ])

  return <EngineControllerContext.Provider value={value}>{children}</EngineControllerContext.Provider>
}

export function useEngineController(): EngineControllerContextValue {
  const ctx = useContext(EngineControllerContext)
  if (!ctx) {
    throw new Error('useEngineController must be used inside EngineControllerProvider')
  }
  return ctx
}

export function useOptionalEngineController(): EngineControllerContextValue | null {
  return useContext(EngineControllerContext)
}

export function useEffectiveQueueControl() {
  const local = useAudioPlayer()
  const engine = useOptionalEngineController()
  const isCoreActive = Boolean(engine?.isCoreActive)
  const coreSnap = isCoreActive ? engine?.activeCoreSnapshot ?? null : null

  return useMemo(() => {
    if (!isCoreActive || !engine) {
      return {
        ...local,
        isCoreActive: false,
        coreConnected: true,
        corePositionSeconds: null as number | null,
        playUpcomingAtIndex: (upcomingIdx: number) => {
          const target = local.upcomingTracks[upcomingIdx]
          if (target) {
            local.playTrack(target, local.queue)
          }
        },
      }
    }

    const nowTrack = engine.coreNowPlayingTrack
    const nowRelease =
      nowTrack?.releaseId
        ? engine.coreCatalogReleases.find((r) => r.id === nowTrack.releaseId) ?? null
        : null
    const upcomingTracks = engine.coreUpcomingEntries.map((e) => e.track)
    const queueTracks = engine.coreQueueEntries.map((e) => e.track)
    const repeatMode = coreSnap?.queue.repeat ?? 'off'
    const isShuffle = Boolean(coreSnap?.queue.shuffle)
    const curIndex = engine.coreCurrentEntryIndex >= 0 ? engine.coreCurrentEntryIndex : 0

    return {
      ...local,
      isCoreActive: true,
      coreConnected: Boolean(engine.state.view.session.connected),
      currentTrack: nowTrack,
      currentRelease: nowRelease,
      queue: queueTracks,
      queueIndex: curIndex,
      upcomingTracks,
      isPlaying: coreSnap?.playback.activity === 'playing',
      isPaused: coreSnap?.playback.activity === 'paused',
      isShuffle,
      repeatMode,
      corePositionSeconds: coreSnap?.playback.positionSeconds ?? 0,
      togglePlayPause: () => {
        void engine.coreTogglePlayPause()
      },
      toggleShuffle: () => {
        void engine.coreSetModes(repeatMode, !isShuffle)
      },
      seek: (seconds: number) => {
        void engine.coreSeek(seconds)
      },
      clearQueue: () => {
        void engine.coreClearUpcomingQueue()
      },
      removeFromQueue: (upcomingIdx: number) => {
        const entry = engine.coreUpcomingEntries[upcomingIdx]
        if (entry) {
          void engine.coreRemoveQueueEntry(entry.entryId)
        }
      },
      reorderQueue: (fromUpcomingIdx: number, toUpcomingIdx: number) => {
        const offset = engine.coreCurrentEntryIndex >= 0 ? engine.coreCurrentEntryIndex + 1 : 0
        void engine.coreReorderQueueEntry(offset + fromUpcomingIdx, offset + toUpcomingIdx)
      },
      playUpcomingAtIndex: (upcomingIdx: number) => {
        const entry = engine.coreUpcomingEntries[upcomingIdx]
        if (entry) {
          void engine.coreJumpToEntry(entry.entryId)
        }
      },
    }
  }, [isCoreActive, engine, coreSnap, local])
}
