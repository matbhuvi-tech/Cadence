export type CreditRole =
  | 'composer'
  | 'arranger'
  | 'primary_artist'
  | 'featured_artist'
  | 'soloist'
  | 'conductor'
  | 'ensemble'
  | 'recording_engineer'
  | 'mastering_engineer'
  | 'lyricist'
  | 'producer'

export interface Person {
  id: string
  name: string
  sortName: string
  disambiguation?: string
  primaryRole: CreditRole
  secondaryRoles?: CreditRole[]
  externalIds?: {
    musicbrainz?: string
    discogs?: string
    wikidata?: string
  }
  avatarUrl?: string
  lifespan?: string
}

export interface Credit {
  personId: string
  personName: string
  role: CreditRole
  instrumentOrDetail?: string
}

export interface Movement {
  sequence: number
  movementNumber: string // "I", "II", "Act I Sc. 2"
  title: string
  tempoOrForm?: string // "Allegro con brio", "Adagio", "Rondo"
  durationSeconds: number
}

export interface Work {
  id: string
  title: string
  opusOrCatalogueNumber?: string // "Op. 67", "BWV 1007", "KV 550"
  musicalKey?: string // "C minor", "D major"
  compositionYear?: number
  isMultiPart: boolean
  parentWorkId?: string
  movementNumber?: string
  movementTitle?: string
  movementSequence?: number
  composerId: string
  composerName: string
  genreIds: string[]
  movements?: Movement[]
}

export type AudioFormat = 'FLAC' | 'DSD' | 'ALAC' | 'WAV' | 'AAC' | 'MP3'

export interface Recording {
  id: string
  workId: string
  workTitle: string
  movementNumber?: string
  acousticFingerprint: string // Chromaprint hash snippet
  audioStreamMd5: string
  flacCrcValid: boolean
  sampleRate: number // e.g. 44100, 96000, 192000, 2822400 (DSD64), 11289600 (DSD256)
  bitDepth: number // 16, 24, 32, 1 (DSD)
  channels: string // "2.0 Stereo", "5.1 Multichannel", "Atmos"
  format: AudioFormat
  durationSeconds: number
  drScore: number // Dynamic Range (1 to 20)
  peakDb: number
  rmsDb: number
  hasClipping: boolean
  recordingDate?: string
  venue?: string
  ensembleId?: string
  ensembleName?: string
  conductorId?: string
  conductorName?: string
  soloists: Credit[]
}

export interface ArtworkMeta {
  frontCoverUrl: string
  backdropUrl?: string // Dedicated 2400x320 panoramic derivative for album header
  originalFrontCoverUrl?: string
  backCoverUrl?: string
  innerSleeveUrl?: string
  resolution: string // e.g. "3000x3000px"
  width: number
  height: number
  dpi: number
  colorProfile: string
  isLowRes: boolean
  hasBookletPdf: boolean
  bookletPagesCount?: number
}

export interface PressingVariant {
  id: string
  masterReleaseId: string
  releaseName: string
  variantName: string // e.g., "1959 US Columbia 6-Eye First Press Mono", "1986 Japan 32DP-513 CD Master"
  releaseYear: number
  drScore: number
  sampleRateStr: string
  formatStr: string
  matrixRunout: string
  catalogNumber: string
  label: string
  isCurrentMaster: boolean
  country: string
}

export type AlbumDisplayMode = 'album_first' | 'folder_first' | 'both'

export interface Release {
  id: string
  masterReleaseId: string
  title: string
  originalTitle?: string
  folderName?: string
  originalFolderName?: string
  folderPath?: string
  targetFolderPath?: string
  artistCredit: string
  composerName?: string
  releaseYear: number
  originalYear: number
  label: string
  catalogNumber: string
  barcodeUpc?: string
  mediaFormat: string // "180g Virgin Vinyl", "Redbook CD", "SACD Hybrid", "DSD256 Master Tape Transfer"
  country: string
  matrixRunout: string
  artwork: ArtworkMeta
  coverArtUrl?: string
  backdropUrl?: string // Dedicated panoramic derivative asset
  variants: PressingVariant[]
  discsCount: number
  tracksCount: number
  genreTags: string[]
  storageMountId: string
  language?: string
}

export type SidecarStatus = 'synced' | 'uncommitted_sidecar' | 'committed'

export interface Track {
  id: string
  releaseId: string
  recordingId: string
  workId?: string
  trackNumber: number
  discNumber: number
  title: string
  workTitle?: string
  movementNumber?: string
  movementTitle?: string
  composerName?: string
  artistCredit: string
  language?: string
  durationSeconds: number
  duration?: number
  filePath: string
  fileSize: number // in bytes
  storageMountId: string
  folderName?: string
  folderPath?: string
  targetFilePath?: string
  sidecarStatus: SidecarStatus
  pendingSidecarEdits?: Record<string, any>
  modifiedTimestamp: string
  checksumValid: boolean
  accurateRipConfidence: number // 0 = no match, >0 = verified rips
  drScore: number
  sampleRateStr: string
  format: AudioFormat
  isHighRes?: boolean
  credits: Credit[]
  masterReleaseId: string
  isOnline?: boolean
}

export interface StorageMount {
  id: string
  name: string
  mountPath: string
  type: 'nas_array' | 'nvme_scratch' | 'usb_vault' | 'local_disk'
  fileSystem: 'Btrfs' | 'ZFS' | 'APFS' | 'NTFS'
  totalBytes: number
  usedBytes: number
  isReadOnlyLocked: boolean
  healthScore: 'healthy' | 'scrubbing' | 'degraded'
  smartOk: boolean
  tempCelsius: number
  status?: 'online' | 'offline' | 'scanning'
  lastSeenTimestamp?: string
  watchedFoldersCount?: number
}

export interface WatchedFolder {
  id: string
  mountId: string
  folderPath: string
  displayName: string
  scanMode: 'realtime' | 'manual'
  ignorePatterns?: string
  isEnabled: boolean
  lastScannedTimestamp?: string
}

export interface ScanProgressPayload {
  stage: 'idle' | 'discovery' | 'extraction' | 'database' | 'complete' | 'cancelled'
  processedCount: number
  totalCount: number
  currentFile: string
  currentFolder: string
  speedTracksPerSec: number
  etaSeconds: number
  isPaused: boolean
  isScanning: boolean
  skippedCount: number
}

export interface ScanCompletePayload {
  folderPath: string
  totalDiscovered: number
  importedCount: number
  updatedCount: number
  skippedCount: number
  durationSecs: number
  status: 'completed' | 'cancelled' | 'failed'
}

export interface SkippedFile {
  id: string
  filePath: string
  fileName: string
  category: 'corrupt_header' | 'unsupported_format' | 'zero_byte' | 'permission_denied' | 'duplicate'
  diagnosticError: string
  timestamp: string
  isIgnored: boolean
}

export type AuditCategory =
  | 'inconsistent_name'
  | 'missing_movement'
  | 'low_res_art'
  | 'missing_track_num'
  | 'empty_composer'
  | 'missing_metadata'
  | 'uncommitted_sidecar'
  | 'checksum_mismatch'
  | 'unmatched_fingerprint'
  | 'duplicate_master'
  | 'compilation_conflict'

export interface AuditIssue {
  id: string
  category: AuditCategory
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  affectedCount: number
  sampleTrackIds: string[]
  suggestedFix: string
  autoFixAction?: string
  isAutoFixable?: boolean
  fixActionLabel?: string
  manualActionHint?: string
}

export type DiffSource = 'current' | 'itunes' | 'musicbrainz' | 'ai' | 'discogs' | 'manual'

export interface DiffField {
  fieldName: string
  label: string
  currentValue: string
  itunesValue?: string
  musicbrainzValue?: string
  aiValue?: string
  discogsValue?: string
  bandcampValue?: string
  selectedSource: DiffSource
  customValue?: string
  status: 'identical' | 'added' | 'mutated'
}

export interface TransactionSnapshot {
  id: string
  timestamp: string
  description: string
  affectedTracksCount: number
  backupManifestHash: string
  phase: 'prepared' | 'committed' | 'rolled_back'
}
