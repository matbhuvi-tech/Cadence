import { useState, useEffect, useCallback, useRef } from 'react'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { tauriBridge, MaintenanceStats } from '../services/tauriBridge'

function isSameMaintenanceStats(a: MaintenanceStats | null, b: MaintenanceStats | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.isRunning === b.isRunning &&
    a.isIdle === b.isIdle &&
    a.cachedCount === b.cachedCount &&
    a.notFoundCount === b.notFoundCount &&
    a.failedCount === b.failedCount &&
    a.totalItems === b.totalItems &&
    a.pendingItems === b.pendingItems &&
    a.statusMessage === b.statusMessage
  )
}

export function useMaintenanceWorker(enabled: boolean = true) {
  const [maintenanceStats, setMaintenanceStats] = useState<MaintenanceStats | null>(null)
  const statsRef = useRef<MaintenanceStats | null>(null)
  statsRef.current = maintenanceStats

  const refreshStats = useCallback(async () => {
    try {
      const stats = await tauriBridge.getMaintenanceStats()
      if (stats) {
        setMaintenanceStats((prev) => (isSameMaintenanceStats(prev, stats) ? prev : stats))
      }
    } catch (err) {
      console.warn('[useMaintenanceWorker] Failed to fetch maintenance stats:', err)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return

    let isMounted = true
    let unlistenProgress: UnlistenFn | null = null

    // 1. Initial fetch
    refreshStats()

    // 2. Event listener for portrait-sync-progress to get immediate reactive updates
    if (tauriBridge.isTauri()) {
      listen('portrait-sync-progress', () => {
        if (isMounted) {
          refreshStats()
        }
      })
        .then((unlisten) => {
          if (isMounted) {
            unlistenProgress = unlisten
          } else {
            unlisten()
          }
        })
        .catch(() => {})
    }

    // 3. Poll only while background artwork maintenance actually has pending work and audio is idle.
    const interval = setInterval(() => {
      const cur = statsRef.current
      if (isMounted && cur?.isRunning && cur.isIdle && cur.pendingItems > 0) {
        refreshStats()
      }
    }, 3000)

    return () => {
      isMounted = false
      clearInterval(interval)
      if (unlistenProgress) {
        unlistenProgress()
      }
    }
  }, [enabled, refreshStats])

  return { maintenanceStats, refreshStats }
}
