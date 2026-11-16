/**
 * Stage P0 — Layer 3 Real Browser/CDP + cadence-headless + PWA Dual-Controller E2E Gate.
 *
 * Drives real headless Chrome over CDP against:
 *   1. Real `cadence-headless.exe --dragonfish` (loopback-isolated, fake RS130 UDN so it
 *      never touches LAN hardware).
 *   2. Real Desktop UI (`http://127.0.0.1:5173`) in Browser Tab 1.
 *   3. Real Android PWA (`http://127.0.0.1:5174`) in Browser Tab 2.
 *   4. A strict passthrough HTTP Correlating Proxy (and an explicit CORS probe + PWA
 *      diagnostic relay) capturing every UI action (`cid_...`), `/v1/core` request/response,
 *      session revision, queue entries, and DOM/screenshot evidence.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

interface CoreWireEvent {
  seq: number
  timestamp: string
  proxyKind: 'strict' | 'pwa-diagnostic'
  correlationId: string
  method: string
  path: string
  operation?: string
  action?: string
  commandId?: string
  expectedRevision?: number
  requestedTrackId?: string
  requestedEntriesCount?: number
  statusCode: number
  ok?: boolean
  errorCode?: string
  responseRevision?: number
  queueEntriesCount?: number
  currentEntryId?: string | null
  playbackActivity?: string | null
  playbackTrackId?: string | null
  allowHeadersObserved?: string | null
}

interface ScenarioOutcome {
  id: string
  name: string
  status: 'PASS' | 'REPRODUCED_DEFECT' | 'FAIL'
  correlationId: string
  details: string
  evidence: Record<string, unknown>
  screenshot?: string
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const RESULTS_DIR = path.join(REPO_ROOT, 'test-results', 'core-e2e')
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

function findBrowserBinary(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`No Chromium/Edge binary found in: ${CHROME_CANDIDATES.join(', ')}`)
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHttpReady(url: string, timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url)
      if (resp.ok || resp.status < 500) return
    } catch {
      // retry
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function killProcessTree(proc: ChildProcess | null | undefined): void {
  if (!proc || !proc.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' })
    } catch {
      // ignore
    }
  } else {
    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
}

function redactText(input: string): string {
  return input
    .replace(
      /\b(token|pairingToken|x-cadence-token|authorization)(["']?\s*[:]\s*["']?)([^"'\s,&}\]]+)/gi,
      '$1$2<redacted>'
    )
    .replace(/([?&]token=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(\/media\/)[A-Za-z0-9._-]+/g, '$1<redacted-run-token>')
}

interface RecordedSoapCall {
  action: string
  uri?: string
  target?: string
}

interface NodeRs130Simulator {
  descUrl: string
  getState: () => {
    currentUri: string
    transportState: string
    relTime: string
    soapCalls: RecordedSoapCall[]
  }
  setExternalPlaying: (uri: string, relTime?: string) => void
  setExternalPaused: (relTime: string) => void
  resetSoapCalls: () => void
  close: () => void
}

function startNodeRs130Simulator(udn: string): Promise<NodeRs130Simulator> {
  return new Promise((resolve, reject) => {
    let currentUri = ''
    let transportState = 'STOPPED'
    let relTime = '00:00:00'
    const trackDuration = '00:03:30'
    const soapCalls: RecordedSoapCall[] = []

    const extractTag = (xml: string, tag: string): string | undefined => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
      return m ? m[1] : undefined
    }

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const urlPath = (req.url || '/').split('?')[0]
        if (req.method === 'GET' && urlPath === '/desc.xml') {
          const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>ROSE-RS130</friendlyName>
    <manufacturer>CITECH</manufacturer>
    <modelName>RS130</modelName>
    <modelDescription>HiFi ROSE Network Transport</modelDescription>
    <UDN>${udn}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/AVTransport/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`
          res.writeHead(200, { 'Content-Type': 'text/xml', Connection: 'close' })
          res.end(xml)
          return
        }

        const rawSoap = req.headers['soapaction']
        const soapHeader = Array.isArray(rawSoap) ? rawSoap[0] : rawSoap || ''
        const action = soapHeader.replace(/"/g, '').split('#').pop() || ''

        let responseXml =
          '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>'
        if (action === 'SetAVTransportURI') {
          const uri = extractTag(body, 'CurrentURI') || ''
          currentUri = uri
          soapCalls.push({ action, uri })
          responseXml =
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetAVTransportURIResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>'
        } else if (action === 'Play') {
          transportState = 'PLAYING'
          soapCalls.push({ action })
          responseXml =
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>'
        } else if (action === 'Pause') {
          transportState = 'PAUSED_PLAYBACK'
          soapCalls.push({ action })
          responseXml =
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PauseResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>'
        } else if (action === 'Stop') {
          transportState = 'STOPPED'
          soapCalls.push({ action })
          responseXml =
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:StopResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>'
        } else if (action === 'Seek') {
          const target = extractTag(body, 'Target') || '00:00:00'
          relTime = target
          soapCalls.push({ action, target })
          responseXml =
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SeekResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>'
        } else if (action === 'GetTransportInfo') {
          soapCalls.push({ action })
          responseXml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><CurrentTransportState>${transportState}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed></u:GetTransportInfoResponse></s:Body></s:Envelope>`
        } else if (action === 'GetPositionInfo') {
          soapCalls.push({ action })
          responseXml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><Track>1</Track><TrackDuration>${trackDuration}</TrackDuration><TrackURI>${currentUri}</TrackURI><RelTime>${relTime}</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>`
        } else if (action === 'GetMediaInfo') {
          soapCalls.push({ action })
          responseXml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetMediaInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><NrTracks>1</NrTracks><MediaDuration>${trackDuration}</MediaDuration><CurrentURI>${currentUri}</CurrentURI></u:GetMediaInfoResponse></s:Body></s:Envelope>`
        } else {
          soapCalls.push({ action })
        }

        res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', Connection: 'close' })
        res.end(responseXml)
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        descUrl: `http://127.0.0.1:${addr.port}/desc.xml`,
        getState: () => ({
          currentUri,
          transportState,
          relTime,
          soapCalls: [...soapCalls],
        }),
        setExternalPlaying: (uri: string, nextRelTime = '00:00:42') => {
          currentUri = uri
          transportState = 'PLAYING'
          relTime = nextRelTime
        },
        setExternalPaused: (nextRelTime: string) => {
          transportState = 'PAUSED_PLAYBACK'
          relTime = nextRelTime
        },
        resetSoapCalls: () => {
          soapCalls.length = 0
        },
        close: () => server.close(),
      })
    })
  })
}

function startCorrelatingProxy(
  upstreamPort: number,
  proxyKind: 'strict',
  wireLog: CoreWireEvent[],
  getActiveCid: () => string
): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve, reject) => {
    let seqCounter = 0
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => {
        const reqBody = Buffer.concat(chunks)
        const cidHeader = req.headers['x-cadence-correlation-id']
        const correlationId =
          (Array.isArray(cidHeader) ? cidHeader[0] : cidHeader) || getActiveCid() || 'cid_background'

        // Never forward test-only correlation header upstream if requested only for local proxy visibility
        const forwardHeaders: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue
          if (k.toLowerCase() === 'host') {
            forwardHeaders[k] = `127.0.0.1:${upstreamPort}`
          } else if (k.toLowerCase() === 'x-cadence-correlation-id') {
            continue
          } else {
            forwardHeaders[k] = v
          }
        }

        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port: upstreamPort,
            path: req.url || '/',
            method: req.method || 'GET',
            headers: forwardHeaders,
          },
          (upstreamRes) => {
            const respChunks: Buffer[] = []
            upstreamRes.on('data', (c) =>
              respChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
            )
            upstreamRes.on('end', () => {
              const respBody = Buffer.concat(respChunks)
              const headersOut: Record<string, string | string[]> = {}
              for (const [k, v] of Object.entries(upstreamRes.headers)) {
                if (v !== undefined) headersOut[k] = v
              }
              const observedAllow =
                typeof headersOut['access-control-allow-headers'] === 'string'
                  ? headersOut['access-control-allow-headers']
                  : null

              const urlPath = (req.url || '/').split('?')[0]
              if (urlPath === '/v1/core') {
                let parsedReq: Record<string, unknown> = {}
                let parsedRes: Record<string, unknown> = {}
                try {
                  parsedReq = reqBody.length ? JSON.parse(reqBody.toString('utf8')) : {}
                } catch {
                  // ignore
                }
                try {
                  parsedRes = respBody.length ? JSON.parse(respBody.toString('utf8')) : {}
                } catch {
                  // ignore
                }
                const resData = (parsedRes.data ?? {}) as Record<string, unknown>
                const resQueue = (resData.queue ?? {}) as Record<string, unknown>
                const resPlayback = (resData.playback ?? {}) as Record<string, unknown>
                const resErr = (parsedRes.error ?? {}) as Record<string, unknown>
                wireLog.push({
                  seq: ++seqCounter,
                  timestamp: new Date().toISOString(),
                  proxyKind,
                  correlationId:
                    typeof parsedReq.commandId === 'string' && parsedReq.commandId.includes('cid_')
                      ? parsedReq.commandId
                      : correlationId,
                  method: req.method || 'GET',
                  path: urlPath,
                  operation:
                    typeof parsedReq.operation === 'string' ? parsedReq.operation : undefined,
                  action: typeof parsedReq.action === 'string' ? parsedReq.action : undefined,
                  commandId:
                    typeof parsedReq.commandId === 'string' ? parsedReq.commandId : undefined,
                  expectedRevision:
                    typeof parsedReq.expectedRevision === 'number'
                      ? parsedReq.expectedRevision
                      : undefined,
                  requestedTrackId:
                    typeof parsedReq.trackId === 'string' ? parsedReq.trackId : undefined,
                  requestedEntriesCount: Array.isArray(parsedReq.entries)
                    ? parsedReq.entries.length
                    : undefined,
                  statusCode: upstreamRes.statusCode || 500,
                  ok: typeof parsedRes.ok === 'boolean' ? parsedRes.ok : undefined,
                  errorCode: typeof resErr.code === 'string' ? resErr.code : undefined,
                  responseRevision:
                    typeof resData.revision === 'number' ? resData.revision : undefined,
                  queueEntriesCount: Array.isArray(resQueue.entries)
                    ? resQueue.entries.length
                    : undefined,
                  currentEntryId:
                    typeof resQueue.currentEntryId === 'string'
                      ? resQueue.currentEntryId
                      : resQueue.currentEntryId === null
                        ? null
                        : undefined,
                  playbackActivity:
                    typeof resPlayback.activity === 'string' ? resPlayback.activity : undefined,
                  playbackTrackId:
                    typeof resPlayback.trackId === 'string' ? resPlayback.trackId : undefined,
                  allowHeadersObserved: observedAllow,
                })
              }

              delete headersOut['content-length']
              headersOut['content-length'] = String(respBody.length)
              res.writeHead(upstreamRes.statusCode || 500, headersOut)
              res.end(respBody)
            })
          }
        )
        proxyReq.on('error', (err) => {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'proxy_upstream_error', detail: err.message } }))
        })
        if (reqBody.length > 0) proxyReq.write(reqBody)
        proxyReq.end()
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, server })
    })
  })
}

class CdpSession {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  public consoleErrors: string[] = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
      if (typeof msg.id === 'number') {
        const slot = this.pending.get(msg.id)
        if (slot) {
          this.pending.delete(msg.id)
          if (msg.error) {
            slot.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          } else {
            slot.resolve(msg.result)
          }
        }
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const text = msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'exception'
        this.consoleErrors.push(redactText(String(text)))
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params?.args || [])
          .map((a: Record<string, unknown>) => String(a.value ?? a.description ?? ''))
          .join(' ')
        this.consoleErrors.push(redactText(text))
      }
    })
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', (e) => reject(new Error(`CDP WebSocket error: ${String(e)}`)), { once: true })
    })
    const client = new CdpSession(ws)
    await client.send('Page.enable')
    await client.send('DOM.enable')
    await client.send('Runtime.enable')
    return client
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return (await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })) as Record<string, unknown>
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    const exc = res.exceptionDetails as Record<string, unknown> | undefined
    if (exc) {
      throw new Error(`Evaluate exception: ${JSON.stringify(exc)}`)
    }
    const result = res.result as Record<string, unknown> | undefined
    return result?.value as T
  }

  async waitFor(predicateExpr: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await this.evaluate<boolean>(`Boolean(${predicateExpr})`)
      if (ok) return
      await sleep(120)
    }
    throw new Error(`Timed out waiting for condition: ${predicateExpr}`)
  }

  async captureScreenshot(filePath: string): Promise<string> {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const b64 = String(res.data || '')
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'))
    return filePath
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}

function seedE2eFixtures(dbPath: string, musicDir: string): void {
  const pyScript = `
import os, sqlite3, struct

db_path = r"""${dbPath}"""
music_dir = r"""${musicDir}"""
os.makedirs(music_dir, exist_ok=True)
os.makedirs(os.path.join(music_dir, 'e2e_browse_subdir'), exist_ok=True)
cover_png_path = os.path.join(music_dir, 'goldberg_cover.png')
# Minimal valid 1x1 PNG image so Core /v1/artwork/rel_goldberg serves real PNG bytes
import base64
with open(cover_png_path, 'wb') as cf:
    cf.write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))

def make_wav(path, sr=44100, bits=16, payload_bytes=4096):
    ch = 2
    br = sr * ch * (bits // 8)
    ba = ch * (bits // 8)
    hdr = b'RIFF' + struct.pack('<I', 36 + payload_bytes) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, ch, sr, br, ba, bits) + b'data' + struct.pack('<I', payload_bytes)
    with open(path, 'wb') as f:
        f.write(hdr + (b'\\x11\\x22' * (payload_bytes // 2)))
    return len(hdr) + payload_bytes

def make_dsf(path, audio_len=16384):
    meta_off = 80 + audio_len
    total = meta_off + 256
    sr = 2822400
    samples = sr * 2
    buf = bytearray()
    buf += b'DSD ' + struct.pack('<QQQ', 28, total, meta_off)
    buf += b'fmt ' + struct.pack('<QIIIIIIQII', 52, 1, 0, 2, 2, sr, 1, samples, 4096, 0)
    buf += b'\\x55' * audio_len
    buf += b'\\x00' * 256
    with open(path, 'wb') as f:
        f.write(buf)
    return len(buf)

conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute(
    "INSERT OR REPLACE INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp) VALUES ('m_e2e', 'E2E Music', ?, 'nas', 'zfs', '2026-11-15T00:00:00Z')",
    (music_dir,)
)

releases = [
    ('rel_std_1988', 'Symphony No. 5', 'Berlin Phil', 1988, 0),
    ('rel_rem_2015', 'Symphony No. 5', 'Berlin Phil', 2015, 0),
    ('rel_goldberg', 'Goldberg Variations', 'Glenn Gould', 1981, 0),
    ('rel_comp_world', 'A World Of Music', 'Various Artists', 2020, 1),
    ('rel_blue_train', 'Blue Train', 'John Coltrane', 1957, 0),
    ('rel_mega_220', 'Mega Anthology', 'Composer Collective', 2024, 0),
]
for rid, title, artist, year, is_comp in releases:
    cur.execute(
        "INSERT OR REPLACE INTO releases (id, title, folder_path, folder_name, artist_credit, release_year, is_compilation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-11-15T00:00:00Z')",
        (rid, title, music_dir, title, artist, year, is_comp)
    )
with open(cover_png_path, 'rb') as cf:
    cur.execute(
        'INSERT OR REPLACE INTO engine_artwork (release_id, etag, jpeg) VALUES (?, ?, ?)',
        ('rel_goldberg', 'e2e_goldberg_v1', cf.read())
    )

tracks = []
# 1) Standard 1988 CD Edition (WAV 16/44.1) vs 2015 Remaster (FLAC 24/192) — shared album title!
for i, ttitle in enumerate(['Allegro Con Brio (1988)', 'Andante (1988)', 'Finale (1988)'], start=1):
    fp = os.path.join(music_dir, f'sym_1988_{i}.wav')
    sz = make_wav(fp, 44100, 16)
    tracks.append((f'trk_sym88_{i}', 'rel_std_1988', fp, os.path.basename(fp), sz, ttitle, 'Berlin Phil', 'Symphony No. 5', 1, i, 180.0, 'WAV', 44100, 16))
for i, ttitle in enumerate(['Allegro Con Brio (2015 Remaster)', 'Andante (2015 Remaster)', 'Finale (2015 Remaster)'], start=1):
    fp = os.path.join(music_dir, f'sym_2015_{i}.flac')
    sz = make_wav(fp, 192000, 24)
    tracks.append((f'trk_sym15_{i}', 'rel_rem_2015', fp, os.path.basename(fp), sz, ttitle, 'Berlin Phil', 'Symphony No. 5', 1, i, 185.0, 'FLAC', 192000, 24))

# 2) Multi-disc + DSD64 + repeated track title ("Aria")
gb_specs = [
    ('trk_gb_1', 'Aria', 1, 1, 'FLAC', 96000, 24, 'gb_d1_t1.flac'),
    ('trk_gb_2', 'Variation 01', 1, 2, 'FLAC', 96000, 24, 'gb_d1_t2.flac'),
    ('trk_gb_3', 'Variation 02', 2, 1, 'DSF', 2822400, 1, 'gb_d2_t1.dsf'),
    ('trk_gb_4', 'Aria', 2, 2, 'DSF', 2822400, 1, 'gb_d2_t2.dsf'),
]
for tid, ttitle, disc, num, fmt, sr, bd, fn in gb_specs:
    fp = os.path.join(music_dir, fn)
    sz = make_dsf(fp) if fmt == 'DSF' else make_wav(fp, sr, bd)
    tracks.append((tid, 'rel_goldberg', fp, fn, sz, ttitle, 'Glenn Gould', 'Goldberg Variations', disc, num, 210.0, fmt, sr, bd))

# 3) Compilation with colliding track_number=1 across Disc 1 and Disc 2
comp_specs = [
    ('trk_comp_1', 'Dawn Raga', 'Artist Alpha', 1, 1, 'comp_d1_t1.flac'),
    ('trk_comp_2', 'Noon Raga', 'Artist Beta', 1, 2, 'comp_d1_t2.flac'),
    ('trk_comp_3', 'Dusk Raga', 'Artist Gamma', 2, 1, 'comp_d2_t1.wav'),
]
for tid, ttitle, art, disc, num, fn in comp_specs:
    fp = os.path.join(music_dir, fn)
    sz = make_wav(fp, 48000, 24)
    fmt = 'WAV' if fn.endswith('.wav') else 'FLAC'
    tracks.append((tid, 'rel_comp_world', fp, fn, sz, ttitle, art, 'A World Of Music', disc, num, 240.0, fmt, 48000, 24))

# 4) Album B for rapid A -> B album switch
for i, ttitle in enumerate(['Blue Train', 'Moments Notice', 'Locomotion', 'Im Old Fashioned'], start=1):
    fp = os.path.join(music_dir, f'bt_{i}.flac')
    sz = make_wav(fp, 192000, 24)
    tracks.append((f'trk_bt_{i}', 'rel_blue_train', fp, os.path.basename(fp), sz, ttitle, 'John Coltrane', 'Blue Train', 1, i, 260.0, 'FLAC', 192000, 24))

# 5) 210-track Mega Anthology (>200 tracks across catalog.page boundary)
for i in range(1, 211):
    fp = os.path.join(music_dir, f'mega_{i:03d}.flac')
    sz = make_wav(fp, 44100, 16, 1024)
    disc = ((i - 1) // 50) + 1
    tnum = ((i - 1) % 50) + 1
    tracks.append((f'trk_mega_{i:03d}', 'rel_mega_220', fp, os.path.basename(fp), sz, f'Etude {i:03d}', 'Composer Collective', 'Mega Anthology', disc, tnum, 90.0, 'FLAC', 44100, 16))

for row in tracks:
    tid, rid, fp, fn, sz, ttitle, art, alb, disc, num, dur, fmt, sr, bd = row
    has_art = 1 if rid == 'rel_goldberg' else 0
    cur.execute(
        """INSERT OR REPLACE INTO tracks (
            id, release_id, mount_id, folder_path, folder_name, file_path, file_name,
            file_size, mtime, title, artist_credit, album_title, disc_number, track_number,
            duration_secs, format, sample_rate, bit_depth, channels, has_embedded_art, created_at
        ) VALUES (?, ?, 'm_e2e', ?, ?, ?, ?, ?, 1700000000, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, '2026-11-15T00:00:00Z')""",
        (tid, rid, music_dir, alb, fp, fn, sz, ttitle, art, alb, disc, num, dur, fmt, sr, bd, has_art)
    )

conn.commit()
conn.close()
print(f"Seeded {len(tracks)} synthetic tracks cleanly.")
`
  const res = spawnSync('python', ['-c', pyScript], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`Python SQLite fixture seeding failed: ${res.stderr || res.stdout}`)
  }
}

async function run(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const skipCargoBuild = args.has('--skip-build')

  fs.mkdirSync(RESULTS_DIR, { recursive: true })

  const headlessBin = path.join(REPO_ROOT, 'src-tauri', 'target', 'debug', 'cadence-headless.exe')
  if (!skipCargoBuild || !fs.existsSync(headlessBin)) {
    console.log('[E2E] Building cadence-headless.exe...')
    const buildRes = spawnSync(
      'cargo',
      ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'cadence-headless'],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    )
    if (buildRes.status !== 0) {
      throw new Error('Failed to build cadence-headless.exe')
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-core-e2e-'))
  const appDataDir = path.join(tempRoot, 'var_lib_cadence')
  const musicDir = path.join(tempRoot, 'music_ro')
  const tmpDir = path.join(tempRoot, 'tmp')
  const chromeProfileDir = path.join(tempRoot, 'chrome_profile')
  fs.mkdirSync(appDataDir, { recursive: true })
  fs.mkdirSync(musicDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(chromeProfileDir, { recursive: true })

  const rawCorePort = await getFreePort()
  const mediaPort = await getFreePort()
  const cdpPort = await getFreePort()
  const desktopPort = await getFreePort()
  const pwaPort = await getFreePort()

  const wireLog: CoreWireEvent[] = []
  let activeCid = 'cid_boot'
  const getActiveCid = () => activeCid

  let rs130Sim: NodeRs130Simulator | null = null
  let coreProc: ChildProcess | null = null
  let desktopViteProc: ChildProcess | null = null
  let pwaViteProc: ChildProcess | null = null
  let chromeProc: ChildProcess | null = null
  let strictProxyServer: http.Server | null = null
  let desktopCdp: CdpSession | null = null
  let pwaCdp: CdpSession | null = null

  const scenarios: ScenarioOutcome[] = []
  const E2E_PAIRING_TOKEN = 'cadence_e2e_pairing_token_0123456789abcdef'

  const spawnCore = async (): Promise<ChildProcess> => {
    const proc = spawn(
      headlessBin,
      [
        '--dragonfish',
        '--app-data-dir',
        appDataDir,
        '--music-dir',
        musicDir,
        '--tmp-dir',
        tmpDir,
        '--advertised-ip',
        '127.0.0.1',
        '--control-port',
        String(rawCorePort),
        '--media-port',
        String(mediaPort),
        '--label',
        'E2E Gate Core',
        '--headroom-mb',
        '64',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CADENCE_ALLOW_LOOPBACK: 'true',
          CADENCE_MUSIC_READ_ONLY: 'true',
          CADENCE_PAIRING_TOKEN: E2E_PAIRING_TOKEN,
          CADENCE_PINNED_RS130_UDN: 'uuid:cadence-e2e-isolated-rs130',
          ...(rs130Sim ? { CADENCE_RS130_DESC_URL: rs130Sim.descUrl } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    await waitForHttpReady(`http://127.0.0.1:${rawCorePort}/healthz`, 20000)
    return proc
  }

  try {
    // Step 0: Start isolated local RS130 UPnP simulator (never touches LAN 192.168.1.106)
    rs130Sim = await startNodeRs130Simulator('uuid:cadence-e2e-isolated-rs130')

    // Step 1: Boot Core once to initialize schema cleanly, seed SQLite + files, then reboot Core
    console.log('[E2E] Initializing cadence.db schema via cadence-headless.exe...')
    coreProc = await spawnCore()
    killProcessTree(coreProc)
    coreProc = null
    await sleep(300)

    seedE2eFixtures(path.join(appDataDir, 'cadence.db'), musicDir)
    coreProc = await spawnCore()
    const healthResp = (await (
      await fetch(`http://127.0.0.1:${rawCorePort}/healthz`)
    ).json()) as Record<string, unknown>
    const coreEngineId = String(healthResp.engineId)
    const coreLibraryId = String(healthResp.libraryId)
    console.log(`[E2E] cadence-headless online on :${rawCorePort} (engine=${coreEngineId})`)

    // Step 2: Start Strict Correlating Proxy (serves both Desktop & PWA directly without header overrides)
    const strictProxy = await startCorrelatingProxy(rawCorePort, 'strict', wireLog, getActiveCid)
    strictProxyServer = strictProxy.server

    // Step 3: Start Vite servers on isolated 127.0.0.1 ports
    console.log(`[E2E] Starting Desktop Vite (${desktopPort}) and PWA Vite (${pwaPort})...`)
    const viteLogs: string[] = []
    desktopViteProc = spawn(
      'cmd',
      ['/c', `npx vite --host 127.0.0.1 --port ${desktopPort} --strictPort`],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    pwaViteProc = spawn(
      'cmd',
      ['/c', `npx vite --host 127.0.0.1 --port ${pwaPort} --strictPort`],
      { cwd: path.join(REPO_ROOT, 'pwa'), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    for (const [tag, p] of [['desktop-vite', desktopViteProc], ['pwa-vite', pwaViteProc]] as const) {
      p.stdout?.on('data', (d) => viteLogs.push(`[${tag}] ${String(d).trim()}`))
      p.stderr?.on('data', (d) => viteLogs.push(`[${tag}:err] ${String(d).trim()}`))
    }
    try {
      await Promise.all([
        waitForHttpReady(`http://127.0.0.1:${desktopPort}/`, 45000),
        waitForHttpReady(`http://127.0.0.1:${pwaPort}/`, 45000),
      ])
    } catch (err) {
      console.error('[E2E] Vite startup logs:\n' + viteLogs.slice(-20).join('\n'))
      throw err
    }

    // Step 4: Launch Headless Chrome with CDP
    const browserBin = findBrowserBinary()
    console.log(`[E2E] Launching browser via CDP on :${cdpPort}...`)
    chromeProc = spawn(
      browserBin,
      [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeProfileDir}`,
        '--window-size=1440,900',
        '--no-first-run',
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore' }
    )
    await waitForHttpReady(`http://127.0.0.1:${cdpPort}/json/version`, 20000)

    const createTab = async (url: string): Promise<CdpSession> => {
      const targetResp = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
      })
      const target = (await targetResp.json()) as { webSocketDebuggerUrl: string }
      const cdp = await CdpSession.connect(target.webSocketDebuggerUrl)
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            window.__cadenceActiveCid = 'cid_init';
          })();
        `,
      })
      await cdp.send('Page.navigate', { url })
      return cdp
    }

    desktopCdp = await createTab(`http://127.0.0.1:${desktopPort}/`)
    pwaCdp = await createTab(`http://127.0.0.1:${pwaPort}/`)

    // Inject fetch hook helpers cleanly on initial load too
    await desktopCdp.waitFor(
      `document.body && document.body.innerText.includes('Connect to a Cadence Playback Engine') && !document.querySelector('[aria-label="Loading configuration"]') && Boolean(document.querySelector('#gate-address-input'))`,
      25000
    )

    // Scenario 1: Open Windows Cadence in Phase 2 Engine-required EngineConnectionGate (zero local SQLite / This PC fallback)
    activeCid = 'cid_s1_engine_gate'
    await desktopCdp.evaluate(`window.__cadenceActiveCid = '${activeCid}'`)
    const s1Text = await desktopCdp.evaluate<string>(`document.body.innerText`)
    const shotS1 = path.join(RESULTS_DIR, 's1-engine-gate.png')
    await desktopCdp.captureScreenshot(shotS1)
    scenarios.push({
      id: 'S1',
      name: 'Open Windows Cadence on EngineConnectionGate with zero local SQLite/This PC fallback',
      status:
        s1Text.includes('Connect to a Cadence Playback Engine') && !s1Text.includes('Use This PC')
          ? 'PASS'
          : 'FAIL',
      correlationId: activeCid,
      details: `EngineConnectionGate visible; Use This PC fallback absent.`,
      evidence: {
        hasGateHeading: s1Text.includes('Connect to a Cadence Playback Engine'),
        hasThisPcButton: s1Text.includes('Use This PC'),
      },
      screenshot: shotS1,
    })

    // Scenario 2: Connect to idle Linux Core via EngineConnectionGate (without auto-play)
    activeCid = 'cid_s2_connect_idle_core'
    await desktopCdp.evaluate(`
      (() => {
        window.__cadenceActiveCid = '${activeCid}';
        function setVal(el, v) {
          const proto = HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setVal(document.querySelector('#gate-address-input'), 'http://127.0.0.1:${strictProxy.port}');
        setVal(document.querySelector('#gate-token-input'), '${E2E_PAIRING_TOKEN}');
        setVal(document.querySelector('#gate-label-input'), 'E2E Gate Core');
        const cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(c => c.closest('label')?.textContent?.includes('Trust self-signed'));
        if (cb && !cb.checked) cb.click();
      })();
    `)
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Verify & Pair')).click();
    `)
    await desktopCdp.waitFor(
      `Array.from(document.querySelectorAll('button')).some(b => b.textContent?.includes('Open Library'))`,
      15000
    )
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Open Library')).click();
    `)
    await desktopCdp.waitFor(
      `document.querySelector('button[aria-label^="Playback engine:"]')?.getAttribute('aria-label')?.includes('E2E Gate Core')`,
      15000
    )
    await desktopCdp.waitFor(`document.body.innerText.includes('Mega Anthology')`, 15000)

    const coreSnapAfterConnect = (await (
      await fetch(`http://127.0.0.1:${rawCorePort}/v1/core`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cadence-token': E2E_PAIRING_TOKEN,
        },
        body: JSON.stringify({
          protocolVersion: 1,
          engineId: coreEngineId,
          libraryId: coreLibraryId,
          operation: 'session.snapshot',
        }),
      })
    ).json()) as { data?: { playback?: { activity?: string } } }

    const s2AlbumCount = await desktopCdp.evaluate<number>(
      `document.querySelectorAll('.group\\\\/card').length`
    )
    const shotS2 = path.join(RESULTS_DIR, 's2-core-connected-idle.png')
    await desktopCdp.captureScreenshot(shotS2)
    scenarios.push({
      id: 'S2',
      name: 'Connect to idle Linux Core (catalog loads without auto-play)',
      status:
        coreSnapAfterConnect.data?.playback?.activity === 'idle' && s2AlbumCount >= 5
          ? 'PASS'
          : 'FAIL',
      correlationId: activeCid,
      details: `Rendered ${s2AlbumCount} album cards; Core playback activity=${coreSnapAfterConnect.data?.playback?.activity}`,
      evidence: {
        s2AlbumCount,
        coreActivity: coreSnapAfterConnect.data?.playback?.activity,
        paginationCalls: wireLog.filter((e) => e.operation === 'catalog.page').length,
      },
      screenshot: shotS2,
    })

    // Scenario 10 (Idle Core before playback): Phase 2 Folder Browse + Add + Artwork + Curate via Core v2 + Zero This PC fallback
    activeCid = 'cid_s10_phase2_core_v2'
    await desktopCdp.evaluate(`window.__cadenceActiveCid = '${activeCid}'`)
    await desktopCdp.waitFor(
      `Array.from(document.querySelectorAll('img')).some((img) => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0)`,
      8000
    )
    const v2Probe = await desktopCdp.evaluate<{
      browseCount: number
      hasSubdir: boolean
      addedOk: boolean
      artworkStatus: number
      artworkBytes: number
      renderedBlobImgs: number
      draftSaved: boolean
      dryRunBlockedReason: string | null
    }>(`(async () => {
      const base = 'http://127.0.0.1:${strictProxy.port}';
      const req = async (operation, extra = {}) => {
        const res = await fetch(base + '/v1/core', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cadence-token': '${E2E_PAIRING_TOKEN}',
          },
          body: JSON.stringify({
            protocolVersion: 2,
            engineId: '${coreEngineId}',
            libraryId: '${coreLibraryId}',
            operation,
            ...extra,
          }),
        });
        return res.json();
      };
      const rootsRes = await req('fs.browse');
      const rootEntry = rootsRes?.data?.entries?.[0];
      const browseRes = rootEntry ? await req('fs.browse', { path: rootEntry.path }) : { data: { entries: [] } };
      const entries = browseRes?.data?.entries || [];
      const subdir = entries.find((e) => e.name === 'e2e_browse_subdir');
      let addedOk = false;
      if (subdir) {
        const addRes = await req('folders.add', { path: subdir.path });
        addedOk = Boolean(addRes?.ok);
      }
      const artRes = await fetch(base + '/v1/artwork/rel_goldberg', {
        headers: { 'x-cadence-token': '${E2E_PAIRING_TOKEN}' },
      });
      const artBuf = artRes.ok ? await artRes.arrayBuffer() : new ArrayBuffer(0);
      const renderedBlobImgs = Array.from(document.querySelectorAll('img')).filter(
        (img) => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0,
      ).length;
      const draftRes = await req('curate.draft.save', {
        draft: {
          draftId: 'draft_e2e_gb_1',
          trackId: 'trk_gb_1',
          changes: [
            { field: 'album', before: 'Goldberg Variations', after: 'Goldberg Variations (E2E)' },
          ],
          updatedBy: 'e2e',
        },
      });
      const dryRunRes = await req('curate.dry_run', {
        draftId: 'draft_e2e_gb_1',
      });
      return {
        browseCount: entries.length,
        hasSubdir: Boolean(subdir),
        addedOk,
        artworkStatus: artRes.status,
        artworkBytes: artBuf.byteLength,
        renderedBlobImgs,
        draftSaved: Boolean(draftRes?.ok),
        dryRunBlockedReason: dryRunRes?.data?.blockReason || dryRunRes?.error?.code || null,
      };
    })()`)
    const hasThisPcUi = await desktopCdp.evaluate<boolean>(
      `document.body.innerText.includes('Use This PC') || document.body.innerText.includes('Switch to This PC')`
    )
    const shotS10 = path.join(RESULTS_DIR, 's10-phase2-core-v2.png')
    await desktopCdp.captureScreenshot(shotS10)
    const s10Ok =
      v2Probe.browseCount >= 1 &&
      v2Probe.hasSubdir &&
      v2Probe.addedOk &&
      v2Probe.artworkStatus === 200 &&
      v2Probe.artworkBytes > 0 &&
      v2Probe.renderedBlobImgs >= 1 &&
      v2Probe.draftSaved &&
      !hasThisPcUi
    scenarios.push({
      id: 'S10',
      name: 'Core v2 folder browse/add, /v1/artwork, DOM blob cover art, curate draft & zero This PC',
      status: s10Ok ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `fs.browse=${v2Probe.browseCount} entries, added=${v2Probe.addedOk}, artwork=${v2Probe.artworkStatus} (${v2Probe.artworkBytes}B), blobImgs=${v2Probe.renderedBlobImgs}, draft=${v2Probe.draftSaved}, dryRun=${v2Probe.dryRunBlockedReason}`,
      evidence: { ...v2Probe, hasThisPcUi },
      screenshot: shotS10,
    })

    // Scenario Bug A: Distinct editions ("Symphony No. 5" 1988 vs 2015 Remaster) stay separate cards
    activeCid = 'cid_bug_a_distinct_editions'
    const symphonyCardsCount = await desktopCdp.evaluate<number>(
      `Array.from(document.querySelectorAll('.group\\\\/card')).filter(c => c.innerText.includes('Symphony No. 5')).length`
    )
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('.group\\\\/card')).find(c => c.innerText.includes('Symphony No. 5')).click();
    `)
    await desktopCdp.waitFor(`document.body.innerText.includes('Allegro Con Brio')`)
    const cardTrackRows = await desktopCdp.evaluate<number>(
      `document.querySelectorAll('.group\\\\/tr').length`
    )
    const shotBugA = path.join(RESULTS_DIR, 'bug-a-edition-collapse.png')
    await desktopCdp.captureScreenshot(shotBugA)
    scenarios.push({
      id: 'BUG-A',
      name: 'Distinct editions remain separate album cards by releaseId',
      status: symphonyCardsCount === 2 && cardTrackRows === 3 ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `Expected 2 separate editions of "Symphony No. 5" (3 tracks each); observed ${symphonyCardsCount} cards with ${cardTrackRows} tracks in selected edition.`,
      evidence: { symphonyCardsCount, cardTrackRows },
      screenshot: shotBugA,
    })

    // Go back to Albums grid
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Back to Albums')).click();
    `)
    await desktopCdp.waitFor(`document.querySelectorAll('.group\\\\/card').length >= 6`)

    // Scenario 3: Rapidly switch Album A ("Goldberg Variations") -> Album B ("Blue Train")
    activeCid = 'cid_s3_rapid_album_switch'
    await desktopCdp.evaluate(`
      (() => {
        window.__cadenceActiveCid = '${activeCid}';
        const cards = Array.from(document.querySelectorAll('[class*="group/card"]'));
        cards.find(c => c.innerText.includes('Goldberg Variations'))?.click();
        const t1 = setInterval(() => {
          const backBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Back to Albums'));
          if (backBtn) {
            clearInterval(t1);
            backBtn.click();
            const t2 = setInterval(() => {
              const bt = Array.from(document.querySelectorAll('[class*="group/card"]')).find(c => c.innerText.includes('Blue Train'));
              if (bt) {
                clearInterval(t2);
                bt.click();
              }
            }, 10);
          }
        }, 10);
      })();
    `)
    await desktopCdp.waitFor(`document.body.innerText.includes('Moments Notice')`, 8000)
    await sleep(200)
    const s3Text = await desktopCdp.evaluate<string>(`document.body.innerText`)
    const s3VisibleText =
      s3Text.includes('Moments Notice') && !s3Text.includes('Glenn Gould')
    const shotS3 = path.join(RESULTS_DIR, 's3-rapid-album-switch.png')
    await desktopCdp.captureScreenshot(shotS3)
    scenarios.push({
      id: 'S3',
      name: 'Rapid Album A -> Album B switch keeps Album B displayed',
      status: s3VisibleText ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: s3VisibleText
        ? 'Album B ("Blue Train") stayed displayed cleanly without stale overwrite.'
        : `Album B state after rapid A->B switch: BlueTrain=${s3Text.includes('Blue Train')} MomentsNotice=${s3Text.includes('Moments Notice')} GlennGould=${s3Text.includes('Glenn Gould')}`,
      evidence: {
        s3VisibleText,
        containsBlueTrain: s3Text.includes('Blue Train'),
        containsMomentsNotice: s3Text.includes('Moments Notice'),
        containsGlennGould: s3Text.includes('Glenn Gould'),
      },
      screenshot: shotS3,
    })

    // Return to Albums & open "Goldberg Variations" (Multi-disc + DSD64 + repeated title "Aria")
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Back to Albums'))?.click();
    `)
    await desktopCdp.waitFor(`document.querySelectorAll('.group\\\\/card').length >= 6`)
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('.group\\\\/card')).find(c => c.innerText.includes('Goldberg Variations')).click();
    `)
    await desktopCdp.waitFor(`document.body.innerText.includes('Variation 01')`)

    const fetchCoreSnap = async () => {
      const r = await fetch(`http://127.0.0.1:${rawCorePort}/v1/core`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cadence-token': E2E_PAIRING_TOKEN,
        },
        body: JSON.stringify({
          protocolVersion: 1,
          engineId: coreEngineId,
          libraryId: coreLibraryId,
          operation: 'session.snapshot',
        }),
      })
      return (await r.json()) as {
        data?: {
          revision?: number
          queue?: { currentEntryId?: string; entries?: Array<{ entryId: string; trackId: string }> }
          playback?: {
            activity?: string
            trackId?: string
            owner?: string
            takeoverRequired?: boolean
            positionSeconds?: number
          }
        }
      }
    }

    const getActiveTrackId = (
      d?: NonNullable<Awaited<ReturnType<typeof fetchCoreSnap>>['data']>
    ): string | undefined => {
      const cur = d?.queue?.currentEntryId
      if (!cur) return undefined
      return d?.queue?.entries?.find((e) => e.entryId === cur)?.trackId
    }

    const waitForCoreState = async (
      pred: (d: NonNullable<Awaited<ReturnType<typeof fetchCoreSnap>>['data']>) => boolean,
      timeoutMs = 10000
    ) => {
      const start = Date.now()
      let lastSnap: Awaited<ReturnType<typeof fetchCoreSnap>> | null = null
      while (Date.now() - start < timeoutMs) {
        lastSnap = await fetchCoreSnap()
        if (lastSnap.data && pred(lastSnap.data)) return lastSnap.data
        await sleep(100)
      }
      throw new Error(
        `Timed out waiting for Core state condition after ${timeoutMs}ms (last=${JSON.stringify({
          revision: lastSnap?.data?.revision,
          playback: lastSnap?.data?.playback,
          currentEntryId: lastSnap?.data?.queue?.currentEntryId,
          activeTrackId: getActiveTrackId(lastSnap?.data),
          queueLen: lastSnap?.data?.queue?.entries?.length,
        })})`
      )
    }

    // Scenario 4 + Bug C: Click middle track #2 ("Variation 01") -> verify RS130 UPnP + full Desktop Queue
    activeCid = 'cid_s4_bug_c_middle_track'
    rs130Sim.resetSoapCalls()
    await desktopCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      const row = Array.from(document.querySelectorAll('.group\\\\/tr')).find(r => r.innerText.includes('Variation 01'));
      row.querySelector('button[title="Play Track"]').click();
    `)
    const coreSnapPlayData = await waitForCoreState(
      (d) => d.playback?.activity === 'playing' && getActiveTrackId(d) === 'trk_gb_2'
    )

    // Open Queue sidebar on Desktop
    await desktopCdp.evaluate(`
      const qBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title') || '').includes('Now Playing Queue'));
      if (qBtn && !document.body.innerText.includes('UP NEXT')) qBtn.click();
    `)
    await desktopCdp.waitFor(
      `document.body.innerText.includes('UP NEXT') && document.body.innerText.includes('Variation 02')`,
      8000
    )

    const desktopQueueEmpty = await desktopCdp.evaluate<boolean>(
      `document.body.innerText.includes('Queue is empty') || document.body.innerText.includes('Up Next\\n(0)') || document.body.innerText.includes('Up Next (0)')`
    )
    const coreEntries = coreSnapPlayData.queue?.entries ?? []
    const rsStateAfterS4 = rs130Sim.getState()
    const rsHasSetUri = rsStateAfterS4.soapCalls.some((c) => c.action === 'SetAVTransportURI')
    const rsHasPlay = rsStateAfterS4.soapCalls.some((c) => c.action === 'Play')
    const shotBugC = path.join(RESULTS_DIR, 'bug-c-desktop-queue-empty.png')
    await desktopCdp.captureScreenshot(shotBugC)

    const s4BugCOk =
      !desktopQueueEmpty &&
      coreEntries.length === 4 &&
      coreEntries[0]?.trackId === 'trk_gb_1' &&
      getActiveTrackId(coreSnapPlayData) === 'trk_gb_2' &&
      rsHasSetUri &&
      rsHasPlay &&
      rsStateAfterS4.transportState === 'PLAYING' &&
      rsStateAfterS4.currentUri.includes(`:${mediaPort}/media/`)

    scenarios.push({
      id: 'BUG-C',
      name: 'Middle track plays on RS130 and hydrates full Desktop Right Sidebar Queue',
      status: s4BugCOk ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `Core revision=${coreSnapPlayData.revision}, queue=${coreEntries.length} tracks starting at ${coreEntries[0]?.trackId}, playing=${getActiveTrackId(coreSnapPlayData)}, RS130=${rsStateAfterS4.transportState}, DesktopQueueEmpty=${desktopQueueEmpty}.`,
      evidence: {
        desktopQueueEmpty,
        coreQueueLength: coreEntries.length,
        coreTrackIds: coreEntries.map((e) => e.trackId),
        coreCurrentEntryId: coreSnapPlayData.queue?.currentEntryId,
        rsTransportState: rsStateAfterS4.transportState,
        rsHasSetUri,
        rsHasPlay,
      },
      screenshot: shotBugC,
    })

    // Scenario 5: Next (to DSD64 .dsf trk_gb_3) & Previous (back to FLAC trk_gb_2)
    activeCid = 'cid_s5_next_prev_dsd'
    rs130Sim.resetSoapCalls()
    await desktopCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      document.querySelector('button[title^="Next Track"]').click();
    `)
    await waitForCoreState(
      (d) => d.playback?.activity === 'playing' && getActiveTrackId(d) === 'trk_gb_3'
    )
    const rsAfterNext = rs130Sim.getState()
    const nextUri = rsAfterNext.currentUri
    rs130Sim.resetSoapCalls()
    await desktopCdp.evaluate(`
      document.querySelector('button[title^="Previous Track"]').click();
    `)
    const snapAfterPrev = await waitForCoreState(
      (d) => d.playback?.activity === 'playing' && getActiveTrackId(d) === 'trk_gb_2'
    )
    const rsAfterPrev = rs130Sim.getState()
    const s5Ok =
      rsAfterNext.soapCalls.some((c) => c.action === 'SetAVTransportURI') &&
      rsAfterNext.soapCalls.some((c) => c.action === 'Play') &&
      rsAfterPrev.currentUri !== nextUri &&
      rsAfterPrev.transportState === 'PLAYING'
    scenarios.push({
      id: 'S5',
      name: 'Next / Previous transitions RS130 between FLAC and DSD64 cleanly',
      status: s5Ok ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `Next selected trk_gb_3 (DSF) and Previous returned to trk_gb_2 (FLAC) with distinct RS130 media URIs.`,
      evidence: {
        nextUri: redactText(nextUri),
        prevUri: redactText(rsAfterPrev.currentUri),
        rsTransportAfterPrev: rsAfterPrev.transportState,
      },
    })

    // Allow Desktop's passive sync (>=5s) to absorb Core's async loading -> playing revision bump before testing rapid concurrent UI clicks
    const settledRev = typeof snapAfterPrev.revision === 'number' ? snapAfterPrev.revision : 0
    const passiveSyncDeadline = Date.now() + 7000
    while (Date.now() < passiveSyncDeadline) {
      const synced = wireLog.some(
        (w) =>
          w.proxyKind === 'desktop' &&
          w.operation === 'session.snapshot' &&
          typeof w.responseRevision === 'number' &&
          w.responseRevision >= settledRev
      )
      if (synced) break
      await sleep(150)
    }

    // Scenario 11: Rapid double clicks across tracks -> serialized execution without stale_revision
    activeCid = 'cid_s11_rapid_clicks'
    await desktopCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      const rows = Array.from(document.querySelectorAll('.group\\\\/tr'));
      rows[0]?.querySelector('button[title="Play Track"]')?.click();
      rows[3]?.querySelector('button[title="Play Track"]')?.click();
    `)
    const snapAfterRapid = await waitForCoreState(
      (d) => d.playback?.activity === 'playing' && getActiveTrackId(d) === 'trk_gb_4'
    )
    const rapidStaleErrors = wireLog.filter(
      (w) => w.correlationId === activeCid && w.errorCode === 'stale_revision'
    )
    scenarios.push({
      id: 'S11',
      name: 'Rapid track clicks serialize cleanly with zero stale_revision errors (last wins)',
      status: rapidStaleErrors.length === 0 && getActiveTrackId(snapAfterRapid) === 'trk_gb_4' ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `Rapid clicks resolved to final track=${getActiveTrackId(snapAfterRapid)} with ${rapidStaleErrors.length} stale_revision rejection(s).`,
      evidence: {
        staleRevisionCount: rapidStaleErrors.length,
        finalTrackId: getActiveTrackId(snapAfterRapid),
      },
    })
    // Scenario CORS + PWA-PAIR + S9 Dual Controller Queue & Format Parity:
    activeCid = 'cid_s9_pwa_cors_raw'
    const rawCorsRes = await fetch(`http://127.0.0.1:${rawCorePort}/v1/core`, {
      method: 'OPTIONS',
      headers: {
        Origin: `http://127.0.0.1:${pwaPort}`,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, x-cadence-token',
      },
    })
    const allowHdrs = rawCorsRes.headers.get('access-control-allow-headers') || ''
    const corsIncludesToken = allowHdrs.toLowerCase().includes('x-cadence-token')
    scenarios.push({
      id: 'PWA-CORS',
      name: 'Dragonfish CORS preflight permits x-cadence-token for browser/PWA',
      status: corsIncludesToken ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `OPTIONS /v1/core returned Access-Control-Allow-Headers="${allowHdrs}" (includes x-cadence-token=${corsIncludesToken}).`,
      evidence: { allowHeaders: allowHdrs },
    })

    // Step A: Real manual UI pairing in PWA directly against strictProxy (no CORS header override!)
    activeCid = 'cid_pwa_manual_pair'
    await pwaCdp.waitFor(
      `document.body && Array.from(document.querySelectorAll('button')).some(b => b.textContent?.includes('Cadence Core'))`,
      20000
    )
    await pwaCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Cadence Core')).click();
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('HTTP (Local LAN)')).click();
      function setVal(el, v) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const hostInput = document.querySelector('input[placeholder*="192.168"]');
      const portInput = document.querySelector('input[type="number"]');
      const pinInput = document.querySelector('input[placeholder*="4829"]');
      setVal(hostInput, '127.0.0.1');
      setVal(portInput, '${strictProxy.port}');
      setVal(pinInput, '${E2E_PAIRING_TOKEN}');
      Array.from(document.querySelectorAll('button[type="submit"]')).find(b => b.textContent?.includes('Connect')).click();
    `)
    await pwaCdp.waitFor(
      `document.body.innerText.includes('E2E Gate Core') || document.body.innerText.includes('HTTP 404') || document.body.innerText.includes('Failed to fetch')`,
      15000
    )
    const pwaPairBody = await pwaCdp.evaluate<string>(`document.body.innerText`)
    const pwaPairFailed =
      !pwaPairBody.includes('E2E Gate Core') ||
      pwaPairBody.includes('HTTP 404') ||
      pwaPairBody.includes('Failed to fetch')
    const shotPwaPair = path.join(RESULTS_DIR, 'pwa-manual-pair.png')
    await pwaCdp.captureScreenshot(shotPwaPair)
    scenarios.push({
      id: 'PWA-PAIR',
      name: 'PWA manual Cadence Core pairing connects via /healthz + /v1/core',
      status: !pwaPairFailed ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: !pwaPairFailed
        ? 'Manual PWA pairing succeeded cleanly against strict Dragonfish Core.'
        : `PairingView failed: ${pwaPairBody.slice(0, 240)}`,
      evidence: { pwaPairFailed },
      screenshot: shotPwaPair,
    })

    // Step B: Switch PWA to Queue tab and verify authoritative Core queue + real DSD/FLAC format badges (no 'CORE')
    activeCid = 'cid_s9_pwa_dual_controller'
    await pwaCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      Array.from(document.querySelectorAll('nav button')).find(b => b.textContent?.includes('Queue')).click();
    `)
    await pwaCdp.waitFor(
      `document.body.innerText.includes('Playback Queue') && document.body.innerText.includes('Goldberg Variations')`,
      10000
    )
    const pwaQueueText = await pwaCdp.evaluate<string>(`document.body.innerText`)
    const pwaHasQueueEntries =
      pwaQueueText.includes('Playback Queue') &&
      pwaQueueText.includes('Goldberg Variations') &&
      pwaQueueText.includes('Variation 01') &&
      pwaQueueText.includes('Variation 02')
    const pwaHasRealFormat = pwaQueueText.includes('DSD') || pwaQueueText.includes('DSF') || pwaQueueText.includes('FLAC')
    const pwaHasLegacyCoreBadge = /\bCORE\b/.test(pwaQueueText)
    const shotPwaQueue = path.join(RESULTS_DIR, 's9-pwa-dual-controller-queue.png')
    await pwaCdp.captureScreenshot(shotPwaQueue)
    scenarios.push({
      id: 'S9',
      name: 'Dual-controller Android PWA & Desktop observe identical queue and real audio format badges',
      status:
        pwaHasQueueEntries && !desktopQueueEmpty && pwaHasRealFormat && !pwaHasLegacyCoreBadge
          ? 'PASS'
          : 'FAIL',
      correlationId: activeCid,
      details: `PWA Queue matches Goldberg Variations (${pwaHasQueueEntries}), Desktop queue hydrated (${!desktopQueueEmpty}), realFormat=${pwaHasRealFormat}, legacyCoreBadge=${pwaHasLegacyCoreBadge}.`,
      evidence: {
        pwaHasQueueEntries,
        desktopQueueEmpty,
        pwaHasRealFormat,
        pwaHasLegacyCoreBadge,
      },
      screenshot: shotPwaQueue,
    })

    // Issue #40 E2E Gate: Monotonic playback timers advance on Core, Desktop, and PWA even when RS130 RelTime stays 00:00:00
    activeCid = 'cid_issue40_timer_sync'
    await pwaCdp.send('Page.bringToFront')
    await pwaCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      const mini = document.querySelector('.h-13.opacity-100 > div');
      if (mini) mini.click();
    `)
    await pwaCdp.waitFor(
      `Boolean(document.querySelector('button[aria-label="Dismiss Now Playing"]')) && Boolean(document.querySelector('input[type="range"]'))`,
      8000
    )
    const parseClockSecs = (raw: string): number => {
      const m = raw.match(/(\d+):(\d{2})/)
      return m ? Number(m[1]) * 60 + Number(m[2]) : -1
    }
    const readDesktopTimerText = async (): Promise<string> =>
      desktopCdp.evaluate<string>(
        `document.querySelector('[title^="Seek: "]')?.getAttribute('title') || ''`
      )
    const readPwaTimerText = async (): Promise<string> =>
      pwaCdp.evaluate<string>(
        `(() => {
          const wrap = document.querySelector('input[type="range"]')?.closest('.max-w-sm');
          const spans = wrap ? wrap.querySelectorAll('span') : [];
          return spans[0]?.textContent?.trim() || '';
        })()`
      )
    const pwaTimerBefore = await readPwaTimerText()
    await new Promise((r) => setTimeout(r, 2300))
    const pwaTimerAfter = await readPwaTimerText()
    const shotIssue40 = path.join(RESULTS_DIR, 'issue-40-timer-sync.png')
    await pwaCdp.captureScreenshot(shotIssue40)
    await pwaCdp.evaluate(`
      document.querySelector('button[aria-label="Dismiss Now Playing"]')?.click();
    `)

    // Foreground Desktop tab so Chrome does not throttle its 1 Hz clock while hidden, verify settle + 1 Hz tick
    await desktopCdp.send('Page.bringToFront')
    await desktopCdp.waitFor(
      `Boolean(document.querySelector('button[title^="Pause"]'))`,
      6000
    )
    const desktopTitleBefore = await readDesktopTimerText()
    await new Promise((r) => setTimeout(r, 2300))
    const desktopTitleAfter = await readDesktopTimerText()

    const coreSnapTimer = (await fetchCoreSnap()).data
    if (!coreSnapTimer) throw new Error('Failed to fetch Core snapshot for Issue #40 verification')
    const rsTimerRelTime = rs130Sim.getState().relTime
    const desktopBeforeSecs = parseClockSecs(desktopTitleBefore)
    const desktopAfterSecs = parseClockSecs(desktopTitleAfter)
    const pwaBeforeSecs = parseClockSecs(pwaTimerBefore)
    const pwaAfterSecs = parseClockSecs(pwaTimerAfter)
    const corePosTimer = Number(coreSnapTimer.playback?.positionSeconds ?? 0)
    const issue40TimerOk =
      rsTimerRelTime === '00:00:00' &&
      corePosTimer >= 1 &&
      desktopBeforeSecs >= 0 &&
      desktopAfterSecs > desktopBeforeSecs &&
      desktopAfterSecs >= 1 &&
      pwaBeforeSecs >= 0 &&
      pwaAfterSecs > pwaBeforeSecs &&
      pwaAfterSecs >= 1
    if (!issue40TimerOk) {
      const recentDesktopWire = wireLog
        .filter((w) => w.proxyKind === 'strict')
        .slice(-12)
      console.error('[E2E ISSUE-40 DEBUG] recent strict wire:', JSON.stringify(recentDesktopWire))
    }
    scenarios.push({
      id: 'ISSUE-40',
      name: 'Desktop, Core, and PWA playback timers advance in sync even when RS130 reports RelTime=00:00:00',
      status: issue40TimerOk ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `RS130 relTime=${rsTimerRelTime}, Core pos=${corePosTimer.toFixed(1)}s, Desktop "${desktopTitleBefore}" -> "${desktopTitleAfter}", PWA "${pwaTimerBefore}" -> "${pwaTimerAfter}".`,
      evidence: {
        rsTimerRelTime,
        corePosTimer,
        desktopBeforeSecs,
        desktopAfterSecs,
        pwaBeforeSecs,
        pwaAfterSecs,
      },
      screenshot: shotIssue40,
    })

    // Scenario 8: Reload Desktop while Core is playing -> playback continues, reconnect restores queue & Now Playing
    activeCid = 'cid_s8_disconnect_reconnect'
    // Step back 1 track from trk_gb_4 -> trk_gb_3 so both NOW PLAYING (Variation 02) and UP NEXT (Aria) are non-empty
    await desktopCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      document.querySelector('button[title^="Previous Track"]').click();
    `)
    await waitForCoreState(
      (d) => d.playback?.activity === 'playing' && getActiveTrackId(d) === 'trk_gb_3'
    )
    const rsStateBeforeReload = rs130Sim.getState().transportState
    await desktopCdp.evaluate(`window.__e2eReloadMarker = 1;`)
    await desktopCdp.send('Page.reload')
    await desktopCdp.waitFor(
      `!window.__e2eReloadMarker && document.body && !document.querySelector('[aria-label="Loading configuration"]') && (Boolean(document.querySelector('button[aria-label^="Playback engine:"]')) || document.body.innerText.includes('Connect to a Cadence Playback Engine'))`,
      20000
    )
    const rsStateWhileDisconnected = rs130Sim.getState().transportState
    // Auto-reconnect on startup or reconnect from Saved Engines if on gate
    await desktopCdp.evaluate(`
      (() => {
        window.__cadenceActiveCid = '${activeCid}';
        if (!document.querySelector('button[aria-label^="Playback engine:"]')) {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Connect');
          if (btn) btn.click();
        }
      })();
    `)
    await desktopCdp.waitFor(
      `document.querySelector('button[aria-label^="Playback engine:"]')?.getAttribute('aria-label')?.includes('E2E Gate Core')`,
      15000
    )
    await desktopCdp.evaluate(`
      const qBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title') || '').includes('Now Playing Queue'));
      if (qBtn && !document.body.innerText.includes('UP NEXT')) qBtn.click();
    `)
    await desktopCdp.waitFor(
      `document.body.innerText.includes('Variation 02') && document.body.innerText.includes('UP NEXT') && document.body.innerText.includes('Aria')`,
      10000
    )
    const s8Text = await desktopCdp.evaluate<string>(`document.body.innerText`)
    const rsStateAfterReload = rs130Sim.getState().transportState
    const s8Ok =
      rsStateBeforeReload === 'PLAYING' &&
      rsStateWhileDisconnected === 'PLAYING' &&
      rsStateAfterReload === 'PLAYING' &&
      s8Text.includes('Variation 02') &&
      s8Text.includes('Aria') &&
      !s8Text.includes('Queue is empty')
    scenarios.push({
      id: 'S8',
      name: 'Disconnect/reload Desktop preserves Core playback and restores queue on reconnect',
      status: s8Ok ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `RS130 remained ${rsStateAfterReload} across Desktop reload & explicit Core reconnect; Now Playing & UP NEXT queue restored.`,
      evidence: {
        rsStateBeforeReload,
        rsStateWhileDisconnected,
        rsStateAfterReload,
        restoredVariation02: s8Text.includes('Variation 02'),
        restoredUpNextAria: s8Text.includes('Aria'),
      },
    })

    // Scenario 6 + 7 + Bug B: External HiFi ROSE takeover -> Decline leaves undisturbed -> Confirm takes over -> PAUSED_PLAYBACK RelTime sync
    activeCid = 'cid_s6_s7_bug_b_external_rose'
    const externalUri = 'http://hifi-rose.local/tidal/track.flac'
    rs130Sim.setExternalPlaying(externalUri, '00:00:42')
    const extDetectedSnap = await waitForCoreState(
      (d) =>
        d.playback?.activity === 'idle' &&
        d.playback?.owner === 'external' &&
        d.playback?.takeoverRequired === true,
      10000
    )
    await desktopCdp.waitFor(
      `document.body.innerText.includes('currently playing via HiFi ROSE')`,
      10000
    )
    // Open Goldberg Variations so we can click Variation 01
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('.group\\\\/card')).find(c => c.innerText.includes('Goldberg Variations'))?.click();
    `)
    await desktopCdp.waitFor(
      `document.querySelectorAll('.group\\\\/tr').length >= 4 && document.body.innerText.includes('Variation 01')`,
      8000
    )
    await desktopCdp.evaluate(`
      window.__cadenceActiveCid = '${activeCid}';
      const row = Array.from(document.querySelectorAll('.group\\\\/tr')).find(r => r.innerText.includes('Variation 01'));
      row.querySelector('button[title="Play Track"]').click();
    `)
    await desktopCdp.waitFor(
      `document.body.innerText.includes('RS130 is Playing via HiFi ROSE') && document.body.innerText.includes('Keep HiFi ROSE')`,
      8000
    )
    rs130Sim.resetSoapCalls()
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Keep HiFi ROSE')).click();
    `)
    await sleep(300)
    const rsAfterDecline = rs130Sim.getState()
    const declinePreservedRose =
      rsAfterDecline.currentUri === externalUri &&
      rsAfterDecline.transportState === 'PLAYING' &&
      !rsAfterDecline.soapCalls.some((c) => c.action === 'SetAVTransportURI' || c.action === 'Play')
    scenarios.push({
      id: 'S6',
      name: 'Declining external HiFi ROSE takeover leaves RS130 playback undisturbed',
      status: declinePreservedRose && extDetectedSnap.playback?.takeoverRequired ? 'PASS' : 'FAIL',
      correlationId: activeCid,
      details: `External owner detected (takeoverRequired=${extDetectedSnap.playback?.takeoverRequired}); after "Keep HiFi ROSE", RS130 URI stayed external=${rsAfterDecline.currentUri === externalUri}.`,
      evidence: {
        takeoverRequired: extDetectedSnap.playback?.takeoverRequired,
        rsUriPreserved: rsAfterDecline.currentUri === externalUri,
        soapMutationsSent: rsAfterDecline.soapCalls.filter((c) => c.action === 'SetAVTransportURI' || c.action === 'Play').length,
      },
    })

    // S7 + Bug B Confirm takeover + PAUSED_PLAYBACK @ 00:01:21
    rs130Sim.resetSoapCalls()
    await desktopCdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.group\\\\/tr')).find(r => r.innerText.includes('Variation 01'));
      row.querySelector('button[title="Play Track"]').click();
    })();`)
    await desktopCdp.waitFor(
      `document.body.innerText.includes('Take Over RS130 & Play')`,
      8000
    )
    await desktopCdp.evaluate(`
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Take Over RS130 & Play')).click();
    `)
    const takeoverSnap = await waitForCoreState(
      (d) =>
        d.playback?.activity === 'playing' &&
        getActiveTrackId(d) === 'trk_gb_2' &&
        d.playback?.owner === 'core',
      10000
    )
    const rsAfterConfirm = rs130Sim.getState()
    rs130Sim.setExternalPaused('00:01:21')
    const pausedSyncSnap = await waitForCoreState(
      (d) =>
        d.playback?.activity === 'paused' &&
        Math.round(d.playback?.positionSeconds ?? -1) === 81,
      8000
    )
    const shotBugB = path.join(RESULTS_DIR, 'bug-b-takeover-verified.png')
    await desktopCdp.captureScreenshot(shotBugB)
    scenarios.push({
      id: 'S7',
      name: 'Confirming RS130 takeover plays requested track and syncs PAUSED_PLAYBACK RelTime',
      status:
        rsAfterConfirm.soapCalls.some((c) => c.action === 'SetAVTransportURI') &&
        rsAfterConfirm.soapCalls.some((c) => c.action === 'Play') &&
        rsAfterConfirm.currentUri.includes(`:${mediaPort}/media/`) &&
        takeoverSnap.playback?.owner === 'core' &&
        pausedSyncSnap.playback?.activity === 'paused' &&
        Math.round(pausedSyncSnap.playback?.positionSeconds ?? 0) === 81
          ? 'PASS'
          : 'FAIL',
      correlationId: activeCid,
      details: `Confirm takeover played trk_gb_2 via RS130 SOAP; PAUSED_PLAYBACK@00:01:21 reconciled as activity=${pausedSyncSnap.playback?.activity} pos=${pausedSyncSnap.playback?.positionSeconds}s.`,
      evidence: {
        takeoverTrackId: getActiveTrackId(takeoverSnap),
        pausedActivity: pausedSyncSnap.playback?.activity,
        pausedPosSeconds: pausedSyncSnap.playback?.positionSeconds,
      },
      screenshot: shotBugB,
    })

    // Scenario 12: Restart Core -> verify honest recovery with idle state, no mutation replay & audiophile 503 guard while paused
    activeCid = 'cid_s12_restart_core'
    const pausedArtRes = await fetch(`http://127.0.0.1:${strictProxy.port}/v1/artwork/rel_std_1988`, {
      headers: { 'x-cadence-token': E2E_PAIRING_TOKEN },
    })
    const mutationsBeforeRestart = wireLog.filter((w) => w.operation && w.operation !== 'session.snapshot' && w.operation !== 'core.hello' && w.operation !== 'catalog.page').length
    killProcessTree(coreProc)
    coreProc = await spawnCore()
    await sleep(500)
    const mutationsAfterRestart = wireLog.filter((w) => w.operation && w.operation !== 'session.snapshot' && w.operation !== 'core.hello' && w.operation !== 'catalog.page').length
    const postRestartSnap = await fetchCoreSnap()

    scenarios.push({
      id: 'S12',
      name: 'Restart Core yields idle recovery without mutation replay & enforces 503 deferred artwork while paused',
      status:
        pausedArtRes.status === 503 &&
        postRestartSnap.data?.playback?.activity === 'idle' &&
        mutationsAfterRestart === mutationsBeforeRestart
          ? 'PASS'
          : 'FAIL',
      correlationId: activeCid,
      details: `Post-restart Core activity=${postRestartSnap.data?.playback?.activity}; mutation delta=${mutationsAfterRestart - mutationsBeforeRestart}; paused artwork status=${pausedArtRes.status}.`,
      evidence: {
        postRestartActivity: postRestartSnap.data?.playback?.activity,
        mutationDelta: mutationsAfterRestart - mutationsBeforeRestart,
        pausedArtworkDeferredStatus: pausedArtRes.status,
      },
    })

    // Write structured JSON + Markdown Stage P1 report (redacted)
    const reportJson = {
      generatedAt: new Date().toISOString(),
      stage: 'P1',
      corePort: rawCorePort,
      desktopErrors: desktopCdp.consoleErrors,
      pwaErrors: pwaCdp.consoleErrors,
      scenarios,
      wireTraceCount: wireLog.length,
      wireTrace: wireLog,
    }
    const jsonPath = path.join(RESULTS_DIR, 'stage-p1-report.json')
    fs.writeFileSync(jsonPath, redactText(JSON.stringify(reportJson, null, 2)), 'utf8')

    const mdLines = [
      '# Cadence Linux Core — Stage P1 Layer 3 Browser/CDP E2E Gate Report',
      '',
      `Generated: ${reportJson.generatedAt}`,
      '',
      '| ID | Scenario | Status | Correlation ID | Summary |',
      '|---|---|---|---|---|',
      ...scenarios.map(
        (s) => `| ${s.id} | ${s.name} | **${s.status}** | \`${s.correlationId}\` | ${s.details} |`
      ),
      '',
      `Captured wire events: ${wireLog.length} (tokens & media RunTokens redacted).`,
      `Desktop console errors: ${desktopCdp.consoleErrors.length}, PWA console errors: ${pwaCdp.consoleErrors.length}.`,
    ]
    const mdPath = path.join(RESULTS_DIR, 'stage-p1-report.md')
    fs.writeFileSync(mdPath, redactText(mdLines.join('\n') + '\n'), 'utf8')

    console.log('\n[E2E] Stage P1 Scenario Matrix Summary:')
    for (const s of scenarios) {
      console.log(`  [${s.status}] ${s.id} (${s.correlationId}): ${s.details}`)
    }
    console.log(`[E2E] Report written to ${mdPath} and ${jsonPath}`)

    const nonPass = scenarios.filter((s) => s.status !== 'PASS')
    if (nonPass.length > 0 || desktopCdp.consoleErrors.length > 0 || pwaCdp.consoleErrors.length > 0) {
      throw new Error(
        `Stage P1 E2E gate failed: scenarios=[${nonPass.map((f) => `${f.id}:${f.status}`).join(', ')}], desktopErrors=${desktopCdp.consoleErrors.length}, pwaErrors=${pwaCdp.consoleErrors.length}`
      )
    }
  } catch (err) {
    try {
      if (desktopCdp) {
        await desktopCdp.evaluate(`
          const stackBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Technical Diagnostics Stack'));
          if (stackBtn) stackBtn.click();
        `).catch(() => {})
        await desktopCdp.captureScreenshot(path.join(RESULTS_DIR, 'debug-error-desktop.png'))
        const txt = await desktopCdp.evaluate<string>(`document.body?.innerText?.slice(0, 2000) || ''`)
        console.error('[E2E] Desktop DOM on error:\n' + txt)
        if (desktopCdp.consoleErrors.length) {
          console.error('[E2E] Desktop console errors:\n' + desktopCdp.consoleErrors.join('\n---\n'))
        }
      }
      if (pwaCdp) {
        await pwaCdp.captureScreenshot(path.join(RESULTS_DIR, 'debug-error-pwa.png'))
        const txt = await pwaCdp.evaluate<string>(`document.body?.innerText?.slice(0, 800) || ''`)
        console.error('[E2E] PWA DOM on error:\n' + txt)
      }
    } catch {
      // ignore secondary debug error
    }
    throw err
  } finally {
    desktopCdp?.close()
    pwaCdp?.close()
    strictProxyServer?.close()
    rs130Sim?.close()
    killProcessTree(chromeProc)
    killProcessTree(desktopViteProc)
    killProcessTree(pwaViteProc)
    killProcessTree(coreProc)
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  }
}

run().catch((err) => {
  console.error('[E2E] FATAL:', err)
  process.exit(1)
})
