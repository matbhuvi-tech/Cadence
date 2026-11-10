import React, { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { tauriBridge, CaptureMode, DebugLogState } from '../../services/tauriBridge'

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
}

interface DebugDiagnosticsPanelProps {
  /** Whether the enclosing surface is currently visible so initial state loads on demand. */
  isActive?: boolean
}

/**
 * Shared controls and live status for lock-free Debug Logging and Diagnostic Capture Mode.
 * Used by both Cadence Settings and Activity Center with zero background polling.
 */
export const DebugDiagnosticsPanel: React.FC<DebugDiagnosticsPanelProps> = ({
  isActive = true,
}) => {
  const [debugState, setDebugState] = useState<DebugLogState>(DEFAULT_BROWSER_DEBUG_STATE)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshState = useCallback(() => {
    void tauriBridge.getDebugLogState().then(setDebugState).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isActive) return
    refreshState()
    return tauriBridge.subscribeDebugLogState(setDebugState)
  }, [isActive, refreshState])

  const handleSetMode = async (nextMode: CaptureMode) => {
    setBusy(true)
    setActionStatus(null)
    try {
      const updated = await tauriBridge.setDebugLogging(nextMode)
      setDebugState(updated)
    } catch (e) {
      setActionStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
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
    </div>
  )
}

