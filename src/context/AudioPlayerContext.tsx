import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { Track, Release } from '../core/types'
import { tauriBridge, AudioStreamTelemetry } from '../services/tauriBridge'

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
}

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
    if (typeof window !== 'undefined') {
      return localStorage.getItem('cadence:active_device') || 'Default System Audio'
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
          // Auto advance if track ended
          if (
            status.durationSecs > 0 &&
            status.positionSecs >= status.durationSecs - 0.5 &&
            !status.isPaused
          ) {
            handleAutoAdvance()
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
      await tauriBridge.pause()
      setIsPlaying(false)
      setIsPaused(true)
    } else {
      await tauriBridge.resume()
      setIsPlaying(true)
      setIsPaused(false)
    }
  }, [currentTrack, isPlaying, queue, playTrack])

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
      localStorage.setItem('cadence:active_device', device)
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

      const savedDevice = typeof window !== 'undefined' ? localStorage.getItem('cadence:active_device') : null
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
          localStorage.setItem('cadence:active_device', streamerLabel)
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
