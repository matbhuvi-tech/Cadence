import {
  beginEngineSwitch, completeEngineSwitch, createEngineSession, setEngineConnection,
  type EngineActivity, type EngineContext, type EngineSession,
} from '../core/engineSession'
import { CoreServiceError, engineScopeKey, parseCoreDescriptor, parseCoreSnapshot, type CoreSnapshot } from '../core/coreProtocol'
import type { EngineService } from './engineService'

export interface EngineServiceView { session: EngineSession; snapshot: CoreSnapshot | null }
type SelectionOutcome = 'activated' | 'failed' | 'stale' | 'requires_stop' | 'unchanged'
type RefreshOutcome = 'updated' | 'failed' | 'stale'

/** Unconnected staging coordinator. A future UI must render this single committed
 * view, rather than hydrate independent catalog/queue/output stores as they arrive.
 * The caller supplies owner-observed activity; 'idle' after a stop means the stop
 * has been acknowledged. This coordinator never sends Stop, Play or queue mutations.
 */
export function createEngineServiceController(local: EngineService) {
  if (engineScopeKey(local.context) !== engineScopeKey(createEngineSession().active)) throw new CoreServiceError('invalid_payload')
  let activeService = local
  let view: EngineServiceView = { session: createEngineSession(), snapshot: null }
  let refreshGeneration = 0

  function failure(error: unknown): string {
    return error instanceof CoreServiceError ? error.message : new CoreServiceError('unavailable').message
  }

  return {
    getView: (): EngineServiceView => structuredClone(view),

    async select(
      target: EngineService,
      sourceActivity: EngineActivity,
      disposition: 'stop_before_switch' | 'leave_core_playing' = 'stop_before_switch',
    ): Promise<SelectionOutcome> {
      engineScopeKey(target.context)
      const selection = beginEngineSwitch(view.session, target.context, sourceActivity, disposition)
      view = { ...view, session: selection.state }
      if (selection.outcome !== 'pending') return selection.outcome
      const epoch = selection.state.epoch
      refreshGeneration++
      try {
        const prepared = await target.prepare()
        if (view.session.epoch !== epoch || !view.session.pending) return 'stale'
        if (engineScopeKey(prepared.context) !== engineScopeKey(target.context)) throw new CoreServiceError('identity_mismatch')
        parseCoreDescriptor(prepared.descriptor, target.context)
        const snapshot = parseCoreSnapshot(prepared.snapshot, target.context)
        view = { session: completeEngineSwitch(view.session, epoch, { ok: true }), snapshot }
        activeService = target
        return 'activated'
      } catch (error) {
        if (view.session.epoch !== epoch || !view.session.pending) return 'stale'
        view = { ...view, session: completeEngineSwitch(view.session, epoch, { ok: false, error: failure(error) }) }
        return 'failed'
      }
    },

    async refresh(): Promise<RefreshOutcome> {
      const generation = ++refreshGeneration
      const epoch = view.session.activeEpoch
      const service = activeService
      try {
        const response = await service.getSnapshot()
        if (generation !== refreshGeneration || epoch !== view.session.activeEpoch) return 'stale'
        const snapshot = parseCoreSnapshot(response, service.context)
        if (view.snapshot && snapshot.revision < view.snapshot.revision) return 'stale'
        view = { snapshot, session: { ...view.session, connected: true, error: null } }
        return 'updated'
      } catch (error) {
        if (generation !== refreshGeneration || epoch !== view.session.activeEpoch) return 'stale'
        view = { ...view, session: { ...view.session, connected: false, error: failure(error) } }
        return 'failed'
      }
    },

    setConnection(epoch: number, context: EngineContext, connected: boolean): void {
      // A socket-open event alone cannot restore a disconnected authoritative view.
      // The consumer must call refresh(), which also rechecks peer trust.
      if (connected) return
      const session = setEngineConnection(view.session, epoch, context, false)
      if (session !== view.session) {
        refreshGeneration++
        view = { ...view, session }
      }
    },
  }
}
