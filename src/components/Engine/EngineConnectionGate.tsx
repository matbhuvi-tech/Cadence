import React, { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react'
import { useEngineController } from '../../context/EngineControllerContext'
import { CadenceLogo } from '../common/CadenceLogo'
import { isLoopbackEngineUrl, type SavedCoreProfile } from '../../services/coreControllerTransport'

export const EngineConnectionGate: React.FC = () => {
  const engine = useEngineController()
  const { state, isBootstrapping } = engine
  const connection = state.startupConnection
  const detailsProfile = connection?.profile ?? state.savedCores[0]

  const [addressInput, setAddressInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [showManualForm, setShowManualForm] = useState(() => state.savedCores.length === 0)
  const [probeError, setProbeError] = useState<string | null>(null)

  const probeAddress = async (target: Parameters<typeof engine.probeAndStageAddress>[0]) => {
    engine.cancelStartupConnection()
    setProbeError(null)
    const result = await engine.probeAndStageAddress(target)
    if (!result.ok) setProbeError(result.error ?? 'Unable to verify the engine endpoint.')
  }

  const handleProbe = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!addressInput.trim()) return
    await probeAddress({
      baseUrl: addressInput.trim(),
      label: labelInput.trim() || undefined,
      trustInsecure: true,
    })
  }

  const handleConnectSaved = async (profile: SavedCoreProfile) => {
    setProbeError(null)
    await engine.switchToSavedCore(profile)
  }

  const handleRetryLast = async () => {
    setProbeError(null)
    await engine.retryStartupConnection()
  }

  const handleSwitchEngine = () => {
    engine.cancelStartupConnection()
    setProbeError(null)
    setShowManualForm(true)
    void engine.discoverCores()
  }

  const errorBanner = probeError || (connection?.error ? null : state.stagingError || state.lastError)

  return (
    <div className="flex-1 flex items-center justify-center bg-[#0A0B0F] text-[#F1F5F9] p-6 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-white/[0.08] bg-[#101219] p-7 shadow-2xl space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-b from-[#1E2026] to-[#0C0D10] border border-[#D4AF37]/35 flex items-center justify-center text-[#D4AF37] shrink-0">
              <CadenceLogo variant="gold" className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">
                Connect to a Cadence Playback Engine
              </h1>
              <p className="text-xs text-[#98A2B3] mt-0.5">
                Connect to Playback Engine to browse, curate, or play music.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleRetryLast()}
              disabled={state.isBusy || isBootstrapping || connection?.phase === 'waiting' || connection?.phase === 'checking'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/[0.08] cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${state.isBusy ? 'animate-spin' : ''}`} />
              <span>Retry</span>
            </button>
            <button
              type="button"
              onClick={handleSwitchEngine}
              disabled={state.isDiscovering || state.isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4AF37]/35 bg-[#D4AF37]/10 px-3 py-1.5 text-xs font-medium text-[#D4AF37] hover:bg-[#D4AF37]/20 cursor-pointer disabled:opacity-50"
            >
              {state.isDiscovering ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Wifi className="w-3.5 h-3.5" />
              )}
              <span>Switch Engine</span>
            </button>
          </div>
        </div>

        {(isBootstrapping || connection) && (
          <div role="status" className={`rounded-xl border border-white/[0.08] bg-black/35 px-4 py-3 text-xs text-white/75 transition-opacity duration-200 motion-reduce:transition-none ${connection?.phase === 'ready' ? 'opacity-0' : 'opacity-100'}`}>
            {connection?.phase === 'ready'
              ? 'Engine ready. Opening library…'
              : connection?.phase === 'failed'
              ? (connection.error ?? 'Could not connect to the saved engine.') + ' Retry or switch engines.'
              : connection
                ? `Waiting for ${connection.profile.label} (attempt ${connection.attempt} of 4)`
                : 'Checking saved engines and the local network…'}
          </div>
        )}

        {detailsProfile && (
          <details className="text-xs text-white/65">
            <summary className="cursor-pointer">Connection Details</summary>
            <div className="mt-2 space-y-1 break-all">
              <p>{isLoopbackEngineUrl(detailsProfile.baseUrl) ? 'Loopback' : 'Network'} · {detailsProfile.baseUrl}</p>
              <p>{connection?.phase === 'ready' ? 'HTTPS fingerprint verified' : detailsProfile.certFingerprint ? 'HTTPS fingerprint pinned' : 'No HTTPS fingerprint saved'}</p>
            </div>
          </details>
        )}

        {errorBanner && !isBootstrapping && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-rose-500/35 bg-rose-950/35 px-4 py-3 text-xs text-rose-200"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{errorBanner}</span>
          </div>
        )}

        {/* Saved Playback Engines */}
        {state.savedCores.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
              Saved Engines
            </h2>
            <div className="space-y-2">
              {state.savedCores.map((profile) => (
                <div
                  key={`${profile.engineId}:${profile.libraryId}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-black/30 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Server className="w-4 h-4 text-[#D4AF37] shrink-0" />
                      <span className="text-sm font-medium text-white truncate">
                        {profile.label}
                      </span>
                      {profile.pinnedOutputLabel && (
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/65">
                          {profile.pinnedOutputLabel}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-white/45 mt-1 truncate">
                      {profile.baseUrl}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        engine.cancelStartupConnection()
                        void handleConnectSaved(profile)
                      }}
                      disabled={state.isBusy}
                      className="rounded-lg bg-[#D4AF37] px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-[#E0BE52] cursor-pointer disabled:opacity-50"
                    >
                      Connect
                    </button>
                    <button
                      type="button"
                      onClick={() => engine.removeSavedCore(profile.engineId, profile.libraryId)}
                      title="Remove saved engine"
                      className="p-1.5 rounded-lg border border-white/10 text-white/50 hover:text-rose-300 hover:border-rose-500/30 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* LAN Discovered Nodes */}
        {state.discoveredCores.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
              Discovered on Local Network
            </h2>
            <div className="space-y-2">
              {state.discoveredCores.map((node) => (
                <div
                  key={node.baseUrl}
                  className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-950/15 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Wifi className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-sm font-medium text-white truncate">{node.label}</span>
                    </div>
                    <p className="text-[11px] font-mono text-white/50 mt-0.5 truncate">
                      {node.baseUrl}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAddressInput(node.baseUrl)
                      setLabelInput(node.label)
                      void probeAddress({
                        baseUrl: node.baseUrl,
                        label: node.label,
                        certFingerprint: node.certFingerprint,
                        pairingToken: node.pairingToken,
                        trustInsecure: !node.certFingerprint,
                      })
                    }}
                    className="rounded-lg border border-emerald-400/35 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25 cursor-pointer"
                  >
                    Select
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Staged Candidate Verification */}
        {state.stagedCandidate && (
          <section className="rounded-xl border border-[#D4AF37]/35 bg-[#D4AF37]/10 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
                  <span>{state.stagedCandidate.descriptor.label}</span>
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
                    Protocol v{state.stagedCandidate.descriptor.protocolVersion}
                  </span>
                </div>
                <p className="text-xs text-white/70 font-mono">
                  {state.stagedCandidate.profile.baseUrl} · Output:{' '}
                  {state.stagedCandidate.snapshot.output?.label ?? 'Unassigned'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => engine.cancelStaging()}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/75 hover:bg-white/[0.06] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void engine.activateStagedCore()}
                  disabled={state.isBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#D4AF37] px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-[#E0BE52] cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Open Library</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Add Engine by IP / Address */}
        <section className="space-y-3 pt-1 border-t border-white/[0.08]">
          <button
            type="button"
            onClick={() => setShowManualForm((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#D4AF37] hover:underline cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{showManualForm ? 'Hide manual engine form' : 'Add Engine by IP / Address'}</span>
          </button>

          {showManualForm && (
            <form onSubmit={(e) => void handleProbe(e)} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="gate-address-input" className="block text-[11px] font-medium text-white/60 mb-1">
                  Engine Address (e.g. 192.168.1.6:4040)
                </label>
                <input
                  id="gate-address-input"
                  type="text"
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                  placeholder="https://192.168.1.6:4040"
                  required
                  className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-xs text-white placeholder-white/30 focus:border-[#D4AF37]/50 focus:outline-none font-mono"
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="gate-label-input" className="block text-[11px] font-medium text-white/60 mb-1">
                  Display Name (optional)
                </label>
                <input
                  id="gate-label-input"
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  placeholder="Music Room Core"
                  className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-xs text-white placeholder-white/30 focus:border-[#D4AF37]/50 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2 flex items-center justify-end gap-3 pt-1">
                <button
                  type="submit"
                  disabled={state.isBusy || !addressInput.trim()}
                  className="rounded-lg bg-white/10 border border-white/15 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 cursor-pointer disabled:opacity-50"
                >
                  {state.isBusy ? 'Checking…' : 'Verify & Connect'}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  )
}
