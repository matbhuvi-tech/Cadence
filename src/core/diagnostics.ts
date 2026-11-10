export type CaptureMode = 'off' | 'debug' | 'diagnostic_capture'

export type DiagCategory =
  | 'device_discovery'
  | 'device_selection'
  | 'audio_routing'
  | 'playback_lifecycle'
  | 'wasapi_lifecycle'
  | 'upnp_lifecycle'
  | 'queue_coordination'
  | 'audio_engine_commands'
  | 'background_workers'
  | 'audio_hygiene'

export interface DebugLogState {
  mode: CaptureMode
  ringCapacity: number
  bufferedApprox: number
  droppedCount: number
  persistedCount: number
  hygieneState: 'idle' | 'playing' | 'paused' | 'loading' | 'cooldown' | string
  cooldownRemainingSecs?: number | null
  logFilePath?: string | null
  logDirPath?: string | null
  lastFlushError?: string | null
}

export interface FrontendDebugEvent {
  category: DiagCategory
  event: string
  correlationId?: number
  waitUs?: number
  execUs?: number
  detail: string
}

export type FrontendDebugBatchSender = (events: FrontendDebugEvent[]) => Promise<void>

const MAX_BUFFERED = 256
const FLUSH_INTERVAL_MS = 150

export function createFrontendDiagnostics(sender?: FrontendDebugBatchSender | null) {
  let mode: CaptureMode = 'off'
  let queue: FrontendDebugEvent[] = []
  let droppedCount = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let activeSender: FrontendDebugBatchSender | null = sender ?? null

  const isActive = (): boolean => mode !== 'off'

  const flush = async () => {
    flushTimer = null
    if (!isActive() || queue.length === 0 || !activeSender) {
      return
    }
    const batch = queue.splice(0, 64)
    try {
      await activeSender(batch)
    } catch {
      // Never block playback or throw UI errors from diagnostic logging
    }
    if (queue.length > 0 && isActive()) {
      scheduleFlush()
    }
  }

  const scheduleFlush = () => {
    if (flushTimer !== null || !activeSender) return
    flushTimer = setTimeout(() => {
      void flush()
    }, FLUSH_INTERVAL_MS)
  }

  return {
    getMode(): CaptureMode {
      return mode
    },
    isActive(): boolean {
      return mode !== 'off'
    },
    getDroppedCount(): number {
      return droppedCount
    },
    getBufferedCount(): number {
      return queue.length
    },
    setSender(nextSender: FrontendDebugBatchSender | null) {
      activeSender = nextSender
    },
    setMode(nextMode: CaptureMode) {
      mode = nextMode
      if (mode === 'off') {
        queue = []
        if (flushTimer !== null) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
      } else if (queue.length > 0) {
        scheduleFlush()
      }
    },
    emit(
      category: DiagCategory,
      event: string,
      detail: string,
      opts?: { correlationId?: number; waitUs?: number; execUs?: number }
    ): boolean {
      if (mode === 'off') {
        return false
      }
      if (queue.length >= MAX_BUFFERED) {
        droppedCount += 1
        return false
      }
      queue.push({
        category,
        event,
        correlationId: opts?.correlationId ?? 0,
        waitUs: opts?.waitUs ?? 0,
        execUs: opts?.execUs ?? 0,
        detail,
      })
      scheduleFlush()
      return true
    },
    flushNow: flush,
  }
}

export const frontendDiagnostics = createFrontendDiagnostics()

export function isDebugActive(): boolean {
  return frontendDiagnostics.isActive()
}

export function setFrontendCaptureMode(mode: CaptureMode): void {
  frontendDiagnostics.setMode(mode)
}

export function emitDiag(
  category: DiagCategory,
  event: string,
  detail: string,
  opts?: { correlationId?: number; waitUs?: number; execUs?: number }
): void {
  frontendDiagnostics.emit(category, event, detail, opts)
}

