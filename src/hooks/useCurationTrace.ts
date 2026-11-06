import { useState, useEffect, useRef, useCallback } from 'react'
import type { CurationDecisionTrace, ExecutionProgressEvent, OutcomeStatus, ExecutionPhase } from '../core/types'
import { tauriBridge } from '../services/tauriBridge'
import type { CurateEvidenceRun, RecordCurateAttempt } from '../services/curateEvidenceService'

export type CurationTraceStatus = 'idle' | 'fetching' | 'completed' | 'paused' | 'error' | 'save_error'

export function useCurationTrace({ albumId }: { albumId?: string } = {}) {

  const [status, setStatus] = useState<CurationTraceStatus>('idle')
  const [currentPhase, setCurrentPhase] = useState<ExecutionPhase>('idle')
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [trace, setTrace] = useState<CurationDecisionTrace | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  const [lastEvidenceId, setLastEvidenceId] = useState<string>()

  const abortControllerRef = useRef<AbortController | null>(null)
  const activeAlbumIdRef = useRef<string | undefined>(albumId)
  activeAlbumIdRef.current = albumId

  // Load persisted decision trace when albumId changes
  useEffect(() => {
    let isMounted = true
    setTrace(null)
    setStatus('idle')
    if (!albumId) {
      setTrace(null)
      setStatus('idle')
      return
    }

    tauriBridge.curationGetTrace(albumId).then((persistedTrace) => {
      if (!isMounted || (abortControllerRef.current && !abortControllerRef.current.signal.aborted)) return
      if (persistedTrace) {
        setTrace(persistedTrace)
        setStatus('completed')
      } else {
        setTrace(null)
        setStatus('idle')
      }
    }).catch(() => {
      if (isMounted && (!abortControllerRef.current || abortControllerRef.current.signal.aborted)) {
        setTrace(null)
        setStatus('idle')
      }
    })

    return () => {
      isMounted = false
      abortControllerRef.current?.abort('AlbumChanged')
    }
  }, [albumId])

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
    input: Pick<CurateEvidenceRun, 'trigger' | 'context'>,
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
    setCurrentPhase('idle')
    setProgressMessage('Initiating steer resolution...')

    const run: CurateEvidenceRun = { ...input, id, requestedAt, completedAt: requestedAt, attempts, outcome: 'failed' }
    let result: T | null = null
    try {
      run.identity = await tauriBridge.curationGetIdentity(input.context.tracks.map(track => track.id))
      controller.signal.throwIfAborted()
      const response = await fetchFn(controller.signal, event => {
        if (active()) handleProgress(event)
      }, attempt => attempts.push(attempt))
      controller.signal.throwIfAborted()
      run.outcome = 'completed'
      run.decision = response.trace ?? undefined
      run.trackDecisions = response.trackDecisions
      run.identityMappings = response.identityMappings
      run.sourceCandidates = response.sourceCandidates
      result = response.result
    } catch {
      run.outcome = controller.signal.aborted ? 'cancelled' : 'failed'
    }
    run.completedAt = new Date().toISOString()
    try {
      await tauriBridge.curationSaveEvidence(targetAlbumId, run)
      if (active()) {
        setLastEvidenceId(id)
        if (run.decision) setTrace(run.decision)
        setStatus(run.outcome === 'completed' ? 'completed' : run.outcome === 'failed' ? 'error' : 'idle')
        if (run.outcome === 'failed') setProgressMessage('Candidate resolution failed.')
      }
      return active() && !controller.signal.aborted ? result : null
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
    setIsResuming,
    executeFetch,
    toggleDrawer,
    closeDrawer,
    setTrace
  }
}

