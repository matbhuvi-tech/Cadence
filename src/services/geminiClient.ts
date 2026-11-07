import { invoke } from '@tauri-apps/api/core'
import type { CompilationProvenanceResult } from '../core/types'
import type { CurateProviderAttempt, RecordCurateAttempt } from './curateEvidenceService'

const isDesktop = () => typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 2000) : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .slice(0, 2000)
}

export async function resolveGemini(operation: 'metadata' | 'cover-art' | 'compilation' | 'agent-chat', payload: unknown,
  signal?: AbortSignal, singleAttempt = false, record?: RecordCurateAttempt,
): Promise<CompilationProvenanceResult | any> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  let outcome: CurateProviderAttempt['outcome'] = 'error'
  let httpStatus: number | undefined
  let errorMessage: string | undefined
  let result: any
  let candidate: CurateProviderAttempt['candidate']
  const context = payload as { albumTitle?: string; userSearchQuery?: { albumTitle?: string } } | null
  try {
    signal?.throwIfAborted()
    if (isDesktop()) {
      result = await invoke('gemini_resolve', { operation, payload, singleAttempt })
    } else {
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
      httpStatus = response.status
      outcome = response.ok ? 'parse_error' : 'http_error'
      result = await response.json()
      if (!response.ok) throw new Error(result.error || `Gemini request failed (${response.status})`)
    }
    signal?.throwIfAborted()
    if (result?.success === false) {
      outcome = 'error'
      throw new Error(result.error || 'Gemini could not resolve the album.')
    }
    if (operation === 'compilation') {
      if (!Array.isArray(result?.results)) {
        outcome = 'parse_error'
        throw new Error('Gemini returned an invalid provenance response.')
      }
      const rows: any[] = result.results
      outcome = rows.length ? 'success' : 'empty'
      if (record) candidate = {
        title: textField(result.albumTitle) ?? textField(context?.albumTitle),
        trackCount: rows.length,
        tracks: rows.slice(0, 100).map(row => ({
          localTrackId: textField(row?.id),
          number: numberField(row?.trackNumber),
          title: textField(row?.title),
          artist: textField(row?.primaryVocalists),
          composer: textField(row?.canonicalComposer),
          originalAlbum: textField(row?.originalAlbum),
          originalYear: numberField(row?.originalYear),
          confidence: numberField(row?.confidence),
          isCompilationTrack: typeof row?.isCompilationTrack === 'boolean' ? row.isCompilationTrack : undefined,
          notes: textField(row?.notes),
        })),
      }
    } else {
      outcome = 'success'
    }
    return result
  } catch (error) {
    errorMessage = safeErrorMessage(error)
    // Native commands currently reject with a string containing the upstream status.
    const nativeStatus = errorMessage.match(/Gemini request failed \((\d{3})\b/)?.[1]
    if (nativeStatus) httpStatus = Number(nativeStatus)
    if (signal?.aborted) outcome = 'cancelled'
    else if (httpStatus && httpStatus >= 400) outcome = 'http_error'
    else if ((error instanceof Error && error.name === 'TimeoutError') || /timed? out|timeout/i.test(errorMessage)) outcome = 'timeout'
    else if (error instanceof SyntaxError || /invalid (?:gemini )?json|invalid provenance response/i.test(errorMessage)) outcome = 'parse_error'
    else if (error instanceof TypeError) outcome = 'network_error'
    throw error
  } finally {
    record?.({
      provider: 'gemini',
      query: textField(context?.userSearchQuery?.albumTitle) ?? textField(context?.albumTitle) ?? operation,
      startedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      outcome, httpStatus, errorMessage, candidate,
      modelUsed: textField(result?.telemetry?.modelUsed),
      retriesAttempted: numberField(result?.telemetry?.retriesAttempted),
      pacingDelayMs: numberField(result?.telemetry?.pacingDelayMs),
    })
  }
}

export async function getGeminiQuota(): Promise<any> {
  if (isDesktop()) return invoke('get_gemini_quota')
  const response = await fetch('/api/ai-quota-telemetry')
  if (!response.ok) throw new Error(`Gemini quota request failed (${response.status})`)
  return response.json()
}
