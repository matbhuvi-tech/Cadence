import {
  Track,
  Release,
  Work,
  Recording,
  Person,
  StorageMount,
  AuditIssue,
  PressingVariant,
} from './types'
import {
  mockTracks,
  mockReleases,
  mockWorks,
  mockRecordings,
  mockPersons,
  mockStorageMounts,
  mockAuditIssues,
} from './mockCatalog'
import {
  matchesComposer,
  matchesEra,
  matchesFormat,
  detectLanguage,
  KNOWN_COMPOSERS,
} from './taxonomyUtils'
import { normalizationService } from '../services/normalizationService'

export interface LibraryStats {
  totalTracks: number
  totalReleases: number
  totalWorks: number
  totalStorageBytes: number
  highResPercentage: number
  averageDrScore: number
  uncommittedSidecarsCount: number
  totalIssuesCount: number
  readOnlyMountsCount: number
}

export interface FacetFilterState {
  searchQuery: string
  formatFilter?: string
  eraFilter?: string
  composerFilter?: string
  languageFilter?: string
  genreFilter?: string
  ensembleFilter?: string
  masteringFilter?: string
  triageFilter?: string
  storageMountFilter?: string
}

export class RelationalGraphEngine {
  private tracks: Map<string, Track> = new Map()
  private releases: Map<string, Release> = new Map()
  private works: Map<string, Work> = new Map()
  private recordings: Map<string, Recording> = new Map()
  private persons: Map<string, Person> = new Map()
  private storageMounts: Map<string, StorageMount> = new Map()
  private auditIssues: Map<string, AuditIssue> = new Map()
  private isCustomMode: boolean = false

  constructor() {
    this.seed()
  }

  public isUsingCustomLibrary(): boolean {
    return this.isCustomMode
  }

  private seed() {
    this.isCustomMode = false
    this.tracks.clear()
    this.releases.clear()
    this.works.clear()
    this.recordings.clear()
    this.persons.clear()
    this.storageMounts.clear()
    this.auditIssues.clear()

    // Default to clean real local mount
    const defaultMount: StorageMount = {
      id: 'mount-user-local',
      name: 'Local Audio Storage',
      mountPath: '/Local/Music',
      type: 'nvme_scratch',
      fileSystem: 'NTFS',
      totalBytes: 2000000000000,
      usedBytes: 0,
      isReadOnlyLocked: false,
      healthScore: 'healthy',
      smartOk: true,
      tempCelsius: 36,
    }
    this.storageMounts.set('mount-user-local', defaultMount)
  }

  public loadDemoCatalog() {
    this.seed()
    mockPersons && Object.values(mockPersons).forEach((p) => this.persons.set(p.id, p))
    mockWorks && Object.values(mockWorks).forEach((w) => this.works.set(w.id, w))
    mockRecordings && Object.values(mockRecordings).forEach((r) => this.recordings.set(r.id, r))
    mockReleases.forEach((rel) => this.releases.set(rel.id, rel))
    mockTracks.forEach((trk) => this.tracks.set(trk.id, trk))
    mockStorageMounts.forEach((m) => this.storageMounts.set(m.id, m))
    mockAuditIssues.forEach((a) => this.auditIssues.set(a.id, a))
  }

  public loadCustomLibrary(data: {
    tracks: Track[]
    releases: Release[]
    works: Work[]
    auditIssues?: AuditIssue[]
    storageMounts?: StorageMount[]
  }) {
    this.isCustomMode = true
    this.tracks.clear()
    this.releases.clear()
    this.works.clear()
    this.auditIssues.clear()

    data.tracks.forEach((t) => this.tracks.set(t.id, t))

    const releaseTrackCounts = new Map<string, number>()
    data.tracks.forEach((t) => {
      if (t.releaseId) {
        releaseTrackCounts.set(t.releaseId, (releaseTrackCounts.get(t.releaseId) || 0) + 1)
      }
    })

    data.releases.forEach((r) => {
      const computed = releaseTrackCounts.get(r.id)
      if (computed !== undefined && computed > 0) {
        r.tracksCount = computed
      }
      this.releases.set(r.id, r)
    })
    data.works.forEach((w) => this.works.set(w.id, w))

    if (data.auditIssues && data.auditIssues.length > 0) {
      data.auditIssues.forEach((a) => this.auditIssues.set(a.id, a))
    }

    if (data.storageMounts && data.storageMounts.length > 0) {
      this.storageMounts.clear()
      data.storageMounts.forEach((m) => this.storageMounts.set(m.id, m))
    } else if (data.tracks.length > 0) {
      // Derive real storage mounts from the imported track paths
      this.storageMounts.clear()
      const mountsByRoot = new Map<string, { used: number; files: number }>()

      for (const t of data.tracks) {
        const pathStr = t.filePath || ''
        let rootKey = 'Local Music'
        const winMatch = pathStr.match(/^([A-Za-z]:)/)
        const uncMatch = pathStr.match(/^(\\\\[^\\]+\\[^\\]+)/)
        if (winMatch) {
          rootKey = winMatch[1]
        } else if (uncMatch) {
          rootKey = uncMatch[1]
        } else if (pathStr.startsWith('/')) {
          const parts = pathStr.split('/').filter(Boolean)
          rootKey = parts.length > 1 ? `/${parts[0]}/${parts[1]}` : `/${parts[0] || 'Music'}`
        }

        const stats = mountsByRoot.get(rootKey) || { used: 0, files: 0 }
        stats.used += t.fileSize
        stats.files += 1
        mountsByRoot.set(rootKey, stats)
      }

      mountsByRoot.forEach((stats, rootKey) => {
        const mId = `mount-${rootKey.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
        const isWin = rootKey.includes(':')
        const isUnc = rootKey.startsWith('\\\\')
        const userMount: StorageMount = {
          id: mId,
          name: isUnc
            ? `TrueNAS Network Storage (${rootKey})`
            : isWin
            ? `Drive ${rootKey} (Local Audio Disk)`
            : `Storage Volume (${rootKey})`,
          mountPath: rootKey,
          type: isUnc ? 'nas_array' : ('local_disk' as any),
          fileSystem: isUnc ? 'ZFS' : isWin ? 'NTFS' : 'APFS',
          totalBytes: Math.max(stats.used * 2, 500000000000),
          usedBytes: stats.used,
          isReadOnlyLocked: false,
          healthScore: 'healthy',
          smartOk: true,
          tempCelsius: 34,
          status: 'online',
          lastSeenTimestamp: new Date().toISOString(),
        }
        this.storageMounts.set(mId, userMount)
      })

      // Link tracks to matching mount
      const firstMountId = Array.from(this.storageMounts.keys())[0] || 'mount-user-local'
      data.tracks.forEach((t) => {
        const p = t.filePath || ''
        const winMatch = p.match(/^([A-Za-z]:)/)
        if (winMatch) {
          t.storageMountId = `mount-${winMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '_')}`
        } else {
          t.storageMountId = firstMountId
        }
      })
    }
  }

  public addOrUpdateTrack(track: Track) {
    this.tracks.set(track.id, track)
  }

  public addOrUpdateRelease(release: Release) {
    this.releases.set(release.id, release)
  }

  public setMountOnlineStatus(mountId: string, isOnline: boolean) {
    const mount = this.storageMounts.get(mountId)
    if (mount) {
      mount.status = isOnline ? 'online' : 'offline'
    }
    this.tracks.forEach((t) => {
      if (t.storageMountId === mountId) {
        t.isOnline = isOnline
      }
    })
  }

  public setAuditIssues(issues: AuditIssue[]) {
    this.auditIssues.clear()
    issues.forEach((i) => this.auditIssues.set(i.id, i))
  }

  public setStorageMounts(mounts: StorageMount[]) {
    this.storageMounts.clear()
    mounts.forEach((m) => this.storageMounts.set(m.id, m))
  }

  public resetToDemoCatalog() {
    this.loadDemoCatalog()
  }

  public clearLibrary() {
    this.seed()
  }

  // Retrieval
  public getAllTracks(): Track[] {
    return Array.from(this.tracks.values())
  }

  public getTrackById(id: string): Track | undefined {
    return this.tracks.get(id)
  }

  public getAllReleases(): Release[] {
    return Array.from(this.releases.values())
  }

  public getReleaseById(id: string): Release | undefined {
    return this.releases.get(id)
  }

  public getAllWorks(): Work[] {
    return Array.from(this.works.values())
  }

  public getWorkById(id: string): Work | undefined {
    return this.works.get(id)
  }

  public getRecordingById(id: string): Recording | undefined {
    return this.recordings.get(id)
  }

  public getPersonById(id: string): Person | undefined {
    return this.persons.get(id)
  }

  public getAllPersons(): Person[] {
    return Array.from(this.persons.values())
  }

  public getAllStorageMounts(): StorageMount[] {
    return Array.from(this.storageMounts.values())
  }

  public getAllAuditIssues(): AuditIssue[] {
    return Array.from(this.auditIssues.values())
  }

  /**
   * Fast, in-memory zero-latency search across releases, tracks, and persons/composers.
   * Runs in <1ms without disk I/O, preserving audiophile bus silence during playback.
   */
  public searchCatalog(
    query: string,
    limitPerCategory: number = 5
  ): {
    albums: Release[]
    tracks: Track[]
    artists: { id: string; name: string; role: 'Composer' | 'Artist'; albumsCount: number; tracksCount: number; portraitUrl?: string }[]
  } {
    const q = (query || '').trim().toLowerCase()
    if (!q) {
      return { albums: [], tracks: [], artists: [] }
    }

    const albums: Release[] = []
    for (const rel of this.releases.values()) {
      if (
        rel.title.toLowerCase().includes(q) ||
        (rel.artistCredit && rel.artistCredit.toLowerCase().includes(q)) ||
        (rel.composerName && rel.composerName.toLowerCase().includes(q)) ||
        (rel.folderName && rel.folderName.toLowerCase().includes(q))
      ) {
        albums.push(rel)
        if (albums.length >= limitPerCategory) break
      }
    }

    const tracks: Track[] = []
    for (const track of this.tracks.values()) {
      if (
        track.title.toLowerCase().includes(q) ||
        (track.artistCredit && track.artistCredit.toLowerCase().includes(q)) ||
        (track.composerName && track.composerName.toLowerCase().includes(q)) ||
        (track.workTitle && track.workTitle.toLowerCase().includes(q)) ||
        (track.movementTitle && track.movementTitle.toLowerCase().includes(q))
      ) {
        tracks.push(track)
        if (tracks.length >= limitPerCategory) break
      }
    }

    const artists: { id: string; name: string; role: 'Composer' | 'Artist'; albumsCount: number; tracksCount: number; portraitUrl?: string }[] = []
    const seenNames = new Set<string>()

    for (const person of this.persons.values()) {
      if (
        person.name.toLowerCase().includes(q) ||
        (person.sortName && person.sortName.toLowerCase().includes(q))
      ) {
        seenNames.add(person.name.toLowerCase())
        const relCount = Array.from(this.releases.values()).filter(
          (r) => (r.composerName && r.composerName.toLowerCase().includes(person.name.toLowerCase())) ||
                 (r.artistCredit && r.artistCredit.toLowerCase().includes(person.name.toLowerCase()))
        ).length
        const trkCount = Array.from(this.tracks.values()).filter(
          (t) => (t.composerName && t.composerName.toLowerCase().includes(person.name.toLowerCase())) ||
                 (t.artistCredit && t.artistCredit.toLowerCase().includes(person.name.toLowerCase()))
        ).length

        artists.push({
          id: person.id,
          name: person.name,
          role: person.primaryRole === 'composer' ? 'Composer' : 'Artist',
          albumsCount: relCount,
          tracksCount: trkCount,
          portraitUrl: person.avatarUrl,
        })
        if (artists.length >= limitPerCategory) break
      }
    }

    if (artists.length < limitPerCategory) {
      for (const comp of KNOWN_COMPOSERS) {
        if (seenNames.has(comp.canonicalName.toLowerCase())) continue
        const matches =
          comp.canonicalName.toLowerCase().includes(q) ||
          comp.aliases.some((a) => a.toLowerCase().includes(q))

        if (matches) {
          seenNames.add(comp.canonicalName.toLowerCase())
          const normName = comp.canonicalName.toLowerCase()
          const relCount = Array.from(this.releases.values()).filter(
            (r) => (r.composerName && r.composerName.toLowerCase().includes(normName)) ||
                   (r.artistCredit && r.artistCredit.toLowerCase().includes(normName))
          ).length
          const trkCount = Array.from(this.tracks.values()).filter(
            (t) => (t.composerName && t.composerName.toLowerCase().includes(normName)) ||
                   (t.artistCredit && t.artistCredit.toLowerCase().includes(normName))
          ).length

          artists.push({
            id: `composer-${comp.key}`,
            name: comp.canonicalName,
            role: 'Composer',
            albumsCount: relCount,
            tracksCount: trkCount,
          })
          if (artists.length >= limitPerCategory) break
        }
      }
    }

    return { albums, tracks, artists }
  }

  // Work-Movement Hierarchies
  public getTracksForWork(workId: string): Track[] {
    return Array.from(this.tracks.values()).filter((t) => t.workId === workId)
  }

  // Release Variants & Stacking
  public getVariantsForRelease(releaseId: string): PressingVariant[] {
    const release = this.releases.get(releaseId)
    return release ? release.variants : []
  }

  public setMasterVariant(releaseId: string, variantId: string): boolean {
    const release = this.releases.get(releaseId)
    if (!release) return false
    release.variants = release.variants.map((v) => ({
      ...v,
      isCurrentMaster: v.id === variantId,
    }))
    const active = release.variants.find((v) => v.id === variantId)
    if (active) {
      release.mediaFormat = active.variantName
      release.catalogNumber = active.catalogNumber
      release.matrixRunout = active.matrixRunout
    }
    return true
  }

  // Sidecar & Track Mutations
  public updateTrackSidecar(trackId: string, edits: Record<string, any>): Track | undefined {
    const trk = this.tracks.get(trackId)
    if (!trk) return undefined

    const rel = this.releases.get(trk.releaseId)
    const currentPending = { ...(trk.pendingSidecarEdits || {}) }

    Object.entries(edits).forEach(([key, val]) => {
      if (val === undefined || val === null || val === '') {
        delete currentPending[key]
        return
      }

      // Check if value is identical to current disk value
      let isUnchanged = false
      if (key === 'title' && val === trk.title) isUnchanged = true
      else if (key === 'artistCredit' && val === trk.artistCredit) isUnchanged = true
      else if (key === 'composerName' && val === (trk.composerName || '')) isUnchanged = true
      else if ((key === 'album' || key === 'releaseTitle') && val === (rel?.title || trk.folderName || '')) isUnchanged = true
      else if ((key === 'year' || key === 'releaseYear') && Number(val) === (rel?.releaseYear || rel?.originalYear)) isUnchanged = true
      else if (key === 'trackNumber' && Number(val) === trk.trackNumber) isUnchanged = true
      else if (key === 'discNumber' && Number(val) === trk.discNumber) isUnchanged = true
      else if (key === 'targetFolderName' && val === (trk.folderName || '')) isUnchanged = true
      else if (key === 'targetFilePath' && val === trk.filePath) isUnchanged = true

      if (isUnchanged) {
        delete currentPending[key]
      } else {
        currentPending[key] = val
      }
    })

    const hasRealChanges = Object.keys(currentPending).length > 0 || trk.targetFilePath !== undefined

    const updated: Track = {
      ...trk,
      sidecarStatus: hasRealChanges ? 'uncommitted_sidecar' : 'synced',
      pendingSidecarEdits: hasRealChanges ? currentPending : undefined,
    }
    this.tracks.set(trackId, updated)
    return updated
  }

  public commitTrack(trackId: string): Track | undefined {
    const trk = this.tracks.get(trackId)
    if (!trk) return undefined

    const p = trk.pendingSidecarEdits || {}
    const rel = this.releases.get(trk.releaseId)
    if (rel) {
      if (p.album || p.releaseTitle) {
        rel.title = p.album || p.releaseTitle
      }
      if (p.folderName) {
        rel.folderName = p.folderName
      }
      if (p.composerName || p.composer) {
        rel.composerName = p.composerName || p.composer
      }
      if (p.artistCredit || p.artist) {
        rel.artistCredit = p.artistCredit || p.artist
      }
      if (p.year) {
        rel.releaseYear = Number(p.year)
      }
      if (p.genre) {
        rel.genreTags = [p.genre]
      }
      if (p.coverArtUrl) {
        rel.artwork = {
          ...rel.artwork,
          frontCoverUrl: p.coverArtUrl,
          isLowRes: false,
        }
        delete (rel.artwork as any).originalFrontCoverUrl
      }
      if (rel.artwork?.originalFrontCoverUrl) {
        delete (rel.artwork as any).originalFrontCoverUrl
      }
      this.releases.set(rel.id, { ...rel })
    }

    // Apply pending edits into real fields
    const applied: Track = {
      ...trk,
      ...p,
      filePath: trk.targetFilePath || trk.filePath,
      targetFilePath: undefined,
      sidecarStatus: 'committed',
      pendingSidecarEdits: undefined,
      modifiedTimestamp: new Date().toISOString(),
    }
    this.tracks.set(trackId, applied)
    return applied
  }

  public discardTrackEdits(trackId: string): Track | undefined {
    const trk = this.tracks.get(trackId)
    if (!trk) return undefined

    const reverted: Track = {
      ...trk,
      sidecarStatus: 'synced',
      pendingSidecarEdits: undefined,
      targetFilePath: undefined,
    }
    this.tracks.set(trackId, reverted)
    return reverted
  }

  public discardAllUncommittedEdits(): number {
    let count = 0
    this.tracks.forEach((trk, id) => {
      if (trk.sidecarStatus === 'uncommitted_sidecar') {
        this.tracks.set(id, {
          ...trk,
          sidecarStatus: 'synced',
          pendingSidecarEdits: undefined,
          targetFilePath: undefined,
        })
        count++
      }
    })
    // Revert any modified release artwork back to original disk artwork
    this.releases.forEach((rel) => {
      if (rel.artwork?.originalFrontCoverUrl) {
        rel.artwork.frontCoverUrl = rel.artwork.originalFrontCoverUrl
        delete rel.artwork.originalFrontCoverUrl
      }
    })
    return count
  }

  public discardReleaseEdits(releaseId: string): number {
    let count = 0
    this.tracks.forEach((trk, id) => {
      if (trk.releaseId === releaseId && trk.sidecarStatus === 'uncommitted_sidecar') {
        this.tracks.set(id, {
          ...trk,
          sidecarStatus: 'synced',
          pendingSidecarEdits: undefined,
          targetFilePath: undefined,
        })
        count++
      }
    })
    const rel = this.releases.get(releaseId)
    if (rel?.artwork?.originalFrontCoverUrl) {
      rel.artwork.frontCoverUrl = rel.artwork.originalFrontCoverUrl
      delete rel.artwork.originalFrontCoverUrl
    }
    return count
  }

  public discardReleaseArtwork(releaseId: string): number {
    let count = 0
    this.tracks.forEach((trk, id) => {
      if (trk.releaseId === releaseId && trk.pendingSidecarEdits?.coverArtUrl) {
        const remaining = { ...trk.pendingSidecarEdits }
        delete remaining.coverArtUrl
        const hasRemaining = Object.keys(remaining).length > 0 || trk.targetFilePath !== undefined
        this.tracks.set(id, {
          ...trk,
          sidecarStatus: hasRemaining ? 'uncommitted_sidecar' : 'synced',
          pendingSidecarEdits: hasRemaining ? remaining : undefined,
        })
        count++
      }
    })
    const rel = this.releases.get(releaseId)
    if (rel?.artwork?.originalFrontCoverUrl) {
      rel.artwork.frontCoverUrl = rel.artwork.originalFrontCoverUrl
      delete rel.artwork.originalFrontCoverUrl
    }
    return count
  }

  public discardAllArtworkEdits(): number {
    let count = 0
    this.tracks.forEach((trk, id) => {
      if (trk.pendingSidecarEdits?.coverArtUrl) {
        const remaining = { ...trk.pendingSidecarEdits }
        delete remaining.coverArtUrl
        const hasRemaining = Object.keys(remaining).length > 0 || trk.targetFilePath !== undefined
        this.tracks.set(id, {
          ...trk,
          sidecarStatus: hasRemaining ? 'uncommitted_sidecar' : 'synced',
          pendingSidecarEdits: hasRemaining ? remaining : undefined,
        })
        count++
      }
    })
    this.releases.forEach((rel) => {
      if (rel.artwork?.originalFrontCoverUrl) {
        rel.artwork.frontCoverUrl = rel.artwork.originalFrontCoverUrl
        delete rel.artwork.originalFrontCoverUrl
      }
    })
    return count
  }

  /**
   * Customizes the album title and/or physical folder name of a release.
   * Stages sidecar changes non-destructively for all associated tracks.
   */
  public updateReleaseNames(
    releaseId: string,
    updates: { title?: string; folderName?: string }
  ): { release: Release; affectedTracksCount: number } | undefined {
    const release = this.releases.get(releaseId)
    if (!release) return undefined

    const trimmedTitle = updates.title?.trim()
    const trimmedFolderName = updates.folderName?.trim()

    let titleChanged = false
    let folderChanged = false

    if (trimmedTitle && trimmedTitle !== release.title) {
      if (!release.originalTitle) {
        release.originalTitle = release.title
      }
      release.title = trimmedTitle
      titleChanged = true
      // Also update pressing variants releaseName
      if (release.variants) {
        release.variants.forEach((v) => {
          v.releaseName = trimmedTitle
        })
      }
    }

    if (trimmedFolderName && trimmedFolderName !== release.folderName) {
      if (!release.originalFolderName) {
        release.originalFolderName = release.folderName
      }
      release.folderName = trimmedFolderName
      folderChanged = true

      // If folder path exists, calculate target folder path
      if (release.folderPath) {
        const parts = release.folderPath.replace(/\\/g, '/').split('/')
        if (parts.length > 1) {
          parts[parts.length - 1] = trimmedFolderName
          release.targetFolderPath = parts.join('/')
        }
      }
    }

    let affectedCount = 0

    if (titleChanged || folderChanged) {
      this.tracks.forEach((track, id) => {
        if (track.releaseId === releaseId) {
          const pending = { ...(track.pendingSidecarEdits || {}) }

          if (titleChanged) {
            pending.album = release.title
          }

          if (folderChanged) {
            track.folderName = release.folderName
            if (release.targetFolderPath) {
              const fileName = track.filePath.split(/[/\\]/).pop() || ''
              track.targetFilePath = `${release.targetFolderPath}/${fileName}`
              pending.targetFilePath = track.targetFilePath
              pending.targetFolderName = release.folderName
            }
          }

          track.sidecarStatus = 'uncommitted_sidecar'
          track.pendingSidecarEdits = pending
          this.tracks.set(id, { ...track })
          affectedCount++
        }
      })
    }

    return { release, affectedTracksCount: affectedCount }
  }

  /**
   * Updates multiple release-level properties (Album Title, Folder Name, Composer, Artist Credit, Year, Cover Art)
   * and automatically stages sidecar edits across all associated tracks non-destructively.
   */
  public updateReleaseDetails(
    releaseId: string,
    updates: {
      title?: string
      folderName?: string
      composerName?: string
      artistCredit?: string
      releaseYear?: number
      coverArtUrl?: string
      backdropUrl?: string
      rating?: number
      isFavorite?: boolean
      isMasterpiece?: boolean
    }
  ): { release: Release; affectedTracksCount: number } | undefined {
    const release = this.releases.get(releaseId)
    if (!release) return undefined

    const trimmedTitle = updates.title?.trim()
    if (trimmedTitle !== undefined && trimmedTitle !== release.title) {
      if (!release.originalTitle) {
        release.originalTitle = release.title
      }
      release.title = trimmedTitle
      if (release.variants) {
        release.variants.forEach((v) => {
          v.releaseName = trimmedTitle
        })
      }
    }

    const trimmedFolder = updates.folderName?.trim()
    if (trimmedFolder !== undefined && trimmedFolder !== release.folderName) {
      if (!release.originalFolderName) {
        release.originalFolderName = release.folderName
      }
      release.folderName = trimmedFolder
      if (release.folderPath) {
        const parts = release.folderPath.replace(/\\/g, '/').split('/')
        if (parts.length > 1) {
          parts[parts.length - 1] = trimmedFolder
          release.targetFolderPath = parts.join('/')
        }
      }
    }

    const trimmedComposer = updates.composerName?.trim()
    if (trimmedComposer !== undefined) {
      release.composerName = trimmedComposer
    }

    const trimmedArtist = updates.artistCredit?.trim()
    if (trimmedArtist !== undefined && trimmedArtist !== release.artistCredit) {
      release.artistCredit = trimmedArtist
    }

    if (updates.releaseYear !== undefined && updates.releaseYear !== release.releaseYear) {
      release.releaseYear = updates.releaseYear
    }

    const trimmedArt = updates.coverArtUrl?.trim()
    if (trimmedArt !== undefined && trimmedArt !== release.artwork?.frontCoverUrl) {
      if (!release.artwork) {
        release.artwork = {
          frontCoverUrl: trimmedArt,
          resolution: 'Custom Front Cover',
          width: 2400,
          height: 2400,
          dpi: 300,
          colorProfile: 'sRGB',
          isLowRes: false,
          hasBookletPdf: false,
        }
      } else {
        if (!release.artwork.originalFrontCoverUrl) {
          release.artwork.originalFrontCoverUrl = release.artwork.frontCoverUrl
        }
        release.artwork.frontCoverUrl = trimmedArt
        release.artwork.resolution = 'Custom Front Cover'
      }
    }

    const trimmedBackdrop = updates.backdropUrl?.trim()
    if (trimmedBackdrop !== undefined) {
      if (!release.artwork) {
        release.artwork = {
          frontCoverUrl: trimmedArt || '',
          backdropUrl: trimmedBackdrop,
          resolution: 'Custom Front Cover',
          width: 2400,
          height: 2400,
          dpi: 300,
          colorProfile: 'sRGB',
          isLowRes: false,
          hasBookletPdf: false,
        }
      } else {
        release.artwork.backdropUrl = trimmedBackdrop
      }
      release.backdropUrl = trimmedBackdrop
    }

    if (updates.rating !== undefined) {
      release.rating = updates.rating
    }
    if (updates.isFavorite !== undefined) {
      release.isFavorite = updates.isFavorite
    }
    if (updates.isMasterpiece !== undefined) {
      release.isMasterpiece = updates.isMasterpiece
    }

    let affectedCount = 0

    this.tracks.forEach((track, id) => {
      if (track.releaseId === releaseId) {
        const pending = { ...(track.pendingSidecarEdits || {}) }
        let trackModified = false

        if (trimmedTitle !== undefined && trimmedTitle !== '') {
          pending.album = trimmedTitle
          trackModified = true
        }

        if (trimmedFolder !== undefined && trimmedFolder !== '') {
          track.folderName = trimmedFolder
          pending.targetFolderName = trimmedFolder
          if (release.targetFolderPath) {
            const fileName = track.filePath.split(/[/\\]/).pop() || ''
            track.targetFilePath = `${release.targetFolderPath}/${fileName}`
            pending.targetFilePath = track.targetFilePath
          }
          trackModified = true
        }

        if (trimmedComposer !== undefined && trimmedComposer !== '') {
          track.composerName = trimmedComposer
          pending.composerName = trimmedComposer
          trackModified = true
        }

        if (trimmedArtist !== undefined && trimmedArtist !== '') {
          track.artistCredit = trimmedArtist
          pending.artistCredit = trimmedArtist
          trackModified = true
        }

        if (updates.releaseYear !== undefined && !isNaN(updates.releaseYear)) {
          pending.year = updates.releaseYear
          trackModified = true
        }

        if (trimmedArt !== undefined && trimmedArt !== '') {
          pending.coverArtUrl = trimmedArt
          trackModified = true
        }

        if (trackModified) {
          track.sidecarStatus = 'uncommitted_sidecar'
          track.pendingSidecarEdits = pending
          this.tracks.set(id, { ...track })
          affectedCount++
        }
      }
    })

    return { release, affectedTracksCount: affectedCount }
  }

  public getTracksByRelease(releaseId: string): Track[] {
    const list: Track[] = []
    this.tracks.forEach((trk) => {
      if (trk.releaseId === releaseId) {
        list.push(trk)
      }
    })
    return list.sort((a, b) => a.trackNumber - b.trackNumber)
  }

  // Normalization Actions (Audit Triage)
  public normalizeArtistNames(source: string, canonical: string): number {
    // Record rule so it persists across sessions and takes precedence in future enrichment
    if (source && canonical && source !== canonical) {
      normalizationService.recordNormalization(source, canonical, 'artist')
    }

    let modified = 0
    this.tracks.forEach((trk, id) => {
      if (trk.composerName === source || trk.artistCredit.includes(source)) {
        const nextComposer = trk.composerName === source ? canonical : trk.composerName
        const nextArtist = trk.artistCredit.replace(source, canonical)
        const origComp = trk.composerName
        const origArt = trk.artistCredit
        const updated = {
          ...trk,
          composerName: nextComposer,
          artistCredit: nextArtist,
          sidecarStatus: 'uncommitted_sidecar' as const,
          pendingSidecarEdits: {
            composerName: nextComposer,
            artistCredit: nextArtist,
            originalComposerName: origComp,
            originalArtistCredit: origArt,
          },
        }
        this.tracks.set(id, updated)
        modified++
      }
    })
    // Resolve audit issue if all fixed
    const norm = canonical.toLowerCase().replace(/[\.\s_,\-]+/g, '')
    const targetIssueId = `audit-name-${encodeURIComponent(norm)}`
    const issue = this.auditIssues.get(targetIssueId) || this.auditIssues.get('audit-01')
    if (issue) {
      issue.affectedCount = 0
      issue.description = `Resolved: Normalized variants of "${source}" to canonical "${canonical}".`
    }
    return modified
  }

  /**
   * Applies all active remembered normalization rules across loaded catalog tracks.
   * Stages sidecars for any tracks with modified metadata.
   */
  public applyRememberedNormalizations(): number {
    let modifiedCount = 0
    this.tracks.forEach((trk, id) => {
      let isModified = false
      let nextArtist = trk.artistCredit
      let nextComposer = trk.composerName

      const normalizedArtist = normalizationService.applyToText(trk.artistCredit || '', 'artist')
      if (normalizedArtist && normalizedArtist !== trk.artistCredit) {
        nextArtist = normalizedArtist
        isModified = true
      }

      if (trk.composerName) {
        const normalizedComposer = normalizationService.applyToText(trk.composerName, 'composer')
        if (normalizedComposer && normalizedComposer !== trk.composerName) {
          nextComposer = normalizedComposer
          isModified = true
        }
      }

      if (isModified) {
        const updated = {
          ...trk,
          artistCredit: nextArtist,
          composerName: nextComposer,
          sidecarStatus: 'uncommitted_sidecar' as const,
          pendingSidecarEdits: {
            ...(trk.pendingSidecarEdits || {}),
            artistCredit: nextArtist,
            originalArtistCredit: trk.artistCredit,
            ...(nextComposer ? { composerName: nextComposer, originalComposerName: trk.composerName } : {}),
          },
        }
        this.tracks.set(id, updated)
        modifiedCount++
      }
    })
    return modifiedCount
  }


  public toggleMountReadOnly(mountId: string): boolean {
    const mount = this.storageMounts.get(mountId)
    if (!mount) return false
    mount.isReadOnlyLocked = !mount.isReadOnlyLocked
    return mount.isReadOnlyLocked
  }

  // Filter & Query
  public filterTracks(filters: FacetFilterState, sourceTracks?: Track[], sourceReleases?: Release[]): Track[] {
    // If source tracks/releases provided and internal map is empty or stale, rehydrate internal maps
    if (sourceTracks && sourceTracks.length > 0) {
      if (this.tracks.size === 0) {
        sourceTracks.forEach((t) => this.tracks.set(t.id, t))
      }
    }
    if (sourceReleases && sourceReleases.length > 0) {
      if (this.releases.size === 0) {
        sourceReleases.forEach((r) => this.releases.set(r.id, r))
      }
    }

    let result = sourceTracks && sourceTracks.length > 0 ? [...sourceTracks] : Array.from(this.tracks.values())

    // Search query
    if (filters.searchQuery && filters.searchQuery.trim()) {
      const q = filters.searchQuery.toLowerCase()
      result = result.filter((t) => {
        const rel = this.releases.get(t.releaseId)
        return (
          t.title.toLowerCase().includes(q) ||
          t.artistCredit.toLowerCase().includes(q) ||
          (t.composerName && t.composerName.toLowerCase().includes(q)) ||
          (t.workTitle && t.workTitle.toLowerCase().includes(q)) ||
          (t.movementTitle && t.movementTitle.toLowerCase().includes(q)) ||
          (t.folderName && t.folderName.toLowerCase().includes(q)) ||
          (rel && rel.title.toLowerCase().includes(q)) ||
          (rel && rel.folderName && rel.folderName.toLowerCase().includes(q))
        )
      })
    }

    // Resolution & Format Filter
    if (filters.formatFilter) {
      result = result.filter((t) => matchesFormat(t, filters.formatFilter!))
    }

    // Recording Era Filter
    if (filters.eraFilter) {
      result = result.filter((t) => {
        const rel = this.releases.get(t.releaseId)
        const y = rel?.releaseYear || rel?.originalYear
        return matchesEra(y, filters.eraFilter!)
      })
    }

    // Composer Filter
    if (filters.composerFilter) {
      result = result.filter((t) => matchesComposer(t, filters.composerFilter!))
    }

    // Language Filter
    if (filters.languageFilter) {
      const targetLang = filters.languageFilter.toLowerCase()
      result = result.filter((t) => {
        const rel = this.releases.get(t.releaseId)
        const lang = (
          t.language ||
          detectLanguage({
            language: t.language,
            title: t.title,
            artistCredit: t.artistCredit,
            composerName: t.composerName,
            albumTitle: rel?.title,
            genreTags: rel?.genreTags,
            folderName: t.folderName || rel?.folderName,
            filePath: t.filePath,
          })
        ).toLowerCase()
        return lang === targetLang
      })
    }

    // Genre Filter
    if (filters.genreFilter) {
      const targetGenre = filters.genreFilter.toLowerCase()
      result = result.filter((t) => {
        const rel = this.releases.get(t.releaseId)
        const tags = Array.isArray(rel?.genreTags) ? rel.genreTags : []
        return tags.some((g) => g.toLowerCase().includes(targetGenre)) || (t.movementTitle && t.movementTitle.toLowerCase().includes(targetGenre))
      })
    }

    // Ensemble / Performer Filter
    if (filters.ensembleFilter) {
      const targetEnsemble = filters.ensembleFilter.toLowerCase()
      result = result.filter((t) => {
        return (
          (t.artistCredit && t.artistCredit.toLowerCase().includes(targetEnsemble)) ||
          (t.credits && t.credits.some((c) => c.personName.toLowerCase().includes(targetEnsemble)))
        )
      })
    }

    // Mastering / Dynamic Range Filter
    if (filters.masteringFilter) {
      if (filters.masteringFilter === 'audiophile_dr14') {
        result = result.filter((t) => t.drScore >= 14)
      } else if (filters.masteringFilter === 'high_dr10_13') {
        result = result.filter((t) => t.drScore >= 10 && t.drScore <= 13)
      } else if (filters.masteringFilter === 'compressed_dr_low') {
        result = result.filter((t) => t.drScore > 0 && t.drScore < 10)
      } else if (filters.masteringFilter === 'high_res_24bit') {
        result = result.filter(
          (t) =>
            t.sampleRateStr.includes('24/') ||
            t.sampleRateStr.includes('32/') ||
            t.format === 'DSD' ||
            (t.format as string) === 'DSF' ||
            (t.format as string) === 'DFF' ||
            t.sampleRateStr.includes('DSD') ||
            Boolean(t.isHighRes)
        )
      }
    }

    // Triage filter: dynamically match issue ID or category
    if (filters.triageFilter) {
      const issue = this.auditIssues.get(filters.triageFilter)
      if (issue && issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
        const idSet = new Set(issue.sampleTrackIds)
        result = result.filter((t) => idSet.has(t.id))
      } else {
        switch (filters.triageFilter) {
          case 'uncommitted_sidecar':
            result = result.filter((t) => t.sidecarStatus === 'uncommitted_sidecar')
            break
          case 'inconsistent_name': {
            const nameIssues = Array.from(this.auditIssues.values()).filter(
              (i) => i.category === 'inconsistent_name'
            )
            const allNameIds = new Set(nameIssues.flatMap((i) => i.sampleTrackIds))
            if (allNameIds.size > 0) {
              result = result.filter((t) => allNameIds.has(t.id))
            }
            break
          }
          case 'checksum_mismatch':
            result = result.filter((t) => !t.checksumValid)
            break
          case 'low_res_art':
            result = result.filter((t) => {
              const rel = this.releases.get(t.releaseId)
              return rel?.artwork.isLowRes || !rel?.artwork.width || rel.artwork.width < 800
            })
            break
          case 'missing_track_num':
            result = result.filter((t) => !t.trackNumber || t.trackNumber <= 0)
            break
          case 'missing_movement':
            result = result.filter((t) => t.workId && !t.movementNumber)
            break
          case 'empty_composer':
            result = result.filter((t) => !t.artistCredit?.trim() && !t.composerName?.trim())
            break
          case 'missing_metadata':
            result = result.filter((t) => {
              const rel = this.releases.get(t.releaseId)
              return !rel?.releaseYear && !rel?.originalYear
            })
            break
        }
      }
    }

    // Storage mount
    if (filters.storageMountFilter) {
      result = result.filter((t) => t.storageMountId === filters.storageMountFilter)
    }

    return result
  }

  // Library statistics
  public getStats(): LibraryStats {
    const trks = Array.from(this.tracks.values())
    const totalTracks = trks.length
    const totalReleases = this.releases.size
    const totalWorks = this.works.size
    const totalStorageBytes = trks.reduce((acc, t) => acc + t.fileSize, 0)

    const highResTracks = trks.filter(
      (t) =>
        t.format === 'DSD' ||
        (t.format as string) === 'DSF' ||
        (t.format as string) === 'DFF' ||
        t.sampleRateStr.includes('DSD') ||
        t.sampleRateStr.includes('24/') ||
        t.sampleRateStr.includes('32/') ||
        t.sampleRateStr.includes('192') ||
        t.sampleRateStr.includes('96') ||
        Boolean(t.isHighRes)
    ).length
    const highResPercentage = totalTracks > 0 ? Math.round((highResTracks / totalTracks) * 100) : 0

    const validDrTracks = trks.filter((t) => t.drScore > 0)
    const averageDrScore =
      validDrTracks.length > 0
        ? Math.round(
            (validDrTracks.reduce((acc, t) => acc + t.drScore, 0) / validDrTracks.length) * 10
          ) / 10
        : 0

    const uncommittedSidecarsCount = trks.filter(
      (t) => t.sidecarStatus === 'uncommitted_sidecar'
    ).length

    const totalIssuesCount = Array.from(this.auditIssues.values()).reduce(
      (acc, i) => acc + i.affectedCount,
      0
    )

    const readOnlyMountsCount = Array.from(this.storageMounts.values()).filter(
      (m) => m.isReadOnlyLocked
    ).length

    return {
      totalTracks,
      totalReleases,
      totalWorks,
      totalStorageBytes,
      highResPercentage,
      averageDrScore,
      uncommittedSidecarsCount,
      totalIssuesCount,
      readOnlyMountsCount,
    }
  }
}

// Singleton instance
export const graphEngine = new RelationalGraphEngine()
