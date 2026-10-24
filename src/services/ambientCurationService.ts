/**
 * Cadence Ambient Curation Telemetry Service
 * Zero-polling hardware telemetry coordinator for background artist portrait curation.
 */

import { tauriBridge, PortraitSyncProgressPayload } from './tauriBridge'
import { federatedResolversService } from './federatedResolvers'

export interface AmbientCurationState {
  state: 'active' | 'cooldown' | 'paused_playback' | 'complete' | 'user_paused'
  completed: number
  total: number
  pending: number
  cooldownRemainingSecs?: number
  currentArtistId?: string
  currentArtistName?: string
  lastResolved?: {
    artistName: string
    provider: string
  }
  nextInQueue: string[]
}

type Listener = (state: AmbientCurationState) => void

class AmbientCurationService {
  private state: AmbientCurationState = {
    state: 'complete',
    completed: 0,
    total: 0,
    pending: 0,
    nextInQueue: [],
  }

  private listeners: Set<Listener> = new Set()
  private unlistenEvent: (() => void) | null = null
  private cooldownTimer: any = null
  private activeResolvingArtistId: string | null = null
  private initialized: boolean = false

  public init() {
    if (this.initialized) return
    this.initialized = true

    // Fetch initial state once on load
    this.fetchInitialState()

    // Subscribe to event-driven push from Rust worker
    tauriBridge.onPortraitSyncProgress((payload: PortraitSyncProgressPayload) => {
      this.handleProgressPayload(payload)
    }).then((unlisten) => {
      this.unlistenEvent = unlisten
    })
  }

  public getState(): AmbientCurationState {
    return { ...this.state }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    const current = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(current)
      } catch (err) {
        console.error('[AmbientCuration] Listener error:', err)
      }
    }
  }

  private async fetchInitialState() {
    try {
      const initial = await tauriBridge.getPortraitSyncStats()
      if (initial) {
        this.handleProgressPayload(initial)
      }
    } catch (err) {
      console.warn('[AmbientCuration] Could not fetch initial stats:', err)
    }
  }

  private handleProgressPayload(payload: PortraitSyncProgressPayload) {
    this.state = {
      state: payload.state,
      completed: payload.completed,
      total: payload.total,
      pending: payload.pending,
      cooldownRemainingSecs: payload.cooldownRemainingSecs,
      currentArtistId: payload.currentArtistId,
      currentArtistName: payload.currentArtistName,
      lastResolved: payload.providerInfo
        ? {
            artistName: payload.currentArtistName || 'Artist',
            provider: payload.providerInfo,
          }
        : this.state.lastResolved,
      nextInQueue: payload.nextInQueue || [],
    }

    // Handle cooldown local ticker (0-30s)
    if (payload.state === 'cooldown') {
      const initialSecs = payload.cooldownRemainingSecs ?? 30
      this.startLocalCooldownTimer(initialSecs)
    } else {
      this.stopLocalCooldownTimer()
    }

    this.notify()

    // When worker signals 'active' and provides an artist, perform client enrichment
    if (
      payload.state === 'active' &&
      payload.currentArtistId &&
      payload.currentArtistName &&
      this.activeResolvingArtistId !== payload.currentArtistId
    ) {
      this.resolveArtistPortrait(payload.currentArtistId, payload.currentArtistName)
    }
  }

  private startLocalCooldownTimer(seconds: number) {
    this.stopLocalCooldownTimer()
    let remaining = seconds
    this.state.cooldownRemainingSecs = remaining

    this.cooldownTimer = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        this.stopLocalCooldownTimer()
        this.state.cooldownRemainingSecs = 0
        this.notify()
      } else {
        this.state.cooldownRemainingSecs = remaining
        this.notify()
      }
    }, 1000)
  }

  private stopLocalCooldownTimer() {
    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer)
      this.cooldownTimer = null
    }
  }

  private async resolveArtistPortrait(artistId: string, artistName: string) {
    this.activeResolvingArtistId = artistId
    try {
      const candidates = await federatedResolversService.searchArtistPortraits(artistName)
      if (candidates && candidates.length > 0) {
        // Pick best candidate
        const best = candidates[0]
        await tauriBridge.dbSetArtistPortrait(artistId, best.portraitUrl, 'enriched')
        await tauriBridge.notifyArtistPortraitResolved(
          artistId,
          artistName,
          best.portraitUrl,
          best.providerLabel
        )
      } else {
        // Negative cache: mark not_found so it won't be queried again
        await tauriBridge.dbSetArtistPortrait(artistId, '', 'not_found')
        await tauriBridge.notifyArtistPortraitResolved(
          artistId,
          artistName,
          '',
          'Negative Cache (No Portrait Found)'
        )
      }
    } catch (err) {
      console.warn(`[AmbientCuration] Error resolving portrait for ${artistName}:`, err)
    } finally {
      this.activeResolvingArtistId = null
    }
  }

  public async togglePause(): Promise<boolean> {
    const isPaused = await tauriBridge.toggleMaintenancePause()
    this.state.state = isPaused ? 'user_paused' : 'active'
    this.notify()
    return isPaused
  }

  public async enrichRemainingNow(stopPlayback?: () => Promise<void> | void) {
    if (stopPlayback) {
      try {
        await stopPlayback()
      } catch (err) {
        console.warn('[AmbientCuration] Error stopping playback for enrichment:', err)
      }
    }
    try {
      await tauriBridge.forceEnrichNow()
    } catch (err) {
      console.warn('[AmbientCuration] Error invoking forceEnrichNow:', err)
      if (this.state.state === 'user_paused') {
        await this.togglePause()
      }
    }
  }
}

export const ambientCurationService = new AmbientCurationService()

// Auto-initialize when in browser/tauri context
if (typeof window !== 'undefined') {
  ambientCurationService.init()
}
