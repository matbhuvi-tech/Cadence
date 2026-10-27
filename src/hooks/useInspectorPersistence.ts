import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'cadence_curate_inspector_collapsed'

/**
 * Hook to manage and persist right-panel inspector collapse state.
 * Defaults to collapsed on viewport width < 1600px, persisting explicit user toggles in localStorage.
 */
export function useInspectorPersistence(defaultCollapseBreakpoint = 1600) {
  const [isCollapsed, setIsCollapsedState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved !== null) {
        return saved === 'true'
      }
    } catch {
      // Fallback if localStorage is inaccessible
    }
    return typeof window !== 'undefined' ? window.innerWidth < defaultCollapseBreakpoint : false
  })

  const setIsCollapsed = useCallback((collapsed: boolean | ((prev: boolean) => boolean)) => {
    setIsCollapsedState((prev) => {
      const next = typeof collapsed === 'function' ? collapsed(prev) : collapsed
      try {
        localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // Ignore quota/access errors
      }
      return next
    })
  }, [])

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev)
  }, [setIsCollapsed])

  return {
    isCollapsed,
    setIsCollapsed,
    toggleCollapse,
  }
}
