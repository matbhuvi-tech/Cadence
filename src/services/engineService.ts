import type { EngineContext } from '../core/engineSession'
import {
  CORE_PROTOCOL_VERSION, CoreServiceError, parseCoreCatalogPage, parseCoreDescriptor,
  parseCoreRequest, parseCoreSnapshot, unwrapCoreReply, validateEngineContext,
  type CoreCatalogPage, type CoreCommand, type CoreDescriptor, type CoreRequest, type CoreSnapshot,
} from '../core/coreProtocol'

/** A typed in-process owner port. It must preserve the owner's playback/idle guards.
 * Binding this to Tauri/catalog/queue state is deferred to the authoritative backend
 * and controller phases; no mixed-revision snapshot is synthesized from legacy IPC.
 */
export interface LocalEngineOwner {
  request(request: CoreRequest): Promise<unknown>
}

/** Provided by an authenticated platform transport, never by discovery/hello JSON.
 * verifyPeer must verify certificate/trust AND controller authorization. request must
 * use that same peer-bound channel, reject redirects/peer changes, enforce the byte
 * limit before buffering, and bound connection/request lifetimes. Native pinning and
 * browser trust implementations are separate later integrations. There is no default
 * fetch transport that could silently bypass these obligations.
 */
export interface AuthenticatedCoreChannel {
  verifyPeer(): Promise<{ authenticated: boolean; engineId: string; libraryId: string }>
  request(request: CoreRequest): Promise<unknown>
}

export interface PreparedEngine {
  context: EngineContext
  descriptor: CoreDescriptor
  snapshot: CoreSnapshot
}

export interface EngineService {
  readonly context: Readonly<EngineContext>
  prepare(): Promise<PreparedEngine>
  getSnapshot(): Promise<CoreSnapshot>
  catalogPage(cursor: string | null, limit: number): Promise<CoreCatalogPage>
  execute(command: CoreCommand): Promise<CoreSnapshot>
}

const LOCAL_CONTEXT: EngineContext = { kind: 'local', engineId: 'local', libraryId: 'local', label: 'This PC' }

export function createLocalEngineService(owner: LocalEngineOwner): EngineService {
  return createService(LOCAL_CONTEXT, owner)
}

export function createRemoteEngineService(context: Readonly<EngineContext>, channel: AuthenticatedCoreChannel): EngineService {
  validateEngineContext(context)
  if (context.kind !== 'core') throw new CoreServiceError('invalid_payload')
  return createService(context, channel, channel.verifyPeer.bind(channel))
}

function createService(
  selected: Readonly<EngineContext>,
  owner: LocalEngineOwner,
  verifyPeer?: AuthenticatedCoreChannel['verifyPeer'],
): EngineService {
  const context = Object.freeze({ ...selected })
  let descriptor: CoreDescriptor | null = null

  function request(operation: object): CoreRequest {
    return parseCoreRequest({ ...operation, protocolVersion: CORE_PROTOCOL_VERSION, engineId: context.engineId, libraryId: context.libraryId }, context)
  }

  async function send(wire: CoreRequest): Promise<unknown> {
    return unwrapCoreReply(await owner.request(wire), context)
  }

  async function authorize(renegotiate = false): Promise<CoreDescriptor> {
    // Recheck the channel for every public operation, including reconnect refresh.
    if (verifyPeer) {
      const peer = await verifyPeer()
      if (peer.authenticated !== true) throw new CoreServiceError('untrusted_peer')
      if (peer.engineId !== context.engineId || peer.libraryId !== context.libraryId) throw new CoreServiceError('identity_mismatch')
    }
    if (!descriptor || renegotiate) descriptor = parseCoreDescriptor(await send(request({ operation: 'core.hello' })), context)
    return descriptor
  }

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() }
    catch (error) {
      descriptor = null
      if (error instanceof CoreServiceError) throw error
      throw new CoreServiceError('unavailable')
    }
  }

  return {
    context,
    prepare: () => guarded(async () => {
      const hello = await authorize(true)
      const snapshot = parseCoreSnapshot(await send(request({ operation: 'session.snapshot' })), context)
      return { context: { ...context }, descriptor: structuredClone(hello), snapshot }
    }),
    getSnapshot: () => guarded(async () => {
      await authorize()
      return parseCoreSnapshot(await send(request({ operation: 'session.snapshot' })), context)
    }),
    catalogPage: (cursor, limit) => guarded(async () => {
      const wire = request({ operation: 'catalog.page', cursor, limit })
      await authorize()
      const page = parseCoreCatalogPage(await send(wire))
      if (page.tracks.length > limit) throw new CoreServiceError('invalid_payload')
      return page
    }),
    execute: command => guarded(async () => {
      // Validate before trust/IPC/network work and detach arguments across awaits.
      const wire = request(command)
      if (wire.operation !== 'playback.control' && wire.operation !== 'queue.replace') throw new CoreServiceError('invalid_payload')
      await authorize()
      const snapshot = parseCoreSnapshot(await send(wire), context)
      if (snapshot.revision < wire.expectedRevision) throw new CoreServiceError('invalid_payload')
      return snapshot
    }),
  }
}
