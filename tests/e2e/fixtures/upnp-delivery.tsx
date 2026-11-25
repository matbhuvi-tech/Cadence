import React from 'react'
import { createRoot } from 'react-dom/client'
import { UpnpPacerPill } from '/src/components/AudioPlayer/UpnpPacerPill'
import { createEngineClient } from '/src/services/engineClient'
import '/src/index.css'

type QaRequest = Record<string, unknown>
type Listener = (event: { event: string; data?: unknown }) => void

const calls: QaRequest[] = []
let listener: Listener = () => {}
let enabled = true
let captureId = 0
let complete = false
let frozenMs = 0
let sampledAtMs = 10_000
let bytesSent = 28_000_000
let scheduleStalls = 0
let start = 0
let failToggle = false
let currentStream = 1

const snapshot = (capture: Record<string, unknown> | null = null) => ({
  streamId: currentStream,
  sampledAtMs,
  pacerEnabled: enabled,
  state: 'steady_maintain',
  bytesSent,
  realtimeBytesPerSec: 2_800_000,
  multiplier: 1,
  writeStalls: 0,
  scheduleStalls,
  congestionEvents: 0,
  flowControlEvents: 0,
  tcpSamples: 10,
  rttUs: 900,
  retransBytes: 0,
  capture,
})

const client = createEngineClient(
  {
    engineId: 'qa-engine',
    libraryId: 'qa-library',
    label: 'QA Engine',
    baseUrl: 'https://qa.invalid',
  },
  async (_target, request) => {
    const req = request as QaRequest
    calls.push(req)
    if (req.operation === 'player.upnp_pacer') {
      if (failToggle) {
        return { ok: false, error: { code: 'unavailable', message: 'Engine unavailable' } }
      }
      enabled = Boolean(req.enabled)
      return { ok: true, data: { pacerEnabled: enabled } }
    }
    if (req.captureAction === 'start') {
      captureId += 1
      start = performance.now()
      complete = false
      frozenMs = 0
    }
    if (req.captureAction === 'stop' && req.captureId === captureId) {
      frozenMs = performance.now() - start
      complete = true
    }
    let capture: Record<string, unknown> | null = null
    if (req.includeCapture) {
      const elapsedMs = Math.min(60_000, Math.floor(complete ? frozenMs : performance.now() - start))
      const bins = Array.from({ length: Math.ceil(elapsedMs / 100) }, (_, i) => ({
        offsetMs: i * 100,
        durationMs: Math.min(100, elapsedMs - i * 100),
        bytes: i % 17 === 8 ? 0 : 280_000,
        writeCount: i % 17 === 8 ? 0 : 68,
        minChunkBytes: 4096,
        maxChunkBytes: 4096,
        timingSamples: enabled && i % 17 !== 8 ? 68 : 0,
        minExpectedUs: 1462,
        maxExpectedUs: 1462,
        maxEarlyUs: 30,
        targetBytesPerSec: enabled ? 2_800_000 : 0,
        maxGapUs: i % 17 === 8 ? 100_000 : 5800,
        maxDelayUs: i % 17 === 8 ? 94_000 : 0,
      }))
      capture = { id: captureId, elapsedMs, complete: complete || elapsedMs >= 60_000, bins }
      if (capture.complete) {
        capture.deviation = { sampleCount: 100, meanUs: 125, medianUs: 42 }
      }
    }
    return { ok: true, data: snapshot(capture) }
  }
)

const subscribe = (callback: Listener) => {
  listener = callback
  return () => {
    listener = () => {}
  }
}

;(window as unknown as { qa: Record<string, unknown> }).qa = {
  calls,
  emit: (slow = false) => {
    sampledAtMs += 10_000
    bytesSent += 28_000_000
    if (slow) scheduleStalls += 1
    listener({ event: 'upnp.delivery', data: snapshot() })
  },
  failToggle: (flag: boolean) => {
    failToggle = flag
  },
  disconnect: () => listener({ event: 'stream.disconnected' }),
  replace: () => {
    currentStream += 1
  },
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <main className="min-h-screen bg-[#101012] text-white p-6">
      <h1 className="text-lg">UPnP sender delivery · QA fixture</h1>
      <p className="mt-2 text-zinc-500">Synthetic data; no playback engine connection.</p>
      <footer className="fixed bottom-3 left-1/2 -translate-x-1/2 w-[calc(100%-1.5rem)] border border-white/10 rounded-xl p-4 flex justify-end gap-3">
        <button type="button">Output · ROSE RS130</button>
        <UpnpPacerPill client={client} subscribe={subscribe} connected={true} playing={true} />
        <button type="button">Signal path</button>
      </footer>
    </main>
  )
}
