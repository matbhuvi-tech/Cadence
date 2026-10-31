import React, { useState, useRef, useEffect } from 'react'
import { Filter, ArrowUpDown, LayoutGrid, SlidersHorizontal, Check } from 'lucide-react'
import { SubToolbarTier } from '../../../hooks/useContainerBreakpoint'

export type SortBy = 'year_desc' | 'year_asc' | 'artist_asc' | 'title_asc'
export type CardSize = 'compact' | 'standard' | 'large'

interface ViewControlClusterProps {
  tier: SubToolbarTier
  isFilterShelfOpen: boolean
  onToggleFilterShelf: () => void
  activeFiltersCount: number
  sortBy: SortBy
  onSortChange: (sort: SortBy) => void
  cardSize: CardSize
  onCardSizeChange: (size: CardSize) => void
  showCardSizeSelector?: boolean
}

const SORT_LABELS: Record<SortBy, string> = {
  year_desc: 'Year (Newest First)',
  year_asc: 'Year (Oldest First)',
  artist_asc: 'Artist (A-Z)',
  title_asc: 'Title (A-Z)',
}

/**
 * ViewControlCluster
 *
 * Decoupled view mutation cluster (Filter Shelf trigger, Sort selector, Card Size selector).
 * Implements a 3-tier progressive disclosure:
 * - 'wide' (>= 960px): Full inline labels, dropdown, and 3-button density selector.
 * - 'compact' (820px <= width < 960px): Icon-only buttons with tooltips.
 * - 'popover' (< 820px): Single consolidated [ Filters & Sort (N) ] Apple HIG popover card.
 */
export const ViewControlCluster: React.FC<ViewControlClusterProps> = ({
  tier,
  isFilterShelfOpen,
  onToggleFilterShelf,
  activeFiltersCount,
  sortBy,
  onSortChange,
  cardSize,
  onCardSizeChange,
  showCardSizeSelector = true,
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close popover on click outside or escape key
  useEffect(() => {
    if (!isPopoverOpen) return

    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsPopoverOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPopoverOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isPopoverOpen])

  // ==========================================
  // TIER 3: CONSOLIDATED POPOVER (< 820px)
  // ==========================================
  if (tier === 'popover') {
    const totalBadges = activeFiltersCount + (isFilterShelfOpen ? 1 : 0)

    return (
      <div className="relative shrink-0 select-none" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setIsPopoverOpen((prev) => !prev)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
            isPopoverOpen || totalBadges > 0
              ? 'bg-[#D4AF37]/20 border border-[#D4AF37]/50 text-[#D4AF37] font-semibold'
              : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[#8E8E93] hover:text-[#F5F5F7]'
          }`}
          title="Open View, Sort, and Filter Controls"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span>Controls</span>
          {totalBadges > 0 && (
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#D4AF37] text-black font-bold">
              {totalBadges}
            </span>
          )}
        </button>

        {isPopoverOpen && (
          <div className="absolute right-0 top-full mt-2 w-64 p-3.5 rounded-2xl bg-[#16181E]/95 backdrop-blur-2xl border border-white/[0.12] shadow-2xl z-50 flex flex-col gap-3.5 text-xs">
            {/* Filter Shelf Trigger */}
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
              <span className="font-semibold text-white flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-[#D4AF37]" />
                Filter Shelf
              </span>
              <button
                type="button"
                onClick={() => {
                  onToggleFilterShelf()
                  setIsPopoverOpen(false)
                }}
                className={`px-2 py-0.5 rounded text-[11px] font-mono cursor-pointer ${
                  isFilterShelfOpen
                    ? 'bg-[#D4AF37] text-black font-bold'
                    : 'bg-white/10 text-[#CBD5E1] hover:text-white'
                }`}
              >
                {isFilterShelfOpen ? 'Active' : 'Show (⌘F)'}
              </button>
            </div>

            {/* Sort Dropdown */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="popover-sort-select" className="text-[11px] font-mono text-[#8E8E93]">Sort Catalog</label>
              <select
                id="popover-sort-select"
                value={sortBy}
                onChange={(e) => onSortChange(e.target.value as SortBy)}
                className="w-full bg-black/60 border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-[#EDEDED] focus:border-[#D4AF37] focus:outline-none cursor-pointer"
              >
                <option value="year_desc">Year (Newest First)</option>
                <option value="year_asc">Year (Oldest First)</option>
                <option value="artist_asc">Artist (A-Z)</option>
                <option value="title_asc">Album Title (A-Z)</option>
              </select>
            </div>

            {/* Card Size Selector */}
            {showCardSizeSelector && (
              <div className="flex flex-col gap-1.5 pt-2 border-t border-white/[0.06]">
                <span className="text-[11px] font-mono text-[#8E8E93]">Cover Density</span>
                <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-black/40 border border-white/[0.06] text-[11px] font-mono text-[#8E8E93]">
                  {(['compact', 'standard', 'large'] as CardSize[]).map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => onCardSizeChange(size)}
                      className={`py-1 rounded capitalize transition-all cursor-pointer text-center ${
                        cardSize === size ? 'bg-white/10 text-white font-bold' : 'hover:text-white'
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ==========================================
  // TIER 2: COMPACT ICON-ONLY (820px - 959px)
  // ==========================================
  if (tier === 'compact') {
    return (
      <div className="flex items-center gap-2 shrink-0 select-none">
        {/* Compact Filter Shelf Icon Button */}
        <button
          type="button"
          onClick={onToggleFilterShelf}
          title="Toggle Filter Shelf (⌘F)"
          className={`flex items-center justify-center w-7 h-7 rounded-lg text-xs transition-all cursor-pointer ${
            isFilterShelfOpen || activeFiltersCount > 0
              ? 'bg-[#D4AF37]/20 border border-[#D4AF37]/50 text-[#D4AF37]'
              : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[#8E8E93] hover:text-[#F5F5F7]'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          {activeFiltersCount > 0 && (
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[#D4AF37] text-black font-mono text-[9px] font-bold flex items-center justify-center">
              {activeFiltersCount}
            </span>
          )}
        </button>

        {/* Compact Sort Selector */}
        <div className="relative flex items-center" title={`Sort: ${SORT_LABELS[sortBy]}`}>
          <ArrowUpDown className="w-3.5 h-3.5 text-[#8E8E93] absolute left-2 pointer-events-none" />
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortBy)}
            className="bg-black/40 border border-white/[0.1] rounded-lg pl-7 pr-2 py-1 text-xs text-[#EDEDED] focus:border-[#D4AF37] focus:outline-none cursor-pointer max-w-[120px] truncate"
          >
            <option value="year_desc">Year (Newest)</option>
            <option value="year_asc">Year (Oldest)</option>
            <option value="artist_asc">Artist (A-Z)</option>
            <option value="title_asc">Title (A-Z)</option>
          </select>
        </div>

        {/* Compact Density Selector */}
        {showCardSizeSelector && (
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[10px] font-mono text-[#8E8E93]">
            {(['compact', 'standard', 'large'] as CardSize[]).map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => onCardSizeChange(size)}
                title={`Card Density: ${size}`}
                className={`px-1.5 py-0.5 rounded uppercase transition-all cursor-pointer ${
                  cardSize === size ? 'bg-white/10 text-white font-bold' : 'hover:text-white'
                }`}
              >
                {size[0]}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ==========================================
  // TIER 1: FULL INLINE (>= 960px)
  // ==========================================
  return (
    <div className="flex items-center gap-3 shrink-0 select-none">
      {/* Filter Shelf Toggle (⌘F) */}
      <button
        type="button"
        onClick={onToggleFilterShelf}
        title="Filter by Era, Format, Dynamic Range, Composer (⌘F)"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
          isFilterShelfOpen || activeFiltersCount > 0
            ? 'bg-[#D4AF37]/20 border border-[#D4AF37]/40 text-[#D4AF37] font-semibold'
            : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[#8E8E93] hover:text-[#F5F5F7]'
        }`}
      >
        <Filter className="w-3 h-3 text-[#D4AF37]" />
        <span>Filter</span>
        {activeFiltersCount > 0 && (
          <span className="text-[10px] px-1 py-0.2 rounded-full bg-[#D4AF37] text-black font-bold">
            {activeFiltersCount}
          </span>
        )}
        <span className="text-[9px] text-[#636366] font-mono hidden sm:inline">⌘F</span>
      </button>

      {/* Sort By Dropdown */}
      <div className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
        <span className="text-[11px] font-mono text-[#8E8E93]">Sort:</span>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as SortBy)}
          className="bg-black/40 border border-white/[0.1] rounded-lg px-2.5 py-1 text-xs text-[#EDEDED] focus:border-[#D4AF37] focus:outline-none cursor-pointer"
        >
          <option value="year_desc">Year (Newest First)</option>
          <option value="year_asc">Year (Oldest First)</option>
          <option value="artist_asc">Artist (A-Z)</option>
          <option value="title_asc">Album Title (A-Z)</option>
        </select>
      </div>

      {/* Card Size Selector */}
      {showCardSizeSelector && (
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[11px] font-mono text-[#8E8E93]">
          {(['compact', 'standard', 'large'] as CardSize[]).map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => onCardSizeChange(size)}
              className={`px-2 py-0.5 rounded capitalize transition-all cursor-pointer ${
                cardSize === size ? 'bg-white/10 text-white font-bold' : 'hover:text-white'
              }`}
            >
              {size}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

