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

export interface ArtistSummary {
  id: string
  name: string
  sortName?: string
  portraitUrl?: string
  portraitStatus?: 'pending' | 'enriched' | 'not_found' | 'manual_override'
  primaryRole: string
  albumsCount: number
  tracksCount: number
  roles: string[]
  eraActive?: string
}

export interface ArtistCreditItem {
  trackId: string
  trackTitle: string
  trackNumber?: number
  releaseId: string
  releaseTitle: string
  releaseYear?: number
  role: string
  format: string
  sampleRate?: number
  bitDepth?: number
  drScore?: number
  durationSecs: number
  fullArtistCredit: string
  coArtists: string[]
}

export interface ArtistDetail {
  artist: {
    id: string
    name: string
    sortName?: string
    mbid?: string
    appleArtistId?: string
    portraitUrl?: string
    portraitStatus?: string
    bioSummary?: string
    eraActive?: string
    primaryRole: string
    createdAt: string
  }
  albumsCount: number
  tracksCount: number
  roles: string[]
  discography: Release[]
  appearingTracks: ArtistCreditItem[]
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
  releaseId?: string
  masterReleaseId: string
  releaseName: string
  variantName: string // e.g., "1959 US Columbia 6-Eye First Press Mono", "1986 Japan 32DP-513 CD Master"
  folderName?: string
  folderPath?: string
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
  // Curation fields (DB-only, non-destructive)
  rating?: number // 1 to 5 stars
  isFavorite?: boolean
  isMasterpiece?: boolean
  isCollected?: boolean
}

export interface ActiveEntityScope {
  type: 'composer' | 'artist' | 'album'
  name: string
  albumId?: string
  parentEntity?: string
  parentType?: 'composer' | 'artist'
}

export type CanvasViewMode =
  | 'cover_grid'
  | 'virtual_table'
  | 'work_movement'
  | 'variant_stack'
  | 'folder_tree'
  | 'playlist_detail'

export interface FacetSelections {
  era?: string
  composer?: string
  language?: string
  format?: string
  genre?: string
  ensemble?: string
  mastering?: string
  rating?: number
}

export type DRSource = 'embedded_tag' | 'replaygain_calc' | 'measured' | 'decoded_pcm' | 'estimated'

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
  drSource?: DRSource
  sampleRateStr: string
  format: AudioFormat
  isHighRes?: boolean
  sampleRate?: number
  bitDepth?: number
  acousticFingerprint?: string
  audioStreamMd5?: string
  credits: Credit[]
  masterReleaseId: string
  isOnline?: boolean
  canonicalAlbumTitle?: string
  canonicalReleaseId?: string
  canonicalReleaseYear?: number
  isCanonicalAlbumTrack?: boolean
  // Curation fields (DB-only)
  rating?: number
  isFavorite?: boolean
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
  lastScanned?: string
  trackCount?: number
}

export interface ScanProgressPayload {
  stage: 'idle' | 'discovery' | 'extraction' | 'database' | 'suspended_playback' | 'complete' | 'cancelled'
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
  | 'unformatted_backdrop'

export type TagFieldType =
  | 'ALBUMARTIST'
  | 'ARTIST'
  | 'COMPOSER'
  | 'TRACK_NUMBER'
  | 'COVER_ART'
  | 'METADATA'
  | 'BACKDROP'

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
  tagField?: TagFieldType
  detectedValue?: string
  proposedAction?: string
  parentEntity?: string
  canonicalTarget?: string
  currentValue?: string
  targetValue?: string
  isRoleConflict?: boolean
  confidence?: 'high_confidence_typo' | 'role_review_required'
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

export interface PlaybackStatePayload {
  isPlaying: boolean
  isPaused: boolean
  currentFile: string | null
  positionSecs: number
  durationSecs: number
  volume: number
  activeDevice?: string
  streamInfo?: any
  purityMode?: boolean
  isBitPerfect?: boolean
  outputSampleRate?: number
  outputChannels?: number
  deviceType?: string
}

export interface Playlist {
  id: string
  title: string
  description?: string
  coverArtUrl?: string
  createdAt: string
  updatedAt: string
  tags?: string[]
  listeningNotes?: string
  tracksCount: number
  totalDurationSecs: number
  formatBreakdown: string // e.g. "14 tracks • DSD/FLAC hybrid"
  trackIds?: string[]
  tracks?: Track[]
}

export interface SampleRateTransition {
  fromSampleRate?: number
  toSampleRate?: number
  fromFormat: string
  toFormat: string
  isSameFamily: boolean // 44.1 family vs 48 family vs DSD
  warningLabel: string
  settlingDelayMs: number
}

