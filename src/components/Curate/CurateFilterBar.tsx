import React, { useId, useMemo, useState } from 'react'
import {
  filterAndRankCurateAlbums, type CatalogProblemSummary, type CurateAlbumSummary,
  type CurateFilterState, type PrioritySettings,
} from '../../core/curatePriorities'
import { categoryIds, labels, tiers } from './curateProblemLabels'

const emptyFilter: CurateFilterState = { priorities: [], categories: [] }

// oxlint-disable-next-line react/only-export-components
export function buildCurateFilterBarModel(
  summary: CatalogProblemSummary, settings: PrioritySettings, activeFilter: CurateFilterState,
  albumSearchQuery: string, albums: readonly CurateAlbumSummary[],
) {
  const query = albumSearchQuery.trim().toLowerCase()
  const matchingTitles = query ? albums.filter(album => album.title.toLowerCase().includes(query)) : []
  const albumSuggestions = filterAndRankCurateAlbums(matchingTitles, summary, {
    priorities: activeFilter.priorities, categories: activeFilter.categories,
  })
  return {
    groups: tiers.map(tier => ({
      tier,
      count: summary.priorityAlbumCounts[tier],
      active: activeFilter.priorities.includes(tier),
      categories: categoryIds.filter(id => settings[id] === tier).map(id => ({
        id, label: labels[id], affected: summary.categoryCounts[id], active: activeFilter.categories.includes(id),
      })),
    })),
    albumSuggestions,
    searchMessage: query && !albumSuggestions.length ? 'No matching albums' : undefined,
    hasFilters: Boolean(activeFilter.priorities.length || activeFilter.categories.length || activeFilter.selectedAlbumIdFilter),
  }
}

interface CurateFilterBarProps {
  summary: CatalogProblemSummary
  settings: PrioritySettings
  filter: CurateFilterState
  albums: readonly CurateAlbumSummary[]
  onFilterChange: (filter: CurateFilterState) => void
  hideReset?: boolean
  placeholder?: string
}

function toggle<T>(values: readonly T[], value: T) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value]
}

const tabStyle = 'rounded px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-white aria-pressed:bg-amber-400/20 aria-pressed:text-amber-200 aria-pressed:ring-1 aria-pressed:ring-amber-400/40'
const priorityNames = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' }
const priorityDots = { P0: 'bg-rose-400', P1: 'bg-amber-400', P2: 'bg-sky-400', P3: 'bg-zinc-400' }

export function CurateFilterBar({ summary, settings, filter, onFilterChange, hideReset = false }: CurateFilterBarProps) {
  const { groups, hasFilters } = buildCurateFilterBarModel(summary, settings, filter, '', [])
  const hasCategorySelection = filter.categories.length > 0
  const visibleGroups = filter.priorities.length
    ? groups.filter(group => group.active || group.categories.some(category => category.active))
    : groups

  return (
    <aside id="curate-filters" aria-label="Curate filters"
      className="flex w-52 shrink-0 flex-col bg-[#121318] text-white xl:w-64">
      {hasFilters && !hideReset && (
        <div className="mx-2 mt-2 flex justify-end">
          <button type="button" className="rounded px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-white/5 hover:text-white"
            onClick={() => onFilterChange(emptyFilter)}>Reset Filters</button>
        </div>
      )}
      <div role="group" aria-label="Priority filters"
        className="mx-2 mt-3 flex justify-between gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5">
        <button type="button" className={tabStyle} aria-pressed={!hasFilters} onClick={() => onFilterChange(emptyFilter)}>
          All Issues
        </button>
        {groups.map(group => (
          <button type="button" key={group.tier} className={tabStyle} aria-pressed={group.active}
            title={`${priorityNames[group.tier]} · ${group.count} matching albums`}
            onClick={() => onFilterChange({ ...filter, priorities: toggle(filter.priorities, group.tier) })}>
            {group.tier}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visibleGroups.map(group => (
          <details key={group.tier} className="group border-b border-white/[0.06] py-1.5"
            open={group.active || group.categories.some(category => category.active) || (!hasCategorySelection && !filter.priorities.length && group.tier === 'P0')}>
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-2 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-white/5">
              <span aria-hidden="true" className="text-[10px] text-zinc-500 transition-transform group-open:rotate-90">▶</span>
              <span>{group.tier} · {priorityNames[group.tier]}</span>
              <span title="Affected albums" className="ml-auto rounded-full border border-white/10 px-1.5 font-mono text-[10px] tabular-nums text-zinc-400">{group.count}</span>
            </summary>
            <div role="group" aria-label={`${group.tier} problem categories`} className="mt-1 space-y-0.5 border-l border-white/10 pl-1">
              {group.categories.map(category => {
                const unit = category.affected.count === 1 ? category.affected.unit.slice(0, -1) : category.affected.unit
                return (
                  <button type="button" key={category.id} aria-pressed={category.active}
                    aria-label={`${category.label}, ${category.affected.count} ${unit}`}
                    title={`${category.label} · ${category.affected.count} ${unit}`}
                    onClick={() => onFilterChange({ ...filter, categories: category.active ? [] : [category.id] })}
                    className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-white/5 aria-pressed:border-amber-400/50 aria-pressed:bg-amber-400/10 aria-pressed:text-amber-100">
                    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${priorityDots[group.tier]}`} />
                    <span className="min-w-0 flex-1">{category.label}</span>
                    <span className="shrink-0 rounded-full bg-white/5 px-1.5 font-mono text-[10px] tabular-nums">{category.affected.count}</span>
                  </button>
                )
              })}
            </div>
          </details>
        ))}
      </div>
    </aside>
  )
}

export function CurateAlbumSearch({ summary, settings, filter, albums, onFilterChange, placeholder }: CurateFilterBarProps) {
  const searchId = useId()
  const [query, setQuery] = useState('')
  const model = useMemo(
    () => buildCurateFilterBarModel(summary, settings, filter, query, albums),
    [summary, settings, filter, query, albums],
  )
  const selectedAlbum = albums.find(album => album.id === filter.selectedAlbumIdFilter)

  return (
    <div className="relative min-w-0">
      <label htmlFor={searchId} className="sr-only">Search filtered albums</label>
      <input id={searchId} type="search" value={query} placeholder={selectedAlbum?.title ?? placeholder ?? 'Search filtered albums...'}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Escape' || !query) return
          event.preventDefault()
          event.stopPropagation()
          setQuery('')
        }}
        className="mt-1 w-full rounded-md border border-white/15 bg-black/30 px-2 py-1 text-xs" />
      {selectedAlbum && !query && (
        <button type="button" onClick={() => onFilterChange({ ...filter, selectedAlbumIdFilter: undefined })}
          className="mt-1 block w-full truncate text-left text-xs text-cyan-200 hover:underline">
          Clear album filter · {selectedAlbum.title}
        </button>
      )}
      {query.trim() && (
        <div className="absolute inset-x-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-white/15 bg-[#1C1C1E] shadow-xl">
          {model.searchMessage ? (
            <p role="status" className="px-2 py-1.5 text-xs text-zinc-400">{model.searchMessage}</p>
          ) : (
            <ul aria-label="Matching albums">
              {model.albumSuggestions.map(album => (
                <li key={album.id}>
                  <button type="button" className="w-full px-2 py-1.5 text-left text-xs hover:bg-white/10"
                    onClick={() => {
                      onFilterChange({ ...filter, selectedAlbumIdFilter: album.id })
                      setQuery('')
                    }}>
                    {album.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
