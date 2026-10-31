import { useState, useEffect, useRef } from 'react'

export type SubToolbarTier = 'wide' | 'compact' | 'popover'

export interface ContainerBreakpointState {
  tier: SubToolbarTier
  containerWidth: number
  isUltrawide: boolean
}

/**
 * useContainerBreakpoint
 *
 * Measures the physical rendered width of a container element (e.g. DataCanvas content canvas)
 * and maps it into calibrated responsive tiers:
 * - 'wide' (>= 960px): Full inline labels, full dropdowns, and button groups.
 * - 'compact' (820px <= width < 960px): Tooltipped icon-only mutation triggers.
 * - 'popover' (< 820px): Consolidated single Apple HIG popover trigger.
 * - 'isUltrawide' (>= 2200px container width or >= 2560px screen width): Activates 3-pane workbench and max-width layout constraints.
 */
export function useContainerBreakpoint<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T | null>(null)
  const [state, setState] = useState<ContainerBreakpointState>({
    tier: 'wide',
    containerWidth: 1200,
    isUltrawide: false,
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateMetrics = (width: number) => {
      let tier: SubToolbarTier = 'wide'
      if (width < 820) {
        tier = 'popover'
      } else if (width < 960) {
        tier = 'compact'
      }

      const isUltrawide = width >= 2200 || (typeof window !== 'undefined' && window.innerWidth >= 2560)

      setState({
        tier,
        containerWidth: width,
        isUltrawide,
      })
    }

    // Initial sync
    updateMetrics(el.getBoundingClientRect().width || el.clientWidth || 1200)

    // ResizeObserver setup
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentBoxSize && entry.contentBoxSize[0]) {
          updateMetrics(entry.contentBoxSize[0].inlineSize)
        } else {
          updateMetrics(entry.contentRect.width)
        }
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { containerRef, ...state }
}

