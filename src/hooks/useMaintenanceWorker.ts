import { useState, useEffect, useCallback } from 'react'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { tauriBridge, MaintenanceStats } from '../services/tauriBridge'

export function useMaintenanceWorker(enabled: boolean = true) {
  const [maintenanceStats, setMaintenanceStats] = useState<MaintenanceStats | null>(null)

  const refreshStats = useCallback(async () => {
    try {
      const stats = await tauriBridge.getMaintenanceStats()
      if (stats) {
        setMaintenanceStats(stats)
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

    // 3. 3-second polling interval (only runs while enabled)
    const interval = setInterval(() => {
      if (isMounted) {
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
