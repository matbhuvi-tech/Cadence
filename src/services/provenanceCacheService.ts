/**
 * src/services/provenanceCacheService.ts
 * Cadence Parameter-Hashed SQLite Cache for Compilation Provenance.
 *
 * Implements deterministic SHA-256 hashing across album and track signatures.
 * Automatically invalidates cache when search parameters, titles, or track lists change.
 * Features browser in-memory fallback and 1,000-entry LRU cap.
 */

import { CompilationProvenanceResult, Track } from '../core/types'
import { cleanConsensusTitle } from '../core/taxonomyUtils'
import { tauriBridge } from './tauriBridge'

// In-memory LRU cache fallback for browser preview mode or before IPC resolves
const memoryCache = new Map<string, { result: CompilationProvenanceResult; createdAt: number }>()
const MAX_CACHE_ENTRIES = 1000

export class ProvenanceCacheService {
  /**
   * Generates a deterministic SHA-256 parameter hash over the normalized album and track inputs.
   */
  public async computeHashKey(
    albumTitle: string,
    artistCredit: string = '',
    composerName: string = '',
    tracks: Array<{ id: string; trackNumber?: number; title: string; duration?: number; durationSeconds?: number }>
  ): Promise<string> {
    const cleanTitle = cleanConsensusTitle(albumTitle || '').trim().toLowerCase()
    const cleanArtist = cleanConsensusTitle(artistCredit || '').trim().toLowerCase()
    const cleanComposer = cleanConsensusTitle(composerName || '').trim().toLowerCase()

    const trackSignature = (tracks || [])
      .map((t) => {
        const tTitle = cleanConsensusTitle(t.title || '').trim().toLowerCase()
        const tNum = t.trackNumber || 0
        const dur = Math.round(t.duration || t.durationSeconds || 0)
        return `${t.id}:${tNum}:${tTitle}:${dur}`
      })
      .join('|')

    const rawSignature = [cleanTitle, cleanArtist, cleanComposer, trackSignature].join(':::')

    // Web Crypto API SHA-256
    const msgUint8 = new TextEncoder().encode(rawSignature)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Retrieves cached compilation provenance result if hash key matches.
   */
  public async get(hashKey: string): Promise<CompilationProvenanceResult | null> {
    if (!hashKey) return null

    // 1. Check in-memory fallback first
    const memEntry = memoryCache.get(hashKey)
    if (memEntry) {
      return { ...memEntry.result, cached: true }
    }

    // 2. Query native SQLite backend if in Tauri desktop environment
    if (tauriBridge.isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const row = await invoke<any>('db_get_provenance_cache', { hashKey })
        if (row && row.response_json) {
          const parsed = JSON.parse(row.response_json) as CompilationProvenanceResult
          parsed.cached = true
          memoryCache.set(hashKey, { result: parsed, createdAt: Date.now() })
          return parsed
        }
      } catch (err) {
        // Native command may not be mounted yet; fallback gracefully
      }
    }

    return null
  }

  /**
   * Persists compilation provenance result into cache.
   */
  public async set(
    hashKey: string,
    albumId: string,
    albumTitle: string,
    inputParams: any,
    result: CompilationProvenanceResult,
    modelVersion: string = 'gemini-1.5-flash'
  ): Promise<void> {
    if (!hashKey || !result) return

    // 1. Store in memory map and enforce LRU cap
    memoryCache.set(hashKey, { result, createdAt: Date.now() })
    if (memoryCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = memoryCache.keys().next().value
      if (oldestKey) memoryCache.delete(oldestKey)
    }

    // 2. Persist to native SQLite backend if available
    if (tauriBridge.isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('db_set_provenance_cache', {
          hashKey,
          albumId,
          albumTitle,
          inputParamsJson: JSON.stringify(inputParams),
          responseJson: JSON.stringify(result),
          modelVersion,
        })
      } catch (err) {
        // Native command may not be mounted yet; silently fallback to in-memory
      }
    }
  }

  /**
   * Clears the in-memory cache (primarily for test environments).
   */
  public clearMemoryCache(): void {
    memoryCache.clear()
  }
}

export const provenanceCacheService = new ProvenanceCacheService()
