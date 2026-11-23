/** Sender observations, never NIC departure timing or the renderer's audio buffer. */
export interface DeliveryBin {
  offsetMs: number
  durationMs: number
  bytes: number
  targetBytesPerSec: number
  maxGapUs: number
  maxDelayUs: number
}
export interface DeliveryCapture {
  id: number
  elapsedMs: number
  complete: boolean
  bins: DeliveryBin[]
}
export interface DeliverySnapshot {
  streamId: number
  sampledAtMs: number
  pacerEnabled: boolean
  state: string
  bytesSent: number
  realtimeBytesPerSec: number
  multiplier: number
  writeStalls: number
  scheduleStalls: number
  congestionEvents: number
  flowControlEvents: number
  tcpSamples: number
  rttUs: number
  retransBytes: number
  capture: DeliveryCapture | null
}
export type DeliveryStatus = 'assessing' | 'off' | 'stable' | 'uneven' | 'falling_behind'
export interface DeliveryAssessment {
  status: DeliveryStatus
  explanation: string
  deficitWindows: number
  mbps: number | null
}
export const deliveryLabels: Record<DeliveryStatus, string> = {
  assessing: 'Assessing', off: 'Off', stable: 'Pacing steady', uneven: 'Uneven', falling_behind: 'Falling behind',
}

export function parseDeliverySnapshot(raw: unknown): DeliverySnapshot {
  const fail = (): never => { throw new Error('Delivery telemetry is unavailable or incompatible.') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const s = raw as DeliverySnapshot
  const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  for (const key of ['streamId', 'sampledAtMs', 'bytesSent', 'realtimeBytesPerSec', 'multiplier',
    'writeStalls', 'scheduleStalls', 'congestionEvents', 'flowControlEvents', 'tcpSamples', 'rttUs', 'retransBytes'] as const) {
    if (!nonnegative(s[key]) || (key !== 'multiplier' && !Number.isSafeInteger(s[key]))) return fail()
  }
  if (typeof s.pacerEnabled !== 'boolean' || !['unpaced', 'initial_fill', 'steady_maintain'].includes(s.state)) return fail()
  if (s.capture !== null) {
    const c = s.capture
    if (!c || !nonnegative(c.id) || c.id === 0 || !nonnegative(c.elapsedMs) || c.elapsedMs > 60000 ||
      typeof c.complete !== 'boolean' || !Array.isArray(c.bins) || c.bins.length > 600) return fail()
    let end = 0
    for (const b of c.bins) {
      if (!b || ![b.offsetMs, b.durationMs, b.bytes, b.targetBytesPerSec, b.maxGapUs, b.maxDelayUs].every(n => nonnegative(n) && Number.isSafeInteger(n)) ||
        b.durationMs <= 0 || b.durationMs > 100 || b.offsetMs < end || b.offsetMs + b.durationMs > c.elapsedMs) return fail()
      end = b.offsetMs + b.durationMs
    }
  }
  return s
}

export function assessDelivery(current: DeliverySnapshot | null, previous: DeliverySnapshot | null, deficitWindows: number): DeliveryAssessment {
  const result = (status: DeliveryStatus, explanation: string, deficit = 0, mbps: number | null = null): DeliveryAssessment =>
    ({ status, explanation, deficitWindows: deficit, mbps })
  if (!current) return result('assessing', 'Waiting for delivery observations from the active engine.')
  if (!current.pacerEnabled) return result('off', 'Pacing is disabled. Sender delivery can be inspected without pacing.')
  if (!previous || current.streamId !== previous.streamId || current.bytesSent < previous.bytesSent ||
    current.sampledAtMs <= previous.sampledAtMs || current.state !== 'steady_maintain' || current.realtimeBytesPerSec <= 0) {
    return result('assessing', 'Collecting steady playback observations; startup and new HTTP ranges are excluded.')
  }
  const seconds = (current.sampledAtMs - previous.sampledAtMs) / 1000
  if (seconds < 4 || seconds > 25) return result('assessing', 'Waiting for a recent observation window.')
  const bytes = current.bytesSent - previous.bytesSent
  if (bytes === 0) return result('assessing', 'No new audio writes. The renderer may already have buffered the requested data.')
  const mbps = bytes * 8 / seconds / 1e6
  const network = current.congestionEvents > previous.congestionEvents || current.retransBytes > previous.retransBytes
  const scheduling = current.scheduleStalls > previous.scheduleStalls
  const writes = current.writeStalls > previous.writeStalls
  const receiver = current.flowControlEvents > previous.flowControlEvents
  // Conservative provisional thresholds: a rate deficit alone is not a dropout.
  const deficit = bytes / seconds < current.realtimeBytesPerSec * 0.95 && (network || scheduling || (writes && !receiver))
    ? deficitWindows + 1 : 0
  if (deficit >= 2) return result('falling_behind', 'Repeated delivery deficits and stalls observed. Reduce competing traffic or compare playback with pacing off.', deficit, mbps)
  if (scheduling || (writes && !receiver)) {
    return result('uneven', network ? 'TCP impairment observed; network contention is possible.' : scheduling
      ? 'Local scheduling delays observed on the playback engine.' : 'Audio writes stalled; the cause is uncertain.', deficit, mbps)
  }
  if (receiver) return result('stable', 'Pacing steady. The receiver is regulating incoming data; delivery rate can temporarily decrease while buffered audio continues.', 0, mbps)
  if (bytes / seconds < current.realtimeBytesPerSec * 0.95) return result('assessing', 'Delivery is below the track average; buffering and HTTP request boundaries may explain this.', 0, mbps)
  return result('stable', network ? 'Pacing steady. TCP warning: transport impairment was observed without a sender timing disruption.' : 'No significant delivery stalls observed in the latest window. This is sender telemetry, not packet timing at the streamer.', 0, mbps)
}
