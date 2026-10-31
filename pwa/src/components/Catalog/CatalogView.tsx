import React, { useState, useEffect, useMemo } from 'react';
import { Search, Disc3, RefreshCw } from 'lucide-react';
import type { DbRelease } from '../../types/remote';
import { fetchReleases, getArtworkUrl } from '../../services/api';
import { FacetShelf, CatalogFilter } from './FacetShelf';
import { AlbumModal } from './AlbumModal';

const releaseCache = new Map<string, DbRelease[]>();

interface CatalogViewProps {
  token: string;
  onPlayRelease: (releaseId: string) => void;
  onQueueRelease: (releaseId: string, playNext?: boolean) => void;
  onPlayTrack: (filePath: string) => void;
  onQueueTrack: (filePath: string, playNext?: boolean) => void;
}

export const CatalogView: React.FC<CatalogViewProps> = ({
  token,
  onPlayRelease,
  onQueueRelease,
  onPlayTrack,
  onQueueTrack,
}) => {
  const [releases, setReleases] = useState<DbRelease[]>(() => releaseCache.get(token) ?? []);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [selectedRelease, setSelectedRelease] = useState<DbRelease | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = (force = false) => {
    const cached = releaseCache.get(token);
    if (!force && cached) {
      setReleases(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    fetchReleases(token, 2000, 0)
      .then((data) => {
        releaseCache.set(token, data);
        setReleases(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load catalog:', err);
        setLoadError('The catalog could not be loaded. Check the connection and try again.');
        setLoading(false);
      });
  };

  useEffect(() => {
    loadData();
  }, [token]);

  // Filter and search
  const filteredReleases = useMemo(() => {
    return releases.filter((rel) => {
      // Search text
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = rel.title.toLowerCase().includes(q);
        const matchesArtist = rel.artistCredit.toLowerCase().includes(q);
        if (!matchesTitle && !matchesArtist) return false;
      }

      // Filter chips
      if (filter === 'compilations') {
        return rel.isCompilation;
      } else if (filter === 'dsd') {
        return rel.hasDsd || rel.folderName?.toLowerCase().includes('dsd') || false;
      } else if (filter === 'hires') {
        return rel.hasHighRes || (
          rel.folderName?.toLowerCase().includes('hi-res') ||
          rel.folderName?.toLowerCase().includes('24bit') ||
          rel.folderName?.toLowerCase().includes('flac 24') ||
          false
        );
      } else if (filter === 'flac') {
        return rel.hasFlac || rel.folderName?.toLowerCase().includes('flac') || false;
      }

      return true;
    });
  }, [releases, searchQuery, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0D0E11]">
      {/* Search Input */}
      <div className="p-3 pb-1 shrink-0">
        <div className="relative flex items-center">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 pointer-events-none" />
          <input
            type="search"
            placeholder="Search albums or artists..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900/90 border border-zinc-800 rounded-xl pl-9 pr-9 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-[#D4AF37]/60"
          />
          <div className="absolute right-2 flex items-center gap-1">
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="px-1 text-sm text-zinc-500 hover:text-zinc-300"
              >
                ×
              </button>
            )}
            <button
              type="button"
              onClick={() => loadData(true)}
              disabled={loading}
              aria-label="Refresh catalog"
              className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Filter Chips */}
      <FacetShelf activeFilter={filter} onSelectFilter={setFilter} />

      {/* Album Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
            <RefreshCw className="w-8 h-8 animate-spin text-[#D4AF37]" />
            <span className="text-xs mt-3">Loading Audiophile Catalog...</span>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <p role="alert" className="text-sm text-rose-300">{loadError}</p>
            <button type="button" onClick={() => loadData(true)} className="mt-3 rounded-xl border border-zinc-700 px-4 py-2 text-xs text-zinc-200 hover:bg-zinc-800">Try again</button>
          </div>
        ) : filteredReleases.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <Disc3 className="w-12 h-12 text-zinc-700 stroke-[1.2] mb-2" />
            <p className="text-sm font-medium text-zinc-400">No releases found</p>
            <p className="text-xs text-zinc-600 mt-1">Try clearing your filters or search terms</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filteredReleases.map((release) => {
              const artUrl = getArtworkUrl(release.id, token);
              return (
                <div
                  key={release.id}
                  onClick={() => setSelectedRelease(release)}
                  className="group flex flex-col bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden cursor-pointer hover:border-[#D4AF37]/40 active:scale-[0.98] transition-all"
                >
                  <div className="aspect-square w-full bg-zinc-900 relative overflow-hidden">
                    <img
                      src={artUrl}
                      alt={release.title}
                      loading="lazy"
                      className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                    />
                    <div className="absolute inset-0 -z-10 flex items-center justify-center bg-zinc-950 text-zinc-700">
                      <Disc3 className="w-10 h-10 stroke-[1.2]" />
                    </div>
                  </div>
                  <div className="p-2.5 flex flex-col">
                    <h4 className="text-xs font-semibold text-zinc-200 truncate group-hover:text-[#D4AF37] transition-colors">
                      {release.title}
                    </h4>
                    <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                      {release.artistCredit}
                    </p>
                    {release.releaseYear ? (
                      <span className="text-[10px] font-mono text-zinc-600 mt-1">
                        {release.releaseYear}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Album Detail Modal */}
      <AlbumModal
        release={selectedRelease}
        token={token}
        onClose={() => setSelectedRelease(null)}
        onPlayRelease={onPlayRelease}
        onQueueRelease={onQueueRelease}
        onPlayTrack={onPlayTrack}
        onQueueTrack={onQueueTrack}
      />
    </div>
  );
};

