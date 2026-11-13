import React from 'react';
import { Filter, Heart, ArrowUpDown, X, RotateCcw } from 'lucide-react';
import {
  CatalogFacets,
  ERA_OPTIONS,
  FORMAT_OPTIONS,
  SORT_OPTIONS,
  SortBy,
} from './catalogFilters';

interface FacetShelfProps {
  facets: CatalogFacets;
  onChangeFacets: (facets: CatalogFacets) => void;
  sortBy: SortBy;
  onChangeSortBy: (sort: SortBy) => void;
  availableLanguages: string[];
  isFilterShelfOpen: boolean;
  onToggleFilterShelf: () => void;
}

export const FacetShelf: React.FC<FacetShelfProps> = ({
  facets,
  onChangeFacets,
  sortBy,
  onChangeSortBy,
  availableLanguages,
  isFilterShelfOpen,
  onToggleFilterShelf,
}) => {
  const shelfFilterCount = [
    facets.era,
    facets.format,
    facets.language,
    facets.compilationsOnly,
  ].filter(Boolean).length;

  const hasAnyFilter = shelfFilterCount > 0 || Boolean(facets.favoritesOnly);

  const clearAll = () => {
    onChangeFacets({});
  };

  return (
    <div className="shrink-0 border-b border-zinc-800/60 bg-[#0D0E11]">
      {/* Primary Control Row: Favorites, Filter, Sort */}
      <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto no-scrollbar">
        {/* Favorites Toggle */}
        <button
          type="button"
          onClick={() =>
            onChangeFacets({
              ...facets,
              favoritesOnly: facets.favoritesOnly ? undefined : true,
            })
          }
          aria-pressed={Boolean(facets.favoritesOnly)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
            facets.favoritesOnly
              ? 'bg-[#F43F5E]/20 border border-[#F43F5E]/50 text-[#F43F5E] font-semibold'
              : 'bg-zinc-900/80 border border-zinc-800/80 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Heart className={`w-3.5 h-3.5 ${facets.favoritesOnly ? 'fill-[#F43F5E]' : ''}`} />
          <span>Favorites</span>
        </button>

        {/* Filter Shelf Toggle */}
        <button
          type="button"
          onClick={onToggleFilterShelf}
          aria-expanded={isFilterShelfOpen}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
            isFilterShelfOpen || shelfFilterCount > 0
              ? 'bg-[#D4AF37]/20 border border-[#D4AF37]/50 text-[#D4AF37] font-semibold'
              : 'bg-zinc-900/80 border border-zinc-800/80 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Filter className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span>Filter</span>
          {shelfFilterCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-[#D4AF37] text-zinc-950 text-[10px] font-bold">
              {shelfFilterCount}
            </span>
          )}
        </button>

        {/* Sort Selector */}
        <div className="relative flex items-center ml-auto shrink-0">
          <ArrowUpDown className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 pointer-events-none" />
          <select
            aria-label="Sort albums"
            value={sortBy}
            onChange={(e) => onChangeSortBy(e.target.value as SortBy)}
            className="bg-zinc-900/90 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-[#D4AF37]/60 cursor-pointer"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Active Shelf Filter Pills (visible when shelf is collapsed and filters are active) */}
      {!isFilterShelfOpen && shelfFilterCount > 0 && (
        <div className="flex items-center gap-1.5 px-3 pb-2 overflow-x-auto no-scrollbar">
          {facets.era && (
            <button
              type="button"
              onClick={() => onChangeFacets({ ...facets, era: undefined })}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-[#D4AF37] text-[11px] font-mono whitespace-nowrap"
            >
              <span>Era: {facets.era}</span>
              <X className="w-3 h-3" />
            </button>
          )}
          {facets.format && (
            <button
              type="button"
              onClick={() => onChangeFacets({ ...facets, format: undefined })}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/10 border border-white/20 text-zinc-100 text-[11px] font-mono whitespace-nowrap"
            >
              <span>Format: {facets.format}</span>
              <X className="w-3 h-3" />
            </button>
          )}
          {facets.language && (
            <button
              type="button"
              onClick={() => onChangeFacets({ ...facets, language: undefined })}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981] text-[11px] font-mono whitespace-nowrap"
            >
              <span>{facets.language}</span>
              <X className="w-3 h-3" />
            </button>
          )}
          {facets.compilationsOnly && (
            <button
              type="button"
              onClick={() => onChangeFacets({ ...facets, compilationsOnly: undefined })}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-[#D4AF37] text-[11px] font-mono whitespace-nowrap"
            >
              <span>Compilations</span>
              <X className="w-3 h-3" />
            </button>
          )}
          {hasAnyFilter && (
            <button
              type="button"
              onClick={clearAll}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 whitespace-nowrap"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Clear</span>
            </button>
          )}
        </div>
      )}

      {/* Expandable Filter Shelf (Desktop Parity, excluding Staged for Review) */}
      {isFilterShelfOpen && (
        <div
          role="region"
          aria-label="Album filters"
          className="px-3 py-3 bg-[#14161C] border-t border-zinc-800/80 space-y-3 text-xs"
        >
          {/* Era Row */}
          <div className="space-y-1.5">
            <span className="block font-mono text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
              Era
            </span>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {ERA_OPTIONS.map((era) => {
                const active = facets.era === era;
                return (
                  <button
                    key={era}
                    type="button"
                    onClick={() => onChangeFacets({ ...facets, era: active ? undefined : era })}
                    className={`px-2.5 py-1 rounded-full text-xs font-mono whitespace-nowrap transition-all ${
                      active
                        ? 'bg-[#D4AF37] text-zinc-950 font-semibold'
                        : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                    }`}
                  >
                    {era}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Format Row */}
          <div className="space-y-1.5">
            <span className="block font-mono text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
              Format
            </span>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {FORMAT_OPTIONS.map((f) => {
                const active = facets.format === f.value;
                return (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() =>
                      onChangeFacets({ ...facets, format: active ? undefined : f.value })
                    }
                    className={`px-2.5 py-1 rounded-full text-xs font-mono whitespace-nowrap transition-all ${
                      active
                        ? 'bg-white text-zinc-950 font-semibold'
                        : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                    }`}
                  >
                    <span className={active ? 'text-zinc-950' : f.colorClass}>{f.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Language Row */}
          {availableLanguages.length > 0 && (
            <div className="space-y-1.5">
              <span className="block font-mono text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                Language
              </span>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                {availableLanguages.map((lang) => {
                  const active = facets.language?.toLowerCase() === lang.toLowerCase();
                  return (
                    <button
                      key={lang}
                      type="button"
                      onClick={() =>
                        onChangeFacets({ ...facets, language: active ? undefined : lang })
                      }
                      className={`px-2.5 py-1 rounded-full text-xs font-mono whitespace-nowrap transition-all ${
                        active
                          ? 'bg-[#10B981] text-zinc-950 font-semibold'
                          : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      {lang}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Collection / Reset Row */}
          <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onChangeFacets({
                    ...facets,
                    compilationsOnly: facets.compilationsOnly ? undefined : true,
                  })
                }
                className={`px-2.5 py-1 rounded-full text-xs font-mono transition-all ${
                  facets.compilationsOnly
                    ? 'bg-[#D4AF37] text-zinc-950 font-semibold'
                    : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                Compilations
              </button>
              <button
                type="button"
                onClick={() =>
                  onChangeFacets({
                    ...facets,
                    favoritesOnly: facets.favoritesOnly ? undefined : true,
                  })
                }
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono transition-all ${
                  facets.favoritesOnly
                    ? 'bg-[#F43F5E] text-white font-semibold'
                    : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                <Heart className={`w-3 h-3 ${facets.favoritesOnly ? 'fill-white' : 'text-[#F43F5E]'}`} />
                <span>Favorites Only</span>
              </button>
            </div>

            {hasAnyFilter && (
              <button
                type="button"
                onClick={clearAll}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 transition-all"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
