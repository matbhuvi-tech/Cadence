import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEngineOutputsClient } from '../services/engineOutputs'

const profile = { engineId: 'engine', libraryId: 'library', label: 'Engine', baseUrl: 'https://engine', musicRoots: [] }
test('lists outputs and selects the exact advertised ID', async () => {
  const requests: Record<string, unknown>[] = []
  const client = createEngineOutputsClient(profile, async (_profile, request) => {
    requests.push(request)
    return request.operation === 'outputs.list'
      ? { ok: true, data: { outputs: [{ id: 'upnp:uuid:rose', displayName: 'ROSE-67', transport: 'upnp', isAvailable: true }] } }
      : { ok: true, data: { output: { id: 'upnp_uuid_rose', label: 'ROSE-67', transport: 'upnp' } } }
  })
  const outputs = await client.list()
  assert.equal(outputs[0].id, 'upnp:uuid:rose')
  await client.select(outputs[0].id)
  assert.deepEqual(requests.map(r => r.operation), ['outputs.list', 'output.select'])
  assert.equal(requests[1].outputId, 'upnp:uuid:rose')
})
test('rejects malformed engine responses', async () => {
  const client = createEngineOutputsClient(profile, async () => ({ ok: true, data: { outputs: [{ id: 7 }] } }))
  await assert.rejects(client.list())
})

test('selection reports when the engine snapshot does not confirm the chosen output', async () => {
  const client = createEngineOutputsClient(profile, async () => ({ ok: true, data: { output: { id: 'upnp_uuid_rose', label: 'ROSE-67', transport: 'upnp' } } }))
  await assert.rejects(client.selectAndConfirm('upnp:uuid:rose', async () => ({ id: 'system_default' })), /did not confirm/i)
})
test('selection succeeds only when the snapshot confirms the selected output', async () => {
  const client = createEngineOutputsClient(profile, async () => ({ ok: true, data: { output: { id: 'upnp_uuid_rose', label: 'ROSE-67', transport: 'upnp' } } }))
  await client.selectAndConfirm('upnp:uuid:rose', async () => ({ id: 'upnp_uuid_rose' }))
})

test('scan requests a fresh engine output inventory', async () => {
  const requests: Record<string, unknown>[] = []
  const client = createEngineOutputsClient(profile, async (_profile, request) => {
    requests.push(request)
    return { ok: true, data: { outputs: [{ id: 'upnp:uuid:rose', displayName: 'ROSE-67', transport: 'upnp', isAvailable: true }] } }
  })
  assert.equal((await client.scan())[0].displayName, 'ROSE-67')
  assert.equal(requests[0].operation, 'outputs.scan')
})

test('scan explains when an older engine does not support the operation', async () => {
  const client = createEngineOutputsClient(profile, async () => ({ ok: false, error: { code: 'invalid_payload' } }))
  await assert.rejects(client.scan(), /update.*engine/i)
})
