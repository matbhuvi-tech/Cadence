import React, { useState, useEffect, useMemo } from 'react';
import { Search, Disc3, RefreshCw } from 'lucide-react';
import type { DbRelease } from '../../types/remote';
import { fetchReleases, getArtworkUrl } from '../../services/api';
import { FacetShelf, CatalogFilter } from './FacetShelf';
import { AlbumModal } from './AlbumModal';

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
  const [releases, setReleases] = useState<DbRelease[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [selectedRelease, setSelectedRelease] = useState<DbRelease | null>(null);

  const loadData = () => {
    setLoading(true);
    fetchReleases(token, 200, 0)
      .then((data) => {
        setReleases(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load catalog:', err);
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
        const matchesArtist = rel.artist_credit.toLowerCase().includes(q);
        if (!matchesTitle && !matchesArtist) return false;
      }

      // Filter chips
      if (filter === 'compilations') {
        return rel.is_compilation;
      } else if (filter === 'dsd') {
        return rel.folder_name?.toLowerCase().includes('dsd') || rel.title.toLowerCase().includes('dsd');
      } else if (filter === 'hires') {
        return (
          rel.folder_name?.toLowerCase().includes('hi-res') ||
          rel.folder_name?.toLowerCase().includes('24bit') ||
          rel.folder_name?.toLowerCase().includes('flac 24')
        );
      } else if (filter === 'flac') {
        return rel.folder_name?.toLowerCase().includes('flac') || !rel.folder_name?.toLowerCase().includes('mp3');
      }

      return true;
    });
  }, [releases, searchQuery, filter]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0D0E11]">
      {/* Search Input */}
      <div className="p-3 pb-1 shrink-0">
        <div className="relative flex items-center">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 pointer-events-none" />
          <input
            type="text"
            placeholder="Search albums or artists..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900/90 border border-zinc-800 rounded-xl pl-9 pr-9 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-[#D4AF37]/60"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 text-xs text-zinc-500 hover:text-zinc-300"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Filter Chips */}
      <FacetShelf activeFilter={filter} onSelectFilter={setFilter} />

      {/* Album Grid */}
      <div className="flex-1 overflow-y-auto px-3 pb-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
            <RefreshCw className="w-8 h-8 animate-spin text-[#D4AF37]" />
            <span className="text-xs mt-3">Loading Audiophile Catalog...</span>
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
                      {release.artist_credit}
                    </p>
                    {release.release_year ? (
                      <span className="text-[10px] font-mono text-zinc-600 mt-1">
                        {release.release_year}
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

