import { useState, useEffect, useRef, useCallback } from 'react'
import type { CurationDecisionTrace, ExecutionProgressEvent, ExecutionPhase, OutcomeStatus } from '../core/types'
import type { CurateEvidenceRun, RecordCurateAttempt } from '../services/curateEvidenceService'
import { useOptionalEngineController } from '../context/EngineControllerContext'
import {
  loadUiCurationTrace,
  saveUiCurationEvidence,
} from '../services/engineCurateBridge'

export type CurationTraceStatus = 'idle' | 'fetching' | 'completed' | 'cancelled' | 'paused' | 'error' | 'save_error'

export function useCurationTrace({ albumId }: { albumId?: string } = {}) {
  const engine = useOptionalEngineController()
  const engineId = engine?.state.activeProfile?.engineId
  const libraryId = engine?.state.activeProfile?.libraryId

  const [status, setStatus] = useState<CurationTraceStatus>('idle')
  const [currentPhase, setCurrentPhase] = useState<ExecutionPhase>('idle')
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [trace, setTrace] = useState<CurationDecisionTrace | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  const [lastEvidenceId, setLastEvidenceId] = useState<string>()
  const [refreshAlbumId, setRefreshAlbumId] = useState<string>()

  const abortControllerRef = useRef<AbortController | null>(null)
  const activeAlbumIdRef = useRef<string | undefined>(albumId)
  activeAlbumIdRef.current = albumId

  // Load persisted decision trace when albumId changes
  useEffect(() => {
    let isMounted = true
    setTrace(null)
    setStatus('idle')
    setRefreshAlbumId(undefined)
    if (!albumId) {
      setTrace(null)
      setStatus('idle')
      return
    }

    const persistedTrace = loadUiCurationTrace(albumId, engineId, libraryId)
    if (persistedTrace) {
      setTrace(persistedTrace)
      setStatus('completed')
    } else {
      setTrace(null)
      setStatus('idle')
    }

    return () => {
      isMounted = false
      abortControllerRef.current?.abort('AlbumChanged')
    }
  }, [albumId, engineId, libraryId])

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
    input: Pick<CurateEvidenceRun, 'trigger' | 'context' | 'confirmedCommitIds'>,
    fetchFn: (signal: AbortSignal, onProgress: (event: ExecutionProgressEvent) => void, record: RecordCurateAttempt) =>
      Promise<{ trace?: CurationDecisionTrace | null; result: T; trackDecisions?: CurateEvidenceRun['trackDecisions']; identityMappings?: CurateEvidenceRun['identityMappings']; sourceCandidates?: CurateEvidenceRun['sourceCandidates'] }>,
  ): Promise<T | null> => {
    abortControllerRef.current?.abort('NewSteerInitiated')
    const controller = new AbortController()
    abortControllerRef.current = controller
    const id = crypto.randomUUID()
    const requestedAt = new Date().toISOString()
    const attempts: CurateEvidenceRun['attempts'] = []
    const active = () => activeAlbumIdRef.current === targetAlbumId && abortControllerRef.current === controller

    setStatus('fetching')
    setRefreshAlbumId(input.trigger === 'user_refresh' ? targetAlbumId : undefined)
    setCurrentPhase('idle')
    setProgressMessage('Initiating steer resolution...')

    const run: CurateEvidenceRun = { ...input, id, requestedAt, completedAt: requestedAt, attempts, outcome: 'failed' }
    let result: T | null = null
    let failureMessage = 'Could not load album identity.'
    try {
      run.identity = input.context.tracks.map((track) => ({
        localTrackId: track.id,
        editionId: targetAlbumId,
        editionRev: 1,
        discId: `${targetAlbumId}_d1`,
        discRev: 1,
        trackOrderRev: track.number ?? 1,
        sourceGroupId: null,
        sourceGroupRev: null,
      }))
      controller.signal.throwIfAborted()
      failureMessage = 'Candidate resolution failed.'
      const response = await fetchFn(controller.signal, event => {
        if (active()) handleProgress(event)
      }, attempt => attempts.push(attempt))
      controller.signal.throwIfAborted()
      if (!active()) controller.abort('AlbumChanged')
      controller.signal.throwIfAborted()
      run.outcome = 'completed'
      run.decision = response.trace ?? undefined
      run.trackDecisions = response.trackDecisions
      run.identityMappings = response.identityMappings
      run.sourceCandidates = response.sourceCandidates
      result = response.result
    } catch (error) {
      run.outcome = controller.signal.aborted ? 'cancelled' : 'failed'
      if (run.outcome === 'failed') {
        console.warn(`[useCurationTrace] ${failureMessage}`, error)
        if (error instanceof Error) failureMessage = error.message
      }
    }
    if (active()) setRefreshAlbumId(undefined)
    run.completedAt = new Date().toISOString()
    try {
      const applicable = saveUiCurationEvidence(targetAlbumId, run, engineId, libraryId)
      if (active()) {
        setLastEvidenceId(id)
        if (run.decision && applicable) setTrace(run.decision)
        setStatus(run.outcome === 'failed' ? 'error' : run.outcome)
        if (run.outcome === 'failed') setProgressMessage(failureMessage)
        if (run.outcome === 'completed' && !applicable) {
          setStatus('error')
          setProgressMessage('Evidence was saved to history. Refresh again against the current album and confirmed values.')
        }
      }
      return applicable && active() && !controller.signal.aborted ? result : null
    } catch (err) {
      console.warn('[useCurationTrace] Evidence persistence failed:', err)
      if (active()) {
        setStatus('save_error')
        setProgressMessage('Could not save Curate evidence.')
      }
      return null
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
    }
  }, [handleProgress])

  const cancelRefresh = useCallback(() => {
    abortControllerRef.current?.abort('RefreshCancelled')
    setRefreshAlbumId(undefined)
    setStatus('cancelled')
  }, [])

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
    outcomeStatus: (status === 'paused' ? 'paused_playback' : status === 'error' ? 'failed' : trace?.outcomeStatus ?? null) as OutcomeStatus | null,
    isDrawerOpen,
    isResuming,
    lastEvidenceId,
    isRefreshing: Boolean(albumId && albumId === refreshAlbumId),
    cancelRefresh,
    setIsResuming,
    executeFetch,
    toggleDrawer,
    closeDrawer,
    setTrace
  }
}

