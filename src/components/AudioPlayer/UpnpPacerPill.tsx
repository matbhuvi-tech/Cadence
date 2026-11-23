import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Activity, AlertTriangle, Pause, RotateCcw, X } from 'lucide-react'
import type { EngineEventRecord } from '../../core/coreProtocol'
import { assessDelivery, deliveryLabels, parseDeliverySnapshot, type DeliverySnapshot, type DeliveryCapture } from '../../core/upnpDelivery'
import type { EngineClient } from '../../services/engineClient'
import { createDeliveryCapture } from '../../services/upnpDeliveryCapture'

interface Props {
  client: EngineClient
  subscribe: (listener: (event: EngineEventRecord) => void) => () => void
  connected: boolean
  playing: boolean
}

const mbps = (bytesPerSecond: number) => bytesPerSecond * 8 / 1e6

/** Static SVG: no animation loop, chart library, hover polling, or broad context updates. */
function DeliveryGraph({ capture, requiredRate }: { capture: DeliveryCapture | null; requiredRate: number }) {
  // Incomplete bins can exaggerate the rate of a single chunk. Publish only
  // complete 100 ms intervals; the partial tail appears in the next batch.
  const bins = capture?.bins.filter(b => b.durationMs === 100) ?? []
  const width = 520, height = 180, left = 42, top = 14, bottom = 150, right = 508
  const ceiling = Math.max(1, requiredRate * 1.3, ...bins.map(b => Math.max(mbps(b.bytes * 1000 / b.durationMs), mbps(b.targetBytesPerSec))))
  const x = (ms: number) => left + ms / 60000 * (right - left)
  const y = (rate: number) => bottom - rate / ceiling * (bottom - top)
  // Step geometry preserves zero-rate intervals; curved interpolation would invent data.
  const line = bins.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.offsetMs)},${y(mbps(b.bytes * 1000 / b.durationMs))} L${x(b.offsetMs + b.durationMs)},${y(mbps(b.bytes * 1000 / b.durationMs))}`).join(' ')
  const target = bins.filter(b => b.targetBytesPerSec > 0).map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.offsetMs)},${y(mbps(b.targetBytesPerSec))}`).join(' ')
  return <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Sender delivery over sixty seconds in megabits per second; markers indicate excess pacing delays of at least 25 milliseconds">
    {[0, 0.5, 1].map(fraction => <g key={fraction}>
      <line x1={left} x2={right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} stroke="#ffffff18" strokeDasharray="3 4" />
      <text x={left - 7} y={y(ceiling * fraction) + 4} textAnchor="end" fill="#a1a1aa" fontSize="10">{(ceiling * fraction).toFixed(1)}</text>
    </g>)}
    {requiredRate > 0 && <line x1={left} x2={right} y1={y(requiredRate)} y2={y(requiredRate)} stroke="#a1a1aa" strokeDasharray="5 4" />}
    <path d={target} fill="none" stroke="#a5b4fc" strokeWidth="1" strokeDasharray="4 3" />
    <path d={line} fill="none" stroke="#d4af37" strokeWidth="1.5" />
    {bins.filter(b => b.maxDelayUs >= 25000).map(b => <line key={b.offsetMs} x1={x(b.offsetMs)} x2={x(b.offsetMs)} y1={bottom - 5} y2={bottom} stroke="#fb923c" strokeWidth="2">
      <title>{(b.offsetMs / 1000).toFixed(1)}s: excess pacing delay {(b.maxDelayUs / 1000).toFixed(0)} ms; sender gap {(b.maxGapUs / 1000).toFixed(0)} ms</title>
    </line>)}
    {[0, 15, 30, 45, 60].map(second => <text key={second} x={x(second * 1000)} y="169" textAnchor="middle" fill="#a1a1aa" fontSize="10">{second}s</text>)}
    {bins.length === 0 && <text x="275" y="85" textAnchor="middle" fill="#a1a1aa" fontSize="12">Waiting for audio writes…</text>}
  </svg>
}

export const UpnpPacerPill = memo(function UpnpPacerPill({ client, subscribe, connected, playing }: Props) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<DeliverySnapshot | null>(null)
  const [assessment, setAssessment] = useState(() => assessDelivery(null, null, 0))
  const [capture, setCapture] = useState<DeliveryCapture | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureGeneration, setCaptureGeneration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const previous = useRef<DeliverySnapshot | null>(null)
  const deficit = useRef(0)
  const stopCapture = useRef<(() => void) | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const mounted = useRef(true)

  const receive = useCallback((next: DeliverySnapshot) => {
    const nextAssessment = assessDelivery(next, previous.current, deficit.current)
    // Inspector reads and the heartbeat may arrive within the same observation window.
    // Keep the previous sample until a meaningful window has elapsed.
    const elapsed = next.sampledAtMs - (previous.current?.sampledAtMs ?? 0)
    if (!previous.current || next.pacerEnabled !== previous.current.pacerEnabled || next.streamId !== previous.current.streamId || elapsed >= 4000 || elapsed < 0) {
      previous.current = next
      deficit.current = nextAssessment.deficitWindows
      setAssessment(nextAssessment)
    }
    setSnapshot(next)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!connected) { previous.current = null; deficit.current = 0; return }
    let cancelled = false
    // One initial request; subsequent quiet updates ride the existing engine heartbeat.
    void client.getUpnpDelivery().then(value => { if (!cancelled) receive(value) }).catch(() => {
      if (!cancelled) setError('Delivery telemetry requires an updated playback engine.')
    })
    const unsubscribe = subscribe(event => {
      if (event.event === 'stream.disconnected') {
        previous.current = null; deficit.current = 0
        setSnapshot(null); setAssessment(assessDelivery(null, null, 0))
        stopCapture.current?.(); setCapturing(false)
        setError('The delivery event stream disconnected. Waiting for fresh observations.')
        return
      }
      if (event.event !== 'upnp.delivery') return
      try { receive(parseDeliverySnapshot(event.data)) } catch { setError('Delivery telemetry is incompatible with this client.') }
    })
    return () => { cancelled = true; unsubscribe() }
  }, [client, connected, receive, subscribe])

  useEffect(() => {
    const changed = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  useEffect(() => {
    if (!open || !connected || !playing || !visible) return
    const stop = createDeliveryCapture(options => client.getUpnpDelivery(options), next => {
      receive(next)
      setError(null)
      setCapture(next.capture)
      setCapturing(!next.capture?.complete)
    }, cause => { setError(cause.message); setCapturing(false) })
    stopCapture.current = stop
    return () => { stop(); stopCapture.current = null }
  }, [client, open, connected, playing, visible, captureGeneration, receive])

  const close = useCallback(() => { setOpen(false); trigger.current?.focus() }, [])
  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside) }
  }, [open, close])

  const toggle = async () => {
    if (!snapshot || busy) return
    setBusy(true)
    setError(null)
    try {
      await client.setUpnpPacer(!snapshot.pacerEnabled)
      const value = await client.getUpnpDelivery()
      if (!mounted.current) return
      previous.current = null
      receive(value)
      setCapture(null)
      setCaptureGeneration(n => n + 1)
    } catch { if (mounted.current) setError('Could not change pacing on the active engine. Please retry.') }
    finally { if (mounted.current) setBusy(false) }
  }

  const status = !connected ? 'assessing' : snapshot?.pacerEnabled === false ? 'off' : !playing ? 'assessing' : assessment.status
  const color = status === 'stable' ? '#34d399' : status === 'falling_behind' ? '#fb7185' : status === 'uneven' ? '#fbbf24' : '#a1a1aa'
  const maxGap = open && visible && capture ? Math.max(0, ...capture.bins.map(b => b.maxGapUs)) / 1000 : 0
  const gapBins = open && visible ? capture?.bins.filter(b => b.maxDelayUs >= 25000).length ?? 0 : 0
  const isCapturing = capturing && open && connected && playing && visible
  const requiredRate = mbps(snapshot?.realtimeBytesPerSec ?? 0)
  return <div className="relative shrink-0">
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId}
      aria-label={`UPnP Pacer: ${deliveryLabels[status]}. Inspect sender delivery`}
      onClick={() => { if (!open) { setCapture(null); setError(null) }; setOpen(value => !value) }} title="Inspect UPnP sender delivery"
      className="flex items-center gap-1.5 px-2 py-1 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-[11px] cursor-pointer">
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span><span className="transport-secondary-label">Pacer · </span>{deliveryLabels[status]}</span>
    </button>
    {open && visible && <div ref={panel} id={dialogId} role="dialog" aria-label="UPnP Delivery Inspector" tabIndex={-1}
      className="fixed bottom-20 right-4 w-[min(580px,calc(100vw-2rem))] max-h-[calc(100vh-7rem)] overflow-y-auto rounded-2xl border border-white/15 bg-[#141416] shadow-2xl p-5 text-[#f4f4f5] select-text z-[60]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
        <h2 className="text-sm font-semibold">UPnP Delivery Inspector</h2>
        <button type="button" onClick={close} aria-label="Close delivery inspector" className="p-1 text-zinc-400 hover:text-white"><X size={18} /></button>
      </div>
      <div className="flex items-center justify-between gap-4 mt-4">
        <div className="flex items-center gap-2 font-semibold" style={{ color }}>
          {status === 'uneven' || status === 'falling_behind' ? <AlertTriangle size={18} /> : <Activity size={18} />}
          <span>{deliveryLabels[status]}</span>
        </div>
        <button type="button" role="switch" aria-label="UPnP Pacer" aria-checked={snapshot?.pacerEnabled ?? false}
          disabled={!connected || !snapshot || busy} onClick={() => { void toggle() }}
          className="flex items-center gap-2 text-xs disabled:opacity-40">
          <span>UPnP Pacer</span><span className={`w-9 h-5 rounded-full p-0.5 ${snapshot?.pacerEnabled ? 'bg-[#b79a50]' : 'bg-zinc-600'}`}>
            <span className={`block w-4 h-4 bg-white rounded-full ${snapshot?.pacerEnabled ? 'translate-x-4' : ''}`} />
          </span>
        </button>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed mt-2">{!connected ? 'The active playback engine is disconnected.' : !playing ? 'Start playback to collect delivery observations.' : assessment.explanation}</p>
      {error && <p role="alert" className="mt-3 text-xs text-amber-300">{error}</p>}
      <div className="mt-5 flex justify-between items-center gap-3">
        <div><h3 className="text-xs font-medium">Sender delivery · Mbps</h3><p className="text-[10px] text-zinc-500 mt-1">100 ms intervals · up to 60s after opening · refreshes every 5s</p></div>
        {isCapturing ? <button type="button" onClick={() => { stopCapture.current?.(); setCapturing(false) }} className="flex gap-1 items-center text-xs text-zinc-300"><Pause size={13} />Freeze</button>
          : <button type="button" disabled={!connected || !playing} onClick={() => { setCapture(null); setCaptureGeneration(n => n + 1) }} className="flex gap-1 items-center text-xs text-zinc-300 disabled:opacity-40"><RotateCcw size={13} />Capture again</button>}
      </div>
      <DeliveryGraph capture={capture} requiredRate={requiredRate} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-400"><span className="text-[#d4af37]">— Measured send rate</span><span title="Current rate the pacer aims to send, including delivery headroom." className="text-indigo-300">┄ Intended send rate</span><span title="Average streaming bitrate; variable-bitrate files can vary during playback.">┄ Average track bitrate</span><span className="text-orange-300">│ Excess delay ≥25 ms</span></div>
      {capture && <p className="text-[10px] text-zinc-500 mt-2">{isCapturing ? 'Capturing' : 'Frozen'} at {(capture.elapsedMs / 1000).toFixed(1)}s. Chunked writes naturally vary by interval; buffering can create sender gaps.</p>}
      <div className="grid grid-cols-3 gap-3 border-t border-white/10 mt-4 pt-3 text-[11px]">
        <div><p className="text-zinc-500">Delivery / track</p><p className="mt-1 tabular-nums">{assessment.mbps?.toFixed(1) ?? '—'} / {requiredRate > 0 ? requiredRate.toFixed(1) : '—'} Mbps</p></div>
        <div><p className="text-zinc-500">Late intervals ≥25ms</p><p className="mt-1 tabular-nums">{gapBins} · max gap {maxGap.toFixed(0)} ms</p></div>
        <div><p className="text-zinc-500">TCP observations</p><p className="mt-1 tabular-nums">{snapshot && snapshot.tcpSamples > 0 ? `${(snapshot.rttUs / 1000).toFixed(1)} ms RTT` : 'Unavailable'}</p></div>
      </div>
      <p className="mt-4 text-[10px] leading-relaxed text-zinc-500">Sender observations do not measure packet spacing at the streamer, its audio buffer, or DAC jitter. Capture stays in RAM and expires after 60 seconds.</p>
    </div>}
  </div>
})
