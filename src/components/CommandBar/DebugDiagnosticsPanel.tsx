import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCopy,
  Database,
  FileArchive,
  FolderOpen,
  HelpCircle,
  Info,
  Mail,
  MinusCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle,
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

const CUSTOM_SCENARIO_OPTION = '__custom__'

const CAPTURE_RECOMMENDED_SCENARIOS = new Set([
  'upnp_dropouts',
  'wasapi_exclusive_failed',
  'ram_lock_admission_failed',
  'scanner_skipped_files',
  'gemini_provenance_failed',
  'missing_artwork',
])

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
    label: 'Cannot connect to Playback Engine',
    description: 'Desktop app cannot reach, pair with, or stay connected to your Playback Engine.',
  },
  {
    id: 'upnp_discovery_failed',
    label: 'Speakers or audio output devices not showing',
    description: 'UPnP speakers, USB DACs, or audio output devices are missing from your output list.',
  },
  {
    id: 'enrichment_stuck',
    label: 'Album metadata or cover art enrichment is stuck',
    description: 'Automatic metadata or cover art matching stopped progressing or stays paused.',
  },
  {
    id: 'enrichment_slow',
    label: 'Metadata or cover art matching is running slowly',
    description: 'Album matching or artwork fetching is taking unusually long.',
  },
  {
    id: 'app_crashed',
    label: 'Cadence closed unexpectedly or crashed',
    description: 'Desktop app or Playback Engine closed abruptly or generated a crash report.',
  },
  {
    id: 'mobile_not_connecting',
    label: 'Mobile Remote cannot connect to Playback Engine',
    description: 'Cadence Remote on your phone or tablet cannot find, trust, or pair with the engine.',
  },
  {
    id: 'smb_mount_failed',
    label: 'Cannot add or access a network (SMB / NAS) music folder',
    description: 'Adding or connecting to a network shared folder fails or reports permission errors.',
  },
  {
    id: 'lost_library_after_upgrade',
    label: 'Missing tracks, albums, or playlists after an update',
    description: 'Your music library or playlists disappeared after updating or switching engine mode.',
  },
  {
    id: 'wasapi_exclusive_failed',
    label: 'Bit-perfect playback (WASAPI Exclusive / ASIO) failed',
    description: 'Bit-perfect audio device initialization or sample-rate switching fails.',
  },
  {
    id: 'upnp_dropouts',
    label: 'Music playback stutters, drops out, or stops early',
    description: 'Streaming to a network speaker pauses, skips, or cuts off mid-track.',
  },
  {
    id: 'ram_lock_admission_failed',
    label: 'Large hi-res or DSD track failed to load into memory',
    description: 'Playback fails with memory lock or track-not-ready errors on large hi-res or DSD files.',
  },
  {
    id: 'scanner_skipped_files',
    label: 'Library scan skipped files or shows wrong audio format',
    description: 'Some audio files are missing after scanning or DSD/PCM format details look wrong.',
  },
  {
    id: 'tag_commit_stuck',
    label: 'Saving metadata edits to audio files is stuck or failing',
    description: 'Approved tag changes stay queued or fail to write to your audio files.',
  },
  {
    id: 'gemini_provenance_failed',
    label: 'Gemini AI album or soundtrack lookup failed',
    description: 'AI metadata resolution or soundtrack lookup returned errors.',
  },
  {
    id: 'missing_artwork',
    label: 'Album covers or artist portraits are missing',
    description: 'Albums or artists show placeholders even when local or online artwork exists.',
  },
  {
    id: 'cooldown_deadlock',
    label: "Background actions stay paused ('deferred until idle')",
    description: 'Folder scans, speaker discovery, or metadata saving remain blocked after playback stops.',
  },
]

type SemanticHealthStatus = 'passed' | 'warning' | 'failed' | 'info' | 'not_checked'

interface SystemHealthRow {
  id: string
  label: string
  summary: string
  status: SemanticHealthStatus
}

function inferScenarioIdFromText(rawText: string): string {
  const lower = rawText.trim().toLowerCase()
  if (!lower) return 'engine_not_connecting'
  const hasAny = (words: string[]) => words.some((w) => lower.includes(w))
  if (hasAny(['stutter', 'dropout', 'drop out', 'skip', 'cut off', 'cuts off', 'glitch'])) {
    return 'upnp_dropouts'
  }
  if (hasAny(['vanish', 'disappear', 'upgrade', 'empty library', 'lost library', 'missing track', 'missing album', 'missing playlist'])) {
    return 'lost_library_after_upgrade'
  }
  if (hasAny(['smb', 'nas', 'unc', 'network folder', 'network share', 'cifs', 'share'])) {
    return 'smb_mount_failed'
  }
  if (hasAny(['wasapi', 'asio', 'exclusive', 'bit-perfect', 'bit perfect', 'dac'])) {
    return 'wasapi_exclusive_failed'
  }
  if (hasAny(['virtuallock', 'memlock', 'ram', 'dsd load', 'memory lock', 'not_ready'])) {
    return 'ram_lock_admission_failed'
  }
  if (hasAny(['enrich', 'musicbrainz', 'metadata stuck'])) {
    return 'enrichment_stuck'
  }
  if (hasAny(['artwork', 'cover', 'portrait', 'album art'])) {
    return 'missing_artwork'
  }
  if (hasAny(['tag', 'commit', 'curate write'])) {
    return 'tag_commit_stuck'
  }
  if (hasAny(['gemini', 'provenance', 'ai lookup'])) {
    return 'gemini_provenance_failed'
  }
  if (hasAny(['deferred', 'cooldown', 'until idle'])) {
    return 'cooldown_deadlock'
  }
  if (hasAny(['mobile', 'phone', 'android', 'ios', 'pin', 'qr'])) {
    return 'mobile_not_connecting'
  }
  if (hasAny(['upnp', 'speaker', 'renderer', 'discover', 'output device'])) {
    return 'upnp_discovery_failed'
  }
  if (hasAny(['connect', 'unreachable', 'port 4040', 'engine'])) {
    return 'engine_not_connecting'
  }
  if (hasAny(['crash', 'panic', 'closed unexpectedly'])) {
    return 'app_crashed'
  }
  return 'custom'
}

function statusMeta(status: SemanticHealthStatus): {
  label: string
  badgeClass: string
  Icon: React.ComponentType<{ className?: string }>
} {
  switch (status) {
    case 'passed':
      return {
        label: 'Passed',
        badgeClass: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
        Icon: CheckCircle2,
      }
    case 'warning':
      return {
        label: 'Warning',
        badgeClass: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
        Icon: AlertTriangle,
      }
    case 'failed':
      return {
        label: 'Failed',
        badgeClass: 'border-rose-500/35 bg-rose-500/15 text-rose-300',
        Icon: XCircle,
      }
    case 'info':
      return {
        label: 'Information',
        badgeClass: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
        Icon: Info,
      }
    case 'not_checked':
      return {
        label: 'Not checked',
        badgeClass: 'border-white/15 bg-white/[0.06] text-zinc-400',
        Icon: MinusCircle,
      }
  }
}

function buildSystemHealthRows(preview: SupportDiagnosticsPreview): SystemHealthRow[] {
  const rows: SystemHealthRow[] = []
  const primaryReport = Array.isArray(preview.doctorReports)
    ? (preview.doctorReports.find(
        (rep) =>
          rep &&
          typeof rep === 'object' &&
          Array.isArray((rep as { checks?: unknown[] }).checks),
      ) as {
        checks?: Array<{ name?: string; status?: string; detail?: string }>
      } | undefined)
    : undefined

  const doctorLabelMap: Record<string, { label: string; okSummary: string }> = {
    data_directory: { label: 'Engine data directory', okSummary: 'Accessible' },
    sqlite_integrity: { label: 'Database integrity', okSummary: 'No corruption detected' },
    sqlite_foreign_keys: { label: 'Database relationships', okSummary: 'No violations detected' },
    identity_and_tls: { label: 'Engine identity & security', okSummary: 'Local files validated' },
    memory_lock_limits: { label: 'Memory & audio resources', okSummary: 'No issues detected' },
  }

  const checks = primaryReport?.checks ?? []
  for (const [key, meta] of Object.entries(doctorLabelMap)) {
    const match = checks.find((c) => c.name === key)
    if (match) {
      const rawStatus = (match.status ?? '').toUpperCase()
      const status: SemanticHealthStatus =
        rawStatus === 'FAIL'
          ? 'failed'
          : rawStatus === 'WARN'
            ? 'warning'
            : rawStatus === 'OK'
              ? 'passed'
              : 'not_checked'
      rows.push({
        id: key,
        label: meta.label,
        summary: status === 'passed' ? meta.okSummary : match.detail || 'Check returned a warning',
        status,
      })
    } else {
      rows.push({
        id: key,
        label: meta.label,
        summary: 'Local check not applicable or skipped',
        status: 'not_checked',
      })
    }
  }

  const hasLineageIssue = preview.hints.some(
    (h) =>
      h.code === 'SPLIT_OR_UNMIGRATED_LIBRARY_DETECTED' ||
      h.code === 'DATABASE_INSPECT_ERROR',
  )
  rows.push({
    id: 'library_consistency',
    label: 'Library consistency',
    summary: hasLineageIssue
      ? 'Multiple or mismatched libraries detected'
      : 'No library conflicts detected',
    status: hasLineageIssue ? 'warning' : 'passed',
  })

  rows.push({
    id: 'engine_connectivity',
    label: 'Engine connectivity',
    summary: preview.activeEngineReachable
      ? 'Connected to Playback Engine'
      : 'Cannot reach Playback Engine',
    status: preview.activeEngineReachable ? 'passed' : 'failed',
  })

  rows.push({
    id: 'live_engine_health',
    label: 'Live engine health',
    summary: preview.activeEngineReachable
      ? 'Retrieved live engine status'
      : 'Unable to retrieve while disconnected',
    status: preview.activeEngineReachable ? 'passed' : 'not_checked',
  })

  return rows
}

function isPrimaryActiveDatabase(label: string, windowsServiceRunning: boolean): boolean {
  if (label.includes('(backups/') || label.includes('(rollback/')) {
    return false
  }
  if (windowsServiceRunning && label.includes('Service')) return true
  if (!windowsServiceRunning && label.includes('User Tray')) return true
  if (label.includes('Linux Core') || label.includes('CADENCE_DATA_DIR')) return true
  return false
}

interface DebugDiagnosticsPanelProps {
  /** Whether the enclosing surface is currently visible so initial state loads on demand. */
  isActive?: boolean
}

/**
 * Listener-first 3-stage Help & Troubleshooting experience with hybrid Type-or-Select
 * issue identification, 5-state System Health checks, visual library lineage cards,
 * guided live capture, and Advanced Diagnostics controls.
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
  const [customProblem, setCustomProblem] = useState<string>('')
  const [showContactStage, setShowContactStage] = useState<boolean>(false)

  const [userNotes, setUserNotes] = useState<string>('')
  const [contactEmail, setContactEmail] = useState<string>('')
  const [webhookUrl, setWebhookUrl] = useState<string>(DEFAULT_SUPPORT_WEBHOOK_URL)
  const [redactPaths, setRedactPaths] = useState<boolean>(true)
  const [consentGranted, setConsentGranted] = useState<boolean>(false)
  const [bundleBusy, setBundleBusy] = useState<boolean>(false)
  const [preview, setPreview] = useState<SupportDiagnosticsPreview | null>(null)
  const [generatedBundle, setGeneratedBundle] = useState<GeneratedSupportBundle | null>(null)
  const [submissionResult, setSubmissionResult] = useState<SupportSubmissionResult | null>(null)
  const [bundleStatus, setBundleStatus] = useState<string | null>(null)

  const trimmedCustomProblem = customProblem.trim()
  const effectiveScenarioInput =
    trimmedCustomProblem.length > 0
      ? trimmedCustomProblem
      : scenarioId === CUSTOM_SCENARIO_OPTION
        ? 'general_issue'
        : scenarioId
  const inferredScenarioId = useMemo(
    () =>
      trimmedCustomProblem.length > 0
        ? inferScenarioIdFromText(trimmedCustomProblem)
        : scenarioId,
    [trimmedCustomProblem, scenarioId],
  )
  const isCaptureRecommended =
    CAPTURE_RECOMMENDED_SCENARIOS.has(inferredScenarioId) ||
    debugState.mode === 'diagnostic_capture'

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
        scenarioId: effectiveScenarioInput,
        ...ctx,
      })
      if (result) {
        setPreview(result)
        setShowContactStage(true)
      } else {
        setBundleStatus('Self-diagnosis is only available in the desktop app.')
      }
    } catch (e) {
      setBundleStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBundleBusy(false)
    }
  }

  const handleStopCaptureAndPrepare = async () => {
    await handleSetMode('off')
    await handleRunPreview()
    setShowContactStage(true)
  }

  const handleSubmitSupport = async () => {
    if (!consentGranted) return
    setBundleBusy(true)
    setBundleStatus(null)
    setSubmissionResult(null)
    try {
      const ctx = await gatherEngineDiagnosticContext()
      const result = await tauriBridge.submitSupportBundle({
        scenarioId: effectiveScenarioInput,
        userNotes: userNotes.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        redactPaths,
        consentGranted: true,
        ...ctx,
        frontendContext: {
          isCoreActive: Boolean(engine?.isCoreActive),
          coreConnected: Boolean(engine?.state.view.session.connected),
          activeEngineLabel: engine?.state.activeProfile?.label ?? null,
          customProblemText: trimmedCustomProblem || null,
        },
      })
      if (!result) {
        setBundleStatus('Direct support submission is only available in the desktop app.')
        return
      }
      setSubmissionResult(result)
      setGeneratedBundle(result.bundle)
      setPreview(result.bundle.preview)
      setBundleStatus(`${result.message} (Reference: ${result.ticketId})`)
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
        scenarioId: effectiveScenarioInput,
        userNotes: userNotes.trim() || undefined,
        redactPaths,
        consentGranted: true,
        ...ctx,
        frontendContext: {
          isCoreActive: Boolean(engine?.isCoreActive),
          coreConnected: Boolean(engine?.state.view.session.connected),
          activeEngineLabel: engine?.state.activeProfile?.label ?? null,
          customProblemText: trimmedCustomProblem || null,
        },
      })
      if (!bundle) {
        setBundleStatus('Diagnostic report export is only available in the desktop app.')
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
          `Saved ${bundle.fileName}, highlighted it in your folder, and opened an email draft to ${bundle.emailTo}.`,
        )
      } else {
        setBundleStatus(
          `Exported ${bundle.fileName} and copied the diagnostic summary to your clipboard.`,
        )
      }
    } catch (e) {
      setBundleStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBundleBusy(false)
    }
  }

  const healthRows = useMemo(
    () => (preview ? buildSystemHealthRows(preview) : []),
    [preview],
  )
  const discoveredDatabases = useMemo(
    () => (preview ? preview.databaseLineage.filter((d) => d.dbExists) : []),
    [preview],
  )

  return (
    <div className="flex flex-col gap-3.5 text-[11px]">
      {/* Stage 1: Identify the problem */}
      <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-zinc-100 font-semibold text-xs flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>01 · Identify the problem</span>
            </div>
            <p className="text-[10px] text-white/55 mt-0.5">
              Choose a common issue from the list or describe what happened in your own words.
            </p>
          </div>
          {(debugState.crashLogCount ?? 0) > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-200 text-[10px] font-medium shrink-0">
              {debugState.crashLogCount} Crash Report(s)
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cadence-support-scenario" className="text-[10px] text-zinc-400 font-medium">
            What are you having trouble with?
          </label>
          <select
            id="cadence-support-scenario"
            aria-label="Issue scenario"
            value={scenarioId}
            onChange={(e) => {
              const val = e.target.value
              setScenarioId(val)
              if (val !== CUSTOM_SCENARIO_OPTION) {
                setCustomProblem('')
              }
            }}
            className="w-full rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-[#D4AF37] focus:outline-none"
          >
            {scenarios.map((sc) => (
              <option key={sc.id} value={sc.id} className="bg-[#12141b] text-zinc-100">
                {sc.label}
              </option>
            ))}
            <option value={CUSTOM_SCENARIO_OPTION} className="bg-[#12141b] text-[#D4AF37]">
              Describe my own issue...
            </option>
          </select>

          <input
            id="cadence-support-custom-problem"
            aria-label="Describe your issue"
            type="text"
            value={customProblem}
            onChange={(e) => {
              const next = e.target.value
              setCustomProblem(next)
              if (next.trim().length > 0 && scenarioId !== CUSTOM_SCENARIO_OPTION) {
                setScenarioId(CUSTOM_SCENARIO_OPTION)
              }
            }}
            placeholder="Or type your problem in your own words (e.g. USB DAC stops at 192 kHz)..."
            className="w-full rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[11px] text-zinc-100 placeholder:text-white/35 focus:border-[#D4AF37] focus:outline-none"
          />
          {trimmedCustomProblem.length > 0 && (
            <div className="text-[10px] text-zinc-400 flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-zinc-200 font-medium">
                {isCaptureRecommended ? 'Guided capture + health checks' : 'Automated health checks'}
              </span>
              <span>Your exact wording will be included in the report.</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={bundleBusy}
              onClick={() => void handleRunPreview()}
              className="px-3.5 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#e1be49] text-black text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${bundleBusy ? 'animate-spin' : ''}`} />
              <span>Diagnose Problem</span>
            </button>
            <span className="text-[10px] text-white/45">
              Read-only · No changes made to your system
            </span>
          </div>

          {!showContactStage && !preview && (
            <button
              type="button"
              onClick={() => setShowContactStage(true)}
              className="text-[10px] text-[#D4AF37] hover:underline flex items-center gap-0.5 cursor-pointer"
            >
              <span>Skip to Contact Support</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Guided Capture Flow for runtime playback/audio issues */}
        {isCaptureRecommended && (
          <div className="mt-1 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="text-[11px] font-semibold text-amber-100">
                  Guided Playback &amp; Audio Capture
                </div>
                <p className="text-[10px] text-amber-100/75 mt-0.5">
                  {debugState.mode === 'diagnostic_capture'
                    ? 'Recording diagnostic trace now. Play music and reproduce the issue, then click Stop & Prepare Report.'
                    : 'Some playback issues can only be diagnosed from logs recorded while the issue happens.'}
                </p>
              </div>
              {debugState.mode === 'diagnostic_capture' ? (
                <button
                  type="button"
                  disabled={busy || bundleBusy}
                  onClick={() => void handleStopCaptureAndPrepare()}
                  className="px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-[10px] font-semibold cursor-pointer disabled:opacity-50 shrink-0"
                >
                  Stop Capture &amp; Prepare Report
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSetMode('diagnostic_capture')}
                  className="px-3 py-1.5 rounded-lg bg-white/[0.1] hover:bg-white/[0.16] text-amber-100 text-[10px] font-semibold cursor-pointer disabled:opacity-50 shrink-0"
                >
                  Start Diagnostic Capture
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Stage 2: Diagnostic results, 5-state System Health & Visual Library Consistency */}
      {preview && (
        <section className="rounded-xl border border-white/[0.08] bg-black/40 p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-zinc-100 font-semibold text-xs">
                02 · Diagnostic results ({preview.hints.length})
              </div>
              <div className="text-[10px] text-white/50 truncate">
                Issue: {preview.scenarioLabel}
              </div>
            </div>
            <button
              type="button"
              disabled={bundleBusy}
              onClick={() => void handleRunPreview()}
              className="px-2.5 py-1 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 text-[10px] font-medium flex items-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${bundleBusy ? 'animate-spin' : ''}`} />
              <span>Check Again</span>
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {preview.hints.map((hint, idx) => {
              const mappedStatus: SemanticHealthStatus =
                hint.severity === 'error'
                  ? 'failed'
                  : hint.severity === 'warn'
                    ? 'warning'
                    : 'info'
              const meta = statusMeta(mappedStatus)
              const StatusIcon = meta.Icon
              const cardBorder =
                mappedStatus === 'failed'
                  ? 'border-rose-500/35 bg-rose-500/10 text-rose-100'
                  : mappedStatus === 'warning'
                    ? 'border-amber-500/35 bg-amber-500/10 text-amber-100'
                    : 'border-white/10 bg-white/[0.04] text-zinc-200'
              return (
                <div key={`${hint.code}-${idx}`} className={`rounded-lg border p-2.5 ${cardBorder}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold flex items-center gap-1.5 text-[11px]">
                      <StatusIcon className="w-3.5 h-3.5 shrink-0" />
                      <span>{hint.title}</span>
                    </div>
                    <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide shrink-0 ${meta.badgeClass}`}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="text-[10px] opacity-85 mt-1 leading-relaxed">{hint.detail}</p>
                  <p className="text-[10px] text-[#D4AF37] mt-1 font-medium">
                    Recommended action: {hint.recommendedAction}
                  </p>
                </div>
              )
            })}
          </div>

          {/* 5-state System Health Checklist */}
          <div className="pt-1 border-t border-white/[0.07]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50 mb-1.5">
              System Health Checklist
            </div>
            <div className="flex flex-col gap-1">
              {healthRows.map((row) => {
                const meta = statusMeta(row.status)
                const RowIcon = meta.Icon
                return (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 border border-white/[0.05]"
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-zinc-200 truncate">{row.label}</div>
                      <div className="text-[10px] text-white/50 truncate">{row.summary}</div>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[9px] font-semibold shrink-0 ${meta.badgeClass}`}
                    >
                      <RowIcon className="w-3 h-3" />
                      <span>{meta.label}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Visual Library Consistency (Database Lineage Cards) */}
          {discoveredDatabases.length > 0 && (
            <div className="pt-1 border-t border-white/[0.07]">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50 flex items-center gap-1 mb-1.5">
                <Database className="w-3 h-3" />
                <span>Library Consistency ({discoveredDatabases.length} database{discoveredDatabases.length === 1 ? '' : 's'} found)</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {discoveredDatabases.map((db) => {
                  const isActiveDb = isPrimaryActiveDatabase(db.label, preview.windowsServiceRunning)
                  return (
                    <div
                      key={db.path}
                      className={`rounded-lg border p-2.5 flex flex-col gap-1.5 ${
                        isActiveDb
                          ? 'border-[#D4AF37]/35 bg-[#D4AF37]/[0.06]'
                          : 'border-white/[0.07] bg-black/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold text-zinc-100 truncate" title={db.path}>
                          {db.label}
                        </div>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0 ${
                            isActiveDb
                              ? 'bg-[#D4AF37]/20 text-[#D4AF37]'
                              : 'bg-white/[0.07] text-zinc-400'
                          }`}
                        >
                          {isActiveDb ? 'Active Library' : 'Discovered'}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 text-center pt-0.5">
                        <div className="rounded bg-black/40 px-1.5 py-1 border border-white/[0.05]">
                          <div className="text-[9px] text-white/45">Tracks</div>
                          <div className="text-[11px] font-mono font-semibold text-emerald-300">
                            {db.tracksCount ?? '—'}
                          </div>
                        </div>
                        <div className="rounded bg-black/40 px-1.5 py-1 border border-white/[0.05]">
                          <div className="text-[9px] text-white/45">Albums</div>
                          <div className="text-[11px] font-mono font-semibold text-zinc-200">
                            {db.releasesCount ?? '—'}
                          </div>
                        </div>
                        <div className="rounded bg-black/40 px-1.5 py-1 border border-white/[0.05]">
                          <div className="text-[9px] text-white/45">Playlists</div>
                          <div className="text-[11px] font-mono font-semibold text-zinc-200">
                            {db.playlistsCount ?? '—'}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Collapsible Technical Details */}
          <details className="rounded-lg border border-white/[0.06] bg-black/30 px-2.5 py-1.5">
            <summary className="cursor-pointer text-[10px] font-medium text-zinc-400 hover:text-zinc-200 select-none">
              View technical details &amp; included files
            </summary>
            <div className="mt-2 flex flex-col gap-1.5 text-[10px] font-mono text-white/55">
              <div>
                Codes: {preview.hints.map((h) => h.code).join(', ')}
              </div>
              {discoveredDatabases.map((db) => (
                <div key={`path-${db.path}`} className="break-all">
                  {db.label}: {db.path} (schema v{db.schemaVersion ?? '?'}, crashes={db.crashLogCount})
                </div>
              ))}
              <div>
                Bundle contents: {preview.plannedBundleFiles.join(', ')}
              </div>
            </div>
          </details>
        </section>
      )}

      {/* Stage 3: Contact Cadence Support (progressive, shown after diagnosis or on Skip) */}
      {(preview || showContactStage) && (
        <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 flex flex-col gap-2.5">
          <div>
            <div className="text-zinc-100 font-semibold text-xs flex items-center gap-1.5">
              <FileArchive className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>03 · Still need help? Contact Cadence Support</span>
            </div>
            <p className="text-[10px] text-white/55 mt-0.5">
              Share a privacy-protected diagnostic report so we can investigate the issue.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="cadence-support-notes" className="text-[10px] text-zinc-400 font-medium">
              Tell us what happened (optional)
            </label>
            <textarea
              id="cadence-support-notes"
              aria-label="Issue details"
              rows={2}
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              placeholder="Steps to reproduce, speaker model, or NAS brand..."
              className="w-full rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-[11px] text-zinc-100 placeholder:text-white/30 focus:border-[#D4AF37] focus:outline-none resize-none"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="cadence-support-contact" className="text-[10px] text-zinc-400 font-medium">
              Your email address (optional — if you&apos;d like a reply)
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

          <div className="rounded-lg border border-white/[0.06] bg-black/30 p-2.5 flex flex-col gap-2">
            <div className="text-[10px] text-emerald-300/90 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>Passwords, pairing PINs, and API keys are removed automatically.</span>
            </div>

            <label className="flex items-center gap-2 text-[10px] text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={redactPaths}
                onChange={(e) => setRedactPaths(e.target.checked)}
                className="rounded border-white/25 bg-black/50 accent-[#D4AF37]"
              />
              <span>Hide my computer username from file paths</span>
            </label>

            {preview && (
              <details className="text-[10px] text-white/60">
                <summary className="cursor-pointer text-zinc-300 hover:text-white select-none">
                  Preview what will be shared
                </summary>
                <div className="mt-1.5 rounded border border-white/[0.06] bg-black/50 p-2 font-mono text-[10px] whitespace-pre-wrap text-zinc-300">
                  {preview.emailBody}
                </div>
              </details>
            )}

            <label className="flex items-start gap-2 text-[10px] text-zinc-200 cursor-pointer pt-0.5">
              <input
                type="checkbox"
                aria-label="Consent to share diagnostic package with Cadence Support"
                checked={consentGranted}
                onChange={(e) => setConsentGranted(e.target.checked)}
                className="mt-0.5 rounded border-white/25 bg-black/50 accent-[#D4AF37]"
              />
              <span className="leading-relaxed">
                I agree to share this diagnostic report with Cadence Support.
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
                <span>Send to Cadence Support</span>
              </button>
              <button
                type="button"
                disabled={!consentGranted || bundleBusy}
                onClick={() => void handleGenerateBundle(false)}
                className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100 font-medium text-[10px] flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ClipboardCopy className="w-3 h-3" />
                <span>Export Diagnostic Report</span>
              </button>
              <button
                type="button"
                disabled={!consentGranted || bundleBusy}
                onClick={() => void handleGenerateBundle(true)}
                className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 font-medium text-[10px] flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Mail className="w-3 h-3" />
                <span>Email Support</span>
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
        </section>
      )}

      {/* Advanced Diagnostics & Debug Logging (tucked below main listener journey) */}
      <section className="rounded-xl border border-white/[0.06] bg-black/25 p-3 flex flex-col gap-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-white/45">
          Advanced Diagnostics
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-zinc-200 font-medium">Debug Logging (Idle Persistence)</div>
            <div className="text-[10px] text-white/50">
              Captures memory events in the background and saves them only when playback is stopped.
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
                  Flushes logs during active or paused playback for hard-to-reproduce issues.
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

            <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] text-zinc-300 bg-black/30 p-2.5 rounded-lg border border-white/[0.05]">
              <div>Buffered: {debugState.bufferedApprox} / {debugState.ringCapacity}</div>
              <div className={debugState.droppedCount > 0 ? 'text-amber-300' : ''}>
                Dropped: {debugState.droppedCount}
              </div>
              <div>Persisted: {debugState.persistedCount}</div>
              <div>Hygiene: {debugState.hygieneState}</div>
              {engineDebugState && (
                <div className="col-span-2 pt-1 border-t border-white/[0.06] text-[#D4AF37]">
                  Playback Engine: mode={engineDebugState.mode} · persisted={engineDebugState.persistedCount} · hygiene={engineDebugState.hygieneState}
                </div>
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
      </section>
    </div>
  )
}
