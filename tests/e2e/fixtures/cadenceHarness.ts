import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

export interface ManagedProcess {
  url: string
  port: number
  stop: () => Promise<void>
}

export interface RecordedSoapCall {
  action: string
  uri?: string
  target?: string
}

export interface Rs130Simulator {
  descUrl: string
  getState: () => {
    currentUri: string
    transportState: string
    relTime: string
    soapCalls: RecordedSoapCall[]
  }
  resetSoapCalls: () => void
  close: () => Promise<void>
}

export interface CadenceE2eStack {
  coreUrl: string
  corePort: number
  coreEngineId: string
  coreLibraryId: string
  pairingToken: string
  desktopUrl: string
  pwaUrl: string
  rs130: Rs130Simulator
  stop: () => Promise<void>
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo | null
      const port = addr?.port ?? 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitForHttpReady(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url)
      if (resp.ok || resp.status < 500) return
    } catch {
      // retry until ready
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

export function killProcessTree(proc: ChildProcess | null | undefined): void {
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      })
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

export async function startViteServer(options: { cwd: string }): Promise<ManagedProcess> {
  const port = await getFreePort()
  const viteBin = path.join(options.cwd, 'node_modules', 'vite', 'bin', 'vite.js')
  const proc = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  const url = `http://127.0.0.1:${port}`
  await waitForHttpReady(url, 45_000)

  return {
    url,
    port,
    stop: async () => {
      killProcessTree(proc)
      await sleep(150)
    },
  }
}

export function startRs130Simulator(udn: string): Promise<Rs130Simulator> {
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
        resetSoapCalls: () => {
          soapCalls.length = 0
        },
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

function resolvePythonBin(): string {
  for (const candidate of ['python3', 'python']) {
    const check = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true })
    if (check.status === 0) return candidate
  }
  throw new Error('Python 3 is required to seed the E2E SQLite catalog fixture')
}

function resolveHeadlessBinary(): string {
  if (process.env.CADENCE_ENGINE_BINARY && fs.existsSync(process.env.CADENCE_ENGINE_BINARY)) {
    return process.env.CADENCE_ENGINE_BINARY
  }
  const exeName = process.platform === 'win32' ? 'cadence-headless.exe' : 'cadence-headless'
  const defaultPath = path.join(REPO_ROOT, 'src-tauri', 'target', 'debug', exeName)
  if (!fs.existsSync(defaultPath) && process.env.CADENCE_SKIP_CARGO_BUILD !== '1') {
    const buildArgs =
      process.platform === 'win32'
        ? ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'cadence-headless']
        : [
            'build',
            '--manifest-path',
            'src-tauri/Cargo.toml',
            '--no-default-features',
            '--features',
            'bundled-sqlite',
            '--bin',
            'cadence-headless',
          ]
    const buildRes = spawnSync('cargo', buildArgs, { cwd: REPO_ROOT, stdio: 'inherit' })
    if (buildRes.status !== 0) {
      throw new Error(`Failed to build ${exeName}`)
    }
  }
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`cadence-headless binary not found at ${defaultPath}`)
  }
  return defaultPath
}

function seedE2eFixtures(dbPath: string, musicDir: string): void {
  const pyScript = `
import base64, os, sqlite3, struct

db_path = r"""${dbPath}"""
music_dir = r"""${musicDir}"""
os.makedirs(music_dir, exist_ok=True)
os.makedirs(os.path.join(music_dir, 'e2e_browse_subdir'), exist_ok=True)

cover_png_path = os.path.join(music_dir, 'goldberg_cover.png')
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
for i, ttitle in enumerate(['Allegro Con Brio (1988)', 'Andante (1988)'], start=1):
    fp = os.path.join(music_dir, f'sym_1988_{i}.wav')
    sz = make_wav(fp, 44100, 16)
    tracks.append((f'trk_sym88_{i}', 'rel_std_1988', fp, os.path.basename(fp), sz, ttitle, 'Berlin Phil', 'Symphony No. 5', 1, i, 180.0, 'WAV', 44100, 16))
for i, ttitle in enumerate(['Allegro Con Brio (2015 Remaster)', 'Andante (2015 Remaster)'], start=1):
    fp = os.path.join(music_dir, f'sym_2015_{i}.flac')
    sz = make_wav(fp, 192000, 24)
    tracks.append((f'trk_sym15_{i}', 'rel_rem_2015', fp, os.path.basename(fp), sz, ttitle, 'Berlin Phil', 'Symphony No. 5', 1, i, 185.0, 'FLAC', 192000, 24))

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

for i, ttitle in enumerate(['Blue Train', 'Moments Notice'], start=1):
    fp = os.path.join(music_dir, f'bt_{i}.flac')
    sz = make_wav(fp, 192000, 24)
    tracks.append((f'trk_bt_{i}', 'rel_blue_train', fp, os.path.basename(fp), sz, ttitle, 'John Coltrane', 'Blue Train', 1, i, 260.0, 'FLAC', 192000, 24))

for i in range(1, 16):
    fp = os.path.join(music_dir, f'mega_{i:03d}.flac')
    sz = make_wav(fp, 44100, 16, 1024)
    tracks.append((f'trk_mega_{i:03d}', 'rel_mega_220', fp, os.path.basename(fp), sz, f'Etude {i:03d}', 'Composer Collective', 'Mega Anthology', 1, i, 90.0, 'FLAC', 44100, 16))

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
`
  const pythonBin = resolvePythonBin()
  const res = spawnSync(pythonBin, ['-c', pyScript], { encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) {
    throw new Error(`Python SQLite fixture seeding failed: ${res.stderr || res.stdout}`)
  }
}

export async function startCadenceStack(): Promise<CadenceE2eStack> {
  const headlessBin = resolveHeadlessBinary()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-pw-e2e-'))
  const appDataDir = path.join(tempRoot, 'var_lib_cadence')
  const musicDir = path.join(tempRoot, 'music_ro')
  const tmpDir = path.join(tempRoot, 'tmp')
  fs.mkdirSync(appDataDir, { recursive: true })
  fs.mkdirSync(musicDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const corePort = await getFreePort()
  const mediaPort = await getFreePort()
  const pairingToken = 'cadence_pw_e2e_token_0123456789abcdef'
  const rs130 = await startRs130Simulator('uuid:cadence-pw-e2e-rs130')

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
        String(corePort),
        '--media-port',
        String(mediaPort),
        '--label',
        'E2E Gate Core',
        '--headroom-mb',
        '64',
      ],
      {
        cwd: REPO_ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          CADENCE_ALLOW_LOOPBACK: 'true',
          CADENCE_MUSIC_READ_ONLY: 'true',
          CADENCE_MIN_LOCKABLE_MB: '1',
          CADENCE_PAIRING_TOKEN: pairingToken,
          CADENCE_PINNED_RS130_UDN: 'uuid:cadence-pw-e2e-rs130',
          CADENCE_RS130_DESC_URL: rs130.descUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stderrBuf = ''
    proc.stderr?.on('data', (chunk) => {
      stderrBuf += String(chunk)
    })
    proc.on('exit', (code) => {
      if (code !== null && code !== 0 && stderrBuf) {
        console.error(`[cadence-headless exit ${code}]: ${stderrBuf.trim()}`)
      }
    })
    await waitForHttpReady(`http://127.0.0.1:${corePort}/healthz`, 20_000)
    return proc
  }

  let coreProc: ChildProcess | null = null
  let desktopVite: ManagedProcess | null = null
  let pwaVite: ManagedProcess | null = null

  try {
    // Boot once to initialize SQLite schema, stop, seed synthetic catalog, then reboot
    coreProc = await spawnCore()
    killProcessTree(coreProc)
    coreProc = null
    await sleep(300)

    seedE2eFixtures(path.join(appDataDir, 'cadence.db'), musicDir)
    coreProc = await spawnCore()

    const healthResp = await fetch(`http://127.0.0.1:${corePort}/healthz`, {
      headers: { 'x-cadence-token': pairingToken },
    })
    const health = (await healthResp.json()) as {
      engineId?: string
      libraryId?: string
      engine?: { id?: string }
      library?: { id?: string }
    }
    const coreEngineId = health.engineId || health.engine?.id || ''
    const coreLibraryId = health.libraryId || health.library?.id || ''
    if (!coreEngineId || !coreLibraryId) {
      throw new Error(`Unexpected /healthz identity payload: ${JSON.stringify(health)}`)
    }

    ;[desktopVite, pwaVite] = await Promise.all([
      startViteServer({ cwd: REPO_ROOT }),
      startViteServer({ cwd: path.join(REPO_ROOT, 'pwa') }),
    ])

    return {
      coreUrl: `http://127.0.0.1:${corePort}`,
      corePort,
      coreEngineId,
      coreLibraryId,
      pairingToken,
      desktopUrl: desktopVite.url,
      pwaUrl: pwaVite.url,
      rs130,
      stop: async () => {
        await Promise.all([desktopVite?.stop(), pwaVite?.stop(), rs130.close()])
        killProcessTree(coreProc)
        await sleep(250)
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          // best-effort temp cleanup
        }
      },
    }
  } catch (err) {
    await Promise.all([desktopVite?.stop(), pwaVite?.stop(), rs130.close()])
    killProcessTree(coreProc)
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw err
  }
}
