import React, { useState, useEffect } from 'react';
import { X, Play, Plus, ListPlus, Disc3, Clock } from 'lucide-react';
import type { DbRelease, DbTrack } from '../../types/remote';
import { fetchTracks, getArtworkUrl } from '../../services/api';

interface AlbumModalProps {
  release: DbRelease | null;
  token: string;
  onClose: () => void;
  onPlayRelease: (releaseId: string) => void;
  onQueueRelease: (releaseId: string, playNext?: boolean) => void;
  onPlayTrack: (filePath: string) => void;
  onQueueTrack: (filePath: string, playNext?: boolean) => void;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export const AlbumModal: React.FC<AlbumModalProps> = ({
  release,
  token,
  onClose,
  onPlayRelease,
  onQueueRelease,
  onPlayTrack,
  onQueueTrack,
}) => {
  const [tracks, setTracks] = useState<DbTrack[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!release) return;
    setLoading(true);
    setError(null);
    fetchTracks(token, release.id)
      .then((data) => {
        setTracks(data);
        setLoading(false);
      })
      .catch((err) => {
        setError('Failed to load tracklist.');
        setLoading(false);
        console.error(err);
      });
  }, [release, token]);

  if (!release) return null;

  const artworkUrl = getArtworkUrl(release.id, token);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col justify-end animate-in fade-in duration-200">
      <div className="bg-[#121418] border-t border-zinc-800 rounded-t-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header Bar */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800/80">
          <div className="flex items-center space-x-3 truncate">
            <div className="w-12 h-12 rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden shrink-0">
              <img
                src={artworkUrl}
                alt={release.title}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
              />
            </div>
            <div className="truncate">
              <h3 className="font-semibold text-zinc-100 text-sm truncate">{release.title}</h3>
              <p className="text-xs text-zinc-400 truncate">{release.artist_credit}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action Row */}
        <div className="flex items-center space-x-2 px-4 py-3 bg-zinc-900/50 border-b border-zinc-800/50">
          <button
            onClick={() => {
              onPlayRelease(release.id);
              onClose();
            }}
            className="flex-1 flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-[#D4AF37] text-zinc-950 font-semibold text-xs active:scale-95 transition-all"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Play Album</span>
          </button>
          <button
            onClick={() => onQueueRelease(release.id, true)}
            className="flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs active:scale-95 transition-all"
          >
            <ListPlus className="w-3.5 h-3.5" />
            <span>Play Next</span>
          </button>
          <button
            onClick={() => onQueueRelease(release.id, false)}
            className="flex items-center justify-center space-x-1.5 py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs active:scale-95 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Queue</span>
          </button>
        </div>

        {/* Track List */}
        <div className="flex-1 overflow-y-auto p-2 divide-y divide-zinc-800/40">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
              <Disc3 className="w-8 h-8 animate-spin-slow text-[#D4AF37]" />
              <span className="text-xs mt-2">Loading tracks...</span>
            </div>
          ) : error ? (
            <div className="p-6 text-center text-rose-400 text-xs">{error}</div>
          ) : tracks.length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-xs">No tracks in this release</div>
          ) : (
            tracks.map((track, idx) => (
              <div
                key={track.id}
                className="flex items-center justify-between p-3 rounded-xl hover:bg-zinc-800/40 active:bg-zinc-800/80 transition-colors"
              >
                <div
                  onClick={() => {
                    onPlayTrack(track.file_path);
                    onClose();
                  }}
                  className="flex items-center space-x-3 flex-1 min-w-0 cursor-pointer"
                >
                  <span className="text-xs font-mono text-zinc-500 w-5 text-center">
                    {track.track_number ?? idx + 1}
                  </span>
                  <div className="truncate flex-1">
                    <p className="text-xs font-medium text-zinc-200 truncate">{track.title}</p>
                    <p className="text-[10px] text-zinc-500 truncate">{track.artist_credit}</p>
                  </div>
                </div>

                <div className="flex items-center space-x-2 pl-2">
                  <span className="text-[11px] font-mono text-zinc-500 flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-zinc-600" />
                    <span>{formatDuration(track.duration_secs)}</span>
                  </span>
                  <button
                    onClick={() => onQueueTrack(track.file_path, false)}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-[#D4AF37] hover:bg-zinc-800 active:scale-95"
                    title="Add to Queue"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

