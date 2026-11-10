import React, { useId, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  DEFAULT_PRIORITY_SETTINGS, type CatalogProblemSummary, type CuratePriorityTier,
  type CurateProblemCategoryId, type PrioritySettings,
} from '../../core/curatePriorities'

import { tiers, labels, categoryIds } from './curateProblemLabels'

// oxlint-disable-next-line react/only-export-components
export function updatePrioritySettingsDraft(
  draft: PrioritySettings, category: CurateProblemCategoryId, nextTier: CuratePriorityTier,
): PrioritySettings {
  return { ...draft, [category]: nextTier }
}

interface CuratePrioritySettingsFormProps {
  settings: PrioritySettings
  summary: CatalogProblemSummary
  onSave: (settings: PrioritySettings) => void
  onCancel?: () => void
}

/**
 * Shared form for editing Curate problem-priority tiers without duplicating validation/draft logic.
 * Pass a fresh `key` when opening the parent dialog/popover to reset draft state cleanly.
 */
export function CuratePrioritySettingsForm({
  settings,
  summary,
  onSave,
  onCancel,
}: CuratePrioritySettingsFormProps) {
  const [draft, setDraft] = useState(settings)
  const [saveError, setSaveError] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        try {
          onSave(draft)
          setSaveError(false)
          setSavedNotice(true)
        } catch {
          setSaveError(true)
          setSavedNotice(false)
        }
      }}
    >
      <div className="divide-y divide-white/10 text-xs">
        {categoryIds.map((category) => {
          const { count, unit } = summary.categoryCounts[category]
          return (
            <label key={category} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-2">
              <span className="text-zinc-200">{labels[category]}</span>
              <span className="text-zinc-400">
                {count} {count === 1 ? unit.slice(0, -1) : unit}
              </span>
              <select
                aria-label={labels[category]}
                className="rounded border border-white/15 bg-[#121318] px-1.5 py-1 text-white"
                value={draft[category]}
                onChange={(event) => {
                  setSavedNotice(false)
                  setDraft((current) =>
                    updatePrioritySettingsDraft(
                      current,
                      category,
                      event.target.value as CuratePriorityTier,
                    ),
                  )
                }}
              >
                {tiers.map((tier) => (
                  <option key={tier}>{tier}</option>
                ))}
              </select>
            </label>
          )
        })}
        <p className="flex flex-wrap justify-between gap-2 py-3 text-xs">
          <span className="text-zinc-300">Valid album artist and no composer</span>
          <span className="text-zinc-400">{summary.infoExemptCount} · Info · Exempt</span>
        </p>
      </div>
      {saveError && (
        <p role="alert" className="mb-2 text-xs text-rose-300">
          Could not save priorities. Try again.
        </p>
      )}
      {savedNotice && (
        <p role="status" className="mb-2 text-xs text-emerald-300">
          Priority settings saved.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 pt-3 text-xs">
        <button
          type="button"
          onClick={() => {
            setDraft(DEFAULT_PRIORITY_SETTINGS)
            setSavedNotice(false)
          }}
          className="mr-auto rounded px-2 py-1.5 text-zinc-300 hover:bg-white/10 cursor-pointer"
        >
          Reset to Default
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded px-2 py-1.5 hover:bg-white/10 cursor-pointer">
            Cancel
          </button>
        )}
        <button type="submit" className="rounded bg-amber-400 px-3 py-1.5 font-medium text-black hover:bg-amber-300 cursor-pointer">
          Save priorities
        </button>
      </div>
    </form>
  )
}

interface CuratePriorityPopoverProps {
  settings: PrioritySettings
  summary: CatalogProblemSummary
  onSave: (settings: PrioritySettings) => void
}

export function CuratePriorityPopover({ settings, summary, onSave }: CuratePriorityPopoverProps) {
  const id = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [openCounter, setOpenCounter] = useState(0)

  const close = () => {
    popoverRef.current?.hidePopover()
    triggerRef.current?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        popoverTarget={id}
        onClick={() => setOpenCounter((c) => c + 1)}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70 hover:text-white"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Priority Settings
      </button>
      <div
        ref={popoverRef}
        id={id}
        popover="auto"
        data-curate-priority-popover
        role="dialog"
        aria-labelledby={`${id}-title`}
        className="fixed inset-auto top-24 right-6 m-0 max-h-[calc(100vh-7rem)] w-[min(28rem,calc(100vw-3rem))] overflow-y-auto rounded-xl border border-white/15 bg-[#1C1C1E] p-4 text-white shadow-2xl"
      >
        <h2 id={`${id}-title`} className="pb-3 text-sm font-semibold">Priority Settings</h2>
        <CuratePrioritySettingsForm
          key={`${openCounter}-${JSON.stringify(settings)}`}
          settings={settings}
          summary={summary}
          onCancel={close}
          onSave={(next) => {
            onSave(next)
            close()
          }}
        />
      </div>
    </>
  )
}
