import { expect, it } from 'vitest'
import { createPwaCoreClient, type CorePostFn } from './coreRemoteClient'

const profile = {
  id: 'core', baseUrl: 'http://localhost:4040', port: 4040, token: '',
  label: 'Core', engineKind: 'core' as const, engineId: 'engine', libraryId: 'library',
}

function clientWithOutputResponse(body: string) {
  const post: CorePostFn = async (_url, request) => ({
    ok: true, status: 200, statusText: 'OK', errorKind: 'ok',
    body: JSON.parse(request).operation === 'outputs.list' ? body : JSON.stringify({
      ok: true,
      data: {
        protocolVersion: 1, engineId: 'engine', libraryId: 'library', label: 'Core',
        capabilities: ['catalog.read', 'session.read', 'playback.control', 'queue.write'],
        ready: true,
      },
    }),
  })
  return createPwaCoreClient(profile, post)
}

it('recognizes the Core rejection for engines without the output-list operation', async () => {
  const client = clientWithOutputResponse('{"ok":false,"error":{"code":"invalid_payload"}}')
  await expect(client.listOutputs()).resolves.toBeNull()
})

it('keeps malformed output responses distinguishable from an unsupported operation', async () => {
  for (const body of ['invalid JSON', '{"ok":true,"data":{}}']) {
    const client = clientWithOutputResponse(body)
    await expect(client.listOutputs()).rejects.toMatchObject({ code: 'invalid_payload' })
  }
})
