import { useEffect, useRef, useState } from 'react'

export interface CorePlaybackClockInput {
  corePositionSeconds: number | null | undefined
  isPlaying: boolean
  isConnected: boolean
  durationSeconds: number
  trackKey?: string | null
}

/** Pure projection helper so tests can verify Core playback clock math deterministically. */
export function computeCoreDisplayPosition(
  basePositionSeconds: number,
  anchorTimestampMs: number,
  nowTimestampMs: number,
  isPlaying: boolean,
  isConnected: boolean,
  durationSeconds: number,
): number {
  const safeBase = Number.isFinite(basePositionSeconds) && basePositionSeconds > 0 ? basePositionSeconds : 0
  const maxDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY
  if (!isPlaying || !isConnected) {
    return Math.min(maxDuration, safeBase)
  }
  const elapsedSeconds = Math.max(0, (nowTimestampMs - anchorTimestampMs) / 1000)
  return Math.min(maxDuration, safeBase + elapsedSeconds)
}

/**
 * Isolated 1 Hz display clock for Core mode leaf timer/scrubber components.
 * Runs no timers in This PC mode or when paused/idle/disconnected, keeping Core
 * network heartbeats at >=5000ms without freezing the UI clock between snapshots.
 */
export function useCorePlaybackClock({
  corePositionSeconds,
  isPlaying,
  isConnected,
  durationSeconds,
  trackKey,
}: CorePlaybackClockInput): number {
  const active = corePositionSeconds !== null && corePositionSeconds !== undefined
  const safeBase = active && Number.isFinite(corePositionSeconds) ? Math.max(0, corePositionSeconds) : 0
  const anchorRef = useRef<{ base: number; at: number }>({ base: safeBase, at: Date.now() })
  const [displaySeconds, setDisplaySeconds] = useState<number>(safeBase)

  useEffect(() => {
    if (!active) {
      setDisplaySeconds(0)
      return
    }
    const now = Date.now()
    anchorRef.current = { base: safeBase, at: now }
    setDisplaySeconds(computeCoreDisplayPosition(safeBase, now, now, isPlaying, isConnected, durationSeconds))
  }, [active, safeBase, isPlaying, isConnected, durationSeconds, trackKey])

  useEffect(() => {
    if (!active || !isPlaying || !isConnected) {
      return
    }
    const syncClock = () => {
      const { base, at } = anchorRef.current
      setDisplaySeconds(computeCoreDisplayPosition(base, at, Date.now(), true, true, durationSeconds))
    }
    const timer = setInterval(syncClock, 1000)
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        syncClock()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    return () => {
      clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [active, safeBase, isPlaying, isConnected, durationSeconds, trackKey])

  return active ? displaySeconds : 0
}
