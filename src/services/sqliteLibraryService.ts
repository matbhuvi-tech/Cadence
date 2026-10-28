import { tauriBridge } from './tauriBridge'
import { storagePersistence } from '../core/storagePersistence'
import { graphEngine } from '../core/graphEngine'
import {
  Track,
  Release,
  StorageMount,
  WatchedFolder,
  ScanProgressPayload,
  ScanCompletePayload,
  SkippedFile,
  ArtistSummary,
  ArtistCreditItem,
  ArtistDetail,
  AudioFormat,
  Playlist,
  PressingVariant,
  UpdateArtistEditorialPayload,
} from '../core/types'
import { getCuratedAlbumArtwork, splitMultiArtistCredits, generateMonogramAvatar, stripRipNoiseAndTags, disambiguateComboTitle, extractMeaningfulFolderName } from '../core/taxonomyUtils'
import type { UnlistenFn } from '@tauri-apps/api/event'

export interface MigrationResult {
  migrated: boolean
  tracksCount: number
  releasesCount: number
  mountsCount: number
}

/**
 * Formats sample rate strings and normalizes audio format for audiophile precision.
 * Correctly distinguishes DSD rates (DSD64 to DSD1024) from linear PCM kHz clocks.
 */
export function formatAudioSpecs(
  rawFormat?: string,
  sampleRate?: number | null,
  bitDepth?: number | null,
  filePath?: string
): { format: AudioFormat; sampleRateStr: string; isHighRes: boolean } {
  const fmtUpper = (rawFormat || '').toUpperCase()
  const pathLower = (filePath || '').toLowerCase()
  const sRate = sampleRate || 0
  const bits = bitDepth || 16

  const isDsd =
    fmtUpper === 'DSD' ||
    fmtUpper === 'DSF' ||
    fmtUpper === 'DFF' ||
    pathLower.endsWith('.dsf') ||
    pathLower.endsWith('.dff') ||
    bits === 1 ||
    sRate > 1000000

  if (isDsd) {
    let sampleRateStr = 'DSD64 (2.82MHz)'
    if (sRate >= 36000000 || pathLower.includes('dsd1024')) {
      sampleRateStr = 'DSD1024 (45.2MHz)'
    } else if (sRate >= 18000000 || pathLower.includes('dsd512')) {
      sampleRateStr = 'DSD512 (22.6MHz)'
    } else if (
      sRate >= 9000000 ||
      pathLower.includes('dsd256') ||
      pathLower.includes('11.2mhz') ||
      pathLower.includes('11.3') ||
      pathLower.includes('11289')
    ) {
      sampleRateStr = 'DSD256 (11.3MHz)'
    } else if (
      sRate >= 4500000 ||
      pathLower.includes('dsd128') ||
      pathLower.includes('5.6mhz') ||
      pathLower.includes('5644')
    ) {
      sampleRateStr = 'DSD128 (5.64MHz)'
    } else if (
      sRate >= 2000000 ||
      pathLower.includes('dsd64') ||
      pathLower.includes('2.8mhz') ||
      pathLower.includes('2822')
    ) {
      sampleRateStr = 'DSD64 (2.82MHz)'
    } else if (sRate === 352800 || pathLower.includes('dxd')) {
      sampleRateStr = 'DXD (352.8kHz)'
    } else if (sRate > 192000) {
      sampleRateStr = `DSD (${(sRate / 1000000).toFixed(2)}MHz)`
    }

    return {
      format: 'DSD',
      sampleRateStr,
      isHighRes: true,
    }
  }

  // PCM formats
  let format: AudioFormat = 'FLAC'
  if (fmtUpper === 'WAV' || pathLower.endsWith('.wav')) format = 'WAV'
  else if (fmtUpper === 'ALAC' || pathLower.endsWith('.alac') || pathLower.endsWith('.m4a')) format = 'ALAC'
  else if (fmtUpper === 'MP3' || pathLower.endsWith('.mp3')) format = 'MP3'
  else if (fmtUpper === 'AAC' || pathLower.endsWith('.aac')) format = 'AAC'
  else format = 'FLAC'

  // Audiophile guard: Valid linear PCM sample rates are never below 8000 Hz
  const effectiveRate = sRate >= 8000 ? sRate : 44100
  const khz = (effectiveRate / 1000).toFixed(effectiveRate % 1000 === 0 ? 0 : 1)
  const sampleRateStr = `${bits}/${khz}kHz`
  const isHighRes = effectiveRate > 48000 || bits > 16

  return { format, sampleRateStr, isHighRes }
}

/**
 * Robust parser converting polymorphic rate strings (e.g., "16/44.1", "24/96", "44.1kHz", "DSD64")
 * into bit-accurate sampleRate (Hz) and bitDepth (bits) integers.
 */
export function parseAudioSpecsFromString(
  sampleRateStr?: string,
  existingSampleRate?: number | null,
  existingBitDepth?: number | null
): { sampleRate: number | null; bitDepth: number | null } {
  let sampleRate: number | null = existingSampleRate && existingSampleRate >= 8000 ? existingSampleRate : null
  let bitDepth: number | null = existingBitDepth && existingBitDepth > 0 ? existingBitDepth : null

  if (sampleRate && bitDepth) {
    return { sampleRate, bitDepth }
  }

  const str = (sampleRateStr || '').trim()
  if (!str) return { sampleRate: sampleRate || 44100, bitDepth: bitDepth || 16 }

  // 1. DSD clocks
  if (/dsd1024/i.test(str)) {
    return { sampleRate: 45158400, bitDepth: 1 }
  } else if (/dsd512/i.test(str)) {
    return { sampleRate: 22579200, bitDepth: 1 }
  } else if (/dsd256/i.test(str)) {
    return { sampleRate: 11289600, bitDepth: 1 }
  } else if (/dsd128/i.test(str)) {
    return { sampleRate: 5644800, bitDepth: 1 }
  } else if (/dsd64/i.test(str) || /dsd/i.test(str)) {
    return { sampleRate: 2822400, bitDepth: 1 }
  }

  // 2. Dual notation "16/44.1" or "24/96" or "24/192.0"
  const slashMatch = str.match(/^(\d{1,2})\s*[\/|\\]\s*(\d+(?:\.\d+)?)/)
  if (slashMatch) {
    const bits = parseInt(slashMatch[1], 10)
    const rateKhz = parseFloat(slashMatch[2])
    const rateHz = Math.round(rateKhz < 1000 ? rateKhz * 1000 : rateKhz)
    return {
      sampleRate: sampleRate || rateHz,
      bitDepth: bitDepth || bits,
    }
  }

  // 3. Clocks ending with kHz e.g. "44.1kHz", "96kHz"
  const khzMatch = str.match(/(\d+(?:\.\d+)?)\s*khz/i)
  if (khzMatch) {
    const rateKhz = parseFloat(khzMatch[1])
    const rateHz = Math.round(rateKhz < 1000 ? rateKhz * 1000 : rateKhz)
    return {
      sampleRate: sampleRate || rateHz,
      bitDepth: bitDepth || 16,
    }
  }

  // 4. Raw Hz clock e.g. "44100", "96000"
  const num = parseInt(str, 10)
  if (!isNaN(num) && num >= 8000) {
    return {
      sampleRate: sampleRate || num,
      bitDepth: bitDepth || 16,
    }
  }

  return { sampleRate: sampleRate || 44100, bitDepth: bitDepth || 16 }
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
          sampleRate: parseAudioSpecsFromString(t.sampleRateStr, t.sampleRate, t.bitDepth).sampleRate,
          bitDepth: parseAudioSpecsFromString(t.sampleRateStr, t.sampleRate, t.bitDepth).bitDepth,
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

      // 1. Process tracks first so format and technical audio specs are resolved
      const tracks: Track[] = rawTracks.map((t) => {
        const specs = formatAudioSpecs(t.format, t.sampleRate, t.bitDepth, t.filePath)
        return {
          id: t.id,
          releaseId: t.releaseId,
          recordingId: t.id,
          trackNumber: t.trackNumber || 1,
          discNumber: 1,
          title: t.title,
          workTitle: t.workTitle,
          movementNumber: t.movementNumber,
          movementTitle: t.movementTitle,
          composerName: (t.sidecarEditsJson ? (JSON.parse(t.sidecarEditsJson).composerName ?? t.composer) : t.composer),
          artistCredit: (t.sidecarEditsJson ? (JSON.parse(t.sidecarEditsJson).artistCredit ?? t.artistCredit) : t.artistCredit),
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
          sampleRateStr: specs.sampleRateStr,
          format: specs.format,
          isHighRes: specs.isHighRes,
          sampleRate: t.sampleRate || undefined,
          bitDepth: t.bitDepth || undefined,
          isOnline: t.isOnline,
          isCompilation: Boolean(t.isCompilation),
          albumArtist: (t.sidecarEditsJson ? (JSON.parse(t.sidecarEditsJson).albumArtist ?? t.albumArtist) : t.albumArtist) || undefined,
          originalAlbum: t.originalAlbum || undefined,
          originalYear: t.originalYear || undefined,
          acoustidFingerprint: t.acoustidFingerprint || undefined,
          musicbrainzRecordingId: t.musicbrainzRecordingId || undefined,
          releaseTitle: (t as any).album_title || t.folderName,
          albumTitle: (t as any).album_title || t.folderName,
          credits: [],
          masterReleaseId: t.releaseId,
        }
      })

      // 2. Index tracks by releaseId to calculate format roll-ups
      const releaseTracksMap = new Map<string, Track[]>()
      tracks.forEach((t) => {
        const list = releaseTracksMap.get(t.releaseId) || []
        list.push(t)
        releaseTracksMap.set(t.releaseId, list)
      })

      // 2.5 Disambiguate multi-soundtrack combo releases (e.g. "Chinna Thambi/Dharma Dorai/Captain Prabhakaran" against folder name)
      rawReleases.forEach((r) => {
        const disambig = disambiguateComboTitle(r.title, r.folderName || r.folderPath)
        if (disambig.isCombo) {
          ;(r as any).physicalComboTitle = disambig.physicalComboTitle
          r.title = disambig.resolvedTitle
        }
      })

      // 3. Cluster releases into Canonical Master Albums (Release Groups)
      // Group by normalized title + primary composer/artist (with unknown artist coalescing)
      const isGenericTitle = (title: string) =>
        /^(greatest hits|best of|hits|collection|anthology|live|various|soundtrack|unknown)$/i.test(title.trim())

      const isUnknownArtist = (artist: string) =>
        !artist || /^(unknown artist|unknown|various artists|various)$/i.test(artist.trim())

      const masterGroupMap = new Map<string, typeof rawReleases>()

      rawReleases.forEach((r) => {
        const cleanTitle = stripRipNoiseAndTags(r.title).toLowerCase().trim()
        const rawArtist = (r.composerName || r.artistCredit || '').toLowerCase().trim()
        const isUnknown = isUnknownArtist(rawArtist)

        // Find existing group by title
        let matchingKey: string | undefined
        for (const existingKey of Array.from(masterGroupMap.keys())) {
          const [groupTitle, groupArtist] = existingKey.split('::')
          if (groupTitle === cleanTitle) {
            if (!isGenericTitle(cleanTitle)) {
              // Specific title: if artists match, or either is unknown, merge!
              if (groupArtist === rawArtist || isUnknown || isUnknownArtist(groupArtist)) {
                matchingKey = existingKey
                break
              }
            } else if (groupArtist === rawArtist) {
              matchingKey = existingKey
              break
            }
          }
        }

        if (matchingKey) {
          const groupRels = masterGroupMap.get(matchingKey)!
          // If existing group had an unknown artist but current release has a known artist, upgrade group key
          const [, groupArtist] = matchingKey.split('::')
          if (isUnknownArtist(groupArtist) && !isUnknown) {
            const upgradedKey = `${cleanTitle}::${rawArtist}`
            masterGroupMap.delete(matchingKey)
            groupRels.push(r)
            masterGroupMap.set(upgradedKey, groupRels)
          } else {
            groupRels.push(r)
          }
        } else {
          const groupKey = `${cleanTitle}::${rawArtist}`
          masterGroupMap.set(groupKey, [r])
        }
      })

      // Map each raw release to its masterReleaseId and variant stack
      const releaseMasterMap = new Map<string, { masterId: string; variants: PressingVariant[] }>()
      masterGroupMap.forEach((groupRels) => {
        // Sort releases so that known artists and high-quality rips serve as primary release
        groupRels.sort((a, b) => {
          const aUnknown = isUnknownArtist(a.composerName || a.artistCredit || '')
          const bUnknown = isUnknownArtist(b.composerName || b.artistCredit || '')
          if (aUnknown && !bUnknown) return 1
          if (!aUnknown && bUnknown) return -1
          return 0
        })

        const primaryRel = groupRels[0]
        const masterId = groupRels.length > 1 ? `master-${primaryRel.id}` : primaryRel.id

        // Propagate known artist and composer from primary release to any unknown release in group
        groupRels.forEach((gr) => {
          if (isUnknownArtist(gr.artistCredit) && !isUnknownArtist(primaryRel.artistCredit)) {
            gr.artistCredit = primaryRel.artistCredit
          }
          if (!gr.composerName && primaryRel.composerName) {
            gr.composerName = primaryRel.composerName
          }
        })

        // Build pressing variants for all releases in this master album
        const variants: PressingVariant[] = groupRels.map((gr, idx) => {
          const rTracks = releaseTracksMap.get(gr.id) || []
          const formats = Array.from(new Set(rTracks.map((t) => t.format)))
          const dominantFormat = formats[0] || 'FLAC'
          const dominantRate = rTracks[0]?.sampleRateStr || '16-bit / 44.1kHz'
          const avgDr = rTracks.length > 0 ? Math.round(rTracks.reduce((acc, t) => acc + (t.drScore || 0), 0) / rTracks.length) : 12

          // Compute distinctive descriptor for variants
          const fNameLower = (gr.folderName || '').toLowerCase()
          const fPathLower = (gr.folderPath || '').toLowerCase()
          let descriptor = ''
          if ((gr as any).physicalComboTitle) {
            descriptor = `Combo CD: ${(gr as any).physicalComboTitle}`
          } else if (fNameLower.includes('cd rip') || fPathLower.includes('cd rip') || fNameLower.includes('cdrip') || fPathLower.includes('cdrip')) {
            descriptor = 'CD Rip'
          } else if (fNameLower.includes('vinyl') || fPathLower.includes('vinyl') || fPathLower.includes('lp')) {
            descriptor = 'Vinyl Master'
          } else if (dominantFormat.includes('DSD') || fNameLower.includes('dsd') || fPathLower.includes('sacd')) {
            descriptor = 'DSD Transfer'
          } else if (dominantRate.includes('24-bit') || dominantRate.includes('192') || dominantRate.includes('96')) {
            descriptor = 'Hi-Res Edition'
          } else if (groupRels.length > 1) {
            const cleanFolder = stripRipNoiseAndTags(gr.folderName || '')
            if (cleanFolder && cleanFolder.toLowerCase() !== gr.title.toLowerCase()) {
              descriptor = cleanFolder
            } else {
              descriptor = 'Standalone Master'
            }
          }

          let variantName = descriptor
            ? `${descriptor} (${dominantFormat} · DR${avgDr})`
            : `${gr.releaseYear || ''} ${dominantFormat} Edition (DR${avgDr})`.trim()
          if (!variantName) variantName = `${dominantFormat} Master`

          const meaningfulFolder = extractMeaningfulFolderName(gr.folderName, gr.folderPath, gr.artistCredit)

          return {
            id: `var-${gr.id}`,
            releaseId: gr.id,
            masterReleaseId: masterId,
            releaseName: gr.title,
            variantName,
            folderName: meaningfulFolder,
            folderPath: gr.folderPath || '',
            releaseYear: gr.releaseYear || 0,
            drScore: avgDr,
            sampleRateStr: dominantRate,
            formatStr: dominantFormat,
            matrixRunout: gr.id.slice(0, 8).toUpperCase(),
            catalogNumber: 'CAD-001',
            label: dominantFormat.includes('DSD') ? 'Direct DSD Transfer' : 'Lossless Master',
            isCurrentMaster: idx === 0,
            country: 'Global',
          }
        })

        groupRels.forEach((gr) => {
          releaseMasterMap.set(gr.id, { masterId, variants })
        })
      })

      // 4. Construct final Release objects with masterReleaseId and populated variants
      const releases: Release[] = rawReleases.map((r) => {
        const rawCover = r.frontCoverUrl || ''
        const coverArtUrl = rawCover || getCuratedAlbumArtwork(r.title, r.composerName || r.artistCredit)
        const groupInfo = releaseMasterMap.get(r.id)
        const rTracks = releaseTracksMap.get(r.id) || []
        const formats = Array.from(new Set(rTracks.map((t) => t.format)))

        return {
          id: r.id,
          masterReleaseId: groupInfo?.masterId || r.id,
          title: r.title,
          folderName: r.folderName,
          folderPath: r.folderPath,
          targetFolderPath: r.targetFolderPath,
          artistCredit: r.artistCredit,
          composerName: r.composerName,
          releaseYear: r.releaseYear || 0,
          originalYear: r.releaseYear || 0,
          label: formats.some((f) => f.includes('DSD')) ? 'Direct DSD Transfer' : 'Lossless Master',
          catalogNumber: 'CAD-001',
          mediaFormat: formats[0] || 'Lossless Audio',
          country: 'Global',
          matrixRunout: '',
          artwork: {
            frontCoverUrl: coverArtUrl,
            backdropUrl: r.backdropUrl,
            resolution: coverArtUrl ? '3000x3000px' : 'No Embedded Art',
            width: coverArtUrl ? 3000 : 0,
            height: coverArtUrl ? 3000 : 0,
            dpi: coverArtUrl ? 300 : 72,
            colorProfile: 'sRGB',
            isLowRes: !coverArtUrl,
            hasBookletPdf: false,
          },
          isCompilation: Boolean(r.isCompilation),
          physicalComboTitle: (r as any).physicalComboTitle || r.physicalComboTitle,
          variants: groupInfo?.variants || [],
          discsCount: 1,
          tracksCount: rTracks.length,
          genreTags: r.genreTags ? JSON.parse(r.genreTags) : [],
          storageMountId: storageMounts[0]?.id || '',
        }
      })

      // 5. Cross-Album Song Graph: Link Compilation Songs to Original Soundtrack Releases
      interface OriginalSoundtrackInfo {
        albumTitle: string
        releaseId: string
        masterReleaseId: string
        releaseYear?: number
      }

      const isCompilation = (r: { title: string; folderName?: string; isCompilation?: boolean; id?: string }) => {
        if (r.isCompilation) return true
        if (r.id) {
          const rTracks = releaseTracksMap.get(r.id) || []
          if (rTracks.some((t) => t.isCompilation)) return true
          if (rTracks.some((t) => t.albumArtist && /^(various artists|various|v\/a)$/i.test(t.albumArtist.trim()))) {
            return true
          }
        }
        const combined = `${r.title || ''} ${r.folderName || ''}`.toLowerCase()
        return /\b(hits|collection|best of|anthology|platinum|duets|melodies|greatest hits|golden hits|favorites|vol\s*\d+|volume\s*\d+|top\s*\d+|super\s*hits|megahits|world of|classics|revisited|essential|tribute|celebration|unforgettable|cd\s*\d+|disc\s*\d+)\b|mania/i.test(combined)
      }

      const soundtrackMap = new Map<string, OriginalSoundtrackInfo>() // songKey -> OriginalSoundtrackInfo
      const soundtrackTitleMap = new Map<string, OriginalSoundtrackInfo>() // cleanTitle -> OriginalSoundtrackInfo
      const releaseTitleMap = new Map<string, OriginalSoundtrackInfo>() // cleanReleaseTitle -> OriginalSoundtrackInfo

      // Index non-compilation release titles
      releases.forEach((r) => {
        if (!isCompilation(r) && r.title) {
          const cleanRel = stripRipNoiseAndTags(r.title).toLowerCase().trim()
          if (cleanRel.length > 2) {
            releaseTitleMap.set(cleanRel, {
              albumTitle: r.title,
              releaseId: r.id,
              masterReleaseId: r.masterReleaseId || r.id,
              releaseYear: r.releaseYear || r.originalYear,
            })
          }
        }
      })

      // Index non-compilation tracks with EARLIEST release year priority
      tracks.forEach((t) => {
        const parentRel = releases.find((r) => r.id === t.releaseId)
        if (parentRel && !isCompilation(parentRel) && parentRel.title) {
          const cleanTitle = stripRipNoiseAndTags(t.title).toLowerCase().trim()
          const artComp = (t.composerName || t.artistCredit || '').toLowerCase().trim()
          const year = parentRel.releaseYear || parentRel.originalYear || 9999
          const info: OriginalSoundtrackInfo = {
            albumTitle: parentRel.title,
            releaseId: parentRel.id,
            masterReleaseId: parentRel.masterReleaseId || parentRel.id,
            releaseYear: parentRel.releaseYear || parentRel.originalYear,
          }

          if (cleanTitle.length > 2) {
            const key = `${cleanTitle}::${artComp}`
            const existing = soundtrackMap.get(key)
            if (!existing || (existing.releaseYear || 9999) > year) {
              soundtrackMap.set(key, info)
            }
            const existingTitle = soundtrackTitleMap.get(cleanTitle)
            if (!existingTitle || (existingTitle.releaseYear || 9999) > year) {
              soundtrackTitleMap.set(cleanTitle, info)
            }
          }
        }
      })

      // Detect repeated movie titles in hyphenated tracks across compilation releases (e.g. "Rockstar", "Blue", "Highway")
      const hyphenMovieCounts = new Map<string, number>()
      tracks.forEach((t) => {
        const parentRel = releases.find((r) => r.id === t.releaseId)
        if (parentRel && isCompilation(parentRel) && t.title && t.title.includes('-')) {
          const parts = t.title.split('-').map((p) => p.trim())
          if (parts.length === 2) {
            const p0 = stripRipNoiseAndTags(parts[0]).trim()
            const p1 = stripRipNoiseAndTags(parts[1]).trim()
            const isDescriptor = (s: string) => /^(female version|male version|remix|version|instrumental|part\s*\d+|sad version)$/i.test(s)
            if (p0.length >= 3 && !isDescriptor(p0)) hyphenMovieCounts.set(p0, (hyphenMovieCounts.get(p0) || 0) + 1)
            if (p1.length >= 3 && !isDescriptor(p1)) hyphenMovieCounts.set(p1, (hyphenMovieCounts.get(p1) || 0) + 1)
          }
        }
      })

      // Update tracks with canonical master IDs and original album provenance
      tracks.forEach((t) => {
        const parentRel = releases.find((r) => r.id === t.releaseId)
        if (parentRel) {
          t.masterReleaseId = parentRel.masterReleaseId
          if (isUnknownArtist(t.artistCredit) && !isUnknownArtist(parentRel.artistCredit)) {
            t.artistCredit = parentRel.artistCredit
          }
          if (!t.composerName && parentRel.composerName) {
            t.composerName = parentRel.composerName
          }
        }

        const isParentComp = parentRel ? isCompilation(parentRel) : false

        // Original soundtrack albums (non-compilations) are ground-truth native masters
        if (!isParentComp) {
          t.isCanonicalAlbumTrack = true
          t.canonicalAlbumTitle = undefined
          t.canonicalReleaseId = undefined
          t.canonicalReleaseYear = undefined

          // Link to stable recording ID for identical song compositions
          const songKey = `${t.title.toLowerCase().trim()}::${(t.composerName || t.artistCredit || '').toLowerCase().trim()}`
          let hash = 0
          for (let i = 0; i < songKey.length; i++) {
            hash = ((hash << 5) - hash + songKey.charCodeAt(i)) | 0
          }
          t.recordingId = `rec-${Math.abs(hash).toString(16)}`
          return
        }

        const rawTitle = t.title.trim()
        const cleanTitle = stripRipNoiseAndTags(t.title).toLowerCase().trim()
        const artComp = (t.composerName || t.artistCredit || '').toLowerCase().trim()

        let orig: OriginalSoundtrackInfo | undefined

        // Layer 1: Authoritative Container / AcoustID / Sidecar Provenance
        if (t.originalAlbum && t.originalAlbum.toLowerCase().trim() !== parentRel?.title.toLowerCase().trim()) {
          const cleanOrig = stripRipNoiseAndTags(t.originalAlbum).toLowerCase().trim()
          const matchedRel = releaseTitleMap.get(cleanOrig)
          orig = {
            albumTitle: t.originalAlbum,
            releaseId: matchedRel?.releaseId || '',
            masterReleaseId: matchedRel?.masterReleaseId || '',
            releaseYear: t.originalYear || matchedRel?.releaseYear,
          }
        }

        // Layer 2: Hyphen pattern (Movie - Song or Song - Movie) against local library releases
        if (!orig && rawTitle.includes('-')) {
          const parts = rawTitle.split('-').map((p) => p.trim())
          if (parts.length === 2) {
            const p0 = stripRipNoiseAndTags(parts[0]).toLowerCase()
            const p1 = stripRipNoiseAndTags(parts[1]).toLowerCase()
            if (releaseTitleMap.has(p0)) {
              orig = releaseTitleMap.get(p0)
            } else if (releaseTitleMap.has(p1)) {
              orig = releaseTitleMap.get(p1)
            }
          }
        }

        // 2. Exact key match
        if (!orig) {
          orig = soundtrackMap.get(`${cleanTitle}::${artComp}`)
        }

        // 3. Clean title match
        if (!orig && cleanTitle.length > 3) {
          orig = soundtrackTitleMap.get(cleanTitle)
        }

        // 4. Normalized prefix match (min 8 chars)
        if (!orig && cleanTitle.length >= 8) {
          for (const [stTitle, stInfo] of Array.from(soundtrackTitleMap.entries())) {
            if (stTitle.length >= 8 && (cleanTitle.startsWith(stTitle) || stTitle.startsWith(cleanTitle))) {
              orig = stInfo
              break
            }
          }
        }

        let isProvenanceTrack = false

        // Check if orig belongs to a different album
        if (orig && orig.albumTitle !== parentRel?.title) {
          t.canonicalAlbumTitle = orig.albumTitle
          t.canonicalReleaseId = orig.masterReleaseId || orig.releaseId
          t.canonicalReleaseYear = orig.releaseYear
          t.isCanonicalAlbumTrack = false
          isProvenanceTrack = true
        }

        // 5. Fallback for Hyphen pattern on compilation when Movie is NOT in local library (e.g. "Katiya Karun - Rockstar")
        if (!isProvenanceTrack && rawTitle.includes('-')) {
          const parts = rawTitle.split('-').map((p) => p.trim())
          if (parts.length === 2) {
            const p0 = stripRipNoiseAndTags(parts[0]).trim()
            const p1 = stripRipNoiseAndTags(parts[1]).trim()
            const count0 = hyphenMovieCounts.get(p0) || 0
            const count1 = hyphenMovieCounts.get(p1) || 0

            // Must be a verified repeated movie name across compilations (e.g. Rockstar appearing 7 times)
            let movieCandidate: string | undefined
            if (count1 >= 2) movieCandidate = p1
            else if (count0 >= 2) movieCandidate = p0

            if (movieCandidate && movieCandidate.toLowerCase() !== parentRel?.title.toLowerCase()) {
              t.canonicalAlbumTitle = movieCandidate
              t.canonicalReleaseId = undefined
              t.canonicalReleaseYear = undefined
              t.isCanonicalAlbumTrack = false
              isProvenanceTrack = true
            }
          }
        }

        if (!isProvenanceTrack) {
          t.isCanonicalAlbumTrack = true
        }

        // Link to stable recording ID for identical song compositions
        const songKey = `${t.title.toLowerCase().trim()}::${(t.composerName || t.artistCredit || '').toLowerCase().trim()}`
        let hash = 0
        for (let i = 0; i < songKey.length; i++) {
          hash = ((hash << 5) - hash + songKey.charCodeAt(i)) | 0
        }
        t.recordingId = `rec-${Math.abs(hash).toString(16)}`
      })

      const skippedFiles: SkippedFile[] = rawSkipped.map((s) => ({
        id: s.id,
        filePath: s.filePath,
        fileName: s.fileName,
        category: s.category as any,
        diagnosticError: s.diagnosticError,
        timestamp: s.timestamp,
        isIgnored: s.isIgnored,
      }))

      // Recompute accurate tracksCount for each release from loaded tracks
      const releaseTrackCounts = new Map<string, number>()
      tracks.forEach((t) => {
        if (t.releaseId) {
          releaseTrackCounts.set(t.releaseId, (releaseTrackCounts.get(t.releaseId) || 0) + 1)
        }
      })
      releases.forEach((r) => {
        r.tracksCount = releaseTrackCounts.get(r.id) || r.tracksCount || 0
      })

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
    const { listen } = await import('@tauri-apps/api/event')

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
          ...(() => {
            const specs = formatAudioSpecs(t.format, t.sampleRate, t.bitDepth, t.filePath)
            return {
              sampleRateStr: specs.sampleRateStr,
              format: specs.format,
              isHighRes: specs.isHighRes,
              sampleRate: t.sampleRate || undefined,
              bitDepth: t.bitDepth || undefined,
            }
          })(),
          isOnline: t.isOnline !== false,
          credits: [],
          masterReleaseId: t.releaseId,
        }))

        const convertedReleases: Release[] = (payload.releases || []).map((r: any) => {
          const coverArt = r.frontCoverUrl || ''
          return {
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
              frontCoverUrl: coverArt,
              backdropUrl: r.backdropUrl,
              resolution: coverArt ? '3000x3000px' : 'No Embedded Art',
              width: coverArt ? 3000 : 0,
              height: coverArt ? 3000 : 0,
              dpi: coverArt ? 300 : 72,
              colorProfile: 'sRGB',
              isLowRes: !coverArt,
              hasBookletPdf: false,
            },
            variants: [],
            discsCount: 1,
            tracksCount: convertedTracks.filter((ct) => ct.releaseId === r.id).length || 0,
            genreTags: r.genreTags ? JSON.parse(r.genreTags) : [],
            storageMountId: '',
          }
        })

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
          sampleRate: parseAudioSpecsFromString(t.sampleRateStr, t.sampleRate, t.bitDepth).sampleRate,
          bitDepth: parseAudioSpecsFromString(t.sampleRateStr, t.sampleRate, t.bitDepth).bitDepth,
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
          isCompilation: Boolean(t.isCompilation),
          albumArtist: t.albumArtist || t.pendingSidecarEdits?.albumArtist || null,
          originalAlbum: t.originalAlbum || null,
          originalYear: t.originalYear || null,
          acoustidFingerprint: t.acoustidFingerprint || null,
          musicbrainzRecordingId: t.musicbrainzRecordingId || null,
          createdAt: new Date().toISOString(),
        }
      })

      await tauriBridge.dbSaveTracksBatch(dbTracks, dbReleases)
      console.log(`[SqliteLibraryService] Synchronized ${dbTracks.length} tracks and ${dbReleases.length} releases to SQLite.`)
    } catch (err) {
      console.warn('[SqliteLibraryService] Failed to synchronize library to SQLite:', err)
    }
  }

  // --- Canonical Relational Artists ---

  /**
   * Retrieves canonical artists with aggregate album and track counts.
   * Leverages SQLite canonical_artists + track_artist_credits in native desktop mode,
   * or falls back to in-memory credit splitting in mock/browser mode.
   */
  public async getCanonicalArtists(
    fallbackReleases?: Release[],
    fallbackTracks?: Track[]
  ): Promise<ArtistSummary[]> {
    if (tauriBridge.isTauri()) {
      try {
        const raw = await tauriBridge.dbGetCanonicalArtists()
        if (raw && raw.length > 0) {
          return raw.map((a: any) => {
            const rawRole = a.primaryRole || a.primary_role || 'Performer'
            const normRole = rawRole === 'Primary' || rawRole === 'Featured' ? 'Performer' : rawRole
            const rawRoles: string[] = a.roles && a.roles.length > 0 ? a.roles : [rawRole]
            const normRoles = Array.from(
              new Set(
                rawRoles.map((r) =>
                  r === 'Primary' || r === 'Featured' ? 'Performer' : r
                )
              )
            )
            return {
              id: a.id,
              name: a.name,
              sortName: a.sortName || a.sort_name,
              portraitUrl: a.portraitUrl || a.portrait_url,
              portraitStatus: (a.portraitStatus || a.portrait_status || 'pending') as any,
              primaryRole: normRole,
              albumsCount: a.albumsCount ?? a.albums_count ?? 0,
              tracksCount: a.tracksCount ?? a.tracks_count ?? 0,
              roles: normRoles,
              eraActive: a.eraActive || a.era_active,
            }
          })
        }
      } catch (err) {
        console.warn('[SqliteLibraryService] Failed to load canonical artists from SQLite:', err)
      }
    }

    if (fallbackReleases && fallbackTracks) {
      return this.deriveCanonicalArtistsFromState(fallbackReleases, fallbackTracks)
    }
    return []
  }

  /**
   * Retrieves detailed discography and appearing tracks for an individual canonical artist.
   */
  public async getCanonicalArtistDetail(
    artistId: string,
    fallbackReleases: Release[] = [],
    fallbackTracks: Track[] = []
  ): Promise<ArtistDetail | null> {
    if (tauriBridge.isTauri()) {
      try {
        const res = await tauriBridge.dbGetCanonicalArtistDetail(artistId)
        if (res && res.artist) {
          const rawArtist = res.artist
          const rawRole = rawArtist.primaryRole || rawArtist.primary_role || 'Performer'
          const normRole = rawRole === 'Primary' || rawRole === 'Featured' ? 'Performer' : rawRole
          const rawRoles: string[] = res.roles && res.roles.length > 0 ? res.roles : [rawRole]
          const normRoles = Array.from(
            new Set(
              rawRoles.map((r) =>
                r === 'Primary' || r === 'Featured' ? 'Performer' : r
              )
            )
          )
          const artist = {
            id: rawArtist.id,
            name: rawArtist.name,
            sortName: rawArtist.sortName || rawArtist.sort_name,
            mbid: rawArtist.mbid,
            appleArtistId: rawArtist.appleArtistId || rawArtist.apple_artist_id,
            portraitUrl: rawArtist.portraitUrl || rawArtist.portrait_url,
            portraitStatus: rawArtist.portraitStatus || rawArtist.portrait_status,
            bioSummary: rawArtist.bioSummary || rawArtist.bio_summary,
            eraActive: rawArtist.eraActive || rawArtist.era_active,
            primaryRole: normRole,
            createdAt: rawArtist.createdAt || rawArtist.created_at || new Date().toISOString(),
          }

          const discography: Release[] = (res.discography || []).map((r: any) => {
            const rawCover = r.frontCoverUrl || r.front_cover_url || ''
            const coverArtUrl = rawCover || getCuratedAlbumArtwork(r.title, r.composerName || r.artistCredit)
            return {
              id: r.id,
              masterReleaseId: r.id,
              title: r.title,
              folderName: r.folderName || r.folder_name,
              folderPath: r.folderPath || r.folder_path,
              targetFolderPath: r.targetFolderPath || r.target_folder_path,
              artistCredit: r.artistCredit || r.artist_credit,
              composerName: r.composerName || r.composer_name,
              releaseYear: r.releaseYear || r.release_year || 0,
              originalYear: r.releaseYear || r.release_year || 0,
              label: 'Lossless Master',
              catalogNumber: 'CAD-001',
              mediaFormat: 'Lossless Audio',
              country: 'Global',
              matrixRunout: '',
              artwork: {
                frontCoverUrl: coverArtUrl,
                backdropUrl: r.backdropUrl || r.backdrop_url,
                resolution: coverArtUrl ? '3000x3000px' : 'No Embedded Art',
                width: coverArtUrl ? 3000 : 0,
                height: coverArtUrl ? 3000 : 0,
                dpi: coverArtUrl ? 300 : 72,
                colorProfile: 'sRGB',
                isLowRes: !coverArtUrl,
                hasBookletPdf: false,
              },
              genres: r.genreTags ? r.genreTags.split(',').map((g: string) => g.trim()) : [],
              tracks: [],
              isLocalOnline: true,
              storageMountId: 'mount-main',
            }
          })

          const appearingTracks: ArtistCreditItem[] = (res.appearingTracks || res.appearing_tracks || []).map((item: any) => ({
            trackId: item.trackId || item.track_id,
            trackTitle: item.trackTitle || item.track_title,
            trackNumber: item.trackNumber ?? item.track_number,
            releaseId: item.releaseId || item.release_id,
            releaseTitle: item.releaseTitle || item.release_title,
            releaseYear: item.releaseYear ?? item.release_year,
            role: item.role === 'Primary' || item.role === 'Featured' ? 'Performer' : (item.role || 'Performer'),
            format: item.format || 'FLAC',
            sampleRate: item.sampleRate ?? item.sample_rate,
            bitDepth: item.bitDepth ?? item.bit_depth,
            drScore: item.drScore ?? item.dr_score,
            durationSecs: item.durationSecs ?? item.duration_secs ?? 0,
            fullArtistCredit: item.fullArtistCredit || item.full_artist_credit,
            coArtists: item.coArtists || item.co_artists || [],
          }))

          return {
            artist,
            albumsCount: res.albumsCount ?? res.albums_count ?? discography.length,
            tracksCount: res.tracksCount ?? res.tracks_count ?? appearingTracks.length,
            roles: normRoles,
            discography,
            appearingTracks,
          }
        }
      } catch (err) {
        console.warn(`[SqliteLibraryService] Error fetching detail for artist ${artistId}:`, err)
      }
    }

    // In-memory fallback
    const summaries = this.deriveCanonicalArtistsFromState(fallbackReleases, fallbackTracks)
    const summary = summaries.find((s) => s.id === artistId || s.name.toLowerCase() === artistId.toLowerCase())
    if (!summary) return null

    const normName = summary.name.toLowerCase()
    const matchingReleases = fallbackReleases.filter(
      (r) =>
        (r.composerName && r.composerName.toLowerCase().includes(normName)) ||
        (r.artistCredit && r.artistCredit.toLowerCase().includes(normName))
    )

    const appearingTracks: ArtistCreditItem[] = []
    for (const t of fallbackTracks) {
      const isComposer = Boolean(t.composerName?.toLowerCase().includes(normName))
      const isPerformer = Boolean(t.artistCredit?.toLowerCase().includes(normName))
      if (isComposer || isPerformer) {
        const splits = splitMultiArtistCredits(t.artistCredit || '')
        const coArtists = splits.map((s) => s.name).filter((n) => n.toLowerCase() !== normName)
        const rel = fallbackReleases.find((r) => r.id === t.releaseId)

        appearingTracks.push({
          trackId: t.id,
          trackTitle: t.title,
          trackNumber: t.trackNumber,
          releaseId: t.releaseId,
          releaseTitle: rel?.title || (t as any).albumTitle || 'Unknown Release',
          releaseYear: rel?.releaseYear ?? (t as any).releaseYear,
          role: isComposer ? 'Composer' : 'Performer',
          format: t.format,
          sampleRate: t.sampleRate,
          bitDepth: t.bitDepth,
          drScore: t.drScore,
          durationSecs: t.durationSeconds || 0,
          fullArtistCredit: t.artistCredit || summary.name,
          coArtists,
        })
      }
    }

    return {
      artist: {
        id: summary.id,
        name: summary.name,
        portraitUrl: summary.portraitUrl,
        portraitStatus: summary.portraitStatus,
        primaryRole: summary.primaryRole,
        createdAt: new Date().toISOString(),
      },
      albumsCount: matchingReleases.length,
      tracksCount: appearingTracks.length,
      roles: summary.roles,
      discography: matchingReleases,
      appearingTracks,
    }
  }

  /**
   * Persists an artist's chosen photographic portrait.
   */
  public async setArtistPortrait(
    artistId: string,
    portraitUrl: string,
    status: string = 'enriched'
  ): Promise<void> {
    if (tauriBridge.isTauri()) {
      await tauriBridge.dbSetArtistPortrait(artistId, portraitUrl, status)
    }
  }

  /**
   * Derives a full relational canonical artist collection from in-memory state,
   * splitting compound strings while protecting compound band/duo entities.
   */
  public deriveCanonicalArtistsFromState(releases: Release[], tracks: Track[]): ArtistSummary[] {
    const artistMap = new Map<
      string,
      {
        id: string
        name: string
        albums: Set<string>
        tracks: Set<string>
        roles: Set<string>
      }
    >()

    // 1. Process Releases
    for (const r of releases) {
      if (r.composerName) {
        const key = r.composerName.trim().toLowerCase()
        if (!artistMap.has(key)) {
          artistMap.set(key, {
            id: `art-${key.replace(/[^a-z0-9]/g, '_')}`,
            name: r.composerName.trim(),
            albums: new Set(),
            tracks: new Set(),
            roles: new Set(['Composer']),
          })
        }
        const entry = artistMap.get(key)!
        entry.albums.add(r.id)
        entry.roles.add('Composer')
      }

      if (r.artistCredit) {
        const splits = splitMultiArtistCredits(r.artistCredit, 'Performer')
        for (const s of splits) {
          const key = s.name.trim().toLowerCase()
          if (!artistMap.has(key)) {
            artistMap.set(key, {
              id: `art-${key.replace(/[^a-z0-9]/g, '_')}`,
              name: s.name.trim(),
              albums: new Set(),
              tracks: new Set(),
              roles: new Set(),
            })
          }
          const entry = artistMap.get(key)!
          entry.albums.add(r.id)
          entry.roles.add(s.role)
        }
      }
    }

    // 2. Process Tracks
    for (const t of tracks) {
      if (t.composerName) {
        const key = t.composerName.trim().toLowerCase()
        if (!artistMap.has(key)) {
          artistMap.set(key, {
            id: `art-${key.replace(/[^a-z0-9]/g, '_')}`,
            name: t.composerName.trim(),
            albums: new Set(),
            tracks: new Set(),
            roles: new Set(['Composer']),
          })
        }
        const entry = artistMap.get(key)!
        if (t.releaseId) entry.albums.add(t.releaseId)
        entry.tracks.add(t.id)
        entry.roles.add('Composer')
      }

      if (t.artistCredit) {
        const splits = splitMultiArtistCredits(t.artistCredit, 'Performer')
        for (const s of splits) {
          const key = s.name.trim().toLowerCase()
          if (!artistMap.has(key)) {
            artistMap.set(key, {
              id: `art-${key.replace(/[^a-z0-9]/g, '_')}`,
              name: s.name.trim(),
              albums: new Set(),
              tracks: new Set(),
              roles: new Set(),
            })
          }
          const entry = artistMap.get(key)!
          if (t.releaseId) entry.albums.add(t.releaseId)
          entry.tracks.add(t.id)
          entry.roles.add(s.role)
        }
      }
    }

    const summaries: ArtistSummary[] = []
    for (const item of artistMap.values()) {
      if (item.tracks.size === 0 && item.albums.size === 0) continue
      const rolesArr = Array.from(item.roles)
      const primaryRole = rolesArr.includes('Composer')
        ? 'Composer'
        : rolesArr.includes('Performer')
        ? 'Performer'
        : rolesArr[0] || 'Performer'

      summaries.push({
        id: item.id,
        name: item.name,
        albumsCount: item.albums.size,
        tracksCount: item.tracks.size,
        roles: rolesArr,
        primaryRole,
        portraitStatus: 'pending',
      })
    }

    // Sort by albums count desc, then name asc
    summaries.sort((a, b) => b.albumsCount - a.albumsCount || a.name.localeCompare(b.name))
    return summaries
  }

  public async updateArtistEditorialProfile(
    artistId: string,
    payload: UpdateArtistEditorialPayload
  ): Promise<void> {
    await tauriBridge.updateCanonicalArtistEditorial(artistId, payload)
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

  /**
   * High-speed catalog search for Omnibar intent resolution (<10ms).
   * Queries in-memory graphEngine first, zero disk I/O.
   */
  public async searchCatalog(
    query: string,
    limit: number = 5
  ): Promise<{
    albums: Release[]
    tracks: Track[]
    artists: ArtistSummary[]
  }> {
    const memResults = graphEngine.searchCatalog(query, limit)
    if (
      memResults.albums.length > 0 ||
      memResults.tracks.length > 0 ||
      memResults.artists.length > 0
    ) {
      return {
        albums: memResults.albums,
        tracks: memResults.tracks,
        artists: memResults.artists.map((a) => ({
          id: a.id,
          name: a.name,
          primaryRole: a.role,
          albumsCount: a.albumsCount,
          tracksCount: a.tracksCount,
          roles: [a.role],
          portraitUrl: a.portraitUrl,
        })),
      }
    }

    if (tauriBridge.isTauri()) {
      try {
        const raw = await tauriBridge.dbSearchCatalog(query, limit)
        if (raw) {
          const albums: Release[] = (raw.albums || []).map((r: any) => {
            const coverArt = r.frontCoverUrl || r.front_cover_url || ''
            return {
              id: r.id,
              masterReleaseId: r.id,
              title: r.title,
              folderName: r.folderName || r.folder_name,
              folderPath: r.folderPath || r.folder_path,
              targetFolderPath: r.targetFolderPath || r.target_folder_path,
              artistCredit: r.artistCredit || r.artist_credit,
              composerName: r.composerName || r.composer_name,
              releaseYear: r.releaseYear || r.release_year || 0,
              originalYear: r.releaseYear || r.release_year || 0,
              label: 'Lossless Master',
              catalogNumber: 'CAD-001',
              mediaFormat: 'Lossless Audio',
              country: 'Global',
              matrixRunout: '',
              artwork: {
                frontCoverUrl: coverArt,
                backdropUrl: r.backdropUrl || r.backdrop_url,
                resolution: coverArt ? '3000x3000px' : 'No Embedded Art',
                width: coverArt ? 3000 : 0,
                height: coverArt ? 3000 : 0,
                dpi: coverArt ? 300 : 72,
                colorProfile: 'sRGB',
                isLowRes: !coverArt,
                hasBookletPdf: false,
              },
              coverArtUrl: coverArt,
              variants: [],
              discsCount: 1,
              tracksCount: 10,
              genreTags: r.genreTags ? JSON.parse(r.genreTags) : [],
              storageMountId: 'mount-user-local',
            }
          })

          const tracks: Track[] = (raw.tracks || []).map((t: any) => {
            const specs = formatAudioSpecs(t.format, t.sampleRate || t.sample_rate, t.bitDepth || t.bit_depth, t.filePath || t.file_path)
            return {
              id: t.id,
              releaseId: t.releaseId || t.release_id,
              recordingId: t.id,
              trackNumber: t.trackNumber ?? t.track_number ?? 1,
              discNumber: 1,
              title: t.title,
              artistCredit: t.artistCredit || t.artist_credit,
              composerName: t.composer || t.composerName,
              workTitle: t.workTitle || t.work_title,
              movementNumber: t.movementNumber || t.movement_number,
              movementTitle: t.movementTitle || t.movement_title,
              durationSeconds: t.durationSecs || t.duration_secs || 0,
              filePath: t.filePath || t.file_path,
              fileSize: t.fileSize || t.file_size || 0,
              storageMountId: t.mountId || t.mount_id || 'mount-user-local',
              sidecarStatus: (t.sidecarStatus || t.sidecar_status || 'synced') as any,
              modifiedTimestamp: new Date().toISOString(),
              checksumValid: true,
              accurateRipConfidence: 100,
              drScore: t.drScore ?? t.dr_score ?? 12,
              sampleRateStr: specs.sampleRateStr,
              format: specs.format,
              isHighRes: specs.isHighRes,
              sampleRate: t.sampleRate || t.sample_rate,
              bitDepth: t.bitDepth || t.bit_depth,
              credits: [],
              masterReleaseId: t.releaseId || t.release_id,
            }
          })

          const artists: ArtistSummary[] = (raw.artists || []).map((a: any) => ({
            id: a.id,
            name: a.name,
            sortName: a.sortName || a.sort_name,
            portraitUrl: a.portraitUrl || a.portrait_url,
            portraitStatus: (a.portraitStatus || a.portrait_status || 'pending') as any,
            primaryRole: a.primaryRole || a.primary_role || 'Performer',
            albumsCount: a.albumsCount ?? a.albums_count ?? 0,
            tracksCount: a.tracksCount ?? a.tracks_count ?? 0,
            roles: a.roles || [a.primaryRole || 'Performer'],
            eraActive: a.eraActive || a.era_active,
          }))

          return { albums, tracks, artists }
        }
      } catch (err) {
        console.warn('[SqliteLibraryService] searchCatalog SQLite fallback failed:', err)
      }
    }

    return { albums: [], tracks: [], artists: [] }
  }

  // ==========================================
  // Playlists & Curated Archival Stacks
  // ==========================================

  private inMemoryPlaylists: Map<string, { playlist: Playlist; tracks: Track[] }> = new Map()

  public async getPlaylists(): Promise<Playlist[]> {
    if (tauriBridge.isTauri()) {
      try {
        const raw = await tauriBridge.dbGetPlaylists()
        if (Array.isArray(raw)) {
          return raw.map((p) => ({
            id: p.id,
            title: p.title,
            description: p.description,
            coverArtUrl: p.coverArtUrl,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            tags: p.tags ? p.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
            listeningNotes: p.listeningNotes,
            tracksCount: p.tracksCount || 0,
            totalDurationSecs: p.totalDurationSecs || 0,
            formatBreakdown: p.formatBreakdown || '',
          }))
        }
      } catch (err) {
        console.warn('[SqliteLibraryService] getPlaylists error:', err)
      }
    }

    return Array.from(this.inMemoryPlaylists.values()).map((item) => item.playlist)
  }

  public async getPlaylistDetails(playlistId: string): Promise<Playlist | null> {
    if (tauriBridge.isTauri()) {
      try {
        const raw = await tauriBridge.dbGetPlaylistDetails(playlistId)
        if (raw) {
          const p = raw.playlist || raw
          const rawTracks = raw.tracks || []
          const tracks: Track[] = rawTracks.map((t: any) => {
            const specs = formatAudioSpecs(t.format, t.sampleRate, t.bitDepth, t.filePath)
            return {
              id: t.id,
              releaseId: t.releaseId || t.release_id,
              recordingId: t.id,
              trackNumber: t.trackNumber || t.track_number || 1,
              discNumber: 1,
              title: t.title || 'Untitled',
              artistCredit: t.artistCredit || t.artist_credit || 'Unknown Artist',
              albumTitle: t.albumTitle || t.album_title || 'Unknown Album',
              duration: t.durationSecs || t.duration_secs || 0,
              durationSeconds: t.durationSecs || t.duration_secs || 0,
              filePath: t.filePath || t.file_path,
              fileName: t.fileName || t.file_name || '',
              fileSize: t.fileSize || t.file_size || 0,
              storageMountId: t.mountId || t.mount_id || 'mount-user-local',
              sidecarStatus: (t.sidecarStatus || t.sidecar_status || 'synced') as any,
              modifiedTimestamp: new Date().toISOString(),
              checksumValid: true,
              accurateRipConfidence: 100,
              drScore: t.drScore ?? t.dr_score ?? 12,
              sampleRateStr: specs.sampleRateStr,
              format: specs.format,
              isHighRes: specs.isHighRes,
              sampleRate: t.sampleRate || t.sample_rate,
              bitDepth: t.bitDepth || t.bit_depth,
              credits: [],
              masterReleaseId: t.releaseId || t.release_id,
            }
          })

          const formatBreakdown = computePlaylistFormatBreakdown(tracks)
          const totalDurationSecs = tracks.reduce((acc, tr) => acc + (tr.durationSeconds || tr.duration || 0), 0)

          return {
            id: p.id,
            title: p.title,
            description: p.description,
            coverArtUrl: p.coverArtUrl,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            tags: p.tags ? (typeof p.tags === 'string' ? p.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : p.tags) : [],
            listeningNotes: p.listeningNotes,
            tracksCount: tracks.length,
            totalDurationSecs,
            formatBreakdown,
            trackIds: tracks.map((t) => t.id),
            tracks,
          }
        }
      } catch (err) {
        console.warn('[SqliteLibraryService] getPlaylistDetails error:', err)
      }
    }

    const item = this.inMemoryPlaylists.get(playlistId)
    if (item) {
      return {
        ...item.playlist,
        tracks: item.tracks,
        trackIds: item.tracks.map((t) => t.id),
      }
    }
    return null
  }

  public async createPlaylist(params: {
    title: string
    description?: string
    coverArtUrl?: string
    tags?: string[]
    listeningNotes?: string
    tracks?: Track[]
    trackIds?: string[]
  }): Promise<Playlist> {
    const id = `playlist-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    const tracks = params.tracks || []
    const trackIds = params.trackIds || tracks.map((t) => t.id)
    const tagsStr = (params.tags || []).join(', ')
    const now = new Date().toISOString()
    const totalDurationSecs = tracks.reduce((acc, t) => acc + (t.durationSeconds || t.duration || 0), 0)
    const formatBreakdown = computePlaylistFormatBreakdown(tracks)

    const playlist: Playlist = {
      id,
      title: params.title.trim() || 'Untitled Playlist',
      description: params.description,
      coverArtUrl: params.coverArtUrl,
      createdAt: now,
      updatedAt: now,
      tags: params.tags || [],
      listeningNotes: params.listeningNotes,
      tracksCount: tracks.length,
      totalDurationSecs,
      formatBreakdown,
      trackIds,
      tracks,
    }

    if (tauriBridge.isTauri()) {
      try {
        await tauriBridge.dbCreatePlaylist({
          id,
          title: playlist.title,
          description: playlist.description,
          coverArtUrl: playlist.coverArtUrl,
          tags: tagsStr,
          listeningNotes: playlist.listeningNotes,
          trackIds,
        })
      } catch (err) {
        console.warn('[SqliteLibraryService] dbCreatePlaylist failed, fallback to memory:', err)
      }
    }

    this.inMemoryPlaylists.set(id, { playlist, tracks })
    return playlist
  }

  public async updatePlaylist(id: string, updates: Partial<Playlist>): Promise<void> {
    const item = this.inMemoryPlaylists.get(id)
    if (item) {
      item.playlist = { ...item.playlist, ...updates, updatedAt: new Date().toISOString() }
      this.inMemoryPlaylists.set(id, item)
    }

    if (tauriBridge.isTauri()) {
      try {
        await tauriBridge.dbUpdatePlaylist({
          id,
          title: updates.title || item?.playlist.title || 'Untitled',
          description: updates.description,
          coverArtUrl: updates.coverArtUrl,
          tags: Array.isArray(updates.tags) ? updates.tags.join(', ') : updates.tags,
          listeningNotes: updates.listeningNotes,
        })
      } catch (err) {
        console.warn('[SqliteLibraryService] dbUpdatePlaylist error:', err)
      }
    }
  }

  public async deletePlaylist(id: string): Promise<void> {
    this.inMemoryPlaylists.delete(id)
    if (tauriBridge.isTauri()) {
      try {
        await tauriBridge.dbDeletePlaylist(id)
      } catch (err) {
        console.warn('[SqliteLibraryService] dbDeletePlaylist error:', err)
      }
    }
  }

  public async addTracksToPlaylist(playlistId: string, newTracks: Track[]): Promise<void> {
    const item = this.inMemoryPlaylists.get(playlistId)
    if (item) {
      item.tracks.push(...newTracks)
      item.playlist.tracksCount = item.tracks.length
      item.playlist.totalDurationSecs = item.tracks.reduce((acc, t) => acc + (t.durationSeconds || t.duration || 0), 0)
      item.playlist.formatBreakdown = computePlaylistFormatBreakdown(item.tracks)
      item.playlist.updatedAt = new Date().toISOString()
      this.inMemoryPlaylists.set(playlistId, item)
    }

    if (tauriBridge.isTauri()) {
      try {
        await tauriBridge.dbAddTracksToPlaylist(playlistId, newTracks.map((t) => t.id))
      } catch (err) {
        console.warn('[SqliteLibraryService] dbAddTracksToPlaylist error:', err)
      }
    }
  }

  public async removeTrackFromPlaylist(playlistId: string, position: number): Promise<void> {
    const item = this.inMemoryPlaylists.get(playlistId)
    if (item && position >= 0 && position < item.tracks.length) {
      item.tracks.splice(position, 1)
      item.playlist.tracksCount = item.tracks.length
      item.playlist.totalDurationSecs = item.tracks.reduce((acc, t) => acc + (t.durationSeconds || t.duration || 0), 0)
      item.playlist.formatBreakdown = computePlaylistFormatBreakdown(item.tracks)
      item.playlist.updatedAt = new Date().toISOString()
      this.inMemoryPlaylists.set(playlistId, item)
    }

    if (tauriBridge.isTauri()) {
      try {
        await tauriBridge.dbRemoveTrackFromPlaylist(playlistId, position)
      } catch (err) {
        console.warn('[SqliteLibraryService] dbRemoveTrackFromPlaylist error:', err)
      }
    }
  }

  public async reorderPlaylistTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const item = this.inMemoryPlaylists.get(playlistId)
    if (item) {
      const trackMap = new Map(item.tracks.map((t) => [t.id, t]))
      item.tracks = trackIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[]
      item.playlist.updatedAt = new Date().toISOString()
      this.inMemoryPlaylists.set(playlistId, item)
    }

    if (tauriBridge.isTauri()) {
      try {
        await tauriBridge.dbReorderPlaylistTracks(playlistId, trackIds)
      } catch (err) {
        console.warn('[SqliteLibraryService] dbReorderPlaylistTracks error:', err)
      }
    }
  }
}

/**
 * Computes a high-fidelity format breakdown for a set of tracks,
 * e.g., "14 tracks • DSD/FLAC hybrid" or "10 tracks • Pure DSD256" or "12 tracks • 24/192 FLAC"
 */
export function computePlaylistFormatBreakdown(tracks: Track[]): string {
  if (!tracks || tracks.length === 0) return '0 tracks • Empty'

  let dsdCount = 0
  let flacCount = 0
  let wavCount = 0
  let maxDsdRate = ''

  for (const t of tracks) {
    const fmt = (t.format || '').toUpperCase()
    if (fmt.includes('DSD') || fmt.includes('DSF') || fmt.includes('DFF')) {
      dsdCount++
      if (t.sampleRateStr?.includes('DSD256')) maxDsdRate = 'DSD256'
      else if (!maxDsdRate && t.sampleRateStr?.includes('DSD128')) maxDsdRate = 'DSD128'
      else if (!maxDsdRate && t.sampleRateStr?.includes('DSD64')) maxDsdRate = 'DSD64'
    } else if (fmt.includes('FLAC') || fmt.includes('ALAC')) {
      flacCount++
    } else if (fmt.includes('WAV')) {
      wavCount++
    }
  }

  if (dsdCount > 0 && flacCount > 0) {
    return `${tracks.length} tracks • DSD/FLAC hybrid`
  }
  if (dsdCount > 0) {
    return `${tracks.length} tracks • Pure ${maxDsdRate || 'DSD'}`
  }
  if (flacCount > 0) {
    const hasHiRes = tracks.some((t) => t.isHighRes)
    return `${tracks.length} tracks • ${hasHiRes ? 'Hi-Res FLAC' : 'Lossless FLAC'}`
  }
  if (wavCount > 0) {
    return `${tracks.length} tracks • Pure WAV`
  }
  return `${tracks.length} tracks • Mixed audio`
}

/**
 * Extracts up to 4 unique artwork URLs from a list of tracks or their releases
 * to generate a 4-grid composite cover art thumbnail.
 */
export function generatePlaylist4GridArtwork(tracks: Track[], allReleases?: Release[]): string[] {
  if (!tracks || tracks.length === 0) return []
  const uniqueArts: string[] = []
  const relMap = new Map<string, string>()
  if (allReleases) {
    for (const r of allReleases) {
      const art = r.coverArtUrl || r.artwork?.frontCoverUrl
      if (art) relMap.set(r.id, art)
    }
  }

  for (const t of tracks) {
    const art = relMap.get(t.releaseId)
    if (art && !uniqueArts.includes(art)) {
      uniqueArts.push(art)
      if (uniqueArts.length === 4) break
    }
  }

  return uniqueArts
}

export const sqliteLibraryService = new SqliteLibraryService()
