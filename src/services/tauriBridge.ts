/**
 * Cadence Core Tauri Bridge
 * Seamless abstraction supporting native Tauri v2 desktop IPC and fallback Web Audio
 */

import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { UpdateArtistEditorialPayload } from '../core/types'
import type { CommitQueueSummary, CommitTelemetryPayload, EnqueueBatchPayload } from '../types/commit'

export interface AudioStreamTelemetry {
  filePath: string
  title?: string
  artist?: string
  album?: string
  durationSecs: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  format: string
  isHighRes: boolean
}

export interface UpnpDevice {
  id: string
  friendlyName: string
  modelName?: string
  modelDescription?: string
  manufacturer?: string
  location: string
  controlUrl: string
}

export interface StreamBufferInfo {
  limitMb: number
  effectiveBudgetMb: number
  availableRamMb?: number
  totalRamMb?: number
  currentMode: 'whole_track' | 'windowed' | 'idle' | string
  currentFileMb?: number
  currentWindowMb?: number
  currentLocked?: boolean
}

export interface PlaybackStatePayload {
  isPlaying: boolean
  isPaused: boolean
  currentFile: string | null
  positionSecs: number
  durationSecs: number
  volume: number
  playbackState?: 'Playing' | 'Paused' | 'Stopped' | 'Loading' | string
  activeDevice?: string
  streamInfo?: AudioStreamTelemetry
  purityMode?: boolean
  isBitPerfect?: boolean
  outputSampleRate?: number
  outputChannels?: number
  deviceType?: string
}

export interface StorageAccessibilityReport {
  mountId: string
  name: string
  mountPath: string
  isAccessible: boolean
  status: 'online' | 'offline'
  tracksCount: number
  releasesCount: number
}

class TauriBridgeService {
  private browserAudio: HTMLAudioElement | null = null
  private browserPositionInterval: any = null
  private onPositionUpdateCallback: ((pos: number, dur: number) => void) | null = null
  private onEndedCallback: (() => void) | null = null
  private browserDeviceMap: Map<string, string> = new Map()
  private activeDeviceId: string = 'default'
  private currentVolume: number = 1
  private playbackStateListeners: ((state: string) => void)[] = []

  /**
   * Subscribe to playback state changes (Playing, Paused, Stopped, Loading).
   */
  public onPlaybackStateChanged(fn: (state: string) => void): () => void {
    this.playbackStateListeners.push(fn)
    return () => {
      this.playbackStateListeners = this.playbackStateListeners.filter((l) => l !== fn)
    }
  }

  public notifyPlaybackState(state: string): void {
    this.playbackStateListeners.forEach((fn) => {
      try {
        fn(state)
      } catch {}
    })
  }

  /**
   * Check if running in native Tauri desktop environment
   */
  public isTauri(): boolean {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
    )
  }

  /**
   * Play audio track (via native Rust audio engine or HTML5 audio fallback)
   */
  public async playTrack(
    filePath: string,
    onPositionUpdate?: (pos: number, dur: number) => void,
    onEnded?: () => void
  ): Promise<AudioStreamTelemetry | null> {
    this.onPositionUpdateCallback = onPositionUpdate || null
    this.onEndedCallback = onEnded || null

    if (this.isTauri()) {
      try {
        const raw: any = await invoke('play_track', { filePath })
        if (!raw) return null
        return {
          filePath: raw.filePath ?? raw.file_path ?? filePath,
          title: raw.title,
          artist: raw.artist,
          album: raw.album,
          durationSecs: raw.durationSecs ?? raw.duration_secs ?? 0,
          sampleRate: raw.sampleRate ?? raw.sample_rate,
          bitDepth: raw.bitDepth ?? raw.bit_depth,
          channels: raw.channels,
          format: raw.format || 'AUDIO',
          isHighRes: Boolean(raw.isHighRes ?? raw.is_high_res),
        }
      } catch (err) {
        console.error('[TauriBridge] Native play_track error:', err)
        throw err
      }
    } else {
      // Browser fallback using HTML5 Audio
      if (this.browserAudio) {
        this.browserAudio.pause()
        this.browserAudio.onloadedmetadata = null
        this.browserAudio.ontimeupdate = null
        this.browserAudio.ondurationchange = null
        this.browserAudio.onended = null
        this.browserAudio.src = ''
      }

      const streamUrl = `/api/track-stream?path=${encodeURIComponent(filePath)}`
      const audio = new Audio(streamUrl)
      audio.volume = this.currentVolume
      this.browserAudio = audio

      // Apply selected audio output device sink if supported
      if (this.activeDeviceId && typeof (audio as any).setSinkId === 'function') {
        try {
          await (audio as any).setSinkId(this.activeDeviceId)
        } catch (sinkErr) {
          console.warn('[TauriBridge] Could not set audio sink ID:', sinkErr)
        }
      }

      const notifyUpdate = () => {
        if (this.browserAudio && this.onPositionUpdateCallback) {
          const cur = this.browserAudio.currentTime || 0
          const dur = isFinite(this.browserAudio.duration) ? this.browserAudio.duration : 0
          this.onPositionUpdateCallback(cur, dur)
        }
      }

      audio.onloadedmetadata = () => notifyUpdate()
      audio.ontimeupdate = () => notifyUpdate()
      audio.ondurationchange = () => notifyUpdate()
      audio.onended = () => {
        if (this.onEndedCallback) {
          this.onEndedCallback()
        }
      }

      if (this.browserPositionInterval) {
        clearInterval(this.browserPositionInterval)
      }

      this.browserPositionInterval = setInterval(() => {
        if (this.browserAudio && !this.browserAudio.paused) {
          notifyUpdate()
        }
      }, 200)

      await audio.play()

      const ext = filePath.split('.').pop()?.toUpperCase() || 'AUDIO'
      return {
        filePath,
        durationSecs: isFinite(audio.duration) ? audio.duration : 0,
        format: ext,
        isHighRes: false,
      }
    }
  }

  /**
   * Pause playback
   */
  public async pause(): Promise<void> {
    this.notifyPlaybackState('Paused')
    if (this.isTauri()) {
      await invoke('pause_audio')
    } else if (this.browserAudio) {
      this.browserAudio.pause()
    }
  }

  /**
   * Resume playback
   */
  public async resume(): Promise<void> {
    this.notifyPlaybackState('Playing')
    if (this.isTauri()) {
      await invoke('resume_audio')
    } else if (this.browserAudio) {
      await this.browserAudio.play()
    }
  }

  /**
   * Stop playback
   */
  public async stop(): Promise<void> {
    this.notifyPlaybackState('Stopped')
    if (this.isTauri()) {
      await invoke('stop_audio')
    } else if (this.browserAudio) {
      this.browserAudio.pause()
      this.browserAudio.currentTime = 0
      if (this.browserPositionInterval) {
        clearInterval(this.browserPositionInterval)
      }
    }
  }

  /**
   * Seek to position in seconds
   */
  public async seek(positionSecs: number): Promise<void> {
    if (this.isTauri()) {
      await invoke('seek_audio', { positionSecs })
    } else if (this.browserAudio) {
      this.browserAudio.currentTime = positionSecs
      if (this.onPositionUpdateCallback) {
        const dur = isFinite(this.browserAudio.duration) ? this.browserAudio.duration : 0
        this.onPositionUpdateCallback(positionSecs, dur)
      }
    }
  }

  /**
   * Set playback volume (0.0 to 1.0)
   */
  public async setVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, volume))
    this.currentVolume = clamped
    if (this.isTauri()) {
      await invoke('set_audio_volume', { volume: clamped })
    } else if (this.browserAudio) {
      this.browserAudio.volume = clamped
    }
  }

  /**
   * Get current playback status
   */
  public async getPlaybackStatus(): Promise<PlaybackStatePayload> {
    if (this.isTauri()) {
      const raw: any = await invoke('get_playback_status')
      const sInfo = raw.streamInfo ?? raw.stream_info
      return {
        isPlaying: Boolean(raw.isPlaying ?? raw.is_playing),
        isPaused: Boolean(raw.isPaused ?? raw.is_paused),
        currentFile: raw.currentFile ?? raw.current_file ?? null,
        positionSecs: Number(raw.positionSecs ?? raw.position_secs ?? 0),
        durationSecs: Number(raw.durationSecs ?? raw.duration_secs ?? 0),
        volume: Number(raw.volume ?? 1),
        playbackState: raw.playbackState ?? raw.playback_state,
        activeDevice: raw.activeDevice ?? raw.active_device,
        purityMode: Boolean(raw.purityMode ?? raw.purity_mode),
        isBitPerfect: Boolean(raw.isBitPerfect ?? raw.is_bit_perfect),
        outputSampleRate: raw.outputSampleRate ?? raw.output_sample_rate,
        outputChannels: raw.outputChannels ?? raw.output_channels,
        deviceType: raw.deviceType ?? raw.device_type ?? 'wasapi_shared',
        streamInfo: sInfo
          ? {
              filePath: sInfo.filePath ?? sInfo.file_path,
              title: sInfo.title,
              artist: sInfo.artist,
              album: sInfo.album,
              durationSecs: sInfo.durationSecs ?? sInfo.duration_secs ?? 0,
              sampleRate: sInfo.sampleRate ?? sInfo.sample_rate,
              bitDepth: sInfo.bitDepth ?? sInfo.bit_depth,
              channels: sInfo.channels,
              format: sInfo.format || 'AUDIO',
              isHighRes: Boolean(sInfo.isHighRes ?? sInfo.is_high_res),
            }
          : undefined,
      }
    } else {
      const isPlaying = Boolean(this.browserAudio && !this.browserAudio.paused && !this.browserAudio.ended)
      const cur = this.browserAudio?.currentTime || 0
      const dur = this.browserAudio && isFinite(this.browserAudio.duration) ? this.browserAudio.duration : 0
      return {
        isPlaying,
        isPaused: Boolean(this.browserAudio?.paused && cur > 0),
        currentFile: this.browserAudio?.src || null,
        positionSecs: cur,
        durationSecs: dur,
        volume: this.browserAudio?.volume ?? this.currentVolume,
        purityMode: false,
        isBitPerfect: false,
        deviceType: 'web_audio',
      }
    }
  }

  /**
   * Set Bit-Perfect Purity Mode (WASAPI Exclusive Clock Matching & Unity Gain)
   */
  public async setPurityMode(enabled: boolean): Promise<boolean> {
    if (this.isTauri()) {
      return await invoke<boolean>('set_purity_mode', { enabled })
    }
    return enabled
  }

  /**
   * Get current Bit-Perfect Purity Mode state
   */
  public async getPurityMode(): Promise<boolean> {
    if (this.isTauri()) {
      return await invoke<boolean>('get_purity_mode')
    }
    return false
  }

  /**
   * Discover network UPnP / DLNA media renderers (e.g. PS Audio AirLens, WiiM, Volumio)
   */
  public async discoverUpnpDevices(): Promise<UpnpDevice[]> {
    if (this.isTauri()) {
      try {
        return await invoke<UpnpDevice[]>('discover_upnp_devices')
      } catch (err) {
        console.error('[TauriBridge] discover_upnp_devices error:', err)
        return []
      }
    }
    return []
  }

  /**
   * Get low-noise stream RAM buffer and allocation telemetry
   */
  public async getStreamBufferInfo(): Promise<StreamBufferInfo | null> {
    if (this.isTauri()) {
      try {
        return await invoke<StreamBufferInfo>('get_stream_buffer_info')
      } catch (err) {
        console.error('[TauriBridge] get_stream_buffer_info error:', err)
        return null
      }
    }
    return null
  }

  /**
   * Set low-noise stream RAM buffer limit (0 = Auto)
   */
  public async setStreamBufferLimit(limitMb: number): Promise<StreamBufferInfo | null> {
    if (this.isTauri()) {
      try {
        return await invoke<StreamBufferInfo>('set_stream_buffer_limit', { limitMb })
      } catch (err) {
        console.error('[TauriBridge] set_stream_buffer_limit error:', err)
        return null
      }
    }
    return null
  }


  /**
   * List available audio output devices (WASAPI / DirectSound in Tauri or Audio Output Devices in Web)
   */
  public async listAudioDevices(): Promise<string[]> {
    if (this.isTauri()) {
      try {
        return await invoke<string[]>('list_audio_devices')
      } catch (err) {
        console.error('[TauriBridge] Native list_audio_devices error:', err)
        return ['Default Audio Device']
      }
    }

    // Web MediaDevices enumeration
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioOutputs = devices.filter((d) => d.kind === 'audiooutput')

        this.browserDeviceMap.clear()
        const resultList: string[] = []

        audioOutputs.forEach((dev, idx) => {
          const label = dev.label || (idx === 0 ? 'Default System Output' : `Audio Output Endpoint ${idx + 1}`)
          this.browserDeviceMap.set(label, dev.deviceId)
          resultList.push(label)
        })

        if (resultList.length > 0) {
          return resultList
        }
      } catch (e) {
        console.warn('[TauriBridge] enumerateDevices error:', e)
      }
    }

    return ['Default System Output', 'Headphones (Realtek Audio)', 'External DAC (Direct)']
  }

  /**
   * Set active audio output device
   */
  public async setAudioDevice(deviceName: string): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('set_audio_device', { deviceName })
      } catch (err) {
        console.error('[TauriBridge] set_audio_device native error:', err)
      }
    } else {
      // Find matching device ID
      const deviceId = this.browserDeviceMap.get(deviceName) || 'default'
      this.activeDeviceId = deviceId
      if (this.browserAudio && typeof (this.browserAudio as any).setSinkId === 'function') {
        try {
          await (this.browserAudio as any).setSinkId(deviceId)
        } catch (err) {
          console.warn('[TauriBridge] setSinkId error:', err)
        }
      }
    }
  }

  /**
   * Fetch base64 cover art from audio file directly
   */
  public async getCoverArt(filePath: string): Promise<string | null> {
    if (this.isTauri()) {
      return await invoke<string | null>('read_cover_art_base64', { filePath })
    }
    return null
  }

  /**
   * Open native OS folder picker dialog to select library directory
   */
  public async openDirectoryDialog(defaultPath?: string): Promise<string | null> {
    if (this.isTauri()) {
      try {
        const selected = await openDialog({
          directory: true,
          multiple: false,
          title: 'Select Music Library Root Folder',
          defaultPath: defaultPath || undefined,
        })
        if (typeof selected === 'string') return selected
        if (Array.isArray(selected)) return (selected as string[])[0] || null
        return null
      } catch (err) {
        console.error('[TauriBridge] Native directory picker error:', err)
        return null
      }
    }
    return null
  }

  /**
   * Open file location in OS File Explorer / Finder
   */
  public async showItemInFolder(path: string): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('show_item_in_folder', { path })
      } catch (err) {
        console.error('[TauriBridge] show_item_in_folder error:', err)
      }
    }
  }

  // --- SQLite Database IPC Methods ---

  public async checkStorageMountsAccessibility(): Promise<StorageAccessibilityReport[]> {
    if (this.isTauri()) {
      return await invoke<StorageAccessibilityReport[]>('check_storage_mounts_accessibility')
    }
    return []
  }

  public async checkPathAccessible(path: string): Promise<boolean> {
    if (this.isTauri()) {
      return await invoke<boolean>('check_path_accessible', { path })
    }
    return true
  }

  public async dbGetOfflineCounts(): Promise<[number, number]> {
    if (this.isTauri()) {
      return await invoke<[number, number]>('db_get_offline_counts')
    }
    return [0, 0]
  }

  public async dbGetStorageMounts(): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_storage_mounts')
    }
    return []
  }

  public async dbSaveStorageMount(mount: any): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_save_storage_mount', { mount })
    }
  }

  public async dbRemoveStorageMount(mountId: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_remove_storage_mount', { mountId })
    }
  }

  public async dbSetMountStatus(mountId: string, status: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_set_mount_status', { mountId, status })
    }
  }

  public async dbToggleMountLock(mountId: string): Promise<boolean> {
    if (this.isTauri()) {
      return await invoke<boolean>('db_toggle_mount_lock', { mountId })
    }
    return false
  }

  public async dbGetWatchedFolders(): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_watched_folders')
    }
    return []
  }

  public async dbSaveWatchedFolder(folder: any): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_save_watched_folder', { folder })
    }
  }

  public async dbRemoveWatchedFolder(folderId: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_remove_watched_folder', { folderId })
    }
  }

  public async dbGetTracks(limit?: number, offset?: number, onlyOnline?: boolean): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_tracks', { limit, offset, onlyOnline })
    }
    return []
  }

  public async dbGetReleases(onlyOnline?: boolean): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_releases', { onlyOnline })
    }
    return []
  }

  public async dbSaveTracksBatch(tracks: any[], releases: any[]): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_save_tracks_batch', { tracks, releases })
    }
  }

  public async dbGetSkippedFiles(): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_skipped_files')
    }
    return []
  }

  public async dbIgnoreSkippedFile(id: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_ignore_skipped_file', { id })
    }
  }

  public async dbIgnoreAllSkippedFiles(): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_ignore_all_skipped_files')
    }
  }

  public async dbDeleteSkippedFile(id: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_delete_skipped_file', { id })
    }
  }

  public async dbGetLibraryStats(): Promise<[number, number, number, number]> {
    if (this.isTauri()) {
      return await invoke<[number, number, number, number]>('db_get_library_stats')
    }
    return [0, 0, 0, 0]
  }

  // --- Canonical Relational Artists ---

  public async dbGetCanonicalArtists(): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_canonical_artists')
    }
    return []
  }

  public async dbGetCanonicalArtistDetail(artistId: string): Promise<any | null> {
    if (this.isTauri()) {
      return await invoke<any | null>('db_get_canonical_artist_detail', { artistId })
    }
    return null
  }

  public async dbSetArtistPortrait(
    artistId: string,
    portraitUrl: string,
    status?: string
  ): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_set_artist_portrait', { artistId, portraitUrl, status })
    }
  }

  public async updateCanonicalArtistEditorial(
    artistId: string,
    payload: UpdateArtistEditorialPayload
  ): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_update_canonical_artist_editorial', { artistId, payload })
    }
  }

  public async dbBackfillArtistCredits(): Promise<number> {
    if (this.isTauri()) {
      return await invoke<number>('db_backfill_artist_credits')
    }
    return 0
  }

  public async dbSearchCatalog(
    query: string,
    limit?: number
  ): Promise<{ albums: any[]; tracks: any[]; artists: any[] }> {
    if (this.isTauri()) {
      return await invoke<{ albums: any[]; tracks: any[]; artists: any[] }>('db_search_catalog', {
        query,
        limit,
      })
    }
    return { albums: [], tracks: [], artists: [] }
  }


  // --- Scanner Controls & Real-time Events ---

  public async startLibraryScan(
    folderPath: string,
    mountId?: string,
    forceFull: boolean = false,
    playbackPolicy?: 'purist' | 'paced' | 'unthrottled'
  ): Promise<void> {
    if (this.isTauri()) {
      await invoke('start_library_scan', {
        folderPath,
        mountId,
        forceFull,
        playbackPolicy,
      })
    }
  }

  public async setScannerPlaybackPolicy(policy: 'purist' | 'paced' | 'unthrottled'): Promise<void> {
    if (this.isTauri()) {
      await invoke('set_scan_playback_policy', { policy })
    }
  }

  public async getScannerPlaybackPolicy(): Promise<'purist' | 'paced' | 'unthrottled'> {
    if (this.isTauri()) {
      return await invoke<'purist' | 'paced' | 'unthrottled'>('get_scan_playback_policy')
    }
    return 'purist'
  }

  public async pauseLibraryScan(): Promise<void> {
    if (this.isTauri()) {
      await invoke('pause_library_scan')
    }
  }

  public async resumeLibraryScan(): Promise<void> {
    if (this.isTauri()) {
      await invoke('resume_library_scan')
    }
  }

  public async cancelLibraryScan(): Promise<void> {
    if (this.isTauri()) {
      await invoke('cancel_library_scan')
    }
  }

  public async getScanStatus(): Promise<any> {
    if (this.isTauri()) {
      return await invoke('get_scan_status')
    }
    return null
  }

  // --- Remote Mobile Controller IPC ---

  public async getRemoteServerInfo(): Promise<RemoteServerStatus | null> {
    if (this.isTauri()) {
      try {
        return await invoke<RemoteServerStatus>('get_remote_server_info')
      } catch (err) {
        console.error('[TauriBridge] get_remote_server_info error:', err)
        return null
      }
    }
    return {
      enabled: true,
      port: 4040,
      primaryIp: '192.168.1.100',
      hasVerifiedLan: true,
      computerName: 'CADENCE-DEV',
      mDnsHost: 'cadence-dev.local',
      pairingToken: '4242',
      interfaces: [{ name: 'Wi-Fi', ip: '192.168.1.100', isRecommended: true }],
      connectedClients: 0,
      qrUrl: 'http://192.168.1.100:4040/?token=4242',
    }
  }

  public async regeneratePairingToken(): Promise<string | null> {
    if (this.isTauri()) {
      try {
        return await invoke<string>('regenerate_pairing_token')
      } catch (err) {
        console.error('[TauriBridge] regenerate_pairing_token error:', err)
        return null
      }
    }
    return '4242'
  }

  public async syncDesktopQueueToRemote(items: any[], currentIndex: number): Promise<void> {
    if (this.isTauri()) {
      try {
        const payload = items.map((t) => ({
          id: t.id || t.filePath,
          title: t.title || 'Unknown',
          artist: t.artist || t.artistCredit || 'Unknown Artist',
          album: t.album || t.albumTitle || 'Unknown Album',
          filePath: t.filePath,
          durationSecs: t.durationSecs || 0,
          format: t.format || 'AUDIO',
          sampleRate: t.sampleRate,
          bitDepth: t.bitDepth,
          isHighRes: Boolean(t.isHighRes),
        }))
        await invoke('sync_desktop_queue_to_remote', { items: payload, currentIndex })
      } catch (err) {
        console.error('[TauriBridge] sync_desktop_queue_to_remote error:', err)
      }
    }
  }

  public async getMaintenanceStats(): Promise<MaintenanceStats | null> {
    if (this.isTauri()) {
      try {
        return await invoke<MaintenanceStats>('get_maintenance_stats')
      } catch (err) {
        console.error('[TauriBridge] get_maintenance_stats error:', err)
        return null
      }
    }
    return {
      isRunning: false,
      isIdle: true,
      statusMessage: 'Ready',
      cachedCount: 0,
      notFoundCount: 0,
      failedCount: 0,
      totalItems: 0,
      pendingItems: 0,
    }
  }

  public async getPortraitSyncStats(): Promise<PortraitSyncProgressPayload | null> {
    if (this.isTauri()) {
      try {
        return await invoke<PortraitSyncProgressPayload>('get_portrait_sync_stats')
      } catch (err) {
        console.error('[TauriBridge] get_portrait_sync_stats error:', err)
        return null
      }
    }
    return {
      state: 'complete',
      completed: 0,
      total: 0,
      pending: 0,
      nextInQueue: [],
    }
  }

  public async toggleMaintenancePause(): Promise<boolean> {
    if (this.isTauri()) {
      try {
        return await invoke<boolean>('toggle_maintenance_pause')
      } catch (err) {
        console.error('[TauriBridge] toggle_maintenance_pause error:', err)
        return false
      }
    }
    return false
  }

  public async forceEnrichNow(): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('force_enrich_now')
      } catch (err) {
        console.error('[TauriBridge] force_enrich_now error:', err)
      }
    }
  }

  public async notifyArtistPortraitResolved(
    artistId: string,
    artistName: string,
    portraitUrl: string,
    providerInfo: string
  ): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('notify_artist_portrait_resolved', {
          artistId,
          artistName,
          portraitUrl,
          providerInfo,
        })
      } catch (err) {
        console.error('[TauriBridge] notify_artist_portrait_resolved error:', err)
      }
    }
  }

  public async onPortraitSyncProgress(
    callback: (payload: PortraitSyncProgressPayload) => void
  ): Promise<() => void> {
    if (this.isTauri()) {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<PortraitSyncProgressPayload>(
          'portrait-sync-progress',
          (event) => {
            callback(event.payload)
          }
        )
        return unlisten
      } catch (err) {
        console.error('[TauriBridge] onPortraitSyncProgress error:', err)
      }
    }
    return () => {}
  }

  public async onPortraitEnriched(
    callback: (payload: { artistId: string; artistName: string; portraitUrl: string; provider?: string }) => void
  ): Promise<() => void> {
    if (this.isTauri()) {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<{ artistId: string; artistName: string; portraitUrl: string; provider?: string }>(
          'portrait-enriched',
          (event) => {
            callback(event.payload)
          }
        )
        return unlisten
      } catch (err) {
        console.error('[TauriBridge] onPortraitEnriched error:', err)
      }
    }
    return () => {}
  }

  public async getTrackFingerprint(trackId: string): Promise<[string, number] | null> {
    if (this.isTauri()) {
      try {
        return await invoke<[string, number]>('get_track_fingerprint', { trackId })
      } catch (err) {
        console.error('[TauriBridge] get_track_fingerprint error:', err)
        return null
      }
    }
    return null
  }

  public async dbUpdateTrackProvenance(
    trackId: string,
    mbid?: string,
    originalAlbum?: string,
    originalYear?: number
  ): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('db_update_track_provenance', {
          trackId,
          mbid,
          originalAlbum,
          originalYear,
        })
      } catch (err) {
        console.error('[TauriBridge] db_update_track_provenance error:', err)
      }
    }
  }

  public async dbGetCachedAcoustid(
    fingerprint: string
  ): Promise<[string | null, string | null, number | null, number | null] | null> {
    if (this.isTauri()) {
      try {
        return await invoke('db_get_cached_acoustid', { fingerprint })
      } catch (err) {
        console.error('[TauriBridge] db_get_cached_acoustid error:', err)
        return null
      }
    }
    return null
  }

  public async dbCacheAcoustidResult(
    fingerprint: string,
    duration: number,
    mbid?: string,
    canonicalTitle?: string,
    canonicalYear?: number,
    score?: number
  ): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('db_cache_acoustid_result', {
          fingerprint,
          duration,
          mbid,
          canonicalTitle,
          canonicalYear,
          score,
        })
      } catch (err) {
        console.error('[TauriBridge] db_cache_acoustid_result error:', err)
      }
    }
  }

  public async onTrackFingerprinted(
    callback: (payload: { trackId: string; fingerprint: string; duration: number }) => void
  ): Promise<() => void> {
    if (this.isTauri()) {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<{ trackId: string; fingerprint: string; duration: number }>(
          'track-fingerprinted',
          (event) => {
            callback(event.payload)
          }
        )
        return unlisten
      } catch (err) {
        console.error('[TauriBridge] onTrackFingerprinted error:', err)
      }
    }
    return () => {}
  }

  // ==========================================
  // Audiophile Gapless & Clock Settling
  // ==========================================

  public async prepareNextTrack(filePath: string): Promise<boolean> {
    if (this.isTauri()) {
      try {
        return await invoke<boolean>('prepare_next_track', { filePath })
      } catch (err) {
        console.warn('[TauriBridge] prepare_next_track failed:', err)
        return false
      }
    }
    return false
  }

  public async invalidateNextTrack(): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('invalidate_next_track')
      } catch (err) {
        console.warn('[TauriBridge] invalidate_next_track error:', err)
      }
    }
  }

  public async setSettlingDelayMs(delayMs: number): Promise<void> {
    if (this.isTauri()) {
      try {
        await invoke('set_settling_delay_ms', { delayMs })
      } catch (err) {
        console.warn('[TauriBridge] set_settling_delay_ms error:', err)
      }
    }
  }

  // ==========================================
  // Playlists SQLite Integration
  // ==========================================

  public async dbGetPlaylists(): Promise<any[]> {
    if (this.isTauri()) {
      try {
        return await invoke<any[]>('db_get_playlists')
      } catch (err) {
        console.error('[TauriBridge] db_get_playlists error:', err)
        return []
      }
    }
    return []
  }

  public async dbGetPlaylistDetails(playlistId: string): Promise<any | null> {
    if (this.isTauri()) {
      try {
        return await invoke<any | null>('db_get_playlist_details', { playlistId })
      } catch (err) {
        console.error('[TauriBridge] db_get_playlist_details error:', err)
        return null
      }
    }
    return null
  }

  public async dbCreatePlaylist(params: {
    id: string
    title: string
    description?: string
    coverArtUrl?: string
    tags?: string
    listeningNotes?: string
    trackIds: string[]
  }): Promise<any> {
    if (this.isTauri()) {
      return await invoke<any>('db_create_playlist', {
        id: params.id,
        title: params.title,
        description: params.description,
        coverArtUrl: params.coverArtUrl,
        tags: params.tags,
        listeningNotes: params.listeningNotes,
        trackIds: params.trackIds,
      })
    }
    return {
      id: params.id,
      title: params.title,
      description: params.description,
      coverArtUrl: params.coverArtUrl,
      tags: params.tags,
      listeningNotes: params.listeningNotes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tracksCount: params.trackIds.length,
      totalDurationSecs: 0,
      formatBreakdown: '',
    }
  }

  public async dbUpdatePlaylist(params: {
    id: string
    title: string
    description?: string
    coverArtUrl?: string
    tags?: string
    listeningNotes?: string
  }): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_update_playlist', {
        id: params.id,
        title: params.title,
        description: params.description,
        coverArtUrl: params.coverArtUrl,
        tags: params.tags,
        listeningNotes: params.listeningNotes,
      })
    }
  }

  public async dbDeletePlaylist(id: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_delete_playlist', { id })
    }
  }

  public async dbAddTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_add_tracks_to_playlist', { playlistId, trackIds })
    }
  }

  public async dbRemoveTrackFromPlaylist(playlistId: string, position: number): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_remove_track_from_playlist', { playlistId, position })
    }
  }

  public async dbReorderPlaylistTracks(playlistId: string, trackIds: string[]): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_reorder_playlist_tracks', { playlistId, trackIds })
    }
  }

  public async dbSetReleaseSplit(releaseId: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_set_release_split', { releaseId })
    }
  }

  public async dbRemoveReleaseSplit(releaseId: string): Promise<void> {
    if (this.isTauri()) {
      await invoke('db_remove_release_split', { releaseId })
    }
  }

  public async dbGetSplitReleases(): Promise<string[]> {
    if (this.isTauri()) {
      return await invoke<string[]>('db_get_split_releases')
    }
    return []
  }

  // Asynchronous Background Commit Queue IPC
  public async commitEnqueueBatch(request: EnqueueBatchPayload): Promise<string> {
    if (this.isTauri()) {
      return await invoke<string>('commit_enqueue_batch', { request })
    }
    return `mock-batch-${Date.now()}`
  }

  public async commitGetQueueSummary(): Promise<CommitQueueSummary> {
    if (this.isTauri()) {
      return await invoke<CommitQueueSummary>('commit_get_queue_summary')
    }
    return {
      totalBatches: 0,
      pendingItems: 0,
      inflightItems: 0,
      completedItems: 0,
      failedItems: 0,
      totalWrittenBytes: 0,
      isPaused: false,
      isEmpty: true,
    }
  }

  public async commitGetTelemetry(): Promise<CommitTelemetryPayload> {
    if (this.isTauri()) {
      return await invoke<CommitTelemetryPayload>('commit_get_telemetry')
    }
    return {
      state: 'idle',
      pendingItems: 0,
      inflightItems: 0,
      completedItems: 0,
      failedItems: 0,
      totalItems: 0,
      percent: 100,
      throughputItemsPerSec: 0,
      offlineMounts: [],
    }
  }

  public async commitSetOverride(batchId: string, allow: boolean): Promise<void> {
    if (this.isTauri()) {
      await invoke('commit_set_override', { batchId, allow })
    }
  }

  public async commitTogglePause(): Promise<boolean> {
    if (this.isTauri()) {
      return await invoke<boolean>('commit_toggle_pause')
    }
    return false
  }

  public async commitRetryOfflineMounts(): Promise<void> {
    if (this.isTauri()) {
      await invoke('commit_retry_offline_mounts')
    }
  }

  public async commitCancelBatch(batchId: string): Promise<number> {
    if (this.isTauri()) {
      return await invoke<number>('commit_cancel_batch', { batchId })
    }
    return 0
  }

  public async commitUndoBatch(batchId: string): Promise<string> {
    if (this.isTauri()) {
      return await invoke<string>('commit_undo_batch', { batchId })
    }
    return `mock-undo-${Date.now()}`
  }

  public async commitGetQueuedTrackIds(): Promise<string[]> {
    if (this.isTauri()) {
      return await invoke<string[]>('commit_get_queued_track_ids')
    }
    return []
  }

  public async listenCommitTelemetry(
    callback: (payload: CommitTelemetryPayload) => void
  ): Promise<() => void> {
    if (this.isTauri()) {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<CommitTelemetryPayload>(
          'commit://telemetry',
          (event) => {
            callback(event.payload)
          }
        )
        return unlisten
      } catch (err) {
        console.warn('[TauriBridge] Failed to subscribe to commit://telemetry:', err)
      }
    }
    return () => {}
  }
}

export interface PortraitSyncProgressPayload {
  state: 'active' | 'cooldown' | 'paused_playback' | 'complete' | 'user_paused'
  completed: number
  total: number
  pending: number
  cooldownRemainingSecs?: number
  currentArtistId?: string
  currentArtistName?: string
  resolvedPortraitUrl?: string
  providerInfo?: string
  nextInQueue: string[]
}

export interface MaintenanceStats {
  isRunning: boolean
  isIdle: boolean
  statusMessage: string
  cachedCount: number
  notFoundCount: number
  failedCount: number
  totalItems: number
  pendingItems: number
  lastProcessedItem?: string
}

export interface LanInterfaceInfo {
  name: string
  ip: string
  isRecommended: boolean
}

export interface RemoteServerStatus {
  enabled: boolean
  port: number
  primaryIp: string | null
  hasVerifiedLan: boolean
  computerName: string
  mDnsHost: string
  pairingToken: string
  interfaces: LanInterfaceInfo[]
  connectedClients: number
  qrUrl: string | null
}

export const tauriBridge = new TauriBridgeService()
