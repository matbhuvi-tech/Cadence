import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CadenceSettingsModal } from './CadenceSettingsModal'
import { DEFAULT_PRIORITY_SETTINGS, evaluateCatalogProblems } from '../../core/curatePriorities'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(true),
}))

const emptySummary = evaluateCatalogProblems([], [], DEFAULT_PRIORITY_SETTINGS)

describe('CadenceSettingsModal', () => {
  it('opens on initialTab and switches tabs via click and keyboard navigation', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <CadenceSettingsModal
        isOpen
        onClose={onClose}
        initialTab="diagnostics"
        prioritySettings={DEFAULT_PRIORITY_SETTINGS}
        prioritySummary={emptySummary}
        onSavePrioritySettings={vi.fn()}
      />,
    )

    const tablist = screen.getByRole('tablist', { name: 'Cadence Settings sections' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Debug Logging \(Idle Persistence\)/i)).toBeVisible()

    // Click to switch to Priority Settings tab
    await user.click(screen.getByRole('tab', { name: /Priority Settings/i }))
    expect(screen.getByRole('tab', { name: /Priority Settings/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /Save priorities/i })).toBeVisible()

    // Keyboard navigation: ArrowRight -> Gemini, Home -> Diagnostics, End -> Gemini
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /Gemini API Key/i })).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: /Diagnostics & Debug Logs/i })).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: /Gemini API Key/i })).toHaveAttribute('aria-selected', 'true')

    // Close button invokes onClose
    await user.click(screen.getByRole('button', { name: 'Close Cadence Settings' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('allows changing a priority category and saving updated priority settings', async () => {
    const user = userEvent.setup()
    const onSavePrioritySettings = vi.fn()

    render(
      <CadenceSettingsModal
        isOpen
        onClose={vi.fn()}
        initialTab="priorities"
        prioritySettings={DEFAULT_PRIORITY_SETTINGS}
        prioritySummary={emptySummary}
        onSavePrioritySettings={onSavePrioritySettings}
      />,
    )

    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(14)

    const firstSelect = selects[0] as HTMLSelectElement
    const nextValue = firstSelect.value === 'P0' ? 'P1' : 'P0'
    await user.selectOptions(firstSelect, nextValue)
    expect(firstSelect.value).toBe(nextValue)

    await user.click(screen.getByRole('button', { name: /Save priorities/i }))
    expect(onSavePrioritySettings).toHaveBeenCalledTimes(1)
    expect(onSavePrioritySettings).toHaveBeenCalledWith(expect.any(Object))
  })
})
