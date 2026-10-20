import { storagePersistence } from '../core/storagePersistence'

export type NormalizationField = 'artist' | 'composer' | 'genre' | 'all'

export interface NormalizationRule {
  id: string
  field: NormalizationField
  sourcePattern: string
  targetValue: string
  createdAt: string
  lastAppliedAt?: string
  matchCount: number
  isEnabled: boolean
  scope?: 'global' | 'library'
}

const STORAGE_KEY = 'cadence_normalization_rules'

export class NormalizationService {
  private rules: Map<string, NormalizationRule> = new Map()
  private listeners: Set<() => void> = new Set()
  private initialized = false

  constructor() {
    this.loadRules()
  }

  /**
   * Normalizes a string for loose phonetic/punctuation comparison.
   * Strips all punctuation, periods, spaces, underscores, and dashes.
   * e.g. "A. R. Rahman" -> "arrahman", "A.R.Rahman" -> "arrahman"
   */
  public normalizeKey(str: string): string {
    if (!str) return ''
    return str.toLowerCase().replace(/[\.\s_,\-]+/g, '')
  }

  /**
   * Loads persisted rules from localStorage and verifies sync.
   */
  public loadRules(): NormalizationRule[] {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            this.rules.clear()
            for (const r of parsed) {
              if (r && r.id && r.sourcePattern && r.targetValue) {
                this.rules.set(r.id, r)
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[NormalizationService] Failed to load rules from localStorage:', e)
    }

    this.initialized = true
    return Array.from(this.rules.values())
  }

  /**
   * Persists the current rules map to localStorage and notifies subscribers.
   */
  private saveRules(): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const array = Array.from(this.rules.values())
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(array))
      }
    } catch (e) {
      console.warn('[NormalizationService] Failed to save rules to localStorage:', e)
    }

    this.notifyListeners()
  }

  public subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notifyListeners(): void {
    this.listeners.forEach((cb) => {
      try {
        cb()
      } catch (e) {
        console.error('[NormalizationService] Listener error:', e)
      }
    })
  }

  /**
   * Returns all stored normalization rules.
   */
  public getRules(): NormalizationRule[] {
    if (!this.initialized) this.loadRules()
    return Array.from(this.rules.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }

  public getRule(id: string): NormalizationRule | undefined {
    return this.rules.get(id)
  }

  /**
   * Records or updates a normalization rule.
   * E.g. source: "A. R. Rahman", target: "A.R.Rahman", field: "artist"
   */
  public recordNormalization(
    source: string,
    target: string,
    field: NormalizationField = 'artist'
  ): NormalizationRule {
    const sTrim = (source || '').trim()
    const tTrim = (target || '').trim()

    if (!sTrim || !tTrim || sTrim === tTrim) {
      // If no valid change, return an empty placeholder or existing rule if found
      const existing = this.findRuleBySourceAndTarget(sTrim, tTrim, field)
      if (existing) return existing
    }

    const normKeySource = this.normalizeKey(sTrim)
    const normKeyTarget = this.normalizeKey(tTrim)

    // Look for an existing rule matching the normalized key and field
    let existingRule: NormalizationRule | undefined
    for (const rule of this.rules.values()) {
      if (rule.field === field || rule.field === 'all' || field === 'all') {
        const rNormSource = this.normalizeKey(rule.sourcePattern)
        const rNormTarget = this.normalizeKey(rule.targetValue)
        if (
          rNormSource === normKeySource ||
          rNormTarget === normKeySource ||
          rNormSource === normKeyTarget ||
          rule.sourcePattern.toLowerCase() === sTrim.toLowerCase()
        ) {
          existingRule = rule
          break
        }
      }
    }

    if (existingRule) {
      existingRule.targetValue = tTrim
      if (!existingRule.sourcePattern.toLowerCase().includes(sTrim.toLowerCase())) {
        existingRule.sourcePattern = sTrim
      }
      existingRule.matchCount = (existingRule.matchCount || 0) + 1
      existingRule.lastAppliedAt = new Date().toISOString()
      existingRule.isEnabled = true
      this.saveRules()
      return existingRule
    }

    const newRule: NormalizationRule = {
      id: `norm-rule-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      field,
      sourcePattern: sTrim,
      targetValue: tTrim,
      createdAt: new Date().toISOString(),
      lastAppliedAt: new Date().toISOString(),
      matchCount: 1,
      isEnabled: true,
      scope: 'global',
    }

    this.rules.set(newRule.id, newRule)
    this.saveRules()
    return newRule
  }

  public addRule(rule: Omit<NormalizationRule, 'id' | 'createdAt' | 'matchCount'>): NormalizationRule {
    const id = `norm-rule-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    const created: NormalizationRule = {
      ...rule,
      id,
      createdAt: new Date().toISOString(),
      matchCount: 0,
    }
    this.rules.set(id, created)
    this.saveRules()
    return created
  }

  public toggleRule(id: string, isEnabled?: boolean): boolean {
    const r = this.rules.get(id)
    if (!r) return false
    r.isEnabled = isEnabled !== undefined ? isEnabled : !r.isEnabled
    this.saveRules()
    return r.isEnabled
  }

  public removeRule(id: string): boolean {
    const deleted = this.rules.delete(id)
    if (deleted) this.saveRules()
    return deleted
  }

  public clearRules(): void {
    this.rules.clear()
    this.saveRules()
  }

  private findRuleBySourceAndTarget(
    source: string,
    target: string,
    field: NormalizationField
  ): NormalizationRule | undefined {
    for (const r of this.rules.values()) {
      if (
        (r.field === field || r.field === 'all') &&
        r.sourcePattern.toLowerCase() === source.toLowerCase() &&
        r.targetValue.toLowerCase() === target.toLowerCase()
      ) {
        return r
      }
    }
    return undefined
  }

  /**
   * Finds any active rule that applies to a given phonetic/punctuation cluster.
   */
  public findRuleForCluster(
    normKey: string,
    variants: string[],
    field: NormalizationField = 'artist'
  ): NormalizationRule | undefined {
    for (const rule of this.rules.values()) {
      if (!rule.isEnabled) continue
      if (rule.field !== field && rule.field !== 'all' && field !== 'all') continue

      const rNormSource = this.normalizeKey(rule.sourcePattern)
      const rNormTarget = this.normalizeKey(rule.targetValue)

      if (rNormSource === normKey || rNormTarget === normKey) {
        return rule
      }

      for (const v of variants) {
        const vNorm = this.normalizeKey(v)
        if (vNorm === rNormSource || vNorm === rNormTarget || v.toLowerCase() === rule.sourcePattern.toLowerCase()) {
          return rule
        }
      }
    }
    return undefined
  }

  /**
   * Applies normalization rules to a text string (exact, normalized, or sub-token delimiter).
   */
  public applyToText(text: string, field: NormalizationField = 'all'): string {
    if (!text || typeof text !== 'string') return text
    const trimmed = text.trim()
    if (!trimmed) return text

    const normText = this.normalizeKey(trimmed)
    const activeRules = Array.from(this.rules.values()).filter((r) => {
      if (!r.isEnabled) return false
      if (r.field === 'all' || field === 'all') return true
      if (r.field === field) return true
      // Artist and composer name authorities are shared musicological person entities
      if ((field === 'composer' || field === 'artist') && (r.field === 'artist' || r.field === 'composer')) {
        return true
      }
      return false
    })


    // 1. Direct or normalized full match
    for (const rule of activeRules) {
      const rNormSource = this.normalizeKey(rule.sourcePattern)
      const rNormTarget = this.normalizeKey(rule.targetValue)

      if (trimmed === rule.targetValue) {
        // Already canonical
        return rule.targetValue
      }

      if (
        trimmed.toLowerCase() === rule.sourcePattern.toLowerCase() ||
        normText === rNormSource ||
        (normText === rNormTarget && trimmed !== rule.targetValue)
      ) {
        rule.matchCount = (rule.matchCount || 0) + 1
        rule.lastAppliedAt = new Date().toISOString()
        return rule.targetValue
      }
    }

    // 2. Delimited multi-value check (e.g. "A. R. Rahman & Hariharan", "A. R. Rahman, S. Janaki")
    if (/[,;&\/+]|\s+(?:feat\.?|ft\.?|with|and)\s+/i.test(trimmed)) {
      // Split tokens preserving delimiters or reconstructing cleanly
      const tokens = trimmed.split(/([,;&\/+]|\s+(?:feat\.?|ft\.?|with|and)\s+)/i)
      let modified = false
      const transformedTokens = tokens.map((token) => {
        const tokTrim = token.trim()
        if (!tokTrim || /^(feat\.?|ft\.?|with|and|[,;&\/+])$/i.test(tokTrim)) {
          return token
        }
        const tokNorm = this.normalizeKey(tokTrim)
        for (const rule of activeRules) {
          const rNormSource = this.normalizeKey(rule.sourcePattern)
          const rNormTarget = this.normalizeKey(rule.targetValue)
          if (
            tokTrim.toLowerCase() === rule.sourcePattern.toLowerCase() ||
            tokNorm === rNormSource ||
            (tokNorm === rNormTarget && tokTrim !== rule.targetValue)
          ) {
            modified = true
            rule.matchCount = (rule.matchCount || 0) + 1
            rule.lastAppliedAt = new Date().toISOString()
            // Preserve leading/trailing spaces from original token chunk
            const leadingSpaces = token.match(/^\s*/)?.[0] || ''
            const trailingSpaces = token.match(/\s*$/)?.[0] || ''
            return `${leadingSpaces}${rule.targetValue}${trailingSpaces}`
          }
        }
        return token
      })

      if (modified) {
        return transformedTokens.join('')
      }
    }

    return text
  }

  /**
   * Fast canonical lookup for artist authorities.
   */
  public getCanonicalArtist(rawArtist: string): string | null {
    if (!rawArtist) return null
    const res = this.applyToText(rawArtist, 'artist')
    return res !== rawArtist ? res : null
  }

  /**
   * Fast canonical lookup for composer authorities.
   */
  public getCanonicalComposer(rawComposer: string): string | null {
    if (!rawComposer) return null
    const res = this.applyToText(rawComposer, 'composer')
    return res !== rawComposer ? res : null
  }

  /**
   * Fast canonical lookup for genres.
   */
  public getCanonicalGenre(rawGenre: string): string | null {
    if (!rawGenre) return null
    const res = this.applyToText(rawGenre, 'genre')
    return res !== rawGenre ? res : null
  }

  /**
   * Applies normalization rules across candidate fields from external enrichment.
   * This guarantees that remembered rules always take precedence over Apple Music,
   * MusicBrainz, and Gemini AI.
   */
  public applyToCandidate<
    T extends {
      artistCredit?: string
      composer?: string
      composerName?: string
      genre?: string
      [key: string]: any
    }
  >(candidate: T): T {
    if (!candidate) return candidate

    const copy = { ...candidate }

    if (copy.artistCredit) {
      copy.artistCredit = this.applyToText(copy.artistCredit, 'artist')
    }
    if (copy.composer) {
      copy.composer = this.applyToText(copy.composer, 'composer')
    }
    if (copy.composerName) {
      copy.composerName = this.applyToText(copy.composerName, 'composer')
    }
    if (copy.genre) {
      copy.genre = this.applyToText(copy.genre, 'genre')
    }

    return copy
  }
}

export const normalizationService = new NormalizationService()
