import { tauriBridge } from './tauriBridge'
import { storagePersistence } from '../core/storagePersistence'
import {
  Track,
  Release,
  StorageMount,
  WatchedFolder,
  ScanProgressPayload,
  ScanCompletePayload,
  SkippedFile,
} from '../core/types'
import { getCuratedAlbumArtwork } from '../core/taxonomyUtils'
import { listen, UnlistenFn } from '@tauri-apps/api/event'

export interface MigrationResult {
  migrated: boolean
  tracksCount: number
  releasesCount: number
  mountsCount: number
}

export class SqliteLibraryService {
  private unlistenProgress: UnlistenFn | null = null
  private unlistenChunk: UnlistenFn | null = null
  private unlistenComplete: UnlistenFn | null = null

  /**
   * Checks if SQLite database has data. If empty, automatically migrates
   * any existing scan data from browser IndexedDB (CadenceCoreDB).
   */
  public async checkAndMigrateFromIndexedDB(): Promise<MigrationResult> {
    if (!tauriBridge.isTauri()) {
      return { migrated: false, tracksCount: 0, releasesCount: 0, mountsCount: 0 }
    }

    try {
      const [tracksCount] = await tauriBridge.dbGetLibraryStats()
      if (tracksCount > 0) {
        // SQLite already populated
        return { migrated: false, tracksCount, releasesCount: 0, mountsCount: 0 }
      }

      // Check legacy IndexedDB
      const legacyData = await storagePersistence.loadLibrary()
      if (
        legacyData &&
        Array.isArray(legacyData.tracks) &&
        legacyData.tracks.length > 0
      ) {
        console.log(
          `[SqliteLibraryService] Migrating ${legacyData.tracks.length} tracks from IndexedDB to SQLite...`
        )

        // Map legacy storage mounts
        if (legacyData.storageMounts && legacyData.storageMounts.length > 0) {
          for (const mount of legacyData.storageMounts) {
            await tauriBridge.dbSaveStorageMount({
              id: mount.id,
              name: mount.name,
              mountPath: mount.mountPath,
              type: mount.type,
              fileSystem: mount.fileSystem,
              totalBytes: mount.totalBytes,
              usedBytes: mount.usedBytes,
              isReadOnlyLocked: mount.isReadOnlyLocked,
              status: mount.status || 'online',
              healthScore: mount.healthScore,
              smartOk: mount.smartOk,
              tempCelsius: mount.tempCelsius,
              lastSeenTimestamp: new Date().toISOString(),
            })

            // Register watched folder for the mount
            await tauriBridge.dbSaveWatchedFolder({
              id: `watch-${mount.id}`,
              mountId: mount.id,
              folderPath: mount.mountPath,
              displayName: mount.name,
              scanMode: 'realtime',
              ignorePatterns: null,
              isEnabled: true,
              lastScannedTimestamp: new Date().toISOString(),
            })
          }
        }

        // Map tracks and releases to SQLite format
        const dbTracks = legacyData.tracks.map((t) => ({
          id: t.id,
          releaseId: t.releaseId,
          mountId: t.storageMountId,
          folderPath: t.folderPath || '',
          folderName: t.folderName || '',
          filePath: t.filePath,
          fileName: t.filePath.split(/[/\\]/).pop() || t.title,
          fileSize: t.fileSize,
          mtime: Math.floor(new Date(t.modifiedTimestamp || Date.now()).getTime() / 1000),
          title: t.title,
          artistCredit: t.artistCredit,
          albumTitle: t.pendingSidecarEdits?.album || 'Unknown Album',
          releaseYear: t.pendingSidecarEdits?.year || null,
          trackNumber: t.trackNumber,
          genre: t.pendingSidecarEdits?.genre || null,
          composer: t.composerName || null,
          durationSecs: t.durationSeconds || t.duration || 0,
          format: t.format,
          sampleRate: t.sampleRateStr ? parseInt(t.sampleRateStr) : null,
          bitDepth: null,
          channels: null,
          drScore: t.drScore != null ? t.drScore : null,
          drSource: t.drSource || null,
          hasEmbeddedArt: false,
          sidecarStatus: t.sidecarStatus || 'in_sync',
          sidecarEditsJson: t.pendingSidecarEdits ? JSON.stringify(t.pendingSidecarEdits) : null,
          isOnline: true,
          workTitle: t.workTitle || null,
          movementNumber: t.movementNumber || null,
          movementTitle: t.movementTitle || null,
          createdAt: new Date().toISOString(),
        }))

        const dbReleases = (legacyData.releases || []).map((r) => ({
          id: r.id,
          title: r.title,
          folderPath: r.folderPath || '',
          folderName: r.folderName || '',
          artistCredit: r.artistCredit,
          composerName: r.composerName || null,
          releaseYear: r.releaseYear || null,
          genreTags: r.genreTags ? JSON.stringify(r.genreTags) : null,
          frontCoverUrl: r.artwork?.frontCoverUrl || null,
          backdropUrl: r.artwork?.backdropUrl || null,
          targetFolderPath: r.targetFolderPath || null,
          createdAt: new Date().toISOString(),
        }))

        await tauriBridge.dbSaveTracksBatch(dbTracks, dbReleases)

        return {
          migrated: true,
          tracksCount: dbTracks.length,
          releasesCount: dbReleases.length,
          mountsCount: (legacyData.storageMounts || []).length,
        }
      }
    } catch (err) {
      console.warn('[SqliteLibraryService] Migration check failed:', err)
    }

    return { migrated: false, tracksCount: 0, releasesCount: 0, mountsCount: 0 }
  }

  /**
   * Load entire library state from SQLite
   */
  public async loadLibraryFromDb(options?: { onlyOnline?: boolean }): Promise<{
    tracks: Track[]
    releases: Release[]
    storageMounts: StorageMount[]
    watchedFolders: WatchedFolder[]
    skippedFiles: SkippedFile[]
    offlineMounts: StorageMount[]
    offlineTracksCount: number
    offlineReleasesCount: number
  } | null> {
    if (!tauriBridge.isTauri()) return null

    try {
      // 1. Proactively verify accessibility of storage mounts and network folders
      await tauriBridge.checkStorageMountsAccessibility()

      // 2. Fetch mounts, folders, tracks, releases, and offline statistics
      const onlyOnline = options?.onlyOnline ?? false
      const [rawMounts, rawFolders, rawTracks, rawReleases, rawSkipped, offlineCounts] = await Promise.all([
        tauriBridge.dbGetStorageMounts(),
        tauriBridge.dbGetWatchedFolders(),
        tauriBridge.dbGetTracks(undefined, undefined, onlyOnline),
        tauriBridge.dbGetReleases(onlyOnline),
        tauriBridge.dbGetSkippedFiles(),
        tauriBridge.dbGetOfflineCounts(),
      ])

      const [offlineTracksCount, offlineReleasesCount] = offlineCounts || [0, 0]

      if (rawTracks.length === 0 && rawMounts.length === 0 && offlineTracksCount === 0) {
        return null
      }

      // Transform raw SQLite rows to typed UI entities
      const storageMounts: StorageMount[] = rawMounts.map((m) => ({
        id: m.id,
        name: m.name,
        mountPath: m.mountPath,
        type: m.type,
        fileSystem: m.fileSystem,
        totalBytes: m.totalBytes,
        usedBytes: m.usedBytes,
        isReadOnlyLocked: m.isReadOnlyLocked,
        healthScore: m.healthScore,
        smartOk: m.smartOk,
        tempCelsius: m.tempCelsius,
        status: m.status,
        lastSeenTimestamp: m.lastSeenTimestamp,
      }))

      const offlineMounts = storageMounts.filter((m) => m.status === 'offline')

      const watchedFolders: WatchedFolder[] = rawFolders.map((f: any) => ({
        id: f.id,
        mountId: f.mountId || f.mount_id,
        folderPath: f.folderPath || f.folder_path,
        displayName: f.displayName || f.display_name,
        scanMode: f.scanMode || f.scan_mode,
        ignorePatterns: f.ignorePatterns || f.ignore_patterns,
        isEnabled: Boolean(f.isEnabled ?? f.is_enabled ?? true),
        lastScannedTimestamp: f.lastScannedTimestamp || f.last_scanned_timestamp,
        lastScanned: f.lastScannedTimestamp || f.last_scanned_timestamp,
        trackCount: f.trackCount ?? f.track_count ?? 0,
      }))

      const releases: Release[] = rawReleases.map((r) => {
        const rawCover = r.frontCoverUrl || ''
        const coverArtUrl = rawCover || getCuratedAlbumArtwork(r.title, r.composerName || r.artistCredit)
        return {
          id: r.id,
          masterReleaseId: r.id,
          title: r.title,
          folderName: r.folderName,
          folderPath: r.folderPath,
          targetFolderPath: r.targetFolderPath,
          artistCredit: r.artistCredit,
          composerName: r.composerName,
          releaseYear: r.releaseYear || 0,
          originalYear: r.releaseYear || 0,
          label: 'Lossless Master',
          catalogNumber: 'CAD-001',
          mediaFormat: 'Lossless Audio',
          country: 'Global',
          matrixRunout: '',
          artwork: {
            frontCoverUrl: coverArtUrl,
            backdropUrl: r.backdropUrl,
            resolution: '3000x3000px',
            width: 3000,
            height: 3000,
            dpi: 300,
            colorProfile: 'sRGB',
            isLowRes: false,
            hasBookletPdf: false,
          },
          variants: [],
          discsCount: 1,
          tracksCount: 0,
          genreTags: r.genreTags ? JSON.parse(r.genreTags) : [],
          storageMountId: storageMounts[0]?.id || '',
        }
      })

      const tracks: Track[] = rawTracks.map((t) => ({
        id: t.id,
        releaseId: t.releaseId,
        recordingId: t.id,
        trackNumber: t.trackNumber || 1,
        discNumber: 1,
        title: t.title,
        workTitle: t.workTitle,
        movementNumber: t.movementNumber,
        movementTitle: t.movementTitle,
        composerName: t.composer,
        artistCredit: t.artistCredit,
        durationSeconds: t.durationSecs || 0,
        filePath: t.filePath,
        fileSize: t.fileSize,
        storageMountId: t.mountId,
        folderName: t.folderName,
        folderPath: t.folderPath,
        sidecarStatus: t.sidecarStatus as any,
        pendingSidecarEdits: t.sidecarEditsJson ? JSON.parse(t.sidecarEditsJson) : undefined,
        modifiedTimestamp: new Date(t.mtime * 1000).toISOString(),
        checksumValid: true,
        accurateRipConfidence: 100,
        drScore: t.drScore || 0,
        drSource: t.drScore ? 'estimated' : undefined,
        sampleRateStr: t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)}kHz` : '44.1kHz',
        format: (t.format || 'FLAC') as any,
        isHighRes: (t.sampleRate || 0) > 48000 || (t.bitDepth || 16) > 16,
        isOnline: t.isOnline,
        credits: [],
        masterReleaseId: t.releaseId,
      }))

      const skippedFiles: SkippedFile[] = rawSkipped.map((s) => ({
        id: s.id,
        filePath: s.filePath,
        fileName: s.fileName,
        category: s.category as any,
        diagnosticError: s.diagnosticError,
        timestamp: s.timestamp,
        isIgnored: s.isIgnored,
      }))

      return {
        tracks,
        releases,
        storageMounts,
        watchedFolders,
        skippedFiles,
        offlineMounts,
        offlineTracksCount,
        offlineReleasesCount,
      }
    } catch (err) {
      console.error('[SqliteLibraryService] Failed to load library from SQLite:', err)
      return null
    }
  }

  /**
   * Subscribe to real-time native scanner events
   */
  public async subscribeToScannerEvents(handlers: {
    onProgress?: (payload: ScanProgressPayload) => void
    onChunk?: (payload: { tracks: Track[]; releases: Release[] }) => void
    onComplete?: (payload: ScanCompletePayload) => void
  }): Promise<void> {
    if (!tauriBridge.isTauri()) return

    this.cleanupListeners()

    if (handlers.onProgress) {
      this.unlistenProgress = await listen<ScanProgressPayload>(
        'library://scan-progress',
        (event) => handlers.onProgress?.(event.payload)
      )
    }

    if (handlers.onChunk) {
      this.unlistenChunk = await listen<any>('library://scan-chunk', (event) => {
        const payload = event.payload
        // Transform chunk tracks & releases
        const convertedTracks: Track[] = (payload.tracks || []).map((t: any) => ({
          id: t.id,
          releaseId: t.releaseId,
          recordingId: t.id,
          trackNumber: t.trackNumber || 1,
          discNumber: 1,
          title: t.title,
          workTitle: t.workTitle,
          movementNumber: t.movementNumber,
          movementTitle: t.movementTitle,
          composerName: t.composer,
          artistCredit: t.artistCredit,
          durationSeconds: t.durationSecs || 0,
          filePath: t.filePath,
          fileSize: t.fileSize,
          storageMountId: t.mountId,
          folderName: t.folderName,
          folderPath: t.folderPath,
          sidecarStatus: t.sidecarStatus as any,
          modifiedTimestamp: new Date(t.mtime * 1000).toISOString(),
          checksumValid: true,
          accurateRipConfidence: 100,
          drScore: t.drScore || 0,
          drSource: t.drScore ? 'estimated' : undefined,
          sampleRateStr: t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)}kHz` : '44.1kHz',
          format: (t.format || 'FLAC') as any,
          isHighRes: (t.sampleRate || 0) > 48000,
          isOnline: t.isOnline !== false,
          credits: [],
          masterReleaseId: t.releaseId,
        }))

        const convertedReleases: Release[] = (payload.releases || []).map((r: any) => ({
          id: r.id,
          masterReleaseId: r.id,
          title: r.title,
          folderName: r.folderName,
          folderPath: r.folderPath,
          artistCredit: r.artistCredit,
          composerName: r.composerName,
          releaseYear: r.releaseYear || 0,
          originalYear: r.releaseYear || 0,
          label: 'Lossless Master',
          catalogNumber: 'CAD-001',
          mediaFormat: 'Lossless Audio',
          country: 'Global',
          matrixRunout: '',
          artwork: {
            frontCoverUrl: r.frontCoverUrl || '',
            backdropUrl: r.backdropUrl,
            resolution: '3000x3000px',
            width: 3000,
            height: 3000,
            dpi: 300,
            colorProfile: 'sRGB',
            isLowRes: false,
            hasBookletPdf: false,
          },
          variants: [],
          discsCount: 1,
          tracksCount: 0,
          genreTags: r.genreTags ? JSON.parse(r.genreTags) : [],
          storageMountId: '',
        }))

        handlers.onChunk?.({ tracks: convertedTracks, releases: convertedReleases })
      })
    }

    if (handlers.onComplete) {
      this.unlistenComplete = await listen<ScanCompletePayload>(
        'library://scan-complete',
        (event) => handlers.onComplete?.(event.payload)
      )
    }
  }

  /**
   * Persists release records (specifically frontCoverUrl and backdropUrl) to SQLite database
   */
  public async persistReleasesToDb(releases: Release[]): Promise<void> {
    if (!tauriBridge.isTauri() || releases.length === 0) return

    try {
      const dbReleases = releases.map((r) => ({
        id: r.id,
        title: r.title,
        folderPath: r.folderPath || '',
        folderName: r.folderName || '',
        artistCredit: r.artistCredit,
        composerName: r.composerName || null,
        releaseYear: r.releaseYear || null,
        genreTags: r.genreTags ? JSON.stringify(r.genreTags) : null,
        frontCoverUrl: r.artwork?.frontCoverUrl || null,
        backdropUrl: r.artwork?.backdropUrl || r.backdropUrl || null,
        targetFolderPath: r.targetFolderPath || null,
        createdAt: new Date().toISOString(),
      }))

      await tauriBridge.dbSaveTracksBatch([], dbReleases)
      console.log(`[SqliteLibraryService] Persisted ${dbReleases.length} releases to SQLite database.`)
    } catch (err) {
      console.warn('[SqliteLibraryService] Failed to persist releases to SQLite:', err)
    }
  }

  /**
   * Persists an individual release's artwork updates directly into SQLite
   */
  public async persistReleaseArtworkToDb(
    releaseId: string,
    artwork: { frontCoverUrl?: string; backdropUrl?: string }
  ): Promise<void> {
    if (!tauriBridge.isTauri()) return

    try {
      const rawReleases = await tauriBridge.dbGetReleases()
      const existing = rawReleases.find((r) => r.id === releaseId)
      if (existing) {
        const updated = {
          ...existing,
          frontCoverUrl: artwork.frontCoverUrl !== undefined ? artwork.frontCoverUrl : existing.frontCoverUrl,
          backdropUrl: artwork.backdropUrl !== undefined ? artwork.backdropUrl : existing.backdropUrl,
        }
        await tauriBridge.dbSaveTracksBatch([], [updated])
        console.log(`[SqliteLibraryService] Updated artwork for release "${existing.title}" in SQLite.`)
      }
    } catch (err) {
      console.warn('[SqliteLibraryService] Failed to update release artwork in SQLite:', err)
    }
  }

  /**
   * Synchronizes the full in-memory graph (tracks and releases) to native SQLite
   */
  public async persistLibraryToDb(tracks: Track[], releases: Release[]): Promise<void> {
    if (!tauriBridge.isTauri()) return

    try {
      const dbReleases = releases.map((r) => ({
        id: r.id,
        title: r.title,
        folderPath: r.folderPath || '',
        folderName: r.folderName || '',
        artistCredit: r.artistCredit,
        composerName: r.composerName || null,
        releaseYear: r.releaseYear || null,
        genreTags: r.genreTags ? JSON.stringify(r.genreTags) : null,
        frontCoverUrl: r.artwork?.frontCoverUrl || null,
        backdropUrl: r.artwork?.backdropUrl || r.backdropUrl || null,
        targetFolderPath: r.targetFolderPath || null,
        createdAt: new Date().toISOString(),
      }))

      const dbTracks = tracks.map((t) => {
        const p = t.filePath || ''
        const winMatch = p.match(/^([A-Za-z]:)/)
        const uncMatch = p.match(/^(\\\\[^\\]+\\[^\\]+)/)
        const rootKey = winMatch
          ? winMatch[1]
          : uncMatch
          ? uncMatch[1]
          : p.startsWith('/')
          ? '/' + p.split('/').filter(Boolean)[0]
          : 'Local Audio'
        const derivedMountId = `mount-${rootKey.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
        const mountId = t.storageMountId || derivedMountId

        return {
          id: t.id,
          releaseId: t.releaseId,
          mountId,
          folderPath: t.folderPath || '',
          folderName: t.folderName || '',
          filePath: t.filePath || '',
          fileName: t.title || '',
          fileSize: t.fileSize || 0,
          mtime: Math.floor(Date.now() / 1000),
          title: t.title,
          artistCredit: t.artistCredit || '',
          albumTitle: t.pendingSidecarEdits?.album || t.folderName || '',
          releaseYear: t.pendingSidecarEdits?.year || null,
          trackNumber: t.trackNumber,
          genre: t.pendingSidecarEdits?.genre || null,
          composer: t.composerName || null,
          durationSecs: t.durationSeconds || 0,
          format: t.format,
          sampleRate: t.sampleRateStr ? parseInt(t.sampleRateStr) : null,
          bitDepth: null,
          channels: null,
          drScore: t.drScore != null ? t.drScore : null,
          drSource: t.drSource || null,
          hasEmbeddedArt: false,
          sidecarStatus: t.sidecarStatus || 'in_sync',
          sidecarEditsJson: t.pendingSidecarEdits ? JSON.stringify(t.pendingSidecarEdits) : null,
          isOnline: true,
          workTitle: t.workTitle || null,
          movementNumber: t.movementNumber || null,
          movementTitle: t.movementTitle || null,
          createdAt: new Date().toISOString(),
        }
      })

      await tauriBridge.dbSaveTracksBatch(dbTracks, dbReleases)
      console.log(`[SqliteLibraryService] Synchronized ${dbTracks.length} tracks and ${dbReleases.length} releases to SQLite.`)
    } catch (err) {
      console.warn('[SqliteLibraryService] Failed to synchronize library to SQLite:', err)
    }
  }

  public cleanupListeners(): void {
    if (this.unlistenProgress) {
      this.unlistenProgress()
      this.unlistenProgress = null
    }
    if (this.unlistenChunk) {
      this.unlistenChunk()
      this.unlistenChunk = null
    }
    if (this.unlistenComplete) {
      this.unlistenComplete()
      this.unlistenComplete = null
    }
  }
}

export const sqliteLibraryService = new SqliteLibraryService()
