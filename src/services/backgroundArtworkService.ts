/**
 * Cadence Background Artwork Enrichment Service
 * 
 * Transport-pure, non-blocking background artwork resolution service.
 * - Subscribes to AudioEngine playback state: halts instantly and tears down open sockets when audio streams.
 * - Enforces 30-second cooldown timer when playback ceases (Paused or Stopped) before resuming background lookups.
 * - Paces queries (500ms floor) to eliminate network PHY EMI/RFI bursts.
 * - Staged incrementally into graphEngine uncommitted sidecars.
 * - Debounces SQLite / IndexedDB checkpoints every 10 albums or upon pause/cancel/finish.
 */

import { graphEngine } from '../core/graphEngine'
import { federatedResolversService } from './federatedResolvers'
import { tauriBridge, PortraitSyncProgressPayload } from './tauriBridge'

export type BackgroundArtworkStatus =
  | 'idle'
  | 'active'
  | 'cooldown'
  | 'suspended_playback'
  | 'user_paused'
  | 'complete'

export interface BackgroundArtworkState {
  status: BackgroundArtworkStatus
  completed: number
  total: number
  pending: number
  cooldownRemainingSecs?: number
  currentReleaseId?: string
  currentAlbumTitle?: string
  lastResolvedTitle?: string
  lastResolvedUrl?: string
  lastProviderLabel?: string
  updatedCount: number
}

interface PendingAlbumJob {
  releaseId: string
  albumTitle: string
  artistCredit: string
  composerName: string
  releaseYear?: number
  preferredProvider: 'apple' | 'musicbrainz' | 'ai'
}

type Listener = (state: BackgroundArtworkState) => void

class BackgroundArtworkService {
  private queue: PendingAlbumJob[] = []
  private totalInBatch: number = 0
  private completedInBatch: number = 0
  private updatedCount: number = 0
  private currentJob: PendingAlbumJob | null = null
  private currentAbortController: AbortController | null = null

  private status: BackgroundArtworkStatus = 'idle'
  private cooldownRemainingSecs: number = 0
  private cooldownTimer: any = null
  private loopRunning: boolean = false
  private activeRunId: number = 0
  private userPaused: boolean = false
  private pacingDelayMs: number = 500

  private isAudioPlaying: boolean = false
  private isAudioPaused: boolean = false
  private lastAudioActivity: number = 0

  private uncheckpointedCount: number = 0
  private checkpointHandler: (() => Promise<void>) | null = null
  private listeners: Set<Listener> = new Set()
  private initialized: boolean = false
  private unlistenPortraitWorker: (() => void) | null = null
  private pollInterval: any = null

  private lastResolvedTitle?: string
  private lastResolvedUrl?: string
  private lastProviderLabel?: string

  public init() {
    if (this.initialized) return
    this.initialized = true

    // 1. Initial check of playback status
    this.checkPlaybackStatus()

    // 2. Event-driven push from Rust worker
    tauriBridge
      .onPortraitSyncProgress((payload: PortraitSyncProgressPayload) => {
        this.handleRustWorkerEvent(payload)
      })
      .then((unlisten) => {
        this.unlistenPortraitWorker = unlisten
      })
      .catch(() => {})

    // 3. Fallback slow poll (every 3s) for audio engine transport status
    this.pollInterval = setInterval(() => {
      this.checkPlaybackStatus()
    }, 3000)
  }

  public setCheckpointHandler(handler: () => Promise<void>) {
    this.checkpointHandler = handler
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  public getState(): BackgroundArtworkState {
    return {
      status: this.status,
      completed: this.completedInBatch,
      total: this.totalInBatch,
      pending: this.queue.length + (this.currentJob ? 1 : 0),
      cooldownRemainingSecs: this.cooldownRemainingSecs > 0 ? this.cooldownRemainingSecs : undefined,
      currentReleaseId: this.currentJob?.releaseId,
      currentAlbumTitle: this.currentJob?.albumTitle,
      lastResolvedTitle: this.lastResolvedTitle,
      lastResolvedUrl: this.lastResolvedUrl,
      lastProviderLabel: this.lastProviderLabel,
      updatedCount: this.updatedCount,
    }
  }

  private notify() {
    const s = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(s)
      } catch (err) {
        console.error('[BackgroundArtwork] Listener error:', err)
      }
    }
  }

  /**
   * Directly notify audio engine playback state changes from AudioPlayerContext.
   */
  public notifyPlaybackState(isPlaying: boolean, isPaused: boolean) {
    const prevPlaying = this.isAudioPlaying
    this.isAudioPlaying = isPlaying
    this.isAudioPaused = isPaused

    if (isPlaying) {
      this.lastAudioActivity = Date.now()
      this.stopCooldownTimer()

      // Transport Purity: Hard halt and immediately abort in-flight HTTP request
      if (this.currentAbortController) {
        this.currentAbortController.abort('AudioEngine playback started: Transport Purity Lock')
        this.currentAbortController = null
      }

      if (this.status !== 'idle' && this.status !== 'complete' && !this.userPaused) {
        this.status = 'suspended_playback'
        this.notify()
        this.flushCheckpoint().catch(() => {})
      }
    } else {
      // Audio is no longer playing (either paused or stopped)
      if (prevPlaying) {
        this.lastAudioActivity = Date.now()
        if (this.queue.length > 0 && !this.userPaused) {
          this.startCooldown(30)
        }
      }
    }
  }

  private async checkPlaybackStatus() {
    try {
      const status = await tauriBridge.getPlaybackStatus()
      if (status) {
        this.notifyPlaybackState(Boolean(status.isPlaying), Boolean(status.isPaused))
      }
    } catch {}
  }

  private handleRustWorkerEvent(payload: PortraitSyncProgressPayload) {
    if (payload.state === 'paused_playback') {
      this.notifyPlaybackState(true, false)
    } else if (payload.state === 'cooldown') {
      if (this.isAudioPlaying) {
        this.isAudioPlaying = false
      }
      if (this.queue.length > 0 && !this.userPaused && this.status !== 'cooldown') {
        const secs = payload.cooldownRemainingSecs ?? 30
        this.startCooldown(secs)
      }
    } else if (payload.state === 'active') {
      if (this.isAudioPlaying) {
        this.isAudioPlaying = false
      }
      if (this.status === 'cooldown' || this.status === 'suspended_playback') {
        this.stopCooldownTimer()
        if (this.queue.length > 0 && !this.userPaused) {
          this.status = 'active'
          this.notify()
          this.runLoop()
        }
      }
    }
  }

  private startCooldown(seconds: number) {
    this.stopCooldownTimer()
    this.status = 'cooldown'
    this.cooldownRemainingSecs = Math.max(1, seconds)
    this.notify()

    this.cooldownTimer = setInterval(() => {
      this.cooldownRemainingSecs -= 1
      if (this.cooldownRemainingSecs <= 0) {
        this.stopCooldownTimer()
        if (!this.isAudioPlaying && !this.userPaused && this.queue.length > 0) {
          this.status = 'active'
          this.notify()
          this.runLoop()
        } else if (this.queue.length === 0) {
          this.status = 'complete'
          this.notify()
        }
      } else {
        this.notify()
      }
    }, 1000)
  }

  private stopCooldownTimer() {
    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer)
      this.cooldownTimer = null
    }
    this.cooldownRemainingSecs = 0
  }

  /**
   * Start or enqueue artwork resolution for specified release IDs (or all releases needing artwork).
   */
  public async start(options?: {
    releaseIds?: string[]
    preferredProvider?: 'apple' | 'musicbrainz' | 'ai'
  }) {
    this.init()
    const provider = options?.preferredProvider || 'apple'

    // Gather candidate releases that lack archival art
    const allReleases = graphEngine.getAllReleases()
    const targetReleases = (
      options?.releaseIds && options.releaseIds.length > 0
        ? options.releaseIds.map((id) => allReleases.find((r) => r.id === id)).filter(Boolean)
        : allReleases.filter(
            (r) =>
              r.artwork?.isLowRes ||
              !r.artwork?.frontCoverUrl ||
              !r.artwork?.width ||
              r.artwork.width < 800 ||
              r.artwork.resolution === 'No Embedded Art' ||
              r.artwork.resolution.includes('Low-Res')
          )
    ) as typeof allReleases

    // Deduplicate against existing queue
    const existingQueueIds = new Set(this.queue.map((j) => j.releaseId))
    if (this.currentJob) existingQueueIds.add(this.currentJob.releaseId)

    const newJobs: PendingAlbumJob[] = []
    for (const rel of targetReleases) {
      if (existingQueueIds.has(rel.id)) continue

      const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === rel.id)
      const sample = relTracks[0]
      const title = rel.title || sample?.folderName || sample?.title || ''
      if (!title) continue

      newJobs.push({
        releaseId: rel.id,
        albumTitle: title,
        artistCredit: rel.artistCredit || sample?.artistCredit || '',
        composerName: rel.composerName || sample?.composerName || '',
        releaseYear: rel.releaseYear,
        preferredProvider: provider,
      })
    }

    if (newJobs.length === 0 && this.queue.length === 0 && !this.currentJob) {
      this.status = 'complete'
      this.notify()
      return
    }

    if (this.status === 'idle' || this.status === 'complete') {
      this.completedInBatch = 0
    }

    this.queue.push(...newJobs)
    this.totalInBatch = this.completedInBatch + this.queue.length + (this.currentJob ? 1 : 0)
    this.userPaused = false

    // If audio is actively playing, set status to suspended_playback
    if (this.isAudioPlaying) {
      this.status = 'suspended_playback'
      this.notify()
      return
    }

    // Check if 30-second cooldown is required after recent playback
    const elapsedSinceAudio = Date.now() - this.lastAudioActivity
    if (this.lastAudioActivity > 0 && elapsedSinceAudio < 30000) {
      const remainingSecs = Math.ceil((30000 - elapsedSinceAudio) / 1000)
      this.startCooldown(remainingSecs)
      return
    }

    this.status = 'active'
    this.notify()
    this.runLoop()
  }

  public pause() {
    this.userPaused = true
    this.status = 'user_paused'
    this.stopCooldownTimer()
    if (this.currentAbortController) {
      this.currentAbortController.abort('User paused artwork enrichment')
      this.currentAbortController = null
    }
    this.notify()
    this.flushCheckpoint().catch(() => {})
  }

  public resume() {
    if (this.queue.length === 0 && !this.currentJob) {
      this.status = 'complete'
      this.notify()
      return
    }

    this.userPaused = false
    if (this.isAudioPlaying) {
      this.status = 'suspended_playback'
      this.notify()
      return
    }

    const elapsed = Date.now() - this.lastAudioActivity
    if (this.lastAudioActivity > 0 && elapsed < 30000) {
      this.startCooldown(Math.ceil((30000 - elapsed) / 1000))
      return
    }

    this.status = 'active'
    this.notify()
    this.runLoop()
  }

  public cancel() {
    this.activeRunId++
    this.userPaused = false
    this.queue = []
    this.completedInBatch = 0
    this.totalInBatch = 0
    this.stopCooldownTimer()
    if (this.currentAbortController) {
      this.currentAbortController.abort('Artwork enrichment cancelled by user')
      this.currentAbortController = null
    }
    this.currentJob = null
    this.status = 'idle'
    this.notify()
    this.flushCheckpoint().catch(() => {})
  }

  public setPacingDelayForTesting(ms: number) {
    this.pacingDelayMs = ms
  }

  public resetTransportStateForTesting() {
    this.activeRunId++
    this.lastAudioActivity = 0
    this.isAudioPlaying = false
    this.isAudioPaused = false
    this.stopCooldownTimer()
    if (this.currentAbortController) {
      this.currentAbortController.abort('Reset for testing')
      this.currentAbortController = null
    }
    this.loopRunning = false
    this.status = 'idle'
    this.completedInBatch = 0
    this.totalInBatch = 0
    this.uncheckpointedCount = 0
    this.queue = []
    this.currentJob = null
  }

  private async flushCheckpoint() {
    if (this.uncheckpointedCount === 0) return
    this.uncheckpointedCount = 0
    if (this.checkpointHandler) {
      try {
        await this.checkpointHandler()
      } catch (err) {
        console.warn('[BackgroundArtwork] Checkpoint error:', err)
      }
    }
  }

  private async runLoop() {
    if (this.loopRunning) return
    this.loopRunning = true
    const currentRunId = ++this.activeRunId

    try {
      while (this.queue.length > 0) {
        if (this.activeRunId !== currentRunId) break

        // Transport Check 1: Halt if user paused
        if (this.userPaused) {
          this.status = 'user_paused'
          this.notify()
          break
        }

        // Transport Check 2: Halt if audio playback is active
        if (this.isAudioPlaying) {
          this.status = 'suspended_playback'
          this.notify()
          break
        }

        // Transport Check 3: Wait if cooldown is active
        if (this.cooldownRemainingSecs > 0) {
          this.status = 'cooldown'
          this.notify()
          break
        }

        const job = this.queue.shift()
        if (!job) break

        this.currentJob = job
        this.currentAbortController = new AbortController()
        const signal = this.currentAbortController.signal

        this.notify()

        try {
          // 1. Query preferred provider
          let candidate = await federatedResolversService.fetchAlbumArtworkCandidate({
            albumTitle: job.albumTitle,
            artistCredit: job.artistCredit,
            composerName: job.composerName,
            releaseYear: job.releaseYear,
            provider: job.preferredProvider,
            signal,
          })

          // 2. Query fallback hierarchy if preferred provider didn't return art
          if (!candidate?.coverArtUrl && !signal.aborted) {
            const fallbacks: ('apple' | 'musicbrainz' | 'ai')[] = (['apple', 'musicbrainz', 'ai'] as const).filter(
              (p) => p !== job.preferredProvider
            )
            for (const fb of fallbacks) {
              if (signal.aborted || this.isAudioPlaying || this.userPaused) break
              candidate = await federatedResolversService.fetchAlbumArtworkCandidate({
                albumTitle: job.albumTitle,
                artistCredit: job.artistCredit,
                composerName: job.composerName,
                releaseYear: job.releaseYear,
                provider: fb,
                signal,
              })
              if (candidate?.coverArtUrl) break
            }
          }

          // If aborted due to playback or user action, re-queue and exit loop
          if (signal.aborted) {
            if (this.status !== 'idle') {
              this.queue.unshift(job)
            }
            this.currentJob = null
            this.currentAbortController = null
            break
          }

          // Stage resolved candidate in graphEngine
          if (candidate?.coverArtUrl && candidate.coverArtUrl.startsWith('http')) {
            const rel = graphEngine.getReleaseById(job.releaseId)
            if (rel) {
              if (!rel.artwork) {
                rel.artwork = {
                  frontCoverUrl: candidate.coverArtUrl,
                  resolution: candidate.coverResolution || '3000×3000px (Apple Music Master Scan)',
                  width: 3000,
                  height: 3000,
                  dpi: 300,
                  colorProfile: 'sRGB',
                  isLowRes: false,
                  hasBookletPdf: false,
                }
              } else {
                if (!rel.artwork.originalFrontCoverUrl) {
                  rel.artwork.originalFrontCoverUrl = rel.artwork.frontCoverUrl
                }
                rel.artwork.frontCoverUrl = candidate.coverArtUrl
                rel.artwork.resolution = candidate.coverResolution || '3000×3000px (Apple Music Master Scan)'
                rel.artwork.isLowRes = false
                rel.artwork.width = 3000
                rel.artwork.height = 3000
              }

              const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === job.releaseId)
              relTracks.forEach((trk) => {
                trk.sidecarStatus = 'uncommitted_sidecar'
                trk.pendingSidecarEdits = {
                  ...(trk.pendingSidecarEdits || {}),
                  coverArtUrl: candidate!.coverArtUrl,
                }
                graphEngine.addOrUpdateTrack(trk)
              })
              graphEngine.addOrUpdateRelease(rel)

              this.updatedCount++
              this.uncheckpointedCount++
              this.lastResolvedTitle = job.albumTitle
              this.lastResolvedUrl = candidate.coverArtUrl
              this.lastProviderLabel = candidate.providerLabel
            }
          }

          this.completedInBatch++
          this.currentJob = null
          this.currentAbortController = null

          // Debounced checkpoint: flush every 10 albums to keep UI thread unburdened
          if (this.uncheckpointedCount >= 10) {
            await this.flushCheckpoint()
          }

          this.notify()

          // Audiophile Transport Pacing: paced delay between albums to prevent network burst noise
          await new Promise((resolve) => setTimeout(resolve, this.pacingDelayMs))
        } catch (err: any) {
          if (this.activeRunId !== currentRunId) break

          if (signal.aborted) {
            if (this.status !== 'idle') {
              this.queue.unshift(job)
            }
            this.currentJob = null
            this.currentAbortController = null
            break
          }
          console.warn(`[BackgroundArtwork] Resolution error for "${job.albumTitle}":`, err)
          this.completedInBatch++
          this.currentJob = null
          this.currentAbortController = null
          this.notify()
        }
      }

      if (
        this.activeRunId === currentRunId &&
        this.queue.length === 0 &&
        !this.currentJob &&
        !this.userPaused &&
        !this.isAudioPlaying
      ) {
        this.status = 'complete'
        await this.flushCheckpoint()
        this.notify()
      }
    } finally {
      if (this.activeRunId === currentRunId) {
        this.loopRunning = false
      }
    }
  }

  public destroy() {
    this.stopCooldownTimer()
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    if (this.unlistenPortraitWorker) {
      this.unlistenPortraitWorker()
      this.unlistenPortraitWorker = null
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.listeners.clear()
  }
}

export const backgroundArtworkService = new BackgroundArtworkService()
