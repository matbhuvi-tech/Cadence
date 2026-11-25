import React from 'react'
import { afterEach, vi } from 'vitest'

if (typeof (globalThis as Record<string, unknown>).React === 'undefined') {
  ;(globalThis as Record<string, unknown>).React = React
}

afterEach(() => {
  vi.restoreAllMocks()
})
