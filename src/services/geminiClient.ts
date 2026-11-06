import { invoke } from '@tauri-apps/api/core'
import type { CompilationProvenanceResult } from '../core/types'

const isDesktop = () => typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)

export async function resolveGemini(operation: 'metadata' | 'cover-art' | 'compilation' | 'agent-chat', payload: unknown, signal?: AbortSignal, singleAttempt = false): Promise<CompilationProvenanceResult | any> {
  signal?.throwIfAborted()
  if (isDesktop()) return invoke('gemini_resolve', { operation, payload, singleAttempt })
  const endpoint: Record<typeof operation, string> = {
    metadata: '/api/ai-metadata-resolver',
    'cover-art': '/api/ai-cover-art',
    compilation: '/api/ai-compilation-resolver',
    'agent-chat': '/api/agent-chat',
  }
  const response = await fetch(endpoint[operation] + (singleAttempt ? '?singleAttempt=1' : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || `Gemini request failed (${response.status})`)
  return result
}

export async function getGeminiQuota(): Promise<any> {
  if (isDesktop()) return invoke('get_gemini_quota')
  const response = await fetch('/api/ai-quota-telemetry')
  if (!response.ok) throw new Error(`Gemini quota request failed (${response.status})`)
  return response.json()
}
