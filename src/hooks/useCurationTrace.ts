import { useState, useEffect, useRef, useCallback } from 'react'
import type { CurationDecisionTrace, ExecutionProgressEvent, OutcomeStatus, ExecutionPhase } from '../core/types'
import { tauriBridge } from '../services/tauriBridge'

export type CurationTraceStatus = 'idle' | 'fetching' | 'completed' | 'paused' | 'error'

interface UseCurationTraceOptions {
  albumId?: string
  onPlaybackInterrupted?: () => void
}

export function useCurationTrace(options?: UseCurationTraceOptions) {
  const { albumId, onPlaybackInterrupted } = options || {}

  const [status, setStatus] = useState<CurationTraceStatus>('idle')
  const [currentPhase, setCurrentPhase] = useState<ExecutionPhase>('idle')
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [trace, setTrace] = useState<CurationDecisionTrace | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isResuming, setIsResuming] = useState(false)

  const abortControllerRef = useRef<AbortController | null>(null)
  const activeAlbumIdRef = useRef<string | undefined>(albumId)
  activeAlbumIdRef.current = albumId

  // Load persisted decision trace when albumId changes
  useEffect(() => {
    let isMounted = true
    if (!albumId) {
      setTrace(null)
      setStatus('idle')
      return
    }

    tauriBridge.curationGetTrace(albumId).then((persistedTrace) => {
      if (!isMounted) return
      if (persistedTrace) {
        setTrace(persistedTrace)
        setStatus('completed')
      } else {
        setTrace(null)
        setStatus('idle')
      }
    }).catch(() => {
      if (isMounted) {
        setTrace(null)
        setStatus('idle')
      }
    })

    return () => {
      isMounted = false
    }
  }, [albumId])

  // Listen for playback state changes to guard bit-perfect transport
  useEffect(() => {
    let unlisten: (() => void) | undefined

    const subscribePlayback = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<{ isPlaying: boolean; isPaused: boolean; playbackState?: string }>(
          'cadence-playback-state',
          (event) => {
            const { isPlaying, isPaused, playbackState } = event.payload
            const isActivePlayback = isPlaying || isPaused || playbackState === 'Loading'

            if (isActivePlayback && abortControllerRef.current) {
              // Immediately abort active fetch
              abortControllerRef.current.abort('PausedForPlayback')
              abortControllerRef.current = null
              setStatus('paused')
              setProgressMessage('Curation paused to preserve bit-perfect playback.')
              onPlaybackInterrupted?.()
            }
          }
        )
      } catch {
        // Fallback or non-Tauri mock
      }
    }

    subscribePlayback()

    return () => {
      if (unlisten) unlisten()
    }
  }, [onPlaybackInterrupted])

  // Global Windows keyboard shortcut listener: Ctrl+I to toggle, Esc to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        setIsDrawerOpen((prev) => !prev)
      } else if (e.key === 'Escape' && isDrawerOpen) {
        setIsDrawerOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isDrawerOpen])

  const handleProgress = useCallback((event: ExecutionProgressEvent) => {
    setCurrentPhase(event.phase)
    setProgressMessage(event.message)
  }, [])

  const executeFetch = useCallback(async <T>(
    targetAlbumId: string,
    fetchFn: (signal: AbortSignal, onProgress: (event: ExecutionProgressEvent) => void) => Promise<{ trace?: CurationDecisionTrace | null; result: T }>
  ): Promise<T | null> => {
    // 1. Debounce and cancel any existing in-flight controller
    if (abortControllerRef.current) {
      abortControllerRef.current.abort('NewSteerInitiated')
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    setStatus('fetching')
    setCurrentPhase('idle')
    setProgressMessage('Initiating steer resolution...')

    try {
      const { trace: newTrace, result } = await fetchFn(controller.signal, handleProgress)

      if (controller.signal.aborted) {
        if (controller.signal.reason === 'PausedForPlayback') {
          setStatus('paused')
          setProgressMessage('Curation paused to preserve bit-perfect playback.')
        }
        return null
      }

      if (newTrace) {
        setTrace(newTrace)
        setStatus('completed')
        // Persist trace to SQLite asynchronously via Tauri IPC
        tauriBridge.curationSaveTrace(targetAlbumId, newTrace).catch((err) => {
          console.warn('[useCurationTrace] Failed to persist trace:', err)
        })
      } else {
        setStatus('completed')
      }

      return result
    } catch (err: any) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === 'PausedForPlayback') {
          setStatus('paused')
          setProgressMessage('Curation paused to preserve bit-perfect playback.')
        }
        return null
      }

      console.error('[useCurationTrace] Steer fetch failed:', err)
      setStatus('error')
      setProgressMessage(err?.message || 'Candidate resolution failed.')
      return null
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }, [handleProgress])

  const toggleDrawer = useCallback(() => {
    setIsDrawerOpen((prev) => !prev)
  }, [])

  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false)
  }, [])

  return {
    status,
    currentPhase,
    progressMessage,
    trace,
    outcomeStatus: (trace?.outcomeStatus || (status === 'paused' ? 'paused_playback' : status === 'error' ? 'failed' : null)) as OutcomeStatus | null,
    isDrawerOpen,
    isResuming,
    setIsResuming,
    executeFetch,
    toggleDrawer,
    closeDrawer,
    setTrace
  }
}

