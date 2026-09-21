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
          drScore: t.drScore || 12,
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
  public async loadLibraryFromDb(): Promise<{
    tracks: Track[]
    releases: Release[]
    storageMounts: StorageMount[]
    watchedFolders: WatchedFolder[]
    skippedFiles: SkippedFile[]
  } | null> {
    if (!tauriBridge.isTauri()) return null

    try {
      const [rawMounts, rawFolders, rawTracks, rawReleases, rawSkipped] = await Promise.all([
        tauriBridge.dbGetStorageMounts(),
        tauriBridge.dbGetWatchedFolders(),
        tauriBridge.dbGetTracks(),
        tauriBridge.dbGetReleases(),
        tauriBridge.dbGetSkippedFiles(),
      ])

      if (rawTracks.length === 0 && rawMounts.length === 0) {
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

      const watchedFolders: WatchedFolder[] = rawFolders.map((f) => ({
        id: f.id,
        mountId: f.mountId,
        folderPath: f.folderPath,
        displayName: f.displayName,
        scanMode: f.scanMode,
        ignorePatterns: f.ignorePatterns,
        isEnabled: f.isEnabled,
        lastScannedTimestamp: f.lastScannedTimestamp,
      }))

      const releases: Release[] = rawReleases.map((r) => ({
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
        storageMountId: storageMounts[0]?.id || '',
      }))

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
        drScore: t.drScore || 12,
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
          drScore: t.drScore || 12,
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
