import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Track, Release, Playlist, SampleRateTransition } from '../core/types'
import { tauriBridge, AudioStreamTelemetry } from '../services/tauriBridge'
import { sqliteLibraryService } from '../services/sqliteLibraryService'

export function computeSampleRateTransition(
  current: Track | null,
  next: Track | null,
  settlingDelayMs: number = 350
): SampleRateTransition | null {
  if (!current || !next) return null

  const getFamily = (rate?: number): '44' | '48' | 'unknown' => {
    if (!rate) return 'unknown'
    if (rate % 44100 === 0) return '44'
    if (rate % 48000 === 0) return '48'
    return 'unknown'
  }

  const fromFmt = (current.format || 'PCM').toUpperCase()
  const toFmt = (next.format || 'PCM').toUpperCase()
  const fromRate = current.sampleRate
  const toRate = next.sampleRate

  const fromIsDsd = fromFmt.includes('DSD') || fromFmt.includes('DSF') || fromFmt.includes('DFF')
  const toIsDsd = toFmt.includes('DSD') || toFmt.includes('DSF') || toFmt.includes('DFF')

  if (fromIsDsd !== toIsDsd) {
    const effectiveDelay = Math.max(settlingDelayMs, 500)
    return {
      fromSampleRate: fromRate,
      toSampleRate: toRate,
      fromFormat: fromFmt,
      toFormat: toFmt,
      isSameFamily: false,
      warningLabel: `Cross-domain transition (${fromFmt} → ${toFmt}) • Hardware relay switch ~${effectiveDelay}ms`,
      settlingDelayMs: effectiveDelay,
    }
  }

  if (fromRate && toRate && fromRate !== toRate) {
    const famFrom = getFamily(fromRate)
    const famTo = getFamily(toRate)
    const isSameFam = famFrom !== 'unknown' && famFrom === famTo
    const effectiveDelay = isSameFam ? Math.min(settlingDelayMs, 200) : settlingDelayMs

    return {
      fromSampleRate: fromRate,
      toSampleRate: toRate,
      fromFormat: fromFmt,
      toFormat: toFmt,
      isSameFamily: isSameFam,
      warningLabel: isSameFam
        ? `Clock multiplier change (${(fromRate / 1000).toFixed(1)}k → ${(toRate / 1000).toFixed(1)}k) • Fast lock ~${effectiveDelay}ms`
        : `Cross-family clock switch (${(fromRate / 1000).toFixed(1)}k → ${(toRate / 1000).toFixed(1)}k) • DAC re-sync ~${effectiveDelay}ms`,
      settlingDelayMs: effectiveDelay,
    }
  }

  return null
}

interface AudioPlayerContextType {
  currentTrack: Track | null
  currentRelease: Release | null
  queue: Track[]
  queueIndex: number
  isPlaying: boolean
  isPaused: boolean
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  repeatMode: 'off' | 'all' | 'one'
  isShuffle: boolean
  streamTelemetry: AudioStreamTelemetry | null
  activeDevice: string
  availableDevices: string[]
  isNativeTauri: boolean
  isPurityMode: boolean
  isBitPerfect: boolean
  outputSampleRate?: number
  deviceType?: string
  upnpDevices: any[]
  playTrack: (track: Track, queueContext?: Track[], release?: Release) => Promise<void>
  togglePlayPause: () => Promise<void>
  stop: () => Promise<void>
  nextTrack: () => Promise<void>
  prevTrack: () => Promise<void>
  seek: (seconds: number) => Promise<void>
  setVolume: (level: number) => void
  toggleMute: () => void
  toggleRepeat: () => void
  toggleShuffle: () => void
  selectDevice: (device: string) => Promise<void>
  refreshDevices: () => Promise<void>
  togglePurityMode: (enabled?: boolean) => Promise<void>
  discoverUpnpDevices: () => Promise<any[]>
  // Queue & Playlist & Gapless additions
  upcomingTracks: Track[]
  nextTrackTransition: SampleRateTransition | null
  addToQueue: (tracks: Track | Track[]) => void
  playNext: (tracks: Track | Track[]) => void
  removeFromQueue: (upcomingIndex: number) => void
  reorderQueue: (fromIndex: number, toIndex: number) => void
  clearQueue: () => void
  setFullQueue: (tracks: Track[], startIndex?: number) => void
  saveQueueAsPlaylist: (name: string, description?: string) => Promise<Playlist | null>
  isQueueDrawerOpen: boolean
  toggleQueueDrawer: (open?: boolean) => void
  queueDrawerTab: 'queue' | 'playlists'
  setQueueDrawerTab: (tab: 'queue' | 'playlists') => void
  isGapless: boolean
  toggleGapless: (enabled?: boolean) => void
  settlingDelayMs: number
  setSettlingDelay: (ms: number) => Promise<void>
  // Unified Right Sidebar State
  rightSidebarTab: RightSidebarTab
  setRightSidebarTab: (tab: RightSidebarTab) => void
  isRightSidebarOpen: boolean
  setIsRightSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  toggleRightSidebar: (tab?: RightSidebarTab) => void
}

export type RightSidebarTab = 'queue' | 'playlists' | 'inspector'

const AudioPlayerContext = createContext<AudioPlayerContextType | null>(null)

export const AudioPlayerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null)
  const [currentRelease, setCurrentRelease] = useState<Release | null>(null)
  const [queue, setQueue] = useState<Track[]>([])
  const [queueIndex, setQueueIndex] = useState<number>(-1)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [isPaused, setIsPaused] = useState<boolean>(false)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const [duration, setDuration] = useState<number>(0)
  const [volume, setVolumeState] = useState<number>(1)
  const [isMuted, setIsMuted] = useState<boolean>(false)
  const [repeatMode, setRepeatMode] = useState<'off' | 'all' | 'one'>('off')
  const [isShuffle, setIsShuffle] = useState<boolean>(false)
  const [streamTelemetry, setStreamTelemetry] = useState<AudioStreamTelemetry | null>(null)
  const [activeDevice, setActiveDevice] = useState<string>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return localStorage.getItem('cadence:active_device') || 'Default System Audio'
      }
    } catch {
      // In restricted WebView2 or private browsing, localStorage may throw SecurityError
    }
    return 'Default System Audio'
  })
  const [availableDevices, setAvailableDevices] = useState<string[]>([])
  const [isNativeTauri, setIsNativeTauri] = useState<boolean>(() => tauriBridge.isTauri())
  const [isPurityMode, setIsPurityMode] = useState<boolean>(false)
  const [isBitPerfect, setIsBitPerfect] = useState<boolean>(false)
  const [outputSampleRate, setOutputSampleRate] = useState<number | undefined>(undefined)
  const [deviceType, setDeviceType] = useState<string | undefined>('wasapi_shared')
  const [upnpDevices, setUpnpDevices] = useState<any[]>([])

  // Unified Right Sidebar & Gapless Playback State
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState<boolean>(false)
  const [rightSidebarTab, setRightSidebarTab] = useState<RightSidebarTab>('queue')
  const [isGapless, setIsGapless] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return localStorage.getItem('cadence:is_gapless') !== 'false'
      }
    } catch {}
    return true
  })
  const [settlingDelayMs, setSettlingDelayMsState] = useState<number>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const val = localStorage.getItem('cadence:settling_delay_ms')
        if (val) return parseInt(val, 10) || 350
      }
    } catch {}
    return 350
  })

  const hasPreloadedNextRef = useRef<string | null>(null)
  const prevVolumeRef = useRef<number>(1)
  const pollIntervalRef = useRef<any>(null)
  const stateRef = useRef({ queue, queueIndex, repeatMode, isShuffle, currentTrack })

  useEffect(() => {
    stateRef.current = { queue, queueIndex, repeatMode, isShuffle, currentTrack }
    tauriBridge.syncDesktopQueueToRemote(queue, queueIndex)
  }, [queue, queueIndex, repeatMode, isShuffle, currentTrack])

  // Detect environment on mount & load audio devices & purity mode & listen to Remote Controller events
  useEffect(() => {
    const tauri = tauriBridge.isTauri()
    setIsNativeTauri(tauri)
    tauriBridge.getPurityMode().then((p) => setIsPurityMode(p))
    refreshDevices()

    if (tauri) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen<any>('cadence:remote-state-changed', (event) => {
          const data = event.payload
          if (data) {
            if (data.isPlaying !== undefined) setIsPlaying(Boolean(data.isPlaying))
            if (data.isPaused !== undefined) setIsPaused(Boolean(data.isPaused))
            if (data.positionSecs !== undefined) setCurrentTime(data.positionSecs)
            if (data.durationSecs !== undefined) setDuration(data.durationSecs)
            if (data.volume !== undefined) setVolumeState(data.volume)
            if (data.isPurityMode !== undefined) setIsPurityMode(data.isPurityMode)
            if (data.isBitPerfect !== undefined) setIsBitPerfect(data.isBitPerfect)
            if (data.activeDevice) setActiveDevice(data.activeDevice)
            if (data.streamInfo) setStreamTelemetry(data.streamInfo)
          }
        }).catch(() => {})
      }).catch(() => {})
    }
  }, [])

  // Poll position and status for native Tauri playback
  useEffect(() => {
    const isTauri = isNativeTauri || tauriBridge.isTauri()
    if (isPlaying && !isPaused && isTauri) {
      pollIntervalRef.current = setInterval(async () => {
        try {
          const status = await tauriBridge.getPlaybackStatus()
          if (typeof status.positionSecs === 'number' && !isNaN(status.positionSecs)) {
            setCurrentTime(status.positionSecs)
          }
          if (status.durationSecs && status.durationSecs > 0) {
            setDuration(status.durationSecs)
          }
          if (status.streamInfo) {
            setStreamTelemetry(status.streamInfo)
          }
          if (status.purityMode !== undefined) {
            setIsPurityMode(status.purityMode)
          }
          if (status.isBitPerfect !== undefined) {
            setIsBitPerfect(status.isBitPerfect)
          }
          if (status.outputSampleRate !== undefined) {
            setOutputSampleRate(status.outputSampleRate)
          }
          if (status.deviceType !== undefined) {
            setDeviceType(status.deviceType)
          }

          // Audiophile Invariant #1 & #3 Gapless Pre-loading Check:
          // Once 2 seconds have elapsed and the playback buffer is stable, pre-stage the immediate next track
          if (
            isGapless &&
            status.positionSecs > 2 &&
            queueIndex + 1 < queue.length
          ) {
            const nextTrackCandidate = queue[queueIndex + 1]
            if (
              nextTrackCandidate?.filePath &&
              hasPreloadedNextRef.current !== nextTrackCandidate.id
            ) {
              hasPreloadedNextRef.current = nextTrackCandidate.id
              tauriBridge.prepareNextTrack(nextTrackCandidate.filePath).catch(() => {})
            }
          }

          // Auto advance if track ended
          if (
            status.durationSecs > 0 &&
            status.positionSecs >= status.durationSecs - 0.5 &&
            !status.isPaused
          ) {
            handleAutoAdvance()
          }

          // Self-heal: If the backend engine is idle and not playing, reconcile UI state
          if (!status.isPlaying && !status.isPaused && !status.currentFile) {
            setIsPlaying(false)
            setIsPaused(false)
          }
        } catch (e) {
          // ignore polling error
        }
      }, 250)
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [isPlaying, isPaused, isNativeTauri])

  // Auto advance helper
  const handleAutoAdvance = useCallback(() => {
    const { queue: q, queueIndex: qIdx, repeatMode: rMode, isShuffle: isShuf, currentTrack: cTrack } = stateRef.current

    if (rMode === 'one' && cTrack) {
      playTrack(cTrack)
      return
    }

    if (q.length > 0 && qIdx >= 0) {
      if (isShuf) {
        const nextIdx = Math.floor(Math.random() * q.length)
        setQueueIndex(nextIdx)
        playTrack(q[nextIdx])
      } else if (qIdx + 1 < q.length) {
        const nextIdx = qIdx + 1
        setQueueIndex(nextIdx)
        playTrack(q[nextIdx])
      } else if (rMode === 'all') {
        setQueueIndex(0)
        playTrack(q[0])
      } else {
        setIsPlaying(false)
        setIsPaused(false)
      }
    }
  }, [])

  // Play track function
  const playTrack = useCallback(
    async (track: Track, queueContext?: Track[], release?: Release) => {
      try {
        if (track.isOnline === false) {
          console.warn(`[AudioPlayer] Cannot play track "${track.title}": storage mount is offline`)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('cadence:toast', {
                detail: `Cannot play "${track.title}": storage mount is offline`,
              })
            )
          }
          return
        }

        if (queueContext && queueContext.length > 0) {
          setQueue(queueContext)
          const idx = queueContext.findIndex((t) => t.id === track.id)
          setQueueIndex(idx >= 0 ? idx : 0)
        } else if (queue.length === 0) {
          setQueue([track])
          setQueueIndex(0)
        }

        setCurrentTrack(track)
        if (release) {
          setCurrentRelease(release)
        }

        const initialDuration = track.durationSeconds || track.duration || 0
        setCurrentTime(0)
        setDuration(initialDuration)

        const telemetry = await tauriBridge.playTrack(
          track.filePath || track.title,
          (pos, dur) => {
            setCurrentTime(pos)
            if (dur && dur > 0) {
              setDuration(dur)
            }
          },
          () => {
            handleAutoAdvance()
          }
        )

        if (telemetry) {
          setStreamTelemetry(telemetry)
          if (telemetry.durationSecs > 0) {
            setDuration(telemetry.durationSecs)
          }
        }

        setIsPlaying(true)
        setIsPaused(false)
      } catch (err) {
        console.error('[AudioPlayer] Play track failed:', err)
        setIsPlaying(false)
        setIsPaused(false)
        try {
          await tauriBridge.stop()
        } catch {}
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('cadence:toast', {
              detail: `Cannot play "${track.title}": ${err instanceof Error ? err.message : String(err)}`,
            })
          )
        }
      }
    },
    [queue, handleAutoAdvance]
  )

  // Toggle Play / Pause
  const togglePlayPause = useCallback(async () => {
    if (!currentTrack) {
      if (queue.length > 0) {
        await playTrack(queue[0])
      }
      return
    }

    if (isPlaying) {
      try {
        await tauriBridge.pause()
      } catch (err) {
        console.error('[AudioPlayer] Pause failed:', err)
      }
      setIsPlaying(false)
      setIsPaused(true)
    } else {
      // If we are legitimately in a paused state and the backend has an active loaded file, resume
      if (isPaused) {
        try {
          const status = await tauriBridge.getPlaybackStatus()
          if (status.isPaused && status.currentFile) {
            await tauriBridge.resume()
            setIsPlaying(true)
            setIsPaused(false)
            return
          }
        } catch (e) {
          console.warn('[AudioPlayer] Resume check failed, falling back to playTrack:', e)
        }
      }

      // If playback was stopped, idle, or not yet initialized in the engine, trigger full playback
      await playTrack(currentTrack)
    }
  }, [currentTrack, isPlaying, isPaused, queue, playTrack])

  // Stop Playback
  const stop = useCallback(async () => {
    try {
      await tauriBridge.stop()
    } catch (err) {
      console.error('[AudioPlayer] Stop failed:', err)
    }
    setIsPlaying(false)
    setIsPaused(false)
  }, [])

  // Next Track
  const nextTrack = useCallback(async () => {
    if (queue.length === 0) return

    let nextIdx = queueIndex + 1
    if (isShuffle) {
      nextIdx = Math.floor(Math.random() * queue.length)
    } else if (nextIdx >= queue.length) {
      nextIdx = repeatMode === 'all' ? 0 : -1
    }

    if (nextIdx >= 0 && nextIdx < queue.length) {
      setQueueIndex(nextIdx)
      await playTrack(queue[nextIdx])
    }
  }, [queue, queueIndex, isShuffle, repeatMode, playTrack])

  // Previous Track
  const prevTrack = useCallback(async () => {
    if (queue.length === 0) return

    // If more than 3 seconds in, restart current track
    if (currentTime > 3) {
      await tauriBridge.seek(0)
      setCurrentTime(0)
      return
    }

    let prevIdx = queueIndex - 1
    if (prevIdx < 0) {
      prevIdx = repeatMode === 'all' ? queue.length - 1 : 0
    }

    if (prevIdx >= 0 && prevIdx < queue.length) {
      setQueueIndex(prevIdx)
      await playTrack(queue[prevIdx])
    }
  }, [queue, queueIndex, currentTime, repeatMode, playTrack])

  // Seek
  const seek = useCallback(async (seconds: number) => {
    setCurrentTime(seconds)
    await tauriBridge.seek(seconds)
  }, [])

  // Set Volume
  const setVolume = useCallback((level: number) => {
    if (isPurityMode) {
      // In Bit-Perfect Purity Mode, volume is locked to 1.0 (Unity Gain)
      setVolumeState(1)
      setIsMuted(false)
      tauriBridge.setVolume(1)
      return
    }
    const clamped = Math.max(0, Math.min(1, level))
    setVolumeState(clamped)
    setIsMuted(clamped === 0)
    tauriBridge.setVolume(clamped)
  }, [isPurityMode])

  // Toggle Mute
  const toggleMute = useCallback(() => {
    if (isMuted) {
      const restored = prevVolumeRef.current > 0 ? prevVolumeRef.current : 1
      setVolumeState(restored)
      setIsMuted(false)
      tauriBridge.setVolume(restored)
    } else {
      prevVolumeRef.current = volume
      setVolumeState(0)
      setIsMuted(true)
      tauriBridge.setVolume(0)
    }
  }, [isMuted, volume])

  // Toggle Repeat Mode
  const toggleRepeat = useCallback(() => {
    setRepeatMode((prev) => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'))
  }, [])

  // Toggle Shuffle
  const toggleShuffle = useCallback(() => {
    setIsShuffle((prev) => !prev)
  }, [])

  // Select Audio Output Device
  const selectDevice = useCallback(async (device: string) => {
    setActiveDevice(device)
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('cadence:active_device', device)
      } catch {}
    }
    await tauriBridge.setAudioDevice(device)
  }, [])

  // Toggle Bit-Perfect Purity Mode
  const togglePurityMode = useCallback(async (forced?: boolean) => {
    const nextState = typeof forced === 'boolean' ? forced : !isPurityMode
    try {
      const active = await tauriBridge.setPurityMode(nextState)
      setIsPurityMode(active)
      if (active) {
        setVolumeState(1)
        setIsMuted(false)
      }
    } catch (e) {
      console.error('[AudioPlayerContext] Failed to toggle purity mode:', e)
    }
  }, [isPurityMode])

  // Discover UPnP / DLNA Network Renderers
  const discoverUpnpDevices = useCallback(async () => {
    try {
      const discovered = await tauriBridge.discoverUpnpDevices()
      setUpnpDevices(discovered)
      return discovered
    } catch (e) {
      console.error('[AudioPlayerContext] discoverUpnpDevices error:', e)
      return []
    }
  }, [])

  // Refresh Audio Output Devices (Local + UPnP)
  const refreshDevices = useCallback(async () => {
    try {
      const [localDevices, netDevices] = await Promise.all([
        tauriBridge.listAudioDevices(),
        tauriBridge.discoverUpnpDevices(),
      ])
      setUpnpDevices(netDevices)
      const merged = [...localDevices]
      for (const d of netDevices) {
        const upnpLabel = `[UPnP] ${d.friendlyName}`
        if (!merged.includes(upnpLabel)) {
          merged.push(upnpLabel)
        }
      }
      setAvailableDevices(merged)

      let savedDevice: string | null = null
      try {
        savedDevice = typeof window !== 'undefined' && window.localStorage ? localStorage.getItem('cadence:active_device') : null
      } catch {}
      // Check if savedDevice is an unintended display monitor/TV
      const isSavedMonitor = savedDevice && /odyssey|oled|tv|monitor|screen|display/i.test(savedDevice)

      // Find top audiophile network streamer (e.g. HiFi Rose, Anthem AVM)
      const audiophileStreamer = netDevices.find(
        (d) => !/odyssey|oled|tv|monitor|screen|display/i.test(d.friendlyName + (d.modelName || '') + (d.modelDescription || ''))
      )

      if (savedDevice && merged.includes(savedDevice) && !isSavedMonitor) {
        setActiveDevice(savedDevice)
        await tauriBridge.setAudioDevice(savedDevice)
      } else if (audiophileStreamer) {
        // Auto-activate top audiophile network streamer (e.g. dedicated UPnP endpoint) for bit-perfect delivery
        const streamerLabel = `[UPnP] ${audiophileStreamer.friendlyName}`
        setActiveDevice(streamerLabel)
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem('cadence:active_device', streamerLabel)
          } catch {}
        }
        await tauriBridge.setAudioDevice(streamerLabel)
      } else if (savedDevice && merged.includes(savedDevice)) {
        setActiveDevice(savedDevice)
        await tauriBridge.setAudioDevice(savedDevice)
      } else if (merged.length > 0 && !activeDevice) {
        setActiveDevice(merged[0])
      }
    } catch (e) {
      console.error('[AudioPlayerContext] refreshDevices error:', e)
    }
  }, [activeDevice])

  // Upcoming tracks derived from current queue & queueIndex
  const upcomingTracks = useMemo(() => {
    if (queueIndex < 0 || queueIndex >= queue.length - 1) return []
    return queue.slice(queueIndex + 1)
  }, [queue, queueIndex])

  const nextTrackCandidate = upcomingTracks.length > 0 ? upcomingTracks[0] : null

  const nextTrackTransition = useMemo(() => {
    return computeSampleRateTransition(currentTrack, nextTrackCandidate, settlingDelayMs)
  }, [currentTrack, nextTrackCandidate, settlingDelayMs])

  const toggleGapless = useCallback((enabled?: boolean) => {
    setIsGapless((prev) => {
      const nextVal = typeof enabled === 'boolean' ? enabled : !prev
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          localStorage.setItem('cadence:is_gapless', nextVal ? 'true' : 'false')
        }
      } catch {}
      if (!nextVal) {
        hasPreloadedNextRef.current = null
        tauriBridge.invalidateNextTrack().catch(() => {})
      }
      return nextVal
    })
  }, [])

  const setSettlingDelay = useCallback(async (ms: number) => {
    const clamped = Math.max(0, Math.min(2000, ms))
    setSettlingDelayMsState(clamped)
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('cadence:settling_delay_ms', clamped.toString())
      }
    } catch {}
    await tauriBridge.setSettlingDelayMs(clamped)
  }, [])

  const toggleRightSidebar = useCallback((tab?: RightSidebarTab) => {
    setIsRightSidebarOpen((prevOpen) => {
      if (!tab) return !prevOpen
      if (prevOpen && rightSidebarTab === tab) {
        return false
      }
      setRightSidebarTab(tab)
      return true
    })
  }, [rightSidebarTab])

  const toggleQueueDrawer = useCallback((open?: boolean) => {
    if (typeof open === 'boolean') {
      setIsRightSidebarOpen(open)
      if (open && rightSidebarTab !== 'queue' && rightSidebarTab !== 'playlists') {
        setRightSidebarTab('queue')
      }
    } else {
      toggleRightSidebar('queue')
    }
  }, [rightSidebarTab, toggleRightSidebar])

  const setQueueDrawerTab = useCallback((tab: 'queue' | 'playlists') => {
    setRightSidebarTab(tab)
    setIsRightSidebarOpen(true)
  }, [])

  const addToQueue = useCallback((tracks: Track | Track[]) => {
    const newItems = Array.isArray(tracks) ? tracks : [tracks]
    if (newItems.length === 0) return

    setQueue((prev) => [...prev, ...newItems])

    if (!currentTrack && queue.length === 0) {
      playTrack(newItems[0], newItems)
    }
  }, [currentTrack, queue.length, playTrack])

  const playNext = useCallback((tracks: Track | Track[]) => {
    const newItems = Array.isArray(tracks) ? tracks : [tracks]
    if (newItems.length === 0) return

    // Invalidate staged next track buffer because slot 0 is mutating
    hasPreloadedNextRef.current = null
    tauriBridge.invalidateNextTrack().catch(() => {})

    setQueue((prev) => {
      if (prev.length === 0) return newItems
      const curQueueIndex = stateRef.current.queueIndex
      const insertIdx = curQueueIndex >= 0 ? curQueueIndex + 1 : 0

      // Deduplicate: if any of newItems already exist in the upcoming portion of the queue,
      // remove their old occurrences so they are moved forward rather than duplicated.
      const newItemKeys = new Set(newItems.map((t) => t.id || t.filePath))
      const history = prev.slice(0, insertIdx)
      const upcoming = prev.slice(insertIdx).filter((t) => !newItemKeys.has(t.id || t.filePath))

      return [...history, ...newItems, ...upcoming]
    })

    // Pre-stage the new immediate next track
    if (isGapless && newItems[0]?.filePath) {
      hasPreloadedNextRef.current = newItems[0].id
      tauriBridge.prepareNextTrack(newItems[0].filePath).catch(() => {})
    }
  }, [isGapless])

  const removeFromQueue = useCallback((upcomingIndex: number) => {
    const curQueueIndex = stateRef.current.queueIndex
    const absIdx = curQueueIndex + 1 + upcomingIndex
    if (absIdx < 0 || absIdx >= queue.length) return

    if (upcomingIndex === 0) {
      // Immediate next track was removed; invalidate staged buffer
      hasPreloadedNextRef.current = null
      tauriBridge.invalidateNextTrack().catch(() => {})
    }

    setQueue((prev) => prev.filter((_, idx) => idx !== absIdx))

    // If there is still an upcoming track after removal, stage it
    if (upcomingIndex === 0 && isGapless) {
      const nextItem = queue[absIdx + 1]
      if (nextItem?.filePath) {
        hasPreloadedNextRef.current = nextItem.id
        tauriBridge.prepareNextTrack(nextItem.filePath).catch(() => {})
      }
    }
  }, [queue, isGapless])

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return

    // If either the source or destination was slot 0, the immediate next track changed
    if (fromIndex === 0 || toIndex === 0) {
      hasPreloadedNextRef.current = null
      tauriBridge.invalidateNextTrack().catch(() => {})
    }

    setQueue((prev) => {
      const curQueueIndex = stateRef.current.queueIndex
      const effectiveIndex = curQueueIndex >= 0 ? curQueueIndex : 0
      const absFrom = effectiveIndex + 1 + fromIndex
      const absTo = effectiveIndex + 1 + toIndex

      if (absFrom < 0 || absFrom >= prev.length || absTo < 0 || absTo >= prev.length) {
        return prev
      }

      const updated = [...prev]
      const [moved] = updated.splice(absFrom, 1)
      updated.splice(absTo, 0, moved)
      return updated
    })

    if (isGapless) {
      setTimeout(() => {
        const { queue: currentQ, queueIndex: curIdx } = stateRef.current
        const newNext = currentQ[curIdx + 1]
        if (newNext?.filePath && hasPreloadedNextRef.current !== newNext.id) {
          hasPreloadedNextRef.current = newNext.id
          tauriBridge.prepareNextTrack(newNext.filePath).catch(() => {})
        }
      }, 50)
    }
  }, [isGapless])

  const clearQueue = useCallback(() => {
    hasPreloadedNextRef.current = null
    tauriBridge.invalidateNextTrack().catch(() => {})

    if (currentTrack && queueIndex >= 0) {
      setQueue([currentTrack])
      setQueueIndex(0)
    } else {
      setQueue([])
      setQueueIndex(-1)
    }
  }, [currentTrack, queueIndex])

  const setFullQueue = useCallback((tracks: Track[], startIndex: number = 0) => {
    hasPreloadedNextRef.current = null
    tauriBridge.invalidateNextTrack().catch(() => {})
    setQueue(tracks)
    setQueueIndex(startIndex)
    if (startIndex >= 0 && startIndex < tracks.length) {
      playTrack(tracks[startIndex], tracks)
    }
  }, [playTrack])

  const saveQueueAsPlaylist = useCallback(async (name: string, description?: string): Promise<Playlist | null> => {
    if (!name.trim()) return null
    const tracksToSave = queue.length > 0 ? queue : currentTrack ? [currentTrack] : []
    if (tracksToSave.length === 0) return null

    try {
      const created = await sqliteLibraryService.createPlaylist({
        title: name.trim(),
        description: description?.trim() || undefined,
        trackIds: tracksToSave.map((t) => t.id),
        tracks: tracksToSave,
      })

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('cadence:toast', {
            detail: `Saved ${tracksToSave.length} tracks to playlist "${name}"`,
          })
        )
      }
      return created
    } catch (err) {
      console.error('[AudioPlayerContext] saveQueueAsPlaylist error:', err)
      return null
    }
  }, [queue, currentTrack])

  return (
    <AudioPlayerContext.Provider
      value={{
        currentTrack,
        currentRelease,
        queue,
        queueIndex,
        isPlaying,
        isPaused,
        currentTime,
        duration,
        volume,
        isMuted,
        repeatMode,
        isShuffle,
        streamTelemetry,
        activeDevice,
        availableDevices,
        isNativeTauri,
        isPurityMode,
        isBitPerfect,
        outputSampleRate,
        deviceType,
        upnpDevices,
        playTrack,
        togglePlayPause,
        stop,
        nextTrack,
        prevTrack,
        seek,
        setVolume,
        toggleMute,
        toggleRepeat,
        toggleShuffle,
        selectDevice,
        refreshDevices,
        togglePurityMode,
        discoverUpnpDevices,
        upcomingTracks,
        nextTrackTransition,
        addToQueue,
        playNext,
        removeFromQueue,
        reorderQueue,
        clearQueue,
        setFullQueue,
        saveQueueAsPlaylist,
        isQueueDrawerOpen: isRightSidebarOpen && (rightSidebarTab === 'queue' || rightSidebarTab === 'playlists'),
        toggleQueueDrawer,
        queueDrawerTab: rightSidebarTab === 'playlists' ? 'playlists' : 'queue',
        setQueueDrawerTab,
        rightSidebarTab,
        setRightSidebarTab,
        isRightSidebarOpen,
        setIsRightSidebarOpen,
        toggleRightSidebar,
        isGapless,
        toggleGapless,
        settlingDelayMs,
        setSettlingDelay,
      }}
    >
      {children}
    </AudioPlayerContext.Provider>
  )
}

export const useAudioPlayer = (): AudioPlayerContextType => {
  const context = useContext(AudioPlayerContext)
  if (!context) {
    throw new Error('useAudioPlayer must be used within an AudioPlayerProvider')
  }
  return context
}
