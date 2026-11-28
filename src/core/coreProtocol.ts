import type { CoreBuildInfo } from './buildInfo'
import type { EngineActivity, EngineContext } from './engineSession'

export type { CoreBuildInfo }

/** Control-plane v1/v2 contracts. Media, SQL, and raw host paths stay on the Engine. */
export const CORE_PROTOCOL_VERSION = 1 as const
export const CORE_PROTOCOL_VERSION_V2 = 2 as const
export const CORE_PROTOCOL_V2_REVISION = 2 as const
export const CORE_SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const
export const CORE_MAX_MESSAGE_BYTES = 1_048_576
export const CORE_MAX_QUEUE_ENTRIES = 4096
export const CORE_MAX_PAGE_TRACKS = 200
export const CORE_REQUIRED_CAPABILITIES = ['catalog.read', 'session.read', 'playback.control', 'queue.write'] as const

export interface CoreDescriptor {
  protocolVersion: typeof CORE_PROTOCOL_VERSION | typeof CORE_PROTOCOL_VERSION_V2
  protocolRevision?: number
  build?: CoreBuildInfo
  engineId: string
  libraryId: string
  label: string
  capabilities: string[]
  ready: boolean
}

export interface CoreCatalogTrack {
  id: string
  title: string
  artist: string
  album: string
  durationSeconds: number
  releaseId?: string
  albumArtist?: string
  isCompilation?: boolean
  edition?: string
  format?: string
  sampleRate?: number
  bitDepth?: number
  trackNumber?: number
  discNumber?: number
  releaseYear?: number
  composerName?: string | null
  genreTags?: string[]
  folderName?: string | null
  folderPath?: string | null
  fileName?: string | null
  language?: string | null
  dynamicRange?: number | null
  hasCoverArt?: boolean
  provenanceStatus?: string | null
  lyrics?: string | null
  fingerprintStatus?: string | null
}

export interface EngineFsEntry {
  name: string
  path: string
  isDir: boolean
  readable: boolean
  isWatched: boolean
}

export interface EngineFsBrowseResult {
  entries: EngineFsEntry[]
  cached?: boolean
}

export interface EngineFolderRecord {
  id: string
  path: string
  displayName: string
  scanMode: 'manual' | 'startup' | string
  lastScannedAt: string | null
  trackCount: number
  online: boolean
}

export interface EngineScanStatus {
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | string
  folderId?: string
  path?: string
  processed?: number
  errorCount?: number
  imported?: number
  skipped?: number
  errors?: Array<string | EngineScanError>
  forceFull?: boolean
  deferred?: boolean
  roots?: Array<{ id: string; path: string }>
}

export interface EngineScanError {
  path: string
  message: string
}

export interface EnginePlaylistSummary {
  id: string
  title: string
  description: string | null
}

export interface EnginePlaylistDetail {
  id: string
  title: string
  description: string | null
  trackIds: string[]
}

export interface EngineCurateDraftSummary {
  draftId: string
  trackId: string
  revision: number
  status: string
  changes: Array<{ field: string; before: string; after: string }>
}

export interface EngineEventRecord {
  event: string
  data?: Record<string, unknown>
}

export interface CoreCatalogPage {
  revision: number
  tracks: CoreCatalogTrack[]
  nextCursor: string | null
}

export interface CoreQueueEntry { entryId: string; trackId: string }

export type PlaybackOwner = 'none' | 'core' | 'external'

export interface ExternalPlaybackInfo {
  active: boolean
  transportState: string
  currentUri?: string
  positionSeconds?: number
}

export interface CoreSnapshot {
  engineId: string
  libraryId: string
  revision: number
  /** Initial catalog page, not a claim that the full library fits in one response. */
  catalog: CoreCatalogPage
  queue: { entries: CoreQueueEntry[]; currentEntryId: string | null; repeat: 'off' | 'one' | 'all'; shuffle: boolean }
  playback: {
    activity: EngineActivity
    positionSeconds: number
    owner?: PlaybackOwner
    takeoverRequired?: boolean
    externalPlayback?: ExternalPlaybackInfo
  }
  output: { id: string; label: string; transport: 'upnp' | 'wasapi' | 'system_default' } | null
}

type Mutation = { commandId: string; expectedRevision: number }
export type CoreCommand = Mutation & (
  | { operation: 'playback.control'; action: 'pause' | 'resume' | 'stop' }
  | { operation: 'playback.control'; action: 'play'; trackId: string; forceTakeover?: boolean }
  | { operation: 'playback.control'; action: 'seek'; positionSeconds: number }
  | { operation: 'queue.replace'; entries: readonly CoreQueueEntry[] }
  | { operation: 'queue.control'; action: 'next' | 'previous' }
  | { operation: 'queue.control'; action: 'jump'; entryId: string }
  | { operation: 'queue.control'; action: 'modes'; repeat: 'off' | 'one' | 'all'; shuffle: boolean }
)
type CoreOperation = CoreCommand
  | { operation: 'core.hello' | 'session.snapshot' }
  | { operation: 'catalog.page'; cursor: string | null; limit: number }
export type CoreRequest = CoreOperation & { protocolVersion: typeof CORE_PROTOCOL_VERSION; engineId: string; libraryId: string }

const errorMessages = {
  untrusted_peer: 'Core connection trust could not be verified.',
  incompatible_protocol: 'Core protocol version is incompatible.',
  unsupported_capability: 'Core does not support the required operation.',
  not_ready: 'Core is not ready for activation.',
  takeover_required: 'RS130 is currently playing from an external controller (HiFi ROSE). Confirm takeover before starting Core playback.',
  invalid_payload: 'Core request or response is invalid or exceeds its limit.',
  identity_mismatch: 'Core or library identity does not match this session.',
  unauthorized: 'Core authorization is required.',
  stale_revision: 'The session changed. Review the fresh snapshot before retrying.',
  unavailable: 'Core connection is unavailable. Playback may still be continuing.',
  deferred_until_idle: 'Engine storage is paused during active playback and the 30-second cooldown.',
  unauthorized_path: 'Requested path is outside the Engine authorized browse roots.',
  not_found: 'Requested Engine resource was not found.',
  read_only_root: 'Engine media root is mounted read-only; tag writes are disabled.',
  external_file_changed: 'Target audio file changed on disk since the dry-run inspection.',
  duplicate_approval: 'This Curate approval command was already submitted.',
  root_leased: 'Target root is currently leased by another writer.',
} as const
export type CoreErrorCode = keyof typeof errorMessages

export class CoreServiceError extends Error {
  readonly code: CoreErrorCode
  readonly snapshot?: CoreSnapshot

  constructor(code: CoreErrorCode, snapshot?: CoreSnapshot) {
    super(errorMessages[code])
    this.name = 'CoreServiceError'
    this.code = code
    this.snapshot = snapshot
  }
}

function requireValue(condition: unknown, code: CoreErrorCode = 'invalid_payload'): asserts condition {
  if (!condition) throw new CoreServiceError(code)
}

/** Also detaches retained objects from a local owner/fake channel's mutable state. */
function boundedCopy(value: unknown): unknown {
  try {
    const json = JSON.stringify(value)
    requireValue(typeof json === 'string' && new TextEncoder().encode(json).byteLength <= CORE_MAX_MESSAGE_BYTES)
    return JSON.parse(json)
  } catch {
    throw new CoreServiceError('invalid_payload')
  }
}

function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const object = record(value)
  requireValue(required.every(key => Object.hasOwn(object, key)))
  requireValue(Object.keys(object).every(key => required.includes(key) || optional.includes(key)))
  return object
}

function token(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
}

function hasDisallowedControlChars(value: string, allowWhitespaceControls: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 32) {
      if (allowWhitespaceControls && (code === 9 || code === 10 || code === 13)) {
        continue
      }
      return true
    }
  }
  return false
}

function text(value: unknown, max = 1024, allowWhitespaceControls = false): asserts value is string {
  requireValue(typeof value === 'string' && value.length <= max && !hasDisallowedControlChars(value, allowWhitespaceControls))
}

function seconds(value: unknown): asserts value is number {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
}

function revision(value: unknown): asserts value is number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= 0)
}

export function validateEngineContext(context: Readonly<EngineContext>): void {
  token(context.engineId); token(context.libraryId); text(context.label)
  requireValue(context.label.trim().length > 0)
  requireValue(context.kind === 'local' || context.kind === 'core')
  if (context.kind === 'local') requireValue(context.engineId === 'local' && context.libraryId === 'local')
  else requireValue(context.engineId !== 'local' && context.libraryId !== 'local')
}

export function engineScopeKey(context: Readonly<EngineContext>): string {
  validateEngineContext(context)
  return JSON.stringify([context.kind, context.engineId, context.libraryId])
}

function identity(value: Record<string, unknown>, expected: Readonly<EngineContext>): void {
  token(value.engineId); token(value.libraryId)
  requireValue(value.engineId === expected.engineId && value.libraryId === expected.libraryId, 'identity_mismatch')
}

export function parseCoreDescriptor(value: unknown, expected: Readonly<EngineContext>): CoreDescriptor {
  const object = fields(boundedCopy(value), ['protocolVersion', 'engineId', 'libraryId', 'label', 'capabilities', 'ready'])
  requireValue(object.protocolVersion === CORE_PROTOCOL_VERSION, 'incompatible_protocol')
  identity(object, expected)
  text(object.label); requireValue(object.label.trim().length > 0)
  const capabilities = object.capabilities
  requireValue(Array.isArray(capabilities) && capabilities.length <= 32)
  for (const capability of capabilities) {
    requireValue(typeof capability === 'string' && capability.length <= 64 && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(capability))
  }
  requireValue(new Set(capabilities).size === capabilities.length)
  requireValue(CORE_REQUIRED_CAPABILITIES.every(capability => capabilities.includes(capability)), 'unsupported_capability')
  requireValue(typeof object.ready === 'boolean')
  requireValue(object.ready, 'not_ready')
  return object as unknown as CoreDescriptor
}

const FORBIDDEN_WIRE_KEYS = new Set(['filePath', 'sql', 'password', 'token'])

const REQUIRED_TRACK_KEYS = ['id', 'title', 'artist', 'album', 'durationSeconds'] as const
const OPTIONAL_TRACK_KEYS = [
  'releaseId', 'albumArtist', 'isCompilation', 'edition', 'format', 'sampleRate', 'bitDepth',
  'trackNumber', 'discNumber', 'releaseYear', 'composerName', 'genreTags', 'folderName',
  'folderPath', 'fileName', 'language', 'dynamicRange', 'hasCoverArt', 'provenanceStatus',
  'lyrics', 'fingerprintStatus',
] as const

function rejectForbiddenKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    requireValue(!FORBIDDEN_WIRE_KEYS.has(key))
  }
}

function validateBuildInfo(value: unknown): CoreBuildInfo {
  const obj = record(value)
  rejectForbiddenKeys(obj)
  const required = ['tag', 'commitsSinceTag', 'commitSha', 'commitDate', 'commitSummary', 'dirty', 'display']
  requireValue(required.every((k) => Object.hasOwn(obj, k)))
  text(obj.tag, 128)
  requireValue(
    typeof obj.commitsSinceTag === 'number' &&
      Number.isInteger(obj.commitsSinceTag) &&
      obj.commitsSinceTag >= 0 &&
      obj.commitsSinceTag <= 1_000_000,
  )
  text(obj.commitSha, 64)
  text(obj.commitDate, 32)
  text(obj.commitSummary, 160)
  requireValue(typeof obj.dirty === 'boolean')
  text(obj.display, 192)
  return {
    tag: obj.tag,
    commitsSinceTag: obj.commitsSinceTag,
    commitSha: obj.commitSha,
    commitDate: obj.commitDate,
    commitSummary: obj.commitSummary,
    dirty: obj.dirty,
    display: obj.display,
  }
}

export function parseCoreV2Descriptor(value: unknown, expected: Readonly<EngineContext>): CoreDescriptor {
  const object = record(boundedCopy(value))
  rejectForbiddenKeys(object)
  requireValue(
    ['protocolVersion', 'engineId', 'libraryId', 'label', 'capabilities', 'ready'].every((key) =>
      Object.hasOwn(object, key),
    ),
  )
  requireValue(
    object.protocolVersion === CORE_PROTOCOL_VERSION || object.protocolVersion === CORE_PROTOCOL_VERSION_V2,
    'incompatible_protocol',
  )
  identity(object, expected)
  text(object.label); requireValue(object.label.trim().length > 0)
  const capabilities = object.capabilities
  requireValue(Array.isArray(capabilities) && capabilities.length <= 32)
  for (const capability of capabilities) {
    requireValue(typeof capability === 'string' && capability.length <= 64 && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(capability))
  }
  requireValue(new Set(capabilities).size === capabilities.length)
  requireValue(CORE_REQUIRED_CAPABILITIES.every(capability => capabilities.includes(capability)), 'unsupported_capability')
  requireValue(typeof object.ready === 'boolean')
  requireValue(object.ready, 'not_ready')
  if (object.protocolRevision !== undefined && object.protocolRevision !== null) {
    optionalPositiveInt(object.protocolRevision, 10_000)
  }
  const build =
    object.build !== undefined && object.build !== null ? validateBuildInfo(object.build) : undefined
  return {
    protocolVersion: object.protocolVersion as typeof CORE_PROTOCOL_VERSION | typeof CORE_PROTOCOL_VERSION_V2,
    ...(typeof object.protocolRevision === 'number' ? { protocolRevision: object.protocolRevision } : {}),
    ...(build ? { build } : {}),
    engineId: object.engineId as string,
    libraryId: object.libraryId as string,
    label: object.label as string,
    capabilities: [...(capabilities as string[])],
    ready: true,
  }
}

function optionalPositiveInt(value: unknown, max: number): void {
  if (value === undefined) return
  requireValue(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max)
}

function optionalNullableText(value: unknown, max = 1024, allowWhitespaceControls = false): void {
  if (value === undefined || value === null) return
  text(value, max, allowWhitespaceControls)
}

function optionalNullableInt(value: unknown, min: number, max: number): void {
  if (value === undefined || value === null) return
  requireValue(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
}

function validateCatalogTrack(value: unknown, allowUnknownKeys: boolean): CoreCatalogTrack {
  let track: Record<string, unknown>
  if (allowUnknownKeys) {
    track = record(value)
    rejectForbiddenKeys(track)
    requireValue(REQUIRED_TRACK_KEYS.every((key) => Object.hasOwn(track, key)))
  } else {
    track = fields(value, [...REQUIRED_TRACK_KEYS], [...OPTIONAL_TRACK_KEYS])
  }
  const allowTagWhitespace = allowUnknownKeys
  token(track.id)
  text(track.title, 1024, allowTagWhitespace)
  text(track.artist, 1024, allowTagWhitespace)
  text(track.album, 1024, allowTagWhitespace)
  seconds(track.durationSeconds)
  if (track.releaseId !== undefined) token(track.releaseId)
  if (track.albumArtist !== undefined) text(track.albumArtist, 1024, allowTagWhitespace)
  if (track.isCompilation !== undefined) requireValue(typeof track.isCompilation === 'boolean')
  if (track.edition !== undefined) text(track.edition, 1024, allowTagWhitespace)
  if (track.format !== undefined) text(track.format, 32)
  optionalPositiveInt(track.sampleRate, 90_316_800)
  optionalPositiveInt(track.bitDepth, 64)
  optionalPositiveInt(track.trackNumber, 9999)
  optionalPositiveInt(track.discNumber, 999)
  optionalPositiveInt(track.releaseYear, 9999)
  optionalNullableText(track.composerName, 1024, allowTagWhitespace)
  optionalNullableText(track.folderName, 1024, allowTagWhitespace)
  optionalNullableText(track.folderPath, 4096, allowTagWhitespace)
  optionalNullableText(track.fileName, 512, allowTagWhitespace)
  optionalNullableText(track.language, 64, allowTagWhitespace)
  optionalNullableInt(track.dynamicRange, 0, 100)
  if (track.hasCoverArt !== undefined) requireValue(typeof track.hasCoverArt === 'boolean')
  optionalNullableText(track.provenanceStatus, 64)
  optionalNullableText(track.lyrics, 262_144, true)
  optionalNullableText(track.fingerprintStatus, 64)
  if (track.genreTags !== undefined) {
    requireValue(Array.isArray(track.genreTags) && track.genreTags.length <= 32)
    for (const tag of track.genreTags) text(tag, 128, allowTagWhitespace)
  }

  const sanitized: Record<string, unknown> = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSeconds: track.durationSeconds,
  }
  for (const key of OPTIONAL_TRACK_KEYS) {
    if (Object.hasOwn(track, key) && track[key] !== undefined) {
      sanitized[key] = track[key]
    }
  }
  return sanitized as unknown as CoreCatalogTrack
}

function catalogPage(value: unknown, allowUnknownKeys = false): CoreCatalogPage {
  let page: Record<string, unknown>
  if (allowUnknownKeys) {
    page = record(value)
    rejectForbiddenKeys(page)
    requireValue(['revision', 'tracks', 'nextCursor'].every((key) => Object.hasOwn(page, key)))
  } else {
    page = fields(value, ['revision', 'tracks', 'nextCursor'])
  }
  revision(page.revision)
  requireValue(Array.isArray(page.tracks) && page.tracks.length <= CORE_MAX_PAGE_TRACKS)
  const ids = new Set<string>()
  const sanitizedTracks: CoreCatalogTrack[] = []
  for (const item of page.tracks) {
    const validated = validateCatalogTrack(item, allowUnknownKeys)
    requireValue(!ids.has(validated.id)); ids.add(validated.id)
    sanitizedTracks.push(validated)
  }
  if (page.nextCursor !== null) token(page.nextCursor)
  return {
    revision: page.revision as number,
    tracks: sanitizedTracks,
    nextCursor: page.nextCursor as string | null,
  }
}

export function parseCoreCatalogPage(value: unknown): CoreCatalogPage {
  return catalogPage(boundedCopy(value), false)
}

export function parseCoreV2CatalogPage(value: unknown): CoreCatalogPage {
  return catalogPage(boundedCopy(value), true)
}

function queueEntries(value: unknown): CoreQueueEntry[] {
  requireValue(Array.isArray(value) && value.length <= CORE_MAX_QUEUE_ENTRIES)
  const ids = new Set<string>()
  for (const item of value) {
    const entry = fields(item, ['entryId', 'trackId'])
    token(entry.entryId); token(entry.trackId)
    requireValue(!ids.has(entry.entryId)); ids.add(entry.entryId)
  }
  return value as CoreQueueEntry[]
}

export function parseCoreSnapshot(value: unknown, expected: Readonly<EngineContext>): CoreSnapshot {
  const object = fields(boundedCopy(value), ['engineId', 'libraryId', 'revision', 'catalog', 'queue', 'playback', 'output'])
  identity(object, expected); revision(object.revision); catalogPage(object.catalog)
  const queue = fields(object.queue, ['entries', 'currentEntryId', 'repeat', 'shuffle'])
  const entries = queueEntries(queue.entries)
  if (queue.currentEntryId !== null) {
    token(queue.currentEntryId)
    requireValue(entries.some(entry => entry.entryId === queue.currentEntryId))
  }
  requireValue(['off', 'one', 'all'].includes(queue.repeat as string) && typeof queue.shuffle === 'boolean')
  const playback = fields(
    object.playback,
    ['activity', 'positionSeconds'],
    ['owner', 'takeoverRequired', 'externalPlayback'],
  )
  requireValue(['idle', 'playing', 'paused', 'loading'].includes(playback.activity as string)); seconds(playback.positionSeconds)
  if (playback.owner !== undefined) requireValue(['none', 'core', 'external'].includes(playback.owner as string))
  if (playback.takeoverRequired !== undefined) requireValue(typeof playback.takeoverRequired === 'boolean')
  if (playback.externalPlayback !== undefined) {
    const ext = fields(playback.externalPlayback, ['active', 'transportState'], ['currentUri', 'positionSeconds'])
    requireValue(typeof ext.active === 'boolean')
    text(ext.transportState, 64)
    if (ext.currentUri !== undefined) text(ext.currentUri, 1024)
    if (ext.positionSeconds !== undefined) seconds(ext.positionSeconds)
  }
  if (object.output !== null) {
    const output = fields(object.output, ['id', 'label', 'transport'])
    token(output.id); text(output.label)
    requireValue(['upnp', 'wasapi', 'system_default'].includes(output.transport as string))
  }
  return object as unknown as CoreSnapshot
}

/** Use on both sides of an eventual server boundary, before resolving IDs to paths. */
export function parseCoreRequest(value: unknown, expected: Readonly<EngineContext>): CoreRequest {
  const object = record(boundedCopy(value))
  requireValue(object.protocolVersion === CORE_PROTOCOL_VERSION, 'incompatible_protocol')
  identity(object, expected)
  const base = ['protocolVersion', 'engineId', 'libraryId', 'operation']
  switch (object.operation) {
    case 'core.hello':
    case 'session.snapshot': fields(object, base); break
    case 'catalog.page':
      fields(object, [...base, 'cursor', 'limit'])
      if (object.cursor !== null) token(object.cursor)
      requireValue(Number.isInteger(object.limit) && (object.limit as number) >= 1 && (object.limit as number) <= CORE_MAX_PAGE_TRACKS)
      break
    case 'playback.control': {
      const extra =
        object.action === 'play'
          ? (Object.hasOwn(object, 'forceTakeover') ? ['trackId', 'forceTakeover'] : ['trackId'])
          : object.action === 'seek'
            ? ['positionSeconds']
            : []
      fields(object, [...base, 'commandId', 'expectedRevision', 'action', ...extra])
      token(object.commandId); revision(object.expectedRevision)
      requireValue(['play', 'pause', 'resume', 'stop', 'seek'].includes(object.action as string))
      if (object.action === 'play') {
        token(object.trackId)
        if (Object.hasOwn(object, 'forceTakeover')) requireValue(typeof object.forceTakeover === 'boolean')
      }
      if (object.action === 'seek') seconds(object.positionSeconds)
      break
    }
    case 'queue.replace':
      fields(object, [...base, 'commandId', 'expectedRevision', 'entries'])
      token(object.commandId); revision(object.expectedRevision); queueEntries(object.entries)
      break
    case 'queue.control': {
      const extra = object.action === 'jump' ? ['entryId'] : object.action === 'modes' ? ['repeat', 'shuffle'] : []
      fields(object, [...base, 'commandId', 'expectedRevision', 'action', ...extra])
      token(object.commandId); revision(object.expectedRevision)
      requireValue(['next', 'previous', 'jump', 'modes'].includes(object.action as string))
      if (object.action === 'jump') token(object.entryId)
      if (object.action === 'modes') {
        requireValue(['off', 'one', 'all'].includes(object.repeat as string) && typeof object.shuffle === 'boolean')
      }
      break
    }
    default: throw new CoreServiceError('invalid_payload')
  }
  return object as CoreRequest
}

export interface EngineSmbSupportStatus {
  supported: boolean
  reason?: string | null
  versions: string[]
}

export interface EngineNetworkShareRecord {
  id: string
  server: string
  share: string
  mountPath: string
  displayName: string
  username?: string | null
  smbVersion?: string | null
  readOnly: boolean
  mounted: boolean
}

export interface AddEngineSmbShareInput {
  server: string
  share: string
  username?: string
  password?: string
  smbVersion?: string
  readOnly?: boolean
  displayName?: string
}

export interface EngineMetadataOverlayRecord {
  entityType: 'release' | 'track' | string
  entityId: string
  fieldName: string
  valueText: string | null
  origin: 'user' | 'auto' | string
  provider: string | null
  confidence: number | null
  distance: number | null
  locked: boolean
  updatedAt: string
}

export interface EngineMetadataUserActionRecord {
  id: number
  entityType: 'release' | 'track' | string
  entityId: string
  fieldName: string
  action: string
  previousValue: string | null
  newValue: string | null
  actor: string
  createdAt: string
}

export interface RootEnrichmentProgress {
  folderId: string
  displayName: string
  path: string
  totalAlbums: number
  coveredAlbums: number
  coveragePercent: number
  autoAppliedAlbums: number
  needsReviewAlbums: number
  noMatchAlbums: number
  userLockedAlbums: number
  pendingAlbums: number
  failedAlbums: number
  artworkCoveredAlbums: number
  artworkCoveragePercent: number
  totalArtists?: number
  artistArtworkCovered?: number
  artistArtworkCoveragePercent?: number
  artistArtworkPending?: number
}

export interface ProviderGateSnapshot {
  provider: string
  circuit: string
  consecutiveFailures: number
  retryAfterSecs: number | null
}

export interface EngineEnrichmentStatus {
  state: 'active' | 'cooldown' | 'paused_playback' | 'user_paused' | 'disabled' | 'complete' | string
  enabled: boolean
  userPaused: boolean
  cooldownRemainingSecs: number | null
  currentReleaseId: string | null
  currentAlbumTitle: string | null
  totalAlbums: number
  coveredAlbums: number
  coveragePercent: number
  autoAppliedAlbums: number
  needsReviewAlbums: number
  noMatchAlbums: number
  userLockedAlbums: number
  pendingAlbums: number
  failedAlbums: number
  artworkCoveredAlbums: number
  artworkCoveragePercent: number
  artworkPendingItems: number
  totalArtists?: number
  artistArtworkCovered?: number
  artistArtworkCoveragePercent?: number
  artistArtworkPending?: number
  providerGates: ProviderGateSnapshot[]
  roots: RootEnrichmentProgress[]
}

export interface EngineArtistPortraitSummary {
  id: string
  name: string
  aliasNorm: string
  portraitStatus: string
  hasArtwork: boolean
  artworkUrl?: string | null
}

export interface EngineEnrichmentAlbumSummary {
  releaseId: string
  title: string
  artist: string
  status: 'pending' | 'auto_applied' | 'needs_review' | 'no_match' | 'user_locked' | 'failed' | string
  provider: string | null
  externalReleaseId: string | null
  distance: number | null
  runnerUpDistance: number | null
  vetoes: unknown[]
  hasUserOverlay: boolean
  hasAutoOverlay: boolean
  artworkStatus: string | null
  artworkSource: string | null
  artworkWidth: number | null
  artworkHeight: number | null
  updatedAt: string
}

export interface EngineEnrichmentRawTrackSummary {
  trackId: string
  title: string
  artist: string
  albumArtist: string | null
  trackNumber: number | null
  discNumber: number | null
  durationSecs: number
  releaseYear: number | null
}

export interface EngineArtworkTraceStep {
  candidate: string
  outcome: string
  detail: string
}

export interface EngineEnrichmentAlbumDetail {
  releaseId: string
  rawTitle: string
  rawArtist: string
  rawAlbumArtist?: string | null
  rawYear: number | null
  rawComposer: string | null
  rawGenre: string | null
  status: 'pending' | 'auto_applied' | 'needs_review' | 'no_match' | 'user_locked' | 'failed' | string
  provider: string | null
  externalReleaseId: string | null
  distance: number | null
  runnerUpDistance: number | null
  vetoes: unknown[]
  proposal: Record<string, unknown> | null
  overlays: EngineMetadataOverlayRecord[]
  tracks: EngineEnrichmentRawTrackSummary[]
  artworkStatus: string | null
  artworkSource: string | null
  artworkWidth: number | null
  artworkHeight: number | null
  artworkTrace: EngineArtworkTraceStep[]
  pendingArtworkUrl?: string | null
  pendingArtworkAttempts?: number | null
  pendingArtworkError?: string | null
  userActions: EngineMetadataUserActionRecord[]
}

export interface UserTrackOverlayEdit {
  trackId: string
  title?: string
  artist?: string
  year?: string
}

export type EnrichmentControlAction =
  | 'pause'
  | 'resume'
  | 'set_enabled'
  | 'rerun_root'
  | 'rerun_album'
  | 'rerun_missing'

export type EnrichmentAlbumAction =
  | 'save_overlay'
  | 'accept_proposal'
  | 'revert_to_file'
  | 'lock_file_tags'
  | 'unlock_auto'

/** Ignore server prose: it can contain owner-only paths, SQL or credentials. */
export function unwrapCoreReply(value: unknown, expected: Readonly<EngineContext>): unknown {
  const object = record(boundedCopy(value))
  if (object.ok === true) return fields(object, ['ok', 'data']).data
  requireValue(object.ok === false)
  fields(object, ['ok', 'error'])
  const error = fields(object.error, ['code'], ['message', 'snapshot'])
  requireValue(typeof error.code === 'string' && Object.hasOwn(errorMessages, error.code))
  if (error.message !== undefined) text(error.message)
  if (error.code === 'stale_revision') throw new CoreServiceError(error.code, parseCoreSnapshot(error.snapshot, expected))
  requireValue(error.snapshot === undefined)
  throw new CoreServiceError(error.code as CoreErrorCode)
}
