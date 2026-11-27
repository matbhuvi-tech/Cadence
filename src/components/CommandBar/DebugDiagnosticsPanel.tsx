import React, { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Database,
  FileArchive,
  FolderOpen,
  Info,
  Link2,
  Mail,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react'
import {
  tauriBridge,
  CaptureMode,
  DebugLogState,
  GeneratedSupportBundle,
  SupportDiagnosticsPreview,
  SupportScenarioInfo,
  SupportSubmissionResult,
} from '../../services/tauriBridge'
import { useOptionalEngineController } from '../../context/EngineControllerContext'

const DEFAULT_SUPPORT_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbzdnWVHCUtReC9EPOYDVIvUBbZy-9IoItxPwu5JlEY0-DVz9pTYMQQ5SA3RXss9d2L_wg/exec'

const DEFAULT_BROWSER_DEBUG_STATE: DebugLogState = {
  mode: 'off',
  ringCapacity: 256,
  bufferedApprox: 0,
  droppedCount: 0,
  persistedCount: 0,
  hygieneState: 'idle',
  cooldownRemainingSecs: null,
  logFilePath: null,
  logDirPath: null,
  lastFlushError: null,
  crashLogCount: 0,
  latestCrashLog: null,
}

const FALLBACK_SCENARIOS: SupportScenarioInfo[] = [
  {
    id: 'engine_not_connecting',
    label: 'App is not connecting with playback engine',
    description: 'Desktop UI cannot reach, pair with, or stay connected to Cadence Playback Engine.',
  },
  {
    id: 'upnp_discovery_failed',
    label: 'App is not discovering UPnP or playback speakers',
    description: 'UPnP renderers, USB DACs, or audio output devices are missing.',
  },
  {
    id: 'enrichment_stuck',
    label: 'Enrichment is not working or got stuck',
    description: 'Metadata or cover art enrichment stopped progressing.',
  },
  {
    id: 'enrichment_slow',
    label: 'Enrichment is going slow',
    description: 'Album matching or artwork fetching is unusually slow.',
  },
  {
    id: 'app_crashed',
    label: 'App crashed or closed unexpectedly',
    description: 'Desktop or Playback Engine exited abruptly.',
  },
  {
    id: 'mobile_not_connecting',
    label: 'Mobile is not connecting with playback engine',
    description: 'Cadence Remote on phone/tablet cannot connect to the engine.',
  },
  {
    id: 'smb_mount_failed',
    label: 'Not able to add an SMB folder',
    description: 'Adding or mounting a network SMB/NAS share fails.',
  },
  {
    id: 'lost_library_after_upgrade',
    label: 'Lost library after upgrading playback engine',
    description: 'Tracks, playlists, or folders disappeared after updating or switching modes.',
  },
  {
    id: 'wasapi_exclusive_failed',
    label: 'WASAPI Exclusive / ASIO bit-perfect playback failed',
    description: 'Bit-perfect device initialization or sample-rate switching fails.',
  },
  {
    id: 'upnp_dropouts',
    label: 'UPnP playback stutters, drops out, or cuts off early',
    description: 'Network streaming pauses, skips, or stops mid-track.',
  },
  {
    id: 'ram_lock_admission_failed',
    label: 'Track failed to pre-load into RAM (VirtualLock / memlock)',
    description: 'Playback fails with not_ready or memory lock budget errors.',
  },
  {
    id: 'scanner_skipped_files',
    label: 'Library scan skipped files or shows wrong format',
    description: 'Some audio files are missing or DSD/PCM metadata looks wrong.',
  },
  {
    id: 'tag_commit_stuck',
    label: 'Tag writes / Curation commits are stuck or failing',
    description: 'Approved metadata changes stay queued or fail to write.',
  },
  {
    id: 'gemini_provenance_failed',
    label: 'Gemini AI / Compilation provenance resolution failed',
    description: 'AI metadata resolution or soundtrack provenance lookup returns errors.',
  },
  {
    id: 'missing_artwork',
    label: 'Album covers or artist portraits are missing',
    description: 'Releases or artists show placeholders instead of cover art.',
  },
  {
    id: 'cooldown_deadlock',
    label: "Actions keep saying 'deferred until idle' when stopped",
    description: 'Scans, discovery, or curation stay blocked after playback stops.',
  },
]

interface DebugDiagnosticsPanelProps {
  /** Whether the enclosing surface is currently visible so initial state loads on demand. */
  isActive?: boolean
}

/**
 * Shared controls and live status for lock-free Debug Logging, Diagnostic Capture Mode,
 * Self-Diagnosis, and consent-first Support Bundle export.
 */
export const DebugDiagnosticsPanel: React.FC<DebugDiagnosticsPanelProps> = ({
  isActive = true,
}) => {
  const engine = useOptionalEngineController()
  const [debugState, setDebugState] = useState<DebugLogState>(DEFAULT_BROWSER_DEBUG_STATE)
  const [engineDebugState, setEngineDebugState] = useState<DebugLogState | null>(null)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [scenarios, setScenarios] = useState<SupportScenarioInfo[]>(FALLBACK_SCENARIOS)
  const [scenarioId, setScenarioId] = useState<string>('engine_not_connecting')
  const [userNotes, setUserNotes] = useState<string>('')
  const [contactEmail, setContactEmail] = useState<string>('')
  const [webhookUrl, setWebhookUrl] = useState<string>(DEFAULT_SUPPORT_WEBHOOK_URL)
  const [webhookSource, setWebhookSource] = useState<string>('default')
  const [showWebhookConfig, setShowWebhookConfig] = useState<boolean>(false)
  const [redactPaths, setRedactPaths] = useState<boolean>(true)
  const [consentGranted, setConsentGranted] = useState<boolean>(false)
  const [bundleBusy, setBundleBusy] = useState<boolean>(false)
  const [preview, setPreview] = useState<SupportDiagnosticsPreview | null>(null)
  const [generatedBundle, setGeneratedBundle] = useState<GeneratedSupportBundle | null>(null)
  const [submissionResult, setSubmissionResult] = useState<SupportSubmissionResult | null>(null)
  const [bundleStatus, setBundleStatus] = useState<string | null>(null)

  const refreshState = useCallback(() => {
    void tauriBridge.getDebugLogState().then(setDebugState).catch(() => {})
    if (engine?.isCoreActive && engine.engineClient && engine.state.view.session.connected) {
      void engine.engineClient
        .getDiagnosticsStatus()
        .then(setEngineDebugState)
        .catch(() => setEngineDebugState(null))
    } else {
      setEngineDebugState(null)
    }
  }, [engine])

  useEffect(() => {
    if (!isActive) return
    refreshState()
    void tauriBridge
      .getSupportScenarios()
      .then((list) => {
        if (Array.isArray(list) && list.length > 0) {
          setScenarios(list)
        }
      })
      .catch(() => {})
    void tauriBridge
      .getSupportWebhookConfig()
      .then((cfg) => {
        setWebhookUrl(cfg.webhookUrl || DEFAULT_SUPPORT_WEBHOOK_URL)
        setWebhookSource(cfg.webhookUrl ? cfg.source : 'default')
      })
      .catch(() => {})
    return tauriBridge.subscribeDebugLogState(setDebugState)
  }, [isActive, refreshState])

  const handleSetMode = async (nextMode: CaptureMode) => {
    setBusy(true)
    setActionStatus(null)
    try {
      const updated = await tauriBridge.setDebugLogging(nextMode)
      setDebugState(updated)
      if (engine?.isCoreActive && engine.engineClient && engine.state.view.session.connected) {
        try {
          const engUpdated = await engine.engineClient.controlDiagnostics({
            action: 'set_mode',
            mode: nextMode,
          })
          setEngineDebugState(engUpdated)
        } catch {
          // Engine sync is best-effort when disconnected
        }
      }
    } catch (e) {
      setActionStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const gatherEngineDiagnosticContext = async () => {
    let engineSnapshot: Record<string, unknown> | null = null
    const activeEngineUrl = engine?.state.activeProfile?.baseUrl ?? null
    const activeEngineReachable = Boolean(
      engine?.isCoreActive && engine.state.view.session.connected,
    )
    const activeEngineProbeError =
      engine?.state.lastError ?? engine?.state.stagingError ?? null

    if (activeEngineReachable && engine?.engineClient) {
      try {
        engineSnapshot = await engine.engineClient.getDiagnosticsSnapshot()
      } catch {
        engineSnapshot = null
      }
    }
    return {
      activeEngineUrl,
      activeEngineReachable,
      activeEngineProbeError,
      engineSnapshot,
    }
  }

  const handleRunPreview = async () => {
    setBundleBusy(true)
    setBundleStatus(null)
    try {
      const ctx = await gatherEngineDiagnosticContext()
      const result = await tauriBridge.previewSupportDiagnostics({
        scenarioId,
        ...ctx,
      })
      if (result) {
        setPreview(result)
      } else {
        setBundleStatus('Self-diagnosis preview is only available in the desktop app.')
      }
    } catch (e) {
      setBundleStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBundleBusy(false)
    }
  }

  const handleSaveWebhookUrl = async () => {
    setBundleBusy(true)
    setBundleStatus(null)
    try {
      const saved = await tauriBridge.setSupportWebhookUrl(webhookUrl)
      setWebhookUrl(saved.webhookUrl ?? '')
      setWebhookSource(saved.source)
      setShowWebhookConfig(false)
      setBundleStatus(
        saved.webhookUrl
          ? 'Support webhook URL saved. 1-click diagnostic submission is ready.'
          : 'Cleared custom support webhook URL.',
      )
    } catch (e) {
      setBundleStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBundleBusy(false)
    }
  }

  const handleSubmitSupport = async () => {
    if (!consentGranted) return
    setBundleBusy(true)
    setBundleStatus(null)
    setSubmissionResult(null)
    try {
      const ctx = await gatherEngineDiagnosticContext()
      const result = await tauriBridge.submitSupportBundle({
        scenarioId,
        userNotes: userNotes.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        webhookUrl: webhookUrl.trim() || undefined,
        redactPaths,
        consentGranted: true,
        ...ctx,
        frontendContext: {
          isCoreActive: Boolean(engine?.isCoreActive),
          coreConnected: Boolean(engine?.state.view.session.connected),
          activeEngineLabel: engine?.state.activeProfile?.label ?? null,
        },
      })
      if (!result) {
        setBundleStatus('Direct webhook submission is only available in the desktop app.')
        return
      }
      setSubmissionResult(result)
      setGeneratedBundle(result.bundle)
      setPreview(result.bundle.preview)
      setBundleStatus(`${result.message} (Ticket: ${result.ticketId})`)
    } catch (e) {
      setBundleStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBundleBusy(false)
    }
  }

  const handleGenerateBundle = async (launchEmail: boolean) => {
    if (!consentGranted) return
    setBundleBusy(true)
    setBundleStatus(null)
    try {
      const ctx = await gatherEngineDiagnosticContext()
      const bundle = await tauriBridge.generateSupportBundle({
        scenarioId,
        userNotes: userNotes.trim() || undefined,
        redactPaths,
        consentGranted: true,
        ...ctx,
        frontendContext: {
          isCoreActive: Boolean(engine?.isCoreActive),
          coreConnected: Boolean(engine?.state.view.session.connected),
          activeEngineLabel: engine?.state.activeProfile?.label ?? null,
        },
      })
      if (!bundle) {
        setBundleStatus('Support bundle export is only available in the desktop app.')
        return
      }
      setGeneratedBundle(bundle)
      setPreview(bundle.preview)

      try {
        await tauriBridge.revealSupportBundleInFolder(bundle.zipPath)
      } catch {
        // non-fatal
      }

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(
            `To: ${bundle.emailTo}\nSubject: ${bundle.emailSubject}\n\n${bundle.emailBody}`,
          )
        } catch {
          // clipboard optional
        }
      }

      if (launchEmail && typeof window !== 'undefined') {
        window.open(bundle.mailtoUrl, '_blank', 'noopener,noreferrer')
        setBundleStatus(
          `Saved ${bundle.fileName}, highlighted it in your folder, copied the summary, and opened your email draft to ${bundle.emailTo}.`,
        )
      } else {
        setBundleStatus(
          `Saved ${bundle.fileName} and copied the diagnostic summary + ${bundle.emailTo} to your clipboard.`,
        )
      }
    } catch (e) {
      setBundleStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBundleBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-zinc-200 font-medium">Debug Logging (Idle Persistence)</div>
          <div className="text-[10px] text-white/50">
            Captures preallocated RAM events; persists to AppData only when fully idle.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Debug Logging (Idle Persistence)"
          aria-checked={debugState.mode !== 'off'}
          disabled={busy}
          onClick={() => void handleSetMode(debugState.mode === 'off' ? 'debug' : 'off')}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-60 ${
            debugState.mode !== 'off' ? 'bg-[#D4AF37]' : 'bg-white/20'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full transition ${
              debugState.mode !== 'off' ? 'translate-x-4 bg-black' : 'translate-x-0 bg-white'
            }`}
          />
        </button>
      </div>

      {debugState.mode !== 'off' && (
        <>
          <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-between gap-3">
            <div>
              <div className="text-zinc-200 font-medium">Diagnostic Capture Mode</div>
              <div className="text-[10px] text-amber-300/90">
                Relaxes audio-hygiene disk silence: flushes to AppData during active or paused playback.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Diagnostic Capture Mode"
              aria-checked={debugState.mode === 'diagnostic_capture'}
              disabled={busy}
              onClick={() =>
                void handleSetMode(
                  debugState.mode === 'diagnostic_capture' ? 'debug' : 'diagnostic_capture',
                )
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-60 ${
                debugState.mode === 'diagnostic_capture' ? 'bg-rose-500' : 'bg-white/20'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full transition ${
                  debugState.mode === 'diagnostic_capture'
                    ? 'translate-x-4 bg-white'
                    : 'translate-x-0 bg-white'
                }`}
              />
            </button>
          </div>

          {debugState.mode === 'debug' && (
            <p className="text-[10px] text-white/50 leading-relaxed">
              Idle-only persistence protects playback &amp; pause hygiene; buffered RAM events may be lost if the app crashes or is force-closed mid-playback.
            </p>
          )}

          <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] text-zinc-300 bg-black/30 p-2.5 rounded-lg border border-white/[0.05]">
            <div>Buffered: {debugState.bufferedApprox} / {debugState.ringCapacity}</div>
            <div className={debugState.droppedCount > 0 ? 'text-amber-300' : ''}>
              Dropped: {debugState.droppedCount}
            </div>
            <div>Persisted: {debugState.persistedCount}</div>
            <div>Hygiene: {debugState.hygieneState}</div>
            {engineDebugState && (
              <>
                <div className="col-span-2 pt-1 border-t border-white/[0.06] text-[#D4AF37]">
                  Playback Engine: mode={engineDebugState.mode} · persisted={engineDebugState.persistedCount} · hygiene={engineDebugState.hygieneState}
                </div>
              </>
            )}
          </div>

          {debugState.logFilePath && (
            <div className="text-[10px] text-white/45 font-mono break-all">
              Log file: {debugState.logFilePath}
            </div>
          )}

          {debugState.lastFlushError && (
            <div role="alert" className="text-[10px] text-rose-300 font-mono">
              Flush error: {debugState.lastFlushError}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-0.5 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await tauriBridge.openDebugLogFolder()
                  } catch (e) {
                    setActionStatus(e instanceof Error ? e.message : String(e))
                  }
                }}
                className="px-2.5 py-1.5 rounded bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 text-[10px] font-medium flex items-center gap-1 cursor-pointer"
              >
                <FolderOpen className="w-3 h-3" />
                <span>Open Log Folder</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const updated = await tauriBridge.flushDebugLogsIfIdle()
                    setDebugState(updated)
                    if (engine?.isCoreActive && engine.engineClient && engine.state.view.session.connected) {
                      try {
                        const eng = await engine.engineClient.controlDiagnostics({ action: 'flush_if_idle' })
                        setEngineDebugState(eng)
                      } catch {
                        // best effort
                      }
                    }
                    setActionStatus('Flushed buffered events.')
                  } catch (e) {
                    setActionStatus(e instanceof Error ? e.message : String(e))
                  }
                }}
                className="px-2.5 py-1.5 rounded bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 text-[10px] font-medium cursor-pointer"
              >
                Flush If Idle
              </button>
              <button
                type="button"
                aria-label="Refresh diagnostics status"
                onClick={refreshState}
                className="px-2 py-1.5 rounded bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 text-[10px] font-medium flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Refresh</span>
              </button>
            </div>
            <button
              type="button"
              onClick={async () => {
                const updated = await tauriBridge.clearDebugLogs()
                setDebugState(updated)
                if (engine?.isCoreActive && engine.engineClient && engine.state.view.session.connected) {
                  try {
                    const eng = await engine.engineClient.controlDiagnostics({ action: 'clear_logs' })
                    setEngineDebugState(eng)
                  } catch {
                    // best effort
                  }
                }
                setActionStatus('Logs cleared.')
              }}
              className="px-2.5 py-1.5 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-[10px] font-medium cursor-pointer"
            >
              Clear Logs
            </button>
          </div>

          {actionStatus && (
            <div className="text-[10px] text-zinc-400 font-mono">{actionStatus}</div>
          )}
        </>
      )}

      {/* Self-Diagnosis & Consent-First Support Bundle Section */}
      <div className="mt-2 pt-3 border-t border-white/[0.08] flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-zinc-100 font-semibold text-xs flex items-center gap-1.5">
              <FileArchive className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>Self-Diagnosis &amp; Support Bundle</span>
            </div>
            <div className="text-[10px] text-white/50 mt-0.5">
              Inspect local health &amp; library databases, or package redacted logs on consent for{' '}
              <span className="text-zinc-300 font-mono">matbhuvitech@gmail.com</span>.
            </div>
          </div>
          {(debugState.crashLogCount ?? 0) > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-200 text-[10px] font-medium shrink-0">
              {debugState.crashLogCount} Crash Log(s)
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cadence-support-scenario" className="text-[10px] text-zinc-400 font-medium">
            What issue are you experiencing?
          </label>
          <select
            id="cadence-support-scenario"
            aria-label="Issue scenario"
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            className="w-full rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-[#D4AF37] focus:outline-none"
          >
            {scenarios.map((sc) => (
              <option key={sc.id} value={sc.id} className="bg-[#12141b] text-zinc-100">
                {sc.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="cadence-support-notes" className="text-[10px] text-zinc-400 font-medium">
            Optional notes (steps to reproduce, speaker model, NAS type)
          </label>
          <textarea
            id="cadence-support-notes"
            aria-label="Issue details"
            rows={2}
            value={userNotes}
            onChange={(e) => setUserNotes(e.target.value)}
            placeholder="Describe what happened right before the issue..."
            className="w-full rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[11px] text-zinc-100 placeholder:text-white/30 focus:border-[#D4AF37] focus:outline-none resize-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="cadence-support-contact" className="text-[10px] text-zinc-400 font-medium">
            Your email (optional, if you&apos;d like a reply)
          </label>
          <input
            id="cadence-support-contact"
            aria-label="Reply email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[11px] text-zinc-100 placeholder:text-white/30 focus:border-[#D4AF37] focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            disabled={bundleBusy}
            onClick={() => void handleRunPreview()}
            className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100 text-[10px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${bundleBusy ? 'animate-spin' : ''}`} />
            <span>Run Self-Diagnosis &amp; Preview</span>
          </button>
          <button
            type="button"
            onClick={() => setShowWebhookConfig((prev) => !prev)}
            className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 cursor-pointer"
          >
            <Link2 className="w-3 h-3" />
            <span>
              {webhookUrl
                ? `Webhook Ready (${webhookSource})`
                : 'Configure Support Webhook URL'}
            </span>
          </button>
        </div>

        {(showWebhookConfig || !webhookUrl) && (
          <div className="rounded-xl border border-white/[0.08] bg-black/35 p-2.5 flex flex-col gap-1.5">
            <label htmlFor="cadence-support-webhook" className="text-[10px] text-zinc-400 font-medium">
              Google Apps Script Webhook URL (for 1-click upload to Drive &amp; Gmail)
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="cadence-support-webhook"
                aria-label="Support webhook URL"
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://script.google.com/macros/s/.../exec"
                className="flex-1 rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[10px] font-mono text-zinc-100 placeholder:text-white/30 focus:border-[#D4AF37] focus:outline-none"
              />
              <button
                type="button"
                disabled={bundleBusy}
                onClick={() => void handleSaveWebhookUrl()}
                className="px-2.5 py-1.5 rounded-lg bg-white/[0.1] hover:bg-white/[0.16] text-zinc-100 text-[10px] font-semibold shrink-0 cursor-pointer disabled:opacity-50"
              >
                Save URL
              </button>
            </div>
          </div>
        )}

        {preview && (
          <div className="rounded-xl border border-white/[0.08] bg-black/40 p-3 flex flex-col gap-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50">
              Self-Diagnosis Findings ({preview.hints.length})
            </div>
            <div className="flex flex-col gap-1.5">
              {preview.hints.map((hint, idx) => {
                const style =
                  hint.severity === 'error'
                    ? 'border-rose-500/35 bg-rose-500/10 text-rose-100'
                    : hint.severity === 'warn'
                      ? 'border-amber-500/35 bg-amber-500/10 text-amber-100'
                      : 'border-white/10 bg-white/[0.04] text-zinc-200'
                return (
                  <div key={`${hint.code}-${idx}`} className={`rounded-lg border p-2 ${style}`}>
                    <div className="font-semibold flex items-center gap-1.5 text-[11px]">
                      {hint.severity === 'info' ? (
                        <Info className="w-3.5 h-3.5 shrink-0 text-sky-300" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>{hint.title}</span>
                    </div>
                    <p className="text-[10px] opacity-85 mt-0.5 leading-relaxed">{hint.detail}</p>
                    <p className="text-[10px] text-[#D4AF37] mt-1">{hint.recommendedAction}</p>
                  </div>
                )
              })}
            </div>

            {preview.databaseLineage.some((d) => d.dbExists) && (
              <div className="pt-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50 flex items-center gap-1 mb-1">
                  <Database className="w-3 h-3" />
                  <span>Discovered Libraries &amp; Backups</span>
                </div>
                <div className="flex flex-col gap-1 font-mono text-[10px]">
                  {preview.databaseLineage
                    .filter((d) => d.dbExists)
                    .map((db) => (
                      <div
                        key={db.path}
                        className="flex items-center justify-between gap-2 rounded bg-black/40 px-2 py-1 border border-white/[0.05]"
                      >
                        <div className="truncate text-zinc-300" title={db.path}>
                          {db.label}
                        </div>
                        <div className="shrink-0 text-emerald-300">
                          {db.tracksCount ?? '?'} tracks
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div className="text-[10px] text-white/45 font-mono">
              Bundle contents: {preview.plannedBundleFiles.join(', ')}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[10px] text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={redactPaths}
              onChange={(e) => setRedactPaths(e.target.checked)}
              className="rounded border-white/25 bg-black/50 accent-[#D4AF37]"
            />
            <span>Redact OS username from file paths (tokens &amp; passwords are always stripped)</span>
          </label>

          <label className="flex items-start gap-2 text-[10px] text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              aria-label="Consent to share diagnostic package with Cadence Support"
              checked={consentGranted}
              onChange={(e) => setConsentGranted(e.target.checked)}
              className="mt-0.5 rounded border-white/25 bg-black/50 accent-[#D4AF37]"
            />
            <span className="leading-relaxed">
              <ShieldCheck className="w-3 h-3 inline mr-1 text-emerald-400" />
              I consent to packaging this diagnostic data to share with Cadence Support (
              <span className="font-mono">matbhuvitech@gmail.com</span>).
            </span>
          </label>

          <div className="flex items-center gap-2 flex-wrap pt-0.5">
            <button
              type="button"
              disabled={!consentGranted || bundleBusy || !webhookUrl.trim()}
              onClick={() => void handleSubmitSupport()}
              className="px-3 py-1.5 rounded-lg bg-[#D4AF37] text-black font-semibold text-[10px] flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-3 h-3" />
              <span>Send to Cadence Support (1-Click)</span>
            </button>
            <button
              type="button"
              disabled={!consentGranted || bundleBusy}
              onClick={() => void handleGenerateBundle(false)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100 font-medium text-[10px] flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ClipboardCopy className="w-3 h-3" />
              <span>Save .zip &amp; Copy Summary</span>
            </button>
            <button
              type="button"
              disabled={!consentGranted || bundleBusy}
              onClick={() => void handleGenerateBundle(true)}
              className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 font-medium text-[10px] flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Mail className="w-3 h-3" />
              <span>Email Fallback</span>
            </button>
          </div>
        </div>

        {submissionResult && (
          <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/15 p-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-emerald-200 font-semibold flex items-center gap-1.5 text-[11px]">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>Submitted — Ticket #{submissionResult.ticketId}</span>
              </div>
              <div className="text-[10px] text-emerald-200/80 mt-0.5">
                {submissionResult.message}
              </div>
            </div>
          </div>
        )}

        {generatedBundle && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-emerald-200 font-semibold flex items-center gap-1 text-[10px]">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{generatedBundle.fileName}</span>
              </div>
              <div className="text-[10px] text-emerald-200/70 font-mono truncate">
                {generatedBundle.zipPath} ({Math.max(1, Math.round(generatedBundle.sizeBytes / 1024))} KB)
              </div>
            </div>
            <button
              type="button"
              onClick={() => void tauriBridge.revealSupportBundleInFolder(generatedBundle.zipPath)}
              className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 text-[10px] font-medium shrink-0 cursor-pointer"
            >
              Show File
            </button>
          </div>
        )}

        {bundleStatus && (
          <div role="status" className="text-[10px] text-zinc-300 leading-relaxed">
            {bundleStatus}
          </div>
        )}
      </div>
    </div>
  )
}
