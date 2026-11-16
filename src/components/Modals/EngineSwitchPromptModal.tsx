import React, { useEffect, useId, useRef } from 'react'
import { AlertTriangle, Laptop, Server, Speaker, X } from 'lucide-react'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { getEndpointDisplayName } from '../../core/endpointRouting'

/**
 * Explicit user choice modal for switching between This PC and Cadence Core,
 * or coordinating UPnP renderer release/takeover.
 */
export const EngineSwitchPromptModal: React.FC = () => {
  const engine = useOptionalEngineController()
  const prompt = engine?.state.switchPrompt ?? null
  const isBusy = engine?.state.isBusy ?? false
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (prompt) {
      if (!dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal()
      }
    } else if (dialog.open && typeof dialog.close === 'function') {
      dialog.close()
    }
  }, [prompt])

  if (!prompt || !engine) return null

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => engine.dismissSwitchPrompt()}
      className="cadence-modal m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-white/[0.12] bg-[#101218] p-0 text-white shadow-2xl"
    >
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#D4AF37]/30 bg-[#D4AF37]/10 text-[#D4AF37] shrink-0">
              {prompt.kind === 'rs130_takeover' || prompt.kind === 'external_rs130_takeover' ? (
                <Speaker className="h-4 w-4" aria-hidden="true" />
              ) : prompt.kind === 'local_to_core' ? (
                <Server className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Laptop className="h-4 w-4" aria-hidden="true" />
              )}
            </div>
            <div>
              <h2 id={titleId} className="text-sm font-semibold text-white">
                {prompt.kind === 'local_to_core'
                  ? `Local playback is ${prompt.sourceActivity}`
                  : prompt.kind === 'core_to_local'
                    ? `${prompt.coreLabel} is ${prompt.sourceActivity}`
                    : prompt.kind === 'external_rs130_takeover'
                      ? 'RS130 is Playing via HiFi ROSE'
                      : 'Coordinate Renderer Takeover'}
              </h2>
              <p className="mt-1 text-xs text-white/65 leading-relaxed">
                {prompt.kind === 'local_to_core'
                  ? `Stop playback on This PC before switching to ${prompt.target.label}, or keep listening here.`
                  : prompt.kind === 'core_to_local'
                    ? `Choose whether ${prompt.coreLabel} should keep playing in the background or stop before returning to This PC. Local audio will not start automatically.`
                    : prompt.kind === 'external_rs130_takeover'
                      ? `${prompt.coreLabel} observed active external playback on the RS130. Keep HiFi ROSE playing undisturbed, or confirm takeover to play your selected track.`
                      : `${getEndpointDisplayName(prompt.endpoint)} is currently associated with ${prompt.coreLabel}. Confirm before claiming it from This PC.`}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Cancel engine switch"
            onClick={() => engine.dismissSwitchPrompt()}
            className="rounded-lg p-1 text-white/50 hover:bg-white/[0.08] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
          <span>
            {prompt.kind === 'local_to_core'
              ? 'This PC must confirm idle state before Core activation completes.'
              : prompt.kind === 'core_to_local'
                ? 'Switching to This PC restores your local view with local playback stopped.'
                : prompt.kind === 'external_rs130_takeover'
                  ? 'Declining leaves existing RS130 playback completely undisturbed and does not import or replace the external queue.'
                  : 'Merely browsing engines never seizes an active UPnP renderer.'}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {prompt.kind === 'local_to_core' && (
            <>
              <button
                type="button"
                onClick={() => engine.dismissSwitchPrompt()}
                className="rounded-xl border border-white/15 bg-white/[0.06] px-3.5 py-2 text-xs font-medium text-white hover:bg-white/[0.12] cursor-pointer"
              >
                Keep listening here
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void engine.confirmLocalToCoreSwitch()}
                className="rounded-xl bg-[#D4AF37] px-3.5 py-2 text-xs font-semibold text-black hover:bg-[#D4AF37]/90 cursor-pointer disabled:opacity-50"
              >
                Stop this PC and use Core
              </button>
            </>
          )}

          {prompt.kind === 'core_to_local' && (
            <>
              <button
                type="button"
                onClick={() => engine.dismissSwitchPrompt()}
                className="rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2 text-xs font-medium text-white/80 hover:bg-white/[0.1] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void engine.confirmLeaveCore('stop_before_switch')}
                className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/25 cursor-pointer disabled:opacity-50"
              >
                Stop Core playback and switch
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void engine.confirmLeaveCore('leave_core_playing')}
                className="rounded-xl bg-[#D4AF37] px-3.5 py-2 text-xs font-semibold text-black hover:bg-[#D4AF37]/90 cursor-pointer disabled:opacity-50"
              >
                Keep Core playing and switch
              </button>
            </>
          )}

          {prompt.kind === 'rs130_takeover' && (
            <>
              <button
                type="button"
                onClick={() => engine.dismissSwitchPrompt()}
                className="rounded-xl border border-white/15 bg-white/[0.06] px-3.5 py-2 text-xs font-medium text-white hover:bg-white/[0.12] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void engine.confirmRs130Takeover()}
                className="rounded-xl bg-[#D4AF37] px-3.5 py-2 text-xs font-semibold text-black hover:bg-[#D4AF37]/90 cursor-pointer disabled:opacity-50"
              >
                Release from Core &amp; Use on This PC
              </button>
            </>
          )}

          {prompt.kind === 'external_rs130_takeover' && (
            <>
              <button
                type="button"
                onClick={() => engine.dismissSwitchPrompt()}
                className="rounded-xl border border-white/15 bg-white/[0.06] px-3.5 py-2 text-xs font-medium text-white hover:bg-white/[0.12] cursor-pointer"
              >
                Keep HiFi ROSE
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void engine.confirmRs130Takeover()}
                className="rounded-xl bg-[#D4AF37] px-3.5 py-2 text-xs font-semibold text-black hover:bg-[#D4AF37]/90 cursor-pointer disabled:opacity-50"
              >
                Take Over RS130 &amp; Play
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}
