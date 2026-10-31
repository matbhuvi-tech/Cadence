import React from 'react';

export type CatalogFilter = 'all' | 'hires' | 'dsd' | 'flac' | 'compilations';

interface FacetShelfProps {
  activeFilter: CatalogFilter;
  onSelectFilter: (filter: CatalogFilter) => void;
}

export const FacetShelf: React.FC<FacetShelfProps> = ({
  activeFilter,
  onSelectFilter,
}) => {
  const filters: { id: CatalogFilter; label: string }[] = [
    { id: 'all', label: 'All Releases' },
    { id: 'hires', label: 'Hi-Res' },
    { id: 'dsd', label: 'DSD' },
    { id: 'flac', label: 'FLAC' },
    { id: 'compilations', label: 'Compilations' },
  ];

  return (
    <div className="flex items-center space-x-2 overflow-x-auto no-scrollbar py-2 px-4 shrink-0">
      {filters.map((f) => {
        const isActive = activeFilter === f.id;
        return (
          <button
            key={f.id}
            onClick={() => onSelectFilter(f.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
              isActive
                ? 'bg-[#D4AF37] text-zinc-950 font-semibold shadow-md'
                : 'bg-zinc-900/80 text-zinc-400 border border-zinc-800/80 hover:text-zinc-200'
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
};

