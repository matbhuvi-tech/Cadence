/**
 * src/services/behavioralLearningService.ts
 * Behavioral Learning Engine for Cadence Metadata Management.
 * 
 * Captures user spelling, spacing, and delimiter corrections (e.g. "A.R. Rahman" -> "A. R. Rahman"),
 * generalizes common orthographic and punctuation variations, and automatically elevates future
 * matching candidates to Tier 1 confidence.
 */

import { LearnedRule, SemanticConventions } from '../core/types'

const STORAGE_KEY = 'cadence_behavioral_learned_rules_v1'

class BehavioralLearningService {
  private rules: Map<string, LearnedRule> = new Map()
  private initialized: boolean = false
  private conventions: SemanticConventions = {
    albumArtistEqualsComposerForIndianSoundtracks: true,
    languagePrefixedSoundtrackGenre: true,
    defaultSoundtrackLanguage: 'Tamil',
  }

  constructor() {
    this.loadRules()
  }

  private loadRules(): void {
    if (this.initialized) return
    this.initialized = true

    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as LearnedRule[]
          for (const rule of parsed) {
            this.rules.set(rule.id, rule)
          }
        }
        const rawConv = window.localStorage.getItem(STORAGE_KEY + '_conventions')
        if (rawConv) {
          this.conventions = { ...this.conventions, ...JSON.parse(rawConv) }
        }
        if (raw) return
      } catch (err) {
        console.warn('[BehavioralLearningService] Failed to load rules from localStorage:', err)
      }
    }

    // Default seeded baseline rules for Indian / Global soundtracks
    this.seedDefaultRules()
  }

  private persistRules(): void {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const arr = Array.from(this.rules.values())
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
        window.localStorage.setItem(STORAGE_KEY + '_conventions', JSON.stringify(this.conventions))
      } catch (err) {
        console.warn('[BehavioralLearningService] Failed to persist rules:', err)
      }
    }
  }

  public getConventions(): SemanticConventions {
    return { ...this.conventions }
  }

  public updateConventions(updates: Partial<SemanticConventions>): void {
    this.conventions = { ...this.conventions, ...updates }
    this.persistRules()
  }

  /**
   * Applies high-level semantic conventions for Indian film music and soundtracks.
   */
  public applySoundtrackConventions(params: {
    composer?: string
    albumArtist?: string
    genre?: string
    language?: string
    isSoundtrack?: boolean
  }): {
    albumArtist?: string
    genre?: string
    appliedConventions: string[]
  } {
    const applied: string[] = []
    let outArtist = params.albumArtist
    let outGenre = params.genre

    // 1. Indian Movie Music: Album Artist = Composer
    if (
      this.conventions.albumArtistEqualsComposerForIndianSoundtracks &&
      params.composer &&
      params.composer.trim() !== ''
    ) {
      const comp = params.composer.trim()
      const rawArtistLower = (outArtist || '').trim().toLowerCase()
      const compLower = comp.toLowerCase()

      // Check if current album artist is empty, placeholder, unknown, various,
      // or if it differs from the primary composer on a soundtrack release
      const isPlaceholder =
        !outArtist ||
        rawArtistLower === '' ||
        rawArtistLower.includes('unknown') ||
        rawArtistLower.includes('various')

      // If it's a soundtrack, composer promotion takes precedence unless albumArtist is explicitly canonicalized
      const isSoundtrackContext =
        params.isSoundtrack ||
        !outGenre ||
        outGenre.toLowerCase().includes('soundtrack') ||
        outGenre.toLowerCase().includes('film') ||
        outGenre.toLowerCase().includes('ost')

      if (isPlaceholder || (isSoundtrackContext && rawArtistLower !== compLower)) {
        outArtist = comp
        applied.push('album_artist_equals_composer')
      }
    }

    // 2. Language-Prefixed Soundtrack Genre (e.g. "Tamil Film Soundtrack")
    if (this.conventions.languagePrefixedSoundtrackGenre) {
      const lang = params.language || this.conventions.defaultSoundtrackLanguage || 'Tamil'
      const targetGenre = `${lang} Film Soundtrack`
      
      const isSoundtrackLike =
        params.isSoundtrack ||
        !outGenre ||
        outGenre.toLowerCase().includes('soundtrack') ||
        outGenre.toLowerCase().includes('film') ||
        outGenre.toLowerCase().includes('score') ||
        outGenre.toLowerCase().includes('ost')

      if (isSoundtrackLike && outGenre !== targetGenre) {
        outGenre = targetGenre
        applied.push('language_prefixed_soundtrack_genre')
      }
    }

    return {
      albumArtist: outArtist,
      genre: outGenre,
      appliedConventions: applied,
    }
  }

  private seedDefaultRules(): void {
    const defaults: Array<{ pattern: string; normalized: string; category: LearnedRule['category'] }> = [
      { pattern: 'A.R. Rahman', normalized: 'A. R. Rahman', category: 'artist' },
      { pattern: 'A.R.Rahman', normalized: 'A. R. Rahman', category: 'artist' },
      { pattern: 'AR Rahman', normalized: 'A. R. Rahman', category: 'artist' },
      { pattern: 'S.P. Balasubrahmanyam', normalized: 'S. P. Balasubrahmanyam', category: 'artist' },
      { pattern: 'S.P.Balasubrahmanyam', normalized: 'S. P. Balasubrahmanyam', category: 'artist' },
      { pattern: 'SP Balasubrahmanyam', normalized: 'S. P. Balasubrahmanyam', category: 'artist' },
      { pattern: 'S.P.B.', normalized: 'S. P. Balasubrahmanyam', category: 'artist' },
      { pattern: 'SPB', normalized: 'S. P. Balasubrahmanyam', category: 'artist' },
      { pattern: 'K.J. Yesudas', normalized: 'K. J. Yesudas', category: 'artist' },
      { pattern: 'KJ Yesudas', normalized: 'K. J. Yesudas', category: 'artist' },
      { pattern: 'K.S. Chithra', normalized: 'K. S. Chithra', category: 'artist' },
      { pattern: 'KS Chithra', normalized: 'K. S. Chithra', category: 'artist' },
    ]

    for (const d of defaults) {
      const id = `rule_${this.hashPattern(d.pattern)}`
      this.rules.set(id, {
        id,
        pattern: d.pattern,
        normalizedValue: d.normalized,
        category: d.category,
        frequency: 1,
        lastUsed: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })
    }
  }

  private hashPattern(str: string): string {
    return encodeURIComponent(str.toLowerCase().trim())
  }

  /**
   * Generates orthographic and punctuation variants for an entity name.
   * e.g., "A. R. Rahman" -> ["A.R. Rahman", "A.R.Rahman", "AR Rahman", "A R Rahman"]
   */
  public generateVariants(name: string): string[] {
    const variants = new Set<string>()
    const trimmed = name.trim()
    variants.add(trimmed)

    // Robust Initials Extraction:
    // Match leading initials pattern like: "A. R.", "A.R.", "AR", "A R", "A.R.R.", "K. J.", "S. P."
    const initialsMatch = trimmed.match(/^((?:[A-Z]\.\s*)+|(?:[A-Z]{2,3}\s+))(.*)$/)
    if (initialsMatch && initialsMatch[1].replace(/[^A-Z]/g, '').length >= 2) {
      const letters = initialsMatch[1].replace(/[^A-Z]/g, '').split('')
      const rest = initialsMatch[2].trim()

      // 1. Spaced dots: "A. R. Rahman"
      variants.add(`${letters.map(l => `${l}.`).join(' ')} ${rest}`.trim())
      // 2. Merged dots with space: "A.R. Rahman"
      variants.add(`${letters.map(l => `${l}.`).join('')} ${rest}`.trim())
      // 3. Merged dots without space: "A.R.Rahman"
      variants.add(`${letters.map(l => `${l}.`).join('')}${rest}`.trim())
      // 4. No dots: "AR Rahman"
      variants.add(`${letters.join('')} ${rest}`.trim())
      // 5. Spaced no dots: "A R Rahman"
      variants.add(`${letters.join(' ')} ${rest}`.trim())
    }

    // Common hyphenation and en-dash variants
    if (trimmed.includes('-')) {
      variants.add(trimmed.replace(/-/g, '–'))
      variants.add(trimmed.replace(/-/g, ' '))
    } else if (trimmed.includes('–')) {
      variants.add(trimmed.replace(/–/g, '-'))
      variants.add(trimmed.replace(/–/g, ' '))
    }

    return Array.from(variants)
  }

  /**
   * Records a user correction and teaches the engine to apply this normalization.
   * Automatically derives variations so that related inputs are normalized in Tier 1.
   */
  public teachRule(
    original: string,
    corrected: string,
    category: LearnedRule['category'] = 'artist'
  ): LearnedRule[] {
    const normCorrected = corrected.trim()
    const normOriginal = original.trim()

    if (!normCorrected || !normOriginal || normCorrected === normOriginal) {
      return []
    }

    const createdRules: LearnedRule[] = []
    const variants = this.generateVariants(normOriginal)
    if (!variants.includes(normOriginal)) variants.push(normOriginal)

    for (const v of variants) {
      if (v.toLowerCase() === normCorrected.toLowerCase() && v === normCorrected) continue
      const id = `rule_${this.hashPattern(v)}`
      const existing = this.rules.get(id)

      const rule: LearnedRule = {
        id,
        pattern: v,
        normalizedValue: normCorrected,
        category,
        frequency: existing ? existing.frequency + 1 : 1,
        lastUsed: new Date().toISOString(),
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }

      this.rules.set(id, rule)
      createdRules.push(rule)
    }

    this.persistRules()
    return createdRules
  }

  /**
   * Applies any learned rule to an input string.
   * Supports exact match and sub-token word replacement.
   */
  public applyLearnedRules(
    input: string,
    category?: LearnedRule['category']
  ): { value: string; appliedRule?: LearnedRule } {
    if (!input || !input.trim()) return { value: input }
    const trimmed = input.trim()

    // 1. Direct exact/case-insensitive match or alphanumeric root match
    const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const trimmedNorm = normKey(trimmed)

    for (const rule of this.rules.values()) {
      if (category && rule.category !== category) continue

      if (
        rule.pattern.toLowerCase() === trimmed.toLowerCase() ||
        (trimmedNorm.length >= 4 && normKey(rule.pattern) === trimmedNorm)
      ) {
        rule.frequency += 1
        rule.lastUsed = new Date().toISOString()
        this.persistRules()
        return { value: rule.normalizedValue, appliedRule: rule }
      }
    }

    // 2. Sub-string / multiple artist delimiter replacement (e.g., "K.J. Yesudas & S.P.B.")
    let current = trimmed
    let applied: LearnedRule | undefined = undefined

    for (const rule of this.rules.values()) {
      if (category && rule.category !== category) continue

      // Match as distinct word boundary or enclosed in delimiters (&, ,, /)
      const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(^|[,&;/\\s])(${escaped})([,&;/\\s]|$)`, 'gi')

      if (regex.test(current)) {
        current = current.replace(regex, (_m, p1, _p2, p3) => `${p1}${rule.normalizedValue}${p3}`)
        applied = rule
        rule.frequency += 1
        rule.lastUsed = new Date().toISOString()
      }
    }

    if (applied) {
      this.persistRules()
      return { value: current.trim(), appliedRule: applied }
    }

    return { value: input }
  }

  public getLearnedRules(): LearnedRule[] {
    return Array.from(this.rules.values()).sort((a, b) => b.frequency - a.frequency)
  }

  public updateRule(id: string, updates: Partial<LearnedRule>): boolean {
    const existing = this.rules.get(id)
    if (!existing) return false
    this.rules.set(id, { ...existing, ...updates })
    this.persistRules()
    return true
  }

  public deleteRule(id: string): boolean {
    const deleted = this.rules.delete(id)
    if (deleted) this.persistRules()
    return deleted
  }

  public clearAllRules(): void {
    this.rules.clear()
    this.persistRules()
  }
}

export const behavioralLearningService = new BehavioralLearningService()
