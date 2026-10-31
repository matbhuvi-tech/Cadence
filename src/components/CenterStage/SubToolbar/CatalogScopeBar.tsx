import React from 'react'

export type ScopeTab = 'albums' | 'artists' | 'composers' | 'tracks'

interface CatalogScopeBarProps {
  activeTab: ScopeTab
  onTabChange: (tab: ScopeTab) => void
  albumsCount: number
  artistsCount: number
  composersCount: number
  tracksCount: number
  className?: string
}

/**
 * CatalogScopeBar
 *
 * Dedicated scope navigation component housing the primary catalog tabs
 * (Albums, Artists, Composers, Tracks). Enforces strict single-line flex-nowrap
 * and minimum badge sizes to prevent any horizontal collisions.
 */
export const CatalogScopeBar: React.FC<CatalogScopeBarProps> = ({
  activeTab,
  onTabChange,
  albumsCount,
  artistsCount,
  composersCount,
  tracksCount,
  className = '',
}) => {
  const tabs: { id: ScopeTab; label: string; count: number }[] = [
    { id: 'albums', label: 'Albums', count: albumsCount },
    { id: 'artists', label: 'Artists', count: artistsCount },
    { id: 'composers', label: 'Composers', count: composersCount },
    { id: 'tracks', label: 'Tracks', count: tracksCount },
  ]

  return (
    <nav
      aria-label="Catalog Scope Navigation"
      className={`flex items-center gap-1 p-0.5 rounded-xl bg-white/[0.04] border border-white/[0.08] shrink-0 select-none ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
              isActive
                ? 'bg-white/[0.08] text-[#F5F5F7] shadow-sm'
                : 'text-[#8E8E93] hover:text-[#F5F5F7]'
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`text-[10px] font-mono px-1 rounded-full ${
                isActive ? 'bg-white/10 text-white' : 'text-[#636366]'
              }`}
            >
              {tab.count.toLocaleString()}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

