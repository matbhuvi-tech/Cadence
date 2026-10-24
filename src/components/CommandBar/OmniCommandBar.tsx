import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Search,
  Disc3,
  Music2,
  Users2,
  Filter,
  Bot,
  Command,
  CornerDownLeft,
  Sparkles,
  Sliders,
  Check,
} from 'lucide-react'
import {
  OmnibarRowItem,
  CatalogEntityMatch,
  CatalogAlbumMatch,
  CatalogTrackMatch,
  CatalogArtistMatch,
  SystemCommandItem,
  deriveFormatBadge,
  parseFacetTokens,
  classifySearchIntent,
  CanonicalEntityCandidate,
} from '../../core/searchIntentClassifier'
import { FacetSelections } from '../../core/types'
import { graphEngine } from '../../core/graphEngine'

export type CommandItem = SystemCommandItem

export interface OmniCommandBarProps {
  isOpen: boolean
  onClose: () => void
  commands: CommandItem[]
  onOpenAgent?: (initialPrompt?: string) => void
  onSelectEntity?: (item: CatalogEntityMatch) => void
  onInspectEntity?: (item: CatalogEntityMatch) => void
  onEnrichEntity?: (item: CatalogEntityMatch) => void
  onApplyFacetFilter?: (facets: FacetSelections, residualQuery?: string) => void
  initialQuery?: string
}

export const OmniCommandBar: React.FC<OmniCommandBarProps> = ({
  isOpen,
  onClose,
  commands,
  onOpenAgent,
  onSelectEntity,
  onInspectEntity,
  onEnrichEntity,
  onApplyFacetFilter,
  initialQuery = '',
}) => {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<'search' | 'agent'>('search')
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const listContainerRef = useRef<HTMLDivElement | null>(null)

  // 25ms micro-debounce to guarantee zero GPU lag and 60 FPS typing
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedQuery(query)
    }, 25)
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [query])

  // Reset or initialize on open
  useEffect(() => {
    if (isOpen) {
      const init = (initialQuery || '').trim()
      setQuery(init)
      setDebouncedQuery(init)
      setSelectedIndex(0)
      setMode('search')
    }
  }, [isOpen, initialQuery])

  // 1. Direct Catalog Entities Lookup (Tier 1: strictly in-memory, <1ms, zero disk I/O)
  const entityHits = useMemo(() => {
    const q = debouncedQuery.trim()
    if (!q || q.startsWith('>') || q.startsWith('?') || q.startsWith('/ai')) {
      return { albums: [], tracks: [], artists: [] }
    }

    const rawMem = graphEngine.searchCatalog(q, 5)

    const albums: CatalogAlbumMatch[] = rawMem.albums.map((rel) => {
      const firstTrack = (rel as any).tracks?.[0]
      const formatBadge = deriveFormatBadge(
        rel.mediaFormat || firstTrack?.format || 'FLAC',
        firstTrack?.sampleRateStr
      )
      return {
        type: 'album',
        id: rel.id,
        title: rel.title,
        artistCredit: rel.artistCredit,
        composerName: rel.composerName,
        releaseYear: rel.releaseYear || rel.originalYear,
        tracksCount: rel.tracksCount || 10,
        formatBadge,
        // Strict Invariant: Only use already-cached memory URLs
        artworkUrl: rel.coverArtUrl || rel.artwork?.frontCoverUrl,
        release: rel,
      }
    })

    const tracks: CatalogTrackMatch[] = rawMem.tracks.map((track) => {
      const rel = graphEngine.getReleaseById(track.releaseId)
      const formatBadge = deriveFormatBadge(track.format, track.sampleRateStr, track.bitDepth)
      return {
        type: 'track',
        id: track.id,
        title: track.title,
        albumTitle: rel?.title || track.workTitle || 'Unknown Album',
        releaseId: track.releaseId,
        artistCredit: track.artistCredit,
        composerName: track.composerName,
        trackNumber: track.trackNumber,
        formatBadge,
        track,
      }
    })

    const artists: CatalogArtistMatch[] = rawMem.artists.map((person) => ({
      type: 'artist',
      id: person.id,
      name: person.name,
      role: person.role,
      albumsCount: person.albumsCount,
      tracksCount: person.tracksCount,
      portraitUrl: person.portraitUrl,
    }))

    return { albums, tracks, artists }
  }, [debouncedQuery])

  // 2. Dynamic Canonical Candidates for Facet Token Matching (Tier 2)
  const canonicalCandidates = useMemo<CanonicalEntityCandidate[]>(() => {
    return graphEngine.getAllPersons().map((p) => ({
      id: p.id,
      name: p.name,
      sortName: p.sortName,
      role: p.primaryRole,
    }))
  }, [])

  // 3. Facet Intent Token Parser (Tier 2)
  const facetIntent = useMemo(() => {
    if (debouncedQuery.startsWith('>') || debouncedQuery.startsWith('?')) return null
    return parseFacetTokens(debouncedQuery, canonicalCandidates)
  }, [debouncedQuery, canonicalCandidates])

  // 4. Unified Deterministic 4-Tier Intent Classifier
  const classifiedState = useMemo(() => {
    return classifySearchIntent({
      rawQuery: debouncedQuery,
      entityHits,
      facetIntent,
      commands,
      mode,
    })
  }, [debouncedQuery, entityHits, facetIntent, commands, mode])

  const { rows, badge } = classifiedState

  // Keep selected index within bounds
  useEffect(() => {
    if (selectedIndex >= rows.length && rows.length > 0) {
      setSelectedIndex(0)
    }
  }, [rows.length, selectedIndex])

  // Scroll active item into view
  useEffect(() => {
    if (!listContainerRef.current) return
    const activeEl = listContainerRef.current.querySelector(
      `[data-omnibar-index="${selectedIndex}"]`
    ) as HTMLElement
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Keyboard Navigation Contract
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      // Explicit Copilot escalation via ⌘+Enter (or Ctrl+Enter)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onOpenAgent?.(query)
        onClose()
        return
      }

      // Navigation: ArrowDown
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (rows.length === 0) return
        setSelectedIndex((prev) => (prev + 1 >= rows.length ? 0 : prev + 1))
        return
      }

      // Navigation: ArrowUp
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (rows.length === 0) return
        setSelectedIndex((prev) => (prev - 1 < 0 ? rows.length - 1 : prev - 1))
        return
      }

      const activeRow = rows[selectedIndex]

      // Tab Key: STRICTLY RESERVED for onInspectEntity (Non-destructive Sidecar Diff)
      if (e.key === 'Tab') {
        e.preventDefault()
        if (
          activeRow &&
          (activeRow.kind === 'album' ||
            activeRow.kind === 'track' ||
            activeRow.kind === 'artist')
        ) {
          onInspectEntity?.(activeRow.entity)
          onClose()
        }
        return
      }

      // Cmd+E (or Ctrl+E): Metadata Enrichment / Batch Diff
      if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
        if (
          activeRow &&
          (activeRow.kind === 'album' ||
            activeRow.kind === 'track' ||
            activeRow.kind === 'artist')
        ) {
          e.preventDefault()
          onEnrichEntity?.(activeRow.entity)
          onClose()
        }
        return
      }

      // Space: Toggle for Boolean System Commands
      if (e.key === ' ' && activeRow && activeRow.kind === 'command') {
        const isToggleCmd =
          activeRow.command.isToggle ||
          activeRow.command.title.toLowerCase().includes('toggle')
        if (isToggleCmd) {
          e.preventDefault()
          activeRow.command.action()
          return
        }
      }

      // Enter: Intent Execution
      if (e.key === 'Enter') {
        e.preventDefault()
        if (!activeRow) return

        if (
          activeRow.kind === 'album' ||
          activeRow.kind === 'track' ||
          activeRow.kind === 'artist'
        ) {
          // Safe navigation: selects/focuses entity, never mutates AudioEngine playback!
          onSelectEntity?.(activeRow.entity)
          onClose()
        } else if (activeRow.kind === 'facet') {
          onApplyFacetFilter?.(
            activeRow.intent.facets,
            activeRow.intent.residualQuery
          )
          onClose()
        } else if (activeRow.kind === 'command') {
          activeRow.command.action()
          onClose()
        } else if (activeRow.kind === 'agent') {
          onOpenAgent?.(activeRow.prompt)
          onClose()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isOpen,
    selectedIndex,
    rows,
    query,
    onClose,
    onOpenAgent,
    onSelectEntity,
    onInspectEntity,
    onEnrichEntity,
    onApplyFacetFilter,
  ])

  if (!isOpen) return null

  const currentRow = rows[selectedIndex]

  // Render Dynamic Badge Styling
  const renderBadge = () => {
    const badgeColors: Record<string, string> = {
      neutral: 'bg-white/[0.06] text-[#8E8E93] border-white/[0.08]',
      emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      cyan: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      purple: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
      gold: 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40',
    }

    return (
      <div
        className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono tracking-wide border flex items-center gap-1.5 shrink-0 transition-colors ${
          badgeColors[badge.variant] || badgeColors.neutral
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            badge.variant === 'emerald'
              ? 'bg-emerald-400 animate-pulse'
              : badge.variant === 'gold'
              ? 'bg-[#D4AF37] animate-pulse'
              : badge.variant === 'cyan'
              ? 'bg-cyan-400'
              : badge.variant === 'purple'
              ? 'bg-purple-400'
              : 'bg-white/40'
          }`}
        />
        <span>{badge.label}</span>
      </div>
    )
  }

  // Render Footer Keycap Contract based on currentRow
  const renderFooterContract = () => {
    if (!currentRow) {
      return (
        <div className="flex items-center gap-3">
          <span>↑↓ Navigate</span>
          <span>esc Dismiss</span>
        </div>
      )
    }

    if (currentRow.kind === 'album' || currentRow.kind === 'track') {
      return (
        <div className="flex items-center gap-3">
          <span className="text-[#EDEDED] font-medium">↵ Open View</span>
          <span className="text-[#00F5FF]">⇥ Inspect Metadata (Sidecar)</span>
          <span className="text-[#ADFF2F]">⌘E Enrich</span>
          <span className="text-[#8E8E93]">⌘↵ Copilot</span>
          <span className="text-[#636366]">esc Dismiss</span>
        </div>
      )
    }

    if (currentRow.kind === 'artist') {
      return (
        <div className="flex items-center gap-3">
          <span className="text-[#EDEDED] font-medium">↵ Filter by Artist</span>
          <span className="text-[#00F5FF]">⇥ Inspect Profile</span>
          <span className="text-[#8E8E93]">⌘↵ Copilot</span>
          <span className="text-[#636366]">esc Dismiss</span>
        </div>
      )
    }

    if (currentRow.kind === 'facet') {
      return (
        <div className="flex items-center gap-3">
          <span className="text-[#00F5FF] font-medium">↵ Apply Filter to Grid</span>
          <span className="text-[#8E8E93]">⌘↵ Copilot</span>
          <span className="text-[#636366]">esc Dismiss</span>
        </div>
      )
    }

    if (currentRow.kind === 'command') {
      const isToggle =
        currentRow.command.isToggle ||
        currentRow.command.title.toLowerCase().includes('toggle')
      return (
        <div className="flex items-center gap-3">
          <span className="text-[#EDEDED] font-medium">↵ Execute Command</span>
          {isToggle && <span className="text-[#F59E0B]">Space Toggle</span>}
          <span className="text-[#636366]">esc Dismiss</span>
        </div>
      )
    }

    if (currentRow.kind === 'agent') {
      return (
        <div className="flex items-center gap-3">
          <span className="text-[#D4AF37] font-medium">↵ Open in Cadence Copilot</span>
          <span className="text-[#636366]">esc Dismiss</span>
        </div>
      )
    }

    return null
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex items-start justify-center pt-[10vh] p-4 animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#121316]/95 backdrop-blur-3xl border border-white/[0.09] rounded-2xl w-full max-w-2xl shadow-[0_32px_64px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col will-change-transform animate-in zoom-in-95 duration-150"
      >
        {/* Spotlight Search Input Header */}
        <div className="p-3.5 px-4 border-b border-white/[0.06] flex items-center gap-3 bg-white/[0.02]">
          <Search className="w-4 h-4 text-[#D4AF37] shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder="Search albums, tracks, composers, filter by 'FLAC 1990s', or type '>' for commands..."
            className="w-full bg-transparent text-sm text-[#EDEDED] placeholder:text-[#636366] focus:outline-none font-sans font-medium selection:bg-[#D4AF37]/30"
          />

          {/* Dynamic Reactive Intent Badge */}
          {renderBadge()}

          {/* Explicit Copilot Mode Switcher Button */}
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === 'search' ? 'agent' : 'search'))
              setSelectedIndex(0)
            }}
            title="Toggle Copilot Prompt Mode (⌘↵ to send directly)"
            className={`px-2 py-0.5 rounded-md text-[10px] font-mono transition-all flex items-center gap-1 cursor-pointer shrink-0 ${
              mode === 'agent'
                ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30'
                : 'bg-white/[0.04] text-[#8E8E93] hover:text-[#EDEDED] border border-white/[0.06]'
            }`}
          >
            <Sparkles className="w-2.5 h-2.5" />
            <span>{mode === 'agent' ? 'Copilot Active' : 'Copilot (⌘↵)'}</span>
          </button>
        </div>

        {/* 4-Tier Zero-Latency Results Stream */}
        <div
          ref={listContainerRef}
          className="max-h-[420px] overflow-y-auto p-2 flex flex-col gap-1 select-none"
        >
          {rows.length === 0 ? (
            <div className="p-10 text-center text-xs text-[#636366]">
              No direct matches found. Press <kbd className="px-1 text-[10px] bg-white/5 rounded text-[#D4AF37]">⌘↵</kbd> to ask Cadence Copilot.
            </div>
          ) : (
            rows.map((row, idx) => {
              const isSelected = selectedIndex === idx

              // Tier 1: Albums
              if (row.kind === 'album') {
                const { entity } = row
                const initials = entity.title.substring(0, 2).toUpperCase()

                return (
                  <div
                    key={`album-${entity.id}`}
                    data-omnibar-index={idx}
                    onClick={() => {
                      onSelectEntity?.(entity)
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-white/[0.08] text-[#EDEDED] border border-white/[0.08]'
                        : 'text-[#8E8E93] hover:bg-white/[0.03] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Strict Invariant: Only render memory-cached artwork */}
                      {entity.artworkUrl ? (
                        <img
                          src={entity.artworkUrl}
                          alt={entity.title}
                          className="w-9 h-9 rounded-md object-cover border border-white/10 shrink-0 bg-[#1B1D22]"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-md bg-[#22252A] border border-white/10 flex items-center justify-center shrink-0">
                          <Disc3 className="w-4 h-4 text-white/40" />
                        </div>
                      )}

                      <div className="flex flex-col min-w-0 text-left">
                        <span className="text-xs font-semibold text-[#EDEDED] truncate">
                          {entity.title}
                        </span>
                        <span className="text-[11px] text-[#8E8E93] truncate">
                          {entity.composerName || entity.artistCredit}
                          {entity.releaseYear ? ` • ${entity.releaseYear}` : ''} • {entity.tracksCount} tracks
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.05] text-[#00F5FF] border border-white/[0.08]">
                        {entity.formatBadge}
                      </span>
                      <CornerDownLeft
                        className={`w-3.5 h-3.5 ${
                          isSelected ? 'text-[#D4AF37] opacity-100' : 'opacity-0'
                        }`}
                      />
                    </div>
                  </div>
                )
              }

              // Tier 1: Tracks
              if (row.kind === 'track') {
                const { entity } = row
                return (
                  <div
                    key={`track-${entity.id}`}
                    data-omnibar-index={idx}
                    onClick={() => {
                      onSelectEntity?.(entity)
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-white/[0.08] text-[#EDEDED] border border-white/[0.08]'
                        : 'text-[#8E8E93] hover:bg-white/[0.03] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          isSelected
                            ? 'bg-[#00F5FF]/15 text-[#00F5FF]'
                            : 'bg-white/[0.04] text-[#8E8E93]'
                        }`}
                      >
                        <Music2 className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col min-w-0 text-left">
                        <span className="text-xs font-medium text-[#EDEDED] truncate">
                          {entity.title}
                        </span>
                        <span className="text-[11px] text-[#8E8E93] truncate">
                          {entity.albumTitle} • {entity.composerName || entity.artistCredit}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-[#8E8E93] border border-white/[0.06]">
                        {entity.formatBadge}
                      </span>
                      <CornerDownLeft
                        className={`w-3.5 h-3.5 ${
                          isSelected ? 'text-[#D4AF37] opacity-100' : 'opacity-0'
                        }`}
                      />
                    </div>
                  </div>
                )
              }

              // Tier 1: Composers / Artists
              if (row.kind === 'artist') {
                const { entity } = row
                const initials = entity.name.substring(0, 2).toUpperCase()

                return (
                  <div
                    key={`artist-${entity.id}`}
                    data-omnibar-index={idx}
                    onClick={() => {
                      onSelectEntity?.(entity)
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-white/[0.08] text-[#EDEDED] border border-white/[0.08]'
                        : 'text-[#8E8E93] hover:bg-white/[0.03] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {entity.portraitUrl ? (
                        <img
                          src={entity.portraitUrl}
                          alt={entity.name}
                          className="w-8 h-8 rounded-full object-cover border border-white/10 shrink-0 bg-[#1B1D22]"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-white/10 to-white/5 border border-white/10 flex items-center justify-center text-[10px] font-bold text-white/80 shrink-0 font-mono">
                          {initials}
                        </div>
                      )}

                      <div className="flex flex-col min-w-0 text-left">
                        <span className="text-xs font-medium text-[#EDEDED] truncate">
                          {entity.name}
                        </span>
                        <span className="text-[11px] text-[#8E8E93] truncate">
                          {entity.albumsCount} album{entity.albumsCount !== 1 ? 's' : ''} • {entity.tracksCount} track{entity.tracksCount !== 1 ? 's' : ''} in library
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                        {entity.role}
                      </span>
                      <CornerDownLeft
                        className={`w-3.5 h-3.5 ${
                          isSelected ? 'text-[#D4AF37] opacity-100' : 'opacity-0'
                        }`}
                      />
                    </div>
                  </div>
                )
              }

              // Tier 2: Actionable Facet Filter Row
              if (row.kind === 'facet') {
                const { intent } = row
                return (
                  <div
                    key="facet-intent-row"
                    data-omnibar-index={idx}
                    onClick={() => {
                      onApplyFacetFilter?.(intent.facets, intent.residualQuery)
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`p-2.5 px-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-cyan-500/15 border-cyan-500/40 text-[#EDEDED]'
                        : 'bg-white/[0.02] border-white/[0.06] text-[#8E8E93] hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 shrink-0">
                        <Filter className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0 text-left">
                        <span className="text-xs font-semibold text-[#EDEDED]">
                          Apply Library Filter:
                        </span>
                        {intent.pills.map((pill) => (
                          <span
                            key={pill.key}
                            className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950/70 border border-cyan-500/30 text-cyan-300 flex items-center gap-1"
                          >
                            <span className="text-cyan-400/60">{pill.label}:</span>
                            <span className="font-semibold">{pill.value}</span>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-cyan-300 font-mono border border-cyan-500/30">
                        ↵ Apply Filter
                      </kbd>
                    </div>
                  </div>
                )
              }

              // Tier 3: Workstation System Commands
              if (row.kind === 'command') {
                const { command } = row
                return (
                  <div
                    key={`cmd-${command.id}`}
                    data-omnibar-index={idx}
                    onClick={() => {
                      command.action()
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-white/[0.08] text-[#EDEDED] border border-white/[0.08]'
                        : 'text-[#8E8E93] hover:bg-white/[0.03] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`p-1.5 rounded-lg shrink-0 ${
                          isSelected
                            ? 'bg-[#D4AF37]/20 text-[#D4AF37]'
                            : 'bg-white/[0.04] text-[#8E8E93]'
                        }`}
                      >
                        {command.icon}
                      </div>
                      <span className="text-xs font-medium text-[#EDEDED] truncate text-left">
                        {command.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {command.shortcut && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-[#8E8E93] border border-white/[0.06]">
                          {command.shortcut}
                        </span>
                      )}
                      <CornerDownLeft
                        className={`w-3.5 h-3.5 ${
                          isSelected ? 'text-[#D4AF37] opacity-100' : 'opacity-0'
                        }`}
                      />
                    </div>
                  </div>
                )
              }

              // Tier 4: Cadence Music Agent Copilot Handover
              if (row.kind === 'agent') {
                return (
                  <div
                    key="agent-handover-row"
                    data-omnibar-index={idx}
                    onClick={() => {
                      onOpenAgent?.(row.prompt)
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`p-2.5 px-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-[#D4AF37]/20 border-[#D4AF37]/45 text-[#EDEDED]'
                        : 'bg-white/[0.02] border-white/[0.06] text-[#8E8E93] hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="p-1.5 rounded-lg bg-[#D4AF37]/25 text-[#D4AF37] shrink-0">
                        <Bot className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col min-w-0 text-left">
                        <span className="text-xs font-semibold text-[#EDEDED] truncate">
                          Ask Cadence Music Agent
                        </span>
                        <span className="text-[11px] text-[#D4AF37] truncate font-mono">
                          "{row.prompt.trim() || 'Open AI Copilot'}"
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-[#D4AF37] font-mono border border-[#D4AF37]/30">
                        ↵ Handover
                      </kbd>
                    </div>
                  </div>
                )
              }

              return null
            })
          )}
        </div>

        {/* Apple Spotlight Footer Keycaps Contract */}
        <div className="p-2.5 px-4 bg-black/30 border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono text-[#636366]">
          {renderFooterContract()}
          <span className="text-[#8E8E93]">Cadence Spotlight</span>
        </div>
      </div>
    </div>
  )
}
