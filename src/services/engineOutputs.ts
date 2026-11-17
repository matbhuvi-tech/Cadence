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
    if (result.ok !== true || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Engine output request failed')
    return result.data as Record<string, unknown>
  }
  return {
    async list(): Promise<EngineOutput[]> {
      const data = await request('outputs.list')
      if (!Array.isArray(data.outputs) || data.outputs.length > 256) throw new Error('Invalid engine output list')
      return data.outputs.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid engine output')
        const output = value as Record<string, unknown>
        if (typeof output.id !== 'string' || !output.id || output.id.length > 512 || typeof output.displayName !== 'string' || !output.displayName || !['upnp', 'wasapi', 'system_default'].includes(String(output.transport)) || typeof output.isAvailable !== 'boolean') throw new Error('Invalid engine output')
        return { id: output.id, displayName: output.displayName, transport: output.transport as EngineOutput['transport'], isAvailable: output.isAvailable }
      })
    },
    async select(id: string): Promise<void> {
      if (!id || id.length > 512) throw new Error('Invalid output ID')
      await request('output.select', { outputId: id })
    },
  }
}
