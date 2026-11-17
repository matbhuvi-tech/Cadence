import type { SavedCoreProfile } from './coreControllerTransport'

export interface EngineOutput {
  id: string
  displayName: string
  transport: 'upnp' | 'wasapi' | 'system_default'
  isAvailable: boolean
}

type Post = (profile: SavedCoreProfile, request: Record<string, unknown>) => Promise<unknown>

export function createEngineOutputsClient(profile: SavedCoreProfile, post: Post) {
  async function request(operation: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await post(profile, { protocolVersion: 2, engineId: profile.engineId, libraryId: profile.libraryId, operation, ...extra })
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid engine response')
    const result = response as Record<string, unknown>
    if (result.ok !== true) {
      const error = result.error && typeof result.error === 'object' ? result.error as Record<string, unknown> : {}
      if (operation === 'outputs.scan' && error.code === 'invalid_payload') throw new Error('This playback engine does not support scanning. Update the engine and try again.')
      if (operation === 'outputs.scan' && error.code === 'not_ready') throw new Error('Stop playback and wait 30 seconds before scanning.')
      throw new Error('The playback engine could not complete the output request.')
    }
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid engine response')
    return result.data as Record<string, unknown>
  }
  async function outputs(operation: string): Promise<EngineOutput[]> {
      const data = await request(operation)
      if (!Array.isArray(data.outputs) || data.outputs.length > 256) throw new Error('Invalid engine output list')
      return data.outputs.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid engine output')
        const output = value as Record<string, unknown>
        if (typeof output.id !== 'string' || !output.id || output.id.length > 512 || typeof output.displayName !== 'string' || !output.displayName || !['upnp', 'wasapi', 'system_default'].includes(String(output.transport)) || typeof output.isAvailable !== 'boolean') throw new Error('Invalid engine output')
        return { id: output.id, displayName: output.displayName, transport: output.transport as EngineOutput['transport'], isAvailable: output.isAvailable }
      })
  }
  return {
    list: () => outputs('outputs.list'),
    scan: () => outputs('outputs.scan'),
    async select(id: string): Promise<void> {
      if (!id || id.length > 512) throw new Error('Invalid output ID')
      await request('output.select', { outputId: id })
    },
    async selectAndConfirm(id: string, refresh: () => Promise<{ id: string } | null>): Promise<void> {
      if (!id || id.length > 512) throw new Error('Invalid output ID')
      const data = await request('output.select', { outputId: id })
      const selected = data.output
      if (!selected || typeof selected !== 'object' || Array.isArray(selected) || typeof (selected as Record<string, unknown>).id !== 'string') throw new Error('Engine did not confirm the selected output.')
      const snapshot = await refresh()
      if (!snapshot || snapshot.id !== (selected as { id: string }).id) throw new Error('Engine did not confirm the selected output. Update or restart the playback engine and try again.')
    },
  }
}
