import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
import type { CoreCatalogTrack, CoreRequest, CoreSnapshot } from '../core/coreProtocol'
import type { EngineActivity } from '../core/engineSession'
import type { AudioEndpoint } from '../core/endpointRouting'

export interface EngineControllerContextValue {
  state: CoreControllerState
  isCoreActive: boolean
  activeCoreSnapshot: CoreSnapshot | null
  coreCatalogTracks: Track[]
  coreCatalogReleases: Release[]
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
  coreSetModes: (repeat: 'off' | 'one' | 'all', shuffle: boolean) => Promise<void>
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
    const releaseId = `core_rel_${ct.album.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'album'}`
    const existing = releaseMap.get(releaseId)
    const fallbackTrackNo = existing ? existing.tracks.length + 1 : 1
    const format = normalizeCoreFormat(ct.format)
    const sampleRateStr = formatCoreSampleRateStr(format, ct.sampleRate, ct.bitDepth, ct.format)
    const isHighRes =
      format === 'DSD' || (ct.sampleRate ?? 0) > 48_000 || (ct.bitDepth ?? 0) > 16
    const discNumber = ct.discNumber ?? 1
    const releaseYear = ct.releaseYear ?? 0

    const uiTrack: Track = {
      id: ct.id,
      releaseId,
      recordingId: ct.id,
      trackNumber: ct.trackNumber ?? fallbackTrackNo,
      discNumber,
      title: ct.title,
      artistCredit: ct.artist,
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
      albumTitle: ct.album,
      releaseTitle: ct.album,
    }
    uiTracks.push(uiTrack)

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
    } else {
      releaseMap.set(releaseId, {
        release: {
          id: releaseId,
          masterReleaseId: releaseId,
          title: ct.album,
          folderName: ct.album,
          folderPath: '',
          artistCredit: ct.artist,
          releaseYear,
          originalYear: releaseYear,
          label: 'Cadence Core',
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
          discsCount: discNumber,
          tracksCount: 1,
          genreTags: [],
          storageMountId: 'core',
          isCompilation: false,
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
          // Confirm authoritative backend idle state when inside Tauri, or local state in tests/browser
          if (tauriBridge.isTauri()) {
            const st = await tauriBridge.getPlaybackStatus()
            if (st && (st.isPlaying || st.isPaused)) {
              return false
            }
          }
          activityRef.current = 'idle'
          return true
        },
        request: async (_req: CoreRequest) => ({ ok: true, data: {} }),
      },
    })
  }

  const store = storeRef.current
  const [state, setState] = useState<CoreControllerState>(() => store.getState())

  useEffect(() => {
    setState(store.getState())
    const unsub = store.subscribe((next) => setState(next))
    return () => {
      unsub()
    }
  }, [store])

  const isCoreActive = state.view.session.active.kind === 'core'
  const activeCoreSnapshot = isCoreActive ? state.view.snapshot : null

  useEffect(() => {
    if (typeof registerExternalPlaybackDelegate !== 'function') return
    if (!isCoreActive) {
      registerExternalPlaybackDelegate(null)
      return
    }
    registerExternalPlaybackDelegate({
      playTrack: async (track, queueContext) => {
        if (queueContext && queueContext.length > 0) {
          const idx = queueContext.findIndex((t) => t.id === track.id)
          const ordered = idx > 0 ? queueContext.slice(idx) : queueContext
          const entries = ordered.map((t, i) => ({
            entryId: `qe_${Date.now().toString(36)}_${i}`,
            trackId: t.id,
          }))
          await store.executeCoreCommand({ operation: 'queue.replace', entries })
        }
        await store.executeCoreCommand({ operation: 'playback.control', action: 'play', trackId: track.id })
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
    if (!activeCoreSnapshot) return { tracks: [], releases: [] }
    const allTracks =
      state.hydratedCatalogTracks.length > activeCoreSnapshot.catalog.tracks.length
        ? state.hydratedCatalogTracks
        : activeCoreSnapshot.catalog.tracks
    return mapCoreCatalogToUi(allTracks)
  }, [activeCoreSnapshot, state.hydratedCatalogTracks])

  const value = useMemo<EngineControllerContextValue>(() => {
    const exec = async (cmd: CoreCommandInput) => {
      await store.executeCoreCommand(cmd)
    }

    return {
      state,
      isCoreActive,
      activeCoreSnapshot,
      coreCatalogTracks,
      coreCatalogReleases,
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
        if (queueTrackIds && queueTrackIds.length > 0) {
          const entries = queueTrackIds.map((id, idx) => ({
            entryId: `qe_${Date.now().toString(36)}_${idx}`,
            trackId: id,
          }))
          await exec({ operation: 'queue.replace', entries })
        }
        await exec({ operation: 'playback.control', action: 'play', trackId })
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
            await exec({ operation: 'playback.control', action: 'play', trackId: entry.trackId })
          }
        } else if (snap.catalog.tracks[0]) {
          await exec({
            operation: 'playback.control',
            action: 'play',
            trackId: snap.catalog.tracks[0].id,
          })
        }
      },
      coreStop: () => exec({ operation: 'playback.control', action: 'stop' }),
      coreNextTrack: () => exec({ operation: 'queue.control', action: 'next' }),
      corePrevTrack: () => exec({ operation: 'queue.control', action: 'previous' }),
      coreSeek: (positionSeconds) =>
        exec({ operation: 'playback.control', action: 'seek', positionSeconds }),
      coreJumpToEntry: (entryId) =>
        exec({ operation: 'queue.control', action: 'jump', entryId }),
      coreSetModes: (repeat, shuffle) =>
        exec({ operation: 'queue.control', action: 'modes', repeat, shuffle }),
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
  }, [state, isCoreActive, activeCoreSnapshot, coreCatalogTracks, coreCatalogReleases, store, selectEndpoint])

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
