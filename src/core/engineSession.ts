/**
 * Optional-Core selection policy. Pure and deliberately not wired to application startup.
 * Pairing/discovery happen outside this model and never activate an engine.
 * An adapter must validate trust, API compatibility, capabilities and a complete
 * catalog/queue/output snapshot before completing activation. Completion never plays.
 */
export interface EngineContext {
  kind: 'local' | 'core'
  engineId: string
  libraryId: string
  label: string
}

export type EngineActivity = 'idle' | 'playing' | 'paused' | 'loading'

export interface EngineSession {
  active: EngineContext
  connected: boolean
  epoch: number
  activeEpoch: number
  pending: { target: EngineContext } | null
  error: string | null
}

export interface EngineSwitchResult {
  state: EngineSession
  outcome: 'unchanged' | 'requires_stop' | 'pending'
}

export function createEngineSession(): EngineSession {
  return {
    active: { kind: 'local', engineId: 'local', libraryId: 'local', label: 'This PC' },
    connected: true,
    epoch: 0,
    activeEpoch: 0,
    pending: null,
    error: null,
  }
}

function sameContext(left: EngineContext, right: EngineContext): boolean {
  return left.kind === right.kind && left.engineId === right.engineId && left.libraryId === right.libraryId
}

/** Caller handles any stop/leave-playing choice; this function performs no transport work. */
export function beginEngineSwitch(
  state: EngineSession,
  target: EngineContext,
  sourceActivity: EngineActivity,
  disposition: 'stop_before_switch' | 'leave_core_playing' = 'stop_before_switch',
): EngineSwitchResult {
  if (sameContext(state.active, target)) {
    return {
      outcome: 'unchanged',
      state: state.pending
        ? { ...state, pending: null, epoch: state.epoch + 1, error: null }
        : state,
    }
  }
  const canLeavePlaying = state.active.kind === 'core' && disposition === 'leave_core_playing'
  if (sourceActivity !== 'idle' && !canLeavePlaying) return { state, outcome: 'requires_stop' }
  return {
    outcome: 'pending',
    state: { ...state, epoch: state.epoch + 1, pending: { target: { ...target } }, error: null },
  }
}

export function completeEngineSwitch(
  state: EngineSession,
  epoch: number,
  result: { ok: true } | { ok: false; error: string },
): EngineSession {
  if (epoch !== state.epoch || !state.pending) return state
  if (result.ok === false) return { ...state, pending: null, error: result.error }
  return { ...state, active: state.pending.target, activeEpoch: epoch, pending: null, connected: true, error: null }
}

/** Epoch + library identity prevent an old socket from changing the selected session. */
export function setEngineConnection(
  state: EngineSession,
  epoch: number,
  context: EngineContext,
  connected: boolean,
): EngineSession {
  if (epoch !== state.activeEpoch || !sameContext(state.active, context)) return state
  return { ...state, connected }
}
