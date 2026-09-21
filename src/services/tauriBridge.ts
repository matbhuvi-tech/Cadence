/**
 * Cadence Core Tauri Bridge
 * Seamless abstraction supporting native Tauri v2 desktop IPC and fallback Web Audio
 */

import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

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

export interface PlaybackStatePayload {
  isPlaying: boolean
  isPaused: boolean
  currentFile: string | null
  positionSecs: number
  durationSecs: number
  volume: number
  activeDevice?: string
  streamInfo?: AudioStreamTelemetry
}

class TauriBridgeService {
  private browserAudio: HTMLAudioElement | null = null
  private browserPositionInterval: any = null
  private onPositionUpdateCallback: ((pos: number, dur: number) => void) | null = null
  private onEndedCallback: (() => void) | null = null
  private browserDeviceMap: Map<string, string> = new Map()
  private activeDeviceId: string = 'default'
  private currentVolume: number = 1

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
        const info = await invoke<AudioStreamTelemetry>('play_track', { filePath })
        return info
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
      return await invoke<PlaybackStatePayload>('get_playback_status')
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
      }
    }
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

  public async dbGetTracks(limit?: number, offset?: number): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_tracks', { limit, offset })
    }
    return []
  }

  public async dbGetReleases(): Promise<any[]> {
    if (this.isTauri()) {
      return await invoke<any[]>('db_get_releases')
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

  // --- Scanner Controls & Real-time Events ---

  public async startLibraryScan(
    folderPath: string,
    mountId?: string,
    forceFull: boolean = false
  ): Promise<void> {
    if (this.isTauri()) {
      await invoke('start_library_scan', {
        folderPath,
        mountId,
        forceFull,
      })
    }
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
}

export const tauriBridge = new TauriBridgeService()
