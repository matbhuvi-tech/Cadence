import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  beginEngineSwitch,
  completeEngineSwitch,
  createEngineSession,
  setEngineConnection,
  type EngineContext,
} from '../core/engineSession'

const core: EngineContext = {
  kind: 'core', engineId: 'core-room', libraryId: 'library-room', label: 'Music Room Core',
}
const otherCore: EngineContext = {
  kind: 'core', engineId: 'core-study', libraryId: 'library-study', label: 'Study Core',
}

test('a new installation selects This PC without any remote configuration', () => {
  const state = createEngineSession()
  assert.deepEqual(state.active, {
    kind: 'local', engineId: 'local', libraryId: 'local', label: 'This PC',
  })
  assert.equal(state.connected, true)
  assert.equal(state.pending, null)
})

test('preparing a switch preserves the active library until a snapshot is ready', () => {
  const initial = createEngineSession()
  const result = beginEngineSwitch(initial, core, 'idle')
  assert.equal(result.outcome, 'pending')
  assert.deepEqual(result.state.active, initial.active)
  assert.deepEqual(result.state.pending?.target, core)
  assert.equal(initial.pending, null)
})

for (const activity of ['playing', 'paused', 'loading'] as const) {
  test(`${activity} requires stopping the source before switching`, () => {
    const initial = createEngineSession()
    const result = beginEngineSwitch(initial, core, activity)
    assert.equal(result.outcome, 'requires_stop')
    assert.equal(result.state, initial)
  })
}

test('successful activation changes engine and library together', () => {
  const { state } = beginEngineSwitch(createEngineSession(), core, 'idle')
  const activated = completeEngineSwitch(state, state.epoch, { ok: true })
  assert.deepEqual(activated.active, core)
  assert.equal(activated.pending, null)
  assert.equal(activated.connected, true)
})

test('failed activation retains the previous engine and catalog', () => {
  const initial = createEngineSession()
  const { state } = beginEngineSwitch(initial, core, 'idle')
  const failed = completeEngineSwitch(state, state.epoch, { ok: false, error: 'Core unavailable' })
  assert.deepEqual(failed.active, initial.active)
  assert.equal(failed.error, 'Core unavailable')
  assert.equal(failed.pending, null)
})

test('late success and failure from an older selection cannot overwrite a newer selection', () => {
  const first = beginEngineSwitch(createEngineSession(), core, 'idle').state
  const second = beginEngineSwitch(first, otherCore, 'idle').state
  assert.equal(completeEngineSwitch(second, first.epoch, { ok: true }), second)
  assert.equal(completeEngineSwitch(second, first.epoch, { ok: false, error: 'Old failure' }), second)
})

test('selecting the current engine cancels a pending switch and invalidates its response', () => {
  const initial = createEngineSession()
  const pending = beginEngineSwitch(initial, core, 'idle').state
  const cancelled = beginEngineSwitch(pending, initial.active, 'idle')
  assert.equal(cancelled.outcome, 'unchanged')
  assert.equal(cancelled.state.pending, null)
  assert.equal(completeEngineSwitch(cancelled.state, pending.epoch, { ok: true }), cancelled.state)
})

test('duplicate completion is harmless', () => {
  const pending = beginEngineSwitch(createEngineSession(), core, 'idle').state
  const active = completeEngineSwitch(pending, pending.epoch, { ok: true })
  assert.equal(completeEngineSwitch(active, pending.epoch, { ok: true }), active)
})

test('Core disconnection preserves its selection and never selects local playback', () => {
  const pending = beginEngineSwitch(createEngineSession(), core, 'idle').state
  const active = completeEngineSwitch(pending, pending.epoch, { ok: true })
  const disconnected = setEngineConnection(active, active.epoch, core, false)
  assert.deepEqual(disconnected.active, core)
  assert.equal(disconnected.connected, false)
  assert.equal(setEngineConnection(disconnected, active.epoch, core, true).connected, true)
})

test('stale connection events and events for another library are ignored', () => {
  const state = createEngineSession()
  assert.equal(setEngineConnection(state, state.epoch - 1, state.active, false), state)
  assert.equal(setEngineConnection(state, state.epoch, core, false), state)
  assert.equal(setEngineConnection(state, state.epoch, { ...state.active, libraryId: 'other' }, false), state)
})

test('switching back to This PC is explicit and preserves disconnected state until success', () => {
  const local = createEngineSession()
  const pending = beginEngineSwitch(local, core, 'idle').state
  const active = completeEngineSwitch(pending, pending.epoch, { ok: true })
  const disconnected = setEngineConnection(active, active.epoch, core, false)
  const returning = beginEngineSwitch(disconnected, local.active, 'idle').state
  assert.equal(returning.connected, false)
  const restored = completeEngineSwitch(returning, returning.epoch, { ok: true })
  assert.deepEqual(restored.active, local.active)
  assert.equal(restored.connected, true)
})

test('the same engine with a different library requires a fresh activation', () => {
  const state = createEngineSession()
  assert.equal(beginEngineSwitch(state, { ...state.active, libraryId: 'another' }, 'idle').outcome, 'pending')
})

test('a no-op selection retains the existing session', () => {
  const state = createEngineSession()
  const result = beginEngineSwitch(state, state.active, 'playing')
  assert.equal(result.outcome, 'unchanged')
  assert.equal(result.state, state)
})
