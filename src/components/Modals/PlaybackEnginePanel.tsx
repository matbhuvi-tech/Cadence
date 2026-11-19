import React, { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Laptop,
  RefreshCw,
  Server,
  ShieldCheck,
  Speaker,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { useOptionalAudioPlayer } from '../../context/AudioPlayerContext'
import { getEndpointDisplayName } from '../../core/endpointRouting'
import { isLoopbackEngineUrl, type SavedCoreProfile } from '../../services/coreControllerTransport'

interface PlaybackEnginePanelProps {
  onEngineActivated?: () => void
}

export const PlaybackEnginePanel: React.FC<PlaybackEnginePanelProps> = ({ onEngineActivated }) => {
  const engine = useOptionalEngineController()
  const audio = useOptionalAudioPlayer()

  const [addressInput, setAddressInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [rootsDraft, setRootsDraft] = useState('')
  const [showConnectForm, setShowConnectForm] = useState(false)

  const state = engine?.state
  const active = state?.view.session.active ?? {
    kind: 'local' as const,
    engineId: 'local',
    libraryId: 'local',
    label: 'This PC',
  }
  const isCoreActive = active.kind === 'core'
  const isConnected = state?.view.session.connected ?? true
  const snapshot = state?.view.snapshot ?? null
  const staged = state?.stagedCandidate ?? null
  const savedCores = state?.savedCores ?? []
  const discoveredCores = state?.discoveredCores ?? []
  const isDiscovering = state?.isDiscovering ?? false
  const isBusy = state?.isBusy ?? false
  const stagingError = state?.stagingError ?? null
  const lastError = state?.lastError ?? null

  const activeOutputLabel = isCoreActive
    ? snapshot?.output?.label ?? 'No output assigned on Core'
    : audio
      ? getEndpointDisplayName(audio.selectedEndpoint)
      : 'Default System Output'

  const handleCheckAndPrepare = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!engine || !addressInput.trim()) return
    const roots = rootsDraft
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    await engine.probeAndStageAddress({
      baseUrl: addressInput.trim(),
      label: labelInput.trim() || undefined,
      trustInsecure: true,
      musicRoots: roots,
    })
  }

  const handleApplyRootsToStaged = () => {
    if (!engine) return
    const roots = rootsDraft
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    engine.updateStagedMusicRoots(roots)
  }

  const handleActivateStaged = async () => {
    if (!engine) return
    await engine.activateStagedCore()
    if (engine.state.view.session.active.kind === 'core') {
      setShowConnectForm(false)
      onEngineActivated?.()
    }
  }

  const handleSelectSavedCore = async (profile: SavedCoreProfile) => {
    if (!engine) return
    await engine.switchToSavedCore(profile)
  }

  return (
    <div className="space-y-4 text-left">
      {/* Accessible Live Connection / Switch Status */}
      <div
        role="status"
        aria-live="polite"
        className={`rounded-xl border p-3.5 ${
          isCoreActive && !isConnected
            ? 'border-rose-500/40 bg-rose-950/30 text-rose-100'
            : 'border-white/[0.08] bg-black/35 text-white'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold">
              {isCoreActive ? (
                <Server className="h-4 w-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
              ) : (
                <Laptop className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
              )}
              <span>Playback engine: {active.label}</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium">
                {isCoreActive && !isConnected ? (
                  <>
                    <WifiOff className="h-3 w-3 text-rose-400" aria-hidden="true" />
                    <span>Disconnected</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                    <span>{isCoreActive ? 'Connected' : 'Ready'}</span>
                  </>
                )}
              </span>
            </div>

            <div className="flex items-center gap-2 text-xs text-white/75">
              <Speaker className="h-3.5 w-3.5 text-[#D4AF37] shrink-0" aria-hidden="true" />
              <span>Audio output: {activeOutputLabel}</span>
            </div>

            {state?.statusAnnouncement && (
              <p className="text-[11px] text-white/60">{state.statusAnnouncement}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isCoreActive && !isConnected && engine && (
              <button
                type="button"
                onClick={() => void engine.reconnectCore()}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4AF37]/40 bg-[#D4AF37]/15 px-3 py-1.5 text-xs font-medium text-[#D4AF37] hover:bg-[#D4AF37]/25 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reconnect</span>
              </button>
            )}
          </div>
        </div>

        {state?.activeProfile && (
          <details className="mt-3 text-xs text-white/65">
            <summary className="cursor-pointer">Connection Details</summary>
            <p className="mt-2 break-all">
              {isLoopbackEngineUrl(state.activeProfile.baseUrl) ? 'Loopback' : 'Network'} · {state.activeProfile.baseUrl}
            </p>
            <p>{state.activeProfile.certFingerprint
              ? (isConnected ? 'HTTPS fingerprint verified' : 'HTTPS fingerprint pinned')
              : 'No HTTPS fingerprint saved'}</p>
          </details>
        )}

        {isCoreActive && !isConnected && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-black/30 px-3 py-2 text-xs text-rose-200">
            <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>Connection lost. Playback may still be continuing.</span>
          </div>
        )}
      </div>

      {/* Error banner (never mutates active session on failure) */}
      {(stagingError || lastError) && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-500/35 bg-rose-950/30 px-3.5 py-2.5 text-xs text-rose-200"
        >
          <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{stagingError || lastError}</span>
        </div>
      )}

      {/* Available Engines: This PC + Saved Cores */}
      <div className="rounded-xl border border-white/[0.08] bg-black/35 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-white">Playback Engines</h2>
            <p className="text-xs text-white/50">
              Select a Playback Engine or pair a new Core on your NAS or PC.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowConnectForm((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4AF37]/40 bg-[#D4AF37]/15 px-3 py-1.5 text-xs font-semibold text-[#D4AF37] hover:bg-[#D4AF37]/25 cursor-pointer"
          >
            <Server className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Connect to Cadence Core</span>
          </button>
        </div>

        <div className="space-y-2">
          {/* Saved Core profiles */}
          {savedCores.map((core) => {
            const selected =
              isCoreActive &&
              active.engineId === core.engineId &&
              active.libraryId === core.libraryId
            return (
              <div
                key={`${core.engineId}:${core.libraryId}`}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 ${
                  selected
                    ? 'border-[#D4AF37]/45 bg-[#D4AF37]/[0.06]'
                    : 'border-white/[0.08] bg-white/[0.02]'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Server className="h-4 w-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white truncate">{core.label}</div>
                    <div className="text-[11px] text-white/55 font-mono truncate">
                      {core.baseUrl}
                      {core.pinnedOutputLabel ? ` · Output: ${core.pinnedOutputLabel}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selected ? (
                    <span className="rounded-full border border-[#D4AF37]/40 bg-[#D4AF37]/15 px-2.5 py-0.5 text-[10px] font-medium text-[#D4AF37]">
                      Active
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSelectSavedCore(core)}
                      disabled={isBusy}
                      className="rounded-lg border border-[#D4AF37]/40 bg-[#D4AF37]/15 px-2.5 py-1 text-xs font-medium text-[#D4AF37] hover:bg-[#D4AF37]/25 cursor-pointer"
                    >
                      Use this Core
                    </button>
                  )}
                  {!selected && engine && (
                    <button
                      type="button"
                      aria-label={`Remove saved Core ${core.label}`}
                      onClick={() => engine.removeSavedCore(core.engineId, core.libraryId)}
                      className="rounded-lg p-1.5 text-white/50 hover:bg-white/[0.08] hover:text-rose-300 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Add / Discover / Pair Core Flow */}
      {showConnectForm && (
        <div className="rounded-xl border border-white/[0.1] bg-black/45 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-white/80">
              Add &amp; Verify Cadence Core
            </h3>
            <button
              type="button"
              onClick={() => void engine?.discoverCores()}
              disabled={isDiscovering}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1 text-xs text-white hover:bg-white/[0.12] cursor-pointer disabled:opacity-50"
            >
              <Wifi className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              <span>{isDiscovering ? 'Discovering...' : 'Discover on demand'}</span>
            </button>
          </div>

          {discoveredCores.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-white/60">Discovered LAN Cores</div>
              {discoveredCores.map((node) => (
                <button
                  key={node.baseUrl}
                  type="button"
                  onClick={() => {
                    setAddressInput(node.baseUrl)
                    setLabelInput(node.label)
                  }}
                  className="w-full flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-xs hover:border-[#D4AF37]/40 cursor-pointer"
                >
                  <span className="font-medium text-white">{node.label}</span>
                  <span className="font-mono text-[11px] text-white/60">{node.baseUrl}</span>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={(e) => void handleCheckAndPrepare(e)} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="core-address-input" className="block text-[11px] text-white/70 mb-1">
                  Core Address or URL
                </label>
                <input
                  id="core-address-input"
                  type="text"
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                  placeholder="https://192.168.1.50:4040"
                  className="w-full rounded-lg border border-white/15 bg-black/50 px-3 py-1.5 text-xs font-mono text-white placeholder-white/30 focus:border-[#D4AF37] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="core-label-input" className="block text-[11px] text-white/70 mb-1">
                  Display Name (optional)
                </label>
                <input
                  id="core-label-input"
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  placeholder="Music Room Core"
                  className="w-full rounded-lg border border-white/15 bg-black/50 px-3 py-1.5 text-xs text-white placeholder-white/30 focus:border-[#D4AF37] focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  engine?.cancelStaging()
                  setShowConnectForm(false)
                }}
                className="rounded-lg border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.1] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isBusy || !addressInput.trim()}
                className="rounded-lg bg-white px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-white/90 cursor-pointer disabled:opacity-50"
              >
                {isBusy ? 'Checking Core...' : 'Check & Prepare Core'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Staged Core Preparation & Explicit Activation Card */}
      {staged && (
        <div className="rounded-xl border border-[#D4AF37]/40 bg-[#D4AF37]/[0.06] p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <ShieldCheck className="h-4 w-4 text-[#D4AF37]" aria-hidden="true" />
                <span>Ready to Activate: {staged.descriptor.label}</span>
              </div>
              <div className="text-[11px] text-white/70 font-mono">
                Engine: {staged.descriptor.engineId} · Library: {staged.descriptor.libraryId} ·{' '}
                {staged.snapshot.catalog.tracks.length} tracks
              </div>
              <div className="text-[11px] text-white/75">
                Audio output: {staged.snapshot.output?.label ?? 'None configured'}
              </div>
            </div>
          </div>

          {staged.needsMusicRoots && (
            <div className="rounded-lg border border-amber-500/30 bg-black/35 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-200">
                <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Prepare Core-visible music roots</span>
              </div>
              <p className="text-[11px] text-white/65">
                This Core catalog is currently empty. Specify Core-visible music paths (for example{' '}
                <code className="text-amber-200">/music</code>) before activating; preparing roots does
                not start an automatic scan or interrupt local playback.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={rootsDraft}
                  onChange={(e) => setRootsDraft(e.target.value)}
                  placeholder="/music"
                  aria-label="Core-visible music roots"
                  className="flex-1 rounded-lg border border-white/15 bg-black/60 px-2.5 py-1 text-xs font-mono text-white"
                />
                <button
                  type="button"
                  onClick={handleApplyRootsToStaged}
                  className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer"
                >
                  Save roots
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => engine?.cancelStaging()}
              className="rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white hover:bg-white/[0.12] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleActivateStaged()}
              disabled={isBusy}
              className="rounded-lg bg-[#D4AF37] px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-[#D4AF37]/90 cursor-pointer disabled:opacity-50"
            >
              Use this Core
            </button>
          </div>
        </div>
      )}

      {/* Progressive Disclosure: Advanced Core Diagnostics */}
      <details className="rounded-xl border border-white/[0.08] bg-black/25 p-3 text-xs text-white/70">
        <summary className="cursor-pointer font-medium text-white/85 select-none">
          Advanced Core &amp; Hardware Readiness Details
        </summary>
        <div className="mt-2.5 space-y-1.5 text-[11px] font-mono text-white/60">
          <div>Protocol version: v1 · Engine scope: {active.kind} ({active.engineId})</div>
          <div>Session revision: {snapshot?.revision ?? 0}</div>
          <div>
            Note: Controller readiness checks API protocol and trust only. Physical DAC/RS130
            qualification is verified separately per deployment.
          </div>
        </div>
      </details>
    </div>
  )
}
