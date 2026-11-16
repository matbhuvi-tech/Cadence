import type { EngineActivity, EngineContext } from './engineSession'

/** Control-plane v1 only. Media, SQL, filesystem paths and arbitrary IPC are excluded. */
export const CORE_PROTOCOL_VERSION = 1 as const
export const CORE_MAX_MESSAGE_BYTES = 1_048_576
export const CORE_MAX_QUEUE_ENTRIES = 4096
export const CORE_MAX_PAGE_TRACKS = 200
export const CORE_REQUIRED_CAPABILITIES = ['catalog.read', 'session.read', 'playback.control', 'queue.write'] as const

export interface CoreDescriptor {
  protocolVersion: typeof CORE_PROTOCOL_VERSION
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

function text(value: unknown, max = 1024): asserts value is string {
  requireValue(typeof value === 'string' && value.length <= max && !Array.from(value).some(char => char.charCodeAt(0) < 32))
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

function optionalPositiveInt(value: unknown, max: number): void {
  if (value === undefined) return
  requireValue(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max)
}

function catalogPage(value: unknown): CoreCatalogPage {
  const page = fields(value, ['revision', 'tracks', 'nextCursor'])
  revision(page.revision)
  requireValue(Array.isArray(page.tracks) && page.tracks.length <= CORE_MAX_PAGE_TRACKS)
  const ids = new Set<string>()
  for (const value of page.tracks) {
    const track = fields(
      value,
      ['id', 'title', 'artist', 'album', 'durationSeconds'],
      ['releaseId', 'albumArtist', 'isCompilation', 'edition', 'format', 'sampleRate', 'bitDepth', 'trackNumber', 'discNumber', 'releaseYear'],
    )
    token(track.id); text(track.title); text(track.artist); text(track.album); seconds(track.durationSeconds)
    if (track.releaseId !== undefined) token(track.releaseId)
    if (track.albumArtist !== undefined) text(track.albumArtist)
    if (track.isCompilation !== undefined) requireValue(typeof track.isCompilation === 'boolean')
    if (track.edition !== undefined) text(track.edition)
    if (track.format !== undefined) text(track.format, 32)
    optionalPositiveInt(track.sampleRate, 90_316_800)
    optionalPositiveInt(track.bitDepth, 64)
    optionalPositiveInt(track.trackNumber, 9999)
    optionalPositiveInt(track.discNumber, 999)
    optionalPositiveInt(track.releaseYear, 9999)
    requireValue(!ids.has(track.id)); ids.add(track.id)
  }
  if (page.nextCursor !== null) token(page.nextCursor)
  return page as unknown as CoreCatalogPage
}

export function parseCoreCatalogPage(value: unknown): CoreCatalogPage {
  return catalogPage(boundedCopy(value))
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
