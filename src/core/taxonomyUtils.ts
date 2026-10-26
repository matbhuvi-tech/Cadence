import { Track, Release } from './types'

// --- Canonical Artist Tokenization & Compound Whitelist ---
export const COMPOUND_ARTIST_WHITELIST: Record<string, string> = {
  shankarehsaanloy: 'Shankar-Ehsaan-Loy',
  salimsulaiman: 'Salim–Sulaiman',
  vishalshekhar: 'Vishal–Shekhar',
  kalyanjianandji: 'Kalyanji-Anandji',
  laxmikantpyarelal: 'Laxmikant-Pyarelal',
  anandmilind: 'Anand-Milind',
  nadeemshravan: 'Nadeem-Shravan',
  jatingalit: 'Jatin-Lalit',
  sajidwajid: 'Sajid-Wajid',
  shivhari: 'Shiv-Hari',
  simonandgarfunkel: 'Simon & Garfunkel',
  crosbystillsnash: 'Crosby, Stills & Nash',
  crosbystillsnashandyoung: 'Crosby, Stills, Nash & Young',
  emersonlakeandpalmer: 'Emerson, Lake & Palmer',
  earthwindandfire: 'Earth, Wind & Fire',
  hallandoates: 'Daryl Hall & John Oates',
  koolandthegang: 'Kool & The Gang',
  daftpunk: 'Daft Punk',
  slyandthefamilystone: 'Sly & The Family Stone',
  rageagainstthemachine: 'Rage Against the Machine',
  charlieparkeranddizzygillespie: 'Charlie Parker & Dizzy Gillespie',
  bbthedilse: 'A. R. Rahman',
}

/**
 * Normalizes an artist name to lowercase alphanumeric without punctuation or spaces
 * to protect compound bands/duos regardless of hyphens, en-dashes, or spacing.
 */
export function normalizeArtistForCompoundLookup(name: string): string {
  return name.toLowerCase().replace(/[\s\-_–—.,&'"+/\\()[\]]/g, '').trim()
}

/**
 * Checks if a name matches any known compound artist or duo.
 */
export function isCompoundArtistException(name: string): string | null {
  if (typeof COMPOUND_ARTIST_WHITELIST === 'undefined' || !COMPOUND_ARTIST_WHITELIST) return null
  const norm = normalizeArtistForCompoundLookup(name)
  return COMPOUND_ARTIST_WHITELIST[norm] || null
}

export interface TaxonomyNormalizationDelegate {
  getCanonicalComposer?: (name: string) => string | null
  getCanonicalGenre?: (genre: string) => string | null
  getCanonicalArtist?: (artist: string) => string | null
  applyToText?: (text: string, field?: any) => string
}

let normalizationDelegate: TaxonomyNormalizationDelegate | null = null

export function setTaxonomyNormalizationDelegate(delegate: TaxonomyNormalizationDelegate | null): void {
  normalizationDelegate = delegate
}

/**
 * Strips common digital rip noise, format tags, bitrate tags, and brackets from names and titles.
 */
export function stripRipNoiseAndTags(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/\b(?:cd\s*rip|dvd\s*rip|web\s*rip|vinyl\s*rip|cassette\s*rip|flac\s*rip|sacd\s*rip)\b/gi, '')
    .replace(/\[\s*(?:flac|wav|alac|dsd\d*|mp3|aac|hi-?res|24bit|16bit|\d{1,3}[-/]\d{1,3}(?:\.\d)?|\d{2,4}khz|audio|master)\s*\]/gi, '')
    .replace(/\(\s*(?:flac|wav|alac|dsd\d*|mp3|aac|hi-?res|24bit|16bit|\d{1,3}[-/]\d{1,3}(?:\.\d)?|\d{2,4}khz|audio|master)\s*\)/gi, '')
    .replace(/\[\s*\d{4}(?:\s*-\s*\d{4})?\s*\]/g, '')
    .replace(/\(\s*\d{4}(?:\s*-\s*\d{4})?\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extracts a meaningful folder descriptor from a physical folderPath and folderName,
 * preserving parent context if the leaf folder is merely an artist or disc subfolder.
 */
export function extractMeaningfulFolderName(
  folderName?: string,
  folderPath?: string,
  artistCredit?: string
): string {
  if (!folderPath) return folderName || ''
  const norm = folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = norm.split('/').filter(Boolean)
  if (parts.length === 0) return folderName || ''

  const last = parts[parts.length - 1]
  const parent = parts.length >= 2 ? parts[parts.length - 2] : ''

  const isGeneric =
    (artistCredit && last.toLowerCase() === artistCredit.toLowerCase()) ||
    /^(cd\s*\d+|disc\s*\d+|wav|flac|dsd|lossless|audio|unknown artist|unknown)$/i.test(last)

  if (isGeneric && parent) {
    return `${parent} / ${last}`
  }

  return last
}

/**
 * Normalizes and canonicalizes composer names across variant spellings and credits.
 */
export interface ComposerAuthority {
  canonicalName: string
  key: string
  aliases: string[]
}

export const KNOWN_COMPOSERS: ComposerAuthority[] = [
  {
    canonicalName: 'Ilaiyaraaja',
    key: 'ilaiyaraaja',
    aliases: [
      'ilaiyaraaja',
      'ilayaraja',
      'ilayarajah',
      'ilaiyaraja',
      'illayaraja',
      'illaiyaraaja',
      'isaignani ilaiyaraaja',
      'raaja',
      'ilaiyaraaja (isai gnani)',
      'isai gnani ilaiyaraaja',
      'ilayaraja sir',
    ],
  },
  {
    canonicalName: 'A. R. Rahman',
    key: 'ar-rahman',
    aliases: [
      'a. r. rahman',
      'a.r. rahman',
      'a.r.rahman',
      'ar rahman',
      'allah rakha rahman',
      'a r rahman',
      'rahman',
      'a.r. rahman (isai puyal)',
    ],
  },
  {
    canonicalName: 'M. S. Viswanathan (M.S.V)',
    key: 'ms-viswanathan',
    aliases: [
      'm. s. viswanathan',
      'm.s. viswanathan',
      'm.s.viswanathan',
      'ms viswanathan',
      'm.s.v',
      'msv',
      'm.s.v.',
      'viswanathan - ramamoorthy',
      'm.s.viswanathan & ramamoorthy',
      'mellissai mannar m.s.v',
    ],
  },
  {
    canonicalName: 'Harris Jayaraj',
    key: 'harris-jayaraj',
    aliases: ['harris jayaraj', 'harris jeyaraj', 'harris', 'harris jayaraj hits'],
  },
  {
    canonicalName: 'Yuvan Shankar Raja',
    key: 'yuvan-shankar-raja',
    aliases: ['yuvan shankar raja', 'yuvan', 'u1', 'yuvan shankar'],
  },
  {
    canonicalName: 'Deva',
    key: 'deva',
    aliases: ['deva', 'thenisai thendral deva', 'deva hits'],
  },
  {
    canonicalName: 'Vidyasagar',
    key: 'vidyasagar',
    aliases: ['vidyasagar', 'vidyasagar musical'],
  },
  {
    canonicalName: 'Anirudh Ravichander',
    key: 'anirudh',
    aliases: ['anirudh ravichander', 'anirudh', 'rockstar anirudh'],
  },
  {
    canonicalName: 'R. D. Burman',
    key: 'rd-burman',
    aliases: ['r. d. burman', 'r.d. burman', 'rd burman', 'rahul dev burman', 'pancham', 'pancham da'],
  },
  {
    canonicalName: 'S. D. Burman',
    key: 'sd-burman',
    aliases: ['s. d. burman', 's.d. burman', 'sd burman', 'sachin dev burman'],
  },
  {
    canonicalName: 'Laxmikant–Pyarelal',
    key: 'laxmikant-pyarelal',
    aliases: ['laxmikant pyarelal', 'laxmikant-pyarelal', 'laxmikant - pyarelal', 'l-p'],
  },
  {
    canonicalName: 'Kalyanji–Anandji',
    key: 'kalyanji-anandji',
    aliases: ['kalyanji anandji', 'kalyanji-anandji', 'kalyanji - anandji'],
  },
  {
    canonicalName: 'Ludwig van Beethoven',
    key: 'beethoven',
    aliases: ['ludwig van beethoven', 'beethoven', 'l. v. beethoven', 'ludwig v beethoven'],
  },
  {
    canonicalName: 'Johann Sebastian Bach',
    key: 'bach',
    aliases: ['johann sebastian bach', 'j.s. bach', 'j. s. bach', 'bach', 'j s bach'],
  },
  {
    canonicalName: 'Wolfgang Amadeus Mozart',
    key: 'mozart',
    aliases: ['wolfgang amadeus mozart', 'w.a. mozart', 'w. a. mozart', 'mozart'],
  },
  {
    canonicalName: 'Gustav Mahler',
    key: 'mahler',
    aliases: ['gustav mahler', 'mahler', 'g. mahler'],
  },
  {
    canonicalName: 'Miles Davis',
    key: 'miles-davis',
    aliases: ['miles davis', 'miles davis quintet', 'miles davis sextet'],
  },
  {
    canonicalName: 'Pink Floyd',
    key: 'pink-floyd',
    aliases: ['pink floyd', 'roger waters', 'david gilmour', 'richard wright', 'nick mason'],
  },
  {
    canonicalName: 'Johnson',
    key: 'johnson-master',
    aliases: ['johnson', 'johnson master'],
  },
  {
    canonicalName: 'Raveendran',
    key: 'raveendran',
    aliases: ['raveendran', 'raveendran master'],
  },
]

/**
 * Normalizes and canonicalizes primary performer & vocal ensemble authorities.
 */
export interface ArtistAuthority {
  canonicalName: string
  key: string
  aliases: string[]
}

export const KNOWN_ARTISTS: ArtistAuthority[] = [
  {
    canonicalName: 'S. P. Balasubrahmanyam',
    key: 'spb',
    aliases: [
      's. p. balasubrahmanyam',
      's.p. balasubrahmanyam',
      's.p.balasubrahmanyam',
      'sp balasubrahmanyam',
      'spb',
      's.p.b',
      's. p. b.',
      's.p.b.',
      'balasubrahmanyam',
      's. p. bala',
      'sp bala',
    ],
  },
  {
    canonicalName: 'S. Janaki',
    key: 's-janaki',
    aliases: ['s. janaki', 's.janaki', 's janaki', 'janaki', 's. janaki amma'],
  },
  {
    canonicalName: 'K. S. Chithra',
    key: 'ks-chithra',
    aliases: ['k. s. chithra', 'k.s. chithra', 'k.s.chithra', 'ks chithra', 'chithra', 'k.s. chitra', 'chitra'],
  },
  {
    canonicalName: 'K. J. Yesudas',
    key: 'kj-yesudas',
    aliases: ['k. j. yesudas', 'k.j. yesudas', 'k.j.yesudas', 'kj yesudas', 'yesudas', 'k j yesudas'],
  },
  {
    canonicalName: 'Hariharan',
    key: 'hariharan',
    aliases: ['hariharan', 'hari haran'],
  },
  {
    canonicalName: 'Mano',
    key: 'mano',
    aliases: ['mano'],
  },
  {
    canonicalName: 'Unni Menon',
    key: 'unni-menon',
    aliases: ['unni menon', 'unnimenon'],
  },
  {
    canonicalName: 'Sujatha Mohan',
    key: 'sujatha',
    aliases: ['sujatha', 'sujatha mohan', 'sujatha m.'],
  },
  {
    canonicalName: 'Shankar Mahadevan',
    key: 'shankar-mahadevan',
    aliases: ['shankar mahadevan', 'shankar'],
  },
  {
    canonicalName: 'Lata Mangeshkar',
    key: 'lata-mangeshkar',
    aliases: ['lata mangeshkar', 'lata', 'lata mangeshkar ji'],
  },
  {
    canonicalName: 'Asha Bhosle',
    key: 'asha-bhosle',
    aliases: ['asha bhosle', 'asha', 'asha bhonsle'],
  },
  {
    canonicalName: 'Kishore Kumar',
    key: 'kishore-kumar',
    aliases: ['kishore kumar', 'kishore', 'kishore da'],
  },
  {
    canonicalName: 'Mohammed Rafi',
    key: 'mohammed-rafi',
    aliases: ['mohammed rafi', 'mohd rafi', 'mohd. rafi', 'mohammad rafi', 'rafi'],
  },
  {
    canonicalName: 'Udit Narayan',
    key: 'udit-narayan',
    aliases: ['udit narayan', 'udit narayan jha', 'udit'],
  },
  {
    canonicalName: 'Alka Yagnik',
    key: 'alka-yagnik',
    aliases: ['alka yagnik', 'alka'],
  },
  {
    canonicalName: 'Sonu Nigam',
    key: 'sonu-nigam',
    aliases: ['sonu nigam', 'sonu nigam hits'],
  },
  {
    canonicalName: 'Shreya Ghoshal',
    key: 'shreya-ghoshal',
    aliases: ['shreya ghoshal', 'shreya ghosal', 'shreya'],
  },
  {
    canonicalName: 'Ilaiyaraaja',
    key: 'ilaiyaraaja',
    aliases: [
      'ilaiyaraaja',
      'ilayaraja',
      'illayaraja',
      'illaiyaraaja',
      'ilaiyaraja',
      'isaignani ilaiyaraaja',
      'raaja',
    ],
  },
  {
    canonicalName: 'A. R. Rahman',
    key: 'ar-rahman',
    aliases: ['a. r. rahman', 'a.r. rahman', 'ar rahman', 'allah rakha rahman'],
  },
  {
    canonicalName: 'Pink Floyd',
    key: 'pink-floyd',
    aliases: ['pink floyd'],
  },
  {
    canonicalName: 'Miles Davis',
    key: 'miles-davis',
    aliases: ['miles davis'],
  },
]

/**
 * Returns canonical authority for a given composer string if matched, or cleanly formats raw name.
 * Strictly checks against invalid placeholders or album titles.
 */
export function canonicalizeComposer(rawName: string): { canonicalName: string; key: string } {
  const cleaned = stripRipNoiseAndTags(rawName || '')
  const trimmed = cleaned.trim()
  if (!trimmed || /^(unknown|unknown\s*artist|unknown\s*composer|various|various\s*artists)$/i.test(trimmed)) {
    return { canonicalName: 'Unknown Composer', key: 'unknown' }
  }

  // Precedence 1: Check user-remembered normalization rules
  const ruleCanonical = normalizationDelegate?.getCanonicalComposer?.(trimmed)
  if (ruleCanonical) {
    const key = ruleCanonical.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    return { canonicalName: ruleCanonical, key }
  }

  const norm = trimmed.toLowerCase().replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()

  for (const comp of KNOWN_COMPOSERS) {
    if (
      comp.aliases.some((alias) => {
        const normAlias = alias.replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
        return norm === normAlias || norm.includes(normAlias) || normAlias.includes(norm)
      })
    ) {
      return { canonicalName: comp.canonicalName, key: comp.key }
    }
  }

  // Check if raw name matches an artist authority
  for (const art of KNOWN_ARTISTS) {
    if (
      art.aliases.some((alias) => {
        const normAlias = alias.replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
        return norm === normAlias || norm.includes(normAlias)
      })
    ) {
      return { canonicalName: art.canonicalName, key: art.key }
    }
  }

  // Fallback for non-catalogued composer
  const key = norm.replace(/[^a-z0-9]+/g, '-')
  return { canonicalName: trimmed, key }
}

/**
 * Normalizes and clusters raw genre tags into canonical taxonomy categories.
 */
export function canonicalizeGenre(rawTag: string): string {
  const clean = (rawTag || '').trim()
  if (!clean || clean === 'Library Import' || /^(audio|music|flac|wav|mp3)$/i.test(clean)) {
    return 'Unclassified'
  }

  // Precedence 1: Check user-remembered normalization rules
  const ruleCanonical = normalizationDelegate?.getCanonicalGenre?.(clean)
  if (ruleCanonical) {
    return ruleCanonical
  }

  const norm = clean.toLowerCase()

  if (norm.includes('tamil') || norm.includes('kollywood')) {
    if (norm.includes('folk') || norm.includes('village')) return 'Tamil Folk & Rural'
    if (norm.includes('classical') || norm.includes('carnatic')) return 'Carnatic Classical'
    if (norm.includes('devotional') || norm.includes('bakthi')) return 'Tamil Devotional'
    return 'Tamil Film Music & Soundtrack'
  }

  if (norm.includes('hindi') || norm.includes('bollywood')) {
    if (norm.includes('ghazal') || norm.includes('qawwali') || norm.includes('sufi')) return 'Hindustani / Ghazal & Qawwali'
    if (norm.includes('classical') || norm.includes('hindustani')) return 'Hindustani Classical'
    return 'Hindi Film Music & Soundtrack'
  }

  if (norm.includes('malayalam') || norm.includes('mollywood')) return 'Malayalam Film Music & Soundtrack'
  if (norm.includes('telugu') || norm.includes('tollywood')) return 'Telugu Film Music & Soundtrack'
  if (norm.includes('kannada') || norm.includes('sandalwood')) return 'Kannada Film Music & Soundtrack'

  if (norm.includes('soundtrack') || norm.includes('score') || norm.includes('ost') || norm.includes('film music') || norm.includes('theme')) {
    return 'Film Score & Soundtrack'
  }

  if (
    norm.includes('classical') ||
    norm.includes('orchestr') ||
    norm.includes('symphon') ||
    norm.includes('concerto') ||
    norm.includes('baroque') ||
    norm.includes('opera') ||
    norm.includes('sonata')
  ) {
    return 'Western Classical'
  }

  if (norm.includes('jazz') || norm.includes('fusion') || norm.includes('bebop') || norm.includes('modal')) {
    return 'Jazz & Fusion'
  }

  if (norm.includes('rock') || norm.includes('progressive') || norm.includes('psychedelic')) {
    return 'Progressive & Classic Rock'
  }

  if (norm.includes('pop') || norm.includes('dance') || norm.includes('electronic')) {
    return 'Pop & Electronic'
  }

  // Capitalize neatly
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

export interface SplitArtistCredit {
  name: string
  role: string
  joinPhrase?: string
}

/**
 * Deterministically splits multi-artist credit strings into canonical entities
 * while strictly safeguarding compound groups, duos, and bands.
 */
export function splitMultiArtistCredits(
  rawCredit: string,
  defaultRole: string = 'Performer'
): SplitArtistCredit[] {
  if (!rawCredit || !rawCredit.trim()) return []

  const cleanRaw = stripRipNoiseAndTags(rawCredit).trim()
  if (!cleanRaw) return []

  // Check if entire string is a compound exception (e.g. "Shankar - Ehsaan - Loy" or "Salim-Sulaiman")
  const wholeCompound = isCompoundArtistException(cleanRaw)
  if (wholeCompound) {
    return [{ name: wholeCompound, role: defaultRole }]
  }

  // Handle "feat." / "ft." / "featuring" clauses first
  const featRegex = /\s+(?:feat\.?|ft\.?|featuring)\s+/i
  let mainPart = cleanRaw
  let featPart = ''
  if (featRegex.test(cleanRaw)) {
    const parts = cleanRaw.split(featRegex)
    mainPart = parts[0].trim()
    featPart = parts.slice(1).join(' ').trim()
  }

  // Tokenize main part while protecting compound tokens
  const results: SplitArtistCredit[] = []
  const seen = new Set<string>()

  const processTokens = (text: string, role: string, isFeat: boolean = false) => {
    // Check if the current chunk as a whole is a compound
    const chunkCompound = isCompoundArtistException(text)
    if (chunkCompound) {
      if (!seen.has(chunkCompound.toLowerCase())) {
        seen.add(chunkCompound.toLowerCase())
        results.push({ name: chunkCompound, role, joinPhrase: isFeat ? 'feat.' : undefined })
      }
      return
    }

    // Delimiters that can safely split: semicolon, slash, backslash, pipe
    // For commas and conjunctions, require surrounding word boundaries
    // e.g. " and ", " with ", " & ", " x ", " + "
    // and commas with space ", "
    const delimiterRegex = /;\s*|\s+[/\\|]\s+|\s+&\s+|\s+and\s+|\s+with\s+|\s+x\s+|\s+\+\s+|,\s*/i
    const rawTokens = text.split(delimiterRegex)

    for (let i = 0; i < rawTokens.length; i++) {
      const token = rawTokens[i].trim()
      if (!token) continue

      // Verify if token is a compound artist
      const tokenCompound = isCompoundArtistException(token)
      const canonicalName = tokenCompound || token

      const key = canonicalName.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        results.push({
          name: canonicalName,
          role,
          joinPhrase: isFeat && results.length > 0 ? 'feat.' : undefined,
        })
      }
    }
  }

  processTokens(mainPart, defaultRole, false)
  if (featPart) {
    processTokens(featPart, 'Featured Performer', true)
  }

  return results
}

/**
 * Generates an ultra-crisp Brushed Titanium monogram avatar SVG data URL
 * as an authentic Apple HIG fallback for artists without photographic portraits.
 */
export function generateMonogramAvatar(name: string): string {
  const clean = (name || '').trim().toUpperCase()
  const parts = clean.split(/\s+/).filter(Boolean)
  let initials = 'A'
  if (parts.length >= 2) {
    initials = `${parts[0][0]}${parts[parts.length - 1][0]}`
  } else if (parts.length === 1 && parts[0].length >= 2) {
    initials = parts[0].substring(0, 2)
  } else if (parts.length === 1 && parts[0].length === 1) {
    initials = parts[0]
  }

  // Create an SVG with subtle radial gradient and specular edge ring
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
    <defs>
      <radialGradient id="titanium" cx="40%" cy="35%" r="70%">
        <stop offset="0%" stop-color="#22252A"/>
        <stop offset="60%" stop-color="#14161A"/>
        <stop offset="100%" stop-color="#0A0B0D"/>
      </radialGradient>
      <linearGradient id="specular" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.18"/>
        <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.04"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.3"/>
      </linearGradient>
    </defs>
    <circle cx="128" cy="128" r="126" fill="url(#titanium)"/>
    <circle cx="128" cy="128" r="125" fill="none" stroke="url(#specular)" stroke-width="2"/>
    <text x="128" y="142" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" font-size="76" font-weight="600" fill="#E5E5EA" text-anchor="middle" letter-spacing="2" opacity="0.92">${initials}</text>
  </svg>`

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Splits multi-performer string (e.g. "S. P. B., S. Janaki", "A. R. Rahman & Hariharan") into canonical individual names.
 */
export function splitAndCanonicalizePerformers(rawArtistString: string): string[] {
  if (!rawArtistString) return []
  const cleaned = stripRipNoiseAndTags(rawArtistString)
  if (!cleaned || /^(unknown|unknown\s*artist|various|various\s*artists)$/i.test(cleaned)) {
    return []
  }

  if (isCompoundArtistException(cleaned)) {
    return [isCompoundArtistException(cleaned)!]
  }

  const rawParts = splitMultiArtistCredits(cleaned).map((c) => c.name)

  const canonicalResults: string[] = []

  for (const part of rawParts) {
    const norm = part.toLowerCase().replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!norm || norm.length < 2) continue

    // Precedence 1: Check user-remembered normalization rules
    let matchedCanonical: string | null = normalizationDelegate?.getCanonicalArtist?.(part) || null

    if (!matchedCanonical) {
      for (const art of KNOWN_ARTISTS) {
        if (
          art.aliases.some((alias) => {
            const normAlias = alias.replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
            return norm === normAlias || norm.includes(normAlias)
          })
        ) {
          matchedCanonical = art.canonicalName
          break
        }
      }
    }

    if (!matchedCanonical) {
      for (const comp of KNOWN_COMPOSERS) {
        if (
          comp.aliases.some((alias) => {
            const normAlias = alias.replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
            return norm === normAlias || norm.includes(normAlias)
          })
        ) {
          matchedCanonical = comp.canonicalName
          break
        }
      }
    }

    const finalName = matchedCanonical || part
    const ruleNormalized = normalizationDelegate?.applyToText?.(finalName, 'artist') || finalName
    canonicalResults.push(ruleNormalized)
  }


  // Deduplicate within the single track
  return Array.from(new Set(canonicalResults))
}

/**
 * Matches a track against a composer key or canonical name.
 */
export function matchesComposer(track: Track, composerKeyOrName: string): boolean {
  if (!composerKeyOrName) return true
  const targetKey = composerKeyOrName.toLowerCase().replace(/[\.\-_,\s]+/g, '')

  // 1. Check direct track.composerName
  if (track.composerName) {
    const { key, canonicalName } = canonicalizeComposer(track.composerName)
    const normKey = key.toLowerCase().replace(/[\.\-_,\s]+/g, '')
    const normCanonical = canonicalName.toLowerCase().replace(/[\.\-_,\s]+/g, '')
    const normRaw = track.composerName.toLowerCase().replace(/[\.\-_,\s]+/g, '')
    if (
      normKey.includes(targetKey) ||
      targetKey.includes(normKey) ||
      normCanonical.includes(targetKey) ||
      normRaw.includes(targetKey)
    ) {
      return true
    }
  }

  // 2. Check track.credits
  if (track.credits && track.credits.length > 0) {
    for (const c of track.credits) {
      if (c.role === 'composer' || !track.composerName) {
        const { key, canonicalName } = canonicalizeComposer(c.personName)
        const normKey = key.toLowerCase().replace(/[\.\-_,\s]+/g, '')
        const normCanonical = canonicalName.toLowerCase().replace(/[\.\-_,\s]+/g, '')
        const normRaw = c.personName.toLowerCase().replace(/[\.\-_,\s]+/g, '')
        if (
          normKey.includes(targetKey) ||
          targetKey.includes(normKey) ||
          normCanonical.includes(targetKey) ||
          normRaw.includes(targetKey)
        ) {
          return true
        }
      }
    }
  }

  // 3. Check artistCredit or folder/file if composer was put in artist credit
  const normArtist = (track.artistCredit || '').toLowerCase().replace(/[\.\-_,\s]+/g, '')
  for (const comp of KNOWN_COMPOSERS) {
    if (comp.key.replace(/[\.\-_,\s]+/g, '') === targetKey) {
      for (const alias of comp.aliases) {
        const normAlias = alias.replace(/[\.\-_,\s]+/g, '')
        if (normArtist.includes(normAlias)) return true
      }
    }
  }

  return false
}

/**
 * Infers language for a track or raw metadata based on:
 * 1. Explicit ID3/Vorbis/Sidecar language tags
 * 2. Unicode script block inspection (Tamil, Devanagari, Malayalam, Telugu, Kannada)
 * 3. Text heuristics in title, artist, album, path, and genre
 * 4. Classical / Instrumental / Western defaults
 */
export function detectLanguage(meta: {
  language?: string
  common?: any
  title?: string
  artistCredit?: string
  composerName?: string
  albumTitle?: string
  genreTags?: string[]
  folderName?: string
  filePath?: string
}): string {
  const common = meta.common || {}
  const rawTag = (
    meta.language ||
    common.language ||
    (common as any).LANGUAGE ||
    (common as any).TLAN ||
    ''
  )
    .toString()
    .toLowerCase()
    .trim()

  if (rawTag) {
    if (rawTag.includes('tam') || rawTag.includes('ta') || rawTag.includes('தமிழ்')) return 'Tamil'
    if (rawTag.includes('hin') || rawTag.includes('hi') || rawTag.includes('हिन्दी') || rawTag.includes('hindi')) return 'Hindi'
    if (rawTag.includes('mal') || rawTag.includes('ml') || rawTag.includes('മലയാളം') || rawTag.includes('malayalam')) return 'Malayalam'
    if (rawTag.includes('eng') || rawTag.includes('en') || rawTag.includes('english')) return 'English'
    if (rawTag.includes('tel') || rawTag.includes('te') || rawTag.includes('తెలుగు')) return 'Telugu'
    if (rawTag.includes('kan') || rawTag.includes('kn') || rawTag.includes('ಕನ್ನಡ')) return 'Kannada'
  }

  const allText = [
    meta.title,
    meta.artistCredit,
    meta.composerName,
    meta.albumTitle,
    meta.folderName,
    meta.filePath,
    ...(meta.genreTags || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  // 1. Directory Path Hierarchy Detection (e.g. \Master\Hindi\... or \Master\Tamil\...)
  if (meta.filePath) {
    const normPath = meta.filePath.replace(/\\/g, '/')
    if (/\/(hindi|bollywood)\//i.test(normPath)) return 'Hindi'
    if (/\/(tamil|kollywood)\//i.test(normPath)) return 'Tamil'
    if (/\/(telugu|tollywood)\//i.test(normPath)) return 'Telugu'
    if (/\/(malayalam|mollywood)\//i.test(normPath)) return 'Malayalam'
    if (/\/(kannada|sandalwood)\//i.test(normPath)) return 'Kannada'
  }

  // 2. Unicode Script Range Checks
  if (/[\u0B80-\u0BFF]/.test(allText)) return 'Tamil'
  if (/[\u0900-\u097F]/.test(allText)) return 'Hindi'
  if (/[\u0D00-\u0D7F]/.test(allText)) return 'Malayalam'
  if (/[\u0C00-\u0C7F]/.test(allText)) return 'Telugu'
  if (/[\u0C80-\u0CFF]/.test(allText)) return 'Kannada'

  // 2. Keyword & Repertoire heuristics
  if (
    /\b(tamil|kollywood|amman|ilaiyaraaja|ilayaraja|illayaraja|m\.?\s*s\.?\s*v|viswanathan|vaali|vairamuthu|spb|s\.?\s*p\.?\s*balasubrahmanyam|chithra|janaki|anirudh|yuvan|harris jayaraj|deva|thiruvizha|nizhalgal|kizhakale|nayagan|thalapathi|mouna ragam|oriental)\b/i.test(
      allText
    )
  ) {
    return 'Tamil'
  }

  if (
    /\b(hindi|bollywood|dil se|qawwali|lata|kishore|rafi|mohammed rafi|burman|rd burman|r\.?\s*d\.?\s*burman|asha|mukesh|kumar sanu|udit narayan|alka yagnik|sonu nigam)\b/i.test(
      allText
    )
  ) {
    return 'Hindi'
  }

  if (
    /\b(malayalam|mollywood|yesudas|k\.?\s*j\.?\s*yesudas|raveendran|johnson|chemmeen|manichitrathazhu|chithra malayalam|mg sreekumar|sujatha)\b/i.test(
      allText
    )
  ) {
    return 'Malayalam'
  }

  if (/\b(telugu|tollywood|ghantasala|keeravani|m\.?\s*m\.?\s*keeravani|veturi)\b/i.test(allText)) {
    return 'Telugu'
  }

  if (/\b(kannada|sandalwood|rajkumar|dr\.?\s*rajkumar|hamsalekha)\b/i.test(allText)) {
    return 'Kannada'
  }

  // Western / English Repertoire
  if (
    /\b(pink floyd|miles davis|rock|pop|jazz|progressive rock|psychedelic|harvest|columbia|harvest uk|abbey road|legacy)\b/i.test(
      allText
    )
  ) {
    return 'English'
  }

  // Classical Repertoire: if Western classical without Tamil/Hindi cues, map to English (universal)
  if (
    /\b(classical|beethoven|bach|mahler|mozart|symphonie|symphony|concerto|sonata|baroque|cello|kleiber|vpo|wiener philharmoniker)\b/i.test(
      allText
    )
  ) {
    return 'English'
  }

  return 'English'
}

/**
 * Checks if a release year falls into the requested era bucket:
 * - 'earlier-1970': <= 1970
 * - '1971-1980': 1971 to 1980
 * - '1981-1990': 1981 to 1990
 * - '1991-2000': 1991 to 2000
 * - '2001-2010': 2001 to 2010
 * - '2010-present': >= 2010
 * - 'unknown': no valid year
 */
export function matchesEra(year: number | undefined, eraBucket: string): boolean {
  if (!eraBucket) return true
  if (!year || year <= 0) return eraBucket === 'unknown'

  switch (eraBucket) {
    case 'earlier-1970':
      return year <= 1970
    case '1971-1980':
      return year >= 1971 && year <= 1980
    case '1981-1990':
      return year >= 1981 && year <= 1990
    case '1991-2000':
      return year >= 1991 && year <= 2000
    case '2001-2010':
      return year >= 2001 && year <= 2010
    case '2010-present':
      return year >= 2010
    case 'unknown':
      return !year || year <= 0
    default:
      return true
  }
}

/**
 * Checks if a track matches the resolution & format selection:
 * 'WAV', 'MP3', 'FLAC', 'DSD256', 'DSD512', 'DSD128', 'DSD64', 'DSD', 'ALAC'
 */
export function matchesFormat(track: Track, formatSelection: string): boolean {
  if (!formatSelection) return true
  const sel = formatSelection.toUpperCase().trim()
  const fmt = (track.format || '').toUpperCase()
  const sRate = (track.sampleRateStr || '').toUpperCase()
  const path = (track.filePath || '').toUpperCase()
  const rawRate = (track as any).sampleRate || 0

  const isDsd =
    fmt === 'DSD' ||
    fmt === 'DSF' ||
    fmt === 'DFF' ||
    fmt.includes('DSD') ||
    sRate.includes('DSD') ||
    path.endsWith('.DSF') ||
    path.endsWith('.DFF') ||
    rawRate > 1000000 ||
    sRate.includes('11289') ||
    sRate.includes('5644') ||
    sRate.includes('2822') ||
    sRate.includes('22579')

  if (sel === 'DSD' || sel === 'NATIVE DSD' || sel === 'NATIVE_DSD') {
    return isDsd
  }

  if (sel === 'DSD1024') {
    return isDsd && (rawRate >= 36000000 || sRate.includes('1024') || sRate.includes('45.1') || sRate.includes('45.2') || sRate.includes('45158'))
  }
  if (sel === 'DSD512') {
    return isDsd && ((rawRate >= 18000000 && rawRate < 36000000) || sRate.includes('512') || sRate.includes('22.5') || sRate.includes('22.6') || sRate.includes('22579'))
  }
  if (sel === 'DSD256') {
    return isDsd && ((rawRate >= 9000000 && rawRate < 18000000) || sRate.includes('256') || sRate.includes('11.2') || sRate.includes('11.3') || sRate.includes('11289') || sRate.includes('12288'))
  }
  if (sel === 'DSD128' || sel === 'DSD128+') {
    if (sel === 'DSD128+') {
      return isDsd && (rawRate >= 4500000 || (!sRate.includes('DSD64') && !sRate.includes('2.8') && !sRate.includes('2822')))
    }
    return isDsd && ((rawRate >= 4500000 && rawRate < 9000000) || sRate.includes('128') || sRate.includes('5.6') || sRate.includes('5644') || sRate.includes('6144'))
  }
  if (sel === 'DSD64') {
    return isDsd && ((rawRate >= 2000000 && rawRate < 4500000) || sRate.includes('64') || sRate.includes('2.8') || sRate.includes('2822') || sRate.includes('3072'))
  }

  if (sel === 'WAV') return fmt === 'WAV' || path.endsWith('.WAV')
  if (sel === 'MP3') return fmt === 'MP3' || path.endsWith('.MP3')
  if (sel === 'FLAC') return fmt === 'FLAC' || path.endsWith('.FLAC')
  if (sel === 'ALAC') return fmt === 'ALAC' || path.endsWith('.M4A') || path.endsWith('.ALAC')
  if (sel === 'AIFF') return fmt === 'AIFF' || path.endsWith('.AIF') || path.endsWith('.AIFF')

  return fmt === sel
}

/**
 * Resolves high-resolution authentic album art / backdrop artwork based on album title, composer, or genre.
 */
export function getCuratedAlbumArtwork(albumTitle?: string, artistOrComposer?: string): string {
  const normTitle = (albumTitle || '').toLowerCase()
  const normCredit = (artistOrComposer || '').toLowerCase()

  if (normTitle.includes('shamitabh') || normTitle.includes('shamitaab')) {
    // Authentic Shamitabh (Original Motion Picture Soundtrack) by Ilaiyaraaja
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/83/f9/fc/83f9fc5d-830c-d26f-8d45-a0990a7c2023/196871083171.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('cheeni kum') || normTitle.includes('cheeni')) {
    // Authentic Cheeni Kum (Original Motion Picture Soundtrack) by Ilaiyaraaja
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/c5/cc/ec/c5ccec9c-fc0d-8e08-2096-4e5d9d26c1e6/828970001021.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('dil se') || normTitle.includes('dilse')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/8e/f8/85/8ef88544-a6c7-018b-0a75-dc3b6b024fa0/cover.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('beethoven') || normTitle.includes('symphonie no. 5') || normTitle.includes('symphony no. 5')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/b7/b0/a5/b7b0a5d5-e487-4dcb-f0b5-04d16c78f693/22UMGIM89320.rgb.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('kind of blue') || (normCredit.includes('miles davis') && normTitle.includes('kind of blue'))) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music/7f/9f/d6/mzi.vtnaewef.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('dark side of the moon') || (normCredit.includes('pink floyd') && normTitle.includes('dark side'))) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/3e/17/ec/3e17ec6d-f980-c64f-19e0-a6fd8bbf0c10/886445635850.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('cello') || normTitle.includes('bach') || normCredit.includes('rostropovich')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music3/v4/f4/24/1a/f4241a1a-733e-2c58-43a7-8dcbf11fc8d9/724355536358.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('mahler')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/64/74/d5/6474d5b3-39ea-4f55-2040-b0342d8806da/196871918558.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('amman kovil') || normTitle.includes('amman koil')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/bb/94/bc/bb94bc97-e818-f2e3-2ee8-dc1a8f90ff8a/8901858022889.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('slumdog')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/ef/11/46/ef1146cf-e28e-b43b-59f6-06cb7e7eec77/8902894629058_cover.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('delhi-6') || normTitle.includes('delhi 6')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e2/fe/21/e2fe21b6-50e6-7b4b-285a-d40394baba4e/8902894628990_cover.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('ghajini')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/d6/ef/40/d6ef4087-eef2-53aa-3ee5-ca3e3e2a6978/816481010137.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('jaane tu') || normTitle.includes('jaane tu... ya jaane na')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/69/9d/1e/699d1e5f-9fb9-a4a9-3fe0-6cae29b7dd49/8902894626033_cover.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('rock on')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music/3d/02/74/mzi.rdsmizhb.jpg/1200x1200bb.jpg'
  }
  if (normTitle === 'blue' || (normTitle.includes('blue') && (normCredit.includes('rahman') || normCredit.includes('narayan')))) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/45/31/27/45312722-6b6f-deaf-8d67-85f8a3e4a198/8902894684682_cover.jpg/1200x1200bb.jpg'
  }
  if (normTitle.includes('world of music')) {
    return 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/8e/f8/85/8ef88544-a6c7-018b-0a75-dc3b6b024fa0/cover.jpg/1200x1200bb.jpg'
  }
  return ''
}

export interface ComboDisambiguationResult {
  resolvedTitle: string
  physicalComboTitle?: string
  isCombo: boolean
}

function stripRepeatedLetters(str: string): string {
  return str.replace(/([a-z])\1+/g, '$1')
}

/**
 * Universal Combo CD & Multi-Album Disambiguation Engine.
 * 
 * When a CD contains multiple soundtracks (e.g., "Chinna Thambi/Dharma Dorai/Captian Prabhakaran")
 * and the folder name or path positively corroborates one of the soundtrack segments
 * (e.g., "Dharma Dorai CD RIP"), this resolves the individual soundtrack album title.
 */
export function disambiguateComboTitle(rawTitle: string, folderNameOrPath: string): ComboDisambiguationResult {
  if (!rawTitle) return { resolvedTitle: rawTitle, isCombo: false }

  const delims = ['/', ';', ' - ']
  const matchedDelim = delims.find((d) => rawTitle.includes(d))
  if (!matchedDelim) {
    return { resolvedTitle: rawTitle, isCombo: false }
  }

  const rawSegments = rawTitle
    .split(matchedDelim)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && !/^(cd|disc)\s*\d+$/i.test(s))
  if (rawSegments.length <= 1) {
    return { resolvedTitle: rawTitle, isCombo: false }
  }

  // Extract base folder name from path if full path is provided
  const baseFolder = folderNameOrPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folderNameOrPath
  const cleanFolder = stripRipNoiseAndTags(baseFolder).toLowerCase().trim()
  if (!cleanFolder) {
    return { resolvedTitle: rawTitle, isCombo: false }
  }

  // Check which segments match the folder name
  const matchingSegs: string[] = []
  for (const seg of rawSegments) {
    const cleanSeg = stripRipNoiseAndTags(seg).toLowerCase().trim()
    if (!cleanSeg) continue

    // Exact or reduced-double match (e.g. 'anand' vs 'aanand')
    if (cleanSeg === cleanFolder || stripRepeatedLetters(cleanSeg) === stripRepeatedLetters(cleanFolder)) {
      matchingSegs.push(seg)
      continue
    }

    // Token overlap check (handles "Captain Prabhakaran" vs "Captian Prabhakaran" or "Nanum Oru Thozillali" vs "Naanum Oru Thozhilaali")
    const st = cleanSeg.split(/\s+/).map(stripRepeatedLetters).filter((t) => t.length >= 2)
    const ft = cleanFolder.split(/\s+/).map(stripRepeatedLetters).filter((t) => t.length >= 2)
    if (st.length > 0 && ft.length > 0) {
      const matches = st.filter((s) =>
        ft.some(
          (f) =>
            f === s ||
            (s.length >= 4 && f.startsWith(s.slice(0, 4))) ||
            (f.length >= 4 && s.startsWith(f.slice(0, 4)))
        )
      ).length
      if (matches >= Math.min(st.length, ft.length) && matches >= 1) {
        matchingSegs.push(seg)
      }
    }
  }

  // Deduplicate matching segments by normalized name
  const uniqueMatches = Array.from(new Set(matchingSegs.map((m) => m.toLowerCase().trim())))

  // Guard: If the folder name contains tokens from multiple distinct segments (e.g. folder is "Face Off" or "Chinna Thambi & Dharma Dorai"),
  // then the folder represents the unified multi-title release, NOT a single split segment!
  const folderTokens = cleanFolder.split(/\s+/).map(stripRepeatedLetters).filter((t) => t.length >= 2)
  const segmentsInFolder = rawSegments.filter((seg) => {
    const cleanSeg = stripRipNoiseAndTags(seg).toLowerCase().trim()
    const st = cleanSeg.split(/\s+/).map(stripRepeatedLetters).filter((t) => t.length >= 2)
    return st.some((s) => folderTokens.some((f) => f === s || (s.length >= 4 && f.startsWith(s.slice(0, 4)))))
  })
  if (segmentsInFolder.length > 1) {
    return { resolvedTitle: rawTitle, isCombo: false }
  }

  // High confidence: exactly ONE distinct segment matched this folder
  if (uniqueMatches.length === 1) {
    const bestSeg = matchingSegs[0]
    return { resolvedTitle: bestSeg, physicalComboTitle: rawTitle, isCombo: true }
  }

  // If multiple distinct segments matched (e.g. unified disc folder like "Face Off" or "Chinna Thambi & Dharma Dorai"),
  // preserve the unified title.
  return { resolvedTitle: rawTitle, isCombo: false }
}
