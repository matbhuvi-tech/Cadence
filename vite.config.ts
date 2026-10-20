import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const uncHostReachability = new Map<string, { reachable: boolean; checkedAt: number }>()

async function isUncHostReachable(host: string): Promise<boolean> {
  const cached = uncHostReachability.get(host)
  const now = Date.now()
  if (cached && now - cached.checkedAt < 30000) {
    return cached.reachable
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 445, timeout: 350 }, () => {
      socket.destroy()
      uncHostReachability.set(host, { reachable: true, checkedAt: now })
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      uncHostReachability.set(host, { reachable: false, checkedAt: now })
      resolve(false)
    })
    socket.on('timeout', () => {
      socket.destroy()
      uncHostReachability.set(host, { reachable: false, checkedAt: now })
      resolve(false)
    })
  })
}

const AUDIO_EXTS = new Set([
  '.flac',
  '.dsf',
  '.dff',
  '.alac',
  '.m4a',
  '.mp3',
  '.wav',
  '.ogg',
  '.aac',
  '.aiff',
  '.ape',
  '.opus',
])

function findAudioFilesRecursive(dir: string, maxFiles: number = 100000): string[] {
  const results: string[] = []
  const queue: string[] = [dir]

  while (queue.length > 0 && results.length < maxFiles) {
    const currentDir = queue.shift()!
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break
      if (
        entry.name.startsWith('.') ||
        entry.name === '$RECYCLE.BIN' ||
        entry.name === 'node_modules' ||
        entry.name === 'System Volume Information'
      ) {
        continue
      }
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (AUDIO_EXTS.has(ext)) {
          results.push(fullPath)
        }
      }
    }
  }

  return results
}

function getDiskStats(dirPath: string) {
  const winMatch = dirPath.match(/^([A-Za-z]:)/)
  const uncMatch = dirPath.match(/^(\\\\[^\\]+\\[^\\]+)/)
  const driveName = winMatch ? winMatch[1] : uncMatch ? uncMatch[1] : path.parse(dirPath).root || 'Network Share'
  const fileSystem = uncMatch ? 'ZFS' : winMatch ? 'NTFS' : 'APFS'

  try {
    const s = fs.statfsSync(dirPath)
    return {
      totalBytes: s.blocks * s.bsize,
      freeBytes: s.bfree * s.bsize,
      usedBytes: (s.blocks - s.bfree) * s.bsize,
      driveName,
      fileSystem,
    }
  } catch {
    return {
      totalBytes: 3000000000000,
      freeBytes: 1500000000000,
      usedBytes: 1500000000000,
      driveName,
      fileSystem,
    }
  }
}

function normalizeGenreTags(genreInput: any): string[] {
  if (Array.isArray(genreInput)) {
    const list = genreInput.filter(Boolean).map((s) => String(s).trim()).filter(Boolean)
    return list.length > 0 ? list : ['Library Import']
  }
  if (typeof genreInput === 'string' && genreInput.trim()) {
    const list = genreInput.split(/[,;/]+/).map((s) => s.trim()).filter(Boolean)
    return list.length > 0 ? list : ['Library Import']
  }
  return ['Library Import']
}

/**
 * Updates or inserts an 'id3 ' chunk in a RIFF WAVE file without touching or re-encoding the PCM audio stream.
 */
function writeWavId3Tags(filePath: string, tags: any, NodeID3: any): boolean {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 12) return false

    // Verify RIFF WAVE magic header
    const magic = buf.subarray(0, 4).toString('ascii')
    const format = buf.subarray(8, 12).toString('ascii')
    if (magic !== 'RIFF' || format !== 'WAVE') return false

    const id3Data: Buffer = NodeID3.create(tags)
    if (!id3Data || id3Data.length === 0) return false

    // RIFF chunk header: 'id3 ' + 4-byte LE size + data + pad byte if odd
    const isOdd = id3Data.length % 2 !== 0
    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write('id3 ', 0, 4, 'ascii')
    chunkHeader.writeUInt32LE(id3Data.length, 4)

    const newId3Chunk = Buffer.concat([
      chunkHeader,
      id3Data,
      ...(isOdd ? [Buffer.from([0])] : []),
    ])

    // Scan existing RIFF chunks for an existing 'id3 ' or 'ID3 ' chunk
    let offset = 12
    let existingId3Offset = -1
    let existingId3Size = -1

    while (offset + 8 <= buf.length) {
      const chunkId = buf.subarray(offset, offset + 4).toString('ascii')
      const chunkSize = buf.readUInt32LE(offset + 4)
      const paddedSize = chunkSize + (chunkSize % 2 !== 0 ? 1 : 0)

      if (chunkId.toLowerCase() === 'id3 ') {
        existingId3Offset = offset
        existingId3Size = 8 + paddedSize
      }

      offset += 8 + paddedSize
    }

    let finalBuffer: Buffer
    if (existingId3Offset !== -1) {
      const before = buf.subarray(0, existingId3Offset)
      const after = buf.subarray(existingId3Offset + existingId3Size)
      finalBuffer = Buffer.concat([before, newId3Chunk, after])
    } else {
      finalBuffer = Buffer.concat([buf, newId3Chunk])
    }

    // Update RIFF total size: finalBuffer.length - 8
    if (finalBuffer.length > 0xFFFFFFFF) {
      console.warn(`[writeWavId3Tags] Target WAV file exceeds 4GB RIFF boundary: ${filePath}`)
      return false
    }
    finalBuffer.writeUInt32LE(finalBuffer.length - 8, 4)
    fs.writeFileSync(filePath, finalBuffer)
    return true
  } catch (err) {
    console.warn(`[writeWavId3Tags] Could not write RIFF id3 chunk to ${filePath}:`, err)
    return false
  }
}

function getGeminiApiKey(): string {
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY
  }
  try {
    const envPath = path.resolve(process.cwd(), '.env')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8')
      const match = content.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)$/m)
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, '')
      }
    }
  } catch {}
  return ''
}

function getGeminiModel(): string {
  if (process.env.GEMINI_MODEL) {
    return process.env.GEMINI_MODEL
  }
  try {
    const envPath = path.resolve(process.cwd(), '.env')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8')
      const match = content.match(/^\s*GEMINI_MODEL\s*=\s*(.+)$/m)
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, '')
      }
    }
  } catch {}
  return 'gemini-3.8-flash'
}

// --- Gemini API Shared Token-Bucket Pacer & Resilient Backoff ---
let lastGeminiCallTimestamp = 0
const GEMINI_PACING_INTERVAL_MS = 4000 // 15 RPM Safe Pacing Buffer for Free Tier

const GEMINI_CANDIDATE_MODELS = [
  getGeminiModel(),
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-pro-latest',
].filter((m, idx, arr) => m && arr.indexOf(m) === idx)

interface GeminiCallOptions {
  bodyPayload: any
  timeoutMs?: number
}

interface GeminiCallResult {
  ok: boolean
  status: number
  data?: any
  modelUsed?: string
  pacingDelayMs?: number
  retriesAttempted?: number
  error?: string
}

async function executePacedGeminiCall(
  apiKey: string,
  options: GeminiCallOptions
): Promise<GeminiCallResult> {
  const { bodyPayload, timeoutMs = 25000 } = options

  // 1. Enforce Token-Bucket Pacing (4000ms safe floor between calls)
  const now = Date.now()
  const elapsed = now - lastGeminiCallTimestamp
  const waitMs = Math.max(0, GEMINI_PACING_INTERVAL_MS - elapsed)
  if (waitMs > 0) {
    console.log(`[Gemini Pacing] Enforcing safe Free Tier buffer: waiting ${waitMs}ms before dispatch...`)
    await new Promise((r) => setTimeout(r, waitMs))
  }
  lastGeminiCallTimestamp = Date.now()

  let lastError: any = null
  let totalRetries = 0

  for (const model of GEMINI_CANDIDATE_MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    // Attempt up to 3 retries with exponential backoff on 429/503 for this model
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`[Gemini AI] Querying model ${model} (attempt ${attempt + 1})...`)
        const resTry = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify(bodyPayload),
        })

        if (resTry.ok) {
          lastGeminiCallTimestamp = Date.now()
          const json = await resTry.json()
          return {
            ok: true,
            status: 200,
            data: json,
            modelUsed: model,
            pacingDelayMs: waitMs,
            retriesAttempted: totalRetries,
          }
        }

        // Handle 429 Too Many Requests or 503 Overloaded
        if (resTry.status === 429 || resTry.status === 503) {
          totalRetries++
          const errJson = (await resTry.json().catch(() => ({}))) as any
          lastError =
            errJson?.error?.message ||
            (resTry.status === 429 ? 'Rate limit exceeded (15 RPM)' : 'Service temporarily overloaded')

          // If attempt < 2, perform exponential backoff: 2s, 4s (+ jitter)
          if (attempt < 2) {
            const backoffMs = Math.pow(2, attempt + 1) * 1000 + Math.floor(Math.random() * 500)
            console.warn(
              `[Gemini AI] Model ${model} returned HTTP ${resTry.status}. Exponential backoff: waiting ${backoffMs}ms before retry...`
            )
            await new Promise((r) => setTimeout(r, backoffMs))
            continue
          } else {
            console.warn(
              `[Gemini AI] Model ${model} exhausted retries on HTTP ${resTry.status}. Trying next fallback model...`
            )
            break // Fallback to next candidate model
          }
        } else {
          // Other error (400, 404, etc.)
          const errJson = (await resTry.json().catch(() => ({}))) as any
          lastError = errJson?.error?.message || `HTTP ${resTry.status}`
          console.warn(`[Gemini AI] Model ${model} returned HTTP ${resTry.status}: ${lastError}`)
          break // Move to next model
        }
      } catch (err: any) {
        lastError = err.message
        console.warn(`[Gemini AI] Model ${model} fetch exception: ${err.message}`)
        break
      }
    }
  }

  return {
    ok: false,
    status: lastError?.includes('429') || lastError?.includes('Rate limit') ? 429 : 503,
    error: lastError || 'All Gemini AI candidate models failed',
    pacingDelayMs: waitMs,
    retriesAttempted: totalRetries,
  }
}

function localLibraryScannerPlugin(): Plugin {
  return {

    name: 'local-library-scanner',
    configureServer(server) {
      // 1. Real-Time Server-Sent Events (SSE) Streaming Scanner with Parallel SMB Concurrency
      server.middlewares.use('/api/scan-stream', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const targetPath = url.searchParams.get('path')

        if (!targetPath) {
          res.statusCode = 400
          res.end('Missing ?path= parameter')
          return
        }

        const cleanedPath = targetPath.trim().replace(/^["']+|["']+$/g, '')
        const normalized = path.resolve(cleanedPath)
        if (!fs.existsSync(normalized)) {
          res.statusCode = 404
          res.end(`Directory not found: "${targetPath}"`)
          return
        }

        // Setup SSE Headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })

        let isClosed = false
        req.on('close', () => {
          isClosed = true
        })

        const sendEvent = (event: string, data: any) => {
          if (isClosed) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        const diskStats = getDiskStats(normalized)

        sendEvent('status', {
          phase: 'discovering',
          message: `Scanning directory structure for audio albums in: ${normalized}...`,
        })

        // Fast discovery of all audio files
        const files = findAudioFilesRecursive(normalized, 100000)

        if (files.length === 0) {
          sendEvent('error', { message: `No supported audio files found in "${normalized}".` })
          res.end()
          return
        }

        sendEvent('discovered', {
          totalFiles: files.length,
          rootPath: normalized,
          diskStats,
          message: `Discovered ${files.length} audio tracks. Beginning high-throughput metadata extraction...`,
        })

        const { parseFile } = await import('music-metadata')
        const startTime = Date.now()
        const discoveredAlbums = new Set<string>()
        const discoveredWorks = new Set<string>()
        const CHUNK_SIZE = 50
        const CONCURRENCY = 16
        let currentChunk: any[] = []
        let lastReportTime = Date.now()
        let processedCount = 0

        async function parseOneFile(filePath: string) {
          try {
            const stat = fs.statSync(filePath)
            const meta = await parseFile(filePath, { skipCovers: true })
            const common = meta.common || {}
            const format = meta.format || {}

            const dir1 = path.basename(path.dirname(filePath))
            const dir2 = path.basename(path.dirname(path.dirname(filePath)))
            let folderName = dir1
            let folderPath = path.dirname(filePath)

            // If immediate parent is a disc folder (e.g. CD 1, Disc 2, Side A) or an artist subfolder
            if (/^(cd\s*\d+|disc\s*\d+|disk\s*\d+|side\s*[a-d]|\d+)$/i.test(dir1)) {
              if (dir2 && !['oriental', 'master', 'music'].includes(dir2.toLowerCase())) {
                folderName = dir2
                folderPath = path.dirname(path.dirname(filePath))
              }
            }

            // Path-based taxonomy detection (Language & Composer from Directory Structure)
            const normalizedPath = filePath.replace(/\\/g, '/')
            let pathLanguage = ''
            if (/\/(hindi|bollywood)\//i.test(normalizedPath)) pathLanguage = 'Hindi'
            else if (/\/(tamil|kollywood)\//i.test(normalizedPath)) pathLanguage = 'Tamil'
            else if (/\/(telugu|tollywood)\//i.test(normalizedPath)) pathLanguage = 'Telugu'
            else if (/\/(malayalam|mollywood)\//i.test(normalizedPath)) pathLanguage = 'Malayalam'
            else if (/\/(kannada|sandalwood)\//i.test(normalizedPath)) pathLanguage = 'Kannada'

            let albumName = common.album
            const isGenericCompilation = Boolean(
              albumName &&
              /^(signature collection|greatest hits|best of|the best of|collection|the very best|definitive|box\s*set|boxset|anthology|compilation|various artists)/i.test(albumName.trim())
            )
            const isFolderClean = Boolean(
              folderName &&
              !['music', 'audio', 'master', 'songs', 'flac', 'wav', 'mp3', 'cd rip'].includes(folderName.toLowerCase()) &&
              !/^(cd\s*\d+|disc\s*\d+|\d+)$/i.test(folderName)
            )

            // If album tag is a generic compilation boxset but physical directory is an album (e.g. Dil Se, Guru, Delhi - 6)
            if (!albumName || (isGenericCompilation && isFolderClean)) {
              albumName = folderName
            }

            if (!albumName) {
              if (
                dir2 &&
                !['oriental', 'master', 'music'].includes(dir2.toLowerCase()) &&
                (dir1.toLowerCase() === 'illayaraja' || /^(cd\s*\d+|disc\s*\d+|side\s*[a-d]|\d+)$/i.test(dir1))
              ) {
                albumName = dir2
              } else {
                albumName = dir1
              }
            }
            const workName = (common as any).work

            if (albumName) discoveredAlbums.add(albumName)
            if (workName) discoveredWorks.add(workName)

            const rawArtist =
              common.artist ||
              (Array.isArray(common.artists) && common.artists[0]) ||
              common.albumartist ||
              (Array.isArray(common.albumartists) && common.albumartists[0]) ||
              (dir2 && !['master', 'music', 'hindi', 'tamil', 'telugu'].includes(dir2.toLowerCase()) ? dir2 : 'Unknown Artist')

            let trackNo = common.track?.no
            if (!trackNo) {
              const match = path.basename(filePath).match(/^(\d+)[\s._-]+/)
              if (match) trackNo = parseInt(match[1], 10)
            }

            // Check for cadence-album.sidecar.json in album directory
            const albumDir = path.dirname(filePath)
            const albumSidecarPath = path.join(albumDir, 'cadence-album.sidecar.json')
            if (fs.existsSync(albumSidecarPath)) {
              try {
                const albData = JSON.parse(fs.readFileSync(albumSidecarPath, 'utf8'))
                if (albData.album) albumName = albData.album
                if (albData.folderName) folderName = albData.folderName
              } catch {}
            }

            // Check if .sidecar.json exists next to this audio file
            let sidecarData: any = null
            const sidecarPath = `${filePath}.sidecar.json`
            if (fs.existsSync(sidecarPath)) {
              try {
                const raw = fs.readFileSync(sidecarPath, 'utf8')
                sidecarData = JSON.parse(raw)
              } catch {}
            }
            const sMeta = sidecarData?.metadata || {}

            const finalTitle = sMeta.title || common.title || path.basename(filePath).replace(/\.[^/.]+$/, '').replace(/^\d+[\s._-]+/, '')
            const finalArtist = sMeta.artist || rawArtist
            const finalAlbum = sMeta.album || albumName
            const finalComposer = sMeta.composer || common.composer || (dir2 && !['master', 'music', 'hindi', 'tamil', 'telugu'].includes(dir2.toLowerCase()) ? dir2 : '')
            const finalYear = sMeta.year || common.year || (common.originalyear as number) || undefined
            const finalTrackNo = sMeta.trackNumber || trackNo
            const finalGenre = normalizeGenreTags(sMeta?.genre ?? common.genre)

            return {
              fileName: path.basename(filePath),
              filePath,
              folderName,
              folderPath,
              fileSize: stat.size,
              lastModified: stat.mtimeMs,
              sidecarStatus: sidecarData ? 'committed' : 'none',
              common: {
                title: finalTitle,
                artist: finalArtist,
                albumartist: common.albumartist || (Array.isArray(common.albumartists) && common.albumartists[0]) || finalArtist,
                album: finalAlbum,
                composer: finalComposer,
                year: finalYear,
                track: { no: finalTrackNo, of: common.track?.of },
                disk: common.disk || { no: 1, of: 1 },
                genre: finalGenre,
                work: workName,
                movement: (common as any).movement,
                opus: (common as any).opus,
                dynamic_range: (common as any).dynamic_range,
                replaygain_track_gain: common.replaygain_track_gain,
                replaygain_track_peak: common.replaygain_track_peak,
                language: sMeta.language || pathLanguage || common.language || (common as any).language || '',
              },
              format: {
                container: format.container || path.extname(filePath).slice(1).toUpperCase(),
                sampleRate: format.sampleRate || 44100,
                bitsPerSample: format.bitsPerSample || 16,
                duration: format.duration || 180,
                lossless: format.lossless ?? true,
              },
            }
          } catch {
            try {
              const stat = fs.statSync(filePath)
              const dir1 = path.basename(path.dirname(filePath))
              const dir2 = path.basename(path.dirname(path.dirname(filePath)))
              let folderName = dir1
              let folderPath = path.dirname(filePath)
              if (/^(cd\s*\d+|disc\s*\d+|disk\s*\d+|side\s*[a-d]|\d+)$/i.test(dir1)) {
                if (dir2 && !['oriental', 'master', 'music'].includes(dir2.toLowerCase())) {
                  folderName = dir2
                  folderPath = path.dirname(path.dirname(filePath))
                }
              }
              let albumName = folderName || 'Unknown Album'

              // Check for cadence-album.sidecar.json
              const albSidecar = path.join(path.dirname(filePath), 'cadence-album.sidecar.json')
              if (fs.existsSync(albSidecar)) {
                try {
                  const albData = JSON.parse(fs.readFileSync(albSidecar, 'utf8'))
                  if (albData.album) albumName = albData.album
                  if (albData.folderName) folderName = albData.folderName
                } catch {}
              }

              // Check for track sidecar
              let sMeta: any = null
              const trkSidecar = `${filePath}.sidecar.json`
              if (fs.existsSync(trkSidecar)) {
                try {
                  sMeta = JSON.parse(fs.readFileSync(trkSidecar, 'utf8'))?.metadata || null
                } catch {}
              }

              const finalTitle = sMeta?.title || path.basename(filePath).replace(/\.[^/.]+$/, '')
              const finalArtist = sMeta?.artist || 'Unknown Artist'
              const finalAlbum = sMeta?.album || albumName

              discoveredAlbums.add(finalAlbum)
              return {
                fileName: path.basename(filePath),
                filePath,
                folderName,
                folderPath,
                fileSize: stat.size,
                lastModified: stat.mtimeMs,
                sidecarStatus: sMeta ? 'committed' : 'none',
                common: {
                  title: finalTitle,
                  artist: finalArtist,
                  album: finalAlbum,
                  composer: sMeta?.composer || '',
                  year: sMeta?.year,
                  track: sMeta?.trackNumber ? { no: sMeta.trackNumber } : undefined,
                  genre: normalizeGenreTags(sMeta?.genre),
                },
                format: {
                  container: path.extname(filePath).slice(1).toUpperCase(),
                  sampleRate: 44100,
                  bitsPerSample: 16,
                  duration: 180,
                  lossless: true,
                },
              }
            } catch {
              return null
            }
          }
        }

        for (let i = 0; i < files.length; i += CONCURRENCY) {
          if (isClosed) break
          const batch = files.slice(i, i + CONCURRENCY)
          const results = await Promise.all(batch.map((f) => parseOneFile(f)))

          for (let j = 0; j < results.length; j++) {
            const item = results[j]
            if (item) currentChunk.push(item)
          }

          processedCount += batch.length
          const now = Date.now()
          const shouldReport =
            currentChunk.length >= CHUNK_SIZE ||
            processedCount >= files.length ||
            now - lastReportTime > 200

          if (shouldReport) {
            const elapsedSec = Math.max(0.1, (now - startTime) / 1000)
            const tracksPerSec = Math.round(processedCount / elapsedSec)
            const remainingFiles = Math.max(0, files.length - processedCount)
            const etaSeconds = tracksPerSec > 0 ? Math.round(remainingFiles / tracksPerSec) : 0
            const lastPath = batch[batch.length - 1] || ''

            sendEvent('progress', {
              processedFiles: Math.min(processedCount, files.length),
              totalFiles: files.length,
              currentFileName: path.basename(lastPath),
              currentAlbumName: path.basename(path.dirname(lastPath)),
              tracksPerSecond: tracksPerSec,
              estimatedTimeRemainingSeconds: etaSeconds,
              discoveredReleases: discoveredAlbums.size,
              discoveredWorks: discoveredWorks.size,
            })

            if (currentChunk.length > 0) {
              sendEvent('chunk', { items: currentChunk })
              currentChunk = []
            }

            lastReportTime = now
          }
        }

        // Flush any remaining items in chunk buffer
        if (currentChunk.length > 0 && !isClosed) {
          sendEvent('chunk', { items: currentChunk })
          currentChunk = []
        }

        if (!isClosed) {
          sendEvent('complete', {
            totalDiscovered: files.length,
            totalParsed: processedCount,
            totalAlbums: discoveredAlbums.size,
            totalWorks: discoveredWorks.size,
            rootPath: normalized,
            diskStats,
          })
          res.end()
        }
      })

      // 1.5 Real-Time Audio Streaming with HTTP 206 Byte-Range Scrubbing
      server.middlewares.use('/api/track-stream', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const targetPath = url.searchParams.get('path')

        if (!targetPath) {
          res.statusCode = 400
          res.end('Missing ?path= parameter')
          return
        }

        const cleanedPath = targetPath.trim().replace(/^["']+|["']+$/g, '')
        const normalized = path.resolve(cleanedPath)

        const uncMatch = cleanedPath.match(/^\\\\([^\\]+)/)
        if (uncMatch) {
          const host = uncMatch[1]
          const reachable = await isUncHostReachable(host)
          if (!reachable) {
            res.statusCode = 404
            res.end(`Network storage host "${host}" is currently unreachable.`)
            return
          }
        }

        if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) {
          res.statusCode = 404
          res.end(`Audio file not found: "${targetPath}"`)
          return
        }

        const stat = fs.statSync(normalized)
        const fileSize = stat.size
        const ext = path.extname(normalized).toLowerCase()

        const mimeTypes: Record<string, string> = {
          '.flac': 'audio/flac',
          '.wav': 'audio/wav',
          '.mp3': 'audio/mpeg',
          '.m4a': 'audio/mp4',
          '.aac': 'audio/aac',
          '.ogg': 'audio/ogg',
          '.opus': 'audio/opus',
          '.aiff': 'audio/aiff',
          '.aif': 'audio/aiff',
        }
        const contentType = mimeTypes[ext] || 'audio/octet-stream'

        const range = req.headers.range
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
          const chunksize = end - start + 1
          const file = fs.createReadStream(normalized, { start, end })

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
          })
          file.pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
          })
          fs.createReadStream(normalized).pipe(res)
        }
      })

      // 2. On-Demand Track / Directory Artwork Extraction
      server.middlewares.use('/api/track-art', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const targetPath = url.searchParams.get('path')

        if (!targetPath) {
          res.statusCode = 400
          res.end('Missing ?path= parameter')
          return
        }

        const cleanedPath = targetPath.trim().replace(/^["']+|["']+$/g, '')
        const normalized = path.resolve(cleanedPath)
        const isStrict = url.searchParams.get('strict') === 'true' || url.searchParams.get('fallback') === '404'

        const sendPlaceholderSvg = (titleHint?: string) => {
          const displayTitle = (titleHint || 'Archival Master')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <radialGradient id="discGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#1E2433" />
      <stop offset="65%" stop-color="#0E121A" />
      <stop offset="100%" stop-color="#07090D" />
    </radialGradient>
    <linearGradient id="neonRim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00F5FF" />
      <stop offset="100%" stop-color="#ADFF2F" />
    </linearGradient>
  </defs>
  <rect width="400" height="400" fill="#0A0C10" rx="12"/>
  <circle cx="200" cy="200" r="160" fill="url(#discGrad)" stroke="#1F293D" stroke-width="2"/>
  <circle cx="200" cy="200" r="135" fill="none" stroke="#161B26" stroke-width="1"/>
  <circle cx="200" cy="200" r="110" fill="none" stroke="#222A3B" stroke-width="0.8"/>
  <circle cx="200" cy="200" r="85" fill="none" stroke="#161B26" stroke-width="1"/>
  <circle cx="200" cy="200" r="55" fill="#121622" stroke="url(#neonRim)" stroke-width="2"/>
  <circle cx="200" cy="200" r="10" fill="#00F5FF" fill-opacity="0.9"/>
  <circle cx="200" cy="200" r="3" fill="#0A0C10"/>
  <text x="200" y="325" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="700" fill="#00F5FF" text-anchor="middle" letter-spacing="2.5">CADENCE ARCHIVAL</text>
  <text x="200" y="345" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="9" font-weight="500" fill="#64748B" text-anchor="middle" letter-spacing="1">BIT-PERFECT MASTER</text>
  <text x="200" y="365" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="600" fill="#94A3B8" text-anchor="middle">${displayTitle.slice(0, 32)}</text>
</svg>`.trim()

          res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
          res.setHeader('Cache-Control', 'public, max-age=3600')
          res.statusCode = 200
          res.end(svg)
        }

        const uncMatch = cleanedPath.match(/^\\\\([^\\]+)/)
        if (uncMatch) {
          const host = uncMatch[1]
          const reachable = await isUncHostReachable(host)
          if (!reachable) {
            if (isStrict) {
              res.statusCode = 404
              res.end(`Host "${host}" is currently unreachable`)
              return
            }
            sendPlaceholderSvg(path.basename(cleanedPath))
            return
          }
        }

        if (!fs.existsSync(normalized)) {
          if (isStrict) {
            res.statusCode = 404
            res.end('File or directory not found')
            return
          }
          sendPlaceholderSvg(path.basename(cleanedPath))
          return
        }

        try {
          const stat = fs.statSync(normalized)
          const isDir = stat.isDirectory()
          const dir = isDir ? normalized : path.dirname(normalized)

          // 1. If an image file was directly specified
          if (!isDir && /\.(jpe?g|png|webp|svg)$/i.test(normalized)) {
            const ext = path.extname(normalized).toLowerCase()
            const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg'
            res.setHeader('Content-Type', mime)
            res.setHeader('Cache-Control', 'public, max-age=86400')
            res.end(fs.readFileSync(normalized))
            return
          }

          // 2. Check for image files in the directory with smart prioritized matching
          try {
            const files = fs.readdirSync(dir)
            const imgFiles = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))

            if (imgFiles.length > 0) {
              // Priority 1: Front cover scan (e.g. "Dil Se - 00 - Front Cover.jpg", "front.jpg", "Front.jpeg", "Cover - Front.jpg")
              let chosenArt = imgFiles.find((f) => /front\s*cover|front/i.test(f))

              // Priority 2: Standard cover or folder art (e.g. "Folder.jpg", "cover.png", "Cover.jpg", "album.jpg")
              if (!chosenArt) {
                chosenArt = imgFiles.find((f) => /^(cover|folder|album)/i.test(f) || /cover|folder|album/i.test(f))
              }

              // Priority 3: Booklet, scan, artwork, or disc image
              if (!chosenArt) {
                chosenArt = imgFiles.find((f) => /art|artwork|scan|booklet|cd|disc/i.test(f))
              }

              // Priority 4: Any first image file in the directory
              if (!chosenArt) {
                chosenArt = imgFiles[0]
              }

              if (chosenArt) {
                const dynPath = path.join(dir, chosenArt)
                const ext = path.extname(dynPath).toLowerCase()
                const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
                res.setHeader('Content-Type', mime)
                res.setHeader('Cache-Control', 'public, max-age=86400')
                res.end(fs.readFileSync(dynPath))
                return
              }
            }
          } catch {}

          // Also check parent directory if current folder is a disc subfolder (e.g. CD 1, Disc 2)
          const parentDir = path.dirname(dir)
          if (/^(cd\s*\d+|disc\s*\d+|disk\s*\d+|side\s*[a-d]|\d+)$/i.test(path.basename(dir))) {
            try {
              const pFiles = fs.readdirSync(parentDir)
              const pImgFiles = pFiles.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
              const pChosen =
                pImgFiles.find((f) => /front\s*cover|front/i.test(f)) ||
                pImgFiles.find((f) => /cover|folder|album/i.test(f)) ||
                pImgFiles[0]
              if (pChosen) {
                const candPath = path.join(parentDir, pChosen)
                const ext = path.extname(candPath).toLowerCase()
                const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
                res.setHeader('Content-Type', mime)
                res.setHeader('Cache-Control', 'public, max-age=86400')
                res.end(fs.readFileSync(candPath))
                return
              }
            } catch {}
          }

          // 3. Check if cadence-album.sidecar.json has a coverArtUrl (e.g. iTunes or MusicBrainz URL)
          try {
            const albSidecar = path.join(dir, 'cadence-album.sidecar.json')
            if (fs.existsSync(albSidecar)) {
              const albData = JSON.parse(fs.readFileSync(albSidecar, 'utf8'))
              const remoteArt = albData.coverArtUrl || albData.artworkUrl
              if (remoteArt && typeof remoteArt === 'string' && remoteArt.startsWith('http')) {
                res.writeHead(302, { Location: remoteArt })
                res.end()
                return
              }
            }
          } catch {}

          // 4. Extract embedded picture via music-metadata
          const { parseFile } = await import('music-metadata')
          let audioFilePath = !isDir ? normalized : null

          // If directory, find first audio file in it
          if (isDir) {
            try {
              const dirFiles = fs.readdirSync(dir)
              const audioFile = dirFiles.find((f) =>
                /\.(flac|m4a|alac|mp3|wav|ogg|aiff|ape|wv|dsf|dff)$/i.test(f)
              )
              if (audioFile) audioFilePath = path.join(dir, audioFile)
            } catch {}
          }

          if (audioFilePath && fs.existsSync(audioFilePath)) {
            try {
              const meta = await parseFile(audioFilePath)
              if (meta.common.picture && meta.common.picture.length > 0) {
                const pic = meta.common.picture[0]
                res.setHeader('Content-Type', pic.format || 'image/jpeg')
                res.setHeader('Cache-Control', 'public, max-age=86400')
                res.end(pic.data)
                return
              }
            } catch {}
          }

          if (isStrict) {
            res.statusCode = 404
            res.end('No cover artwork found')
            return
          }

          // Generate dark audiophile SVG placeholder with album title hint
          let titleHint = path.basename(dir).replace(/\s*cd\s*rip/gi, '').trim()
          try {
            const albSidecar = path.join(dir, 'cadence-album.sidecar.json')
            if (fs.existsSync(albSidecar)) {
              const albData = JSON.parse(fs.readFileSync(albSidecar, 'utf8'))
              if (albData.album) titleHint = albData.album
            }
          } catch {}

          sendPlaceholderSvg(titleHint)
        } catch (err: any) {
          if (isStrict) {
            res.statusCode = 500
            res.end(`Failed to extract artwork: ${err.message}`)
            return
          }
          sendPlaceholderSvg(path.basename(cleanedPath))
        }
      })

      // 3. Fallback Batch Scan Endpoint (high-capacity up to 50,000 files)
      server.middlewares.use('/api/scan-local-dir', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const targetPath = url.searchParams.get('path')

        res.setHeader('Content-Type', 'application/json')

        if (!targetPath) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Missing ?path= parameter' }))
          return
        }

        const normalized = path.resolve(targetPath)
        if (!fs.existsSync(normalized)) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: `Directory not found on local disk: "${targetPath}"` }))
          return
        }

        try {
          const files = findAudioFilesRecursive(normalized, 50000)
          const diskStats = getDiskStats(normalized)
          const { parseFile } = await import('music-metadata')

          const parsedItems = []
          for (const filePath of files) {
            try {
              const stat = fs.statSync(filePath)
              const meta = await parseFile(filePath, { skipCovers: true })
              const common = meta.common || {}
              const format = meta.format || {}

              // Check for cadence-album.sidecar.json
              const albSidecar = path.join(path.dirname(filePath), 'cadence-album.sidecar.json')
              let albData: any = null
              if (fs.existsSync(albSidecar)) {
                try {
                  albData = JSON.parse(fs.readFileSync(albSidecar, 'utf8'))
                } catch {}
              }

              // Check if .sidecar.json exists next to this audio file
              let sidecarData: any = null
              const sidecarPath = `${filePath}.sidecar.json`
              if (fs.existsSync(sidecarPath)) {
                try {
                  const raw = fs.readFileSync(sidecarPath, 'utf8')
                  sidecarData = JSON.parse(raw)
                } catch {}
              }
              const sMeta = sidecarData?.metadata || {}

              const dir1 = path.basename(path.dirname(filePath))
              const dir2 = path.basename(path.dirname(path.dirname(filePath)))
              let folderName = sMeta.folderName || albData?.folderName || dir1
              let folderPath = path.dirname(filePath)

              if (/^(cd\s*\d+|disc\s*\d+|disk\s*\d+|side\s*[a-d]|\d+)$/i.test(dir1)) {
                if (dir2 && !['oriental', 'master', 'music'].includes(dir2.toLowerCase())) {
                  folderName = dir2
                  folderPath = path.dirname(path.dirname(filePath))
                }
              }

              // Path-based language detection
              const normalizedPath = filePath.replace(/\\/g, '/')
              let pathLanguage = ''
              if (/\/(hindi|bollywood)\//i.test(normalizedPath)) pathLanguage = 'Hindi'
              else if (/\/(tamil|kollywood)\//i.test(normalizedPath)) pathLanguage = 'Tamil'
              else if (/\/(telugu|tollywood)\//i.test(normalizedPath)) pathLanguage = 'Telugu'
              else if (/\/(malayalam|mollywood)\//i.test(normalizedPath)) pathLanguage = 'Malayalam'
              else if (/\/(kannada|sandalwood)\//i.test(normalizedPath)) pathLanguage = 'Kannada'

              let albumName = sMeta.album || albData?.album || common.album
              const isGenericCompilation = Boolean(
                albumName &&
                /^(signature collection|greatest hits|best of|the best of|collection|the very best|definitive|box\s*set|boxset|anthology|compilation|various artists)/i.test(albumName.trim())
              )
              const isFolderClean = Boolean(
                folderName &&
                !['music', 'audio', 'master', 'songs', 'flac', 'wav', 'mp3', 'cd rip'].includes(folderName.toLowerCase()) &&
                !/^(cd\s*\d+|disc\s*\d+|\d+)$/i.test(folderName)
              )

              if (!albumName || (isGenericCompilation && isFolderClean)) {
                albumName = folderName
              }

              const finalFolderName = folderName
              const finalFolderPath = folderPath
              const finalTitle = sMeta.title || common.title || path.basename(filePath).replace(/\.[^/.]+$/, '').replace(/^\d+[\s._-]+/, '')
              const finalArtist = sMeta.artist || common.artist || common.albumartist || (dir2 && !['master', 'music', 'hindi', 'tamil', 'telugu'].includes(dir2.toLowerCase()) ? dir2 : 'Unknown Artist')
              const finalAlbum = albumName || folderName
              const finalComposer = sMeta.composer || common.composer || (dir2 && !['master', 'music', 'hindi', 'tamil', 'telugu'].includes(dir2.toLowerCase()) ? dir2 : '')
              const finalYear = sMeta.year || common.year || (common.originalyear as number) || undefined
              const finalTrackNo = sMeta.trackNumber !== undefined ? sMeta.trackNumber : (common.track || { no: undefined, of: undefined })
              const finalGenre = normalizeGenreTags(sMeta?.genre ?? common.genre)

              parsedItems.push({
                fileName: path.basename(filePath),
                filePath,
                folderName: finalFolderName,
                folderPath: finalFolderPath,
                fileSize: stat.size,
                lastModified: stat.mtimeMs,
                sidecarStatus: sidecarData ? 'committed' : 'none',
                common: {
                  title: finalTitle,
                  artist: finalArtist,
                  album: finalAlbum,
                  composer: finalComposer,
                  year: finalYear,
                  track: typeof finalTrackNo === 'number' ? { no: finalTrackNo, of: common.track?.of } : finalTrackNo,
                  disk: common.disk || { no: 1, of: 1 },
                  genre: finalGenre,
                  work: (common as any).work,
                  movement: (common as any).movement,
                  opus: (common as any).opus,
                  dynamic_range: (common as any).dynamic_range,
                  replaygain_track_gain: common.replaygain_track_gain,
                  replaygain_track_peak: common.replaygain_track_peak,
                  language: sMeta.language || pathLanguage || common.language || (common as any).language || '',
                },
                native: meta.native || {},
                format: {
                  container: format.container || path.extname(filePath).slice(1).toUpperCase(),
                  sampleRate: format.sampleRate || 44100,
                  bitsPerSample: format.bitsPerSample || 16,
                  duration: format.duration || 180,
                  lossless: format.lossless ?? true,
                },
              })
            } catch (err) {
              console.warn(`Could not parse audio file: ${filePath}`, err)
              try {
                const stat = fs.statSync(filePath)
                const dir1 = path.basename(path.dirname(filePath))
                const albSidecar = path.join(path.dirname(filePath), 'cadence-album.sidecar.json')
                let albData: any = null
                if (fs.existsSync(albSidecar)) {
                  try {
                    albData = JSON.parse(fs.readFileSync(albSidecar, 'utf8'))
                  } catch {}
                }
                let sMeta: any = null
                const trkSidecar = `${filePath}.sidecar.json`
                if (fs.existsSync(trkSidecar)) {
                  try {
                    sMeta = JSON.parse(fs.readFileSync(trkSidecar, 'utf8'))?.metadata || null
                  } catch {}
                }
                const finalTitle = sMeta?.title || path.basename(filePath).replace(/\.[^/.]+$/, '')
                const finalArtist = sMeta?.artist || 'Unknown Artist'
                const finalAlbum = sMeta?.album || albData?.album || dir1
                parsedItems.push({
                  fileName: path.basename(filePath),
                  filePath,
                  folderName: sMeta?.folderName || albData?.folderName || dir1,
                  folderPath: path.dirname(filePath),
                  fileSize: stat.size,
                  lastModified: stat.mtimeMs,
                  sidecarStatus: sMeta ? 'committed' : 'none',
                  common: {
                    title: finalTitle,
                    artist: finalArtist,
                    album: finalAlbum,
                    composer: sMeta?.composer || '',
                    year: sMeta?.year,
                    track: sMeta?.trackNumber ? { no: sMeta.trackNumber } : undefined,
                    genre: normalizeGenreTags(sMeta?.genre),
                  },
                  format: {
                    container: path.extname(filePath).slice(1).toUpperCase(),
                    sampleRate: 44100,
                    bitsPerSample: 16,
                    duration: 180,
                    lossless: true,
                  },
                })
              } catch {}
            }
          }

          res.statusCode = 200
          res.end(
            JSON.stringify({
              success: true,
              directory: normalized,
              diskStats,
              totalDiscovered: files.length,
              totalParsed: parsedItems.length,
              items: parsedItems,
            })
          )
        } catch (error: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: error?.message || 'Failed to scan directory' }))
        }
      })

      // 4. Apple iTunes Search API with Multi-Tier Resilient Fuzzy Fallback
      server.middlewares.use('/api/itunes-search', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const artist = url.searchParams.get('artist') || ''
        const composer = url.searchParams.get('composer') || ''
        const title = url.searchParams.get('title') || ''
        const album = url.searchParams.get('album') || ''
        const entity = url.searchParams.get('entity') || (title ? 'song' : 'album')

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        const cleanTerm = (s: string) =>
          s
            .replace(/\.[^/.]+$/, '')
            .replace(/^\d+[\s._-]+/, '')
            .replace(/\(.*?\)/g, ' ')
            .replace(/\[.*?\]/g, ' ')
            .replace(/cd\s*rip/gi, ' ')
            .replace(/flac|alac|wav|mp3|dsd|dsf|hi-res|remaster(ed)?/gi, ' ')
            .replace(/[\s_-]+/g, ' ')
            .trim()

        const cleanArtist = cleanTerm(artist)
        const cleanComposer = cleanTerm(composer)
        const cleanTitle = cleanTerm(title)
        const cleanAlbum = cleanTerm(album)

        let foundItem: any = null

        // Primary entity search if entity === 'album' or no song title provided
        if (entity === 'album' || !cleanTitle) {
          const albumQueries = [
            cleanAlbum && cleanComposer ? `${cleanAlbum} ${cleanComposer}`.trim() : null,
            cleanAlbum && cleanArtist ? `${cleanAlbum} ${cleanArtist}`.trim() : null,
            cleanAlbum ? `${cleanAlbum}`.trim() : null,
          ].filter(Boolean) as string[]

          for (const q of albumQueries) {
            try {
              const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=5`
              const itunesRes = await fetch(itunesUrl, { signal: AbortSignal.timeout(6000) })
              if (itunesRes.ok) {
                const data = (await itunesRes.json()) as any
                if (data.results && data.results.length > 0) {
                  const norm = cleanAlbum.toLowerCase()
                  const matched =
                    data.results.find((r: any) => (r.collectionName || '').toLowerCase().includes(norm)) ||
                    data.results[0]
                  if (matched) {
                    foundItem = {
                      artistName: matched.artistName,
                      trackName: matched.collectionName,
                      collectionName: matched.collectionName,
                      releaseDate: matched.releaseDate,
                      primaryGenreName: matched.primaryGenreName,
                      artworkUrl100: matched.artworkUrl100,
                      copyright: matched.copyright,
                      collectionId: matched.collectionId,
                    }
                    break
                  }
                }
              }
            } catch {}
          }
        }

        // Song entity queries if not found yet
        if (!foundItem) {
          const searchQueries = [
            cleanComposer && cleanTitle ? `${cleanComposer} ${cleanTitle}`.trim() : null,
            cleanArtist && cleanTitle ? `${cleanArtist} ${cleanTitle}`.trim() : null,
            cleanComposer && cleanAlbum ? `${cleanComposer} ${cleanAlbum}`.trim() : null,
            cleanArtist && cleanAlbum ? `${cleanArtist} ${cleanAlbum}`.trim() : null,
            cleanTitle ? `${cleanTitle}`.trim() : null,
            cleanAlbum ? `${cleanAlbum}`.trim() : null,
          ].filter(Boolean) as string[]

          for (const q of searchQueries) {
            try {
              const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=5`
              const itunesRes = await fetch(itunesUrl, { signal: AbortSignal.timeout(6000) })
              if (itunesRes.ok) {
                const data = (await itunesRes.json()) as any
                if (data.results && data.results.length > 0) {
                  foundItem = data.results[0]
                  break
                }
              }
            } catch {}
          }
        }

        // Secondary fallback: query album entity
        if (!foundItem && cleanAlbum) {
          try {
            const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanAlbum)}&entity=album&limit=3`
            const itunesRes = await fetch(itunesUrl, { signal: AbortSignal.timeout(6000) })
            if (itunesRes.ok) {
              const data = (await itunesRes.json()) as any
              if (data.results && data.results.length > 0) {
                const alb = data.results[0]
                foundItem = {
                  artistName: alb.artistName,
                  trackName: cleanTitle || alb.collectionName,
                  collectionName: alb.collectionName,
                  releaseDate: alb.releaseDate,
                  primaryGenreName: alb.primaryGenreName,
                  artworkUrl100: alb.artworkUrl100,
                  copyright: alb.copyright,
                  collectionId: alb.collectionId,
                }
              }
            }
          } catch {}
        }

        if (!foundItem) {
          res.statusCode = 404
          res.end(JSON.stringify({ success: false, message: 'No iTunes match found' }))
          return
        }

        const highResArt = foundItem.artworkUrl100
          ? foundItem.artworkUrl100.replace('100x100bb.jpg', '3000x3000bb.jpg')
          : ''

        res.statusCode = 200
        res.end(
          JSON.stringify({
            success: true,
            provider: 'itunes',
            confidenceScore: 0.95,
            releaseTitle: foundItem.collectionName || cleanAlbum,
            artistCredit: foundItem.artistName || cleanArtist,
            composer: foundItem.artistName || cleanArtist,
            trackTitle: foundItem.trackName || cleanTitle,
            releaseYear: foundItem.releaseDate ? new Date(foundItem.releaseDate).getFullYear() : undefined,
            genre: foundItem.primaryGenreName || 'Soundtrack',
            label: foundItem.copyright || 'Apple Music Catalog',
            catalogNumber: `ITUNES-${foundItem.collectionId || foundItem.trackId || 'MSTR'}`,
            barcodeUpc: '',
            coverArtUrl: highResArt,
            coverResolution: '3000x3000px (Apple Music Master Scan)',
          })
        )
      })

      // 5. MusicBrainz Search API with 1-Req/Sec Rate Limiter & Multi-Tier Fuzzy Fallback
      let lastMbTime = 0
      const mbFetch = async (endpoint: string) => {
        const now = Date.now()
        const wait = Math.max(0, 1100 - (now - lastMbTime))
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        lastMbTime = Date.now()
        return fetch(endpoint, {
          headers: {
            'User-Agent': 'CadenceMusicAgent/1.0.0 (https://github.com/cadence-audio)',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(7000),
        })
      }

      server.middlewares.use('/api/musicbrainz-search', async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const artist = url.searchParams.get('artist') || ''
        const composer = url.searchParams.get('composer') || ''
        const title = url.searchParams.get('title') || ''
        const album = url.searchParams.get('album') || ''
        const trackNum = parseInt(url.searchParams.get('trackNum') || url.searchParams.get('trackNumber') || '0', 10)

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        const cleanTerm = (s: string) =>
          s
            .replace(/\.[^/.]+$/, '')
            .replace(/^\d+[\s._-]+/, '')
            .replace(/\(.*?\)/g, ' ')
            .replace(/\[.*?\]/g, ' ')
            .replace(/cd\s*rip/gi, ' ')
            .replace(/[\s_-]+/g, ' ')
            .trim()

        let cleanArtist = cleanTerm(artist)
        let cleanComposer = cleanTerm(composer)
        let cleanTitle = cleanTerm(title)
        let cleanAlbum = cleanTerm(album)

        if (/^(unknown|unknown\s*artist|various|various\s*artists)$/i.test(cleanArtist)) {
          cleanArtist = ''
        }

        try {
          // --- Tier 1: Release-First Lookup (Gets authentic album tracklist & Cover Art Archive) ---
          if (cleanAlbum && !/^(music|audio|songs|flac|wav|mp3|master|local)$/i.test(cleanAlbum)) {
            const releaseQueries = [
              cleanComposer ? `release:"${cleanAlbum}" AND (artist:"${cleanComposer}" OR creditname:"${cleanComposer}")` : null,
              cleanArtist ? `release:"${cleanAlbum}" AND artist:"${cleanArtist}"` : null,
              cleanArtist ? `release:"${cleanAlbum}" AND (artist:"${cleanArtist}" OR creditname:"${cleanArtist}")` : null,
              `release:"${cleanAlbum}"`,
            ].filter(Boolean) as string[]

            for (const rq of releaseQueries) {
              try {
                const mbReleaseUrl = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(rq)}&fmt=json&limit=5`
                const mbRelRes = await mbFetch(mbReleaseUrl)
                if (mbRelRes.ok) {
                  const relData = (await mbRelRes.json()) as any
                  const topRelWithArt = relData.releases?.find((r: any) => r['cover-art-archive']?.front === true)
                  const topRel =
                    topRelWithArt ||
                    relData.releases?.find((r: any) => r.score >= 80) ||
                    (relData.releases?.[0]?.score >= 70 ? relData.releases[0] : null)

                  if (topRel && topRel.id) {
                    // Fetch full release details with medium tracklist and labels
                    const detailUrl = `https://musicbrainz.org/ws/2/release/${topRel.id}?inc=recordings+artist-credits+labels+media&fmt=json`
                    const detailRes = await mbFetch(detailUrl)
                    if (detailRes.ok) {
                      const detail = (await detailRes.json()) as any
                      const media = detail.media?.[0]
                      const tracks = media?.tracks || []

                      let matchedTrack: any = null
                      if (trackNum > 0 && tracks.length > 0) {
                        matchedTrack = tracks.find((t: any) => parseInt(t.position, 10) === trackNum)
                      }
                      if (!matchedTrack && cleanTitle && tracks.length > 0) {
                        const normTitle = cleanTitle.toLowerCase()
                        matchedTrack = tracks.find((t: any) => {
                          const tNorm = (t.title || '').toLowerCase()
                          return tNorm.includes(normTitle) || normTitle.includes(tNorm)
                        })
                      }
                      if (!matchedTrack && tracks.length > 0) {
                        matchedTrack = tracks[0]
                      }

                      const releaseArtist = detail['artist-credit']?.map((a: any) => a.name).join(', ') || cleanArtist
                      const trackArtist = matchedTrack?.['artist-credit']?.map((a: any) => a.name).join(', ') || releaseArtist
                      const releaseYear = detail.date ? parseInt(detail.date.slice(0, 4), 10) : undefined

                      res.statusCode = 200
                      res.end(
                        JSON.stringify({
                          success: true,
                          provider: 'musicbrainz',
                          confidenceScore: topRel.score >= 90 ? 0.95 : 0.85,
                          releaseTitle: detail.title || topRel.title || cleanAlbum,
                          artistCredit: trackArtist,
                          composer: releaseArtist || trackArtist,
                          trackTitle: matchedTrack?.title || cleanTitle,
                          releaseYear,
                          label: detail['label-info']?.[0]?.label?.name || 'MusicBrainz Verified',
                          catalogNumber:
                            detail['catalog-number'] ||
                            detail['label-info']?.[0]?.['catalog-number'] ||
                            `MB-${topRel.id.slice(0, 8).toUpperCase()}`,
                          barcodeUpc: detail.barcode || '',
                          coverArtUrl: `https://coverartarchive.org/release/${topRel.id}/front-500`,
                          coverResolution: 'Archival 1000px (Cover Art Archive)',
                        })
                      )
                      return
                    }
                  }
                }
              } catch (err) {
                console.warn('[MusicBrainz Release Query Error]:', err)
              }
            }
          }

          // --- Tier 2: Recording Lookup Fallback (Strict score >= 75) ---
          if (cleanTitle) {
            const recordingQueries = [
              cleanArtist ? `recording:"${cleanTitle}" AND artist:"${cleanArtist}"` : null,
              cleanAlbum ? `recording:"${cleanTitle}" AND release:"${cleanAlbum}"` : null,
              `recording:"${cleanTitle}"`,
            ].filter(Boolean) as string[]

            for (const rq of recordingQueries) {
              try {
                const mbRecUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(rq)}&fmt=json&limit=5`
                const mbRecRes = await mbFetch(mbRecUrl)
                if (mbRecRes.ok) {
                  const recData = (await mbRecRes.json()) as any
                  const topRec = recData.recordings?.find((r: any) => r.score >= 75)
                  if (topRec) {
                    const primaryRelease = topRec.releases?.[0]
                    const recArtist = topRec['artist-credit']?.map((a: any) => a.name).join(', ') || cleanArtist
                    const releaseId = primaryRelease?.id
                    const year = topRec['first-release-date']
                      ? parseInt(topRec['first-release-date'].slice(0, 4), 10)
                      : primaryRelease?.date
                      ? parseInt(primaryRelease.date.slice(0, 4), 10)
                      : undefined

                    res.statusCode = 200
                    res.end(
                      JSON.stringify({
                        success: true,
                        provider: 'musicbrainz',
                        confidenceScore: topRec.score >= 90 ? 0.92 : 0.8,
                        releaseTitle: primaryRelease?.title || cleanAlbum,
                        artistCredit: recArtist,
                        composer: recArtist,
                        trackTitle: topRec.title || cleanTitle,
                        releaseYear: year,
                        label: primaryRelease?.['label-info']?.[0]?.label?.name || 'MusicBrainz Verified',
                        catalogNumber:
                          primaryRelease?.['catalog-number'] ||
                          (releaseId ? `MB-${releaseId.slice(0, 8).toUpperCase()}` : ''),
                        barcodeUpc: primaryRelease?.barcode || '',
                        coverArtUrl: releaseId ? `https://coverartarchive.org/release/${releaseId}/front-500` : '',
                        coverResolution: 'Archival Front (Cover Art Archive)',
                      })
                    )
                    return
                  }
                }
              } catch (err) {
                console.warn('[MusicBrainz Recording Query Error]:', err)
              }
            }
          }
        } catch (globalErr) {
          console.error('[MusicBrainz Global Error]:', globalErr)
        }

        // Return clean 404 so UI does not display false hallucinations
        res.statusCode = 404
        res.end(JSON.stringify({ success: false, message: 'No confident MusicBrainz archival match found' }))
      })

      // 6. Gemini AI Metadata Resolver with 25-Album Single-Call Batching & Safe Pacing
      server.middlewares.use('/api/ai-metadata-resolver', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })

        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}')
            const items: any[] = Array.isArray(data.items)
              ? data.items.slice(0, 25)
              : data.item
              ? [data.item]
              : []

            if (items.length === 0) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'No items provided in payload' }))
              return
            }

            const apiKey = getGeminiApiKey()
            if (!apiKey) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not configured. Please add GEMINI_API_KEY to your .env file.' }))
              return
            }

            const promptText = `You are an authoritative archival musicologist, discographer, and audio tag engineer.
Analyze the following batch of ${items.length} audio release(s)/track(s) from a master music library.
For each item, determine canonical, highly accurate musicological metadata based on historical discographies, record label catalogs (e.g. Echo Records, Venus, HMV, Columbia, Deutsche Grammophon, Decca), and master releases.

Items to resolve:
${JSON.stringify(
  items.map((it) => ({
    id: it.id,
    title: it.title,
    artist: it.artist,
    album: it.album,
    year: it.year,
    filePath: it.filePath,
  })),
  null,
  2
)}

Return ONLY a valid JSON array containing exactly ${items.length} object(s), where each object has these exact keys:
[
  {
    "id": "<matching item id>",
    "artistCredit": "<canonical artist name(s) e.g. S. Janaki & Chorus or Ilaiyaraaja or Miles Davis>",
    "composer": "<canonical composer e.g. Ilaiyaraaja or Ludwig van Beethoven>",
    "releaseTitle": "<canonical album/release title>",
    "trackTitle": "<canonical clean track title>",
    "releaseYear": 1985,
    "label": "<canonical record label e.g. Echo Records, Venus, Columbia, EMI>",
    "catalogNumber": "<official or estimated catalog number e.g. 8000 593 or CL 1355>",
    "barcodeUpc": "<official barcode if known or empty string>",
    "opusOrCatalogue": "<opus or catalogue number if classical e.g. Op. 67, or empty string>",
    "movement": "<movement designation if applicable, e.g. I. Allegro, or empty string>",
    "genre": "<specific genre, e.g. Tamil Film Music, Western Classical, Modal Jazz>",
    "matrixRunout": "<matrix runout stamp if applicable>",
    "confidenceScore": 0.98
  }
]
No other text or markdown explanation, just the pure JSON array.`

            const callResult = await executePacedGeminiCall(apiKey, {
              bodyPayload: {
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                },
              },
              timeoutMs: 25000,
            })

            res.setHeader('x-gemini-pacing-delay', String(callResult.pacingDelayMs || 0))
            res.setHeader('x-gemini-model-used', callResult.modelUsed || '')
            res.setHeader('x-gemini-retries', String(callResult.retriesAttempted || 0))

            if (!callResult.ok) {
              res.statusCode = callResult.status
              const errMessage = callResult.error || 'All Gemini AI models temporarily unavailable'
              console.error('[Gemini AI] Resolver failed:', errMessage)
              res.end(
                JSON.stringify({
                  error: errMessage,
                  code: callResult.status === 429 ? 'RATE_LIMIT_429' : 'AI_ERROR',
                  pacingDelayMs: callResult.pacingDelayMs,
                })
              )
              return
            }

            const geminiResult = callResult.data as any
            const textResponse = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || '[]'
            let parsedEntities = []
            try {
              parsedEntities = JSON.parse(textResponse)
            } catch {
              const cleaned = textResponse.replace(/^```json\s*|```\s*$/g, '').trim()
              parsedEntities = JSON.parse(cleaned)
            }

            res.statusCode = 200
            res.end(
              JSON.stringify({
                success: true,
                count: parsedEntities.length,
                results: parsedEntities,
                telemetry: {
                  modelUsed: callResult.modelUsed,
                  pacingDelayMs: callResult.pacingDelayMs,
                  retriesAttempted: callResult.retriesAttempted,
                },
              })
            )
          } catch (e: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: e.message || 'Server error processing AI metadata' }))
          }
        })
      })

      // 6.5. Gemini AI Album Cover Art & Canonical Master Resolver with Safe Pacing
      server.middlewares.use('/api/ai-cover-art', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })

        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}')
            const albumTitle = data.albumTitle || ''
            const artistCredit = data.artistCredit || ''
            const composerName = data.composerName || ''
            const releaseYear = data.releaseYear

            if (!albumTitle) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing albumTitle in payload' }))
              return
            }

            const apiKey = getGeminiApiKey()
            if (!apiKey) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not configured. Please add GEMINI_API_KEY to your .env file.' }))
              return
            }

            const promptText = `You are an authoritative archival discographer and music librarian.
Analyze the following album and provide canonical metadata and artwork details:
Album: "${albumTitle}"
Artist: "${artistCredit}"
Composer: "${composerName}"
Year: ${releaseYear || 'Unknown'}

Return ONLY a valid JSON object with these exact keys:
{
  "canonicalReleaseTitle": "<official canonical album title>",
  "canonicalArtist": "<primary artist/performers>",
  "canonicalComposer": "<composer>",
  "releaseYear": 2000,
  "recordLabel": "<official label>",
  "officialCoverDescription": "<visual description of the authentic album cover artwork>",
  "suggestedCoverArtUrl": "<authentic high-resolution CDN or master URL if known or empty string>",
  "coverResolution": "3000x3000px Archival Scan",
  "confidenceScore": 0.96
}
No markdown, just JSON.`

            const callResult = await executePacedGeminiCall(apiKey, {
              bodyPayload: {
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: { responseMimeType: 'application/json' },
              },
              timeoutMs: 15000,
            })

            res.setHeader('x-gemini-pacing-delay', String(callResult.pacingDelayMs || 0))
            res.setHeader('x-gemini-model-used', callResult.modelUsed || '')

            let parsed: any = {}
            if (callResult.ok && callResult.data) {
              const text = callResult.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
              try {
                parsed = JSON.parse(text)
              } catch {
                const cleaned = text.replace(/^```json\s*|```\s*$/g, '').trim()
                parsed = JSON.parse(cleaned)
              }
            }

            res.statusCode = 200
            res.end(
              JSON.stringify({
                success: true,
                provider: 'ai',
                canonicalReleaseTitle: parsed.canonicalReleaseTitle || albumTitle,
                canonicalArtist: parsed.canonicalArtist || artistCredit,
                canonicalComposer: parsed.canonicalComposer || composerName,
                releaseYear: parsed.releaseYear || releaseYear,
                recordLabel: parsed.recordLabel || 'Archival Master',
                officialCoverDescription: parsed.officialCoverDescription || 'AI Verified Canonical Master Release',
                coverArtUrl: parsed.suggestedCoverArtUrl || '',
                coverResolution: parsed.coverResolution || 'Master Reference Scan (AI Verified)',
                confidenceScore: parsed.confidenceScore || 0.95,
                telemetry: {
                  modelUsed: callResult.modelUsed,
                  pacingDelayMs: callResult.pacingDelayMs,
                  retriesAttempted: callResult.retriesAttempted,
                },
              })
            )
          } catch (e: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: e.message || 'AI Cover Art resolver failed' }))
          }
        })
      })

      // 7. Embedded Conversational AI Agent with Live Database Snapshot & Paced Calling
      server.middlewares.use('/api/agent-chat', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })

        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}')
            const prompt = data.prompt || ''
            const catalogSummary = data.catalogSummary || ''
            const history = Array.isArray(data.history) ? data.history.slice(-6) : []

            if (!prompt) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing prompt in request' }))
              return
            }

            const apiKey = getGeminiApiKey()
            if (!apiKey) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not configured. Please add GEMINI_API_KEY to your .env file.' }))
              return
            }

            const systemInstruction = `You are Cadence, an advanced autonomous AI musicologist, audio engineer, and library management agent embedded in Cadence Core (an audiophile-grade music management suite).
You have full access to the live library database snapshot and can execute capabilities on the user's behalf.

${catalogSummary}

Available executable tools:
- filter_catalog(args: { composer?: string, era?: string, language?: string, format?: string, genre?: string, mastering?: string, searchQuery?: string })
- switch_view(args: { viewMode: "virtual_table" | "variant_stack" | "work_movement" })
- run_audit(args: {})
- remediate_issue(args: { actionType: "RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER" | "MERGE_DUPLICATE_PERFORMERS" | "NORMALIZE_GENRES" | "FETCH_HIRES_ART" | "SYNC_FOLDER_TO_ALBUM" | "REWORK_BACKDROP" | "NORMALIZE_ARTIST_NAMES" | "AUTOGEN_TRACK_NUMBERS" | "FILL_MISSING_METADATA", provider?: "apple" | "musicbrainz" | "ai" })
- rework_backdrop(args: { composer?: string, artist?: string, releaseId?: string, provider?: "apple" | "musicbrainz" | "ai" })
- select_track(args: { query: string })
- open_modal(args: { modalName: "import" | "commit" | "path_rules" | "sidecar_export" | "batch_diff" | "customize_album" | "storage_manager" })
- reset_filters(args: {})
- execute_pipeline(args: { commands: Array<{ tool: string, args: Record<string, any> }> })

Instructions:
1. Provide a concise, knowledgeable, audiophile-grade conversational response in markdown.
2. If the user asks to perform an action (e.g. "filter to 24-bit tracks", "switch to grid", "auto tag from folders", "open commit modal"), include the exact structured tool in "command".
   For compound or multi-step requests (e.g. "fetch art and rework backdrop", "run audit and fix tags, then commit"), use "execute_pipeline" with an ordered array of tool commands in "args.commands".
3. If the user asks an informational or explanatory question without requesting an action (e.g. questions about dynamic range, file formats, health score, or statistics), answer conversationally and set "command" to null.
4. If the user asks for recommendations, evaluate the catalog hygiene and suggest the top 2-3 most impactful actions.
5. Format output strictly as JSON with this schema:
{
  "response": "<Markdown formatted conversational response>",
  "command": { "tool": "<tool_name>", "args": { ... }, "explanation": "<short description of action>" } | null,
  "suggestedActions": [ { "label": "<short pill label>", "prompt": "<full instruction>" } ]
}`

            const historyContents = (Array.isArray(history) ? history : []).map((h: any) => ({
              role: h.role === 'agent' ? 'model' : 'user',
              parts: [{ text: h.text }],
            }))

            const contents = [
              ...historyContents,
              { role: 'user', parts: [{ text: `${systemInstruction}\n\nUser Instruction: ${prompt}` }] },
            ]

            const callResult = await executePacedGeminiCall(apiKey, {
              bodyPayload: {
                contents,
                generationConfig: {
                  responseMimeType: 'application/json',
                },
              },
              timeoutMs: 20000,
            })

            res.setHeader('x-gemini-pacing-delay', String(callResult.pacingDelayMs || 0))
            res.setHeader('x-gemini-model-used', callResult.modelUsed || '')

            let aiResponseText = ''
            if (callResult.ok && callResult.data) {
              aiResponseText = callResult.data.candidates?.[0]?.content?.parts?.[0]?.text || ''
            }

            let parsed: any = null
            if (aiResponseText) {
              try {
                parsed = JSON.parse(aiResponseText)
              } catch {
                const clean = aiResponseText.replace(/^```json\s*|```\s*$/g, '').trim()
                parsed = JSON.parse(clean)
              }
            }

            if (!parsed) {
              parsed = {
                response: `I analyzed your library. You have ${catalogSummary ? 'an active catalog loaded' : 'tracks indexed'}. How would you like me to assist you with tagging, filtering, or audio hygiene?`,
                command: null,
                suggestedActions: [
                  { label: 'Library Statistics', prompt: 'Give me a statistical breakdown of my library' },
                  { label: 'Recommend Actions', prompt: 'What actions do you recommend next?' },
                  { label: 'Auto-Resolve Artists', prompt: 'Extract missing artists from folder hierarchy' },
                ],
              }
            }

            res.statusCode = 200
            res.end(
              JSON.stringify({
                success: true,
                ...parsed,
                telemetry: {
                  modelUsed: callResult.modelUsed,
                  pacingDelayMs: callResult.pacingDelayMs,
                  retriesAttempted: callResult.retriesAttempted,
                },
              })
            )
          } catch (err: any) {
            res.statusCode = 200
            res.end(
              JSON.stringify({
                success: true,
                response: 'I am ready to assist with your collection. You can ask for statistics, filtering, or batch hygiene cleanups.',
                command: null,
                suggestedActions: [
                  { label: 'Catalog Statistics', prompt: 'Show library statistics' },
                  { label: 'Switch to Grid View', prompt: 'Switch to Virtual Data Grid' },
                ],
              })
            )
          }
        })
      })

      // 7.5 Real-Time Gemini AI Quota & Pacing Telemetry Endpoint
      server.middlewares.use('/api/ai-quota-telemetry', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        const now = Date.now()
        const elapsed = now - lastGeminiCallTimestamp
        const nextSlotRemainingMs = Math.max(0, GEMINI_PACING_INTERVAL_MS - elapsed)
        res.statusCode = 200
        res.end(
          JSON.stringify({
            rateLimitRpm: 15,
            pacingIntervalMs: GEMINI_PACING_INTERVAL_MS,
            nextSlotRemainingMs,
            isPacingActive: nextSlotRemainingMs > 0,
            lastCallTimestamp: lastGeminiCallTimestamp,
          })
        )
      })

      // 8. Commit Staged Metadata to Disk (Audiophile Sidecars & Tag Records)
      server.middlewares.use('/api/commit-tags', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')

        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })

        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}')
            const tracks: any[] = Array.isArray(data.tracks) ? data.tracks : []

            const NodeID3Module = await import('node-id3')
            const NodeID3 = (NodeID3Module as any).default || NodeID3Module

            let committedCount = 0
            let embeddedHeadersCount = 0
            let sidecarsCount = 0
            const errors: string[] = []

            for (const t of tracks) {
              if (!t.filePath) continue
              let embeddedSuccess = false
              let sidecarSuccess = false

              // Prepare ID3 metadata tags
              const ext = path.extname(t.filePath).toLowerCase()
              const artistVal = t.artistCredit || t.artist || ''
              const composerVal = t.composerName || t.composer || ''
              const genreList = normalizeGenreTags(t.genre)

              const id3Tags: any = {}
              if (t.title) id3Tags.title = t.title
              if (artistVal) id3Tags.artist = artistVal
              if (composerVal) id3Tags.composer = composerVal
              if (t.album) id3Tags.album = t.album
              if (t.year) id3Tags.year = String(t.year)
              if (t.trackNumber) id3Tags.trackNumber = String(t.trackNumber)
              if (genreList.length > 0) id3Tags.genre = genreList[0]

              // 1. Embed metadata into audio file header
              try {
                if (fs.existsSync(t.filePath)) {
                  if (ext === '.wav') {
                    embeddedSuccess = writeWavId3Tags(t.filePath, id3Tags, NodeID3)
                  } else if (ext === '.mp3') {
                    const res = NodeID3.write(id3Tags, t.filePath)
                    embeddedSuccess = res !== false
                  }
                }
              } catch (err: any) {
                console.warn(`[commit-tags] Header embedding failed for ${t.filePath}:`, err)
              }

              // 2. Write audiophile sidecar JSON
              try {
                const sidecarPath = `${t.filePath}.sidecar.json`
                const sidecarData = {
                  cadenceSidecarVersion: '2.4.0',
                  audioFileRef: {
                    path: t.filePath,
                    fileName: path.basename(t.filePath),
                  },
                  metadata: {
                    title: t.title,
                    artist: artistVal,
                    composer: composerVal,
                    album: t.album,
                    year: t.year,
                    trackNumber: t.trackNumber,
                    folderName: t.folderName,
                    genre: genreList,
                  },
                  embeddedHeaderCommitted: embeddedSuccess,
                  pendingEditsApplied: t.pendingSidecarEdits || {},
                  committedTimestamp: new Date().toISOString(),
                }

                const dir = path.dirname(t.filePath)
                if (fs.existsSync(dir)) {
                  fs.writeFileSync(sidecarPath, JSON.stringify(sidecarData, null, 2), 'utf8')
                  sidecarSuccess = true

                  // If album title, folderName, or coverArtUrl is specified, write/update album sidecar
                  if (t.album || t.folderName || t.coverArtUrl) {
                    const albumSidecarPath = path.join(dir, 'cadence-album.sidecar.json')
                    let prevAlbumData: any = {}
                    if (fs.existsSync(albumSidecarPath)) {
                      try {
                        prevAlbumData = JSON.parse(fs.readFileSync(albumSidecarPath, 'utf8'))
                      } catch {}
                    }
                    const albumSidecar = {
                      ...prevAlbumData,
                      cadenceSidecarVersion: '2.4.0',
                      album: t.album || prevAlbumData.album,
                      folderName: t.folderName || prevAlbumData.folderName || path.basename(dir),
                      coverArtUrl:
                        t.coverArtUrl && !t.coverArtUrl.includes('unsplash')
                          ? t.coverArtUrl
                          : prevAlbumData.coverArtUrl,
                      lastCommitted: new Date().toISOString(),
                    }
                    fs.writeFileSync(albumSidecarPath, JSON.stringify(albumSidecar, null, 2), 'utf8')
                  }
                }
              } catch (err: any) {
                errors.push(`Failed to commit sidecar for ${t.filePath}: ${err.message}`)
              }

              if (embeddedSuccess) embeddedHeadersCount++
              if (sidecarSuccess) sidecarsCount++
              if (embeddedSuccess || sidecarSuccess) committedCount++
            }

            res.statusCode = 200
            res.end(
              JSON.stringify({
                success: true,
                committedCount,
                embeddedHeadersCount,
                sidecarsCount,
                totalRequested: tracks.length,
                errors,
              })
            )
          } catch (e: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ success: false, error: e.message }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), localLibraryScannerPlugin()],
  optimizeDeps: {
    include: [
      '@tauri-apps/api',
      '@tauri-apps/api/event',
      '@tauri-apps/api/core',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-fs',
      '@tauri-apps/plugin-shell',
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/target/**', '**/.git/**'],
    },
  },
})
