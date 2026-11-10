import React, { useEffect, useId, useRef, useState } from 'react'
import { Activity, KeyRound, Settings, SlidersHorizontal, X } from 'lucide-react'
import type { CatalogProblemSummary, PrioritySettings } from '../../core/curatePriorities'
import { DebugDiagnosticsPanel } from '../CommandBar/DebugDiagnosticsPanel'
import { CuratePrioritySettingsForm } from '../Curate/CuratePriorityPopover'
import { GeminiConfigForm } from '../GeminiSetupScreen'

export type CadenceSettingsTab = 'diagnostics' | 'priorities' | 'gemini'

interface CadenceSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  initialTab?: CadenceSettingsTab
  prioritySettings: PrioritySettings
  prioritySummary: CatalogProblemSummary
  onSavePrioritySettings: (settings: PrioritySettings) => void
  onGeminiSaved?: () => void
  onGeminiRemoved?: () => void
}

const TABS: Array<{ id: CadenceSettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'diagnostics', label: 'Diagnostics & Debug Logs', icon: Activity },
  { id: 'priorities', label: 'Priority Settings', icon: SlidersHorizontal },
  { id: 'gemini', label: 'Gemini API Key', icon: KeyRound },
]

/**
 * Unified always-accessible Cadence Settings dialog built with native `<dialog>` top-layer semantics.
 */
export const CadenceSettingsModal: React.FC<CadenceSettingsModalProps> = ({
  isOpen,
  onClose,
  initialTab = 'diagnostics',
  prioritySettings,
  prioritySummary,
  onSavePrioritySettings,
  onGeminiSaved,
  onGeminiRemoved,
}) => {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const dialogRef = useRef<HTMLDialogElement>(null)
  const tabRefs = useRef<Record<CadenceSettingsTab, HTMLButtonElement | null>>({
    diagnostics: null,
    priorities: null,
    gemini: null,
  })
  const [activeTab, setActiveTab] = useState<CadenceSettingsTab>(initialTab)

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab)
    }
  }, [isOpen, initialTab])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen) {
      if (!dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal()
      }
    } else if (dialog.open && typeof dialog.close === 'function') {
      dialog.close()
    }
  }, [isOpen])

  // Fallback outside click-to-dismiss only where HTMLDialogElement `closedby` is unsupported.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !isOpen || 'closedBy' in HTMLDialogElement.prototype) return

    let pressedOutside = false
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }

    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close()
      }
      pressedOutside = false
    }

    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('pointerup', onPointerUp)
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('pointerup', onPointerUp)
    }
  }, [isOpen])

  const selectTabByIndex = (idx: number) => {
    const bounded = (idx + TABS.length) % TABS.length
    const nextTab = TABS[bounded].id
    setActiveTab(nextTab)
    const button = tabRefs.current[nextTab]
    button?.focus()
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      {...({ closedby: 'any' } as Record<string, unknown>)}
      className="cadence-modal m-auto w-[min(46rem,calc(100vw-2rem))] max-h-[85vh] rounded-2xl border border-white/[0.12] bg-[#101218] p-0 text-white shadow-2xl"
    >
      {isOpen && (
        <div className="flex max-h-[85vh] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#141720] px-6 py-4 shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#D4AF37]/30 bg-[#D4AF37]/10 text-[#D4AF37]">
                <Settings className="h-4.5 w-4.5" />
              </div>
              <div>
                <h1 id={titleId} className="text-base font-semibold tracking-wide text-white">
                  Cadence Settings
                </h1>
                <p className="text-xs text-white/50">
                  Diagnostics logging, metadata triage priorities, and Gemini configuration
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close Cadence Settings"
              onClick={onClose}
              className="rounded-lg p-1.5 text-white/50 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div
            role="tablist"
            aria-label="Cadence Settings sections"
            className="flex flex-nowrap overflow-x-auto border-b border-white/[0.08] bg-[#12141B] px-6 shrink-0"
          >
            {TABS.map((tab, idx) => {
              const Icon = tab.icon
              const selected = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el
                  }}
                  id={`${baseId}-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight') {
                      e.preventDefault()
                      selectTabByIndex(idx + 1)
                    } else if (e.key === 'ArrowLeft') {
                      e.preventDefault()
                      selectTabByIndex(idx - 1)
                    } else if (e.key === 'Home') {
                      e.preventDefault()
                      selectTabByIndex(0)
                    } else if (e.key === 'End') {
                      e.preventDefault()
                      selectTabByIndex(TABS.length - 1)
                    }
                  }}
                  className={`cadence-settings-tab flex-none flex items-center gap-2 px-4 py-3 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    selected ? 'text-[#D4AF37]' : 'text-white/60 hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-diagnostics`}
              hidden={activeTab !== 'diagnostics'}
            >
              <div className="rounded-xl border border-white/[0.08] bg-black/35 p-4">
                <h2 className="mb-1 text-sm font-semibold text-white">Diagnostics &amp; Debug Logs</h2>
                <p className="mb-4 text-xs text-white/50">
                  Zero-allocation lock-free ring buffer for troubleshooting discovery, endpoint routing, playback commands, and audio hygiene.
                </p>
                <DebugDiagnosticsPanel isActive={isOpen && activeTab === 'diagnostics'} />
              </div>
            </div>

            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-priorities`}
              hidden={activeTab !== 'priorities'}
            >
              <div className="rounded-xl border border-white/[0.08] bg-black/35 p-4">
                <h2 className="mb-1 text-sm font-semibold text-white">Priority Settings</h2>
                <p className="mb-3 text-xs text-white/50">
                  Assign urgency tiers for Curate metadata issue detection and album ranking.
                </p>
                <CuratePrioritySettingsForm
                  settings={prioritySettings}
                  summary={prioritySummary}
                  resetDraftSignal={isOpen && activeTab === 'priorities'}
                  onSave={onSavePrioritySettings}
                />
              </div>
            </div>

            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-gemini`}
              hidden={activeTab !== 'gemini'}
            >
              <div className="rounded-xl border border-white/[0.08] bg-black/35 p-4">
                <h2 className="mb-1 text-sm font-semibold text-white">Gemini API Key &amp; Model</h2>
                <p className="mb-4 text-xs text-white/50">
                  Manage the encrypted Gemini API key and model used for musicology enrichment and album provenance.
                </p>
                <GeminiConfigForm
                  isConfigured
                  compact
                  onConfigured={() => onGeminiSaved?.()}
                  onRemoved={onGeminiRemoved}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </dialog>
  )
}

