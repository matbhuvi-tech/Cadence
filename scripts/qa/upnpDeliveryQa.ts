/** Isolated browser QA for the real pill component with synthetic sender telemetry.
 * Never connects to a production engine or music library. Uses Chromium CDP like coreE2eGate.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const output = path.join(root, 'test-results/upnp-delivery')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-delivery-browser-'))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const freePort = () => new Promise<number>(resolve => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port
    server.close(() => resolve(port))
  })
})

class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  readonly errors: string[] = []
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(JSON.stringify(message.params))
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
  }
  async send(method: string, params = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression: string): Promise<any> {
    const value = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result?.value
  }
  async wait(expression: string) {
    for (let i = 0; i < 100; i++) {
      if (await this.evaluate(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`Timeout: ${expression}`)
  }
  async screenshot(name: string) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, 'base64'))
  }
  close() { this.ws.close() }
}

const fixture = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { UpnpPacerPill } from '/src/components/AudioPlayer/UpnpPacerPill'
import { createEngineClient } from '/src/services/engineClient'
import '/src/index.css'
const calls = []
let listener = () => {}, enabled = true, captureId = 0, complete = false, frozenMs = 0
let sampledAtMs = 10000, bytesSent = 28000000, scheduleStalls = 0
let start = 0
let failToggle = false, currentStream = 1
const snapshot = (capture = null) => ({streamId: currentStream, sampledAtMs, pacerEnabled: enabled,
state: 'steady_maintain', bytesSent, realtimeBytesPerSec: 2800000, multiplier: 1,
writeStalls: 0, scheduleStalls, congestionEvents: 0, flowControlEvents: 0,
tcpSamples: 10, rttUs: 900, retransBytes: 0, capture})
const client = createEngineClient({engineId: 'qa-engine', libraryId: 'qa-library', label: 'QA Engine', baseUrl: 'https://qa.invalid'}, async (_target, request) => {
  calls.push(request)
  if (request.operation === 'player.upnp_pacer') {
    if (failToggle) return {ok: false, error: {code: 'unavailable'}}
    enabled = request.enabled
    return {ok:true, data:{pacerEnabled:enabled}}
  }
  if (request.captureAction === 'start') { captureId++; start = performance.now(); complete = false; frozenMs = 0 }
  if (request.captureAction === 'stop' && request.captureId === captureId) { frozenMs = performance.now() - start; complete = true }
  let capture = null
  if (request.includeCapture) {
    const elapsedMs = Math.min(60000, Math.floor(complete ? frozenMs : performance.now()-start))
    const bins = Array.from({length: Math.ceil(elapsedMs/100)}, (_, i) => ({offsetMs: i*100,
      durationMs: Math.min(100, elapsedMs-i*100), bytes: i%17 === 8 ? 0 : 280000,
      writeCount: i%17 === 8 ? 0 : 68, minChunkBytes: 4096, maxChunkBytes: 4096, timingSamples: enabled && i%17 !== 8 ? 68 : 0, minExpectedUs: 1462, maxExpectedUs: 1462, maxEarlyUs: 30, targetBytesPerSec: enabled ? 2800000 : 0, maxGapUs: i%17 === 8 ? 100000 : 5800, maxDelayUs: i%17 === 8 ? 94000 : 0}))
    capture = {id: captureId, elapsedMs, complete: complete || elapsedMs>=60000, bins}
    if (capture.complete) capture.deviation = {sampleCount: 100, meanUs: 125, medianUs: 42}
  }
  return {ok:true,data:snapshot(capture)}
})
const subscribe = callback => {listener=callback; return () => {listener=()=>{}}}
window.qa = {calls, emit: (slow=false) => {sampledAtMs+=10000; bytesSent+=28000000; if(slow) scheduleStalls++; listener({event:'upnp.delivery',data:snapshot()})},
failToggle: flag => {failToggle=flag}, disconnect: () => listener({event:'stream.disconnected'}), replace: () => {currentStream++}}
createRoot(document.getElementById('root')).render(<main className="min-h-screen bg-[#101012] text-white p-6">
<h1 className="text-lg">UPnP sender delivery · QA fixture</h1><p className="mt-2 text-zinc-500">Synthetic data; no playback engine connection.</p>
<footer className="fixed bottom-3 left-1/2 -translate-x-1/2 w-[calc(100%-1.5rem)] border border-white/10 rounded-xl p-4 flex justify-end gap-3">
<button>Output · ROSE RS130</button><UpnpPacerPill client={client} subscribe={subscribe} connected={true} playing={true} /><button>Signal path</button>
</footer></main>)
`

let vite: ChildProcess | undefined, browser: ChildProcess | undefined, cdp: Cdp | undefined
function kill(child?: ChildProcess) {
  if (!child?.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
}
try {
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'fixture.tsx'), fixture)
  fs.writeFileSync(path.join(output, 'index.html'), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>')
  const vitePort = await freePort(), cdpPort = await freePort()
  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' })
  const binary = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file))
  assert.ok(binary, 'Chromium/Edge must be installed for browser QA')
  browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let tabs: any[] = []
  for (let i=0;i<100;i++) {
    try {
      await fetch(`http://127.0.0.1:${vitePort}`)
      tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json() as any[]
      if (tabs.length) break
    } catch {}
    await sleep(100)
  }
  assert.ok(tabs.length, 'browser and preview must start')
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl)
  await new Promise<void>(resolve => ws.addEventListener('open', () => resolve(), {once:true}))
  cdp = new Cdp(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false})
  await cdp.send('Page.navigate', {url:`http://127.0.0.1:${vitePort}/test-results/upnp-delivery/index.html`})
  await cdp.wait('window.qa && document.querySelector("[aria-haspopup=dialog]")')
  await cdp.wait('window.qa.calls.length === 1')
  await cdp.evaluate('window.qa.emit()')
  await cdp.wait('document.body.textContent.includes("Pacer · Pacing steady")')
  assert.equal(await cdp.evaluate('window.qa.calls.some(c=>c.captureAction === "start")'),false,'closed pill must not collect history')
  await cdp.evaluate('document.querySelector("[aria-haspopup=dialog]").click()')
  await cdp.wait('document.querySelector("[role=dialog]") && window.qa.calls.some(c=>c.captureAction === "start")')
  await sleep(5200)
  await cdp.wait('document.querySelector("svg[role=img] path").getAttribute("d").length > 0')
  assert.ok(await cdp.evaluate('document.body.textContent.includes("4096 bytes · consistent")'))
  assert.ok(await cdp.evaluate('document.body.textContent.includes("1.462 ms")'))
  assert.ok(await cdp.evaluate('document.querySelector("svg[role=img]").textContent.includes("Deviation (ms)")'))
  assert.equal(await cdp.evaluate('document.body.textContent.includes("Absolute timing deviation")'), false)
  await cdp.screenshot('desktop.png')
  await cdp.evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent === "Freeze").click()')
  await cdp.wait('window.qa.calls.at(-1).captureAction === "stop"')
  await cdp.wait('document.body.textContent.includes("Mean 0.125 ms · Median 0.042 ms")')
  const frozenCalls = await cdp.evaluate('window.qa.calls.length')
  await sleep(5200)
  assert.equal(await cdp.evaluate('window.qa.calls.length'), frozenCalls, 'freeze must cancel subsequent reads')
  await cdp.evaluate('document.querySelector("[role=switch]").click()')
  await cdp.wait('document.querySelector("[role=switch]").getAttribute("aria-checked") === "false"')
  await cdp.evaluate('window.qa.failToggle(true); document.querySelector("[role=switch]").click()')
  await cdp.wait('document.querySelector("[role=alert]")')
  assert.equal(await cdp.evaluate('document.querySelector("[role=switch]").getAttribute("aria-checked")'), 'false', 'failed toggle must preserve the observed engine state')
  await cdp.send('Emulation.setDeviceMetricsOverride', {width:375,height:812,deviceScaleFactor:1,mobile:true})
  const rect = await cdp.evaluate('(()=>{const r=document.querySelector("[role=dialog]").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()')
  assert.ok(rect.left >= 0 && rect.right <= 375 && rect.top >= 0 && rect.bottom <= 812, JSON.stringify(rect))
  await cdp.screenshot('narrow.png')
  await cdp.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27})
  await cdp.wait('!document.querySelector("[role=dialog]")')
  assert.equal(await cdp.evaluate('document.activeElement.getAttribute("aria-haspopup")'), 'dialog')
  await cdp.evaluate('window.qa.failToggle(false); window.qa.emit(true)')
  await cdp.evaluate('document.querySelector("[aria-haspopup=dialog]").click()')
  await cdp.wait('document.querySelector("[role=dialog]")')
  await cdp.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
  await cdp.wait('window.qa.calls.at(-1).captureAction === "stop"')
  await sleep(500) // Let an in-flight capture start resolve and be stopped before counting.
  const hiddenCalls = await cdp.evaluate('window.qa.calls.length')
  await sleep(5200)
  assert.equal(await cdp.evaluate('window.qa.calls.length'), hiddenCalls, 'hidden inspector must not poll')
  assert.deepEqual(cdp.errors, [], 'no unhandled browser exceptions')
  const report = {result:'PASS', checks:['closed pill has no history capture','stable heartbeat status','on-demand graph','five-second batches','freeze stops reads','toggle verified by engine','toggle failure preserves state','375px dialog bounds','Escape restores focus','hidden window stops capture'], screenshots:['desktop.png','narrow.png'], fixture:'synthetic telemetry; real component and RPC client; no physical streamer'}
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2))
} finally {
  cdp?.close(); kill(browser); kill(vite)
  // Keep screenshots/report, but remove executable fixture files after QA.
  for (const file of ['fixture.tsx','index.html']) fs.rmSync(path.join(output,file),{force:true})
  const resolvedProfile = path.resolve(profile)
  if (path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('cadence-delivery-browser-')) {
    fs.rmSync(resolvedProfile, {recursive:true,force:true,maxRetries:10,retryDelay:100})
  }
}
