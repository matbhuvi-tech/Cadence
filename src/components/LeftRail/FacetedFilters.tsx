import React, { useState, useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Calendar,
  Music,
  Languages,
  Disc3,
  RotateCcw,
  Search,
  Tag,
  Users,
  Volume2,
} from 'lucide-react'
import { Track, Release } from '../../core/types'
import {
  canonicalizeComposer,
  canonicalizeGenre,
  splitAndCanonicalizePerformers,
  matchesComposer,
  matchesEra,
  matchesFormat,
  detectLanguage,
  KNOWN_COMPOSERS,
} from '../../core/taxonomyUtils'
import { FacetSelections } from '../../core/types'
import { FEATURES } from '../../config/features'

export type { FacetSelections }

interface FacetedFiltersProps {
  facets: FacetSelections
  onFacetChange: (facets: FacetSelections) => void
  onReset: () => void
  tracks: Track[]
  releases: Release[]
}

export const FacetedFilters: React.FC<FacetedFiltersProps> = ({
  facets,
  onFacetChange,
  onReset,
  tracks = [],
  releases = [],
}) => {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    era: true,
    composer: true,
    language: true,
    format: true,
    genre: false,
    ensemble: false,
    mastering: false,
  })

  const [composerSearch, setComposerSearch] = useState('')
  const [showAllComposers, setShowAllComposers] = useState(false)

  const toggleSection = (section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const hasActiveFacets = Object.values(facets).some(Boolean)

  // ==========================================
  // 1. Dynamic Recording Era Options
  // ==========================================
  const eraOptions = useMemo(() => {
    const counts: Record<string, number> = {
      'earlier-1970': 0,
      '1971-1980': 0,
      '1981-1990': 0,
      '1991-2000': 0,
      '2001-2010': 0,
      '2010-present': 0,
      unknown: 0,
    }

    const relMap = new Map<string, Release>()
    releases.forEach((r) => relMap.set(r.id, r))

    tracks.forEach((t) => {
      const rel = relMap.get(t.releaseId)
      const y = rel?.releaseYear || rel?.originalYear
      if (!y || y <= 0) {
        counts.unknown++
      } else if (y <= 1970) {
        counts['earlier-1970']++
      } else if (y <= 1980) {
        counts['1971-1980']++
      } else if (y <= 1990) {
        counts['1981-1990']++
      } else if (y <= 2000) {
        counts['1991-2000']++
      } else if (y <= 2010) {
        counts['2001-2010']++
      } else {
        counts['2010-present']++
      }
    })

    const labels: Record<string, string> = {
      'earlier-1970': 'Earlier – 1970',
      '1971-1980': '1971 – 1980',
      '1981-1990': '1981 – 1990',
      '1991-2000': '1991 – 2000',
      '2001-2010': '2001 – 2010',
      '2010-present': '2010 – Present',
      unknown: 'Uncatalogued Year',
    }

    const order = [
      'earlier-1970',
      '1971-1980',
      '1981-1990',
      '1991-2000',
      '2001-2010',
      '2010-present',
      'unknown',
    ]

    return order
      .filter((key) => counts[key] > 0)
      .map((key) => ({
        label: labels[key] || key,
        value: key,
        count: counts[key],
      }))
  }, [tracks, releases])

  // ==========================================
  // 2. Dynamic Composer Authority Options
  // ==========================================
  const composerOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number; key: string }>()
    const relMap = new Map<string, Release>()
    releases.forEach((r) => relMap.set(r.id, r))

    tracks.forEach((t) => {
      const rel = relMap.get(t.releaseId)
      const albumTitle = (rel?.title || '').toLowerCase()
      const folderName = (t.folderName || rel?.folderName || '').toLowerCase()

      const candidates: string[] = []
      if (t.composerName) candidates.push(t.composerName)
      if (t.credits) {
        t.credits.forEach((c) => {
          if (c.role === 'composer') candidates.push(c.personName)
        })
      }

      // Safe fallback to artistCredit ONLY if it matches a catalogued composer authority and is NOT the album title
      if (candidates.length === 0 && t.artistCredit && t.artistCredit !== 'Unknown Artist') {
        const normArt = t.artistCredit.toLowerCase().trim()
        const isKnownComp = KNOWN_COMPOSERS.some((c) => c.aliases.some((al) => normArt.includes(al)))
        const isAlbumName = normArt === albumTitle || normArt === folderName
        if (isKnownComp && !isAlbumName) {
          candidates.push(t.artistCredit)
        }
      }

      const distinctKeysForTrack = new Set<string>()

      candidates.forEach((cand) => {
        const { canonicalName, key } = canonicalizeComposer(cand)
        if (key && key !== 'unknown' && !distinctKeysForTrack.has(key)) {
          distinctKeysForTrack.add(key)
          const curr = counts.get(key) || { label: canonicalName, key, count: 0 }
          curr.count++
          counts.set(key, curr)
        }
      })
    })

    return Array.from(counts.values()).sort((a, b) => b.count - a.count)
  }, [tracks, releases])

  const filteredComposers = useMemo(() => {
    let list = composerOptions
    if (composerSearch.trim()) {
      const q = composerSearch.toLowerCase()
      list = list.filter((c) => c.label.toLowerCase().includes(q))
    }
    if (!showAllComposers && !composerSearch.trim() && list.length > 6) {
      return list.slice(0, 6)
    }
    return list
  }, [composerOptions, composerSearch, showAllComposers])

  // ==========================================
  // 3. Dynamic Language Options
  // ==========================================
  const languageOptions = useMemo(() => {
    const counts: Record<string, number> = {}
    const relMap = new Map<string, Release>()
    releases.forEach((r) => relMap.set(r.id, r))

    tracks.forEach((t) => {
      const rel = relMap.get(t.releaseId)
      const lang =
        t.language ||
        detectLanguage({
          language: t.language,
          title: t.title,
          artistCredit: t.artistCredit,
          composerName: t.composerName,
          albumTitle: rel?.title,
          genreTags: rel?.genreTags,
          folderName: t.folderName || rel?.folderName,
          filePath: t.filePath,
        })

      if (lang) {
        counts[lang] = (counts[lang] || 0) + 1
      }
    })

    const priority = ['Tamil', 'Hindi', 'English', 'Malayalam']
    const allLangs = Object.keys(counts)

    const sortedLangs = allLangs.sort((a, b) => {
      const idxA = priority.indexOf(a)
      const idxB = priority.indexOf(b)
      if (idxA !== -1 && idxB !== -1) return idxA - idxB
      if (idxA !== -1) return -1
      if (idxB !== -1) return 1
      return b.localeCompare(a)
    })

    return sortedLangs.map((lang) => ({
      label: lang,
      value: lang,
      count: counts[lang] || 0,
    }))
  }, [tracks, releases])

  // ==========================================
  // 4. Dynamic Resolution & Format Options
  // ==========================================
  const formatOptions = useMemo(() => {
    const counts: Record<string, number> = {
      WAV: 0,
      MP3: 0,
      FLAC: 0,
      DSD256: 0,
      DSD512: 0,
      DSD128: 0,
      DSD64: 0,
      ALAC: 0,
    }

    tracks.forEach((t) => {
      const fmt = (t.format || '').toUpperCase()
      const sRate = (t.sampleRateStr || '').toUpperCase()

      if (fmt === 'WAV') counts.WAV++
      else if (fmt === 'MP3') counts.MP3++
      else if (fmt === 'FLAC') counts.FLAC++
      else if (fmt === 'ALAC') counts.ALAC++
      else if (fmt === 'DSD' || fmt === 'DSF' || fmt === 'DFF' || sRate.includes('DSD') || sRate.includes('11289')) {
        if (sRate.includes('DSD512') || sRate.includes('22.5') || sRate.includes('22.6') || sRate.includes('22579')) {
          counts.DSD512++
        } else if (sRate.includes('DSD256') || sRate.includes('11.2') || sRate.includes('11.3') || sRate.includes('11289')) {
          counts.DSD256++
        } else if (sRate.includes('DSD128') || sRate.includes('5.6') || sRate.includes('5644')) {
          counts.DSD128++
        } else if (sRate.includes('DSD64') || sRate.includes('2.8') || sRate.includes('2822')) {
          counts.DSD64++
        } else {
          counts.DSD256++
        }
      }
    })

    const labels: Record<string, string> = {
      WAV: 'WAV Linear PCM',
      MP3: 'MP3 Audio',
      FLAC: 'FLAC Lossless',
      DSD256: 'DSD256 (11.3MHz)',
      DSD512: 'DSD512 (22.6MHz)',
      DSD128: 'DSD128 (5.6MHz)',
      DSD64: 'DSD64 (2.8MHz)',
      ALAC: 'ALAC Apple Lossless',
    }

    const priorityOrder = ['WAV', 'MP3', 'FLAC', 'DSD256', 'DSD512', 'DSD128', 'DSD64', 'ALAC']

    return priorityOrder
      .filter((key) => counts[key] > 0)
      .map((key) => ({
        label: labels[key] || key,
        value: key,
        count: counts[key],
      }))
  }, [tracks])

  // ==========================================
  // 5. Dynamic Genre & Repertoire Options
  // ==========================================
  const genreOptions = useMemo(() => {
    const counts = new Map<string, number>()
    const relMap = new Map<string, Release>()
    releases.forEach((r) => relMap.set(r.id, r))

    tracks.forEach((t) => {
      const rel = relMap.get(t.releaseId)
      const tags = Array.isArray(rel?.genreTags) ? rel.genreTags : []
      const distinctPerTrack = new Set<string>()

      tags.forEach((tag) => {
        const canonical = canonicalizeGenre(tag)
        if (canonical && canonical !== 'Unclassified' && !distinctPerTrack.has(canonical)) {
          distinctPerTrack.add(canonical)
          counts.set(canonical, (counts.get(canonical) || 0) + 1)
        }
      })
    })

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([genre, count]) => ({
        label: genre,
        value: genre,
        count,
      }))
  }, [tracks, releases])

  // ==========================================
  // 6. Dynamic Ensemble & Artist Credit Options
  // ==========================================
  const ensembleOptions = useMemo(() => {
    const counts = new Map<string, number>()
    tracks.forEach((t) => {
      const distinctPerTrack = new Set<string>()
      const performers = splitAndCanonicalizePerformers(t.artistCredit || '')

      performers.forEach((perf) => {
        if (perf && !distinctPerTrack.has(perf)) {
          distinctPerTrack.add(perf)
          counts.set(perf, (counts.get(perf) || 0) + 1)
        }
      })
    })

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([ensemble, count]) => ({
        label: ensemble,
        value: ensemble,
        count,
      }))
  }, [tracks])

  // ==========================================
  // 7. Dynamic Mastering & Dynamic Range Options
  // ==========================================
  const masteringOptions = useMemo(() => {
    const dr14Count = FEATURES.DYNAMIC_RANGE ? tracks.filter((t) => t.drScore != null && t.drScore >= 14).length : 0
    const dr10Count = FEATURES.DYNAMIC_RANGE ? tracks.filter((t) => t.drScore != null && t.drScore >= 10 && t.drScore <= 13).length : 0
    const drLowCount = FEATURES.DYNAMIC_RANGE ? tracks.filter((t) => t.drScore != null && t.drScore > 0 && t.drScore < 10).length : 0
    const highRes24Count = tracks.filter(
      (t) =>
        t.sampleRateStr?.includes('24/') ||
        t.sampleRateStr?.includes('32/') ||
        t.format === 'DSD' ||
        (t.format as string) === 'DSF' ||
        (t.format as string) === 'DFF' ||
        Boolean(t.isHighRes)
    ).length

    const list = [
      ...(FEATURES.DYNAMIC_RANGE ? [
        { label: 'Audiophile Master (DR14+)', value: 'audiophile_dr14', count: dr14Count },
        { label: 'Wide Dynamic Range (DR10–13)', value: 'high_dr10_13', count: dr10Count },
        { label: 'Compressed Mastering (DR < 10)', value: 'compressed_dr_low', count: drLowCount },
      ] : []),
      { label: '24-bit / DSD Studio Pressing', value: 'high_res_24bit', count: highRes24Count },
    ]

    return list.filter((item) => item.count > 0)
  }, [tracks])

  return (
    <div className="bento-card p-3.5 flex flex-col gap-3 bg-[#12151D]/90 border-white/[0.07]">
      {/* Header */}
      <div className="flex items-center justify-between pb-1 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-[#00F5FF]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Faceted Filters
          </span>
        </div>
        <button
          data-tutorial-id="filter-reset-btn"
          onClick={onReset}
          disabled={!hasActiveFacets}
          className={`flex items-center gap-1 text-[11px] text-[#00F5FF] hover:underline transition-opacity ${
            !hasActiveFacets ? 'opacity-30 cursor-not-allowed' : 'opacity-100 cursor-pointer'
          }`}
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      {/* ========================================== */}
      {/* Section 1: Recording Era */}
      {/* ========================================== */}
      <div data-tutorial-id="filter-era-pills" className="flex flex-col gap-1">
        <button
          onClick={() => toggleSection('era')}
          className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
        >
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-[#ADFF2F]" />
            <span>Recording Era</span>
          </div>
          {openSections.era ? (
            <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
          )}
        </button>
        {openSections.era && (
          <div className="pl-5 flex flex-col gap-1 mt-0.5">
            {eraOptions.length === 0 ? (
              <span className="text-[10px] text-[#64748B] italic">No eras in library</span>
            ) : (
              eraOptions.map((opt) => {
                const isChecked = facets.era === opt.value
                return (
                  <label
                    key={opt.value}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="era"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            era: isChecked ? undefined : opt.value,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, era: undefined })
                          }
                        }}
                        className="accent-[#ADFF2F] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors ${
                          isChecked ? 'text-[#ADFF2F] font-semibold' : 'group-hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* ========================================== */}
      {/* Section 2: Composer */}
      {/* ========================================== */}
      <div data-tutorial-id="filter-composer-pills" className="flex flex-col gap-1">
        <button
          onClick={() => toggleSection('composer')}
          className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
        >
          <div className="flex items-center gap-1.5">
            <Music className="w-3.5 h-3.5 text-[#00F5FF]" />
            <span>Composer</span>
          </div>
          {openSections.composer ? (
            <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
          )}
        </button>
        {openSections.composer && (
          <div className="pl-5 flex flex-col gap-1.5 mt-0.5">
            {composerOptions.length > 5 && (
              <div className="relative my-0.5">
                <Search className="w-3 h-3 text-[#64748B] absolute left-2 top-2" />
                <input
                  type="text"
                  placeholder="Filter composers..."
                  value={composerSearch}
                  onChange={(e) => setComposerSearch(e.target.value)}
                  className="w-full bg-white/[0.03] border border-white/[0.08] rounded text-[11px] pl-7 pr-2 py-1 text-[#CBD5E1] placeholder-[#475569] focus:outline-none focus:border-[#00F5FF]/50"
                />
              </div>
            )}

            {filteredComposers.length === 0 ? (
              <span className="text-[10px] text-[#64748B] italic">No composers found</span>
            ) : (
              filteredComposers.map((opt) => {
                const isChecked = facets.composer === opt.key
                return (
                  <label
                    key={opt.key}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="composer"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            composer: isChecked ? undefined : opt.key,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, composer: undefined })
                          }
                        }}
                        className="accent-[#00F5FF] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors truncate max-w-[170px] ${
                          isChecked ? 'text-[#00F5FF] font-semibold' : 'group-hover:text-white'
                        }`}
                        title={opt.label}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })
            )}

            {composerOptions.length > 6 && !composerSearch.trim() && (
              <button
                onClick={() => setShowAllComposers(!showAllComposers)}
                className="text-[10px] text-[#00F5FF] hover:underline self-start mt-0.5"
              >
                {showAllComposers
                  ? 'Show fewer composers'
                  : `+${composerOptions.length - 6} more composers`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ========================================== */}
      {/* Section 3: Language */}
      {/* ========================================== */}
      <div data-tutorial-id="filter-language-pills" className="flex flex-col gap-1">
        <button
          onClick={() => toggleSection('language')}
          className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
        >
          <div className="flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-[#F59E0B]" />
            <span>Language</span>
          </div>
          {openSections.language ? (
            <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
          )}
        </button>
        {openSections.language && (
          <div className="pl-5 flex flex-col gap-1 mt-0.5">
            {languageOptions.length === 0 ? (
              <span className="text-[10px] text-[#64748B] italic">No languages detected</span>
            ) : (
              languageOptions.map((opt) => {
                const isChecked = facets.language === opt.value
                return (
                  <label
                    key={opt.value}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="language"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            language: isChecked ? undefined : opt.value,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, language: undefined })
                          }
                        }}
                        className="accent-[#F59E0B] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors ${
                          isChecked ? 'text-[#F59E0B] font-semibold' : 'group-hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* ========================================== */}
      {/* Section 4: Resolution & Format */}
      {/* ========================================== */}
      <div data-tutorial-id="filter-format-pills" className="flex flex-col gap-1">
        <button
          onClick={() => toggleSection('format')}
          className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
        >
          <div className="flex items-center gap-1.5">
            <Disc3 className="w-3.5 h-3.5 text-[#EC4899]" />
            <span>Resolution & Format</span>
          </div>
          {openSections.format ? (
            <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
          )}
        </button>
        {openSections.format && (
          <div className="pl-5 flex flex-col gap-1 mt-0.5">
            {formatOptions.length === 0 ? (
              <span className="text-[10px] text-[#64748B] italic">No audio formats found</span>
            ) : (
              formatOptions.map((opt) => {
                const isChecked = facets.format === opt.value
                return (
                  <label
                    key={opt.value}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="format"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            format: isChecked ? undefined : opt.value,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, format: undefined })
                          }
                        }}
                        className="accent-[#EC4899] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors ${
                          isChecked ? 'text-[#EC4899] font-semibold' : 'group-hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* ========================================== */}
      {/* Section 5: Genre & Repertoire */}
      {/* ========================================== */}
      {genreOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => toggleSection('genre')}
            className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
          >
            <div className="flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-[#38BDF8]" />
              <span>Genre & Repertoire</span>
            </div>
            {openSections.genre ? (
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
            )}
          </button>
          {openSections.genre && (
            <div className="pl-5 flex flex-col gap-1 mt-0.5 max-h-48 overflow-y-auto">
              {genreOptions.map((opt) => {
                const isChecked = facets.genre === opt.value
                return (
                  <label
                    key={opt.value}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="genre"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            genre: isChecked ? undefined : opt.value,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, genre: undefined })
                          }
                        }}
                        className="accent-[#38BDF8] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors truncate max-w-[170px] ${
                          isChecked ? 'text-[#38BDF8] font-semibold' : 'group-hover:text-white'
                        }`}
                        title={opt.label}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================== */}
      {/* Section 6: Ensemble & Performer Credit */}
      {/* ========================================== */}
      {ensembleOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => toggleSection('ensemble')}
            className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
          >
            <div className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-[#A78BFA]" />
              <span>Ensemble / Performer</span>
            </div>
            {openSections.ensemble ? (
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
            )}
          </button>
          {openSections.ensemble && (
            <div className="pl-5 flex flex-col gap-1 mt-0.5 max-h-48 overflow-y-auto">
              {ensembleOptions.map((opt) => {
                const isChecked = facets.ensemble === opt.value
                return (
                  <label
                    key={opt.value}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="ensemble"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            ensemble: isChecked ? undefined : opt.value,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, ensemble: undefined })
                          }
                        }}
                        className="accent-[#A78BFA] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors truncate max-w-[170px] ${
                          isChecked ? 'text-[#A78BFA] font-semibold' : 'group-hover:text-white'
                        }`}
                        title={opt.label}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================== */}
      {/* Section 7: Mastering & Dynamic Range */}
      {/* ========================================== */}
      {masteringOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => toggleSection('mastering')}
            className="flex items-center justify-between text-xs font-medium text-[#CBD5E1] hover:text-[#F1F5F9] py-1"
          >
            <div className="flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5 text-[#10B981]" />
              <span>Mastering & Dynamic Range</span>
            </div>
            {openSections.mastering ? (
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[#64748B]" />
            )}
          </button>
          {openSections.mastering && (
            <div className="pl-5 flex flex-col gap-1 mt-0.5">
              {masteringOptions.map((opt) => {
                const isChecked = facets.mastering === opt.value
                return (
                  <label
                    key={opt.value}
                    className="flex items-center justify-between text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] cursor-pointer group py-0.5"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="mastering"
                        checked={isChecked}
                        onChange={() =>
                          onFacetChange({
                            ...facets,
                            mastering: isChecked ? undefined : opt.value,
                          })
                        }
                        onClick={() => {
                          if (isChecked) {
                            onFacetChange({ ...facets, mastering: undefined })
                          }
                        }}
                        className="accent-[#10B981] w-3 h-3 cursor-pointer"
                      />
                      <span
                        className={`transition-colors truncate max-w-[170px] ${
                          isChecked ? 'text-[#10B981] font-semibold' : 'group-hover:text-white'
                        }`}
                        title={opt.label}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.04] px-1.5 py-0.2 rounded">
                      {opt.count}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
